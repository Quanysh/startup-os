// Agents built to run in Startup OS itself (the internal project `startup-os`),
// besides those built for a connected project (convex/lib/agentBuilder.ts).
// Their definitions are kept exactly as a project's are (the same tables,
// project `startup-os`), and **Startup OS runs them** (the owner's decision of
// 2026-10-17): convex/agentRuntime.ts, on a schedule, with Run now, as a
// sub-agent and in test runs; the models are called only by
// convex/lib/modelClients.ts. Nothing here calls one.
//
// - **Tools** are Startup OS's own: the owner's agent tools (convex/lib/mcpTools.ts),
//   each read tool `read` and each act tool `write` (so always approved),
//   each tagged with the area a person needs for it (`STARTUP_OS_TOOL_AREAS`). A
//   tool of an owner-only area (payroll, costs, settings, team, the owner's
//   own) may be used only by an agent the owner publishes, and that agent's
//   runs and outputs are the owner's alone (`usesOwnerOnlyTools`).
// - **No patient data, ever**: no tool here handles any, and the providers
//   offered are Startup OS's own (`STARTUP_OS_PROVIDERS`), each shown "not
//   configured" until its Convex variables are set (names only, never a value).
//
// Pure: the UI imports it.

import { DEFAULT_BUILDER_MODEL } from "./agentBuilder";
import type { KnownProvider } from "./agentControl";
import { INTERNAL_PROJECT } from "./agentProjects";
import { GPU } from "./features";
import { PRODUCT } from "./identity";
import type { Area } from "./roles";

export const STARTUP_OS_PROJECT = INTERNAL_PROJECT;

/**
 * The area each of Startup OS's own tools needs, by the tool's name: the area
 * whose page shows what it reads or changes. The runner's own tools
 * (`chat_*`) are no agent's. A test fails until every other tool is here.
 */
export const STARTUP_OS_TOOL_AREAS: Readonly<Record<string, Area>> = {
  // Across every page: the owner's.
  overview: "personal",
  metrics: "scorecard",
  tasks: "board",
  deals: "sales",
  investors: "fundraising",
  partners: "partnerships",
  contacts: "contacts",
  contact_intro_paths: "contacts",
  customers: "customers",
  pull_requests: "engineering",
  repositories: "engineering",
  obligations: "compliance",
  compliance_evidence: "compliance",
  sources: "settings",
  // Globex's Intercom inbox: its page's own area.
  support: "support",
  people: "board",
  // Read as the Goals page reads them: the scorecard or the board (`STARTUP_OS_READ_ALSO`).
  // Proposing one (goal_create, goal_update) stays on review.
  goals: "scorecard",
  costs: "costs",
  decisions: "memory",
  meetings: "memory",
  notes: "memory",
  linkedin_posts: "gtm",
  budget: "finance",
  handoffs: "board",
  comments: "board",
  agents: "agents",
  brief_latest: "personal",
  proposals_open: "personal",
  proposals_feedback: "personal",
  task_create: "board",
  task_update: "board",
  task_move: "board",
  deal_update: "sales",
  investor_update: "fundraising",
  investor_create: "fundraising",
  customer_update: "customers",
  partner_upsert: "partnerships",
  partner_move: "partnerships",
  contact_upsert: "contacts",
  contact_link: "contacts",
  contact_merge: "contacts",
  note_create: "memory",
  note_write: "memory",
  decision_create: "memory",
  handoff_create: "board",
  handoff_update: "board",
  comment_create: "board",
  task_archive: "board",
  handoff_reassign: "board",
  questionnaire_upsert: "compliance",
  answer_bank_upsert: "compliance",
  vendor_agreement_upsert: "compliance",
  evidence_upsert: "compliance",
  linkedin_post_upsert: "gtm",
  linkedin_stats_add: "gtm",
  brief_write: "personal",
  propose: "personal",
  // They only propose (the owner approves on /approvals), on the Goals page's own
  // editing area, so a bot given write there may call them; `propose` stays `personal`.
  goal_create: "review",
  goal_update: "review",
  // Takes back the caller's own proposals: held to what `propose` asks (botRules.botMayCall).
  proposal_withdraw: "personal",
  proposal_sweep: "personal",
  // The chief of staff approves or dismisses, as the buttons do. The tool checks the caller.
  proposal_decide: "personal",
  // A bot's own (botRules.EVERY_BOT_TOOLS): any known bot may call them whatever it holds.
  permission_request: "personal",
  my_inbox: "personal",
  // A bot asks for a fix: stored and filed as a GitHub issue (convex/devRequests.ts).
  dev_request: "personal",
  // What came of a play (Bot Loop v3): logged and read on an area of its own.
  outcome_log: "outcomes",
  outcomes: "outcomes",
};

/**
 * A read tool its page opens with any of several areas: the areas besides
 * its own in `STARTUP_OS_TOOL_AREAS` that open it too, so a bot holding any one
 * of them may read it (botRules.botMayCall) and is listed it. Only reading:
 * a tool that changes something needs write on its own area.
 */
export const STARTUP_OS_READ_ALSO: Readonly<Record<string, readonly Area[]>> = {
  // goals.list is memberQuery(["scorecard", "board"]).
  goals: ["board"],
  // comments.list is memberQuery(["board", "sales"]).
  comments: ["sales"],
};

/** Every area that opens a tool of this kind: its own, and for a read the others its page takes. */
export const toolAreasOf = (tool: string, kind: "read" | "act"): readonly Area[] => {
  const area = STARTUP_OS_TOOL_AREAS[tool];
  if (area === undefined) return [];
  return kind === "read" ? [area, ...(STARTUP_OS_READ_ALSO[tool] ?? [])] : [area];
};

/** The providers Startup OS runs its own agents on. Vertex AI is left out until it has variables of its own here. */
export const STARTUP_OS_PROVIDERS: readonly KnownProvider[] = ["ai_studio", "astana_gpu"];

/** The Convex variables each provider needs before Startup OS can call it. Names only. */
export const STARTUP_OS_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  ai_studio: ["GOOGLE_GENAI_API_KEY"],
  astana_gpu: ["OPEN_MODELS_BASE_URL", "OPEN_MODELS_API_KEY"],
};

/** Models offered for each provider; any other model id may be typed. */
export const STARTUP_OS_MODELS: Readonly<Record<string, readonly string[]>> = {
  ai_studio: [DEFAULT_BUILDER_MODEL.model, "gemini-2.5-flash", "gemini-2.5-pro"],
  // What the lab's GPUs serve (convex/lib/features.ts). The lab can switch either, which is a
  // 404 there: keep a Gemini fallback.
  astana_gpu: GPU.models,
};

/** Startup OS as a project the rules read: no patient data, its own providers. */
export const STARTUP_OS_POLICY = {
  slug: STARTUP_OS_PROJECT,
  holdsPatientData: false,
  allowedProviders: [...STARTUP_OS_PROVIDERS] as string[],
};

/** Whether each of Startup OS's providers has its variables set, from the names set (never the values). */
export function providersConfigured(set: (name: string) => boolean): Record<string, boolean> {
  return Object.fromEntries(
    STARTUP_OS_PROVIDERS.map((provider) => [provider, (STARTUP_OS_PROVIDER_ENV[provider] ?? []).every((name) => set(name))]),
  );
}

/**
 * The most runs one Startup OS agent starts in a UTC day, sub-agent runs and
 * refusals included: the brake on what it spends that holds whether its runs
 * are priced or not. In this one place.
 */
export const MAX_RUNS_PER_DAY = 200;
/** The most calls one agent's runs may have waiting for the owner; past it, no new run starts. */
export const MAX_PENDING_APPROVALS = 10;

/** The longest message Run now sends a conversation agent, in characters. */
export const MAX_RUN_MESSAGE = 8_000;

export const STARTUP_OS_WORDS = {
  runsHere: `${PRODUCT.name} (runs here)`,
  howItRuns:
    `${PRODUCT.name} runs it itself: test it on its Tests tab, then it runs on its schedule, with Run now on its Runs tab, or as another agent's sub-agent. A tool that changes something waits for the owner's approval.`,
  notConfigured: "not configured",
  ownerOnly: "Its runs and outputs are the owner's: it uses a tool of a page only the owner may give.",
  noApi: `An API endpoint is not offered for an agent that runs in ${PRODUCT.name} yet: start it with Run now on its Runs tab.`,
  noChat: `A chat box is not offered for an agent that runs in ${PRODUCT.name}: ask on the chat on /assistant.`,
  approvalsHere: "Approve or deny each on Approvals (a denial needs a reason). Nothing it changes happens before you do.",
  budgetNotEnforced: `Not enforced: ${PRODUCT.name}'s runs are not priced, so no budget is ever reached. What holds is ${MAX_RUNS_PER_DAY} runs a day.`,
} as const;

/** Why Run now, a schedule or an approval was refused: fixed words, naming variables only. */
export const RUNTIME_ACTION_WORDS = {
  notPublished: "Publish it first: only a published agent runs.",
  off: "It is switched off. Switch it on to run it.",
  overBudget: "It has spent its monthly budget.",
  dailyCap: `It has started its ${MAX_RUNS_PER_DAY} runs for today (UTC). It can run again tomorrow.`,
  tooManyWaiting: `${MAX_PENDING_APPROVALS} of its calls already wait for your approval: decide those first.`,
  noModel: "It has no model to run on.",
  notConfigured: (names: readonly string[]) => `Its provider is not configured in ${PRODUCT.name}: set ${names.join(" and ")} in Convex.`,
  message: `Write the message to send it, 1 to ${MAX_RUN_MESSAGE.toLocaleString("en-US")} characters.`,
  decided: "That call was already decided.",
  denyReason: "A denial needs a reason: pick a quick one or type it.",
  gone: "That run no longer waits for an approval.",
  noAgent: `There is no agent built to run in ${PRODUCT.name} by that id.`,
  noOutput: "That run has no answer to show.",
} as const;
