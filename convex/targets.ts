import { ConvexError, v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { companyOfMetric, metricServesAny } from "./lib/company";
import { getMetric, metricScopes } from "./lib/metricRegistry";
import { memberMutation, memberQuery, requireCompany } from "./lib/owner";
import { may } from "./lib/roles";
import { maySeeMetric } from "./metrics";

function find(ctx: QueryCtx, key: string, scope: string) {
  return ctx.db
    .query("metricTargets")
    .withIndex("by_key_and_scope", (q) => q.eq("key", key).eq("scope", scope))
    .unique();
}

/**
 * The targets the caller may read, and no others: those of the figures they
 * may see (`maySeeMetric`), and, for someone with the `settings` area, those
 * they may set, which are every figure's of their companies. A target is not
 * the figure: the area opens no value of a figure (`metrics.series`).
 */
export const list = memberQuery(["scorecard", "settings"])({
  args: {},
  handler: async (ctx) => {
    const targets = await ctx.db.query("metricTargets").collect();
    const sets = may(ctx.member, "settings");
    return targets
      .filter((t) => {
        const metric = getMetric(t.key);
        if (metric === undefined) return false;
        return (
          (may(ctx.member, "scorecard") && maySeeMetric(ctx.member, metric, t.scope)) ||
          (sets && metricServesAny(ctx.member.companies, t.key, t.scope))
        );
      })
      .map((t) => ({ key: t.key, scope: t.scope, target: t.target }));
  },
});

/**
 * Set the target for one metric in one scope, in that scope's unit. For the
 * `settings` area, and only for a figure of one of the caller's companies
 * (`companyOfMetric`): another company's is refused as a missing permission is.
 */
export const set = memberMutation("settings")({
  args: { key: v.string(), scope: v.string(), target: v.number() },
  handler: async (ctx, args) => {
    const metric = getMetric(args.key);
    if (!metric) throw new ConvexError(`Unknown metric "${args.key}".`);
    requireCompany(ctx.member, companyOfMetric(args.key, args.scope));
    if (!metricScopes(metric).some((scope) => scope === args.scope)) {
      throw new ConvexError(`"${args.key}" has no "${args.scope}" scope.`);
    }
    if (!Number.isFinite(args.target)) throw new ConvexError("A target must be a number.");

    const existing = await find(ctx, args.key, args.scope);
    if (existing) await ctx.db.patch(existing._id, { target: args.target });
    else await ctx.db.insert("metricTargets", args);
    return null;
  },
});

/** Remove a target. As `set`: only for a figure of one of the caller's companies. */
export const clear = memberMutation("settings")({
  args: { key: v.string(), scope: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, companyOfMetric(args.key, args.scope));
    const existing = await find(ctx, args.key, args.scope);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
