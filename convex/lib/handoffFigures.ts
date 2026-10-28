import type { QueryCtx } from "../_generated/server";
import { isAgentId } from "./agents";
import { MAX_BOTS } from "./botRules";
import { handoffKey } from "./handoffs";
import { FIGURE_AREAS, type Area } from "./roles";

// Which of the company's figures a side of a handoff could have written into
// it: what decides who is sent a handoff's words (convex/handoffs.ts `list`)
// and whether the company's Telegram group is told them (convex/telegram.ts
// `prepareHandoff`). Reads the bot profiles, so Convex's alone.

/**
 * The figure areas (`FIGURE_AREAS`) one side of a handoff can read: none for
 * a person, whose words are their own; a bot profile's own permissions; and,
 * for one of the owner's four agents, an external profile or a name no
 * profile has, every one of them, since nothing says what it reads.
 */
export async function figureAreasOf(ctx: QueryCtx, name: string, kind: "person" | undefined): Promise<readonly Area[]> {
  if (kind === "person") return [];
  const key = handoffKey(name);
  if (key.startsWith("bot:") || isAgentId(key)) return FIGURE_AREAS;
  const profiles = await ctx.db
    .query("bots")
    .withIndex("by_botId", (q) => q.eq("botId", key))
    .take(MAX_BOTS);
  if (profiles.length === 0) return FIGURE_AREAS;
  return FIGURE_AREAS.filter((area) => profiles.some((bot) => bot.permissions.some((p) => p.area === area)));
}

