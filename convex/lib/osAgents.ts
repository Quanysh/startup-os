// Startup OS's own four agents (the chief of staff, the engineering manager,
// sales and pipeline, finance and compliance: `AGENT_IDS`), kept since the
// owner's decision of 2026-10-17 as harness-managed agents of the project
// `startup-os`, like any agent built there: versions, draft → test → publish,
// rollback. Their ids are the ones `agentSettings` (their switch) and
// `agentCalls` (their calls) already use.
//
// Each one **runs on** what the owner chose: `claude_mac`, the runner on the
// owner's Mac (Claude Code, the default, as before), or `gemini`, Startup OS's
// own runtime (convex/agentRuntime.ts). Only one runner runs an agent: the
// Mac skips a `gemini` agent and the runtime's schedule skips a `claude_mac`
// one. Their code's defaults (the prompt, the tools, the schedule) are
// docs/agents/ (convex/lib/osAgentDefaults.ts, Convex only).
//
// Pure: the UI imports it.

import { AGENT_IDS, isAgentId, type AgentId } from "./agents";
import { nextRuns } from "./agentCron";
import { INTERNAL_PROJECT } from "./agentProjects";
import { HEADERS, PRODUCT } from "./identity";

export const RUNS_ON = ["claude_mac", "gemini"] as const;
export type RunsOn = (typeof RUNS_ON)[number];
/** Where the four run until the owner says otherwise: on the Mac, as they always have. */
export const DEFAULT_RUNS_ON: RunsOn = "claude_mac";

export const isRunsOn = (value: unknown): value is RunsOn => (RUNS_ON as readonly unknown[]).includes(value);

/** What each is called on the page: a chip and a choice. */
export const RUNS_ON_WORDS: Record<RunsOn, string> = {
  claude_mac: "Claude on the Mac",
  gemini: `Gemini in ${PRODUCT.name}`,
};

/** What each means, in a line, beside the choice. */
export const RUNS_ON_LINES: Record<RunsOn, string> = {
  claude_mac:
    "The runner on the owner's Mac starts Claude Code at its scheduled times, with its published instructions and only its tools. Nothing runs while the Mac is off; a run missed is started when the Mac is back, the same day.",
  gemini:
    `${PRODUCT.name} runs it itself, on Gemini, at its scheduled times. Every change it would make waits for the owner's approval on its Runs tab.`,
};

/** On the Mac nothing waits for an approval, so it may change nothing but what it proposes and the brief. */
export const MAC_TOOLS_LINE =
  `On the Mac it may read, propose and write the brief, nothing else: no approval waits there. A tool that changes something needs Gemini in ${PRODUCT.name}, where each call waits for the owner's approval.`;

/** Whether an agent of a project is one of Startup OS's own four. */
export const isOsAgent = (project: string, agentId: string): agentId is AgentId =>
  project === INTERNAL_PROJECT && isAgentId(agentId);

/**
 * Where an agent runs: one of the four by its setting (the Mac when none is
 * kept); any other agent of `startup-os` in Startup OS; a project's agent in its
 * project (null).
 */
export function runsOnOf(project: string, agentId: string, stored: RunsOn | null | undefined): RunsOn | null {
  if (project !== INTERNAL_PROJECT) return null;
  if (isAgentId(agentId)) return stored ?? DEFAULT_RUNS_ON;
  return "gemini";
}

/**
 * The order the Mac runs them in when several are due at once: the chief of
 * staff last, so it can be handed the others' lines (docs/agents/run.md).
 */
export const OS_AGENT_RUN_ORDER: readonly AgentId[] = ["engineering", "sales", "finance", "chief_of_staff"];

/**
 * The tools each may use by default: what its own file in docs/agents/ tells
 * it to call, and the run's first steps (`sources`, `proposals_feedback`,
 * `proposals_open`). Never `task_create`, `task_update`, `task_move` or
 * `deal_update`, `investor_update`, `investor_create`, `customer_update`, `partner_upsert` or `partner_move`, which its file names only to forbid; never a runner's tool.
 * A test holds each list to its file.
 */
export const OS_AGENT_TOOLS: Readonly<Record<AgentId, readonly string[]>> = {
  chief_of_staff: [
    "sources",
    "proposals_feedback",
    "proposals_open",
    "brief_latest",
    "overview",
    "metrics",
    "goals",
    "decisions",
    "meetings",
    "people",
    "propose",
    "proposal_withdraw",
    "proposal_sweep",
    "brief_write",
    "goal_update",
    "goal_create",
  ],
  engineering: [
    "sources",
    "proposals_feedback",
    "proposals_open",
    "pull_requests",
    "repositories",
    "tasks",
    "people",
    "agents",
    "propose",
    "proposal_withdraw",
    "proposal_sweep",
  ],
  sales: ["sources", "proposals_feedback", "proposals_open", "deals", "investors", "metrics", "propose", "proposal_withdraw", "proposal_sweep"],
  finance: [
    "sources",
    "proposals_feedback",
    "proposals_open",
    "metrics",
    "budget",
    "costs",
    "customers",
    "obligations",
    "people",
    "tasks",
    "propose",
    "proposal_withdraw",
    "proposal_sweep",
  ],
};

/**
 * The act tools any of the four may be given (convex/lib/mcpTools.ts): each
 * is in its `approvals`. A test holds this to the registry's act tools that
 * are not a runner's.
 */
export const OS_AGENT_ACT_TOOLS = ["task_create", "task_update", "task_move", "deal_update", "investor_update", "investor_create", "customer_update", "partner_upsert", "partner_move", "contact_upsert", "contact_link", "contact_merge", "note_create", "decision_create", "handoff_create", "handoff_update", "questionnaire_upsert", "answer_bank_upsert", "vendor_agreement_upsert", "evidence_upsert", "linkedin_post_upsert", "linkedin_stats_add", "brief_write", "propose", "goal_create", "goal_update", "proposal_withdraw", "note_write", "comment_create", "task_archive", "handoff_reassign", "proposal_sweep", "proposal_decide"] as const;

/**
 * The act tools an agent on the Mac may have: each only stores something for
 * the owner (a proposal to approve, the brief) or takes back its own open
 * proposal (`proposal_withdraw`). `proposal_decide` is not among them: it
 * carries a proposal out at once, and on the Mac nothing waits for a click.
 * Any other act tool would change the board at once with nobody's click:
 * refused at save and publish, and never admitted to a call of a Mac run.
 * On Gemini every act tool waits for the owner's click.
 */
export const MAC_ACT_TOOLS = ["propose", "brief_write", "goal_create", "goal_update", "proposal_withdraw", "proposal_sweep"] as const;

/** Whether a tool is one no agent on the Mac may have: an act tool that changes something at once. */
export const macActForbidden = (tool: string): boolean =>
  (OS_AGENT_ACT_TOOLS as readonly string[]).includes(tool) && !(MAC_ACT_TOOLS as readonly string[]).includes(tool);

/**
 * The schedule each starts on: once a day at 06:20 UTC, which is 11:20 in
 * Almaty (UTC+5 all year), after the morning's reads (docs/setup.md).
 * The afternoon's light run of before is gone: it only answered questions,
 * which nothing asks any more, or stood in for a morning run the Mac missed,
 * which the Mac's catch-up now does.
 */
export const OS_AGENT_DEFAULT_CRON = "20 6 * * *";

/** A run's bounds: 30 turns and ten minutes, the most an agent here may have. */
export const OS_AGENT_LIMITS = { maxSteps: 30, timeoutMs: 600_000 } as const;

/** How long after its time a run the Mac missed (it was off, or asleep) is still started. */
export const MAC_CATCH_UP_MS = 6 * 60 * 60 * 1000;
/** How long a run the Mac started may go unfinished before it is ended as timed out: from its own start. */
export const MAC_RUN_STUCK_MS = 20 * 60 * 1000;
/**
 * How long a run handed out may wait for the runner to start it: the runs
 * before it in the same check (four at most, ten minutes each) and more.
 * One never started by then is ended as timed out.
 */
export const MAC_START_WITHIN_MS = 60 * 60 * 1000;

/**
 * The latest time a schedule was due at or before `now` and after
 * `now - MAC_CATCH_UP_MS`, or null: what the Mac runs now (once: the server
 * remembers each time it handed out).
 */
export function macDueAt(cron: string, now: number): number | null {
  // At most one run every five minutes (MIN_RUNS_HERE_GAP_MINUTES): 72 in six hours.
  const due = nextRuns(cron, now - MAC_CATCH_UP_MS, 80).filter((at) => at <= now);
  return due.length === 0 ? null : due[due.length - 1]!;
}

/**
 * The headers the Mac's runner sends with each call Claude makes in a run
 * (in the MCP configuration it writes for that run): which of the four it is,
 * and which run. POST /mcp/v1 then lets the call use only that agent's tools.
 */
export const AGENT_HEADER = HEADERS.agent;
export const RUN_HEADER = HEADERS.run;
/** A run's id as the runner sends it back: letters, digits and dashes. */
export const MAC_RUN_ID = /^[a-z0-9-]{8,64}$/;

/** Whether a tool is in an agent's allowlist. */
export const mayCall = (allowlist: readonly string[], tool: string): boolean => allowlist.includes(tool);

/** The four, as their ids. */
export const OS_AGENT_IDS: readonly AgentId[] = AGENT_IDS;

/** Every refusal about the four is fixed words; an id quoted is one of the closed set. */
export const OS_AGENT_WORDS = {
  ownerOnly: `${PRODUCT.name}'s own four agents are the owner's: only the owner changes, tests, publishes or reads them.`,
  macTests:
    `It runs on Claude on the owner's Mac, and test runs of an agent there are not offered yet. Publish it with your override and a reason, or switch it to Gemini in ${PRODUCT.name} to test it here.`,
  macRunNow: "It runs on Claude on the owner's Mac, at its scheduled times: Run now is not offered for it yet.",
  notOsAgent: `Only ${PRODUCT.name}'s own four agents choose where they run.`,
  reserved: `That id is one of ${PRODUCT.name}'s own four agents.`,
  notAllowedTool: (agent: AgentId) => `That tool is not one the ${agent} agent may use: ${PRODUCT.name} refused it.`,
  wrongAgent: "That call names another agent than the one running.",
  runGone: "That run is not one the Mac is running.",
  unknownAgent: `That agent is not one of ${PRODUCT.name}'s own four.`,
  macActTool:
    `On the Mac a tool that changes something runs at once, with no approval: an agent there may change things only by proposing (propose) and writing the brief (brief_write). Remove the others, or run it on Gemini in ${PRODUCT.name}, where each change waits for your approval.`,
} as const;
