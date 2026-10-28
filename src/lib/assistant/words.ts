// How the Assistant page says what an agent wrote or proposes. Pure: every
// function that depends on "now" takes it.
//
// A sentence here is built from fixed words and the proposal's own fields.
// The fields are a model's text (a title, a next step) or a name the server
// looked up: they are put in as text, quoted, and the page renders the
// sentence as text. Nothing here reads them as markup.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { localIsoDate } from "@/lib/dates";
import { dayLabel } from "@/lib/format";
import { taskColumnTitle } from "@/lib/task-columns";
import { AREA_NAMES, type Area } from "@convex/lib/roles";
import { WITHDRAW_REASON_LABELS } from "@convex/lib/agents";

/** A proposal waiting on /approvals (`assistant.inbox`). */
export type OpenProposal = Extract<FunctionReturnType<typeof api.assistant.inbox>[number], { source: "proposal" }>;
/** A proposal with what became of it (`assistant.decided`; a chat answer's card is the same shape). */
export type DecidedProposal = Extract<FunctionReturnType<typeof api.assistant.decided>[number], { source: "proposal" }>;

type Fields = {
  title?: string;
  body?: string;
  notes?: string;
  assignee?: string | null;
  due?: string | null;
  column?: string;
  nextStep?: string;
  decision?: string;
  context?: string;
  /** decision_record's owner; a goal's, where null clears it. */
  ownerEmail?: string | null;
  revisitOn?: string;
  /** A goal's bot, target and due day (goal_create / goal_update); null clears one. */
  ownerBot?: string | null;
  target?: string | null;
  dueOn?: string | null;
  quarter?: string;
  status?: string;
  /** bot_permission: the bot that asked, the area and the level. */
  bot?: string;
  area?: string;
  level?: string;
  /** deal_create: the new deal's name, stage and contact. */
  name?: string;
  stage?: string;
  contact?: string;
  /** comment: what it is on. */
  subjectKind?: string;
  subjectId?: string;
  /** handoff_reassign: who it goes to, and why. */
  to?: string;
  note?: string;
};

/** How the Goals page rates a goal, in words. */
export const GOAL_STATUS_WORDS: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  done: "Done",
};

/** A proposal's payload read by field, whatever its kind: a field it lacks is undefined. */
export const fieldsOf = (row: Pick<OpenProposal, "payload">): Fields => row.payload as Fields;

/**
 * What approving a proposal will do, in plain words:
 * `Create a task for Dana: "Review PR #118", due Oct 16, in This week`.
 */
/**
 * A proposal its proposer withdrew, as the owner's history says it: "Withdrawn
 * by the agent: superseded. Merged into the newer card." The note is the
 * proposer's text, put in as text. Null for any row not withdrawn.
 */
export function withdrawnLine(row: Pick<DecidedProposal, "withdrawReason" | "withdrawNote">): string | null {
  if (row.withdrawReason === null) return null;
  const said = `Withdrawn by its proposer: ${WITHDRAW_REASON_LABELS[row.withdrawReason]}.`;
  return row.withdrawNote === null ? said : `${said} ${row.withdrawNote}`;
}

export function proposalSentence(
  row: Pick<OpenProposal, "kind" | "payload" | "about">,
  now: number,
): string {
  const fields = fieldsOf(row);
  const { about } = row;
  switch (row.kind) {
    case "task_create": {
      const who = about.assignee === null ? "" : ` for ${about.assignee}`;
      const due = fields.due == null ? "" : `, due ${dayLabel(fields.due, now)}`;
      return `Create a task${who}: "${fields.title ?? ""}"${due}, in ${taskColumnTitle(fields.column ?? "backlog")}`;
    }
    case "task_change": {
      const changes: string[] = [];
      if (fields.assignee === null) changes.push("take it off whoever holds it");
      else if (fields.assignee !== undefined) changes.push(`give it to ${about.assignee ?? "someone"}`);
      if (fields.due === null) changes.push("clear its due date");
      else if (fields.due !== undefined) changes.push(`set it due ${dayLabel(fields.due, now)}`);
      if (fields.column !== undefined) changes.push(`move it to ${taskColumnTitle(fields.column)}`);
      const what = about.task === null ? "a task that is no longer on the board" : `"${about.task}"`;
      return `Change ${what}: ${changes.join(", ")}`;
    }
    case "deal_next_step": {
      const deal = about.deal === null ? "a deal that is no longer on the board" : about.deal;
      return `Set the next step of ${deal} to "${fields.nextStep ?? ""}"`;
    }
    case "draft":
      return `A draft for you to send yourself: "${fields.title ?? ""}"`;
    case "decision_record": {
      const who = about.assignee === null ? "" : `, owned by ${about.assignee}`;
      const when = fields.revisitOn == null ? "" : `, to revisit ${dayLabel(fields.revisitOn, now)}`;
      return `Record a decision${who}: "${fields.title ?? ""}"${when}`;
    }
    case "goal_create": {
      const rated = fields.status === undefined ? "" : `, rated ${GOAL_STATUS_WORDS[fields.status] ?? fields.status}`;
      const target = fields.target == null ? "" : `, target "${fields.target}"`;
      const due = fields.dueOn == null ? "" : `, due ${dayLabel(fields.dueOn, now)}`;
      return `Add a goal for ${fields.quarter ?? "a quarter"}: "${fields.title ?? ""}"${rated}${target}${due}`;
    }
    case "goal_update": {
      const changes: string[] = [];
      if (fields.title !== undefined) changes.push(`rename it "${fields.title}"`);
      if (fields.status !== undefined) changes.push(`rate it ${GOAL_STATUS_WORDS[fields.status] ?? fields.status}`);
      if (fields.ownerEmail === null) changes.push("take its owner off");
      else if (fields.ownerEmail !== undefined) changes.push("give it an owner");
      if (fields.ownerBot === null) changes.push("take its bot off");
      else if (fields.ownerBot !== undefined) changes.push(`give it to the bot ${fields.ownerBot}`);
      if (fields.target === null) changes.push("clear its target");
      else if (fields.target !== undefined) changes.push(`set its target "${fields.target}"`);
      if (fields.dueOn === null) changes.push("clear its due day");
      else if (fields.dueOn !== undefined) changes.push(`make it due ${dayLabel(fields.dueOn, now)}`);
      // The goal's title as it is now is looked up where a task's would be.
      const what = about.task === null ? "a goal that no longer exists" : `the goal "${about.task}"`;
      return `Change ${what}: ${changes.join(", ")}`;
    }
    case "deal_create": {
      const stage = fields.stage ?? "lead";
      const contact = fields.contact === undefined ? "" : `, contact ${fields.contact}`;
      return `Add a new deal: "${fields.name ?? ""}" at ${stage}${contact}`;
    }
    case "bot_permission": {
      const area = AREA_NAMES[fields.area as Area] ?? fields.area ?? "an area";
      const level = fields.level === "write" ? "read and change" : "read";
      return `Let the bot ${fields.bot ?? ""} ${level} ${area}`;
    }
    case "memory_note":
      return `Keep a note: "${fields.title ?? ""}"`;
    case "comment": {
      const on = about.deal ?? about.task ?? "something that is no longer there";
      return `Comment on ${on}: "${fields.body ?? ""}"`;
    }
    case "task_archive": {
      const what = about.task === null ? "a task that is no longer on the board" : `"${about.task}"`;
      return `Take ${what} off the board`;
    }
    case "handoff_reassign": {
      const what = about.task === null ? "a handoff that is no longer there" : `"${about.task}"`;
      const who = about.assignee ?? fields.to ?? "someone";
      return `Hand ${what} to ${who}`;
    }
  }
}

/** The hour and minute of a moment, in the reader's own time: "11:20". */
export function clockTime(at: number): string {
  const when = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(when.getHours())}:${two(when.getMinutes())}`;
}

/** "at 11:20" for today, "on Oct 13 at 11:20" for another day. */
export function whenWritten(at: number, now: number): string {
  const day = localIsoDate(at);
  return day === localIsoDate(now)
    ? `at ${clockTime(at)}`
    : `on ${dayLabel(day, now)} at ${clockTime(at)}`;
}

/** The line under a brief: who wrote it, when, and from what. */
export const briefFooter = (writtenAt: number, now: number) =>
  `Written by Claude ${whenWritten(writtenAt, now)} from the OS's figures.`;

/** Where approving a proposal led, as a link: null for a draft, which leads nowhere. */
export function resultLink(result: DecidedProposal["result"]): { href: string; label: string } | null {
  if (result === null) return null;
  if ("taskId" in result) return { href: `/board?task=${result.taskId}`, label: "Open the task on the board" };
  if ("dealId" in result) return { href: "/sales", label: "Open the sales board" };
  if ("goalId" in result) return { href: "/goals", label: "Open Goals" };
  if ("decisionId" in result) {
    return { href: `/memory?decision=${result.decisionId}`, label: "Open the decision in Memory" };
  }
  if ("noteId" in result) return { href: "/memory?tab=notes", label: "Open the note in Memory" };
  if ("handoffId" in result) return { href: "/handoffs", label: "Open handoffs" };
  return null;
}
