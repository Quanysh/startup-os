// Company memory, part two: notes of meetings (/memory, the `memory` area).
// Each row is one company's, sent only to people on it. Teammates who were
// there are held to who a task of that company could be given to; people
// from outside are plain names, and an email address there is refused. The
// notes are typed (or copied from the owner's own Fireflies summary, which he
// edits first): never a transcript. An action item becomes a card on the
// board through `createTask`, with the board's own notifications.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { MAX_TITLE_LENGTH } from "./lib/limits";
import {
  MAX_ACTION_ITEMS,
  MAX_ATTENDEES,
  MAX_MEETING_NOTES,
  MEMORY_LIST_ROWS,
  MEMORY_WORDS,
  cleanMemoryLine,
  cleanMemoryLines,
  cleanOutsideNames,
} from "./lib/memory";
import { NOT_ALLOWED, memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { may } from "./lib/roles";
import { assignablePeople, knows, nameOf, teamDirectory } from "./lib/teamDirectory";
import { companyValidator, meetingKindValidator } from "./schema";
import { PERSON_DUPLICATE_REASONS, createTask, duplicatesArg, personDuplicates } from "./tasks";

type Row = Doc<"meetingNotes">;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

export type MeetingInput = {
  company: CompanyId;
  kind: Row["kind"];
  heldOn: string;
  title: string;
  notes: string;
  attendees: readonly string[];
  outsideAttendees: readonly string[];
  actionItems: readonly string[];
};

/** The fields of a row, cleaned and checked. `before` keeps the cards of items still there. */
async function fieldsOf(ctx: QueryCtx, member: Member, input: MeetingInput, before?: Row) {
  requireCompany(member, input.company);
  if (!isCanonicalPeriodStart("day", input.heldOn)) refuse(MEMORY_WORDS.notADate);
  const title = cleanMemoryLine(input.title, MAX_TITLE_LENGTH, "That title");
  if (title === "") refuse("A meeting needs a title.");
  const people = await assignablePeople(ctx, member, input.company);
  const attendees: string[] = [];
  for (const raw of input.attendees) {
    const email = raw.trim().toLowerCase();
    if (!people.some((person) => person.email === email)) refuse(MEMORY_WORDS.cannotAttend);
    if (!attendees.includes(email)) attendees.push(email);
  }
  if (attendees.length > MAX_ATTENDEES) refuse(MEMORY_WORDS.tooManyAttendees);
  const items: Row["actionItems"] = [];
  for (const raw of input.actionItems) {
    const text = cleanMemoryLine(raw, MAX_TITLE_LENGTH, "An action item");
    if (text === "") continue;
    const kept = before?.actionItems.find((item) => item.text === text && item.taskId !== undefined);
    items.push(kept?.taskId === undefined ? { text } : { text, taskId: kept.taskId });
  }
  if (items.length > MAX_ACTION_ITEMS) refuse(MEMORY_WORDS.tooManyItems);
  return {
    company: input.company,
    kind: input.kind,
    heldOn: input.heldOn,
    title,
    notes: cleanMemoryLines(input.notes, MAX_MEETING_NOTES, "Those notes"),
    attendees,
    outsideAttendees: cleanOutsideNames(input.outsideAttendees),
    actionItems: items,
  };
}

/** A row the caller may read or change: there, and of one of their companies. */
async function ownRow(ctx: QueryCtx, member: Member, id: Id<"meetingNotes">): Promise<Row> {
  const row = await ctx.db.get(id);
  if (row === null) return refuse(MEMORY_WORDS.meetingGone);
  if (!member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
  return row;
}

async function rowsOf(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const rows: Row[] = [];
  for (const company of companies) {
    rows.push(
      ...(await ctx.db
        .query("meetingNotes")
        .withIndex("by_company_and_heldOn", (q) => q.eq("company", company))
        .order("desc")
        .take(MEMORY_LIST_ROWS)),
    );
  }
  return rows.sort((a, b) => (a.heldOn < b.heldOn ? 1 : a.heldOn > b.heldOn ? -1 : b.createdAt - a.createdAt));
}

/**
 * Meetings as an agent's read tool sends them (convex/lib/mcpTools.ts): no
 * attendee of any kind, the notes whole for the tool to cut.
 */
export async function meetingsFor(ctx: QueryCtx, member: Member, companies: readonly CompanyId[]) {
  const rows = await rowsOf(ctx, companies.filter((c) => member.companies.includes(c)));
  return await Promise.all(
    rows.map(async (row) => ({
      id: row._id,
      company: row.company,
      kind: row.kind,
      heldOn: row.heldOn,
      title: row.title,
      notes: row.notes,
      actionItems: row.actionItems.map((item) => ({ text: item.text, onBoard: item.taskId !== undefined })),
      /** The titles of the decisions recorded as made in it. */
      decisions: (
        await ctx.db
          .query("decisions")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", row._id))
          .take(20)
      ).map((decision) => decision.title),
    })),
  );
}

/** The meetings of the caller's companies, newest first, without their notes. */
export const list = memberQuery("memory")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    if (args.company !== undefined) requireCompany(ctx.member, args.company);
    const rows = await rowsOf(ctx, args.company === undefined ? ctx.member.companies : [args.company]);
    // Which of the owner's Fireflies meetings a row was made from: the owner's alone.
    const owner = may(ctx.member, "personal");
    return rows.map((row) => ({
      ...(owner && row.firefliesId !== undefined ? { firefliesId: row.firefliesId } : null),
      id: row._id,
      company: row.company,
      kind: row.kind,
      heldOn: row.heldOn,
      title: row.title,
      attendeeCount: row.attendees.length + row.outsideAttendees.length,
      actionItems: row.actionItems.length,
      onBoard: row.actionItems.filter((item) => item.taskId !== undefined).length,
      // When the notes last changed: the page header's "last change".
      updatedAt: row.updatedAt,
    }));
  },
});

/** One meeting whole, with the decisions made in it. A teammate's name only for a caller who knows them. */
export const get = memberQuery("memory")({
  args: { id: v.id("meetingNotes") },
  handler: async (ctx, args) => {
    const row = await ownRow(ctx, ctx.member, args.id);
    const directory = await teamDirectory(ctx.db);
    const attendees = [];
    for (const email of row.attendees) {
      const person = directory.get(email);
      attendees.push(
        person !== undefined && knows(ctx.member, person)
          ? { email, name: await nameOf(ctx.db, email) }
          : { email: null, name: null },
      );
    }
    const decisions = await ctx.db
      .query("decisions")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", row._id))
      .take(50);
    return {
      id: row._id,
      company: row.company,
      kind: row.kind,
      heldOn: row.heldOn,
      title: row.title,
      notes: row.notes,
      attendees,
      outsideAttendees: row.outsideAttendees,
      actionItems: row.actionItems.map((item) => ({ text: item.text, taskId: item.taskId ?? null })),
      decisions: decisions.map((d) => ({ id: d._id, title: d.title, status: d.status })),
    };
  },
});

const fields = {
  company: companyValidator,
  kind: meetingKindValidator,
  heldOn: v.string(),
  title: v.string(),
  notes: v.string(),
  attendees: v.array(v.string()),
  outsideAttendees: v.array(v.string()),
  actionItems: v.array(v.string()),
};

/** The shape of a Fireflies meeting id: kept only as an id, never as text. */
const FIREFLIES_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Add a meeting's notes. What `meetingNotes.create` runs and what the MCP
 * `note_create` tool runs, so both are held to the same fields and limits.
 */
export async function createMeeting(
  ctx: MutationCtx,
  member: Member,
  input: MeetingInput,
  firefliesId?: string,
): Promise<Id<"meetingNotes">> {
  if (firefliesId !== undefined) {
    // The import is the owner's own Fireflies: nobody else links to it.
    if (!may(member, "personal")) throw new ConvexError(NOT_ALLOWED);
    if (!FIREFLIES_ID.test(firefliesId)) refuse(MEMORY_WORDS.importGone);
  }
  const now = Date.now();
  return await ctx.db.insert("meetingNotes", {
    ...(await fieldsOf(ctx, member, input)),
    ...(firefliesId === undefined ? null : { firefliesId }),
    createdBy: member.user._id,
    createdAt: now,
    updatedAt: now,
  });
}

export const create = memberMutation("memory")({
  args: { ...fields, firefliesId: v.optional(v.string()) },
  handler: (ctx, { firefliesId, ...args }) => createMeeting(ctx, ctx.member, args, firefliesId),
});

export const update = memberMutation("memory")({
  args: { id: v.id("meetingNotes"), ...fields },
  handler: async (ctx, { id, ...input }) => {
    const row = await ownRow(ctx, ctx.member, id);
    await ctx.db.patch(id, { ...(await fieldsOf(ctx, ctx.member, input, row)), updatedAt: Date.now() });
    return null;
  },
});

/** Delete a meeting's notes. Decisions made in it stay, without the link. */
export const remove = memberMutation("memory")({
  args: { id: v.id("meetingNotes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    if (!ctx.member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
    const linked = await ctx.db
      .query("decisions")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.id))
      .take(100);
    for (const decision of linked) await ctx.db.patch(decision._id, { meetingId: undefined });
    await ctx.db.delete(args.id);
    return null;
  },
});

/**
 * Put one action item on the board, as a card of the meeting's company,
 * through `createTask` (the board's own checks, notifications and Telegram
 * announcement). Needs the board too. An item goes once.
 */
export const addActionToBoard = memberMutation("memory")({
  args: {
    id: v.id("meetingNotes"),
    index: v.number(),
    assignee: v.optional(v.string()),
    // As the board's add form: "warn" stops at a near open card, to confirm past.
    duplicates: duplicatesArg,
  },
  handler: async (ctx, args) => {
    const row = await ownRow(ctx, ctx.member, args.id);
    if (!may(ctx.member, "board")) throw new ConvexError(NOT_ALLOWED);
    const item = Number.isInteger(args.index) ? row.actionItems[args.index] : undefined;
    if (item === undefined) return refuse(MEMORY_WORDS.itemGone);
    if (item.taskId !== undefined) return refuse(MEMORY_WORDS.itemOnBoard);
    const mark = await personDuplicates(
      ctx,
      ctx.member,
      { title: item.text, company: row.company, duplicates: args.duplicates },
      PERSON_DUPLICATE_REASONS.memory,
    );
    const taskId = await createTask(
      ctx,
      ctx.member,
      {
        title: item.text,
        company: row.company,
        ...(args.assignee === undefined || args.assignee === "" ? null : { assignee: args.assignee }),
      },
      mark === null ? undefined : { duplicate: mark },
    );
    await ctx.db.patch(row._id, {
      actionItems: row.actionItems.map((one, at) => (at === args.index ? { ...one, taskId } : one)),
      updatedAt: Date.now(),
    });
    return taskId;
  },
});
