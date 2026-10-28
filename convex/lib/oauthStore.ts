// The OAuth tables' writes that more than one module needs (convex/oauth.ts,
// convex/assistant.ts). Runs only inside Convex. Nothing here logs.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** A grant's tokens, a bounded read: a grant holds one live pair and the refresh tokens rotated since. */
const GRANT_TOKENS_BATCH = 2_000;

/** Delete a grant and every token it holds: its access and refresh tokens stop at once. */
export async function deleteGrant(ctx: MutationCtx, grantId: Id<"oauthGrants">): Promise<void> {
  const tokens = await ctx.db
    .query("oauthTokens")
    .withIndex("by_grantId", (q) => q.eq("grantId", grantId))
    .take(GRANT_TOKENS_BATCH);
  for (const token of tokens) await ctx.db.delete(token._id);
  if ((await ctx.db.get(grantId)) !== null) await ctx.db.delete(grantId);
}

/** Delete every grant a client holds with an owner (`userId`), or with anyone when it is left out. */
export async function deleteGrantsOf(ctx: MutationCtx, clientId: string, userId?: Id<"users">): Promise<void> {
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .take(50);
  for (const grant of grants) {
    if (userId === undefined || grant.userId === userId) await deleteGrant(ctx, grant._id);
  }
}
