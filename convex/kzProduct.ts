import { v } from "convex/values";
import { requireFeature } from "./lib/featureGates";
import { METRICS } from "./lib/metricRegistry";
import { memberQuery } from "./lib/owner";
import { maySeeMetric } from "./metrics";

// Globex's app in breakdowns (`kzBreakdowns`): the heat map of failures by
// hour, pages by their interface response, and events and their empty fields
// for tracking health. Product's, and Globex's alone; no row names a person.

/** The finished weeks a breakdown is read for: two months, enough to see what went silent. */
export const BREAKDOWN_WEEKS = 8;
/** Rows a week at most: 168 hours, or a few hundred events, pages and fields. */
const ROWS_A_WEEK = 400;

export const breakdowns = memberQuery("product", "kz")({
  args: { kind: v.union(v.literal("hour"), v.literal("page"), v.literal("event"), v.literal("field")) },
  handler: async (ctx, args) => {
    requireFeature("kzProduct");
    const rows = await ctx.db
      .query("kzBreakdowns")
      .withIndex("by_kind_and_weekStart", (q) => q.eq("kind", args.kind))
      .order("desc")
      .take(BREAKDOWN_WEEKS * ROWS_A_WEEK);
    const weeks = [...new Set(rows.map((r) => r.weekStart))].sort().slice(-BREAKDOWN_WEEKS);
    return rows
      .filter((r) => weeks.includes(r.weekStart))
      .map((r) => ({ weekStart: r.weekStart, key: r.key, values: r.values }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.key.localeCompare(b.key));
  },
});

/** The weeks of history a period may reach back over: a year. */
export const HISTORY_WEEKS = 53;

/**
 * Every weekly figure of Globex's app over the last year, in one read, so
 * a period on Product › Kazakhstan can reach back past the scorecard's 13
 * weeks. The product's own scope only, newest last, and each figure only to
 * a caller who may see it (`maySeeMetric`, the scorecard's rule): the app's
 * AI spend is Finance's, so a teammate with Product alone is not sent it.
 */
export const history = memberQuery("product", "kz")({
  args: {},
  handler: async (ctx) => {
    requireFeature("kzProduct");
    const out: { key: string; series: { periodStart: string; value: number }[] }[] = [];
    for (const metric of METRICS) {
      if (metric.grain !== "week" || metric.sources.kz_product === undefined) continue;
      if (metric.section !== "product" && metric.section !== "finance") continue;
      if (!maySeeMetric(ctx.member, metric, "kz_product")) continue;
      const rows = await ctx.db
        .query("metricSnapshots")
        .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
          q.eq("key", metric.key).eq("scope", "kz_product").eq("period", "week"),
        )
        .order("desc")
        .take(HISTORY_WEEKS);
      if (rows.length === 0) continue;
      out.push({ key: metric.key, series: rows.reverse().map((r) => ({ periodStart: r.periodStart, value: r.value })) });
    }
    return out;
  },
});

/**
 * The clinics Globex's app knows, by their id there, each with its last
 * finished week and whether it is linked to a clinic in Customers. No name:
 * a linked clinic's name is Customers' to send.
 */
export const appClinics = memberQuery("product", "kz")({
  args: {},
  handler: async (ctx) => {
    requireFeature("kzProduct");
    const rows = await ctx.db.query("kzAppClinics").take(500);
    return rows
      .map((r) => ({
        org: r.org,
        customerId: r.customerId ?? null,
        weeks: r.weeks,
        actions: r.actions,
        doctors: r.doctors,
        lastActiveOn: r.lastActiveOn ?? null,
      }))
      .sort((a, b) => b.actions - a.actions || a.org.localeCompare(b.org));
  },
});
