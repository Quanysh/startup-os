import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { forgetPerson } from "./lib/personal";

// Who may use the OS. The owners come from the OWNER_EMAILS Convex env var
// (comma or whitespace separated), read on every call rather than at module
// scope so a dashboard edit takes effect without a redeploy. Teammates are
// rows in `members`, which only an owner can write (convex/team.ts).
//
// Unset or empty means nobody is let in at all: not an owner, and not a
// teammate either (`hasOwner`). A `members` row is the owner's word, and with
// no owner there is nobody to take it back.
function ownerEmails(): Set<string> {
  return new Set(
    (process.env.OWNER_EMAILS ?? "")
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ownerEmails().has(email.trim().toLowerCase());
}

/**
 * Whether any owner is configured. When none is, nobody is let in: the gate
 * (`getMember`) and sign-in (`resolveOwnerUser`) both refuse everyone.
 */
export function hasOwner(): boolean {
  return ownerEmails().size > 0;
}

/** Every owner address, lower-cased, in a stable order. */
export function ownerEmailList(): string[] {
  return [...ownerEmails()].sort();
}

/** The teammate row for an address, or null. An owner's address never has one. */
export async function memberByEmail(
  db: QueryCtx["db"],
  email: string | null | undefined,
): Promise<Doc<"members"> | null> {
  if (!email) return null;
  const address = email.trim().toLowerCase();
  return await db
    .query("members")
    .withIndex("by_email", (q) => q.eq("email", address))
    .unique();
}

// Addresses Google itself issues. For any other domain Google only vouches
// for the address when the account belongs to that domain's Workspace, which
// it reports in the `hd` claim.
const GOOGLE_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Map Google's ID-token claims to the profile Convex Auth hands the callback.
 *
 * Convex Auth's default mapping keeps only id, name, email and image, which
 * would drop the two claims the allow-list depends on: whether Google has
 * verified the address, and which Workspace domain (if any) the account
 * belongs to.
 */
export function googleProfile(claims: Record<string, unknown>) {
  return {
    id: String(claims.sub),
    name: typeof claims.name === "string" ? claims.name : undefined,
    email: typeof claims.email === "string" ? claims.email : undefined,
    image: typeof claims.picture === "string" ? claims.picture : undefined,
    emailVerified: claims.email_verified === true,
    hostedDomain: typeof claims.hd === "string" ? claims.hd : undefined,
  };
}

type SignInProfile = {
  email?: unknown;
  emailVerified?: unknown;
  hostedDomain?: unknown;
  name?: unknown;
  image?: unknown;
};

/** True when Google is authoritative for this address, not merely aware of it. */
export function googleVouchesFor(email: string, hostedDomain: unknown): boolean {
  const domain = email.split("@")[1] ?? "";
  if (GOOGLE_CONSUMER_DOMAINS.has(domain)) return true;
  return typeof hostedDomain === "string" && hostedDomain.toLowerCase() === domain;
}

/**
 * Decide which user a Google sign-in resolves to, or refuse it.
 *
 * This is the body of Convex Auth's `createOrUpdateUser` callback, split out
 * so it can be tested. Throwing rolls back the sign-in mutation, so a refused
 * visitor leaves no `users` or `authAccounts` row behind.
 *
 * An address belongs to the first Google identity that signs in with it. A
 * different Google account presenting the same address later is refused
 * rather than linked: being able to show an email is not being its owner.
 * (To move the owner to a new Google account, delete their row in `users`.)
 * The same holds for an identity that already has a user and comes back
 * showing an address another user holds: refused, and neither row changes.
 *
 * Personal records follow the person, never the address. When the identity
 * behind an address changes, everything held under that address ("Connect
 * your Claude": the token, the mail, calendar, meeting notes and issues, the
 * status rows) is deleted here, in the sign-in's own transaction: when a new
 * `users` row is made for an address (whoever held it before is not this
 * identity), and when a returning identity moves to another address (what it
 * sent under the old one, and anything left under the new one). Only rows
 * that carry the address are reached; the deployment owner's carry none.
 *
 * It is a first line, not the gate: sessions outlive allow-list edits and a
 * teammate's removal, so every function still checks who is calling
 * (convex/lib/owner.ts).
 */
export async function resolveOwnerUser(
  db: MutationCtx["db"],
  args: { existingUserId: Id<"users"> | null; profile: SignInProfile },
): Promise<Id<"users">> {
  const { existingUserId, profile } = args;
  const email =
    typeof profile.email === "string" ? profile.email.trim().toLowerCase() : null;
  // `emailVerified` must be exactly true: it is Google's own claim, passed
  // through by googleProfile(). Absent means refuse.
  if (
    !email ||
    profile.emailVerified !== true ||
    !googleVouchesFor(email, profile.hostedDomain)
  ) {
    throw new ConvexError("not_owner");
  }
  // With no owner configured nobody signs in, whatever `members` holds.
  if (!hasOwner()) throw new ConvexError("not_owner");
  // An owner, or a teammate the owner has added. Nobody else gets a row.
  if (!isOwnerEmail(email) && (await memberByEmail(db, email)) === null) {
    throw new ConvexError("not_owner");
  }

  const details = {
    email,
    ...(typeof profile.name === "string" ? { name: profile.name } : null),
    ...(typeof profile.image === "string" ? { image: profile.image } : null),
  };

  // Every user that holds the address now. One address, one user.
  const holders = await db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .collect();

  // A Google identity that has signed in before: the library found its link.
  const existing = existingUserId === null ? null : await db.get(existingUserId);
  if (existing) {
    // Its address may have changed at Google, but not to one that is
    // somebody else's here: that would make two users one person to the gate.
    if (holders.some((holder) => holder._id !== existing._id)) {
      throw new ConvexError("not_owner");
    }
    const before = (existing.email ?? "").trim().toLowerCase();
    if (before !== email) {
      await forgetPerson({ db }, before);
      await forgetPerson({ db }, email);
    }
    await db.patch(existing._id, {
      ...details,
      emailVerificationTime: existing.emailVerificationTime ?? Date.now(),
    });
    return existing._id;
  }

  // An identity with no link. If the address already has a user, this is a
  // second Google account claiming it.
  if (holders.length > 0) throw new ConvexError("not_owner");

  // A new identity for this address: nothing an earlier one sent is theirs.
  await forgetPerson({ db }, email);
  return await db.insert("users", { ...details, emailVerificationTime: Date.now() });
}
