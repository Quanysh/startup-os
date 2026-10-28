// Company memory, part one: what was decided (/memory, the `memory` area).
// Each row is one company's: a handler sends only the caller's companies'
// rows and refuses a write to another's, in the words of a missing
// permission. Text is typed by a person, or proposed by an agent and approved
// by the owner (convex/lib/proposals.ts): cleaned and bounded by
// convex/lib/memory.ts, stored as plain text, in no log or thrown error.
//
// A decision's owner is held to who a task of that company could be given to
// (`assignablePeople`, what `team.assignable` returns). The daily sweep
// (`markRevisits`) tells that owner once when the revisit date comes.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { AgentId } from "./lib/agents";
import type { CompanyId } from "./lib/company";
import { MAX_TITLE_LENGTH } from "./lib/limits";
import {
  MAX_DECISION_CONTEXT,
  MAX_DECISION_LINKS,
  MAX_DECISION_TEXT,
  MEMORY_LIST_ROWS,
  MEMORY_WORDS,
  cleanMemoryLine,
  cleanMemoryLines,
  cleanTags,
  isRevisitDue,
  type DecisionStatus,
} from "./lib/memory";
import { keepNewest, userOfAddress } from "./lib/notify";
import { memberMutation, memberQuery, requireCompany, NOT_ALLOWED, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { may } from "./lib/roles";
import { assignablePeople, knows, nameOf, teamDirectory } from "./lib/teamDirectory";
import { companyValidator, decisionStatusValidator } from "./schema";

type Row = Doc<"decisions">;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

function dayOf(value: string): string {
  return isCanonicalPeriodStart("day", value) ? value : refuse(MEMORY_WORDS.notADate);
}

/** What a decision holds, as typed: the same for a person's form and an approved proposal. */
export type DecisionInput = {
  company: CompanyId;
  title: string;
  decision: string;
  context?: string;
  owner?: string | null;
  decidedOn: string;
  status: DecisionStatus;
  revisitOn?: string | null;
  tags?: readonly string[];
  meetingId?: Id<"meetingNotes"> | null;
  taskIds?: readonly Id<"tasks">[];
  dealIds?: readonly Id<"deals">[];
  goalIds?: readonly Id<"goals">[];
};

/** Refuse an owner a task of this company could not be given to, without saying whose. */
export async function checkOwner(
  ctx: QueryCtx,
  member: Member,
  email: string | null | undefined,
  company: CompanyId,
): Promise<string | undefined> {
  if (email == null || email.trim() === "") return undefined;
  const wanted = email.trim().toLowerCase();
  const people = await assignablePeople(ctx, member, company);
  if (!people.some((person) => person.email === wanted)) refuse(MEMORY_WORDS.cannotOwn);
  return wanted;
}

/** The meeting a decision names: there, and of the same company. */
export async function checkMeeting(
  ctx: QueryCtx,
  id: Id<"meetingNotes"> | null | undefined,
  company: CompanyId,
): Promise<Id<"meetingNotes"> | undefined> {
  if (id == null) return undefined;
  const meeting = await ctx.db.get(id);
  if (meeting === null) return refuse(MEMORY_WORDS.meetingGone);
  if (meeting.company !== company) return refuse(MEMORY_WORDS.meetingElsewhere);
  return id;
}

/** Links to rows that exist and that the caller may see, or a refusal. */
async function checkLinks(ctx: QueryCtx, member: Member, input: DecisionInput) {
  const taskIds = [...new Set(input.taskIds ?? [])];
  const dealIds = [...new Set(input.dealIds ?? [])];
  const goalIds = [...new Set(input.goalIds ?? [])];
  if (taskIds.length + dealIds.length + goalIds.length > MAX_DECISION_LINKS) {
    refuse(MEMORY_WORDS.tooManyLinks);
  }
  for (const id of taskIds) {
    const task = await ctx.db.get(id);
    if (task === null || (task.company !== undefined && !member.companies.includes(task.company))) {
      refuse(MEMORY_WORDS.linkGone);
    }
  }
  for (const id of dealIds) {
    const deal = await ctx.db.get(id);
    if (deal === null || deal.archivedAt !== undefined || !member.companies.includes(deal.market)) {
      refuse(MEMORY_WORDS.linkGone);
    }
  }
  for (const id of goalIds) if ((await ctx.db.get(id)) === null) refuse(MEMORY_WORDS.linkGone);
  return { taskIds, dealIds, goalIds };
}

/** The fields of a row, cleaned and checked: what `create`, `update` and an approval write. */
async function fieldsOf(ctx: QueryCtx, member: Member, input: DecisionInput) {
  requireCompany(member, input.company);
  const title = cleanMemoryLine(input.title, MAX_TITLE_LENGTH, "That title");
  if (title === "") refuse("A decision needs a title.");
  const decision = cleanMemoryLines(input.decision, MAX_DECISION_TEXT, "That decision");
  if (decision === "") refuse(MEMORY_WORDS.needsDecision);
  const context = cleanMemoryLines(input.context ?? "", MAX_DECISION_CONTEXT, "That context");
  return {
    company: input.company,
    title,
    decision,
    context: context === "" ? undefined : context,
    owner: await checkOwner(ctx, member, input.owner, input.company),
    decidedOn: dayOf(input.decidedOn),
    status: input.status,
    revisitOn: input.revisitOn == null || input.revisitOn === "" ? undefined : dayOf(input.revisitOn),
    tags: cleanTags(input.tags ?? []),
    meetingId: await checkMeeting(ctx, input.meetingId, input.company),
    ...(await checkLinks(ctx, member, input)),
  };
}

/**
 * Record a decision. What `decisions.create` runs and what approving an
 * agent's `decision_record` runs (with `origin`), so both are held to the same.
 */
export async function createDecision(
  ctx: MutationCtx,
  member: Member,
  input: DecisionInput,
  origin?: { agent: AgentId },
): Promise<Id<"decisions">> {
  const now = Date.now();
  return await ctx.db.insert("decisions", {
    ...(await fieldsOf(ctx, member, input)),
    createdBy: member.user._id,
    ...(origin === undefined ? null : { origin: { source: "agent" as const, agent: origin.agent } }),
    createdAt: now,
    updatedAt: now,
  });
}

/** A row the caller may change: there, and of one of their companies. */
async function ownRow(ctx: QueryCtx, member: Member, id: Id<"decisions">): Promise<Row> {
  const row = await ctx.db.get(id);
  if (row === null) return refuse(MEMORY_WORDS.decisionGone);
  if (!member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
  return row;
}

/** Reads the names a caller may be told: only of people they share a company with. */
function personReader(ctx: QueryCtx, member: Member) {
  const directory = teamDirectory(ctx.db);
  return async (email: string | undefined) => {
    if (email === undefined) return null;
    const person = (await directory).get(email);
    if (person === undefined || !knows(member, person)) return { email: null, name: null };
    return { email, name: await nameOf(ctx.db, email) };
  };
}

/** What a decision links to, each only where the caller may see it. */
async function linksOf(ctx: QueryCtx, member: Member, row: Row) {
  const links: { kind: "task" | "deal" | "goal"; id: string; title: string }[] = [];
  if (may(member, "board")) {
    for (const id of row.taskIds) {
      const task = await ctx.db.get(id);
      if (task !== null && (task.company === undefined || member.companies.includes(task.company))) {
        links.push({ kind: "task", id, title: task.title });
      }
    }
  }
  if (may(member, "sales")) {
    for (const id of row.dealIds) {
      const deal = await ctx.db.get(id);
      if (deal !== null && deal.archivedAt === undefined && member.companies.includes(deal.market)) {
        links.push({ kind: "deal", id, title: deal.name });
      }
    }
  }
  if (may(member, ["scorecard", "board", "review"])) {
    for (const id of row.goalIds) {
      const goal = await ctx.db.get(id);
      if (goal !== null) links.push({ kind: "goal", id, title: goal.title });
    }
  }
  return links;
}

/** The companies a read covers: one the caller names (theirs), or all of theirs. */
function companiesFor(member: Member, company: CompanyId | undefined): readonly CompanyId[] {
  if (company === undefined) return member.companies;
  requireCompany(member, company);
  return [company];
}

/** The latest decisions of these companies, newest decision day first. */
async function rowsOf(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const rows: Row[] = [];
  for (const company of companies) {
    rows.push(
      ...(await ctx.db
        .query("decisions")
        .withIndex("by_company_and_decidedOn", (q) => q.eq("company", company))
        .order("desc")
        .take(MEMORY_LIST_ROWS)),
    );
  }
  return rows.sort((a, b) => (a.decidedOn < b.decidedOn ? 1 : a.decidedOn > b.decidedOn ? -1 : b.createdAt - a.createdAt));
}

/**
 * Decisions as an agent's read tool sends them (convex/lib/mcpTools.ts): the
 * fields, the owner's address, and no text beyond what the tool cuts.
 */
export async function decisionsFor(ctx: QueryCtx, member: Member, companies: readonly CompanyId[]) {
  return (await rowsOf(ctx, companies.filter((c) => member.companies.includes(c)))).map((row) => ({
    id: row._id,
    company: row.company,
    title: row.title,
    decision: row.decision,
    context: row.context ?? null,
    owner: row.owner ?? null,
    decidedOn: row.decidedOn,
    status: row.status,
    revisitOn: row.revisitOn ?? null,
    tags: row.tags,
    meetingId: row.meetingId ?? null,
  }));
}

export const list = memberQuery("memory")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    const person = personReader(ctx, ctx.member);
    const rows = await rowsOf(ctx, companiesFor(ctx.member, args.company));
    return await Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        company: row.company,
        title: row.title,
        decision: row.decision,
        context: row.context ?? null,
        owner: await person(row.owner),
        decidedOn: row.decidedOn,
        status: row.status,
        revisitOn: row.revisitOn ?? null,
        tags: row.tags,
        meetingId: row.meetingId ?? null,
        taskIds: row.taskIds,
        dealIds: row.dealIds,
        goalIds: row.goalIds,
        links: await linksOf(ctx, ctx.member, row),
        byAgent: row.origin?.agent ?? null,
        updatedAt: row.updatedAt,
      })),
    );
  },
});

const fields = {
  company: companyValidator,
  title: v.string(),
  decision: v.string(),
  context: v.optional(v.string()),
  owner: v.optional(v.union(v.string(), v.null())),
  decidedOn: v.string(),
  status: decisionStatusValidator,
  revisitOn: v.optional(v.union(v.string(), v.null())),
  tags: v.optional(v.array(v.string())),
  meetingId: v.optional(v.union(v.id("meetingNotes"), v.null())),
  taskIds: v.optional(v.array(v.id("tasks"))),
  dealIds: v.optional(v.array(v.id("deals"))),
  goalIds: v.optional(v.array(v.id("goals"))),
};

export const create = memberMutation("memory")({
  args: fields,
  handler: (ctx, args) => createDecision(ctx, ctx.member, args),
});

/** Save the whole decision again. A new revisit date is told again when it comes. */
export const update = memberMutation("memory")({
  args: { id: v.id("decisions"), ...fields },
  handler: async (ctx, { id, ...input }) => {
    const row = await ownRow(ctx, ctx.member, id);
    const next = await fieldsOf(ctx, ctx.member, input);
    await ctx.db.replace(id, {
      ...next,
      createdBy: row.createdBy,
      ...(row.origin === undefined ? null : { origin: row.origin }),
      ...(row.revisitNotifiedAt !== undefined && row.revisitOn === next.revisitOn
        ? { revisitNotifiedAt: row.revisitNotifiedAt }
        : null),
      createdAt: row.createdAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Delete a decision. One already gone is no error, so a double-click is safe. */
export const remove = memberMutation("memory")({
  args: { id: v.id("decisions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    if (!ctx.member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
    await ctx.db.delete(args.id);
    return null;
  },
});

/**
 * The caller's own decisions due for a revisit on `today` (the browser's
 * day: a query reads no clock), oldest date first. For Today's "Waiting on you".
 */
export const mineToRevisit = memberQuery("memory")({
  args: { today: v.string() },
  handler: async (ctx, args) => {
    const today = dayOf(args.today);
    const email = ctx.member.user.email?.trim().toLowerCase();
    if (email === undefined) return [];
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_owner_and_revisitOn", (q) => q.eq("owner", email).gt("revisitOn", "").lte("revisitOn", today))
      .take(50);
    return rows
      .filter((row) => ctx.member.companies.includes(row.company) && isRevisitDue(row, today))
      .map((row) => ({ id: row._id, company: row.company, title: row.title, revisitOn: row.revisitOn! }));
  },
});

/** Who may own a decision of a company (one of the caller's): a name and an address. */
export const people = memberQuery("memory")({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    return assignablePeople(ctx, ctx.member, args.company);
  },
});

/** Rows a decision may link to, each list only for a caller with its page. */
export const linkable = memberQuery("memory")({
  args: { company: companyValidator, quarter: v.string() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const tasks = may(ctx.member, "board")
      ? (
          await ctx.db
            .query("tasks")
            .withIndex("by_column_and_order")
            .take(1_000)
        )
          .filter(
            (task) =>
              task.archivedAt === undefined &&
              task.column !== "done" &&
              (task.company === undefined || task.company === args.company),
          )
          .slice(0, 200)
          .map((task) => ({ id: task._id, title: task.title }))
      : [];
    const deals = may(ctx.member, "sales")
      ? (
          await ctx.db
            .query("deals")
            .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", args.company))
            .take(300)
        )
          .filter((deal) => deal.archivedAt === undefined)
          .map((deal) => ({ id: deal._id, title: deal.name }))
      : [];
    const goals = may(ctx.member, ["scorecard", "board", "review"])
      ? (
          await ctx.db
            .query("goals")
            .withIndex("by_quarter_and_order", (q) => q.eq("quarter", args.quarter))
            .take(50)
        ).map((goal) => ({ id: goal._id, title: goal.title }))
      : [];
    return { tasks, deals, goals };
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 100;

/**
 * The daily sweep: each decision whose revisit date has come and that was not
 * yet marked is marked (its status stays as it is), and its owner told once,
 * unless it was reversed. A batch at a time; a full batch schedules the next.
 */
export const markRevisits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const today = new Date(now - (now % DAY_MS)).toISOString().slice(0, 10);
    const due = await ctx.db
      .query("decisions")
      .withIndex("by_revisitNotifiedAt_and_revisitOn", (q) =>
        q.eq("revisitNotifiedAt", undefined).gt("revisitOn", "").lte("revisitOn", today),
      )
      .take(SWEEP_BATCH);
    for (const row of due) {
      await ctx.db.patch(row._id, { revisitNotifiedAt: now });
      if (!isRevisitDue(row, today)) continue;
      const recipient = await userOfAddress(ctx.db, row.owner);
      if (recipient === null) continue;
      await ctx.db.insert("notifications", {
        recipient,
        kind: "decision_revisit",
        actor: { type: "system", source: "memory" },
        decisionId: row._id,
        company: row.company,
        title: row.title.slice(0, MAX_TITLE_LENGTH),
        createdAt: now,
      });
      await keepNewest(ctx, recipient);
    }
    if (due.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.decisions.markRevisits, {});
    return null;
  },
});
