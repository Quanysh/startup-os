import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { companyOfMetric } from "./lib/company";
import { MAX_RUN_MESSAGE_LENGTH } from "./lib/limits";
import { currencyOf, getMetric } from "./lib/metricRegistry";
import { memberMutation, requireCompany } from "./lib/owner";
import { applyPipelinePush } from "./lib/pipelineOps";
import { may } from "./lib/roles";
import { isCanonicalPeriodStart, periodStart } from "./lib/periods";
import { upsertSnapshots } from "./lib/snapshotWriter";
import { periodValidator, runStatusValidator } from "./schema";

const rowValidator = v.object({
  key: v.string(),
  scope: v.string(),
  period: periodValidator,
  periodStart: v.string(),
  value: v.number(),
  currency: v.optional(v.string()),
});

// A deal or an investor as it arrives in a push (convex/lib/ingestSchema.ts).
const pipelineRowValidator = v.object({
  externalId: v.string(),
  name: v.string(),
  contact: v.optional(v.string()),
  stage: v.string(),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  lastActivityAt: v.optional(v.string()),
  closedAt: v.optional(v.string()),
});

export async function setSourceStatus(
  ctx: MutationCtx,
  source: string,
  update: { state: "ok" | "error" | "not_configured" | "empty"; message?: string; at: number },
) {
  const existing = await ctx.db
    .query("sourceStatus")
    .withIndex("by_source", (q) => q.eq("source", source))
    .unique();
  const next = {
    source,
    state: update.state,
    message: update.message,
    lastRunAt: update.at,
    // Only a good run moves lastOkAt; a failure keeps showing when the
    // numbers on screen were last confirmed.
    lastOkAt: update.state === "ok" ? update.at : existing?.lastOkAt,
  };
  if (existing === null) await ctx.db.insert("sourceStatus", next);
  else await ctx.db.replace(existing._id, next);
}

/**
 * The single write path for synced data (connectors and the ingest endpoint).
 * Rows, the run log entry and the source's status land in one transaction, so
 * the status can never say "ok" for rows that were not written.
 */
export const applySync = internalMutation({
  args: {
    source: v.string(),
    batchId: v.optional(v.string()),
    observedAt: v.optional(v.string()),
    startedAt: v.number(),
    rows: v.array(rowValidator),
    // Deals and investors in the same push. They land with the snapshots or
    // not at all.
    pipeline: v.optional(
      v.object({
        mode: v.union(v.literal("upsert"), v.literal("replace")),
        deals: v.optional(v.array(pipelineRowValidator)),
        investors: v.optional(v.array(pipelineRowValidator)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const snapshots = await upsertSnapshots(ctx, args.source, args.rows, now);
    const pipeline = args.pipeline
      ? await applyPipelinePush(ctx, args.source, args.pipeline, now)
      : null;
    const counts = {
      inserted: snapshots.inserted + (pipeline?.inserted ?? 0),
      updated: snapshots.updated + (pipeline?.updated ?? 0),
      unchanged: snapshots.unchanged + (pipeline?.unchanged ?? 0),
      // Only a push that carried pipeline rows can archive any.
      ...(pipeline ? { archived: pipeline.archived } : null),
    };
    await ctx.db.insert("syncRuns", {
      source: args.source,
      batchId: args.batchId,
      observedAt: args.observedAt,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      ...counts,
    });
    await setSourceStatus(ctx, args.source, { state: "ok", at: now });
    return counts;
  },
});

/** Log a run that wrote nothing. Stored snapshots are left exactly as they were. */
export const recordFailure = internalMutation({
  args: {
    source: v.string(),
    batchId: v.optional(v.string()),
    startedAt: v.number(),
    status: runStatusValidator,
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const message = args.message.slice(0, MAX_RUN_MESSAGE_LENGTH);
    await ctx.db.insert("syncRuns", {
      source: args.source,
      batchId: args.batchId,
      startedAt: args.startedAt,
      finishedAt: now,
      status: args.status,
      message,
      inserted: 0,
      updated: 0,
      unchanged: 0,
    });
    await setSourceStatus(ctx, args.source, { state: args.status, message, at: now });
    return null;
  },
});

/**
 * Type a number in. `date` is any day inside the bucket it belongs to. For
 * the `settings` area, and only for a figure of one of the caller's companies
 * (`companyOfMetric`): another company's is refused as a missing permission is.
 */
export const setManual = memberMutation("settings")({
  args: {
    key: v.string(),
    scope: v.string(),
    date: v.string(),
    value: v.number(),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const metric = getMetric(args.key);
    if (!metric) throw new ConvexError(`Unknown metric "${args.key}".`);
    requireCompany(ctx.member, companyOfMetric(args.key, args.scope));
    if (!isCanonicalPeriodStart("day", args.date)) {
      throw new ConvexError(`"${args.date}" is not a date.`);
    }
    const row = {
      key: args.key,
      scope: args.scope,
      period: metric.grain,
      periodStart: periodStart(metric.grain, new Date(`${args.date}T00:00:00Z`)),
      value: args.value,
      // Money is stored in its market's currency; the form need not ask.
      currency:
        args.currency ??
        currencyOf(metric, args.scope),
    };
    await upsertSnapshots(ctx, "manual", [row], Date.now());
    return null;
  },
});

/** Said to someone who may not see a figure, whatever is or is not stored for it. */
export const NOTHING_TYPED_IN = "There is no typed-in value there to remove.";

/**
 * Remove a typed-in number. Values written by a sync cannot be removed here.
 * As `setManual`: only for a figure of one of the caller's companies, asked
 * before the stored value is read.
 */
export const removeManual = memberMutation("settings")({
  args: { key: v.string(), scope: v.string(), periodStart: v.string() },
  handler: async (ctx, args) => {
    const metric = getMetric(args.key);
    if (!metric) throw new ConvexError(`Unknown metric "${args.key}".`);
    requireCompany(ctx.member, companyOfMetric(args.key, args.scope));
    const existing = await ctx.db
      .query("metricSnapshots")
      .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
        q
          .eq("key", args.key)
          .eq("scope", args.scope)
          .eq("period", metric.grain)
          .eq("periodStart", args.periodStart),
      )
      .unique();
    // Someone who types figures in without the page that shows them (the
    // `settings` area without the figure's own) is told one thing whether a
    // value is there or not, and never which source wrote it.
    // (Its company was asked above; what is left of `maySeeMetric` is its section.)
    if (!may(ctx.member, metric.section)) {
      if (existing === null || existing.source !== "manual") {
        throw new ConvexError(NOTHING_TYPED_IN);
      }
    } else {
      if (existing === null) return null;
      if (existing.source !== "manual") {
        throw new ConvexError(`This value comes from "${existing.source}", not manual entry.`);
      }
    }
    await ctx.db.delete(existing._id);
    return null;
  },
});
