// The rules the owner gives the bots (docs/assistant.md, "Bots"): one text
// for every bot and a note for each, published as a numbered version
// (`botRuleVersions`). The newest is what `whoami` and `bot_rules` return, so
// a change reaches every bot on its next call and nobody confirms it in a chat.
//
// Runs only inside Convex: never import it from the UI. Nothing here logs, and
// no refusal quotes the text.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { KEPT_RULE_VERSIONS } from "./botRules";

/** The newest published version of an owner's rules, or null before the first publish. */
export async function latestRules(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"botRuleVersions"> | null> {
  return await ctx.db
    .query("botRuleVersions")
    .withIndex("by_userId_and_version", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
}

/** The rules as one bot is given them: the version, when, the text for all, and its own note. */
export type RulesForBot = { version: number; publishedAt: number; text: string; note: string | null };

export async function rulesForBot(ctx: QueryCtx, userId: Id<"users">, botId: string | null): Promise<RulesForBot | null> {
  const latest = await latestRules(ctx, userId);
  if (latest === null) return null;
  const note = botId === null ? null : (latest.notes.find((n) => n.bot === botId)?.text ?? null);
  return { version: latest.version, publishedAt: latest.publishedAt, text: latest.rules, note };
}

/**
 * Publish rules already checked (`bots.publishRules`) as the next version.
 * The oldest beyond `KEPT_RULE_VERSIONS` are dropped. Returns the version.
 */
export async function publishRules(
  ctx: MutationCtx,
  userId: Id<"users">,
  rules: string,
  notes: { bot: string; text: string }[],
  now: number,
): Promise<number> {
  const latest = await latestRules(ctx, userId);
  const version = (latest?.version ?? 0) + 1;
  await ctx.db.insert("botRuleVersions", { userId, version, rules, notes, publishedAt: now });
  const old = await ctx.db
    .query("botRuleVersions")
    .withIndex("by_userId_and_version", (q) => q.eq("userId", userId).lte("version", version - KEPT_RULE_VERSIONS))
    .take(20);
  for (const row of old) await ctx.db.delete(row._id);
  return version;
}
