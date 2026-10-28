import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { metricServesAny } from "./lib/company";
import { productOn } from "./lib/featureGates";
import { clampLimit } from "./lib/limits";
import { METRICS, getMetric, metricScopes, type MetricDef } from "./lib/metricRegistry";
import { memberQuery, type Member } from "./lib/owner";
import { ANY_AREA, may } from "./lib/roles";
import { maySeeSource } from "./sources";

/** Buckets returned per tile: a quarter of weeks, or just over a year of months. */
export const SCORECARD_SERIES_LENGTH = 13;

/**
 * Whether a caller may be sent a figure: its section is an area they have,
 * and it belongs to one of their companies. The one rule for the
 * scorecard, a series and the targets, so they cannot disagree. A figure of
 * a product a switched-off feature takes away (convex/lib/featureGates.ts)
 * is nobody's.
 */
export function maySeeMetric(member: Member, metric: MetricDef, scope: string): boolean {
  return (
    productOn(scope) &&
    may(member, [metric.section, ...(metric.alsoFor ?? [])]) &&
    metricServesAny(member.companies, metric.key, scope)
  );
}

async function recentBuckets(
  ctx: QueryCtx,
  metric: MetricDef,
  scope: string,
  limit: number,
) {
  const newestFirst = await ctx.db
    .query("metricSnapshots")
    .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
      q.eq("key", metric.key).eq("scope", scope).eq("period", metric.grain),
    )
    .order("desc")
    .take(limit);
  return newestFirst.reverse();
}

/**
 * Everything the scorecard needs in one subscription: the latest value and a
 * short series for every metric and scope the caller may see, plus the last
 * good run of each source that serves one of their companies. A figure the
 * caller may not see is not in the result at all, and is never read.
 *
 * Deliberately returns raw timestamps and never calls Date.now(): a query's
 * result is cached until something it read changes, so "is this stale?" has to
 * be answered on the client against a ticking clock.
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function scorecardFor(ctx: QueryCtx, member: Member) {
  {
    const tiles = [];
    // The sources behind the figures in the result. A teammate hears about
    // those and no others: the state of the bank feed is not an engineer's.
    const feeding = new Set<string>();
    for (const metric of METRICS) {
      for (const scope of metricScopes(metric)) {
        if (!maySeeMetric(member, metric, scope)) continue;
        const feed = metric.sources[scope];
        if (feed !== undefined) feeding.add(feed);
        const rows = await recentBuckets(ctx, metric, scope, SCORECARD_SERIES_LENGTH);
        const last = rows.at(-1);
        // Only read separately when the window is full; otherwise the
        // window's own first row is the first bucket ever recorded.
        const first =
          rows.length < SCORECARD_SERIES_LENGTH
            ? rows[0]
            : await ctx.db
                .query("metricSnapshots")
                .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
                  q.eq("key", metric.key).eq("scope", scope).eq("period", metric.grain),
                )
                .first();
        tiles.push({
          key: metric.key,
          scope,
          firstPeriodStart: first?.periodStart ?? null,
          latest: last
            ? {
                value: last.value,
                periodStart: last.periodStart,
                currency: last.currency ?? null,
                source: last.source,
                syncedAt: last.syncedAt,
              }
            : null,
          series: rows.map((r) => ({ periodStart: r.periodStart, value: r.value })),
        });
      }
    }

    const sources: Record<
      string,
      { state: string; lastRunAt: number; lastOkAt: number | null; message: string | null }
    > = {};
    for await (const status of ctx.db.query("sourceStatus")) {
      // Whoever may open the sources page hears of every feed it lists for
      // them (`maySeeSource`: their companies', and the owner's own work tools
      // for the owner alone). Anyone else, only of the feeds behind their figures.
      if (!maySeeSource(member, status.source) && !feeding.has(status.source)) continue;
      sources[status.source] = {
        state: status.state,
        lastRunAt: status.lastRunAt,
        lastOkAt: status.lastOkAt ?? null,
        message: status.message ?? null,
      };
    }

    return { tiles, sources };
  }
}

export const scorecard = memberQuery(ANY_AREA)({
  args: {},
  handler: (ctx) => scorecardFor(ctx, ctx.member),
});

/**
 * A longer history of one metric, for a detail chart or the entry form. A
 * figure the caller may not see answers as an unknown one does, with an empty
 * list, so the query cannot be used to find out what exists.
 */
export const series = memberQuery(ANY_AREA)({
  args: { key: v.string(), scope: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, args) => seriesFor(ctx, ctx.member, args.key, args.scope, args.limit),
});

/**
 * What `metrics.series` returns, for a caller: also read by the budget's
 * report for the owner's agent (Kazakhstan's balance history), so the two
 * cannot drift.
 */
export async function seriesFor(
  ctx: QueryCtx,
  member: Member,
  key: string,
  scope: string,
  requested?: number,
) {
  const metric = getMetric(key);
  if (!metric || !metricScopes(metric).some((s) => s === scope)) return [];
  if (!maySeeMetric(member, metric, scope)) return [];
  const limit = clampLimit(requested, 36, 400);
  const rows = await recentBuckets(ctx, metric, scope, limit);
  return rows.map((r) => ({
    periodStart: r.periodStart,
    value: r.value,
    currency: r.currency ?? null,
    source: r.source,
    syncedAt: r.syncedAt,
  }));
}
