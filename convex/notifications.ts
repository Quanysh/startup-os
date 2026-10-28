// The notification center: what a person has been told about the board
// (convex/lib/notify.ts writes the rows). Everything here is the caller's own
// rows and nobody else's: no function takes an argument that names a person.
//
// Open to anyone with a page, the board or not: a row is the title a task had
// and who did what, which is what they were told. It carries no note and no
// other field of the task. Whether a row leads anywhere is the page's to
// decide by `can("board")`; the server says only whether the task still
// exists and is still one the caller may see.
//
// The company rule: a row about a task of a company the caller is no longer
// on is neither sent nor counted. It is not deleted; it goes by age.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import {
  MAX_NOTIFICATIONS,
  NOTIFICATION_PAGE,
  NOTIFICATION_RETENTION_DAYS,
  UNREAD_COUNT_CAP,
  clampLimit,
} from "./lib/limits";
import { memberMutation, memberQuery, type Member } from "./lib/owner";
import { ANY_AREA, may } from "./lib/roles";
import { knows, teamDirectory, type Person } from "./lib/teamDirectory";

type Row = Doc<"notifications">;

/**
 * For a row that is not the caller's and for one that is not there, in the
 * same words: an id says nothing about whether somebody else has such a row.
 */
export const NOTIFICATION_GONE = "That notification is no longer there.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows one sweep deletes before it schedules its own next run. */
const PRUNE_BATCH = 500;

/** Whether a caller is sent a row: its task was shared, or of a company they are on now. */
const visible = (member: Member, row: Row) =>
  row.company === undefined || member.companies.includes(row.company);

/**
 * A person's name for one caller: only someone they share a company with
 * (`knows`), and only while that person is on the team. Otherwise null, and
 * the page says "A teammate".
 */
function nameReader(ctx: QueryCtx, member: Member) {
  let directory: Promise<Map<string, Person>> | null = null;
  return async (id: Row["recipient"] | undefined): Promise<string | null> => {
    if (id === undefined) return null;
    const user = await ctx.db.get(id);
    const email = user?.email?.trim().toLowerCase();
    if (user == null || email === undefined) return null;
    directory ??= teamDirectory(ctx.db);
    const person = (await directory).get(email);
    if (person === undefined || !knows(member, person)) return null;
    return user.name ?? email.split("@")[0]!;
  };
}

/** The caller's notifications, newest first: the first `count` they may be sent. */
export const mine = memberQuery(ANY_AREA)({
  args: { count: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const count = clampLimit(args.count, NOTIFICATION_PAGE, MAX_NOTIFICATIONS);
    const rows: Row[] = [];
    let more = false;
    const all = ctx.db
      .query("notifications")
      .withIndex("by_recipient_and_createdAt", (q) => q.eq("recipient", ctx.member.user._id))
      .order("desc");
    // At most MAX_NOTIFICATIONS rows and a few: the writer keeps it so.
    for await (const row of all) {
      if (!visible(ctx.member, row)) continue;
      if (rows.length === count) {
        more = true;
        break;
      }
      rows.push(row);
    }
    const nameOf = nameReader(ctx, ctx.member);
    return {
      rows: await Promise.all(
        rows.map(async (row) => {
          const task = row.taskId === undefined ? null : await ctx.db.get(row.taskId);
          const open =
            task !== null &&
            (task.company === undefined || ctx.member.companies.includes(task.company));
          // A decision leads to /memory only while it is there, of one of the
          // caller's companies, and they have the memory page.
          const decision =
            row.decisionId === undefined || !may(ctx.member, "memory")
              ? null
              : await ctx.db.get(row.decisionId);
          const decisionOpen = decision !== null && ctx.member.companies.includes(decision.company);
          // A handoff leads to /handoffs while it is there and of one of the caller's companies.
          const handoff = row.handoffId === undefined ? null : await ctx.db.get(row.handoffId);
          const handoffOpen = handoff !== null && ctx.member.companies.includes(handoff.company);
          return {
            id: row._id,
            kind: row.kind,
            actor:
              row.actor.type === "user"
                ? { type: "user" as const, name: await nameOf(row.actor.userId) }
                : row.actor.type === "agent"
                  ? // Whose Claude it was, by name, to a caller who knows them.
                    { type: "agent" as const, name: await nameOf(row.actor.userId) }
                  : row.actor,
            /** The task's title when it happened. */
            title: row.title,
            company: row.company ?? null,
            /** The task to open, or null: it was deleted, or is no longer the caller's to see. */
            taskId: open ? row.taskId! : null,
            /** The decision to open on /memory, or null. */
            decisionId: decisionOpen ? row.decisionId! : null,
            /** "handoff": whether it leads to /handoffs (it is there and the caller's to see). */
            handoff: handoffOpen,
            /** "handoff": the start of its summary, as the bot wrote it. */
            summary: row.summary ?? null,
            column: row.column ?? null,
            /** For "reassigned": who has it now, if the caller may be told. */
            to: await nameOf(row.to),
            due: row.due ?? null,
            createdAt: row.createdAt,
            read: row.readAt !== undefined,
          };
        }),
      ),
      more,
    };
  },
});

/** How many the caller has not read, counted to UNREAD_COUNT_CAP and no further. */
export const unreadCount = memberQuery(ANY_AREA)({
  args: {},
  handler: async (ctx) => {
    let count = 0;
    const unread = ctx.db
      .query("notifications")
      .withIndex("by_recipient_and_readAt_and_createdAt", (q) =>
        q.eq("recipient", ctx.member.user._id).eq("readAt", undefined),
      );
    for await (const row of unread) {
      if (!visible(ctx.member, row)) continue;
      count += 1;
      if (count === UNREAD_COUNT_CAP) break;
    }
    return count;
  },
});

export const markRead = memberMutation(ANY_AREA)({
  args: { id: v.id("notifications") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null || row.recipient !== ctx.member.user._id) {
      throw new ConvexError(NOTIFICATION_GONE);
    }
    if (row.readAt === undefined) await ctx.db.patch(row._id, { readAt: Date.now() });
    return null;
  },
});

export const markAllRead = memberMutation(ANY_AREA)({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_and_readAt_and_createdAt", (q) =>
        q.eq("recipient", ctx.member.user._id).eq("readAt", undefined),
      )
      .take(MAX_NOTIFICATIONS + 50);
    for (const row of unread) await ctx.db.patch(row._id, { readAt: now });
    return null;
  },
});

/**
 * The daily sweep: delete rows older than NOTIFICATION_RETENTION_DAYS, read
 * or not, a batch at a time. A run that fills its batch schedules the next.
 * It takes no argument: a scheduled function's arguments are stored.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - NOTIFICATION_RETENTION_DAYS * DAY_MS;
    const old = await ctx.db
      .query("notifications")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.notifications.prune, {});
    return null;
  },
});
