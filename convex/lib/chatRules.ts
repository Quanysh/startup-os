// The owner's live chat on /assistant: its limits, its closed sets and every
// fixed sentence. Pure: nothing here reads a table, a clock or the
// environment, so the server (convex/lib/chat.ts), the page and the runner on
// the owner's Mac (scripts/assistantRunner.ts) quote the same thing.
//
// **No model runs on the server and none is called from it** (the owner's
// decision of 2026-10-13: "reuse this Claude, not an API key"). A question
// waits in the OS until the runner on the owner's Mac claims it, and the
// answer is written by Claude Code there, on the owner's own subscription,
// through the same endpoint and token as everything else his Claude does.
//
// The question is the owner's typed text and the answer a model's: both are
// cleaned, bounded, stored as plain text and rendered as text. Every refusal
// and every failure here is fixed words: none is built from what was sent,
// and none carries anything the Mac's Claude printed.

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_CHAT_QUESTION_LENGTH = 2_000;
/** An answer, whole or partial. Over this it is refused, never cut: the runner cuts first. */
export const MAX_CHAT_ANSWER_LENGTH = 6_000;
/** Tool names shown under an answer. */
export const MAX_CHAT_STEPS = 30;
/** Proposals one answer may put under itself. */
export const MAX_CHAT_PROPOSALS = 10;
/** Questions asked in one UTC day. */
export const MAX_CHAT_QUESTIONS_PER_DAY = 200;
export const MAX_THREAD_TITLE_LENGTH = 80;
/** Messages one conversation holds, questions and answers together. */
export const MAX_THREAD_MESSAGES = 200;
/** Conversations the page lists, newest first. */
export const CHAT_THREADS_SHOWN = 50;
/** A conversation nobody has added to for this long is deleted. */
export const CHAT_RETENTION_DAYS = 90;

/** Earlier messages the answering model is given, newest kept. */
export const CHAT_HISTORY_MESSAGES = 20;
/** And at most this many bytes of them. */
export const CHAT_HISTORY_BYTES = 8_000;

/** How long a claimed question is the runner's before another may take it. Each progress extends it. */
export const CHAT_CLAIM_MS = 3 * 60 * 1000;
/** A question is claimed at most this many times: once, and once more after a claim ran out. */
export const MAX_CHAT_CLAIMS = 2;

/** The runner is "there" while its last check-in is no older than its own interval plus this. */
export const RUNNER_FRESH_MS = 30_000;
/** The longest interval a runner may say it checks in at. */
export const MAX_RUNNER_EVERY_MS = 120_000;
/**
 * Calls of the three runner tools one token may make in a ten-minute window,
 * counted apart from the 120 a model has. A runner that polls every 3 s makes
 * 200; one that answers without a pause and reports every 700 ms makes about
 * 860.
 */
export const MAX_RUNNER_CALLS_PER_WINDOW = 1_200;

// ── The closed sets ─────────────────────────────────────────────────────────

export const CHAT_STATUSES = ["queued", "working", "done", "failed"] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/** Why an answer failed. A key is stored; the sentence is said from here. */
export const CHAT_FAILURES = {
  tooLong: "It took too long.",
  notSignedIn: "Claude is not signed in on this Mac.",
  notStarted: "Claude could not be started.",
  usageLimit: "Claude's usage limit was reached.",
  stopped: "Stopped.",
  wrong: "Something went wrong.",
  gaveUp: "Your Mac stopped answering part-way.",
} as const;
export type ChatFailure = keyof typeof CHAT_FAILURES;
export const CHAT_FAILURE_KEYS = Object.keys(CHAT_FAILURES) as ChatFailure[];

/** The failures the runner may report. "Stopped" is the owner's and "gave up" the server's. */
export const RUNNER_FAILURES = ["tooLong", "notSignedIn", "notStarted", "usageLimit", "wrong"] as const;
export type RunnerFailure = (typeof RUNNER_FAILURES)[number];

/** Which of the owner's agents the chat writes as: the one that "answers what you ask here". */
export const CHAT_AGENT = "chief_of_staff";

/**
 * The tools the answering Claude is allowed: every read tool, and `propose`.
 * It changes nothing itself. Pinned here, where the runner can read it without
 * loading the server's registry; a test fails if it is not exactly the
 * registry's read tools and `propose` (convex/chat.test.ts).
 */
export const CHAT_READ_TOOLS = [
  "whoami",
  "bot_rules",
  "overview",
  "metrics",
  "tasks",
  "deals",
  "investors",
  "partners",
  "contacts",
  "contact_intro_paths",
  "customers",
  "pull_requests",
  "repositories",
  "obligations",
  "compliance_evidence",
  "sources",
  "support",
  "people",
  "goals",
  "costs",
  "decisions",
  "meetings",
  "notes",
  "linkedin_posts",
  "budget",
  "handoffs",
  "comments",
  "agents",
  "brief_latest",
  "proposals_open",
  "proposals_feedback",
  "outcomes",
] as const;
export const CHAT_TOOLS = [...CHAT_READ_TOOLS, "propose"] as const;
export type ChatTool = (typeof CHAT_TOOLS)[number];

/**
 * The runner program's own: the chat's three, and the three it runs Startup OS's
 * own four agents with (convex/lib/osAgentRuns.ts). Never given to a model,
 * and not in `tools/list`.
 */
export const RUNNER_TOOLS = [
  "chat_next",
  "chat_progress",
  "chat_finish",
  "os_agents_due",
  "os_agent_start",
  "os_agent_finish",
] as const;

/** Every other tool of the endpoint: denied to the answering Claude by name. */
export const CHAT_DENIED_TOOLS = [
  "task_create",
  "task_update",
  "task_move",
  "deal_update",
  "investor_update",
  "investor_create",
  "customer_update",
  "partner_upsert",
  "partner_move",
  "contact_upsert",
  "contact_link",
  "contact_merge",
  "note_create",
  "decision_create",
  "handoff_create",
  "handoff_update",
  "questionnaire_upsert",
  "answer_bank_upsert",
  "vendor_agreement_upsert",
  "evidence_upsert",
  "linkedin_post_upsert",
  "linkedin_stats_add",
  "brief_write",
  // They only propose, but the chat proposes through `propose` alone.
  "goal_create",
  "goal_update",
  // The chat takes nothing back: the owner dismisses on /approvals.
  "proposal_withdraw",
  "note_write",
  "comment_create",
  "task_archive",
  "handoff_reassign",
  "proposal_sweep",
  // The chief of staff bot decides in its own chat. The answering Claude here only proposes.
  "proposal_decide",
  // A bot's own (botRules.BOT_OWN_TOOLS): they refuse any caller that is not a bot.
  "permission_request",
  "my_inbox",
  "dev_request",
  // What came of a play: a bot logs its own (Bot Loop v3).
  "outcome_log",
  ...RUNNER_TOOLS,
] as const;

/** What a step is called under an answer. The one place a tool's name becomes words. */
export const STEP_LABELS: Record<ChatTool, string> = {
  whoami: "Read who it is",
  bot_rules: "Read the bots' rules",
  overview: "Read what needs attention",
  metrics: "Read figures",
  tasks: "Read tasks",
  deals: "Read deals",
  investors: "Read investors",
  partners: "Read partners",
  contacts: "Read contacts",
  contact_intro_paths: "Read who can introduce",
  customers: "Read clinics",
  pull_requests: "Read pull requests",
  repositories: "Read repositories",
  obligations: "Read obligations",
  compliance_evidence: "Read questionnaires, agreements and evidence",
  sources: "Read sources",
  support: "Read the support inbox",
  people: "Read people",
  goals: "Read goals",
  costs: "Read costs",
  decisions: "Read decisions",
  meetings: "Read meeting notes",
  notes: "Read notes",
  linkedin_posts: "Read LinkedIn posts",
  budget: "Read the budget",
  handoffs: "Read handoffs between bots",
  comments: "Read comments",
  agents: "Read the projects' agents",
  brief_latest: "Read the brief",
  proposals_open: "Read open proposals",
  proposals_feedback: "Read your decisions",
  outcomes: "Read what came of the bots' plays",
  propose: "Made a proposal",
};

export const isChatTool = (name: unknown): name is ChatTool =>
  (CHAT_TOOLS as readonly unknown[]).includes(name);

/** The steps of an answer as stored: known tool names only, the latest `MAX_CHAT_STEPS`. */
export function knownSteps(steps: readonly unknown[]): ChatTool[] {
  return steps.filter(isChatTool).slice(-MAX_CHAT_STEPS);
}

/** The pages an answer may link to: a closed list of the app's own paths, never an address a model chose. */
export const CHAT_PAGES = [
  "/",
  "/board",
  "/finance",
  "/product",
  "/engineering",
  "/sales",
  "/fundraising",
  "/partnerships",
  "/contacts",
  "/customers",
  "/compliance",
  "/gtm",
  "/linkedin",
  "/memory",
  "/support",
  "/assistant",
] as const;

// ── The words ───────────────────────────────────────────────────────────────

export const CHAT_WORDS = {
  empty: "Type a question first.",
  tooLong: `A question may be at most ${MAX_CHAT_QUESTION_LENGTH.toLocaleString("en-US")} characters.`,
  busy: "This conversation is still being answered. Wait for the answer, or stop it.",
  tooManyToday: `At most ${MAX_CHAT_QUESTIONS_PER_DAY} questions a day.`,
  full: "This conversation is full. Start a new one.",
  threadGone: "That conversation no longer exists.",
  messageGone: "That message no longer exists.",
  noTitle: "A conversation needs a name.",
  titleTooLong: `A name may be at most ${MAX_THREAD_TITLE_LENGTH} characters.`,
  /** To the runner, for a question that is no longer its to answer. */
  abandon:
    "That answer is no longer wanted: it was stopped, finished, or taken by another runner. Abandon it.",
  answerTooLong: `An answer may be at most ${MAX_CHAT_ANSWER_LENGTH.toLocaleString("en-US")} characters.`,
  emptyAnswer: "An answer needs some text.",
  /** To the answering model, for a `chatMessageId` that is not an answer in progress. */
  notAnswering: "That chatMessageId is not an answer in progress. Leave it out, or use the one you were given.",
  tooManyProposals: `One answer may put at most ${MAX_CHAT_PROPOSALS} proposals under itself.`,
} as const;

// ── For the page ────────────────────────────────────────────────────────────

/**
 * Whether the runner on the owner's Mac is there: it checked in no longer
 * ago than its own interval plus `RUNNER_FRESH_MS`. The page asks, with its
 * own clock (a query never reads one).
 */
export function runnerIsThere(
  runner: { checkedInAt: number | null; everyMs: number | null },
  now: number,
): boolean {
  if (runner.checkedInAt === null) return false;
  const every = Math.min(Math.max(runner.everyMs ?? 0, 0), MAX_RUNNER_EVERY_MS);
  return now - runner.checkedInAt <= every + RUNNER_FRESH_MS;
}
