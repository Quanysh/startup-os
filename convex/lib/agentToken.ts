// Who a client of the agent endpoint is, asked on every request and again
// inside every read and write it leads to (convex/mcp.ts, convex/assistant.ts).
// Callers hand over the credential's SHA-256, never the credential. Runs only
// inside Convex. Nothing here logs or throws.
//
// A client is one of the owner's named tokens (`sosa_…`, `agentTokens`), or
// a client the owner approved with OAuth (`oauthGrants`), which presents an
// access token (`soso_…`, `oauthTokens`). Each acts as the owner, with its own
// scope, its own limits and its own name on the audit. One named token at
// most is the Mac's runner, the one that may call the runner's tools; an
// OAuth client never is.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isOwnerEmail } from "../authOwner";
import { LEGACY_TOKEN_NAME } from "./agentClients";
import type { AgentScope } from "./agentRules";
import { secretsEqual } from "./constantTime";
import { memberOf } from "./memberOf";
import { botResourceOf, mcpResourceOf, siteOrigin } from "./oauthRules";
import type { Member } from "./owner";

/**
 * What a request presented, by its SHA-256: a named token's, or an OAuth
 * access token's. `address` is the bot whose own address (`/mcp/v1/bot/<id>`)
 * it was presented at, absent at the plain `/mcp/v1`: an access token is
 * honoured only at the address its grant was made for.
 */
export type Credential = { kind: "token" | "oauth"; hash: string; address?: string };
export const credentialValidator = v.object({
  kind: v.union(v.literal("token"), v.literal("oauth")),
  hash: v.string(),
  address: v.optional(v.string()),
});

/** Which client made a call, as the audit keeps it. */
export type ClientRef = { kind: "token"; id: Id<"agentTokens"> } | { kind: "oauth"; id: Id<"oauthGrants"> };

export { LEGACY_TOKEN_NAME };

/** A token's name as shown: the owner's words, or the legacy row's. */
export const tokenName = (row: Pick<Doc<"agentTokens">, "name">): string => row.name ?? LEGACY_TOKEN_NAME;

/**
 * Whether a token is the Mac's runner. The one token of before (no name) was
 * the one the runner read from Claude Code's configuration, so it keeps that
 * until it is revoked.
 */
export const tokenIsRunner = (row: Pick<Doc<"agentTokens">, "name" | "runner">): boolean =>
  row.runner ?? row.name === undefined;

/**
 * Whether only the owner's bots may use a client (docs/assistant.md, "Bots"):
 * a call that names no bot is refused, and so is one naming one of the four
 * unless the client is the Mac's runner. A row that says nothing: on for a
 * named token that is not the runner, off for the runner's (the one token of
 * before included) and for an OAuth grant approved before the setting existed.
 * A grant approved since is on (convex/oauth.ts).
 */
export const tokenBotsOnly = (row: Pick<Doc<"agentTokens">, "name" | "runner" | "botsOnly">): boolean =>
  row.botsOnly ?? !tokenIsRunner(row);
export const grantBotsOnly = (row: Pick<Doc<"oauthGrants">, "botsOnly">): boolean => row.botsOnly ?? false;

/** The counters each client keeps its limits on (convex/assistant.ts, `admit`). */
export type LimitFields = Pick<
  Doc<"agentTokens">,
  | "windowStart"
  | "calls"
  | "actWindowStart"
  | "acts"
  | "limitNotedFor"
  | "runnerWindowStart"
  | "runnerCalls"
  | "runnerLimitNotedFor"
  | "lastUsedAt"
>;

export type Holder = {
  client: ClientRef;
  /** The client's name, for the audit. */
  name: string;
  scope: AgentScope;
  /** Whether it may call the runner's tools. */
  runner: boolean;
  /** Whether only the owner's bots may use it (`tokenBotsOnly`, `grantBotsOnly`). */
  botsOnly: boolean;
  /** The one bot a token was made for (Agents › Bots, "Make a token for this bot"): no other bot may use it. */
  onlyBot: string | null;
  member: Member;
  /** The row its limits are counted on: the token's, or the grant's. */
  limits: LimitFields & { _id: Id<"agentTokens"> | Id<"oauthGrants"> };
};

/**
 * The owner a client acts as, or null. Asked each time, of the `users` row
 * the credential was made by:
 *
 * - that row still exists, with a verified address;
 * - that address is an owner's by `OWNER_EMAILS` **now** (an owner taken off
 *   the list, or an empty list, stops every client at once);
 * - and that same row is still the one the gate would take for the address
 *   (`memberOf`, which mirrors `getMember`).
 *
 * The `Member` returned is the owner's, so every tool runs under the checks
 * the app makes for the owner and no others.
 */
export async function ownerBehind(ctx: QueryCtx, userId: Id<"users">): Promise<Member | null> {
  const user = await ctx.db.get(userId);
  if (user === null || !user.email || !isOwnerEmail(user.email)) return null;
  const member = await memberOf(ctx, user.email);
  if (member === null || member.role !== "owner" || member.user._id !== userId) return null;
  return member;
}

/**
 * The client behind a credential and the owner it acts as, or null. A
 * credential is honoured only while exactly one row has its hash (compared in
 * constant time) and its maker passes `ownerBehind`; an access token also
 * only before it expires (`now`, handed in: a query reads no clock), while
 * its grant is on record, and for this endpoint as it is now (its resource).
 */
export async function clientHolder(ctx: QueryCtx, credential: Credential, now: number): Promise<Holder | null> {
  if (credential.kind === "oauth") return await grantHolder(ctx, credential.hash, now, credential.address ?? null);
  const rows = await ctx.db
    .query("agentTokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", credential.hash))
    .take(2);
  const token = rows.length === 1 ? rows[0]! : null;
  if (token === null || !(await secretsEqual(credential.hash, token.tokenHash))) return null;
  const member = await ownerBehind(ctx, token.userId);
  if (member === null) return null;
  return {
    client: { kind: "token", id: token._id },
    name: tokenName(token),
    scope: token.scope,
    runner: tokenIsRunner(token),
    botsOnly: tokenBotsOnly(token),
    onlyBot: token.onlyBot ?? null,
    member,
    limits: token,
  };
}

/**
 * An OAuth access token's grant and the owner it acts as, or null. Only at
 * the address the grant was made for (RFC 8707): a grant made at a bot's own
 * address is that bot's, refused at another bot's and at the plain endpoint,
 * and a grant made at the plain endpoint is refused at any bot's.
 */
async function grantHolder(ctx: QueryCtx, hash: string, now: number, address: string | null): Promise<Holder | null> {
  const rows = await ctx.db
    .query("oauthTokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
    .take(2);
  const token = rows.length === 1 ? rows[0]! : null;
  if (token === null || token.kind !== "access" || token.expiresAt <= now) return null;
  if (!(await secretsEqual(hash, token.tokenHash))) return null;
  const grant = await ctx.db.get(token.grantId);
  if (grant === null) return null;
  const origin = siteOrigin(process.env.SITE_URL);
  if (origin === null) return null;
  const expected = address === null ? mcpResourceOf(origin) : botResourceOf(origin, address);
  if (grant.resource !== expected || (grant.onlyBot ?? null) !== address) return null;
  const member = await ownerBehind(ctx, grant.userId);
  if (member === null) return null;
  return {
    client: { kind: "oauth", id: grant._id },
    name: grant.clientName,
    scope: grant.scope,
    runner: false,
    botsOnly: grantBotsOnly(grant),
    onlyBot: grant.onlyBot ?? null,
    member,
    limits: grant,
  };
}
