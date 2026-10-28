import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ownersBot, scheduleBotEvent } from "./botEvents";
import { assigneeProfileId, botCoversCompany, mayReceiveEvents, taskAssigneeBot } from "./lib/botEvents";
import { botNamed } from "./lib/botStore";
import type { CompanyId } from "./lib/company";
import { findDuplicates, type DuplicateMark } from "./lib/duplicates";
import { DONE_LIMIT, MAX_MENTIONS, MAX_NOTES_LENGTH } from "./lib/limits";
import { notifyTaskChange, userOfAddress, type NotificationActor } from "./lib/notify";
import {
  NOT_ALLOWED,
  isOwner,
  memberMutation,
  memberQuery,
  requireCompany,
  type Member,
} from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { may } from "./lib/roles";
import { knows, mayTakeWork, nameOf, teamDirectory, type Person } from "./lib/teamDirectory";
import { cleanText, cleanTitle } from "./lib/text";
import { companyValidator, taskColumnValidator, taskKindValidator } from "./schema";
import { announceAssignment } from "./telegram";

type Column = Doc<"tasks">["column"];

const OPEN_COLUMNS = ["backlog", "this_week", "doing"] as const;
// Open issues read most-active first: what is being worked on, then what is
// planned for the week, then the backlog.
const ISSUE_COLUMNS = ["doing", "this_week", "backlog"] as const;

// One sentence for an address that is nobody's and for a person who is not on
// the task's company, so it cannot be used to find out who is on the team.
// The address is never quoted back.
export const CANNOT_ASSIGN = "That person cannot be given this task.";
export const ASSIGNEE_NOT_ON_COMPANY =
  "The person this task is assigned to is not on that company. Unassign it first.";
// One sentence again, for the same reason: an address that is nobody's, a
// person the caller shares no company with, one not on the task's company.
export const CANNOT_MENTION = "That person cannot be mentioned on this task.";
export const TOO_MANY_MENTIONS = `At most ${MAX_MENTIONS} people can be mentioned in one save.`;
/** People remembered as told on one card. A team is smaller; a bound, not a target. */
const MAX_MENTIONED = 100;

function checkDue(due: string | null | undefined) {
  if (due != null && !isCanonicalPeriodStart("day", due)) {
    throw new ConvexError(`"${due}" is not a date.`);
  }
}

async function checkGoal(ctx: QueryCtx, goalId: Id<"goals"> | null | undefined) {
  if (goalId != null && (await ctx.db.get(goalId)) === null) {
    throw new ConvexError("That goal no longer exists.");
  }
}

const cleanNotes = (notes: string) => cleanText(notes, MAX_NOTES_LENGTH, "That note") || undefined;

/**
 * Whether a caller is sent a task: it is shared (no company), or of one of
 * their companies. Every read filters with this and every write asks it.
 */
function canSee(member: Member, task: Doc<"tasks">): boolean {
  return task.company === undefined || member.companies.includes(task.company);
}

/** Refuse a task of a company the caller is not on, as a missing permission is. */
function requireVisible(member: Member, task: Doc<"tasks">) {
  if (!canSee(member, task)) throw new ConvexError(NOT_ALLOWED);
}

/**
 * The person behind an address, if a task of this company may be given to
 * them by this caller, or they may be mentioned on it: someone who may take
 * work (`mayTakeWork`: on the task's company, with the board, the one rule a
 * handoff to a person keeps too) and whom the caller may be told of
 * (`knows`). `member` null is the system (the standup import), which knows
 * everyone. Otherwise null, whatever the reason.
 */
export async function reachable(
  ctx: QueryCtx,
  member: Member | null,
  email: string,
  company: CompanyId | undefined,
): Promise<Person | null> {
  const person = (await teamDirectory(ctx.db)).get(email.trim().toLowerCase());
  if (
    person === undefined ||
    (member !== null && !knows(member, person)) ||
    !mayTakeWork(person, company)
  ) {
    return null;
  }
  return person;
}

/** What a card shows for a bot assignee to anyone but the owner. */
export const SOME_BOT = "a bot";

/**
 * Whether this caller may give a task to a bot: the owner by hand on the
 * board, or an approved proposal (carried out as the owner). Never a bot,
 * never a teammate, never a way in that did not ask for it (`mayGiveBot`).
 */
export function mayGiveToBot(member: Member | null, mayGiveBot: boolean | undefined): member is Member {
  return mayGiveBot === true && member !== null && isOwner(member);
}

/**
 * The stored spelling of the bot a task of this company may be given to
 * (`taskAssigneeBot`): one of the owner's profiles, found by the owner's user
 * and its id, switched on, reading or writing the board and working for that
 * company. Null for an address (a person), and for any bot that may not hold
 * it; the caller refuses in the same words either way, so a refusal never
 * says whether a bot of that id exists.
 */
export async function botAssignee(
  ctx: QueryCtx,
  owner: Member,
  raw: string,
  company: CompanyId | undefined,
): Promise<string | null> {
  const stored = taskAssigneeBot(raw);
  const profile = assigneeProfileId(stored);
  if (stored === null || profile === null) return null;
  const row = await botNamed(ctx, owner.user._id, profile);
  return mayReceiveEvents(row, company) ? stored : null;
}

/** The address or bot a task may be assigned to (`reachable`, or `botAssignee` for the owner). */
async function checkAssignee(
  ctx: QueryCtx,
  member: Member | null,
  email: string,
  company: CompanyId | undefined,
  mayGiveBot: boolean | undefined,
): Promise<string> {
  if (taskAssigneeBot(email) !== null) {
    const bot = mayGiveToBot(member, mayGiveBot) ? await botAssignee(ctx, member, email, company) : null;
    if (bot === null) throw new ConvexError(CANNOT_ASSIGN);
    return bot;
  }
  const person = await reachable(ctx, member, email, company);
  if (person === null) throw new ConvexError(CANNOT_ASSIGN);
  return person.email;
}

/**
 * The people a save mentions, as `users` rows. Who was mentioned is this
 * list and never the text: a name typed after an `@` is only text. Each
 * address must be one the task could be given to (`reachable`), or the whole
 * save is refused, in one sentence that does not repeat the address. Someone
 * who has never signed in has no row and nowhere to be told, and is left out.
 */
async function checkMentions(
  ctx: QueryCtx,
  member: Member,
  emails: readonly string[],
  company: CompanyId | undefined,
): Promise<Id<"users">[]> {
  if (emails.length > MAX_MENTIONS) throw new ConvexError(TOO_MANY_MENTIONS);
  const people = new Set<Id<"users">>();
  for (const email of emails) {
    const person = await reachable(ctx, member, email, company);
    if (person === null) throw new ConvexError(CANNOT_MENTION);
    const user = await userOfAddress(ctx.db, person.email);
    if (user !== null) people.add(user);
  }
  return [...people];
}

async function inColumn(ctx: QueryCtx, column: Column) {
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_column_and_order", (q) => q.eq("column", column))
    .collect();
  return rows.filter((task) => task.archivedAt === undefined);
}

/** Write `order` 0, 1, 2, … down the given sequence, touching only rows that change. */
async function renumber(ctx: MutationCtx, tasks: readonly Doc<"tasks">[]) {
  for (const [index, task] of tasks.entries()) {
    if (task.order !== index) await ctx.db.patch(task._id, { order: index });
  }
}

/**
 * Put a task at a position in a column, closing the gap it leaves behind.
 *
 * `index` counts the cards the caller can see, which is what their board
 * shows: the card lands just above the one they see at that place (after the
 * last one they see, past the end). Cards of a company they are not on keep
 * their order among the rest.
 *
 * "Done" is ordered by when a task was finished, not by hand: moving a card
 * into it stamps the time, and moving one within it changes nothing.
 */
async function place(
  ctx: MutationCtx,
  member: Member,
  task: Doc<"tasks">,
  to: Column,
  index: number,
) {
  const from = task.column;
  if (from !== to) {
    await ctx.db.patch(task._id, {
      column: to,
      doneAt: to === "done" ? Date.now() : undefined,
    });
    if (from !== "done") await renumber(ctx, await inColumn(ctx, from));
  }
  if (to !== "done") {
    const column = await inColumn(ctx, to);
    const others = column.filter((t) => t._id !== task._id);
    const seen = others.filter((t) => canSee(member, t));
    const at = Math.min(Math.max(index, 0), seen.length);
    const position =
      at < seen.length
        ? others.indexOf(seen[at]!)
        : seen.length > 0
          ? others.indexOf(seen.at(-1)!) + 1
          : others.length;
    const moved = column.find((t) => t._id === task._id)!;
    await renumber(ctx, [...others.slice(0, position), moved, ...others.slice(position)]);
  }
}

/**
 * How an assignee is sent to one caller. A teammate the caller shares a
 * company with is named. One on the other company alone is "elsewhere", and
 * one since removed is "removed", each without a name; only the owner is
 * still given a removed teammate's address.
 */
type Assignee =
  | { status: "teammate"; email: string; name: string | null }
  | { status: "removed" | "elsewhere"; email: string | null; name: null };

/** Looks people up once for a whole board. */
function assigneeReader(ctx: QueryCtx, member: Member) {
  let directory: Promise<Map<string, Person>> | null = null;
  const names = new Map<string, Promise<string | null>>();
  const bots = new Map<string, Promise<string>>();
  return async (email: string | undefined): Promise<Assignee | null> => {
    if (email === undefined) return null;
    const botId = taskAssigneeBot(email);
    const profile = assigneeProfileId(botId);
    if (botId !== null && profile !== null) {
      // A bot's name is the owner's to see; anyone else is told only that a bot holds it.
      if (!isOwner(member)) return { status: "teammate", email: botId, name: SOME_BOT };
      if (!bots.has(profile)) {
        bots.set(
          profile,
          botNamed(ctx, member.user._id, profile).then((row) => row?.name ?? SOME_BOT),
        );
      }
      return { status: "teammate", email: botId, name: await bots.get(profile)! };
    }
    directory ??= teamDirectory(ctx.db);
    const person = (await directory).get(email);
    if (person === undefined) {
      return { status: "removed", email: may(member, "admin") ? email : null, name: null };
    }
    if (!knows(member, person)) return { status: "elsewhere", email: null, name: null };
    if (!names.has(email)) names.set(email, nameOf(ctx.db, email));
    return { status: "teammate", email, name: await names.get(email)! };
  };
}

type AssigneeReader = ReturnType<typeof assigneeReader>;

/**
 * The people mentioned on a card, as the text names them (`@` and then
 * this), for a caller who may be told who they are; anyone else is left out.
 */
async function mentionsOf(ctx: QueryCtx, task: Doc<"tasks">, personOf: AssigneeReader) {
  const labels: string[] = [];
  for (const id of task.mentioned ?? []) {
    const email = (await ctx.db.get(id))?.email?.trim().toLowerCase();
    const person = await personOf(email);
    if (person?.status === "teammate") labels.push(person.name ?? person.email.split("@")[0]!);
  }
  return labels;
}

/** The name of whoever made a card, as the caller may be told it: as an assignee's is. */
async function addedBy(ctx: QueryCtx, task: Doc<"tasks">, personOf: AssigneeReader) {
  const maker = task.createdBy ? await ctx.db.get(task.createdBy) : null;
  return (await personOf(maker?.email?.trim().toLowerCase()))?.name ?? null;
}

/** The first word of a name, for "Claude (for Ada)"; null where there is no name. */
const firstNameOf = (name: string | null) => name?.trim().split(/\s+/)[0] || null;

/**
 * Where a card came from, as a caller is sent it. The standup's is the stored
 * value. A suggestion's says who sent it by name only, never an address, and
 * only to a caller who shares a company with them (`knows`): anyone else, and
 * for someone since removed or with no name on record, it is null.
 */
function originReader(ctx: QueryCtx, member: Member) {
  let directory: Promise<Map<string, Person>> | null = null;
  return async (task: Doc<"tasks">) => {
    const origin = task.origin;
    if (origin === undefined) return null;
    if (origin.source === "standup") return origin;
    // A Telegram card's origin, and an agent's, are written by `present`,
    // which knows who asked.
    if (origin.source === "telegram" || origin.source === "agent") return null;
    const user = task.createdBy === undefined ? null : await ctx.db.get(task.createdBy);
    const email = user?.email?.trim().toLowerCase();
    directory ??= teamDirectory(ctx.db);
    const person = email === undefined ? undefined : (await directory).get(email);
    const known = person !== undefined && knows(member, person);
    return { source: origin.source, suggestedBy: known ? (user?.name ?? null) : null };
  };
}

type OriginReader = ReturnType<typeof originReader>;

async function present(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  assigneeOf: AssigneeReader,
  originOf: OriginReader,
) {
  const goal = task.goalId ? await ctx.db.get(task.goalId) : null;
  return {
    id: task._id,
    title: task.title,
    notes: task.notes ?? null,
    kind: task.kind,
    column: task.column,
    due: task.due ?? null,
    goalId: goal ? goal._id : null,
    goalTitle: goal?.title ?? null,
    doneAt: task.doneAt ?? null,
    /** When the card was added: what "new for you" on Today goes by. */
    createdAt: task._creationTime,
    /** null is a shared task: every member with the board sees it. */
    company: task.company ?? null,
    /** The standup could not tell its company: listed under "Needs owner" until one is picked. */
    needsCompany: task.needsCompany === true,
    assignee: await assigneeOf(task.assignee),
    /** Who the card mentions: the names to mark where the text says `@Name`. */
    mentions: task.mentioned === undefined ? [] : await mentionsOf(ctx, task, assigneeOf),
    /**
     * Where the card came from when nobody typed it in on the board: the
     * standup, a Telegram group (with who asked, for a viewer who knows them),
     * the owner's Claude (with whose, by first name, and `bot` when a bot
     * made it), or "Suggest a change"; null otherwise.
     */
    origin:
      task.origin?.source === "telegram"
        ? { source: "telegram" as const, by: await addedBy(ctx, task, assigneeOf) }
        : task.origin?.source === "agent"
          ? {
              source: "agent" as const,
              for: firstNameOf(await addedBy(ctx, task, assigneeOf)),
              // Which of the owner's four, where the card says (convex/lib/agents.ts).
              ...(task.origin.agent === undefined ? null : { agent: task.origin.agent }),
              // The bot that made it, by its profile id (convex/lib/taskOrigin.ts).
              ...(task.origin.bot === undefined ? null : { bot: task.origin.bot }),
            }
          : await originOf(task),
  };
}

/**
 * The whole board as a person may see it: shared tasks and those of their
 * companies. Open columns in their order, and the latest finished tasks.
 * What `tasks.board` returns, and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function boardFor(ctx: QueryCtx, member: Member) {
  {
    const [backlog, thisWeek, doing] = await Promise.all(
      OPEN_COLUMNS.map((column) => inColumn(ctx, column)),
    );
    // The latest finished tasks the caller can see, so a board is not left
    // short by the other company's finishing more.
    const done: Doc<"tasks">[] = [];
    const finished = ctx.db
      .query("tasks")
      .withIndex("by_column_and_doneAt", (q) => q.eq("column", "done"))
      .order("desc");
    for await (const task of finished) {
      if (task.archivedAt !== undefined || !canSee(member, task)) continue;
      done.push(task);
      if (done.length === DONE_LIMIT) break;
    }
    const assigneeOf = assigneeReader(ctx, member);
    const originOf = originReader(ctx, member);
    const show = (tasks: Doc<"tasks">[]) =>
      Promise.all(
        tasks.filter((t) => canSee(member, t)).map((t) => present(ctx, t, assigneeOf, originOf)),
      );
    return {
      backlog: await show(backlog!),
      this_week: await show(thisWeek!),
      doing: await show(doing!),
      done: await show(done),
    };
  }
}

export const board = memberQuery("board")({
  args: {},
  handler: (ctx) => boardFor(ctx, ctx.member),
});

/** Problems still to be solved, for the scorecard. */
export const openIssues = memberQuery(["scorecard", "board"])({
  args: {},
  handler: async (ctx) => {
    const assigneeOf = assigneeReader(ctx, ctx.member);
    const originOf = originReader(ctx, ctx.member);
    const issues = [];
    for (const column of ISSUE_COLUMNS) {
      for (const task of await inColumn(ctx, column)) {
        if (task.kind !== "issue" || !canSee(ctx.member, task)) continue;
        issues.push(await present(ctx, task, assigneeOf, originOf));
      }
    }
    return issues;
  },
});

/**
 * Add a card: the one writer of a new task, whoever asks. Every check
 * `tasks.create` makes (the caller's company, who it may be given to:
 * `reachable`), the same cleaning, the same place in its column and the same
 * notifications. `member` is the person who asked, or null for the system
 * (the standup import), which is on every company and knows everyone but
 * still gives a card only to someone who may take work; it must say who is
 * said to have done it (`from.actor`).
 *
 * `from.origin` is for a card asked for somewhere else (a Telegram group, the
 * standup, "Suggest a change", the owner's agent): it is stored as the card's
 * origin, and the card is not announced in Telegram, since whoever asked was
 * answered where they asked (the standup and a suggestion name no assigner).
 * The owner's agent is the exception (`announce`): nobody was answered
 * anywhere, so its card is announced as the owner's own would be, and
 * `actor` says the agent did it.
 */
export async function createTask(
  ctx: MutationCtx,
  member: Member | null,
  args: {
    title: string;
    kind?: Doc<"tasks">["kind"];
    column?: Column;
    notes?: string;
    goalId?: Id<"goals">;
    due?: string;
    assignee?: string | null;
    company?: CompanyId | null;
    /**
     * Where the card goes in its column, counted among the cards the caller
     * sees (as `tasks.move` counts): 0 is the top. Left out, the end, as every
     * other caller of this function (Telegram, the standup, suggestions, the
     * owner's agent) has always had it. Means nothing in "Done".
     */
    index?: number;
  },
  from?: {
    origin?: NonNullable<Doc<"tasks">["origin"]>;
    announce?: boolean;
    actor?: NotificationActor;
    /** Added with `force` past a near-duplicate check (convex/lib/duplicates.ts): kept on the card for its badge. */
    duplicate?: { duplicateOf: string[]; forceReason: string } | null;
    /** The standup could not tell its company: listed under "Needs owner" until one is picked. */
    needsCompany?: boolean;
    /**
     * This way in may give the task to a bot: the board's own add, a call
     * that names no bot, an approved proposal. Still only for the owner
     * (`mayGiveToBot`). Left out: a bot assignee is refused.
     */
    mayGiveBot?: boolean;
  },
): Promise<Id<"tasks">> {
  {
    checkDue(args.due);
    await checkGoal(ctx, args.goalId);
    const company = args.company ?? undefined;
    if (company !== undefined && member !== null) requireCompany(member, company);
    const actor: NotificationActor | undefined =
      from?.actor ?? (member === null ? undefined : { type: "user", userId: member.user._id });
    if (actor === undefined) throw new Error("A card the system adds says who added it.");
    const assignee =
      args.assignee == null
        ? undefined
        : await checkAssignee(ctx, member, args.assignee, company, from?.mayGiveBot);
    const title = cleanTitle(args.title, "task");
    const column = args.column ?? "backlog";
    // "Done" sorts by doneAt, so its `order` is unused; elsewhere a new card
    // goes after the last one.
    const last =
      column === "done"
        ? null
        : await ctx.db
            .query("tasks")
            .withIndex("by_column_and_order", (q) => q.eq("column", column))
            .order("desc")
            .first();
    const id = await ctx.db.insert("tasks", {
      title,
      kind: args.kind ?? "task",
      column,
      order: (last?.order ?? -1) + 1,
      notes: args.notes === undefined ? undefined : cleanNotes(args.notes),
      goalId: args.goalId,
      due: args.due,
      doneAt: column === "done" ? Date.now() : undefined,
      assignee,
      company,
      ...(member === null ? null : { createdBy: member.user._id }),
      ...(from?.origin === undefined ? null : { origin: from.origin }),
      ...(from?.duplicate == null ? null : from.duplicate),
      ...(from?.needsCompany === true ? { needsCompany: true } : null),
    });
    if (args.index !== undefined && column !== "done" && member !== null) {
      await place(ctx, member, (await ctx.db.get(id))!, column, args.index);
    }
    // A bot is woken by the events webhook, not by a Telegram message to a person.
    if (
      member !== null &&
      taskAssigneeBot(assignee) === null &&
      (from?.origin === undefined || from.announce === true)
    ) {
      await announceAssignment(ctx, { taskId: id, before: undefined, after: assignee, actor: member.user });
    }
    // Whether it was typed on the board, asked for elsewhere or brought by the standup.
    await notifyTaskChange(ctx, { taskId: id, before: null, actor });
    await scheduleBotEvent(ctx, {
      event: "task.assigned",
      company,
      agent: assigneeProfileId(assignee),
      id,
      title,
      at: Date.now(),
    });
    return id;
  }
}

// ── Near-duplicates, for people ────────────────────────────────────────────
// A bot adding a card near an open one is refused until it says how it
// differs (`checkDuplicates`, convex/lib/duplicates.ts). A person is never
// refused: the board and Memory warn and let them add it anyway, Telegram
// adds it and names the open card in its reply, a suggestion (whose sender
// may not read the board) is added silently, and the standup import skips
// it. Whatever was added past a near card is marked (`duplicateOf`, with one
// of these reasons), as a bot's forced card is.

export const TASK_DUPLICATE_WORDS = {
  possible: "This may repeat a card already open on the board.",
} as const;

/** Why a card a person added past a near one was added: fixed words, one per way in. */
export const PERSON_DUPLICATE_REASONS = {
  board: "Added on the board after the possible duplicate was shown.",
  memory: "Added from Memory after the possible duplicate was shown.",
  telegram: "Asked for in Telegram; the reply named the possible duplicate.",
  suggestion: "Sent with Suggest a change, whose sender is not shown the board.",
} as const;

/** An open card near a new one: its id, title and company (null: shared). */
export type NearTask = { id: Id<"tasks">; title: string; company: CompanyId | null };

/**
 * The open cards near a new one's title (`findDuplicates`, open tasks only,
 * the same company and shared ones), best first, as `viewer` may be told of
 * them (`canSee`); `viewer` null is the system, which sees all. Reads no
 * clock: `now` is the caller's.
 */
export async function nearTasks(
  ctx: QueryCtx,
  viewer: Member | null,
  args: { title: string; company: CompanyId | null; now: number },
): Promise<NearTask[]> {
  if (args.title.trim() === "") return [];
  const found = await findDuplicates(ctx, { company: args.company, title: args.title, kinds: ["task"], now: args.now });
  const near: NearTask[] = [];
  for (const match of found.matches) {
    const id = ctx.db.normalizeId("tasks", match.id);
    const task = id === null ? null : await ctx.db.get(id);
    if (task === null || (viewer !== null && !canSee(viewer, task))) continue;
    near.push({ id: task._id, title: task.title, company: task.company ?? null });
  }
  return near;
}

/** What a card added past these near ones stores, or null when there were none. */
export const nearMark = (near: readonly NearTask[], reason: string): DuplicateMark | null =>
  near.length === 0 ? null : { duplicateOf: near.map((task) => task.id), forceReason: reason };

/**
 * A person adding a card: with `"warn"`, near open cards stop it with a coded
 * warning (`possible_duplicate`, the cards they may see by id and title) for
 * the page to show and confirm past; otherwise (`"confirmed"`, or nothing
 * said) it is added and marked. Returns the mark to store.
 */
export async function personDuplicates(
  ctx: MutationCtx,
  member: Member,
  args: { title: string; company: CompanyId | null; duplicates: "warn" | "confirmed" | undefined },
  reason: string,
): Promise<DuplicateMark | null> {
  const near = await nearTasks(ctx, member, { title: args.title, company: args.company, now: Date.now() });
  if (args.duplicates === "warn" && near.length > 0) {
    throw new ConvexError({
      words: TASK_DUPLICATE_WORDS.possible,
      refusal: { code: "possible_duplicate", matches: near.map(({ id, title }) => ({ id, title })) },
    });
  }
  return nearMark(near, reason);
}

/** How a person's add says what to do with a near card: warn first, or add it anyway. */
export const duplicatesArg = v.optional(v.union(v.literal("warn"), v.literal("confirmed")));

export const create = memberMutation("board")({
  args: {
    title: v.string(),
    kind: v.optional(taskKindValidator),
    column: v.optional(taskColumnValidator),
    notes: v.optional(v.string()),
    goalId: v.optional(v.id("goals")),
    due: v.optional(v.string()),
    // Left out or null: nobody, and a task shared by both companies.
    assignee: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(companyValidator, v.null())),
    // Where in the column, among the cards the caller sees: 0 is the top.
    // Left out, the end.
    index: v.optional(v.number()),
    // "warn": a near open card stops it with a coded warning, to confirm
    // past; "confirmed" or nothing: added, marked if near one.
    duplicates: duplicatesArg,
  },
  handler: async (ctx, { duplicates, ...args }) => {
    const mark = await personDuplicates(
      ctx,
      ctx.member,
      { title: args.title, company: args.company ?? null, duplicates },
      PERSON_DUPLICATE_REASONS.board,
    );
    // By hand on the board: the owner may give it to a bot (`mayGiveToBot`).
    return createTask(ctx, ctx.member, args, { mayGiveBot: true, ...(mark === null ? null : { duplicate: mark }) });
  },
});

export const TASK_GONE = "That task no longer exists.";
export const TASK_ARCHIVED = "That task is already off the board.";

/**
 * Put a task at a position in a column, counted among the cards the person
 * sees: what `tasks.move` runs. `by` is who is said to have done it, where
 * that is not the person themselves (the owner's agent).
 */
export async function moveTask(
  ctx: MutationCtx,
  member: Member,
  args: { id: Id<"tasks">; column: Column; index: number },
  by?: { actor: NotificationActor },
): Promise<null> {
  const task = await ctx.db.get(args.id);
  if (!task) throw new ConvexError(TASK_GONE);
  requireVisible(member, task);
  if (task.archivedAt !== undefined) throw new ConvexError(TASK_ARCHIVED);
  await place(ctx, member, task, args.column, args.index);
  await notifyTaskChange(ctx, {
    taskId: args.id,
    before: task,
    actor: by?.actor ?? { type: "user", userId: member.user._id },
  });
  return null;
}

/** Put a task at a position in a column, counted among the cards the caller sees. */
export const move = memberMutation("board")({
  args: { id: v.id("tasks"), column: taskColumnValidator, index: v.number() },
  handler: (ctx, args) => moveTask(ctx, ctx.member, args),
});

/**
 * Take a task off the board without deleting it. Hidden from the board and
 * from open lists. What `tasks.archive` runs, and what `task_archive` runs.
 */
export async function archiveTask(
  ctx: MutationCtx,
  member: Member,
  id: Id<"tasks">,
  now?: number,
): Promise<null> {
  const task = await ctx.db.get(id);
  if (!task) throw new ConvexError(TASK_GONE);
  requireVisible(member, task);
  if (task.archivedAt !== undefined) throw new ConvexError(TASK_ARCHIVED);
  await ctx.db.patch(id, { archivedAt: now ?? Date.now() });
  return null;
}

/** Take a task off the board. It stays stored; nothing is told. */
export const archive = memberMutation("board")({
  args: { id: v.id("tasks") },
  handler: (ctx, args) => archiveTask(ctx, ctx.member, args.id),
});

/** What an edit of a task may carry. For five of them, null clears the field and leaving it out keeps it. */
export type TaskEdit = {
  id: Id<"tasks">;
  title?: string;
  kind?: Doc<"tasks">["kind"];
  column?: Column;
  notes?: string | null;
  goalId?: Id<"goals"> | null;
  due?: string | null;
  assignee?: string | null;
  company?: CompanyId | null;
  mentions?: string[];
};

/**
 * Edit a task: what `tasks.update` runs. Changing `column` here moves the
 * card to the top of the new column in the same transaction, so the editor
 * never half-saves.
 *
 * Anyone with the board may edit any task they can see. Giving a task a
 * company hides it from teammates who are not on that company. `by` is who is
 * said to have done it, where that is not the person themselves (the owner's
 * agent); the Telegram announcement is the person's either way.
 */
export async function updateTask(
  ctx: MutationCtx,
  member: Member,
  args: TaskEdit,
  /** `mayGiveBot`: as `createTask`'s; left out, a bot assignee is refused. */
  by?: { actor?: NotificationActor; mayGiveBot?: boolean },
): Promise<null> {
  const task = await ctx.db.get(args.id);
  if (!task) throw new ConvexError(TASK_GONE);
  requireVisible(member, task);
  if (task.archivedAt !== undefined) throw new ConvexError(TASK_ARCHIVED);
  checkDue(args.due);
  await checkGoal(ctx, args.goalId);

  const company = args.company === undefined ? task.company : (args.company ?? undefined);
  if (args.company != null) requireCompany(member, args.company);
  let assignee = task.assignee;
  if (args.assignee === null) assignee = undefined;
  else if (args.assignee !== undefined) {
    assignee = await checkAssignee(ctx, member, args.assignee, company, by?.mayGiveBot);
  } else if (assignee !== undefined && company !== undefined && company !== task.company) {
    // The task is moving to a company; whoever holds it must be on it. A
    // teammate since removed is on none and stays as they are. A bot whose
    // profile names the other company does not.
    const profile = assigneeProfileId(assignee);
    if (profile !== null) {
      const row = await ownersBot(ctx, profile);
      if (row !== null && !botCoversCompany(row.company, company)) {
        throw new ConvexError(ASSIGNEE_NOT_ON_COMPANY);
      }
    } else {
      const holder = (await teamDirectory(ctx.db)).get(assignee);
      if (holder !== undefined && !holder.companies.includes(company)) {
        throw new ConvexError(ASSIGNEE_NOT_ON_COMPANY);
      }
    }
  }
  const title = args.title !== undefined ? cleanTitle(args.title, "task") : task.title;

  const already = task.mentioned ?? [];
  const mentioned = (
    args.mentions === undefined ? [] : await checkMentions(ctx, member, args.mentions, company)
  ).filter((person) => !already.includes(person));

  await ctx.db.patch(args.id, {
    ...(mentioned.length > 0
      ? { mentioned: [...already, ...mentioned].slice(-MAX_MENTIONED) }
      : null),
    ...(args.title !== undefined ? { title } : null),
    ...(args.kind !== undefined ? { kind: args.kind } : null),
    ...(args.notes !== undefined
      ? { notes: args.notes === null ? undefined : cleanNotes(args.notes) }
      : null),
    ...(args.goalId !== undefined ? { goalId: args.goalId ?? undefined } : null),
    ...(args.due !== undefined ? { due: args.due ?? undefined } : null),
    ...(args.assignee !== undefined ? { assignee } : null),
    // Any company chosen on the card, shared included, answers the standup's flag.
    ...(args.company !== undefined ? { company, needsCompany: undefined } : null),
  });
  // A bot is woken by the events webhook, never named in a group: to Telegram
  // it is as if the task were unassigned. Whoever held it before is still
  // told in the app (`notifyTaskChange`, "reassigned").
  await announceAssignment(ctx, {
    taskId: args.id,
    before: task.assignee,
    after: taskAssigneeBot(assignee) === null ? assignee : undefined,
    actor: member.user,
  });
  if (args.column !== undefined && args.column !== task.column) {
    await place(ctx, member, task, args.column, 0);
  }
  await notifyTaskChange(ctx, {
    taskId: args.id,
    before: task,
    actor: by?.actor ?? { type: "user", userId: member.user._id },
    mentioned,
  });
  if (assignee !== task.assignee) {
    await scheduleBotEvent(ctx, {
      event: "task.assigned",
      company,
      agent: assigneeProfileId(assignee),
      id: args.id,
      title,
      at: Date.now(),
    });
  }
  return null;
}

/** Edit a task (`updateTask`). */
export const update = memberMutation("board")({
  args: {
    id: v.id("tasks"),
    title: v.optional(v.string()),
    kind: v.optional(taskKindValidator),
    column: v.optional(taskColumnValidator),
    // For these five, null clears the field and leaving it out keeps it.
    notes: v.optional(v.union(v.string(), v.null())),
    goalId: v.optional(v.union(v.id("goals"), v.null())),
    due: v.optional(v.union(v.string(), v.null())),
    assignee: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(companyValidator, v.null())),
    // The addresses of the people this save mentions (`checkMentions`). Each
    // is told once per card: saving again does not tell them again.
    mentions: v.optional(v.array(v.string())),
  },
  // By hand on the board: the owner may give it to a bot (`mayGiveToBot`).
  handler: (ctx, args) => updateTask(ctx, ctx.member, args, { mayGiveBot: true }),
});

export const remove = memberMutation("board")({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) return null;
    requireVisible(ctx.member, task);
    await ctx.db.delete(args.id);
    if (task.column !== "done") await renumber(ctx, await inColumn(ctx, task.column));
    return null;
  },
});
