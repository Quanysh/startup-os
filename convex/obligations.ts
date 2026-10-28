import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { categoryServesAny } from "./lib/company";
import { MAX_NOTES_LENGTH } from "./lib/limits";
import {
  OBLIGATION_CATEGORIES,
  type ObligationCategory,
  type ObligationRow,
} from "./lib/obligationShape";
import { NOT_ALLOWED, memberMutation, memberQuery, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { anchorDayOf, nextOccurrence, rollKeepsConfirmation } from "./lib/recurrence";
import { cleanLink, cleanText, cleanTitle } from "./lib/text";
import {
  obligationCategoryValidator,
  obligationStatusValidator,
  recurrenceValidator,
} from "./schema";

// Compliance and corporate obligations: what has to be done, by when, and
// where the proof is. This file records dates and evidence. Nothing here, or
// in anything built on it, states that the company is compliant.

const CATEGORY_ORDER = new Map<string, number>(
  OBLIGATION_CATEGORIES.map((category, index) => [category.id, index]),
);

function present(o: Doc<"obligations">): ObligationRow {
  return {
    id: o._id,
    category: o.category,
    title: o.title,
    due: o.due ?? null,
    dueConfirmed: o.dueConfirmed,
    anchorDay: o.anchorDay ?? null,
    recurrence: o.recurrence,
    status: o.status,
    evidenceUrl: o.evidenceUrl ?? null,
    note: o.note ?? null,
    sourceUrl: o.sourceUrl ?? null,
    lastDoneAt: o.lastDoneAt ?? null,
    lastDoneFor: o.lastDoneFor ?? null,
    lastEvidenceUrl: o.lastEvidenceUrl ?? null,
    // A row from before `updatedAt` was kept has only its making to go by.
    changedAt: o.updatedAt ?? o._creationTime,
  };
}

function checkDay(value: string | null | undefined) {
  if (value != null && !isCanonicalPeriodStart("day", value)) {
    throw new ConvexError("The due date is not a date.");
  }
}

const cleanNote = (note: string) => cleanText(note, MAX_NOTES_LENGTH, "That note") || undefined;
const cleanEvidence = (url: string) => cleanLink(url, "An evidence link");
const NO_DATE_TO_CONFIRM = "A date can be confirmed only once there is one.";

/**
 * Refuse a category none of the caller's companies has (HIPAA for someone on
 * Globex alone), in the words of a missing permission. Asked of the row
 * as it is stored and of any category a write would give it.
 */
function requireCategory(member: Member, category: ObligationCategory) {
  if (!categoryServesAny(member.companies, category)) throw new ConvexError(NOT_ALLOWED);
}

/**
 * Every obligation: by category in the page's order, then by date (undated
 * last), then by title. What is due or overdue is not decided here: that
 * depends on today's date, which a query must not read
 * (src/lib/compliance/due.ts).
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function obligationsFor(ctx: QueryCtx, member: Member) {
  {
    const rows = (await ctx.db.query("obligations").collect())
      .filter((o) => categoryServesAny(member.companies, o.category))
      .map(present);
    return rows.sort((a, b) => {
      const byCategory = CATEGORY_ORDER.get(a.category)! - CATEGORY_ORDER.get(b.category)!;
      if (byCategory !== 0) return byCategory;
      if (a.due !== b.due) {
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      }
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });
  }
}

export const list = memberQuery("compliance")({
  args: {},
  handler: (ctx) => obligationsFor(ctx, ctx.member),
});

export const create = memberMutation("compliance")({
  args: {
    category: obligationCategoryValidator,
    title: v.string(),
    due: v.optional(v.string()),
    dueConfirmed: v.optional(v.boolean()),
    recurrence: v.optional(recurrenceValidator),
    note: v.optional(v.string()),
    evidenceUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireCategory(ctx.member, args.category);
    checkDay(args.due);
    if (args.dueConfirmed && args.due === undefined) throw new ConvexError(NO_DATE_TO_CONFIRM);
    return await ctx.db.insert("obligations", {
      category: args.category,
      title: cleanTitle(args.title, "compliance item"),
      due: args.due,
      // A date is a deadline only once someone has checked it.
      dueConfirmed: args.due !== undefined && args.dueConfirmed === true,
      anchorDay: args.due === undefined ? undefined : anchorDayOf(args.due),
      recurrence: args.recurrence ?? "none",
      status: "open",
      note: args.note === undefined ? undefined : cleanNote(args.note),
      evidenceUrl: args.evidenceUrl === undefined ? undefined : cleanEvidence(args.evidenceUrl),
    });
  },
});

/**
 * Edit an obligation. For the date, the note and the link, null clears the
 * field and leaving it out keeps it. A changed date is unconfirmed unless the
 * same call confirms it: the confirmation was of the old date.
 */
export const update = memberMutation("compliance")({
  args: {
    id: v.id("obligations"),
    category: v.optional(obligationCategoryValidator),
    title: v.optional(v.string()),
    due: v.optional(v.union(v.string(), v.null())),
    dueConfirmed: v.optional(v.boolean()),
    recurrence: v.optional(recurrenceValidator),
    status: v.optional(obligationStatusValidator),
    note: v.optional(v.union(v.string(), v.null())),
    evidenceUrl: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (!current) throw new ConvexError("That item no longer exists.");
    requireCategory(ctx.member, current.category);
    if (args.category !== undefined) requireCategory(ctx.member, args.category);
    checkDay(args.due);
    if (args.status === "done") {
      throw new ConvexError('Use "Mark done" to finish an item: it also schedules the next one.');
    }

    const due = args.due === undefined ? current.due : (args.due ?? undefined);
    const dateChanged = due !== current.due;
    const dueConfirmed = args.dueConfirmed ?? (dateChanged ? false : current.dueConfirmed);
    // Asking to confirm nothing is an error; a cleared date just unconfirms.
    if (args.dueConfirmed === true && due === undefined) throw new ConvexError(NO_DATE_TO_CONFIRM);

    await ctx.db.patch(args.id, {
      ...(args.category !== undefined ? { category: args.category } : null),
      ...(args.title !== undefined ? { title: cleanTitle(args.title, "compliance item") } : null),
      due,
      dueConfirmed: due !== undefined && dueConfirmed,
      // The day the owner chose is what a repeating date returns to.
      anchorDay: dateChanged ? (due === undefined ? undefined : anchorDayOf(due)) : current.anchorDay,
      ...(args.recurrence !== undefined ? { recurrence: args.recurrence } : null),
      ...(args.status !== undefined ? { status: args.status } : null),
      ...(args.note !== undefined
        ? { note: args.note === null ? undefined : cleanNote(args.note) }
        : null),
      ...(args.evidenceUrl !== undefined
        ? { evidenceUrl: args.evidenceUrl === null ? undefined : cleanEvidence(args.evidenceUrl) }
        : null),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Finish an obligation. One that does not repeat becomes done. One that
 * repeats rolls to its next date and is open again: one period on from the
 * date that was due (from `today` when it had none), with this cycle's
 * evidence filed as the previous one, because the next cycle needs its own.
 * The new date stays confirmed only for a yearly or quarterly item whose date
 * was confirmed; a monthly one arrives unconfirmed.
 *
 * `expectedDue` is the date the caller was looking at. If the item has moved
 * on since (a second click on the same button), nothing happens.
 */
export const complete = memberMutation("compliance")({
  args: {
    id: v.id("obligations"),
    /** The owner's calendar date. A mutation's own clock is UTC. */
    today: v.string(),
    expectedDue: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const o = await ctx.db.get(args.id);
    if (!o) throw new ConvexError("That item no longer exists.");
    requireCategory(ctx.member, o.category);
    if (!isCanonicalPeriodStart("day", args.today)) {
      throw new ConvexError("Today's date did not arrive as a date.");
    }
    if (o.status === "not_applicable") {
      throw new ConvexError("That item is marked not applicable. Reopen it first.");
    }
    if ((o.due ?? null) !== args.expectedDue || o.status === "done") return null;

    const at = Date.now();
    const done = { lastDoneAt: at, lastDoneFor: o.due, updatedAt: at };
    if (o.recurrence === "none") {
      await ctx.db.patch(args.id, { ...done, status: "done" });
      return null;
    }
    const next = nextOccurrence(
      { due: o.due, recurrence: o.recurrence, anchorDay: o.anchorDay },
      args.today,
    );
    await ctx.db.patch(args.id, {
      ...done,
      status: "open",
      due: next.due,
      // The next date is confirmed only if this one was, and only for a
      // yearly or quarterly item (rollKeepsConfirmation says why). A date
      // worked out from no date at all is a suggestion, not a deadline.
      dueConfirmed: o.due !== undefined && o.dueConfirmed && rollKeepsConfirmation(o.recurrence),
      anchorDay: next.anchorDay,
      lastEvidenceUrl: o.evidenceUrl,
      evidenceUrl: undefined,
    });
    return null;
  },
});

/** Delete an obligation. Removing one that is already gone does nothing. */
export const remove = memberMutation("compliance")({
  args: { id: v.id("obligations") },
  handler: async (ctx, args) => {
    const o = await ctx.db.get(args.id);
    if (o === null) return null;
    requireCategory(ctx.member, o.category);
    await ctx.db.delete(args.id);
    return null;
  },
});
