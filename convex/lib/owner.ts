import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { hasOwner, isOwnerEmail, memberByEmail } from "../authOwner";
import { COMPANY_NOT_IN_USE, companyIds, isCompanyId, type CompanyId } from "./company";
import { effectiveAreas, may, ownerAreas, roleKind, type Area, type Role } from "./roles";

// The access gate. Everything the browser can call is built with one of the
// four builders below, and an ESLint rule bans the raw builders elsewhere, so
// a function cannot be published without this check by forgetting a line.
//
// The check runs on every call, against the live allow-list and the live
// `members` table: a signed-in session proves only that someone signed in
// once, not that they are still (or ever were) let in. Removing a teammate or
// changing their pages therefore takes effect on their very next call.

/** Thrown for a missing permission and for another company's data alike. */
export const NOT_ALLOWED = "not_allowed";

/** The signed-in user whose session still exists and whose email is verified. */
async function signedIn(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;

  // The session must still exist. A token is valid for up to an hour after
  // it is issued, so without this a signed-out browser tab (or a copied
  // token) would keep working until it expired.
  const rawSessionId = await getAuthSessionId(ctx);
  const sessionId = rawSessionId && ctx.db.normalizeId("authSessions", rawSessionId);
  if (!sessionId || (await ctx.db.get(sessionId)) === null) return null;

  const user = await ctx.db.get(userId);
  if (!user?.emailVerificationTime) return null;
  return user;
}

/** The signed-in owner, or null for anyone else. Never throws. */
export async function getOwner(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const user = await signedIn(ctx);
  return user !== null && isOwnerEmail(user.email) ? user : null;
}

export async function requireOwner(ctx: QueryCtx): Promise<Doc<"users">> {
  const owner = await getOwner(ctx);
  if (owner === null) throw new ConvexError("not_owner");
  return owner;
}

/** Someone the OS lets in: the owner, or a teammate the owner has added. */
export type Member = {
  user: Doc<"users">;
  /** The label they wear. What they may do is `areas`: ask with `may`, never by role. */
  role: Role;
  /**
   * The role the owner named, where theirs is one ("custom" above): for its
   * name and what their pages are arranged for (convex/lib/roleRows.ts).
   * Nothing is ever allowed or refused by it.
   */
  named?: Id<"roles">;
  /** The companies whose data they may be sent. The owner has both. */
  companies: readonly CompanyId[];
  /**
   * The areas they have: all of them for the owner, and for a teammate the
   * ones the owner picked (`effectiveAreas`), never `personal` or `admin`.
   */
  areas: readonly Area[];
};

/**
 * The signed-in owner or teammate, or null for anyone else. Never throws.
 * An owner's address is the owner whatever `members` says. With no owner
 * configured (OWNER_EMAILS unset or empty) it is null for everyone: a
 * teammate's row lets them in only while there is an owner who could remove it.
 */
export async function getMember(ctx: QueryCtx): Promise<Member | null> {
  if (!hasOwner()) return null;
  const user = await signedIn(ctx);
  if (user === null) return null;
  if (isOwnerEmail(user.email)) {
    return { user, role: "owner", companies: companyIds(), areas: ownerAreas() };
  }
  const row = await memberByEmail(ctx.db, user.email);
  if (row === null) return null;
  const role = roleKind(row.role);
  return {
    user,
    role,
    ...(role === "custom" ? { named: row.role as Id<"roles"> } : null),
    companies: row.companies.filter(isCompanyId),
    areas: effectiveAreas(row.role, row.areas),
  };
}

/**
 * Whether a caller is the owner: an OWNER_EMAILS address, which is never a
 * row. For the few places where the owner and a teammate with the same area
 * are held to different rules (the team, the Telegram settings). What a
 * caller may open is still asked with `may`, by area.
 */
export function isOwner(member: Member): boolean {
  return member.role === "owner";
}

/** The caller, if they have one of the areas. */
export async function requireMember(ctx: QueryCtx, areas: readonly Area[]): Promise<Member> {
  const member = await getMember(ctx);
  if (member === null || !may(member, areas)) throw new ConvexError(NOT_ALLOWED);
  return member;
}

/**
 * Refuse a caller who is not on a company, in the words of a missing
 * permission; and anyone, in fixed words, for a company this OS is not run
 * for (one-company mode: the `secondCompany` switch is off).
 */
export function requireCompany(member: Member, company: CompanyId) {
  if (!isCompanyId(company)) throw new ConvexError(COMPANY_NOT_IN_USE);
  if (!member.companies.includes(company)) throw new ConvexError(NOT_ALLOWED);
}

/**
 * What a function is gated with: the owner alone, or the areas that open it
 * and, for a function that is one company's throughout, that company.
 */
export type Gate = "owner" | { areas: readonly Area[]; company?: CompanyId };

// Marks a function as built by one of the wrappers below, so a test can list
// every public function, prove each is gated and print what gates it
// (convex/publicSurface.test.ts). Lint keeps raw builders out; this checks
// what is actually exported.
function gated<Build extends (...args: never[]) => object>(build: Build, gate: Gate): Build {
  return ((...args: Parameters<Build>) =>
    Object.assign(build(...args), { gated: true, gate })) as unknown as Build;
}

// For what is the owner's alone and can be given to nobody: the `personal`
// area (the owner's own work tools and Google connection), and `admin`, which
// is whatever else stays the owner's (the record of what team managers did,
// the owner's own Telegram username).
export const ownerQuery = gated(
  customQuery(
    query,
    customCtx(async (ctx) => ({ owner: await requireOwner(ctx) })),
  ),
  "owner",
);

export const ownerMutation = gated(
  customMutation(
    mutation,
    customCtx(async (ctx) => ({ owner: await requireOwner(ctx) })),
  ),
  "owner",
);

function gateOf(area: Area | readonly Area[], company?: CompanyId) {
  const areas: readonly Area[] = typeof area === "string" ? [area] : area;
  const admit = async (ctx: QueryCtx) => {
    const member = await requireMember(ctx, areas);
    if (company !== undefined) requireCompany(member, company);
    return { member };
  };
  const gate: Gate = company === undefined ? { areas } : { areas, company };
  return { admit, gate };
}

/**
 * A query for the owner and any teammate the owner gave the area (one of
 * the areas, given a list). Naming a company also requires the caller to be
 * on it, for what only one company has (fundraising).
 *
 * The handler gets `ctx.member`. For anything else it must itself keep to
 * `ctx.member.companies`: the gate knows the area, not the rows. A handler
 * that needs to know what else the caller has asks `may(ctx.member, area)`
 * (convex/lib/roles.ts), never their role.
 */
export function memberQuery(area: Area | readonly Area[], company?: CompanyId) {
  const { admit, gate } = gateOf(area, company);
  return gated(customQuery(query, customCtx(admit)), gate);
}

export function memberMutation(area: Area | readonly Area[], company?: CompanyId) {
  const { admit, gate } = gateOf(area, company);
  return gated(customMutation(mutation, customCtx(admit)), gate);
}
