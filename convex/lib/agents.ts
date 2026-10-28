// The owner's agents and what they may write: the daily brief, proposals for
// the owner to approve, and answers to questions asked in the app. One module
// for the closed sets, the limits and every fixed sentence, so the tools
// (convex/lib/mcpTools.ts), the owner's functions (convex/assistant.ts) and
// the Assistant page quote the same thing.
//
// Pure: nothing here reads a table, a clock or the environment, and the UI
// imports it (through `@/lib/assistant/agents`).
//
// **Everything an agent writes was written by a model.** It is data: cleaned
// (convex/lib/agentText.ts), bounded by the numbers below, stored as plain
// text and rendered as text. It is never markup, never a link and never an
// instruction to whatever reads it next. Every refusal here is fixed words:
// none is built from what was sent.

import { PRODUCT } from "./identity";

// ── The agents ──────────────────────────────────────────────────────────────

/** A closed set. A new agent is added here, given a name and a line, and a prompt in docs/agents/. */
export const AGENT_IDS = ["chief_of_staff", "engineering", "sales", "finance"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_NAMES: Record<AgentId, string> = {
  chief_of_staff: "Chief of staff",
  engineering: "Engineering manager",
  sales: "Sales and pipeline",
  finance: "Finance and compliance",
};

/** What each does, in a line, beside its switch. */
export const AGENT_LINES: Record<AgentId, string> = {
  chief_of_staff:
    "Writes the daily brief for each company from the others' findings, answers what you ask here, and drafts the investor update on the month's first run.",
  engineering:
    "Looks for pull requests that are stuck, people with too much open, and tasks nobody owns. Proposes tasks and changes to them.",
  sales:
    "Looks for deals gone quiet or with no next step, and at Apollo's figures. Proposes next steps and drafts follow-ups for you to send.",
  finance:
    "Looks at cash, burn, runway and MRR, dates coming due, and clinics that owe or are at risk. Proposes tasks for what is coming due.",
};

export const isAgentId = (value: unknown): value is AgentId =>
  (AGENT_IDS as readonly unknown[]).includes(value);

/** The file of each agent's procedure, under docs/agents/. */
export const AGENT_PROMPTS: Record<AgentId, string> = {
  chief_of_staff: "chief-of-staff.md",
  engineering: "engineering.md",
  sales: "sales.md",
  finance: "finance.md",
};

/**
 * When the four run by default, in the owner's own time (Almaty): their
 * default schedule is `OS_AGENT_DEFAULT_CRON` (convex/lib/osAgents.ts), in
 * UTC, which a test holds to this. Words only: nothing is scheduled here.
 */
export const RUN_TIMES = { morning: "11:20" } as const;

export const AGENT_OFF = "That agent is switched off on the Assistant page. Nothing was written.";

// ── The brief ───────────────────────────────────────────────────────────────

export const MAX_BRIEF_BULLETS = 8;
export const MAX_BULLET_LENGTH = 240;
/** A brief older than this is not shown: yesterday's news is not today's. */
export const BRIEF_FRESH_MS = 36 * 60 * 60 * 1000;
/** Briefs are kept this long. */
export const BRIEF_RETENTION_DAYS = 90;

/**
 * The pages a bullet may point at: a closed list of the app's own paths, so
 * a bullet's link is never an address a model chose. Each is a key of
 * `PAGE_AREAS` (src/lib/nav.ts); a test fails if one is not.
 */
export const BRIEF_PAGES = [
  "/engineering",
  "/sales",
  "/finance",
  "/customers",
  "/compliance",
  "/board",
  "/fundraising",
  "/product",
  "/gtm",
  "/memory",
  // Vertical Startup's AI agents: a line from the engineering manager.
  "/agents",
] as const;
export type BriefPage = (typeof BRIEF_PAGES)[number];

export const isBriefPage = (value: unknown): value is BriefPage =>
  (BRIEF_PAGES as readonly unknown[]).includes(value);

/** What a link to each page is called. */
export const BRIEF_PAGE_LABELS: Record<BriefPage, string> = {
  "/engineering": "Engineering",
  "/sales": "Sales",
  "/finance": "Finance",
  "/customers": "Customers",
  "/compliance": "Compliance",
  "/board": "Board",
  "/fundraising": "Fundraising",
  "/product": "Product",
  "/gtm": "Go to market",
  "/memory": "Memory",
  "/agents": "Agents",
};

export const BRIEF_WORDS = {
  dayTooFar: "`day` must be the server's UTC day or the day either side of it.",
  noBullets: `A brief needs at least one bullet and at most ${MAX_BRIEF_BULLETS}.`,
  emptyBullet: "A bullet has no text once it is cleaned.",
  tooLong: `A bullet may be at most ${MAX_BULLET_LENGTH} characters, on one line.`,
  page: "A bullet's page must be one of the app's own pages.",
  none: `No brief today yet. The next run is at about ${RUN_TIMES.morning}.`,
} as const;

/** Whether a brief written then is still shown now. The page asks, with its own clock. */
export const briefIsFresh = (writtenAt: number, now: number) => now - writtenAt <= BRIEF_FRESH_MS;

// ── Proposals ───────────────────────────────────────────────────────────────

export const PROPOSAL_KINDS = [
  "task_create",
  "task_change",
  "deal_next_step",
  "draft",
  // A decision seen in a meeting's notes, recorded on /memory if the owner approves.
  "decision_record",
  // A quarter's goal to add, or a goal to rename or re-rate (/goals): the
  // owner's plan, so a bot only ever proposes it (docs/assistant.md).
  "goal_create",
  "goal_update",
  // A bot asking for a level on an area (`permission_request`): approving it
  // changes that bot's profile, as the Bots tab does. The owner's alone.
  "bot_permission",
  // A new deal on a market's sales board (Bot Loop v3, section C): approving
  // it runs the Sales page's own create. Kazakhstan's too, made here and never
  // synced back to its CRM. Never autonomy-eligible (convex/lib/trust.ts).
  "deal_create",
  // A note that is not a meeting's, on /memory. Write with `note_write`, or propose this.
  "memory_note",
  // A comment on a task, a deal or a handoff. Write with `comment_create`, or propose this.
  "comment",
  // Take a task off the board without deleting it. Write with `task_archive`, or propose this.
  "task_archive",
  // Hand an open handoff to another bot or a person. Write with `handoff_reassign`, or propose this.
  "handoff_reassign",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * The kinds that may ever be done without the owner's click (earned autonomy,
 * convex/lib/trust.ts, which checks it again at every proposal).
 */
export const AUTONOMY_ELIGIBLE = [
  "task_create",
  "task_change",
  "deal_next_step",
  "decision_record",
] as const satisfies readonly ProposalKind[];

/**
 * Every other kind of today, never offered: outbound text (investor drafts
 * included), the owner's plan, a bot's permission and a new deal. On
 * /approvals these also take a click of their own: never approved in bulk or
 * with the `a` key (src/lib/approvals/inbox.ts, `oneClickOnly`).
 */
export const NEVER_AUTONOMOUS = [
  "draft",
  "goal_create",
  "goal_update",
  // A bot asking for a permission: the owner's own decision, always (and never a delegate's).
  "bot_permission",
  // A new deal on the sales board (Bot Loop v3): the owner's pipeline, always his click.
  "deal_create",
  // A note, a comment, taking a task off the board, handing a handoff on: always the owner's click.
  "memory_note",
  "comment",
  "task_archive",
  "handoff_reassign",
] as const satisfies readonly ProposalKind[];

/**
 * `auto_approved` is a proposal carried out at once through the same approve
 * path, under autonomy the owner granted a bot for its kind (convex/lib/trust.ts;
 * `approveProposal` in convex/lib/proposals.ts with `decision: "auto_approved"`).
 */
export const PROPOSAL_STATUSES = ["open", "approved", "dismissed", "expired", "auto_approved", "withdrawn"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// ── Withdrawing (spec §14) ──────────────────────────────────────────────────
// A proposer takes back its own open proposal (`proposal_withdraw`): status
// `withdrawn`, distinct from the owner's dismissal and from an expiry. Nobody's
// decision of the owner's: it counts toward no approval rate and no trust.

/** Why a proposer withdrew a proposal: a closed set, stored as `withdrawReason`. */
export const WITHDRAW_REASONS = ["duplicate", "superseded", "stale", "wrong", "other"] as const;
export type WithdrawReason = (typeof WITHDRAW_REASONS)[number];
/** Each reason in words, for the owner's history ("Withdrawn: superseded"). */
export const WITHDRAW_REASON_LABELS: Record<WithdrawReason, string> = {
  duplicate: "a duplicate",
  superseded: "superseded",
  stale: "stale",
  wrong: "wrong",
  other: "other",
};
/** The most proposals one `proposal_withdraw` call takes. */
export const MAX_WITHDRAW_IDS = 50;
/** The most proposals one `proposal_decide` call takes. */
export const MAX_DECIDE_IDS = 50;
/** The most characters of a withdrawal's note. */
export const MAX_WITHDRAW_NOTE = 300;
/** A key withdrawn as `wrong` is not proposed again for this long; any other reason releases it at once. */
export const WRONG_WITHDRAW_BLOCKS_DAYS = 7;

/**
 * Whether a proposal was filed by this caller: a bot by its profile's id (an
 * external chief of staff's rows are `bot: "chief_of_staff"`), one of the four
 * by its id on a row no bot made (a bot's rows are filed under the chief of
 * staff but are not its). Neither named: nobody's.
 */
export const filedBy = (
  row: { agent: string; bot?: string | undefined },
  who: { bot?: string | undefined; agent?: string | undefined },
): boolean =>
  who.bot !== undefined ? row.bot === who.bot : who.agent !== undefined && row.bot === undefined && row.agent === who.agent;

/** How soon a proposal wants the owner, set by its proposer: `normal` when none is given. */
export const URGENCIES = ["critical", "high", "normal", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];
export const DEFAULT_URGENCY: Urgency = "normal";

/** What a proposal may name as its evidence (`source`): checked to exist, of that company. */
export const SOURCE_KINDS = ["deal", "meeting", "note", "metric", "task", "decision"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The quick reasons for a rejection (a chip on /approvals), besides typed words. */
export const REJECT_CODES = ["wrong_timing", "wrong_data", "not_a_priority", "rewrite_tone", "duplicate"] as const;
export type RejectCode = (typeof REJECT_CODES)[number];
export const REJECT_CODE_LABELS: Record<RejectCode, string> = {
  wrong_timing: "Wrong timing",
  wrong_data: "Wrong data",
  not_a_priority: "Not a priority",
  rewrite_tone: "Rewrite tone",
  duplicate: "Duplicate",
};

/** What became of a proposal, as `proposals_feedback` says it to the bot that made it. */
export const DECISIONS = ["approved", "rejected", "expired", "auto_approved", "withdrawn"] as const;
export type Decision = (typeof DECISIONS)[number];
export const decisionOf = (status: ProposalStatus): Decision | null =>
  status === "dismissed" ? "rejected" : status === "open" ? null : status;

export const DRAFT_ABOUT = ["deal", "investor", "customer", "update"] as const;
export type DraftAbout = (typeof DRAFT_ABOUT)[number];

export const MAX_REASON_LENGTH = 300;
export const MAX_DEDUPE_KEY_LENGTH = 120;
/** A key is lower case and plain: `agent:kind:subject-id`. */
export const DEDUPE_KEY = /^[a-z0-9:_-]+$/;
export const MAX_DISMISS_REASON_LENGTH = 200;
/**
 * A bot profile's id (an owner-managed bot, not one of the four: botRules.ts):
 * lower case letters, digits, `_` and `-`, 2 to 40, starting with a letter.
 * Defined here, and re-exported by botRules.ts, so a proposal's `bot` and a
 * profile's id are one shape. A proposal a bot makes carries it as `bot`, and
 * is filed under the agent whose limits and switch it counts against
 * (`BOT_FILED_UNDER`).
 */
export const BOT_ID = /^[a-z][a-z0-9_-]{1,39}$/;
export const isBotId = (value: unknown): value is string => typeof value === "string" && BOT_ID.test(value);
/** The agent a bot's goal proposal is filed under: goals are the chief of staff's to watch. */
export const BOT_FILED_UNDER = "chief_of_staff" as const;
export const MAX_DRAFT_TITLE_LENGTH = 120;
export const MAX_DRAFT_BODY_LENGTH = 4_000;

/** Proposals one agent may have open at once. */
export const MAX_OPEN_PER_AGENT = 20;
/** Proposals made in one UTC day, by the four agents together (a bot's are counted apart). */
export const MAX_PROPOSALS_PER_DAY = 40;
/**
 * Proposals one of the owner's bots may have open at once: its own bucket,
 * never the chief of staff's it is filed under. Its proposals a day are its
 * profile's (`proposalsPerDay`, convex/lib/botRules.ts).
 */
export const MAX_OPEN_PER_BOT = 20;
/** A key the owner dismissed is not proposed again for this long. */
export const DISMISSED_BLOCKS_DAYS = 30;
/** A key the owner approved is not proposed again for this long. */
export const APPROVED_BLOCKS_DAYS = 14;
/** An open proposal nobody decided is marked expired after this long. */
export const PROPOSAL_EXPIRES_DAYS = 7;
/** Decided proposals `proposals_feedback` returns. */
export const FEEDBACK_ROWS = 30;
/** How far back /approvals' "Decided" lists what became of proposals and tool calls. */
export const DECIDED_WINDOW_DAYS = 30;
/** Decided rows of each source "Decided" lists at most. */
export const DECIDED_ROWS = 300;
/** Decided proposals are kept this long. */
export const PROPOSAL_RETENTION_DAYS = 90;
/** The count on the owner's navigation item stops here. */
export const OPEN_COUNT_CAP = 99;

export const PROPOSAL_WORDS = {
  repeatOpen:
    "This is a repeat: a proposal with that dedupeKey is already open. Do not propose it again.",
  repeatDismissed: `This is a repeat: the owner dismissed a proposal with that dedupeKey in the last ${DISMISSED_BLOCKS_DAYS} days. Do not propose it again.`,
  repeatApproved: `This is a repeat: the owner approved a proposal with that dedupeKey in the last ${APPROVED_BLOCKS_DAYS} days. Do not propose it again.`,
  tooManyOpen: `That agent already has ${MAX_OPEN_PER_AGENT} proposals open. Propose no more until the owner has decided some.`,
  tooManyToday: `At most ${MAX_PROPOSALS_PER_DAY} proposals a day. Propose no more today.`,
  tooManyOpenBot: `This bot already has ${MAX_OPEN_PER_BOT} proposals open. Propose no more until the owner has decided some.`,
  tooManyTodayBot: (max: number) =>
    `This bot may make ${max.toLocaleString("en-US")} proposals a day. Propose no more today.`,
  attribution:
    "That dedupeKey begins with another proposer's id (see `expected` and `got`). Begin it with your own id (`<you>:` or `bot-<you>:`), and send your own name: " + PRODUCT.name + " files each proposal under the caller.",
  dedupeKey: `A dedupeKey is lower-case letters, digits, ":", "_" and "-", at most ${MAX_DEDUPE_KEY_LENGTH} characters.`,
  reason: "A proposal needs a reason: one or two plain sentences.",
  why: "A proposal needs `why`: one plain sentence on why it should be done. Nothing was stored.",
  urgency: "`urgency` is one of critical, high, normal or low.",
  goalLink: "That goal is not one of this company's goals: read `goals` and give its id, or leave `goalId` out.",
  sourceKind: "`source.kind` is one of deal, meeting, note, metric, task or decision.",
  sourceGone: "That source does not exist for this company: give the id a tool returned, or leave `source` out.",
  rejectReason: "A rejection needs a reason: pick one or type a few words.",
  repeatExpired: `This is a repeat: a proposal with that dedupeKey expired undecided in the last ${DISMISSED_BLOCKS_DAYS} days. Do not propose it again unless something changed; then use a new dedupeKey.`,
  repeatWithdrawnWrong: `This is a repeat: a proposal with that dedupeKey was withdrawn as wrong in the last ${WRONG_WITHDRAW_BLOCKS_DAYS} days. Do not propose it again; if it is something different, use a new dedupeKey.`,
  payload: "The payload does not fit that kind of proposal.",
  nothingToChange: "A change to a task needs at least one of assignee, due and column.",
  taskGone: "That task is no longer on the board.",
  taskElsewhere: "That task is on the other company's board.",
  cannotAssign: "That person cannot be given a task of that company.",
  dealGone: "That deal is no longer on the board.",
  dealElsewhere: "That deal is in the other market.",
  aboutGone: "What that draft is about is no longer there.",
  nextStep: "A next step needs some text.",
  title: "That needs a title.",
  body: "A draft needs some text.",
  notADate: "That is not a date.",
  tooLong: "Some of that text is too long.",
  gone: "That proposal no longer exists.",
  decided: "That proposal has already been decided.",
  fixedField: "Which task or deal a proposal is about cannot be edited. Dismiss it instead.",
  decision: "A decision needs what was decided.",
  cannotOwn: "That person cannot own a decision of that company.",
  meetingGone: "That meeting is no longer in company memory.",
  meetingElsewhere: "That meeting is the other company's.",
  notAQuarter: 'A quarter is written like "2026-Q4".',
  nothingToChangeGoal: "A change to a goal needs a new title or a new status.",
  goalGone: "That goal no longer exists.",
  goalElsewhere: "That goal is the other company's.",
  botId: "A bot is named by its profile's id: lower-case letters, digits, \"_\" and \"-\", 2 to 40, starting with a letter.",
  whoProposes: "Name the agent you run as (`agent`) or the bot you are (`bot`).",
  taskArchived: "That task is already off the board.",
  commentElsewhere: "That is the other company's.",
  handoffElsewhere: "That handoff is the other company's.",
} as const;

/**
 * Whether this caller may approve or dismiss proposals (`proposal_decide`).
 * The chief of staff only, as the endpoint authenticated them: a matched bot
 * wins, else one of the four named by the run. An argument is never read.
 */
export function mayDecideProposals(caller: { bot?: string | undefined; agent?: string | undefined }): boolean {
  if (caller.bot !== undefined) return caller.bot === "chief_of_staff";
  return caller.agent === "chief_of_staff";
}

/** What `proposal_decide` is refused with: fixed words, and `not_chief_of_staff` for the first. */
export const DECIDE_WORDS = {
  notChief:
    `Only the chief of staff may approve or dismiss a proposal, and only when ${PRODUCT.name} authenticated the caller as the chief of staff. Naming chief_of_staff in an argument does not. Nothing was changed.`,
  editOne: "An edited payload applies to one proposal. Send a single id, or leave editedPayload out. Nothing was changed.",
  editOnDismiss: "A dismissal takes no edited payload. Leave editedPayload out, or approve instead. Nothing was changed.",
} as const;

/** What `proposal_withdraw` is refused with: fixed words, beside a code (`not_owner`, `not_open`…). */
export const WITHDRAW_WORDS = {
  /** Another proposer's, or an id that is no proposal at all: the same words, so nothing can be probed. */
  notOwner: "That is not a proposal you filed. You may withdraw only your own open proposals: read `my_inbox` or `proposals_feedback` for their ids.",
  notOpen: "That proposal is no longer open: the owner decided it, it expired, or it was withdrawn already. Nothing was changed.",
  oneOf: `Give \`id\` (one proposal) or \`ids\` (up to ${MAX_WITHDRAW_IDS}), not both and not neither.`,
  replacedBy: "`replacedBy` must be another of your own proposals, of the same company as the one withdrawn. Nothing was changed.",
  contact: "Leave email addresses and phone numbers out of the note: the owner's activity shows it. Nothing was changed.",
} as const;

/** The stages a proposed deal may start at: an open stage before any terms. */
export const DEAL_CREATE_STAGES = ["lead", "qualified", "demo", "proposal"] as const;
export const MAX_DEAL_CREATE_SOURCES = 12;
export const MAX_DEAL_INTEL_SUMMARY = 300;
export const MAX_DEAL_INTEL_SIGNALS = 3;

export const DEAL_CREATE_WORDS = {
  /**
   * At the click: a name on that market's board since it was proposed (archived
   * and mirrored deals included). When proposed, the shared near-duplicate
   * check refuses it as `possible_duplicate` (convex/lib/duplicates.ts).
   */
  duplicateDeal: (dealId: string) =>
    `Possible duplicate: a deal of that name is already on the board (deal ${dealId}). Update it with deal_update or deal_next_step instead. Nothing was stored.`,
  usOnly: "Priority, region, practice size and intel are for a US deal only. Leave them out for a Kazakhstan deal.",
  stage: "A new deal starts at lead, qualified, demo or proposal.",
} as const;

// ── Questions ───────────────────────────────────────────────────────────────
// Nothing asks or answers one any more (the queued Ask was removed in the
// 2026-10 dedupe); rows already on record are deleted after this long.

/** Questions on record are kept this long. */
export const QUESTION_RETENTION_DAYS = 90;

// ── For the tools' descriptions ─────────────────────────────────────────────
// Said to the model wherever it writes text a person will read.

export const WRITING_RULES = [
  "Plain text only: no markdown, no links, no HTML. It is shown exactly as written.",
  'Say "not read yet" for a figure a tool returned as missing: never 0, never a guess.',
  "Every count and fact must come from a tool result of this run.",
  "Never name a clinic or a person unless a tool returned that name in this run.",
  "Give no advice the data does not support.",
].join(" ");
