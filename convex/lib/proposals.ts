// What an agent proposes and the owner decides (the `proposals` table).
// `propose` is the tool's (convex/lib/mcpTools.ts); `approve` and `dismiss`
// are the owner's own click (convex/assistant.ts). `proposal_decide` calls
// the same two. Runs only inside Convex:
// never import it from the UI.
//
// **Nothing a proposal names happens until the owner approves it**, and then
// it happens through the function the app's own mutation runs (`createTask`,
// `updateTask`, `moveTask`, `updateDeal`), as the owner, said to be the
// agent's. So a teammate is told exactly what the owner's own change would
// tell them, and every rule the app keeps holds unasked. A draft is text to
// copy: approving one marks it kept and sends nothing anywhere.
//
// A proposal's reason and payload were written by a model: held to the kind's
// own fields, cleaned, bounded, and checked against the live data twice (when
// proposed, and again at the click). No title, name, address or text goes in
// a log or a thrown error: every refusal is fixed words (convex/lib/agents.ts).
//
// **To add a kind**: its name in `PROPOSAL_KINDS` (convex/lib/agents.ts), its
// shape in `proposalPayloadValidator` (convex/schema.ts), its fields in
// `FIELDS` and a case in `shapeOf`, `checkLive`, `carryOut` and `aboutOf`
// below (each `switch` stops compiling until it has one), its zod payload in
// convex/lib/mcpTools.ts, its sentence in src/lib/assistant/proposal-words.ts,
// and its form in src/components/assistant/approvals.tsx.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { customersFor } from "../customers";
import { attachIntel } from "../dealIntel";
import { createDeal, updateDeal } from "../deals";
import { createDecision } from "../decisions";
import { MAX_GOAL_TARGET, checkGoalDetails, createGoal, updateGoal } from "../goals";
import { addComment, commentTarget } from "../comments";
import { HANDOFF_WORDS, MAX_HANDOFF_NOTE } from "./handoffs";
import { prepareReassign, reassignHandoff } from "../handoffs";
import { COMMENT_WORDS, MAX_COMMENT_BODY, isCommentSubject, type CommentSubjectKind } from "./comments";
import { MAX_NOTE_BODY, NOTE_WORDS } from "./memory";
import { createNote } from "../notes";
import { scheduleBotEvent } from "../botEvents";
import { PROPOSAL_EVENT_TITLES } from "./botEvents";
import { archiveTask, botAssignee, createTask, mayGiveToBot, moveTask, updateTask } from "../tasks";
import { taskAssigneeBot } from "./botEvents";
import { requireAgentOn } from "./agentStore";
import { cleanLine, cleanLines } from "./agentText";
import {
  AGENT_IDS,
  APPROVED_BLOCKS_DAYS,
  DEFAULT_URGENCY,
  REJECT_CODES,
  SOURCE_KINDS,
  URGENCIES,
  decisionOf,
  type RejectCode,
  type SourceKind,
  type Urgency,
  isAgentId,
  isBotId,
  DECIDED_ROWS,
  DEDUPE_KEY,
  DEAL_CREATE_STAGES,
  DEAL_CREATE_WORDS,
  DISMISSED_BLOCKS_DAYS,
  MAX_DEAL_CREATE_SOURCES,
  MAX_DEAL_INTEL_SIGNALS,
  MAX_DEAL_INTEL_SUMMARY,
  DRAFT_ABOUT,
  FEEDBACK_ROWS,
  DECIDE_WORDS,
  MAX_DEDUPE_KEY_LENGTH,
  MAX_DISMISS_REASON_LENGTH,
  MAX_DRAFT_BODY_LENGTH,
  MAX_DRAFT_TITLE_LENGTH,
  MAX_OPEN_PER_AGENT,
  MAX_OPEN_PER_BOT,
  MAX_PROPOSALS_PER_DAY,
  MAX_REASON_LENGTH,
  MAX_WITHDRAW_NOTE,
  PROPOSAL_EXPIRES_DAYS,
  PROPOSAL_RETENTION_DAYS,
  PROPOSAL_WORDS,
  WITHDRAW_WORDS,
  WRONG_WITHDRAW_BLOCKS_DAYS,
  filedBy,
  type AgentId,
  type WithdrawReason,
  type DraftAbout,
  type ProposalKind,
} from "./agents";
import {
  botAreaRefusal,
  botLevelRefusal,
  BOT_PERMISSION_WORDS,
  BOT_WORDS,
  DEFAULT_BOT_LIMITS,
  MAX_BOTS,
  isBotArea,
  levelOf,
  type BotArea,
} from "./botRules";
import { botNamed, setBotLevel } from "./botStore";
import { agentTaskOrigin } from "./taskOrigin";
import { cashReader } from "./cashGroup";
import { checkDuplicates, duplicateViewFor, linksOfProposal, proposalTitle } from "./duplicates";
import { AREA_NAMES } from "./roles";
import type { CompanyId } from "./company";
import { MAX_NAME_LENGTH, MAX_NEXT_STEP_LENGTH, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./limits";
import { dealNameKey, isDealPriority, looksLikeContactDetail, type DealPriority } from "./dealDetails";
import { cleanIntelEdit, type IntelEdit } from "./dealIntel";
import { NO_CONTACT_DETAILS, cleanDealDetails } from "./pipelineFields";
import { MAX_DECISION_CONTEXT, MAX_DECISION_TEXT } from "./memory";
import type { NotificationActor } from "./notify";
import type { Member } from "./owner";
import { METRICS } from "./metricRegistry";
import { isCanonicalPeriodStart } from "./periods";
import { isQuarter } from "./quarter";
import { assignablePeople, nameOf } from "./teamDirectory";
import { grantCovers, noteDecision, type ProposalCaller } from "./trust";

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Doc<"proposals">;
type Column = Doc<"tasks">["column"];
const COLUMNS: readonly Column[] = ["backlog", "this_week", "doing", "done"];

export type TaskCreate = { title: string; notes?: string; assignee?: string; due?: string; column?: Column };
export type TaskChange = {
  taskId: Id<"tasks">;
  assignee?: string | null;
  due?: string | null;
  column?: Column;
};
export type DealNextStep = { dealId: Id<"deals">; nextStep: string };
export type Draft = { title: string; body: string; about?: { type: DraftAbout; id?: string } };
type GoalStatus = Doc<"goals">["status"];
const GOAL_STATUSES: readonly GoalStatus[] = ["on_track", "at_risk", "off_track", "done"];
export type GoalCreate = {
  quarter: string;
  title: string;
  status?: GoalStatus;
  ownerEmail?: string;
  ownerBot?: string;
  target?: string;
  dueOn?: string;
};
export type GoalUpdate = {
  goalId: Id<"goals">;
  title?: string;
  status?: GoalStatus;
  ownerEmail?: string | null;
  ownerBot?: string | null;
  target?: string | null;
  dueOn?: string | null;
};
/** What a goal proposal may set besides its title and status. */
const GOAL_DETAILS = ["ownerEmail", "ownerBot", "target", "dueOn"] as const;
export type BotPermissionAsk = { bot: string; area: BotArea; level: "read" | "write" };
export type DecisionRecord = {
  title: string;
  decision: string;
  context?: string;
  ownerEmail?: string;
  revisitOn?: string;
  meetingId?: Id<"meetingNotes">;
};

/** What a proposed new deal's intel may hold (Bot Loop v3): a short summary and a few signals. */
export type DealIntelAsk = {
  summary?: string;
  fit?: number | null;
  ehr?: string;
  billingModel?: string;
  ownership?: string;
  angle?: string;
  nextBestAction?: string;
  signals?: { date?: string; kind: string; text: string }[];
};
export type MemoryNoteAsk = { title: string; body: string };
export type CommentAsk = { subjectKind: CommentSubjectKind; subjectId: string; body: string };
export type TaskArchive = { taskId: Id<"tasks"> };
export type HandoffReassign = { handoffId: Id<"handoffs">; to: string; note?: string };

export type DealCreate = {
  name: string;
  stage?: string;
  contact?: string;
  amount?: number | null;
  region?: string;
  physicians?: number | null;
  locations?: number | null;
  priority?: DealPriority;
  sources?: string[];
  intel?: DealIntelAsk;
  nextStep?: string;
};

/** A proposal's kind with the payload that kind has. */
export type Shaped =
  | { kind: "task_create"; payload: TaskCreate }
  | { kind: "task_change"; payload: TaskChange }
  | { kind: "deal_next_step"; payload: DealNextStep }
  | { kind: "draft"; payload: Draft }
  | { kind: "decision_record"; payload: DecisionRecord }
  | { kind: "goal_create"; payload: GoalCreate }
  | { kind: "goal_update"; payload: GoalUpdate }
  | { kind: "bot_permission"; payload: BotPermissionAsk }
  | { kind: "deal_create"; payload: DealCreate }
  | { kind: "memory_note"; payload: MemoryNoteAsk }
  | { kind: "comment"; payload: CommentAsk }
  | { kind: "task_archive"; payload: TaskArchive }
  | { kind: "handoff_reassign"; payload: HandoffReassign };

const shapedOf = (row: Row) => ({ kind: row.kind, payload: row.payload }) as Shaped;

type Raw = Record<string, unknown>;

/** The fields each kind's payload may hold, and those it must. */
const FIELDS: Record<ProposalKind, { all: readonly string[]; needs: readonly string[] }> = {
  task_create: { all: ["title", "notes", "assignee", "due", "column"], needs: ["title"] },
  task_change: { all: ["taskId", "assignee", "due", "column"], needs: ["taskId"] },
  deal_next_step: { all: ["dealId", "nextStep"], needs: ["dealId", "nextStep"] },
  draft: { all: ["title", "body", "about"], needs: ["title", "body"] },
  decision_record: {
    all: ["title", "decision", "context", "ownerEmail", "revisitOn", "meetingId"],
    needs: ["title", "decision"],
  },
  goal_create: { all: ["quarter", "title", "status", ...GOAL_DETAILS], needs: ["quarter", "title"] },
  goal_update: { all: ["goalId", "title", "status", ...GOAL_DETAILS], needs: ["goalId"] },
  bot_permission: { all: ["bot", "area", "level"], needs: ["bot", "area", "level"] },
  deal_create: {
    all: ["name", "stage", "contact", "amount", "region", "physicians", "locations", "priority", "sources", "intel", "nextStep"],
    needs: ["name"],
  },
  memory_note: { all: ["title", "body"], needs: ["title", "body"] },
  comment: { all: ["subjectKind", "subjectId", "body"], needs: ["subjectKind", "subjectId", "body"] },
  task_archive: { all: ["taskId"], needs: ["taskId"] },
  handoff_reassign: { all: ["handoffId", "to", "note"], needs: ["handoffId", "to"] },
};

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

/** One line within `max`, or a refusal: over-long text is refused, never cut. */
function line(value: unknown, max: number, empty: string): string {
  if (typeof value !== "string") return refuse(PROPOSAL_WORDS.payload);
  if (value.trim().length > max) return refuse(PROPOSAL_WORDS.tooLong);
  const text = cleanLine(value, max);
  return text === "" ? refuse(empty) : text;
}

function lines(value: unknown, max: number): string {
  if (typeof value !== "string") return refuse(PROPOSAL_WORDS.payload);
  return cleanLines(value, max) ?? refuse(PROPOSAL_WORDS.tooLong);
}

function dayOf(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalPeriodStart("day", value)) {
    return refuse(PROPOSAL_WORDS.notADate);
  }
  return value;
}

function columnOf(value: unknown): Column {
  return COLUMNS.includes(value as Column) ? (value as Column) : refuse(PROPOSAL_WORDS.payload);
}

function goalStatusOf(value: unknown): GoalStatus {
  return GOAL_STATUSES.includes(value as GoalStatus) ? (value as GoalStatus) : refuse(PROPOSAL_WORDS.payload);
}

function quarterIn(value: unknown): string {
  return typeof value === "string" && isQuarter(value) ? value : refuse(PROPOSAL_WORDS.notAQuarter);
}

/** A goal's owner, bot, target and due day as sent: each in its own shape, null (an update's) clearing it. */
function goalDetailsIn(raw: Raw, clearable: boolean) {
  const out: Record<string, string | null> = {};
  for (const field of GOAL_DETAILS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value === null && clearable) out[field] = null;
    else if (field === "ownerEmail") out[field] = addressOf(value);
    else if (field === "dueOn") out[field] = dayOf(value);
    else if (field === "target") out[field] = line(value, MAX_GOAL_TARGET, PROPOSAL_WORDS.payload);
    else if (typeof value === "string" && value.trim() !== "") out[field] = value.trim().toLowerCase();
    else refuse(PROPOSAL_WORDS.payload);
  }
  return out;
}

const addressOf = (value: unknown): string =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().toLowerCase()
    : refuse(PROPOSAL_WORDS.cannotAssign);

/**
 * What was sent, as this kind's payload: only the kind's own fields, each of
 * its own type, text cleaned and within its limit, fields in one fixed order
 * (two payloads that say the same thing are then the same JSON). An id that
 * is not one of its table's reads as a row that is gone.
 */
export function shapeOf(ctx: QueryCtx, kind: ProposalKind, raw: Raw): Shaped {
  const { all, needs } = FIELDS[kind];
  const sent = Object.keys(raw).filter((key) => raw[key] !== undefined);
  if (sent.some((key) => !all.includes(key)) || needs.some((key) => !sent.includes(key))) {
    refuse(PROPOSAL_WORDS.payload);
  }
  const has = (key: string) => raw[key] !== undefined;
  switch (kind) {
    case "task_create": {
      const notes = has("notes") ? lines(raw.notes, MAX_NOTES_LENGTH) : "";
      return {
        kind,
        payload: {
          title: line(raw.title, MAX_TITLE_LENGTH, PROPOSAL_WORDS.title),
          ...(notes === "" ? null : { notes }),
          ...(has("assignee") ? { assignee: addressOf(raw.assignee) } : null),
          ...(has("due") ? { due: dayOf(raw.due) } : null),
          ...(has("column") ? { column: columnOf(raw.column) } : null),
        },
      };
    }
    case "task_change": {
      const taskId =
        typeof raw.taskId === "string" ? ctx.db.normalizeId("tasks", raw.taskId) : null;
      if (taskId === null) return refuse(PROPOSAL_WORDS.taskGone);
      if (!has("assignee") && !has("due") && !has("column")) refuse(PROPOSAL_WORDS.nothingToChange);
      return {
        kind,
        payload: {
          taskId,
          ...(has("assignee")
            ? { assignee: raw.assignee === null ? null : addressOf(raw.assignee) }
            : null),
          ...(has("due") ? { due: raw.due === null ? null : dayOf(raw.due) } : null),
          ...(has("column") ? { column: columnOf(raw.column) } : null),
        },
      };
    }
    case "deal_next_step": {
      const dealId =
        typeof raw.dealId === "string" ? ctx.db.normalizeId("deals", raw.dealId) : null;
      if (dealId === null) return refuse(PROPOSAL_WORDS.dealGone);
      return {
        kind,
        payload: { dealId, nextStep: line(raw.nextStep, MAX_NEXT_STEP_LENGTH, PROPOSAL_WORDS.nextStep) },
      };
    }
    case "draft": {
      const body = lines(raw.body, MAX_DRAFT_BODY_LENGTH);
      if (body === "") refuse(PROPOSAL_WORDS.body);
      return {
        kind,
        payload: {
          title: line(raw.title, MAX_DRAFT_TITLE_LENGTH, PROPOSAL_WORDS.title),
          body,
          ...(has("about") ? { about: aboutIn(raw.about) } : null),
        },
      };
    }
    case "decision_record": {
      const decision = lines(raw.decision, MAX_DECISION_TEXT);
      if (decision === "") refuse(PROPOSAL_WORDS.decision);
      const context = has("context") ? lines(raw.context, MAX_DECISION_CONTEXT) : "";
      const meetingId =
        !has("meetingId")
          ? undefined
          : typeof raw.meetingId === "string"
            ? ctx.db.normalizeId("meetingNotes", raw.meetingId)
            : null;
      if (meetingId === null) return refuse(PROPOSAL_WORDS.meetingGone);
      return {
        kind,
        payload: {
          title: line(raw.title, MAX_TITLE_LENGTH, PROPOSAL_WORDS.title),
          decision,
          ...(context === "" ? null : { context }),
          ...(has("ownerEmail") ? { ownerEmail: addressOf(raw.ownerEmail) } : null),
          ...(has("revisitOn") ? { revisitOn: dayOf(raw.revisitOn) } : null),
          ...(meetingId === undefined ? null : { meetingId }),
        },
      };
    }
    case "goal_create":
      return {
        kind,
        payload: {
          quarter: quarterIn(raw.quarter),
          title: line(raw.title, MAX_TITLE_LENGTH, PROPOSAL_WORDS.title),
          ...(has("status") ? { status: goalStatusOf(raw.status) } : null),
          ...(goalDetailsIn(raw, false) as Omit<GoalCreate, "quarter" | "title" | "status">),
        },
      };
    case "goal_update": {
      const goalId = typeof raw.goalId === "string" ? ctx.db.normalizeId("goals", raw.goalId) : null;
      if (goalId === null) return refuse(PROPOSAL_WORDS.goalGone);
      if (!has("title") && !has("status") && !GOAL_DETAILS.some(has)) refuse(PROPOSAL_WORDS.nothingToChangeGoal);
      return {
        kind,
        payload: {
          goalId,
          ...(has("title") ? { title: line(raw.title, MAX_TITLE_LENGTH, PROPOSAL_WORDS.title) } : null),
          ...(has("status") ? { status: goalStatusOf(raw.status) } : null),
          ...goalDetailsIn(raw, true),
        },
      };
    }
    case "bot_permission": {
      if (!isBotId(raw.bot)) return refuse(PROPOSAL_WORDS.botId);
      const areaProblem = botAreaRefusal(raw.area);
      if (areaProblem === "locked") return refuse(BOT_WORDS.locked);
      if (areaProblem !== null || !isBotArea(raw.area)) return refuse(BOT_PERMISSION_WORDS.badArea);
      if (raw.level !== "read" && raw.level !== "write") return refuse(PROPOSAL_WORDS.payload);
      return { kind, payload: { bot: raw.bot, area: raw.area, level: raw.level } };
    }
    case "deal_create":
      return { kind, payload: dealCreateIn(raw, has) };
    case "memory_note": {
      const body = lines(raw.body, MAX_NOTE_BODY);
      if (body === "") refuse(NOTE_WORDS.body);
      return { kind, payload: { title: line(raw.title, MAX_TITLE_LENGTH, NOTE_WORDS.title), body } };
    }
    case "comment": {
      const subjectKind = raw.subjectKind;
      const rawId = raw.subjectId;
      if (!isCommentSubject(subjectKind)) return refuse(COMMENT_WORDS.gone);
      if (typeof rawId !== "string" || rawId === "") return refuse(COMMENT_WORDS.gone);
      const table = subjectKind === "task" ? "tasks" : subjectKind === "deal" ? "deals" : "handoffs";
      const subjectId = ctx.db.normalizeId(table, rawId);
      if (subjectId === null) return refuse(COMMENT_WORDS.gone);
      const body = lines(raw.body, MAX_COMMENT_BODY);
      if (body === "") return refuse(COMMENT_WORDS.body);
      return { kind, payload: { subjectKind, subjectId, body } };
    }
    case "task_archive": {
      const taskId = typeof raw.taskId === "string" ? ctx.db.normalizeId("tasks", raw.taskId) : null;
      if (taskId === null) return refuse(PROPOSAL_WORDS.taskGone);
      return { kind, payload: { taskId } };
    }
    case "handoff_reassign": {
      const handoffId = typeof raw.handoffId === "string" ? ctx.db.normalizeId("handoffs", raw.handoffId) : null;
      if (handoffId === null) return refuse(HANDOFF_WORDS.gone);
      const note = has("note") ? lines(raw.note, MAX_HANDOFF_NOTE) : "";
      return {
        kind,
        payload: {
          handoffId,
          to: line(raw.to, 254, HANDOFF_WORDS.unknownPerson),
          ...(note === "" ? null : { note }),
        },
      };
    }
  }
}

/** Text a deal would store, refused when it holds an email address or a phone number. */
function noContact(text: string): string {
  return looksLikeContactDetail(text) ? refuse(NO_CONTACT_DETAILS) : text;
}

const INTEL_KEYS = ["summary", "fit", "ehr", "billingModel", "ownership", "angle", "nextBestAction", "signals"];

/** A proposed deal's intel as the intel editor takes it: each signal said to come from the proposer. */
export function intelEditOf(intel: DealIntelAsk, by: string): IntelEdit {
  const { fit, signals, ...rest } = intel;
  return {
    ...rest,
    ...(fit === undefined ? null : { fit: fit === null ? null : { score: fit, reasons: [] } }),
    ...(signals === undefined ? null : { signals: signals.map((signal) => ({ ...signal, source: `Proposed by ${by}` })) }),
  };
}

function intelIn(value: unknown): DealIntelAsk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse(PROPOSAL_WORDS.payload);
  const raw = value as Raw;
  if (Object.keys(raw).some((key) => !INTEL_KEYS.includes(key))) return refuse(PROPOSAL_WORDS.payload);
  const intel: DealIntelAsk = {};
  for (const key of ["summary", "ehr", "billingModel", "ownership", "angle", "nextBestAction"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") return refuse(PROPOSAL_WORDS.payload);
    intel[key] = noContact(raw[key]);
  }
  if (intel.summary !== undefined && intel.summary.trim().length > MAX_DEAL_INTEL_SUMMARY) refuse(PROPOSAL_WORDS.tooLong);
  if (raw.fit !== undefined) {
    if (raw.fit !== null && typeof raw.fit !== "number") return refuse(PROPOSAL_WORDS.payload);
    intel.fit = raw.fit;
  }
  if (raw.signals !== undefined) {
    if (!Array.isArray(raw.signals) || raw.signals.length > MAX_DEAL_INTEL_SIGNALS) return refuse(PROPOSAL_WORDS.payload);
    intel.signals = raw.signals.map((signal: unknown) => {
      if (typeof signal !== "object" || signal === null) return refuse(PROPOSAL_WORDS.payload);
      const { date, kind, text, ...extra } = signal as Raw;
      if (Object.keys(extra).length > 0 || typeof kind !== "string" || typeof text !== "string") {
        return refuse(PROPOSAL_WORDS.payload);
      }
      if (date !== undefined && typeof date !== "string") return refuse(PROPOSAL_WORDS.payload);
      return { ...(date === undefined ? null : { date }), kind, text: noContact(text) };
    });
  }
  // Held to the intel editor's own rules now, so a bad field is refused when proposed, not at the click.
  const cleaned = cleanIntelEdit(intelEditOf(intel, "a proposal"));
  if (!cleaned.ok) refuse(cleaned.problem);
  return intel;
}

/** A proposed new deal: the card's fields, a US deal's details and intel, each held to the board's rules. */
function dealCreateIn(raw: Raw, has: (key: string) => boolean): DealCreate {
  const name = noContact(line(raw.name, MAX_NAME_LENGTH, PROPOSAL_WORDS.title));
  if (has("stage") && !(DEAL_CREATE_STAGES as readonly unknown[]).includes(raw.stage)) refuse(DEAL_CREATE_WORDS.stage);
  const count = (value: unknown) =>
    value === null || value === undefined ? undefined : typeof value === "number" ? value : refuse(PROPOSAL_WORDS.payload);
  const amount = count(raw.amount);
  const physicians = count(raw.physicians);
  const locations = count(raw.locations);
  if (has("priority") && !isDealPriority(raw.priority)) refuse(PROPOSAL_WORDS.payload);
  if (has("sources") && (!Array.isArray(raw.sources) || raw.sources.length > MAX_DEAL_CREATE_SOURCES)) {
    refuse(PROPOSAL_WORDS.payload);
  }
  const sources = has("sources")
    ? (raw.sources as unknown[]).map((source) => noContact(line(source, MAX_TITLE_LENGTH, PROPOSAL_WORDS.title)))
    : undefined;
  const region = has("region") ? noContact(line(raw.region, 40, PROPOSAL_WORDS.payload)) : undefined;
  // The board's own cleaning of a US deal's details, so a bad one is refused now.
  cleanDealDetails({ priority: raw.priority as DealPriority | undefined, region, physicians, locations, sources });
  return {
    name,
    ...(has("stage") ? { stage: raw.stage as string } : null),
    ...(has("contact") ? { contact: noContact(line(raw.contact, MAX_NAME_LENGTH, PROPOSAL_WORDS.payload)) } : null),
    ...(amount === undefined ? null : { amount }),
    ...(region === undefined ? null : { region }),
    ...(physicians === undefined ? null : { physicians }),
    ...(locations === undefined ? null : { locations }),
    ...(has("priority") ? { priority: raw.priority as DealPriority } : null),
    ...(sources === undefined ? null : { sources }),
    ...(has("intel") ? { intel: intelIn(raw.intel) } : null),
    ...(has("nextStep") ? { nextStep: noContact(line(raw.nextStep, MAX_NEXT_STEP_LENGTH, PROPOSAL_WORDS.nextStep)) } : null),
  };
}

/**
 * At the click: a deal of that market whose name is this one's (archived and
 * mirrored ones included), other than one the proposal was forced past
 * (`duplicateOf`), so two approvals never make one deal twice. When it is
 * proposed the shared near-duplicate check asks the same (convex/lib/duplicates.ts).
 */
async function refuseDuplicateDeal(ctx: QueryCtx, company: CompanyId, name: string, forcedPast: readonly string[]) {
  const key = dealNameKey(name);
  const same = (
    await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", company))
      .collect()
  ).find((deal) => dealNameKey(deal.name) === key && !forcedPast.includes(deal._id));
  if (same !== undefined) refuse(DEAL_CREATE_WORDS.duplicateDeal(same._id));
}

function aboutIn(value: unknown): NonNullable<Draft["about"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse(PROPOSAL_WORDS.payload);
  }
  const { type, id, ...rest } = value as Raw;
  if (Object.keys(rest).length > 0 || !(DRAFT_ABOUT as readonly unknown[]).includes(type)) {
    return refuse(PROPOSAL_WORDS.payload);
  }
  if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 64)) {
    return refuse(PROPOSAL_WORDS.aboutGone);
  }
  return { type: type as DraftAbout, ...(id === undefined ? null : { id }) };
}

/**
 * Refuse an address a task of this company cannot be given to, without saying
 * whose. A bot assignee only where `mayGiveBot` (the owner's own proposal, or
 * the owner approving), and in the same words whether or not that bot exists.
 */
async function requireAssignable(
  ctx: QueryCtx,
  member: Member,
  email: string,
  company: CompanyId | undefined,
  mayGiveBot: boolean,
) {
  if (taskAssigneeBot(email) !== null) {
    const ok = mayGiveToBot(member, mayGiveBot) && (await botAssignee(ctx, member, email, company)) !== null;
    if (!ok) refuse(PROPOSAL_WORDS.cannotAssign);
    return;
  }
  const people = await assignablePeople(ctx, member, company, { work: true });
  if (!people.some((person) => person.email === email)) refuse(PROPOSAL_WORDS.cannotAssign);
}

/**
 * Whether a payload still applies to what is there **now**: the task exists
 * and is this company's or shared; the person may be given it; the deal is on
 * the board, in this market; what a draft is about exists. Asked when it is
 * proposed and again when the owner approves it.
 */
export async function checkLive(
  ctx: QueryCtx,
  member: Member,
  company: CompanyId,
  shaped: Shaped,
  /**
   * Whether a bot may be the assignee: never when a bot files it, so a bot
   * cannot give work to a bot; when the owner's own agent files it, or the
   * owner approves (only the owner approves).
   */
  mayGiveBot: boolean,
): Promise<void> {
  switch (shaped.kind) {
    case "task_create": {
      const { assignee } = shaped.payload;
      if (assignee !== undefined) await requireAssignable(ctx, member, assignee, company, mayGiveBot);
      return;
    }
    case "task_change": {
      const task = await ctx.db.get(shaped.payload.taskId);
      if (task === null) return refuse(PROPOSAL_WORDS.taskGone);
      if (task.company !== undefined && task.company !== company) {
        return refuse(PROPOSAL_WORDS.taskElsewhere);
      }
      const { assignee } = shaped.payload;
      if (assignee != null) await requireAssignable(ctx, member, assignee, task.company, mayGiveBot);
      return;
    }
    case "deal_next_step": {
      const deal = await ctx.db.get(shaped.payload.dealId);
      if (deal === null || deal.archivedAt !== undefined) return refuse(PROPOSAL_WORDS.dealGone);
      if (deal.market !== company) return refuse(PROPOSAL_WORDS.dealElsewhere);
      return;
    }
    case "draft": {
      const about = shaped.payload.about;
      if (about === undefined || about.id === undefined) return;
      if (!(await aboutExists(ctx, member, about.type, about.id))) refuse(PROPOSAL_WORDS.aboutGone);
      return;
    }
    case "decision_record": {
      const { ownerEmail, meetingId } = shaped.payload;
      if (ownerEmail !== undefined) {
        const people = await assignablePeople(ctx, member, company);
        if (!people.some((person) => person.email === ownerEmail)) refuse(PROPOSAL_WORDS.cannotOwn);
      }
      if (meetingId !== undefined) {
        const meeting = await ctx.db.get(meetingId);
        if (meeting === null) return refuse(PROPOSAL_WORDS.meetingGone);
        if (meeting.company !== company) return refuse(PROPOSAL_WORDS.meetingElsewhere);
      }
      return;
    }
    case "goal_create":
      // The quarter is checked by its shape; the goals page's own function checks it again,
      // and the owner, bot, target and due day are checked as the page checks them.
      await checkGoalDetails(ctx, member, company, shaped.payload);
      return;
    case "goal_update": {
      const goal = await ctx.db.get(shaped.payload.goalId);
      if (goal === null) return refuse(PROPOSAL_WORDS.goalGone);
      // A goal of both companies may be changed from either; one company's only from its own.
      if (goal.company !== undefined && goal.company !== company) return refuse(PROPOSAL_WORDS.goalElsewhere);
      await checkGoalDetails(ctx, member, goal.company, shaped.payload);
      return;
    }
    case "deal_create": {
      const { intel, region, physicians, locations, priority, sources } = shaped.payload;
      const usOnly = [intel, region, physicians, locations, priority, sources].some((field) => field !== undefined);
      if (company !== "us" && usOnly) refuse(DEAL_CREATE_WORDS.usOnly);
      // Its name: by the near-duplicate check when proposed, and at the click by `refuseDuplicateDeal`.
      return;
    }
    case "bot_permission": {
      // The bot is still the owner's and on, and does not hold that level already.
      const bot = await botNamed(ctx, member.user._id, shaped.payload.bot);
      if (bot === null) return refuse(BOT_WORDS.gone);
      const refusal = botLevelRefusal(bot, shaped.payload.area, shaped.payload.level);
      if (refusal !== null) return refuse(refusal);
      return;
    }
    case "memory_note":
      return;
    case "comment": {
      const target = await commentTarget(ctx, member, shaped.payload.subjectKind, shaped.payload.subjectId);
      if (target === null) return refuse(COMMENT_WORDS.gone);
      if (target.company !== undefined && target.company !== company) return refuse(PROPOSAL_WORDS.commentElsewhere);
      return;
    }
    case "task_archive": {
      const task = await ctx.db.get(shaped.payload.taskId);
      if (task === null) return refuse(PROPOSAL_WORDS.taskGone);
      if (task.archivedAt !== undefined) return refuse(PROPOSAL_WORDS.taskArchived);
      if (task.company !== undefined && task.company !== company) return refuse(PROPOSAL_WORDS.taskElsewhere);
      return;
    }
    case "handoff_reassign": {
      const prepared = await prepareReassign(ctx, member, {
        id: shaped.payload.handoffId,
        to: shaped.payload.to,
        note: shaped.payload.note,
      });
      if (prepared.row.company !== company) return refuse(PROPOSAL_WORDS.handoffElsewhere);
      return;
    }
  }
}

async function aboutExists(ctx: QueryCtx, member: Member, type: DraftAbout, id: string) {
  switch (type) {
    case "deal": {
      const dealId = ctx.db.normalizeId("deals", id);
      const deal = dealId === null ? null : await ctx.db.get(dealId);
      return deal !== null && deal.archivedAt === undefined;
    }
    case "investor": {
      const investorId = ctx.db.normalizeId("investors", id);
      const investor = investorId === null ? null : await ctx.db.get(investorId);
      return investor !== null && investor.archivedAt === undefined;
    }
    case "customer":
      // Through the one function that reads the register (convex/customers.ts).
      return (await customersFor(ctx, member)).customers.some((clinic) => clinic.id === id);
    case "update":
      // The investor update names no row.
      return false;
  }
}

// ── Proposing ───────────────────────────────────────────────────────────────

export type ProposeInput = {
  agent: AgentId;
  /** The bot profile that proposes it, when a bot does (a slug). */
  bot?: string;
  company: CompanyId;
  kind: ProposalKind;
  /** Why it should be done: one sentence, required (stored as the row's `reason`). */
  reason: string;
  dedupeKey: string;
  payload: Raw;
  /** How soon it wants the owner; `normal` when left out. */
  urgency?: string;
  /** The goal it serves, by id: one of this company's goals (or both companies'). */
  goalId?: string;
  /** Its evidence: a row of this company (or a metric key). */
  source?: { kind: string; id: string };
  /** Past a near-duplicate refusal: made anyway, with the proposer's reason it differs (convex/lib/duplicates.ts). */
  force?: boolean;
  forceReason?: string;
  /** Which tool it came through, for the duplicate check's log: `propose` when left out. */
  via?: "propose" | "goal_create" | "goal_update";
};

/**
 * The proposer a dedupeKey names: its first segment, with a `bot-` before a
 * bot's id taken off. `bot-growth:task_create:x` and `growth:task_create:x`
 * both name growth.
 */
export function keyProposer(dedupeKey: string): { head: string; id: string } {
  const head = dedupeKey.split(":")[0] ?? "";
  return { head, id: head.startsWith("bot-") ? head.slice("bot-".length) : head };
}

/**
 * Attribution (Bot Loop v3, A): a key whose prefix names a known proposer
 * (one of the four, or a profile the owner keeps) other than the caller is
 * refused as `attribution_mismatch {expected, got}`, so a proposal is never
 * filed under one bot while its key says another made it. A prefix that names
 * no one Startup OS knows is left alone. Both ids are the server's: the caller
 * as the endpoint matched it, the prefix only once it matched a known one.
 */
async function refuseMisattributed(ctx: QueryCtx, member: Member, dedupeKey: string, who: { agent: AgentId; bot?: string }) {
  const caller = who.bot ?? who.agent;
  const { head, id } = keyProposer(dedupeKey);
  if (head === caller || id === caller || head === `bot-${caller}`) return;
  const known = isAgentId(id) || (isBotId(id) && (await botNamed(ctx, member.user._id, id)) !== null);
  if (!known) return;
  throw new ConvexError({
    words: PROPOSAL_WORDS.attribution,
    refusal: { code: "attribution_mismatch", expected: caller, got: id },
  });
}

const urgencyIn = (value: string | undefined): Urgency =>
  value === undefined
    ? DEFAULT_URGENCY
    : (URGENCIES as readonly string[]).includes(value)
      ? (value as Urgency)
      : refuse(PROPOSAL_WORDS.urgency);

/** A goal id that is one of this company's goals, or both companies'; anything else is refused. */
async function goalIn(ctx: QueryCtx, company: CompanyId, value: string): Promise<Id<"goals">> {
  const id = ctx.db.normalizeId("goals", value);
  const goal = id === null ? null : await ctx.db.get(id);
  if (goal === null || (goal.company !== undefined && goal.company !== company)) return refuse(PROPOSAL_WORDS.goalLink);
  return goal._id;
}

/**
 * A source that exists for this company: a deal in its market, a meeting's
 * notes, a task of its board (or shared), a decision of its memory, or a
 * metric the registry declares. Anything else reads as one that is not there.
 */
async function sourceIn(
  ctx: QueryCtx,
  company: CompanyId,
  value: { kind: string; id: string },
): Promise<{ kind: SourceKind; id: string }> {
  if (!(SOURCE_KINDS as readonly string[]).includes(value.kind)) return refuse(PROPOSAL_WORDS.sourceKind);
  const kind = value.kind as SourceKind;
  const id = value.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return refuse(PROPOSAL_WORDS.sourceGone);
  const exists = await (async () => {
    switch (kind) {
      case "deal": {
        const dealId = ctx.db.normalizeId("deals", id);
        const deal = dealId === null ? null : await ctx.db.get(dealId);
        return deal !== null && deal.archivedAt === undefined && deal.market === company;
      }
      case "meeting":
      case "note": {
        const meetingId = ctx.db.normalizeId("meetingNotes", id);
        const meeting = meetingId === null ? null : await ctx.db.get(meetingId);
        return meeting !== null && meeting.company === company;
      }
      case "task": {
        const taskId = ctx.db.normalizeId("tasks", id);
        const task = taskId === null ? null : await ctx.db.get(taskId);
        return task !== null && (task.company === undefined || task.company === company);
      }
      case "decision": {
        const decisionId = ctx.db.normalizeId("decisions", id);
        const decision = decisionId === null ? null : await ctx.db.get(decisionId);
        return decision !== null && decision.company === company;
      }
      case "metric":
        return METRICS.some((metric) => metric.key === id);
    }
  })();
  if (!exists) refuse(PROPOSAL_WORDS.sourceGone);
  return { kind, id };
}

/** Proposals with this key filed by this `bot` (absent: the four's, which carry none). */
async function sameKey(ctx: QueryCtx, dedupeKey: string, bot: string | undefined) {
  return await ctx.db
    .query("proposals")
    .withIndex("by_dedupeKey_and_bot_and_createdAt", (q) => q.eq("dedupeKey", dedupeKey).eq("bot", bot))
    .order("desc")
    .take(50);
}

/**
 * Refuse a key that is open, or that the owner decided lately: the model is
 * told it is a repeat. A key is the proposer's own: a bot's rows, or one of
 * the four's (a bot's are filed under the chief of staff but are not its), so
 * a bot cannot block an internal agent by proposing its key first. A decision
 * from before `bot` was stamped is still that proposer's (`legacyProposer`),
 * so the same key is refused after it too.
 */
async function refuseRepeat(ctx: QueryCtx, dedupeKey: string, who: { agent: AgentId; bot?: string }, now: number) {
  const stamped = await sameKey(ctx, dedupeKey, who.bot);
  const profiles = who.bot === undefined ? null : await proposerProfiles(ctx);
  const earlier =
    who.bot === undefined || profiles === null
      ? []
      : (await sameKey(ctx, dedupeKey, undefined)).filter((row) => legacyProposer(row, profiles) === who.bot);
  const same = [...stamped, ...earlier].filter((row) => who.bot !== undefined || row.agent === who.agent);
  const within = (row: Row, days: number) => now - (row.decidedAt ?? 0) < days * DAY_MS;
  if (same.some((row) => row.status === "open")) refuse(PROPOSAL_WORDS.repeatOpen);
  if (same.some((row) => row.status === "dismissed" && within(row, DISMISSED_BLOCKS_DAYS))) {
    refuse(PROPOSAL_WORDS.repeatDismissed);
  }
  // A proposal that expired undecided blocks its key as a dismissal does.
  if (same.some((row) => row.status === "expired" && within(row, DISMISSED_BLOCKS_DAYS))) {
    refuse(PROPOSAL_WORDS.repeatExpired);
  }
  const approved = (row: Row) => row.status === "approved" || row.status === "auto_approved";
  if (same.some((row) => approved(row) && within(row, APPROVED_BLOCKS_DAYS))) {
    refuse(PROPOSAL_WORDS.repeatApproved);
  }
  // A withdrawn key is released at once (spec §14), unless its proposer said it was wrong.
  const wrong = (row: Row) => row.status === "withdrawn" && row.withdrawReason === "wrong";
  if (same.some((row) => wrong(row) && within(row, WRONG_WITHDRAW_BLOCKS_DAYS))) {
    refuse(PROPOSAL_WORDS.repeatWithdrawnWrong);
  }
}

/**
 * Put one proposal in front of the owner. In order: the agent is on; the
 * payload is its kind's; the reason and the key are well formed; the key is
 * not a repeat; the agent and the day have room; the payload applies to the
 * live data. Then it is stored open, and nothing else happens.
 */
export async function propose(
  ctx: MutationCtx,
  member: Member,
  input: ProposeInput,
  /** `caller`: the credential it came through (the endpoint's), for earned autonomy's `boundToBot`. */
  clock: { now: number; caller?: ProposalCaller | null | undefined },
) {
  await requireAgentOn(ctx, input.agent);
  if (input.bot !== undefined && !isBotId(input.bot)) refuse(PROPOSAL_WORDS.botId);
  const shaped = shapeOf(ctx, input.kind, input.payload);
  if (input.reason.trim().length > MAX_REASON_LENGTH) refuse(PROPOSAL_WORDS.tooLong);
  const reason = cleanLine(input.reason, MAX_REASON_LENGTH);
  if (reason === "") refuse(PROPOSAL_WORDS.why);
  const urgency = urgencyIn(input.urgency);
  const { dedupeKey } = input;
  if (dedupeKey.length > MAX_DEDUPE_KEY_LENGTH || !DEDUPE_KEY.test(dedupeKey)) {
    refuse(PROPOSAL_WORDS.dedupeKey);
  }
  // A bot asks for its own permission only: never another bot's, never one of the four.
  if (shaped.kind === "bot_permission" && (input.bot === undefined || shaped.payload.bot !== input.bot)) {
    refuse(BOT_PERMISSION_WORDS.botsOnly);
  }
  await refuseMisattributed(ctx, member, dedupeKey, input);
  await refuseRepeat(ctx, dedupeKey, input, clock.now);

  // A bot's proposals are its own bucket: its open ones and its day's, from
  // its profile. The four's are theirs: a bot's rows are not counted in them.
  const dayStart = clock.now - (clock.now % DAY_MS);
  if (input.bot !== undefined) {
    const bot = input.bot;
    const perDay = (await botNamed(ctx, member.user._id, bot))?.limits.proposalsPerDay ?? DEFAULT_BOT_LIMITS.proposalsPerDay;
    const open = await ctx.db
      .query("proposals")
      .withIndex("by_bot_and_status", (q) => q.eq("bot", bot).eq("status", "open"))
      .take(MAX_OPEN_PER_BOT);
    if (open.length >= MAX_OPEN_PER_BOT) refuse(PROPOSAL_WORDS.tooManyOpenBot);
    const today = await ctx.db
      .query("proposals")
      .withIndex("by_bot_and_createdAt", (q) => q.eq("bot", bot).gte("createdAt", dayStart))
      .take(perDay);
    if (today.length >= perDay) refuse(PROPOSAL_WORDS.tooManyTodayBot(perDay));
  } else {
    const open = await ctx.db
      .query("proposals")
      .withIndex("by_agent_and_status_and_bot", (q) => q.eq("agent", input.agent).eq("status", "open").eq("bot", undefined))
      .take(MAX_OPEN_PER_AGENT);
    if (open.length >= MAX_OPEN_PER_AGENT) refuse(PROPOSAL_WORDS.tooManyOpen);
    const today = await ctx.db
      .query("proposals")
      .withIndex("by_bot_and_createdAt", (q) => q.eq("bot", undefined).gte("createdAt", dayStart))
      .take(MAX_PROPOSALS_PER_DAY);
    if (today.length >= MAX_PROPOSALS_PER_DAY) refuse(PROPOSAL_WORDS.tooManyToday);
  }

  await checkLive(ctx, member, input.company, shaped, input.bot === undefined);
  // After the payload's own checks, so a goal_update of the other company's goal says so in its own words.
  const goalId = input.goalId === undefined ? undefined : await goalIn(ctx, input.company, input.goalId);
  const source = input.source === undefined ? undefined : await sourceIn(ctx, input.company, input.source);
  // Near-duplicates (Bot Loop v3, B): of every kind but a bot's own permission
  // request. A new deal (C) is also compared with its market's deals by name,
  // and logged as deal_create's.
  const duplicate =
    shaped.kind === "bot_permission"
      ? null
      : await checkDuplicates(ctx, {
          tool: input.via ?? (shaped.kind === "deal_create" ? "deal_create" : "propose"),
          company: input.company,
          title: proposalTitle(shaped.payload as Record<string, unknown>),
          links: linksOfProposal({ payload: shaped.payload as Record<string, unknown>, goalId, source }),
          ...(shaped.kind === "deal_create" ? { dealName: shaped.payload.name } : null),
          now: clock.now,
          force: input.force,
          forceReason: input.forceReason,
          // A bot is never told an open proposal's title or id (convex/lib/duplicates.ts),
          // except its own, as `withdrawHint` (spec §14).
          view: await duplicateViewFor(ctx, member.user._id, input.bot),
          proposer: { bot: input.bot, agent: input.agent },
        });
  const id = await ctx.db.insert("proposals", {
    agent: input.agent,
    ...(input.bot === undefined ? null : { bot: input.bot }),
    kind: shaped.kind,
    company: input.company,
    reason,
    payload: shaped.payload,
    dedupeKey,
    status: "open",
    createdAt: clock.now,
    editedBeforeApprove: false,
    urgency,
    ...(goalId === undefined ? null : { goalId }),
    ...(source === undefined ? null : { source }),
    ...(duplicate === null ? null : { duplicateOf: duplicate.duplicateOf, forceReason: duplicate.forceReason }),
  });
  // Earned autonomy (convex/lib/trust.ts): a granted kind runs the one approve path at once.
  if (await grantCovers(ctx, member, input, clock.caller)) {
    return {
      id,
      proposed: true,
      autoApproved: await approveProposal(ctx, member, id, { now: clock.now, decision: "auto_approved" }),
    };
  }
  return { id, proposed: true };
}

function openOf(ctx: QueryCtx, company: CompanyId) {
  return ctx.db
    .query("proposals")
    .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", "open"))
    .take(AGENT_IDS.length * MAX_OPEN_PER_AGENT + MAX_BOTS * MAX_OPEN_PER_BOT);
}

/** What is open, oldest first, as the agent that made it is shown it. */
export async function openProposals(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const rows = [];
  for (const company of companies) rows.push(...(await openOf(ctx, company)));
  return rows.map((row) => ({
    id: row._id,
    agent: row.agent,
    kind: row.kind,
    company: row.company,
    reason: row.reason,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    payload: row.payload,
  }));
}

/**
 * Newest decisions a feedback read scans on `by_decidedAt`. A bot's stamped
 * rows come from its own index, so this only has to cover proposals filed
 * before `bot` was stamped, and the four's, which never carry it.
 */
const DECIDED_SCAN = 400;

/** Bot profiles the owner keeps, by id: at most `MAX_BOTS` exist. */
async function proposerProfiles(ctx: QueryCtx): Promise<Set<string>> {
  const bots = await ctx.db.query("bots").take(MAX_BOTS);
  return new Set(bots.map((bot) => bot.botId));
}

/**
 * Who filed a proposal that has no `bot`. The dedupeKey's first part, when it
 * names one of the four or a bot profile; otherwise the agent it was stored
 * under. A `growth:…` key filed under the chief of staff is growth's once
 * that profile exists. A `cs:…` key names no profile, so it stays the chief
 * of staff's, which is the agent it was filed under. Proposals decided before
 * attribution stamped `bot`, and every proposal of the four, are still that
 * proposer's.
 */
export function legacyProposer(row: { agent: string; dedupeKey: string }, profiles: ReadonlySet<string>): string {
  const { id } = keyProposer(row.dedupeKey);
  if (isAgentId(id) || profiles.has(id)) return id;
  return row.agent;
}

/** The latest decided proposals of these companies, newest decision first. */
async function decidedOf(
  ctx: QueryCtx,
  companies: readonly CompanyId[],
  count: number,
  keep: (row: Row) => boolean = () => true,
) {
  const rows = await ctx.db
    .query("proposals")
    .withIndex("by_decidedAt", (q) => q.gt("decidedAt", 0))
    .order("desc")
    .take(DECIDED_SCAN);
  return rows.filter((row) => companies.includes(row.company) && keep(row)).slice(0, count);
}

/** The owner's reason for a rejection: typed words, from either field (rows from before codes used `dismissReason`). */
const rejectReasonOf = (row: Row) => row.rejectReason ?? row.dismissReason ?? null;

/**
 * What became of the latest proposals, for a model to learn from. Each row
 * says the `decision` (approved, rejected, expired, auto_approved), the
 * owner's quick reason (`rejectCode`) and typed reason (`rejectReason`), the
 * fields the owner changed before approving (`edits`), how long it waited
 * (`decisionMs`), its `urgency` and its `goal`. **No payload and no reason of
 * the model's own.** A rejection also says, as `rejection`, the kind that was
 * rejected and the owner's reason, and `rejectedKinds` counts the rejections
 * by kind, so a model proposes less of a kind the owner keeps rejecting.
 *
 * `who` narrows it to one proposer. A bot sees its own rows only (stamped
 * with its id, and those it filed before `bot` was stamped:
 * `legacyProposer`). With no bot, the latest of every proposer, or one of
 * the four's own when `who.agent` is set. The tool passes a bot or nothing,
 * so the four and the owner's own Claude read every proposer's.
 */
export async function feedback(
  ctx: QueryCtx,
  companies: readonly CompanyId[],
  who: { bot?: string; agent?: AgentId } = {},
) {
  // A bot is told of its own proposals only, read by its own index (so the
  // latest of every proposer cannot crowd its rows out) plus the decisions
  // it filed before `bot` was stamped. One of the four and the owner's own
  // Claude are told of the latest of all.
  const decided =
    who.bot !== undefined
      ? (await decidedForBotRows(ctx, who.bot, 0)).filter((row) => companies.includes(row.company)).slice(0, FEEDBACK_ROWS)
      : await decidedOf(
          ctx,
          companies,
          FEEDBACK_ROWS,
          who.agent !== undefined ? (row: Row) => row.bot === undefined && row.agent === who.agent : () => true,
        );
  const titles = new Map<string, string | null>();
  const rows = [];
  for (const row of decided) {
    let goal = null;
    if (row.goalId !== undefined) {
      if (!titles.has(row.goalId)) titles.set(row.goalId, (await ctx.db.get(row.goalId))?.title ?? null);
      goal = { id: row.goalId, title: titles.get(row.goalId) ?? null };
    }
    const reason = rejectReasonOf(row);
    rows.push({
      agent: row.agent,
      bot: row.bot ?? null,
      kind: row.kind,
      company: row.company,
      dedupeKey: row.dedupeKey,
      status: row.status,
      decision: decisionOf(row.status),
      rejectCode: row.rejectCode ?? null,
      rejectReason: reason,
      /** Kept for readers from before: the owner's typed reason. */
      dismissReason: reason,
      decidedAt: row.decidedAt ?? null,
      decisionMs: row.decidedAt === undefined ? null : row.decidedAt - row.createdAt,
      edited: row.editedBeforeApprove,
      edits: row.edits ?? [],
      urgency: row.urgency ?? DEFAULT_URGENCY,
      goal,
      rejection:
        row.status === "dismissed" ? { kind: row.kind, code: row.rejectCode ?? null, reason } : null,
      createdId: createdIdOf(row),
      /** The owner, when `proposal_decide` carried it out; null for a click in the app. */
      decidedBy: row.decidedBy ?? null,
      /** `chief_of_staff` when that tool did; null otherwise. */
      via: row.decidedVia ?? null,
      /** The owner's words on an approval made that way; a dismissal's stay `rejectReason`. */
      decisionReason: row.decisionReason ?? null,
      ...withdrawalOf(row),
    });
  }
  const rejectedKinds: Partial<Record<ProposalKind, number>> = {};
  const withdrawnKinds: Partial<Record<ProposalKind, number>> = {};
  for (const row of rows) {
    if (row.rejection !== null) rejectedKinds[row.kind] = (rejectedKinds[row.kind] ?? 0) + 1;
    if (row.status === "withdrawn") withdrawnKinds[row.kind] = (withdrawnKinds[row.kind] ?? 0) + 1;
  }
  return { rows, rejectedKinds, withdrawnKinds };
}

/** A withdrawal as a proposer reads it back: why, its note, what replaced it (nulls for any other row). */
const withdrawalOf = (row: Row) => ({
  withdrawReason: row.withdrawReason ?? null,
  withdrawNote: row.withdrawNote ?? null,
  replacedBy: row.replacedBy ?? null,
});

/** What approving a kind that makes something made (a task, a deal, a decision, a goal), by id: null for any other. */
export function createdIdOf(row: Pick<Row, "kind" | "result">): string | null {
  const result = row.result;
  if (result === undefined) return null;
  switch (row.kind) {
    case "task_create":
      return "taskId" in result ? result.taskId : null;
    case "deal_create":
      return "dealId" in result ? result.dealId : null;
    case "decision_record":
      return "decisionId" in result ? result.decisionId : null;
    case "goal_create":
      return "goalId" in result ? result.goalId : null;
    case "memory_note":
      return "noteId" in result ? result.noteId : null;
    case "comment":
      return "commentId" in result ? result.commentId : null;
    case "task_archive":
      return "taskId" in result ? result.taskId : null;
    case "handoff_reassign":
      return "handoffId" in result ? result.handoffId : null;
    default:
      return null;
  }
}

/**
 * A bot's decided proposals since a moment, newest decision first (100 of
 * each outcome at most). Rows stamped with `bot` come from that index.
 * Rows with no `bot` — the four's, and anything decided before attribution
 * stamped it — are that proposer's too (`legacyProposer`), read from the
 * newest decisions, so a dismissal on Oct 19 is not missing from the history
 * `rejectedKinds` is counted from.
 */
async function decidedForBotRows(ctx: QueryCtx, bot: string, since: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (const status of ["approved", "auto_approved", "dismissed", "expired", "withdrawn"] as const) {
    rows.push(
      ...(await ctx.db
        .query("proposals")
        .withIndex("by_bot_and_status", (q) => q.eq("bot", bot).eq("status", status))
        .order("desc")
        .take(100)),
    );
  }
  const profiles = await proposerProfiles(ctx);
  const seen = new Set(rows.map((row) => row._id));
  const earlier = await ctx.db
    .query("proposals")
    .withIndex("by_decidedAt", (q) => q.gt("decidedAt", 0))
    .order("desc")
    .take(DECIDED_SCAN);
  for (const row of earlier) {
    if (seen.has(row._id) || row.bot !== undefined) continue;
    if (legacyProposer(row, profiles) !== bot) continue;
    rows.push(row);
  }
  return rows
    .filter((row) => (row.decidedAt ?? 0) >= since)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
}

/**
 * What `my_inbox` tells a bot of its own proposals decided since a moment:
 * kind, company, key, outcome, when, the owner's reason; a permission
 * request's area and level. No payload of the model's own.
 */
export async function decidedForBot(ctx: QueryCtx, bot: string, since: number) {
  return (await decidedForBotRows(ctx, bot, since)).slice(0, FEEDBACK_ROWS * 2).map((row) => ({
    id: row._id,
    kind: row.kind,
    company: row.company,
    dedupeKey: row.dedupeKey,
    status: row.status,
    decision: decisionOf(row.status),
    decidedAt: row.decidedAt ?? null,
    rejectCode: row.rejectCode ?? null,
    reason: rejectReasonOf(row),
    area: row.kind === "bot_permission" ? (row.payload as BotPermissionAsk).area : null,
    level: row.kind === "bot_permission" ? (row.payload as BotPermissionAsk).level : null,
    ...withdrawalOf(row),
  }));
}

/** Decided proposals one week's stats read at most. */
const STATS_ROWS = 2_000;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Each proposer's record since `since` (the page's clock: a week ago), for the
 * Bots tab: how many were decided, approved (by the owner or under granted
 * autonomy), rejected and expired, and how many it withdrew itself (counted
 * apart: not decided); the approval rate (approved of approved and rejected:
 * an expiry is nobody's decision and a withdrawal the proposer's own); the median time to a decision the
 * owner made; and the three commonest reasons for a rejection (a chip's code,
 * or `typed` for words alone). A bot is keyed `bot:<id>`, one of the four by its id.
 */
export async function proposerStats(ctx: QueryCtx, since: number) {
  const rows = await ctx.db
    .query("proposals")
    .withIndex("by_decidedAt", (q) => q.gte("decidedAt", since))
    .take(STATS_ROWS);
  const by = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.bot === undefined ? row.agent : `bot:${row.bot}`;
    by.set(key, [...(by.get(key) ?? []), row]);
  }
  return [...by.entries()]
    .map(([key, all]) => {
      // Withdrawn by its proposer (spec §14): counted apart, in no rate and not as decided.
      const list = all.filter((row) => row.status !== "withdrawn");
      const approved = list.filter((row) => row.status === "approved" || row.status === "auto_approved");
      const rejected = list.filter((row) => row.status === "dismissed");
      const reasons = new Map<RejectCode | "typed", number>();
      for (const row of rejected) {
        const code = row.rejectCode ?? (rejectReasonOf(row) === null ? null : "typed");
        if (code !== null) reasons.set(code, (reasons.get(code) ?? 0) + 1);
      }
      const owners = [...approved.filter((row) => row.status === "approved"), ...rejected];
      return {
        key,
        bot: all[0]!.bot ?? null,
        agent: all[0]!.agent,
        decided: list.length,
        withdrawn: all.length - list.length,
        approved: approved.length,
        rejected: rejected.length,
        expired: list.filter((row) => row.status === "expired").length,
        approvalRate:
          approved.length + rejected.length === 0 ? null : approved.length / (approved.length + rejected.length),
        medianDecisionMs: median(owners.map((row) => row.decidedAt! - row.createdAt)),
        topRejectReasons: [...reasons.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, 3)
          .map(([code, count]) => ({ code, count })),
      };
    })
    .sort((a, b) => b.decided - a.decided || (a.key < b.key ? -1 : 1));
}

// ── The owner's page ────────────────────────────────────────────────────────

/** What a proposal names, as it is now: null for what is gone or not named. */
async function aboutOf(ctx: QueryCtx, shaped: Shaped) {
  const person = async (email: string | null | undefined) =>
    email == null ? null : ((await nameOf(ctx.db, email)) ?? email);
  switch (shaped.kind) {
    case "task_create":
      return { task: null, deal: null, assignee: await person(shaped.payload.assignee) };
    case "task_change":
      return {
        task: (await ctx.db.get(shaped.payload.taskId))?.title ?? null,
        deal: null,
        assignee: await person(shaped.payload.assignee),
      };
    case "deal_next_step": {
      const deal = await ctx.db.get(shaped.payload.dealId);
      return {
        task: null,
        deal: deal === null || deal.archivedAt !== undefined ? null : deal.name,
        assignee: null,
      };
    }
    case "draft":
      return { task: null, deal: null, assignee: null };
    case "decision_record":
      // The decision's owner, by name where the owner of the OS knows it.
      return { task: null, deal: null, assignee: await person(shaped.payload.ownerEmail) };
    case "goal_create":
      return { task: null, deal: null, assignee: null };
    case "goal_update":
      // The goal's title as it is now sits where a task's would.
      return { task: (await ctx.db.get(shaped.payload.goalId))?.title ?? null, deal: null, assignee: null };
    case "bot_permission":
    case "deal_create":
    case "memory_note":
      return { task: null, deal: null, assignee: null };
    case "comment": {
      const { subjectKind, subjectId } = shaped.payload;
      if (subjectKind === "deal") {
        const id = ctx.db.normalizeId("deals", subjectId);
        const deal = id === null ? null : await ctx.db.get(id);
        return { task: null, deal: deal?.name ?? null, assignee: null };
      }
      const table = subjectKind === "task" ? "tasks" : "handoffs";
      const id = ctx.db.normalizeId(table, subjectId);
      const row = id === null ? null : await ctx.db.get(id);
      return { task: row?.title ?? null, deal: null, assignee: null };
    }
    case "task_archive":
      return { task: (await ctx.db.get(shaped.payload.taskId))?.title ?? null, deal: null, assignee: null };
    case "handoff_reassign": {
      const row = await ctx.db.get(shaped.payload.handoffId);
      const to = shaped.payload.to;
      return { task: row?.title ?? null, deal: null, assignee: to.includes("@") ? await person(to) : to };
    }
  }
}

/** A proposal as its card shows it while it is open. */
const shownOf = async (ctx: QueryCtx, row: Row) => ({
  id: row._id,
  agent: row.agent,
  kind: row.kind,
  company: row.company,
  reason: row.reason,
  createdAt: row.createdAt,
  payload: row.payload,
  about: await aboutOf(ctx, shapedOf(row)),
});

/** The goal a proposal serves, as it is now: null where it names none or the goal is gone. */
async function goalOf(ctx: QueryCtx, row: Row) {
  const goal = row.goalId === undefined ? null : await ctx.db.get(row.goalId);
  return goal === null
    ? null
    : { id: goal._id as string, title: goal.title, status: goal.status, cash: goal.cash === true };
}

/**
 * A proposal with what became of it, as the owner's history shows it (the
 * "Decided" tab on /approvals, and a card under a chat answer): who made it,
 * what it would do, why, the goal it served, and the decision with the
 * owner's reason, a withdrawal's reason and note, what the owner edited
 * first, and whether an automatic approval was flagged. Model text is data.
 */
export async function decidedRowOf(ctx: QueryCtx, row: Row) {
  return {
    ...(await shownOf(ctx, row)),
    source: "proposal" as const,
    bot: row.bot ?? null,
    why: row.reason,
    urgency: row.urgency ?? DEFAULT_URGENCY,
    goal: await goalOf(ctx, row),
    status: row.status,
    decidedAt: row.decidedAt ?? null,
    rejectCode: row.rejectCode ?? null,
    rejectReason: rejectReasonOf(row),
    result: row.result ?? null,
    edited: row.editedBeforeApprove,
    edits: row.edits ?? [],
    withdrawReason: row.withdrawReason ?? null,
    withdrawNote: row.withdrawNote ?? null,
    flagged: row.status === "auto_approved" && (row.rejectReason !== undefined || row.rejectCode !== undefined),
  };
}

/**
 * What became of the proposals of these companies decided at or after
 * `since` (a moment the page names: a query reads no clock), newest decision
 * first: approved, dismissed, expired, approved automatically and withdrawn.
 */
export async function decidedForOwner(ctx: QueryCtx, companies: readonly CompanyId[], since: number) {
  const rows = await ctx.db
    .query("proposals")
    .withIndex("by_decidedAt", (q) => q.gte("decidedAt", since))
    .order("desc")
    .take(DECIDED_ROWS);
  const out = [];
  for (const row of rows) if (companies.includes(row.company)) out.push(await decidedRowOf(ctx, row));
  return out;
}

/**
 * These proposals as cards, open or decided, in the order given: what a chat
 * answer shows under itself (convex/lib/chat.ts). One that is gone is left out.
 */
export async function cardsFor(ctx: QueryCtx, ids: readonly Id<"proposals">[]) {
  const cards = [];
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (row !== null) cards.push(await decidedRowOf(ctx, row));
  }
  return cards;
}

// ── The approvals inbox (/approvals) ────────────────────────────────────────

const COLUMN_WORDS: Record<Column, string> = {
  backlog: "Backlog",
  this_week: "This week",
  doing: "Doing",
  done: "Done",
};
const STATUS_WORDS: Record<GoalStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  done: "Done",
};

/** One field a proposal would change: as it is now, and as it would be. Null is "none". */
export type Change = { field: string; before: string | null; after: string | null };

/**
 * What approving would change, field by field, with each field as it is now:
 * known for a change to a task, a deal's next step and a change to a goal.
 * A kind that makes something new (or a target that is gone) has none: its
 * sentence says it all.
 */
async function changesOf(ctx: QueryCtx, shaped: Shaped): Promise<Change[]> {
  const person = async (email: string | null | undefined) =>
    email == null ? null : ((await nameOf(ctx.db, email)) ?? email);
  switch (shaped.kind) {
    case "task_change": {
      const task = await ctx.db.get(shaped.payload.taskId);
      if (task === null) return [];
      const { assignee, due, column } = shaped.payload;
      const changes: Change[] = [];
      if (assignee !== undefined) {
        changes.push({ field: "Assignee", before: await person(task.assignee), after: await person(assignee) });
      }
      if (due !== undefined) changes.push({ field: "Due", before: task.due ?? null, after: due });
      if (column !== undefined) {
        changes.push({ field: "Column", before: COLUMN_WORDS[task.column], after: COLUMN_WORDS[column] });
      }
      return changes;
    }
    case "deal_next_step": {
      const deal = await ctx.db.get(shaped.payload.dealId);
      if (deal === null) return [];
      return [{ field: "Next step", before: deal.nextStep ?? null, after: shaped.payload.nextStep }];
    }
    case "goal_update": {
      const goal = await ctx.db.get(shaped.payload.goalId);
      if (goal === null) return [];
      const { title, status, ownerEmail, ownerBot, target, dueOn } = shaped.payload;
      const person = async (email: string | null | undefined) =>
        email == null ? null : ((await nameOf(ctx.db, email)) ?? email);
      const detail = (field: string, before: string | null, after: string | null | undefined) =>
        after === undefined ? [] : [{ field, before, after }];
      return [
        ...(title === undefined ? [] : [{ field: "Title", before: goal.title, after: title }]),
        ...(status === undefined
          ? []
          : [{ field: "Status", before: STATUS_WORDS[goal.status], after: STATUS_WORDS[status] }]),
        ...(ownerEmail === undefined
          ? []
          : [{ field: "Owner", before: await person(goal.ownerEmail), after: await person(ownerEmail) }]),
        ...detail("Bot", goal.ownerBot ?? null, ownerBot),
        ...detail("Target", goal.target ?? null, target),
        ...detail("Due", goal.dueOn ?? null, dueOn),
      ];
    }
    case "bot_permission": {
      const { bot, area, level } = shaped.payload;
      const held = await ctx.db
        .query("bots")
        .withIndex("by_botId", (q) => q.eq("botId", bot))
        .first();
      const now = held === null ? "none" : levelOf(held.permissions, area);
      return [{ field: AREA_NAMES[area], before: LEVEL_WORDS[now], after: LEVEL_WORDS[level] }];
    }
    case "task_archive": {
      const task = await ctx.db.get(shaped.payload.taskId);
      if (task === null) return [];
      return [{ field: "Task", before: task.title, after: "Archived" }];
    }
    case "handoff_reassign": {
      const row = await ctx.db.get(shaped.payload.handoffId);
      if (row === null) return [];
      const before = row.toKind === "person" ? await person(row.to) : row.to;
      const after = shaped.payload.to.includes("@") ? await person(shaped.payload.to) : shaped.payload.to;
      return [
        { field: "To", before, after },
        ...(shaped.payload.note === undefined ? [] : [{ field: "Note", before: null, after: shaped.payload.note }]),
      ];
    }
    case "task_create":
    case "draft":
    case "decision_record":
    case "goal_create":
    case "deal_create":
    case "memory_note":
    case "comment":
      return [];
  }
}

const LEVEL_WORDS = { none: "None", read: "Read", write: "Write" } as const;

/**
 * What approving would do, worked out by the server from the payload and the
 * live rows, never written by the proposer: field by field before → after for
 * a change (a task, a deal's next step, a goal), every field it would set (from
 * nothing) for something new, and the full text of a draft.
 */
export type Effect = { changes: Change[]; text: { title: string; body: string } | null };

async function effectOf(ctx: QueryCtx, shaped: Shaped): Promise<Effect> {
  const person = async (email: string | null | undefined) =>
    email == null ? null : ((await nameOf(ctx.db, email)) ?? email);
  const set = (field: string, after: string | null | undefined): Change[] =>
    after == null || after === "" ? [] : [{ field, before: null, after }];
  switch (shaped.kind) {
    case "task_change":
    case "deal_next_step":
    case "goal_update":
      return { changes: await changesOf(ctx, shaped), text: null };
    case "task_create": {
      const { title, notes, assignee, due, column } = shaped.payload;
      return {
        changes: [
          ...set("Title", title),
          ...set("Assignee", await person(assignee)),
          ...set("Due", due),
          ...set("Column", column === undefined ? COLUMN_WORDS.backlog : COLUMN_WORDS[column]),
          ...set("Notes", notes),
        ],
        text: null,
      };
    }
    case "goal_create": {
      const { quarter, title, status, ownerEmail, ownerBot, target, dueOn } = shaped.payload;
      return {
        changes: [
          ...set("Title", title),
          ...set("Quarter", quarter),
          ...set("Status", STATUS_WORDS[status ?? "on_track"]),
          ...set("Owner", await person(ownerEmail)),
          ...set("Bot", ownerBot),
          ...set("Target", target),
          ...set("Due", dueOn),
        ],
        text: null,
      };
    }
    case "decision_record": {
      const { title, decision, context, ownerEmail, revisitOn } = shaped.payload;
      return {
        changes: [
          ...set("Title", title),
          ...set("Decision", decision),
          ...set("Context", context),
          ...set("Owner", await person(ownerEmail)),
          ...set("Revisit on", revisitOn),
        ],
        text: null,
      };
    }
    case "draft":
      return { changes: [], text: { title: shaped.payload.title, body: shaped.payload.body } };
    case "deal_create": {
      const { name, stage, contact, amount, region, priority, intel, nextStep } = shaped.payload;
      return {
        changes: [
          ...set("Name", name),
          ...set("Stage", stage ?? DEAL_CREATE_STAGES[0]),
          ...set("Contact", contact),
          ...set("Amount", amount == null ? null : amount.toLocaleString("en-US")),
          ...set("Region", region),
          ...set("Priority", priority),
          ...set("Next step", nextStep),
          ...set("Intel", intel?.summary),
        ],
        text: null,
      };
    }
    case "bot_permission":
      // The bot's level on that area, as it is now and as it would be.
      return { changes: await changesOf(ctx, shaped), text: null };
    case "memory_note":
      return { changes: [], text: { title: shaped.payload.title, body: shaped.payload.body } };
    case "comment":
      return { changes: [], text: { title: "Comment", body: shaped.payload.body } };
    case "task_archive":
    case "handoff_reassign":
      return { changes: await changesOf(ctx, shaped), text: null };
  }
}

/** Where a proposal's evidence is in the app, and what it is called now (null: it is gone). */
const SOURCE_PAGES: Record<SourceKind, string> = {
  deal: "/sales",
  meeting: "/memory",
  note: "/memory",
  task: "/board",
  decision: "/memory",
  metric: "/",
};

async function evidenceOf(ctx: QueryCtx, source: NonNullable<Row["source"]>) {
  const label = await (async () => {
    switch (source.kind) {
      case "deal": {
        const id = ctx.db.normalizeId("deals", source.id);
        return id === null ? null : ((await ctx.db.get(id))?.name ?? null);
      }
      case "meeting":
      case "note": {
        const id = ctx.db.normalizeId("meetingNotes", source.id);
        return id === null ? null : ((await ctx.db.get(id))?.title ?? null);
      }
      case "task": {
        const id = ctx.db.normalizeId("tasks", source.id);
        return id === null ? null : ((await ctx.db.get(id))?.title ?? null);
      }
      case "decision": {
        const id = ctx.db.normalizeId("decisions", source.id);
        return id === null ? null : ((await ctx.db.get(id))?.title ?? null);
      }
      case "metric":
        return METRICS.find((metric) => metric.key === source.id)?.label ?? null;
    }
  })();
  return { kind: source.kind, id: source.id, label, href: SOURCE_PAGES[source.kind] };
}

/**
 * Every open proposal of these companies as a row of the owner's approvals
 * inbox: its card's fields; `why`; the server's `effect`; its `urgency`; the
 * goal it serves as it is now (its status for the sort, `cash` for the pinned
 * section); its evidence; and what it would change, before and after.
 */
export async function inboxProposals(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const rows = [];
  // Pinned in "Cash and runway": the one reader the digest counts with too.
  const isCash = cashReader(ctx.db);
  for (const company of companies) {
    for (const row of await openOf(ctx, company)) {
      const shaped = shapedOf(row);
      rows.push({
        ...(await shownOf(ctx, row)),
        bot: row.bot ?? null,
        why: row.reason,
        urgency: row.urgency ?? DEFAULT_URGENCY,
        goal: await goalOf(ctx, row),
        evidence: row.source === undefined ? null : await evidenceOf(ctx, row.source),
        effect: await effectOf(ctx, shaped),
        changes: await changesOf(ctx, shaped),
        // Pinned in "Cash and runway" (convex/lib/cashGroup.ts).
        cash: await isCash(row),
        // Made with `force` past a near-duplicate check: what it was near, and the proposer's reason.
        duplicate:
          row.duplicateOf === undefined
            ? null
            : { of: await duplicateTitles(ctx, row.duplicateOf), reason: row.forceReason ?? null },
      });
    }
  }
  return rows;
}

/**
 * What a forced proposal was near, as its badge names them: each id's title
 * where it is still a task, proposal, handoff or deal, else a placeholder. At most three.
 */
async function duplicateTitles(ctx: QueryCtx, ids: readonly string[]): Promise<{ id: string; title: string }[]> {
  const out = [];
  for (const id of ids.slice(0, 3)) {
    let title: string | null = null;
    const task = ctx.db.normalizeId("tasks", id);
    const proposal = ctx.db.normalizeId("proposals", id);
    const handoff = ctx.db.normalizeId("handoffs", id);
    const deal = ctx.db.normalizeId("deals", id);
    if (task !== null) title = (await ctx.db.get(task))?.title ?? null;
    else if (handoff !== null) title = (await ctx.db.get(handoff))?.title ?? null;
    else if (deal !== null) title = (await ctx.db.get(deal))?.name ?? null;
    else if (proposal !== null) {
      const row = await ctx.db.get(proposal);
      title = row === null ? null : proposalTitle(row.payload as Record<string, unknown>) || "An open proposal";
    }
    out.push({ id, title: title ?? "Since closed" });
  }
  return out;
}

async function openRow(ctx: QueryCtx, id: Id<"proposals">): Promise<Row> {
  const row = await ctx.db.get(id);
  if (row === null) return refuse(PROPOSAL_WORDS.gone);
  if (row.status !== "open") return refuse(PROPOSAL_WORDS.decided);
  return row;
}

/** The owner's edit, as this proposal's kind: the task or deal it names stays the one proposed. */
function edited(ctx: QueryCtx, row: Row, edit: Raw): Shaped {
  const was = shapedOf(row);
  const now = shapeOf(ctx, row.kind, edit);
  if (
    (was.kind === "task_change" && now.kind === "task_change" && now.payload.taskId !== was.payload.taskId) ||
    (was.kind === "deal_next_step" && now.kind === "deal_next_step" && now.payload.dealId !== was.payload.dealId) ||
    (was.kind === "goal_update" && now.kind === "goal_update" && now.payload.goalId !== was.payload.goalId) ||
    (was.kind === "bot_permission" && now.kind === "bot_permission" && now.payload.bot !== was.payload.bot) ||
    (was.kind === "comment" &&
      now.kind === "comment" &&
      (now.payload.subjectKind !== was.payload.subjectKind || now.payload.subjectId !== was.payload.subjectId)) ||
    (was.kind === "task_archive" && now.kind === "task_archive" && now.payload.taskId !== was.payload.taskId) ||
    (was.kind === "handoff_reassign" && now.kind === "handoff_reassign" && now.payload.handoffId !== was.payload.handoffId)
  ) {
    refuse(PROPOSAL_WORDS.fixedField);
  }
  // What a draft is about is not on the form: it stays as proposed.
  if (was.kind === "draft" && now.kind === "draft") {
    const { about } = was.payload;
    return { kind: "draft", payload: { title: now.payload.title, body: now.payload.body, ...(about ? { about } : null) } };
  }
  // Nor is the meeting a decision was seen in: it stays as proposed.
  if (was.kind === "decision_record" && now.kind === "decision_record") {
    const { meetingId: _dropped, ...rest } = now.payload;
    const { meetingId } = was.payload;
    return { kind: "decision_record", payload: { ...rest, ...(meetingId ? { meetingId } : null) } };
  }
  return now;
}

/** A value as JSON with every object's keys in order: two payloads that say the same thing read the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

/** Do what a proposal says, as the owner, through the app's own function. */
async function carryOut(
  ctx: MutationCtx,
  member: Member,
  row: Row,
  shaped: Shaped,
  now: number,
): Promise<NonNullable<Row["result"]>> {
  const actor: NotificationActor = { type: "agent", userId: member.user._id };
  switch (shaped.kind) {
    case "task_create": {
      // The proposing bot, when a bot filed it. This is the one approve path
      // (`approveProposal`: the owner's click, auto-approval, and any decide
      // tool that calls it), so the card is attributed here and nowhere else.
      const taskId = await createTask(
        ctx,
        member,
        { ...shaped.payload, company: row.company },
        // Approved by the owner: the one way a bot's proposal gives work to a bot, and only one he edited in.
        { origin: agentTaskOrigin({ agent: row.agent, bot: row.bot }), announce: true, actor, mayGiveBot: true },
      );
      return { taskId };
    }
    case "task_change": {
      const { taskId, column, ...rest } = shaped.payload;
      if (column !== undefined && Object.keys(rest).length === 0) {
        // Only the column: what dragging the card does.
        await moveTask(ctx, member, { id: taskId, column, index: 0 }, { actor });
      } else {
        // One save, as the card's editor makes: whoever it concerns is told once.
        await updateTask(
          ctx,
          member,
          { id: taskId, ...rest, ...(column === undefined ? null : { column }) },
          { actor, mayGiveBot: true },
        );
      }
      return { taskId };
    }
    case "deal_next_step":
      await updateDeal(ctx, member, { id: shaped.payload.dealId, nextStep: shaped.payload.nextStep });
      return { dealId: shaped.payload.dealId };
    case "draft":
      // Text for the owner to send himself: nothing is sent, made or changed.
      return { kept: true };
    case "decision_record": {
      // Through the function `decisions.create` runs, as the owner, marked as the agent's.
      const { ownerEmail, ...rest } = shaped.payload;
      const decisionId = await createDecision(
        ctx,
        member,
        {
          ...rest,
          company: row.company,
          owner: ownerEmail ?? null,
          status: "decided",
          decidedOn: new Date(now - (now % DAY_MS)).toISOString().slice(0, 10),
        },
        { agent: row.agent },
      );
      return { decisionId };
    }
    case "goal_create": {
      // Through the function `goals.create` runs: the proposal's company, last in its quarter.
      const goalId = await createGoal(ctx, member, { ...shaped.payload, company: row.company });
      return { goalId };
    }
    case "goal_update": {
      // Through the function `goals.update` runs.
      const { goalId, ...rest } = shaped.payload;
      await updateGoal(ctx, member, { id: goalId, ...rest }, now);
      return { goalId };
    }
    case "deal_create": {
      // Through the function the Sales page's own create runs, in the
      // proposal's market (Kazakhstan's too: made here, never mirrored), said
      // to be the proposer's; its intel through the intel editor's own write.
      const { intel, ...card } = shaped.payload;
      const by = row.bot ?? row.agent;
      const dealId = await createDeal(
        ctx,
        member,
        {
          market: row.company,
          ...card,
          amount: card.amount ?? undefined,
          physicians: card.physicians ?? undefined,
          locations: card.locations ?? undefined,
        },
        { now, anyMarket: true, createdBy: by },
      );
      if (intel !== undefined) await attachIntel(ctx, dealId, intelEditOf(intel, by), now);
      return { dealId };
    }
    case "bot_permission": {
      // The owner's alone (approve is an ownerMutation): the same change the Bots tab makes.
      const bot = await botNamed(ctx, member.user._id, shaped.payload.bot);
      if (bot === null) return refuse(BOT_WORDS.gone);
      await setBotLevel(ctx, bot, shaped.payload.area, shaped.payload.level, now);
      return { botId: bot._id };
    }
    case "memory_note": {
      const by = row.bot ?? row.agent;
      const noteId = await createNote(ctx, member, { company: row.company, ...shaped.payload }, { now, by });
      return { noteId };
    }
    case "comment": {
      const by = row.bot ?? row.agent;
      const { commentId } = await addComment(ctx, member, shaped.payload, { now, by, areas: member.areas });
      return { commentId };
    }
    case "task_archive": {
      await archiveTask(ctx, member, shaped.payload.taskId, now);
      return { taskId: shaped.payload.taskId };
    }
    case "handoff_reassign": {
      const by = row.bot ?? row.agent;
      await reassignHandoff(
        ctx,
        member,
        { id: shaped.payload.handoffId, to: shaped.payload.to, note: shaped.payload.note },
        now,
        by,
      );
      return { handoffId: shaped.payload.handoffId };
    }
  }
}

/** A payload's field as the card shows it: text as it is, nothing as null, anything else as JSON. */
const fieldText = (value: unknown): string | null =>
  value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);

/** What the owner changed before approving, field by field, in the payload's own field names. */
export function editsOf(proposed: Raw, approved: Raw): { field: string; before: string | null; after: string | null }[] {
  const fields = [...new Set([...Object.keys(proposed), ...Object.keys(approved)])];
  return fields
    .map((field) => ({ field, before: fieldText(proposed[field]), after: fieldText(approved[field]) }))
    .filter((edit) => canonical(edit.before) !== canonical(edit.after));
}

export type ApproveOptions = {
  /** The clock, read by the caller. */
  now: number;
  /** The owner's edit of the payload, the whole payload of the same kind; left out, it is approved as proposed. */
  edit?: Raw;
  /**
   * `approved` for the owner's click (the default); `auto_approved` when the
   * earned-autonomy path carries it out at once under a grant the owner gave.
   * Either way it runs exactly this path: checked live, carried out as the owner.
   */
  decision?: "approved" | "auto_approved";
  /**
   * Set by `proposal_decide`: the owner decided in chat with the chief of staff.
   * Stored on the row and returned by `proposals_feedback`. The button leaves it out.
   */
  via?: "chief_of_staff";
  /** The owner's words for an approval made that way (already cleaned, within the limit). */
  reason?: string;
};

/** What `proposal_decide` writes beside the decision, so feedback can say who. */
const CHIEF_ATTRIBUTION = { decidedBy: "owner" as const, decidedVia: "chief_of_staff" as const };

/**
 * Approve one open proposal: **the one approve path** (the owner's click,
 * `proposal_decide`, and auto-approval under granted autonomy all call it). The
 * payload (or the owner's edit of it) is held to the live data again; one
 * that no longer applies is refused with a sentence and the proposal stays
 * open, since a mutation that throws writes nothing. What the owner changed
 * is stored as `edits` (and `editedBeforeApprove`), which
 * `proposals_feedback` returns.
 */
export async function approveProposal(
  ctx: MutationCtx,
  member: Member,
  id: Id<"proposals">,
  options: ApproveOptions,
) {
  const { now, edit } = options;
  const row = await openRow(ctx, id);
  const shaped = edit === undefined ? shapedOf(row) : edited(ctx, row, edit);
  await checkLive(ctx, member, row.company, shaped, true);
  if (shaped.kind === "deal_create") await refuseDuplicateDeal(ctx, row.company, shaped.payload.name, row.duplicateOf ?? []);
  const result = await carryOut(ctx, member, row, shaped, now);
  const edits = editsOf(row.payload as Raw, shaped.payload as Raw);
  const said = options.reason === undefined ? "" : cleanLine(options.reason, MAX_DISMISS_REASON_LENGTH);
  await ctx.db.patch(id, {
    status: options.decision ?? "approved",
    decidedAt: now,
    result,
    payload: shaped.payload,
    editedBeforeApprove: edits.length > 0,
    edits,
    ...(options.via === "chief_of_staff" ? CHIEF_ATTRIBUTION : null),
    ...(said === "" ? null : { decisionReason: said }),
  });
  // Earned autonomy (convex/lib/trust.ts): a clean approval adds to the
  // proposer's streak in this kind, an edit starts it again (what changed is
  // this row's `edits`), an automatic one is counted apart.
  await noteDecision(
    ctx,
    row,
    options.decision === "auto_approved" ? "auto" : edits.length > 0 ? "edited" : "clean",
    now,
    edits.length > 0 ? id : undefined,
  );
  await scheduleBotEvent(ctx, {
    event: "proposal.decided",
    company: row.company,
    // A bot's proposal only: one of the four's (a Mac agent's) is never sent out.
    agent: row.bot ?? null,
    id,
    title: proposalTitle(shaped.payload as Record<string, unknown>) || PROPOSAL_EVENT_TITLES[row.kind],
    decision: options.decision ?? "approved",
    at: now,
  });
  return result;
}

export type RejectInput = { code?: string; reason?: string };

/**
 * The owner's "no", with a reason: a quick one (`code`), typed words
 * (`reason`), or both; neither is refused. What the next run reads back.
 */
export async function dismiss(
  ctx: MutationCtx,
  id: Id<"proposals">,
  input: RejectInput,
  now: number,
  /** Set by `proposal_decide`. The button leaves it out. */
  via?: "chief_of_staff",
) {
  const row = await openRow(ctx, id);
  if ((input.reason ?? "").trim().length > MAX_DISMISS_REASON_LENGTH) {
    refuse(`That reason is too long (${MAX_DISMISS_REASON_LENGTH} characters at most).`);
  }
  if (input.code !== undefined && !(REJECT_CODES as readonly string[]).includes(input.code)) {
    refuse(PROPOSAL_WORDS.rejectReason);
  }
  const code = input.code as RejectCode | undefined;
  const said = cleanLine(input.reason ?? "", MAX_DISMISS_REASON_LENGTH);
  if (code === undefined && said === "") refuse(PROPOSAL_WORDS.rejectReason);
  await ctx.db.patch(row._id, {
    status: "dismissed",
    decidedAt: now,
    ...(code === undefined ? null : { rejectCode: code }),
    ...(said === "" ? null : { rejectReason: said }),
    ...(via === "chief_of_staff" ? CHIEF_ATTRIBUTION : null),
  });
  await noteDecision(ctx, row, "dismissed", now);
  await scheduleBotEvent(ctx, {
    event: "proposal.decided",
    company: row.company,
    // A bot's proposal only: one of the four's (a Mac agent's) is never sent out.
    agent: row.bot ?? null,
    id: row._id,
    title: proposalTitle(row.payload as Record<string, unknown>) || PROPOSAL_EVENT_TITLES[row.kind],
    decision: "dismissed",
    at: now,
  });
  return null;
}

// ── Deciding from chat (`proposal_decide`) ──────────────────────────────────
// The chief of staff, and only that caller, approves or dismisses for the
// owner. Approve and dismiss are the functions the buttons run. An id that
// is already decided returns as it is: nothing is created again.

/** One id as `proposal_decide` answers it. No payload: the same rule as `proposals_feedback`. */
export type DecideItem = {
  id: string;
  ok: boolean;
  /** True when it was already decided: this call created nothing and changed nothing. */
  already: boolean;
  status: Row["status"] | null;
  decision: ReturnType<typeof decisionOf>;
  createdId: string | null;
  edits: { field: string; before: string | null; after: string | null }[];
  decidedBy: "owner" | null;
  via: "chief_of_staff" | null;
  /** An approval's `decisionReason`, or a dismissal's `rejectReason`. */
  reason: string | null;
  error: string | null;
};

export type DecideInput = {
  ids: readonly string[];
  decision: "approve" | "dismiss";
  reason?: string | undefined;
  /** The owner's edit of the payload, the whole payload of that one proposal's kind. */
  edit?: Raw | undefined;
};

const blankDecide = {
  ok: false as const,
  already: false as const,
  status: null,
  decision: null,
  createdId: null,
  edits: [] as DecideItem["edits"],
  decidedBy: null,
  via: null,
  reason: null,
  error: null as string | null,
};

/** The row as the caller reads it back. `already` is true when this call did not decide it. */
function decideView(row: Row, already: boolean): DecideItem {
  return {
    id: row._id,
    ok: true,
    already,
    status: row.status,
    decision: decisionOf(row.status),
    createdId: createdIdOf(row),
    edits: row.edits ?? [],
    decidedBy: row.decidedBy ?? null,
    via: row.decidedVia ?? null,
    reason: row.decisionReason ?? rejectReasonOf(row),
    error: null,
  };
}

/** A fixed sentence from `refuse`, or null for anything else (which must roll the mutation back). */
function refusalWords(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data;
  if (typeof data !== "string") return null;
  try {
    const decoded: unknown = JSON.parse(data);
    if (typeof decoded === "string") return decoded;
  } catch {
    return data;
  }
  return data;
}

/**
 * The checks `approveProposal` makes before it writes, so a refusal of one id
 * in a batch changes nothing of that id and the others still go through.
 */
async function preflightApprove(ctx: MutationCtx, member: Member, row: Row, edit: Raw | undefined) {
  const shaped = edit === undefined ? shapedOf(row) : edited(ctx, row, edit);
  await checkLive(ctx, member, row.company, shaped, true);
  if (shaped.kind === "deal_create") {
    await refuseDuplicateDeal(ctx, row.company, shaped.payload.name, row.duplicateOf ?? []);
  }
}

/**
 * Approve or dismiss each id, as the owner's buttons do (`approveProposal`,
 * `dismiss`). One already decided returns its current state and is left as it
 * is. A draft that is approved is kept as text: `carryOut` sends nothing.
 * The caller has already checked that the caller is the chief of staff.
 */
export async function decideProposals(
  ctx: MutationCtx,
  member: Member,
  input: DecideInput,
  now: number,
): Promise<{ decided: number; results: DecideItem[] }> {
  if (input.edit !== undefined && input.decision === "dismiss") refuse(DECIDE_WORDS.editOnDismiss);
  if (input.edit !== undefined && input.ids.length !== 1) refuse(DECIDE_WORDS.editOne);
  const raw = input.reason ?? "";
  if (raw.trim().length > MAX_DISMISS_REASON_LENGTH) {
    refuse(`That reason is too long (${MAX_DISMISS_REASON_LENGTH} characters at most). Nothing was changed.`);
  }
  const said = cleanLine(raw, MAX_DISMISS_REASON_LENGTH);

  const results: DecideItem[] = [];
  for (const given of input.ids) {
    const id = ctx.db.normalizeId("proposals", given);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null) {
      results.push({ ...blankDecide, id: given, error: PROPOSAL_WORDS.gone });
      continue;
    }
    if (row.status !== "open") {
      results.push(decideView(row, true));
      continue;
    }
    if (input.decision === "approve") {
      try {
        await preflightApprove(ctx, member, row, input.edit);
      } catch (error) {
        const words = refusalWords(error);
        if (words === null) throw error;
        results.push({ ...blankDecide, id: given, status: "open", error: words });
        continue;
      }
      // The same path as the Approve button. A throw here is after a write
      // might have started, so it rolls the whole call back.
      await approveProposal(ctx, member, row._id, {
        now,
        ...(input.edit === undefined ? null : { edit: input.edit }),
        via: "chief_of_staff",
        ...(said === "" ? null : { reason: said }),
      });
    } else {
      try {
        // The same path as Dismiss. It writes only after its checks.
        await dismiss(ctx, row._id, said === "" ? {} : { reason: said }, now, "chief_of_staff");
      } catch (error) {
        const words = refusalWords(error);
        if (words === null) throw error;
        const fresh = await ctx.db.get(row._id);
        if (fresh !== null && fresh.status !== "open") throw error;
        results.push({ ...blankDecide, id: given, status: "open", error: words });
        continue;
      }
    }
    const decidedRow = await ctx.db.get(row._id);
    results.push(decideView(decidedRow ?? row, false));
  }
  return { decided: results.filter((item) => item.ok && !item.already).length, results };
}

// ── Withdrawing (spec §14) ──────────────────────────────────────────────────

/**
 * Who is withdrawing: a bot by the profile the endpoint matched (`bot`), one
 * of the four by its id (`agent`), or neither: the owner's own client, which
 * may withdraw any.
 */
export type Withdrawer = { bot?: string | undefined; agent?: AgentId | undefined };

export type WithdrawInput = {
  ids: readonly string[];
  reason: WithdrawReason;
  note?: string | undefined;
  replacedBy?: string | undefined;
};

/** A withdrawal refused whole: its words and code, for the endpoint's `structuredContent`. */
const refuseCoded = (words: string, code: "not_owner" | "not_open" | "contact_detail" | "bad_context"): never => {
  throw new ConvexError({ words, refusal: { code } });
};

/** Who withdrew it, as the row keeps it: `bot:<id>`, one of the four, or `owner`. */
const withdrawnByOf = (who: Withdrawer) => (who.bot !== undefined ? `bot:${who.bot}` : (who.agent ?? "owner"));

/** Whether this caller may withdraw this row: its own, or any for the owner's own client. */
const mayWithdraw = (row: Row, who: Withdrawer) =>
  who.bot === undefined && who.agent === undefined ? true : filedBy(row, who);

/**
 * Take back proposals the caller filed (`proposal_withdraw`): each open one of
 * its own becomes `withdrawn` with the reason, the note and what replaced it;
 * off the inbox at once (it is no longer open). Per item: another proposer's,
 * or an id that is no proposal, is `not_owner` (the same answer, so nothing can
 * be probed), one no longer open `not_open`. Nothing of the owner's decision:
 * no trust is noted (`noteDecision` is not called), no rate counts it. The
 * note and the replacement are checked once, before anything changes, and
 * refuse the whole call.
 */
export async function withdrawProposals(
  ctx: MutationCtx,
  who: Withdrawer,
  input: WithdrawInput,
  now: number,
): Promise<{ id: string; ok: boolean; code?: "not_owner" | "not_open" | "bad_context" }[]> {
  const raw = input.note ?? "";
  if (raw.trim().length > MAX_WITHDRAW_NOTE) refuse(PROPOSAL_WORDS.tooLong);
  if (looksLikeContactDetail(raw)) refuseCoded(WITHDRAW_WORDS.contact, "contact_detail");
  const note = cleanLine(raw, MAX_WITHDRAW_NOTE);

  let replacement: Row | null = null;
  if (input.replacedBy !== undefined) {
    const id = ctx.db.normalizeId("proposals", input.replacedBy);
    replacement = id === null ? null : await ctx.db.get(id);
    if (replacement === null || !mayWithdraw(replacement, who)) refuseCoded(WITHDRAW_WORDS.replacedBy, "not_owner");
  }

  const results: { id: string; ok: boolean; code?: "not_owner" | "not_open" | "bad_context" }[] = [];
  for (const given of input.ids) {
    const id = ctx.db.normalizeId("proposals", given);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || !mayWithdraw(row, who)) {
      results.push({ id: given, ok: false, code: "not_owner" });
      continue;
    }
    if (row.status !== "open") {
      results.push({ id: given, ok: false, code: "not_open" });
      continue;
    }
    if (replacement !== null && (replacement._id === row._id || replacement.company !== row.company)) {
      results.push({ id: given, ok: false, code: "bad_context" });
      continue;
    }
    await ctx.db.patch(row._id, {
      status: "withdrawn",
      decidedAt: now,
      withdrawnAt: now,
      withdrawReason: input.reason,
      withdrawnBy: withdrawnByOf(who),
      ...(note === "" ? null : { withdrawNote: note }),
      ...(replacement === null ? null : { replacedBy: replacement._id }),
    });
    results.push({ id: given, ok: true });
  }
  return results;
}

/** One proposal withdrawn, or the refusal with its code (`not_owner`, `not_open`, `bad_context`). */
export async function withdrawOne(ctx: MutationCtx, who: Withdrawer, input: Omit<WithdrawInput, "ids"> & { id: string }, now: number) {
  const [result] = await withdrawProposals(ctx, who, { ...input, ids: [input.id] }, now);
  if (result!.ok) return { id: input.id, withdrawn: true, status: "withdrawn" as const };
  switch (result!.code) {
    case "not_open":
      return refuseCoded(WITHDRAW_WORDS.notOpen, "not_open");
    case "bad_context":
      return refuseCoded(WITHDRAW_WORDS.replacedBy, "bad_context");
    default:
      return refuseCoded(WITHDRAW_WORDS.notOwner, "not_owner");
  }
}

// ── Counting and keeping ────────────────────────────────────────────────────

/** Proposals made at or after `since` (500 at most). */
export async function proposalsMadeSince(ctx: QueryCtx, since: number): Promise<number> {
  const made = await ctx.db
    .query("proposals")
    .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
    .take(500);
  return made.length;
}

/**
 * Mark a batch of open proposals nobody decided as expired, and delete a
 * batch of decided ones past their keeping. Returns whether there may be more.
 */
export async function sweepProposals(ctx: MutationCtx, now: number, batch: number) {
  const stale = await ctx.db
    .query("proposals")
    .withIndex("by_status_and_createdAt", (q) =>
      q.eq("status", "open").lt("createdAt", now - PROPOSAL_EXPIRES_DAYS * DAY_MS),
    )
    .take(batch);
  for (const row of stale) await ctx.db.patch(row._id, { status: "expired", decidedAt: now });
  const old = await ctx.db
    .query("proposals")
    .withIndex("by_decidedAt", (q) =>
      q.gt("decidedAt", 0).lt("decidedAt", now - PROPOSAL_RETENTION_DAYS * DAY_MS),
    )
    .take(batch);
  for (const row of old) await ctx.db.delete(row._id);
  return stale.length === batch || old.length === batch;
}
