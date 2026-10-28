// Whose mirrored records are whose. Runs only inside Convex.
//
// THE RULE: a person is sent their own records and nobody else's. The
// deployment owner's are the rows with no `owner` (what the OS reads itself
// and what the per-source tokens push); a teammate's are the rows whose
// `owner` is their own address AND whose `userId` is their own `users` row.
// The owner is never sent a teammate's, and a teammate never the owner's.
// Every read and every delete of `mirrorRecords` names whose rows it wants
// through `holderKey`, and both of the table's indexes lead with `owner`, so
// there is no way to range over a tool's rows across people.
//
// A PERSON, NOT AN ADDRESS. An address can pass from one Google identity to
// another (a `users` row deleted so the address can sign in with a new
// account; an identity whose address changed at Google). What one identity
// sent must never reach the next holder of its address, and the first one's
// token must not go on feeding the second one's page. So:
//   - a token, a status row and a record each carry the `users` row they are
//     about (`userId`);
//   - a token is honoured only while that row is still the one that holds the
//     address (`mayHold`);
//   - a read returns a row only if its `userId` is the caller's (`isHeldBy`),
//     and a write deletes any row under its address that is not;
//   - sign-in deletes everything under an address the moment the identity
//     behind it changes (`resolveOwnerUser` in convex/authOwner.ts).
// A row under an address with no `userId` is nobody's. The deployment owner's
// rows have neither field and none of this reaches them.
//
// Nothing here puts an address, a token or a hash in a thrown error or a log.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { hasOwner, isOwnerEmail, memberByEmail } from "../authOwner";
import { secretsEqual } from "./constantTime";
import { MIRROR_SOURCES, type MirrorSource } from "./mirrorRules";
import { NOT_ALLOWED, type Member } from "./owner";
import { effectiveAreas } from "./roles";

/** One teammate: the address their rows are filed under, and the `users` row that is them. */
export type Teammate = { kind: "teammate"; email: string; userId: Id<"users"> };
/** Whose rows a read or a write is for: the deployment owner's (no `owner` field), or one teammate's. */
export type Holder = { kind: "owner" } | Teammate;
/**
 * Whose rows a delete removes: the deployment owner's, or everything filed
 * under one address, whichever identity sent it.
 */
export type Held = { kind: "owner" } | { kind: "teammate"; email: string };

type Reader = { db: QueryCtx["db"] };
type Writer = { db: MutationCtx["db"] };

/**
 * Whose records a caller reads: their own. A teammate with no address on
 * record is refused; they are never answered with the owner's rows.
 */
export function holderOf(member: Member): Holder {
  if (member.role === "owner") return { kind: "owner" };
  const email = (member.user.email ?? "").trim().toLowerCase();
  if (email === "") throw new ConvexError(NOT_ALLOWED);
  return { kind: "teammate", email, userId: member.user._id };
}

/** The value of `owner` on a holder's rows. Undefined only for the deployment owner. */
export function holderKey(holder: Held): string | undefined {
  return holder.kind === "owner" ? undefined : holder.email;
}

/**
 * Whether a row filed where this holder's rows are is theirs. The owner's
 * rows carry no person; a teammate's must carry that teammate's own `users`
 * row, so a row left under the address by whoever held it before is not.
 */
export function isHeldBy(holder: Holder, row: { userId?: Id<"users"> }): boolean {
  return holder.kind === "owner" ? row.userId === undefined : row.userId === holder.userId;
}

/** Whether an address is a teammate's who has the Today area right now. Never an owner's. */
export async function hasToday(db: QueryCtx["db"], email: string): Promise<boolean> {
  if (!hasOwner() || isOwnerEmail(email)) return false;
  const row = await memberByEmail(db, email);
  return row !== null && effectiveAreas(row.role, row.areas).includes("today");
}

/** The one `users` row that holds an address, or null when none or more than one does. */
async function identityOf(db: QueryCtx["db"], email: string): Promise<Id<"users"> | null> {
  const users = await db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .take(2);
  return users.length === 1 ? users[0]!._id : null;
}

/**
 * Whether what is filed under an address for one `users` row may still be
 * held: the address is a teammate's with the Today area, and that same row is
 * still the one that holds it. Missing means no.
 */
export async function mayHold(
  db: QueryCtx["db"],
  email: string,
  userId: Id<"users"> | undefined,
): Promise<boolean> {
  if (userId === undefined || !(await hasToday(db, email))) return false;
  return (await identityOf(db, email)) === userId;
}

/** More token rows than there can be teammates; a bound, not a target. */
const MAX_TOKENS = 200;

/**
 * Whose token a hash is, if its person may still push: a teammate with the
 * Today area whose `users` row is the one that made the token, asked again on
 * every call. Every stored hash is compared, in constant time and with no
 * early exit, so the time taken does not say whether a guess came close. A
 * hash two rows share authenticates neither.
 */
export async function tokenHolder(
  ctx: QueryCtx,
  tokenHash: string,
): Promise<{ token: Doc<"personalTokens">; holder: Teammate } | null> {
  const rows = await ctx.db.query("personalTokens").take(MAX_TOKENS);
  const matches: Doc<"personalTokens">[] = [];
  for (const row of rows) {
    if (await secretsEqual(tokenHash, row.tokenHash)) matches.push(row);
  }
  const token = matches.length === 1 ? matches[0]! : null;
  if (token === null || token.userId === undefined) return null;
  if (!(await mayHold(ctx.db, token.owner, token.userId))) return null;
  return { token, holder: { kind: "teammate", email: token.owner, userId: token.userId } };
}

/** The caller's own token row, if they have one. One made by another identity is not theirs. */
export async function tokenOf(ctx: Reader, holder: Teammate): Promise<Doc<"personalTokens"> | null> {
  const tokens = await ctx.db
    .query("personalTokens")
    .withIndex("by_owner", (q) => q.eq("owner", holder.email))
    .collect();
  return tokens.find((token) => isHeldBy(holder, token)) ?? null;
}

/** The status rows filed under an address for one tool, whoever they are about. */
const statusRows = (ctx: Reader, email: string, source: MirrorSource) =>
  ctx.db
    .query("personalSourceStatus")
    .withIndex("by_owner_and_source", (q) => q.eq("owner", email).eq("source", source))
    .collect();

/** How one person's pushes of one tool stand: their own row, or null. */
export async function personalStatus(
  ctx: Reader,
  holder: Teammate,
  source: MirrorSource,
): Promise<Doc<"personalSourceStatus"> | null> {
  return (await statusRows(ctx, holder.email, source)).find((row) => isHeldBy(holder, row)) ?? null;
}

/**
 * Change one person's status for one tool, making the row if there is none.
 * A row under the address that is about somebody else is deleted, not taken over.
 */
export async function patchPersonalStatus(
  ctx: Writer,
  holder: Teammate,
  source: MirrorSource,
  change: Partial<
    Omit<Doc<"personalSourceStatus">, "_id" | "_creationTime" | "owner" | "userId" | "source">
  >,
) {
  let existing: Doc<"personalSourceStatus"> | null = null;
  for (const row of await statusRows(ctx, holder.email, source)) {
    if (existing === null && isHeldBy(holder, row)) existing = row;
    else await ctx.db.delete(row._id);
  }
  if (existing === null) {
    await ctx.db.insert("personalSourceStatus", {
      owner: holder.email,
      userId: holder.userId,
      source,
      ...change,
    });
  } else {
    await ctx.db.patch(existing._id, change);
  }
}

/**
 * Delete everything of one tool filed where a holder's rows are: the
 * deployment owner's, or all that is under one address. Returns how many went.
 */
export async function deleteHeld(ctx: Writer, held: Held, source: MirrorSource): Promise<number> {
  const owner = holderKey(held);
  const rows = await ctx.db
    .query("mirrorRecords")
    .withIndex("by_owner_and_source_and_externalId", (q) => q.eq("owner", owner).eq("source", source))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * A teammate's records of one tool deleted, and its "last received" with
 * them: a page must not say "received an hour ago" over a list that is gone.
 * The push count stays, so forgetting is not a way round the rate limit.
 */
export async function forgetTool(ctx: Writer, holder: Teammate, source: MirrorSource) {
  await deleteHeld(ctx, holder, source);
  for (const row of await statusRows(ctx, holder.email, source)) {
    if (!isHeldBy(holder, row)) {
      await ctx.db.delete(row._id);
      continue;
    }
    await ctx.db.patch(row._id, {
      state: undefined,
      message: undefined,
      lastRunAt: undefined,
      lastOkAt: undefined,
    });
  }
}

/** Delete every token under an address, so the next push with one is refused. */
export async function deleteTokens(ctx: Writer, email: string) {
  const tokens = await ctx.db
    .query("personalTokens")
    .withIndex("by_owner", (q) => q.eq("owner", email))
    .collect();
  for (const token of tokens) await ctx.db.delete(token._id);
}

/**
 * Everything held under one teammate's address, gone in this transaction:
 * the token (so a push in flight is refused when it lands), the records of
 * every tool, and the status rows, whichever identity they are about. For a
 * teammate removed from the team or whose Today area was taken away, and for
 * an address whose identity changed. It can only reach rows that carry this
 * address: the deployment owner's rows carry none.
 */
export async function forgetPerson(ctx: Writer, rawEmail: string) {
  const email = rawEmail.trim().toLowerCase();
  if (email === "") return;
  await deleteTokens(ctx, email);
  for (const source of MIRROR_SOURCES) {
    await deleteHeld(ctx, { kind: "teammate", email }, source);
    for (const status of await statusRows(ctx, email, source)) await ctx.db.delete(status._id);
  }
}
