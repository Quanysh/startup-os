// Globex's Intercom inbox (/support, the `support` area; Globex's alone).
//
// **Startup OS never calls Intercom and holds no Intercom credential.** Once a
// day a task on the owner's Mac reads the inbox through Claude's Intercom
// connector (read-only calls only), maps each conversation to the fields the
// OS keeps with `pnpm support:envelope` (convex/lib/supportParse.ts: never a
// message, a subject or anything about the customer) and pushes the envelope
// to POST /ingest/v1 on the `intercom` source's own token
// (INGEST_TOKEN_INTERCOM). The endpoint checks it (convex/lib/supportRecords.ts)
// and `applyPush` here writes it, the one writer of `supportConversations`.
// How each push went is where Settings › Sources reads it (`sourceStatus`,
// `syncRuns`), as for every pushed source.

import { v } from "convex/values";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { SOURCES, feedOf } from "./connectors/manifest";
import { memberQuery, type Member } from "./lib/owner";
import {
  INTERCOM_SOURCE,
  MAX_SUPPORT_CONVERSATIONS,
  SUPPORT_KEEP_DAYS,
  SUPPORT_READ_DAYS,
  failureOf,
  type SupportFailure,
  type SupportRow,
} from "./lib/support";
import type { SupportRowView } from "./lib/supportMetrics";
import { supportRowValidator } from "./schema";
import { setSourceStatus } from "./snapshots";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most stored rows of each kind (open; closed and updated in the window) one push reads. */
const WINDOW_CAP = 2 * MAX_SUPPORT_CONVERSATIONS;
/**
 * How far before the last push the page's closed chats reach: the chart's
 * eight weeks from any clock at or after the push, and a week to spare.
 */
const PAGE_DAYS = 63;
/** Closed chats past `SUPPORT_KEEP_DAYS` deleted by one push, at most: the rest go with the next. */
const PRUNE_BATCH = 500;

const intercom = () => SOURCES.find((source) => source.id === INTERCOM_SOURCE)!;

const sameRow = (stored: Record<string, unknown>, row: SupportRow) =>
  (Object.keys(row) as (keyof SupportRow)[]).every(
    (key) => JSON.stringify(stored[key]) === JSON.stringify(row[key]),
  );

/**
 * One push, in one transaction. The push is the whole current set (every
 * open chat and every chat updated in `SUPPORT_READ_DAYS`), so each chat is
 * upserted by its id, and a stored chat the push does not hold goes if it is
 * open or was updated inside that window (it is gone from Intercom); closed
 * chats updated before the window are kept until `SUPPORT_KEEP_DAYS` and then
 * deleted, a batch a push. Then the workspace's id, the run's counts and the
 * source's status. A push that would remove more than half of the chats its
 * window holds (an empty one over stored chats included) is refused with the
 * counts, and nothing is written, unless it says `allowShrink`.
 */
export const applyPush = internalMutation({
  args: {
    startedAt: v.number(),
    observedAt: v.string(),
    appId: v.string(),
    rows: v.array(supportRowValidator),
    /** The push says it means to remove more than half of what its window holds. */
    allowShrink: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const observed = Date.parse(args.observedAt);
    const readFrom = (Number.isNaN(observed) ? args.startedAt : observed) - SUPPORT_READ_DAYS * DAY_MS;
    const pushed = new Set(args.rows.map((row) => row.intercomId));

    // What the push's window holds now: every open chat (an open chat is
    // always in the push), and every closed one updated inside the window.
    // Each is bounded: a push holds at most MAX_SUPPORT_CONVERSATIONS, and
    // each push replaces the window, so neither can hold much more.
    const open = await ctx.db
      .query("supportConversations")
      .withIndex("by_open_and_updatedAt", (q) => q.eq("open", true))
      .take(WINDOW_CAP);
    const recent = await ctx.db
      .query("supportConversations")
      .withIndex("by_open_and_updatedAt", (q) => q.eq("open", false).gte("updatedAt", readFrom))
      .take(WINDOW_CAP);
    const window = [...open, ...recent];
    const gone = window.filter((row) => !pushed.has(row.intercomId));
    // More than half of it gone is far more often a short read than an inbox
    // that emptied: refused unless the push says so, and nothing is written.
    if (!args.allowShrink && gone.length * 2 > window.length) {
      return { ok: false as const, removing: gone.length, of: window.length };
    }

    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("supportConversations")
        .withIndex("by_intercomId", (q) => q.eq("intercomId", row.intercomId))
        .unique();
      if (existing === null) {
        await ctx.db.insert("supportConversations", { ...row, syncedAt: now });
        counts.inserted += 1;
      } else if (sameRow(existing, row)) {
        counts.unchanged += 1;
      } else {
        await ctx.db.replace(existing._id, { ...row, syncedAt: now });
        counts.updated += 1;
      }
    }
    for (const row of gone) await ctx.db.delete(row._id);
    const removed = gone.length;
    const old = await ctx.db
      .query("supportConversations")
      .withIndex("by_open_and_updatedAt", (q) =>
        q.eq("open", false).lt("updatedAt", args.startedAt - SUPPORT_KEEP_DAYS * DAY_MS),
      )
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);

    const workspace = await ctx.db.query("supportWorkspace").first();
    if (workspace === null) await ctx.db.insert("supportWorkspace", { appId: args.appId, readAt: now });
    else await ctx.db.replace(workspace._id, { appId: args.appId, readAt: now });

    await ctx.db.insert("syncRuns", {
      source: INTERCOM_SOURCE,
      observedAt: args.observedAt,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      ...counts,
    });
    await setSourceStatus(ctx, INTERCOM_SOURCE, { state: "ok", at: now });
    return { ok: true as const, ...counts, removed: removed + old.length };
  },
});

export type SupportOverview = {
  /** Whether the `intercom` source's ingest token is set (its value is never read here). */
  configured: boolean;
  /** The workspace's id code, for links; null until a good read. */
  appId: string | null;
  /** How the last push went: times, and a failure as a key (`failureOf`), never the stored message. */
  status: {
    state: "ok" | "error" | "empty" | "not_configured" | null;
    lastRunAt: number | null;
    lastOkAt: number | null;
    failure: SupportFailure | null;
  };
  rows: SupportRowView[];
};

/**
 * What the page and the owner's agent are sent: each chat's fields the
 * figures read (convex/lib/supportMetrics.ts), oldest first, and how the read
 * went. Globex's, so nothing for a member who is not on it. Reads no clock.
 */
export async function supportFor(ctx: QueryCtx, member: Member): Promise<SupportOverview | null> {
  if (!member.companies.includes("kz")) return null;
  const status = await ctx.db
    .query("sourceStatus")
    .withIndex("by_source", (q) => q.eq("source", INTERCOM_SOURCE))
    .unique();
  const workspace = await ctx.db.query("supportWorkspace").first();
  // What the page shows, and no more: every open chat (waits, open counts,
  // hygiene), and closed chats begun in the `PAGE_DAYS` before the last push
  // (the 8 weeks of the chart and the 30 days of the figures, from any clock
  // at or after the push). Bounded by the index and the push's own cap.
  const pushedAt = status?.lastOkAt ?? null;
  const open =
    pushedAt === null
      ? []
      : await ctx.db
          .query("supportConversations")
          .withIndex("by_open_and_createdAt", (q) => q.eq("open", true))
          .take(WINDOW_CAP);
  const closed =
    pushedAt === null
      ? []
      : await ctx.db
          .query("supportConversations")
          .withIndex("by_open_and_createdAt", (q) => q.eq("open", false).gte("createdAt", pushedAt - PAGE_DAYS * DAY_MS))
          .take(WINDOW_CAP);
  const stored = [...open, ...closed];
  return {
    configured: feedOf(intercom()) !== null,
    appId: workspace?.appId ?? null,
    status: {
      state: status?.state ?? null,
      lastRunAt: status?.lastRunAt ?? null,
      lastOkAt: status?.lastOkAt ?? null,
      failure: failureOf(status?.state),
    },
    rows: stored
      .sort((a, b) => a.createdAt - b.createdAt || a.intercomId.localeCompare(b.intercomId))
      .map(
        (row): SupportRowView => ({
          intercomId: row.intercomId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          state: row.state,
          open: row.open,
          waitingSince: row.waitingSince,
          origin: row.origin,
          pageArea: row.pageArea,
          finParticipated: row.finParticipated,
          finOutcome: row.finOutcome,
          humanRepliedAt: row.humanRepliedAt,
          timeToHumanReply: row.timeToHumanReply,
          lastCustomerReplyAt: row.lastCustomerReplyAt,
          lastHumanReplyAt: row.lastHumanReplyAt,
          assigneeId: row.assigneeId,
          assigneeName: row.assigneeName,
          articles: row.articles,
        }),
      ),
  };
}

/** The Support page's data: the `support` area, on Globex. */
export const overview = memberQuery("support", "kz")({
  args: {},
  handler: async (ctx): Promise<SupportOverview> => (await supportFor(ctx, ctx.member))!,
});
