import { type FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { SOURCES, feedOf, ingestTokenEnv, missingEnv } from "./connectors/manifest";
import { sourceServesAny } from "./lib/company";
import { sourceOn, withFeatures } from "./lib/featureGates";
import { BACKFILL_MONTHS, clampLimit } from "./lib/limits";
import type { SourceId } from "./lib/metricRegistry";
import { MIRROR_SOURCES } from "./lib/mirrorRules";
import { NOT_ALLOWED, memberMutation, memberQuery, type Member } from "./lib/owner";
import { may } from "./lib/roles";

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_RETENTION_DAYS = 30;
/** The most run-log rows read to fill one page for a caller who is sent only some of them. */
const RUN_SCAN_LIMIT = 2000;

/**
 * Whether a caller is told how a source stands and may start it: the sources
 * page, its run log and "Run now" (the `settings` area), and the feeds the
 * scorecard reports. Two rules, and the owner passes both:
 *
 * - A source is a company's (`sourceServes`): its state, its failures and its
 *   runs go only to the people on that company. One that serves both is
 *   everyone's who has the area.
 * - The four work tools (Gmail, Calendar, Linear, Fireflies) are read into the
 *   owner's own records. How they stand is the owner's own too, like the
 *   records: it goes with the `personal` area, which no teammate can be given.
 */
export function maySeeSource(member: Member, source: string): boolean {
  // A source a switched-off feature takes away is nobody's (convex/lib/featureGates.ts).
  if (!sourceOn(source)) return false;
  if (!sourceServesAny(member.companies, source)) return false;
  // The people the owner's own mail and meetings put in the Contacts book go
  // with those tools: their source carries them (`carriedBy`).
  const own = SOURCES.find((def) => def.id === source)?.carriedBy ?? source;
  const area = (MIRROR_SOURCES as readonly string[]).includes(own) ? "personal" : "settings";
  return may(member, area);
}

/**
 * Every wired-up source the caller may see (`maySeeSource`), with whether it
 * is configured and how its last run went. Reports env var *names* that are
 * missing, never values.
 *
 * The owner's agent reads the same list and is handed only each source's
 * state and run times from it (convex/lib/mcpTools.ts): never a variable's name.
 */
export async function sourcesFor(ctx: QueryCtx, member: Member) {
  {
    const result = [];
    for (const source of SOURCES) {
      // Not read at all for a caller it is not sent to.
      if (!maySeeSource(member, source.id)) continue;
      const status = await ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", source.id))
        .unique();
      // Fed either way counts as configured: a pulled source with its API
      // variables, or one a connector run pushes with its ingest token.
      const fedBy = feedOf(source);
      const missing = fedBy === null ? missingEnv(source) : [];
      result.push({
        id: source.id,
        label: source.label,
        kind: source.kind,
        description: withFeatures(source.description),
        configured: fedBy !== null,
        /** "manual", "push" or "pull"; null until something it needs is set. */
        fedBy,
        canBackfill: source.kind === "api" && source.backfill !== false,
        missingEnv: missing,
        /** The other way in for a pulled source: the token a connector run pushes with. */
        pushEnv: source.pushable === true ? ingestTokenEnv(source.id) : null,
        status: status
          ? {
              state: status.state,
              message: status.message ?? null,
              lastRunAt: status.lastRunAt,
              lastOkAt: status.lastOkAt ?? null,
            }
          : null,
      });
    }
    return result;
  }
}

export const list = memberQuery("settings")({
  args: {},
  handler: (ctx) => sourcesFor(ctx, ctx.member),
});

/**
 * The latest runs of the sources the caller may see, newest first. The limit
 * counts what is returned: runs of another company's sources, or of the
 * owner's work tools, are passed over, never sent and never counted.
 */
export const recentRuns = memberQuery("settings")({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 20, 100);
    const runs = [];
    let read = 0;
    for await (const run of ctx.db.query("syncRuns").withIndex("by_startedAt").order("desc")) {
      if (maySeeSource(ctx.member, run.source)) runs.push(run);
      read += 1;
      if (runs.length >= limit || read >= RUN_SCAN_LIMIT) break;
    }
    return runs.map((r) => ({
      id: r._id,
      source: r.source,
      batchId: r.batchId ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      message: r.message ?? null,
      inserted: r.inserted,
      updated: r.updated,
      unchanged: r.unchanged,
    }));
  },
});

/** The action that syncs each pulled source. A new connector adds its line here. */
type SyncAction = FunctionReference<"action", "internal", { months?: number }>;
export const SYNC_ACTIONS: Partial<Record<SourceId, SyncAction>> = {
  mercury: internal.connectors.mercury.sync,
  posthog: internal.connectors.posthog.sync,
  posthog_globex: internal.connectors.posthogGlobex.sync,
  vercel: internal.connectors.vercel.sync,
  vertical_startup: internal.connectors.verticalHealth.sync,
  search_console: internal.connectors.searchConsole.sync,
  apollo: internal.connectors.apollo.sync,
  gmail: internal.connectors.gmail.sync,
  google_calendar: internal.connectors.googleCalendar.sync,
  linear: internal.connectors.linear.sync,
  fireflies: internal.connectors.fireflies.sync,
};

/** How often one source may be started by hand. */
const RUN_NOW_EVERY_MS = 60 * 1000;
export const RUN_NOW_TOO_SOON = "That source was started less than a minute ago. Try again in a minute.";

/**
 * Start a pulled source's sync now instead of waiting for its schedule. The
 * sync runs in the background and reports through the source's status.
 */
export const runNow = memberMutation("settings")({
  args: { source: v.string(), backfill: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const source = SOURCES.find((s) => s.id === args.source);
    if (!source) throw new ConvexError(`Unknown source "${args.source}".`);
    // Another company's source, or one of the owner's own work tools: refused
    // before anything about it is said, in the words of a missing permission.
    if (!maySeeSource(ctx.member, source.id)) throw new ConvexError(NOT_ALLOWED);
    const sync = SYNC_ACTIONS[source.id];
    if (source.kind !== "api" || !sync) {
      throw new ConvexError(`"${source.id}" is not pulled by the OS, so there is nothing to run.`);
    }
    if (args.backfill && source.backfill === false) {
      throw new ConvexError(
        `"${source.id}" has no backfill: every run reads all the source keeps.`,
      );
    }
    if (feedOf(source) === "push") {
      throw new ConvexError(
        `"${source.id}" is pushed by a connector run, so there is nothing to run here.`,
      );
    }
    // Without its variables the run would only log "not configured".
    const missing = missingEnv(source);
    if (missing.length > 0) {
      throw new ConvexError(`Set ${missing.join(", ")} on the Convex deployment first.`);
    }
    // Once a minute a source, whoever asks: a run reads the whole window
    // from someone else's API, and a button can be pressed many times.
    const now = Date.now();
    const last = await ctx.db
      .query("sourceRunRequests")
      .withIndex("by_source", (q) => q.eq("source", source.id))
      .first();
    if (last !== null && now - last.at < RUN_NOW_EVERY_MS) throw new ConvexError(RUN_NOW_TOO_SOON);
    if (last === null) await ctx.db.insert("sourceRunRequests", { source: source.id, at: now });
    else await ctx.db.patch(last._id, { at: now });
    await ctx.scheduler.runAfter(0, sync, args.backfill ? { months: BACKFILL_MONTHS } : {});
    return null;
  },
});

const PRUNE_BATCH = 500;

/**
 * Drop run-log entries past the retention window, a batch at a time. When a
 * batch comes back full there may be more, so it schedules itself again
 * rather than leaving the rest for next week's cron: hourly connectors write
 * more runs in a week than one batch removes.
 */
export const pruneRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RUN_RETENTION_DAYS * DAY_MS;
    const old = await ctx.db
      .query("syncRuns")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", cutoff))
      .take(PRUNE_BATCH);
    for (const run of old) await ctx.db.delete(run._id);
    if (old.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sources.pruneRuns, {});
    }
    return old.length;
  },
});
