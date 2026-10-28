// The approvals inbox (/approvals): what waits for the owner's click, from
// every agent and bot. Pure: the view (filters) lives in the address, the
// narrowing is done here on the rows already sent, and deciding many is one
// call of the existing path per row, in turn (`decideMany`).
//
// A row is one of two things: an open proposal (convex/lib/proposals.ts),
// decided with `assistant.approve` / `assistant.dismiss`; or a tool call a
// Startup OS run paused on, decided with `agentRuntime.decide`. There is no
// path of its own here, and no other place decides either: the chat shows a
// proposal it just made with the same row and the same calls, and an agent's
// Runs tab links here.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import {
  AGENT_NAMES,
  NEVER_AUTONOMOUS,
  PROPOSAL_KINDS,
  REJECT_CODE_LABELS,
  REJECT_CODES,
  isAgentId,
  type RejectCode,
} from "@convex/lib/agents";
import { companyIds, type CompanyId } from "@convex/lib/company";
import { proposalSentence, type OpenProposal } from "@/lib/assistant/words";

export type InboxRow = FunctionReturnType<typeof api.assistant.inbox>[number];
export type InboxKind = InboxRow["kind"];
/** A row of "Decided": a proposal or a tool call, with how it ended. */
export type DecidedRow = FunctionReturnType<typeof api.assistant.decided>[number];
export type DecidedStatus = DecidedRow["status"];

/** How a row of "Decided" ended, as its filter offers them. */
export const DECIDED_STATUSES = [
  "approved",
  "auto_approved",
  "dismissed",
  "denied",
  "expired",
  "withdrawn",
] as const satisfies readonly DecidedStatus[];
export const DECIDED_LABELS: Record<(typeof DECIDED_STATUSES)[number], string> = {
  approved: "Approved",
  auto_approved: "Approved automatically",
  dismissed: "Dismissed",
  denied: "Denied",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

/** The two tabs of /approvals: what waits, and what became of the rest. */
export const TABS = ["waiting", "decided"] as const;
export type Tab = (typeof TABS)[number];

export const INBOX_KINDS: readonly InboxKind[] = [...PROPOSAL_KINDS, "tool_call"];

const KIND_LABELS: Record<InboxKind, string> = {
  task_create: "New task",
  task_change: "Task change",
  deal_next_step: "Next step",
  draft: "Draft",
  decision_record: "Decision",
  goal_create: "New goal",
  goal_update: "Goal change",
  bot_permission: "Bot permission",
  deal_create: "New deal",
  memory_note: "Note",
  comment: "Comment",
  task_archive: "Archive task",
  handoff_reassign: "Reassign handoff",
  tool_call: "Tool call",
};

export const kindLabel = (kind: InboxKind): string => KIND_LABELS[kind];

/**
 * Who proposed it, as the filter keys it: an owner-managed bot as `bot:<id>`
 * (its proposal is filed under an agent, but the bot made it), else the agent.
 */
export const whoKey = (row: Pick<InboxRow, "agent" | "bot">): string =>
  row.bot !== null ? `bot:${row.bot}` : row.agent;

/** Who proposed it: a bot by its profile's id, one of the owner's four by name, or a Startup OS agent by its id. */
export function whoLabel(row: Pick<InboxRow, "agent" | "bot">): string {
  if (row.bot !== null) return `Bot: ${row.bot}`;
  return isAgentId(row.agent) ? AGENT_NAMES[row.agent] : row.agent;
}

/** A filter key back as the row it names, for its label. */
export const whoOfKey = (key: string): Pick<InboxRow, "agent" | "bot"> =>
  key.startsWith("bot:") ? { agent: "", bot: key.slice(4) } : { agent: key, bot: null };

/** What approving it does, in plain words. */
export function rowSentence(row: InboxRow, now: number): string {
  if (row.source === "tool_call") return `Run a tool: ${row.toolName}`;
  return proposalSentence(row as unknown as OpenProposal, now);
}

/**
 * The types the filter offers, each a group of kinds: a task, a deal's stage
 * (its next step), a goal, an outbound message (a draft to send), and a data
 * edit (everything else: a decision recorded, a tool call, what comes next).
 */
export const INBOX_TYPES = ["task", "deal", "goal", "message", "data"] as const;
export type InboxType = (typeof INBOX_TYPES)[number];
export const TYPE_LABELS: Record<InboxType, string> = {
  task: "Task",
  deal: "Deal stage",
  goal: "Goal",
  message: "Outbound message",
  data: "Data edit",
};
export function typeOf(kind: InboxKind): InboxType {
  switch (kind) {
    case "task_create":
    case "task_change":
    case "task_archive":
      return "task";
    case "deal_next_step":
    case "deal_create":
      return "deal";
    case "goal_create":
    case "goal_update":
      return "goal";
    case "draft":
      return "message";
    default:
      return "data";
  }
}

export const INBOX_URGENCIES = ["critical", "high", "normal", "low"] as const satisfies readonly InboxRow["urgency"][];

/**
 * The tab and its filters, all in the address: company, who proposed it
 * (`agent`), the goal it serves, its type, its kind and its urgency; and on
 * "Decided", how it ended (`decision`).
 */
export type View = {
  tab: Tab;
  company: CompanyId | null;
  agent: string | null;
  /** A goal's id, or `none` for proposals that serve no goal. */
  goal: string | null;
  type: InboxType | null;
  kind: InboxKind | null;
  urgency: InboxRow["urgency"] | null;
  decision: (typeof DECIDED_STATUSES)[number] | null;
};
export const EVERYTHING: View = {
  tab: "waiting",
  company: null,
  agent: null,
  goal: null,
  type: null,
  kind: null,
  urgency: null,
  decision: null,
};

const AGENT_ID = /^(bot:)?[a-z0-9._-]{1,64}$/;
const GOAL_ID = /^[a-z0-9]{1,64}$/;

export function readView(params: URLSearchParams): View {
  const pick = <T extends string>(name: string, among: readonly T[]): T | null => {
    const value = params.get(name);
    return (among as readonly string[]).includes(value ?? "") ? (value as T) : null;
  };
  const agent = params.get("agent");
  const goal = params.get("goal");
  return {
    tab: pick("tab", TABS) ?? "waiting",
    company: pick("company", companyIds()),
    agent: agent !== null && AGENT_ID.test(agent) ? agent : null,
    goal: goal !== null && GOAL_ID.test(goal) ? goal : null,
    type: pick("type", INBOX_TYPES),
    kind: pick("kind", INBOX_KINDS),
    urgency: pick("urgency", INBOX_URGENCIES),
    decision: pick("decision", DECIDED_STATUSES),
  };
}

/** The query string for a view: only what differs from everything. */
export function writeView(view: View): string {
  const params = new URLSearchParams();
  if (view.tab !== "waiting") params.set("tab", view.tab);
  for (const name of ["company", "agent", "goal", "type", "kind", "urgency", "decision"] as const) {
    const value = view[name];
    if (value !== null) params.set(name, value);
  }
  return params.toString();
}

/** What a filter reads of a row: a waiting one, or one of "Decided" (which says how it ended). */
type Filterable = Pick<InboxRow, "company" | "agent" | "bot" | "kind" | "urgency"> & {
  goal: { id: string } | null;
  status?: string;
};

export function filterInbox<Row extends Filterable>(rows: readonly Row[], view: View): Row[] {
  return rows.filter(
    (row) =>
      (view.company === null || row.company === view.company) &&
      (view.agent === null || whoKey(row) === view.agent) &&
      (view.goal === null || (row.goal?.id ?? "none") === view.goal) &&
      (view.type === null || typeOf(row.kind) === view.type) &&
      (view.kind === null || row.kind === view.kind) &&
      (view.urgency === null || row.urgency === view.urgency) &&
      (view.decision === null || row.status === undefined || row.status === view.decision),
  );
}

/** The goals among the rows, for the filter: each once, in the order first seen. */
export function goalsIn(rows: readonly { goal: { id: string; title: string } | null }[]): { id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) if (row.goal !== null && !seen.has(row.goal.id)) seen.set(row.goal.id, row.goal.title);
  return [...seen.entries()].map(([id, title]) => ({ id, title }));
}

/** A goal the sort lifts: at risk or off track. */
const atRisk = (row: InboxRow) => row.goal !== null && (row.goal.status === "at_risk" || row.goal.status === "off_track");

/**
 * The default order: critical first, then what serves a goal at risk (or off
 * track), then the rest; oldest first within each. Ties keep the order given.
 */
export function sortInbox(rows: readonly InboxRow[]): InboxRow[] {
  const rank = (row: InboxRow) => (row.urgency === "critical" ? 0 : atRisk(row) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/**
 * "Cash and runway", pinned at the top: what the server put in the cash group
 * (convex/lib/cashGroup.ts: a goal tagged cash, or a goal or proposer about
 * fundraising, finance or collections). The rest below.
 */
export function splitCash(rows: readonly InboxRow[]): { cash: InboxRow[]; rest: InboxRow[] } {
  return {
    cash: rows.filter((row) => row.cash),
    rest: rows.filter((row) => !row.cash),
  };
}

/** A forced near-duplicate's badge: "Possible duplicate of “…”" (and how many more). Null for any other row. */
export function duplicateBadge(row: Pick<InboxRow, "duplicate">): string | null {
  const first = row.duplicate?.of[0];
  if (row.duplicate == null || first === undefined) return null;
  const more = row.duplicate.of.length - 1;
  return `Possible duplicate of “${first.title}”${more > 0 ? ` and ${more} more` : ""}`;
}

const HOUR = 60 * 60 * 1000;
/** How old a row is, as its badge shows it: amber after a day, red after three, by the page's clock. */
export function ageTone(now: number, createdAt: number): "fresh" | "amber" | "red" {
  const age = now - createdAt;
  return age > 72 * HOUR ? "red" : age > 24 * HOUR ? "amber" : "fresh";
}

export const URGENCY_LABELS = { critical: "Critical", high: "High", normal: "Normal", low: "Low" } as const;

/** Why a row is rejected: a quick reason, typed words, or both. One of the two is required. */
export type RejectReason = { code: RejectCode | null; text: string };
export const REJECT_CHIPS = REJECT_CODES.map((code) => ({ code, label: REJECT_CODE_LABELS[code] }));
export const hasReason = (reason: RejectReason) => reason.code !== null || reason.text.trim() !== "";

/** The agents among the rows, for the filter: each once, in the order first seen. */
export const agentsIn = (rows: readonly Pick<InboxRow, "agent" | "bot">[]): string[] => [...new Set(rows.map(whoKey))];

/**
 * Why a row is not approved with others: said beside it, and it stays
 * selected, so the owner gives it a click of its own.
 */
export const ONE_CLICK_WORDS =
  "Approve this one with its own button: a possible duplicate, a new deal, a draft (an investor's included), a goal or a bot's permission is never approved with others or with the a key.";

/**
 * Whether a row needs a click of its own to be approved: a forced
 * near-duplicate, or a kind never done without the owner (`NEVER_AUTONOMOUS`:
 * a new deal, a draft, an investor's included, a goal, a bot's permission).
 * Approving in bulk or with the `a` key leaves it waiting; rejecting is never
 * held back.
 */
export function oneClickOnly(row: Pick<InboxRow, "source" | "kind" | "duplicate">): boolean {
  if (row.source !== "proposal") return false;
  return row.duplicate != null || (NEVER_AUTONOMOUS as readonly string[]).includes(row.kind);
}

export type Deciders = {
  approve: (args: { id: string }) => Promise<unknown>;
  dismiss: (args: { id: string; reason?: string; code?: RejectCode }) => Promise<unknown>;
  decide: (args: { id: string; decision: "approve" | "deny"; reason?: string }) => Promise<unknown>;
};

/** Said beside a row rejected with no reason: none is sent without one. */
export const REASON_NEEDED = "Pick a quick reason or type one: it goes back to the proposer.";

/**
 * Approve or reject these rows, one at a time, each through its own existing
 * path. A refusal (a proposal that no longer applies, a run that is gone)
 * leaves that row as it was and the rest go on; what was refused comes back
 * by id, in the words the server gave. A rejection carries the row's reason
 * (`reasonOf`), and none is sent without one: a proposal its code and words,
 * a tool call its words, or the code's label where none were typed. Approving
 * in `bulk` (several selected, or the `a` key) leaves a row that needs a
 * click of its own (`oneClickOnly`) waiting, with `ONE_CLICK_WORDS`.
 */
export async function decideMany(
  rows: readonly Pick<InboxRow, "id" | "source" | "kind" | "duplicate">[],
  action: "approve" | "reject",
  deciders: Deciders,
  reasonOf: (id: string) => RejectReason,
  messageOf: (error: unknown) => string = (error) => (error instanceof Error ? error.message : String(error)),
  { bulk = false }: { bulk?: boolean } = {},
): Promise<Record<string, string>> {
  const failed: Record<string, string> = {};
  for (const row of rows) {
    const said = reasonOf(row.id);
    const text = said.text.trim();
    const words = text !== "" ? text : said.code === null ? "" : REJECT_CODE_LABELS[said.code];
    if (action === "approve" && bulk && oneClickOnly(row)) {
      failed[row.id] = ONE_CLICK_WORDS;
      continue;
    }
    if (action === "reject" && words === "") {
      failed[row.id] = REASON_NEEDED;
      continue;
    }
    try {
      if (row.source === "tool_call") {
        await deciders.decide({
          id: row.id,
          decision: action === "approve" ? "approve" : "deny",
          ...(action === "reject" ? { reason: words } : null),
        });
      } else if (action === "approve") {
        await deciders.approve({ id: row.id });
      } else {
        await deciders.dismiss({
          id: row.id,
          ...(said.code === null ? null : { code: said.code }),
          ...(text === "" ? null : { reason: text }),
        });
      }
    } catch (error) {
      failed[row.id] = messageOf(error);
    }
  }
  return failed;
}
