// The near-duplicate check's owner setting and its log (convex/lib/duplicates.ts
// has the rules): the threshold, read and set by the owner on Agents › Bots,
// and the log line of a refused check, which the endpoint writes after the
// refusing transaction rolled back. Numbers and closed words only.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  DEFAULT_DUP_THRESHOLD,
  DUPLICATE_CHECK_TOOLS,
  DUPLICATE_WORDS,
  MIN_DUP_THRESHOLD,
  dupThreshold,
} from "./lib/duplicates";
import { ownerMutation, ownerQuery } from "./lib/owner";

/** The threshold in force, and whether it is the default. */
export const settings = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const threshold = await dupThreshold(ctx);
    return { threshold, isDefault: (await ctx.db.query("duplicateSettings").first()) === null, defaultThreshold: DEFAULT_DUP_THRESHOLD };
  },
});

/** Set the threshold: from 0.5 to 1, two decimals. */
export const setThreshold = ownerMutation({
  args: { threshold: v.number() },
  handler: async (ctx, { threshold }) => {
    if (!Number.isFinite(threshold) || threshold < MIN_DUP_THRESHOLD || threshold > 1) {
      throw new ConvexError(DUPLICATE_WORDS.threshold);
    }
    const value = Math.round(threshold * 100) / 100;
    const row = await ctx.db.query("duplicateSettings").first();
    const now = Date.now();
    if (row === null) await ctx.db.insert("duplicateSettings", { threshold: value, updatedAt: now });
    else await ctx.db.patch(row._id, { threshold: value, updatedAt: now });
    return { threshold: value };
  },
});

/** A refused check's log line, written by the endpoint (convex/mcp.ts). */
export const logRefused = internalMutation({
  args: {
    at: v.number(),
    tool: v.union(...DUPLICATE_CHECK_TOOLS.map((t) => v.literal(t))),
    sim: v.number(),
    threshold: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("duplicateChecks", { ...args, decision: "refused" });
    return null;
  },
});
