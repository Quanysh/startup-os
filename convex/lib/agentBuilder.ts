// Agents built in Startup OS (Agents Protocol v1.3, docs/agents-protocol.md).
// A **declarative** agent is defined here entirely, from scratch: its
// instructions (a prompt with variants and sections, as v1.2's), its model,
// the tools it may use from what its project can execute, other agents built
// here it may call as sub-agents, its output schema, how it is started
// (an API endpoint, a schedule, as a sub-agent, a chat box) and its limits.
// The project's package (`@startup/agents` v0.5.0) runs it, inside the project,
// from the config: no code change in the project.
//
// What a project reports for this: its **tool catalogue** (`toolsCatalog`:
// the tools it can execute, each read or write, for patient data or not) and
// **run summaries** (`runs`: ids, states and numbers, never a word of a
// prompt, an argument or an answer).
//
// A definition is kept on its harness version (`definition`), so it goes
// draft → test → publish with the harness, and `harness.version` ("h3") is
// its version too. The rules are one pure function, `declarativeProblems`,
// asked by the page as it is typed and by the server before a test run, a
// publish and a rollback.
//
// Pure: the UI imports it. Every refusal is fixed words; an id quoted is a
// tool id or variable name, charset-limited.

import { z } from "zod";
import { AGENT_ID_PATTERN, BUDGET_WORDS, MAX_BUDGET_USD, CLOCK_SKEW_MS } from "./agentControl";
import { cronProblem, minGapMinutes } from "./agentCron";
import {
  DEFAULT_VARIANT,
  HARNESS_WORDS,
  MAX_TOOLS,
  MAX_VARIABLES,
  TOOL_KINDS,
  VARIABLE_NAME_PATTERN,
  cleanParams,
  harnessProblems,
  patientDataOnly,
  variantNames,
  versionName,
  type HarnessDefaults,
  type HarnessParts,
  type Issue,
  type Params,
  type PromptInput,
  type PromptPart,
  type ToolDecl,
  type ToolKind,
  type Variable,
  type Variants,
} from "./agentHarness";
import { AGENT_NAME_PATTERN, LAUNCH_WORDS, providerPolicyProblem } from "./agentProjects";
import { PRODUCT } from "./identity";
import { OS_AGENT_WORDS, macActForbidden } from "./osAgents";
import { stableStringify, utf8Bytes } from "./agentSchemaCompat";
import { PAY_AND_COSTS, SENSITIVE_AREAS, type Area } from "./roles";

export type { Issue };

// ── The tool catalogue (POST /agents/v1/usage, `toolsCatalog`) ─────────────

/** The most tools a project reports. */
export const MAX_CATALOG_TOOLS = 200;
/** A tool's input schema, as JSON, in UTF-8 bytes. */
export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;
/** A built agent's description (and a sub-agent's), in characters: what the builder takes. */
export const MAX_DESCRIPTION = 500;
/** A catalogue tool's name and description, in characters (the package's bounds). */
export const MAX_TOOL_NAME = 200;
export const MAX_TOOL_DESCRIPTION_V13 = 4096;
/**
 * A catalogue tool's id, as the package takes it (`defineTools`): what the
 * model sees as a function name, and what a definition's tools and approvals
 * name. Wider than v1.1's harness tool ids (capitals, a leading `_`).
 */
export const CATALOG_TOOL_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
/** What a tool does: reads, or changes something in the project (`write`: always approvable). */
export const TOOL_EFFECTS = ["read", "write"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

const inputSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => utf8Bytes(JSON.stringify(schema)) <= MAX_INPUT_SCHEMA_BYTES, "is more than 16 KB.");

/** One tool the project can execute. Strict: nothing else rides with it. */
export const catalogToolWire = z.strictObject({
  id: z.string().regex(CATALOG_TOOL_ID_PATTERN),
  name: z.string().min(1).max(MAX_TOOL_NAME),
  description: z.string().max(MAX_TOOL_DESCRIPTION_V13),
  /** Whether its result is patient data. */
  phi: z.boolean(),
  kind: z.enum(TOOL_KINDS),
  /** The JSON Schema of its arguments. */
  inputSchema,
  effect: z.enum(TOOL_EFFECTS),
  /** Whether a human may be asked to approve each call: every `function` tool; never a `provider` one. */
  approvable: z.boolean(),
});
export type CatalogToolWire = z.infer<typeof catalogToolWire>;

/** A catalogue tool as the rules read it (its schema aside). */
export type CatalogTool = {
  id: string;
  name: string;
  description: string;
  phi: boolean;
  kind: ToolKind;
  effect: ToolEffect;
  approvable: boolean;
  /**
   * The area a caller needs for it: Startup OS's own tools (the project
   * `startup-os`) only. A project's tools need none here: the project decides.
   */
  area?: Area;
};

/**
 * The areas whose tools only the owner may give an agent: payroll and costs,
 * the sensitive ones and the owner's own. An agent using one (or a sub-agent
 * that does) is published by the owner alone, and its runs and outputs are
 * the owner's.
 */
export const OWNER_ONLY_TOOL_AREAS: readonly Area[] = [...PAY_AND_COSTS, ...SENSITIVE_AREAS, "personal", "admin"];

/**
 * What the shape alone cannot say about a catalogue: no id twice; a
 * `function` tool approvable and a `provider` one not (it runs inside the
 * model call, so nothing can gate it), and so a provider tool only reads.
 */
export function catalogProblems(list: readonly CatalogToolWire[], prefix = "toolsCatalog"): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  list.forEach((tool, i) => {
    if (seen.has(tool.id)) issues.push({ path: `${prefix}.${i}`, message: "repeats an earlier tool's id." });
    seen.add(tool.id);
    if (tool.kind === "function" && !tool.approvable) {
      issues.push({ path: `${prefix}.${i}.approvable`, message: BUILDER_WORDS.functionApprovable });
    }
    if (tool.kind === "provider" && tool.approvable) {
      issues.push({ path: `${prefix}.${i}.approvable`, message: BUILDER_WORDS.providerNotApprovable });
    }
    if (tool.kind === "provider" && tool.effect === "write") {
      issues.push({ path: `${prefix}.${i}.effect`, message: BUILDER_WORDS.providerReads });
    }
  });
  return issues;
}

/** The same catalogue always prints the same: what a report's catalogue is compared by. */
export const catalogKey = (list: readonly CatalogToolWire[]): string =>
  stableStringify([...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

// ── Run summaries (POST /agents/v1/usage, `runs`) ────────────────────────────

/** The most run summaries one report carries. */
export const MAX_RUNS_PER_PUSH = 500;
/** How long a run summary is kept, from when it started. */
export const RUN_RETENTION_DAYS = 90;
export const MAX_TOOL_CALLS_PER_RUN = 100;
export const MAX_RUN_STEPS = 1000;
/** A run waiting on a human may last: thirty days. */
export const MAX_RUN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RUN_COST_USD = 1000;
/** A run's id, as the project made it: "run_01HF…", "2026-10-17:abc". */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** The version a run used (`definition.harness.version`): "h3", or a code agent's prompt version. */
export const RUN_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_:#-]{0,63}$/;
/** Why a run ended badly: a provider's class, a refusal's reason, or the runtime's own. Never a message. */
export const RUN_ERROR_CLASSES = [
  "timeout",
  "auth",
  "rate_limit",
  "server",
  "network",
  "schema",
  "agent_off",
  "over_budget",
  "phi_not_allowed",
  "config_unavailable",
  "provider_not_configured",
  "max_steps",
  "invalid_input",
  "depth_exceeded",
  "subagent_failed",
  "store",
] as const;
export type RunErrorClass = (typeof RUN_ERROR_CLASSES)[number];

export const RUN_TRIGGERS = ["api", "schedule", "subagent", "chat", "test"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const AGENT_RUN_STATUSES = ["ok", "error", "refused", "awaiting_approval", "denied", "timeout"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const TOOL_CALL_STATUSES = ["ok", "error", "denied", "skipped"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export const APPROVAL_STATES = ["approved", "denied", "pending"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const toolCallWire = z.strictObject({
  toolId: z.string().regex(CATALOG_TOOL_ID_PATTERN),
  status: z.enum(TOOL_CALL_STATUSES),
  /** Left out: the tool needs no approval. */
  approval: z.enum(APPROVAL_STATES).optional(),
});
export type ToolCall = z.infer<typeof toolCallWire>;

/** One run, as a summary: ids, states and numbers, nothing a person or a model wrote. */
export const runSummaryWire = z.strictObject({
  runId: z.string().regex(RUN_ID_PATTERN),
  agentId: z.string().regex(AGENT_ID_PATTERN),
  /** The definition version it ran ("h3"). */
  version: z.string().regex(RUN_VERSION_PATTERN),
  trigger: z.enum(RUN_TRIGGERS),
  /** The run that called it, for a sub-agent's run. */
  parentRunId: z.string().regex(RUN_ID_PATTERN).optional(),
  status: z.enum(AGENT_RUN_STATUSES),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().max(MAX_RUN_DURATION_MS),
  steps: z.number().int().nonnegative().max(MAX_RUN_STEPS),
  /** null: not priced. Never read as $0. */
  costUsd: z.number().nonnegative().max(MAX_RUN_COST_USD).nullable(),
  errorClass: z.enum(RUN_ERROR_CLASSES).nullable(),
  toolCalls: z.array(toolCallWire).max(MAX_TOOL_CALLS_PER_RUN),
});
export type RunSummaryWire = z.infer<typeof runSummaryWire>;

/** What the shape alone cannot say about a report's runs: none twice, none ahead, a sub-agent's has its parent. */
export function runsProblems(list: readonly RunSummaryWire[], now: number, prefix = "runs"): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  list.forEach((run, i) => {
    if (seen.has(run.runId)) issues.push({ path: `${prefix}.${i}`, message: "repeats an earlier run's runId." });
    seen.add(run.runId);
    if (Date.parse(run.startedAt) > now + CLOCK_SKEW_MS) {
      issues.push({ path: `${prefix}.${i}.startedAt`, message: "is in the future." });
    }
    if (run.trigger === "subagent" && run.parentRunId === undefined) {
      issues.push({ path: `${prefix}.${i}.parentRunId`, message: "is required for a sub-agent's run." });
    }
    if (run.parentRunId !== undefined && run.parentRunId === run.runId) {
      issues.push({ path: `${prefix}.${i}.parentRunId`, message: "is the run itself." });
    }
  });
  return issues;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a run that started then is still kept (RUN_RETENTION_DAYS). */
export const retainedRun = (startedAt: number, now: number): boolean => startedAt >= now - RUN_RETENTION_DAYS * DAY_MS;

/** The calls of a run still waiting on a human. */
export const pendingApprovalsOf = (calls: readonly { approval?: ApprovalState }[]): number =>
  calls.filter((call) => call.approval === "pending").length;

// ── A definition ─────────────────────────────────────────────────────────────

export type ModelChoice = { provider: string; model: string; fallbackProvider?: string; fallbackModel?: string };

export type Triggers = {
  /** POST /api/startup-agents/run/{agentId} in the project. */
  api: boolean;
  schedule?: { cron: string; variables: Record<string, string> };
  /** How other agents built here see it: a tool of this id. */
  subAgent?: { toolId: string; description: string };
  chat?: { enabled: boolean; title: string; greeting: string };
};

export type Limits = { maxSteps: number; timeoutMs: number; monthlyBudgetUsd?: number };

/**
 * What the OS keeps of a declarative agent besides its harness parts: kept on
 * each version. `model` is the OS's (it goes out as the agent's provider and
 * model, not in the definition); the rest goes out as `definition`.
 */
export type Definition = {
  name: string;
  description: string;
  input: { mode: PromptInput; variables: Variable[] };
  model?: ModelChoice;
  triggers: Triggers;
  /** The tools a human approves before each call. */
  approvals: string[];
  limits: Limits;
};

export const LIMIT_BOUNDS = {
  maxSteps: { min: 1, max: 30 },
  timeoutMs: { min: 1_000, max: 600_000 },
} as const;
export const DEFAULT_LIMITS: Limits = { maxSteps: 10, timeoutMs: 120_000 };
/** The shortest gap between two scheduled runs of an agent Startup OS runs itself, in minutes: it calls a model each time. */
export const MIN_RUNS_HERE_GAP_MINUTES = 5;
/** A schedule's value for one variable, in characters. */
export const MAX_SCHEDULE_VALUE = 2_000;
export const MAX_GREETING = 500;

export const BUILDER_WORDS = {
  agentId: "An agent's id is 1 to 64 lowercase letters, digits, dots, hyphens and underscores.",
  taken: "An agent with that id is already in this project.",
  name: LAUNCH_WORDS.name,
  description: `A description is 1 to ${MAX_DESCRIPTION} characters.`,
  variableName: "A variable's name is a lowercase letter, then up to 39 letters, digits and _.",
  variableRepeated: "names a variable twice.",
  variablesTooMany: `holds more than ${MAX_VARIABLES} variables.`,
  instructions: "Write its instructions: the system prompt is empty.",
  modelMissing: "Choose the model it runs on.",
  fallbackPair: "A fallback needs a provider and a model.",
  fallbackSame: "The fallback must differ from the model.",
  functionApprovable: "A function tool is approvable: a person may be asked before each call.",
  providerNotApprovable: "A tool built into the provider runs inside the model call: it cannot be approvable.",
  providerReads: "A tool built into the provider only reads.",
  toolUnknown: "names a tool that is neither in the project's catalogue nor another agent built here, published and offered as a sub-agent.",
  writeNeedsApproval: (id: string) => `${id} changes something in the project: it needs a human approval before each call.`,
  approvalNotOn: "asks approval for a tool the agent does not use.",
  approvalNotApprovable: "asks approval for a tool that cannot ask for it (one built into the provider).",
  subAgentBroken: "calls a sub-agent that cannot run: one of its tools is gone from the catalogue, or it calls one that cannot.",
  ownerOnlyTool:
    "uses a tool of a page only the owner may give (payroll, costs, settings, team or the owner's own): only the owner can publish it.",
  cycle: "Its sub-agents call back into it: a cycle is refused.",
  depth: "Sub-agents go more than 3 deep.",
  exposureId: "A sub-agent's tool id is a letter or _, then up to 63 letters, digits, _, . and -.",
  exposureTaken: "That tool id is already a tool in the catalogue or another agent's.",
  exposureKept: (id: string) => `Other agents call it as ${id}: keep that tool id.`,
  exposureDescription: `Say what it does for the agents that call it, in 1 to ${MAX_DESCRIPTION} characters.`,
  scheduleMessages: "A schedule gives variables only: an agent that takes a conversation cannot be scheduled.",
  scheduleTooOften: `An agent that runs in ${PRODUCT.name} runs at most every ${MIN_RUNS_HERE_GAP_MINUTES} minutes: each run calls a model.`,
  scheduleVariable: (name: string) => `gives ${name}, which is not one of its variables.`,
  scheduleRequired: (name: string) => `gives no value for the required variable ${name}.`,
  scheduleValue: `A value is at most ${MAX_SCHEDULE_VALUE.toLocaleString("en-US")} characters.`,
  chatMessages: "A chat box sends the agent a conversation: choose a conversation as its input.",
  chatRunsHere: `A chat box is not offered for an agent that runs in ${PRODUCT.name}: ask on the chat on /assistant.`,
  chatTitle: "A chat box's title is 1 to 60 letters, digits, spaces and simple punctuation.",
  chatGreeting: `A greeting is at most ${MAX_GREETING} characters.`,
  noTrigger: "Turn on at least one way to run it: an API endpoint, a schedule, as a sub-agent or a chat box.",
  maxSteps: "Steps are a whole number, 1 to 30.",
  timeout: "The time limit is 1 second to 10 minutes, in whole milliseconds.",
  budget: BUDGET_WORDS,
} as const;

/** A new agent's definition: an API endpoint on, the usual limits, nothing else yet. */
export function newDefinition(fields: { name: string; description: string; mode: PromptInput }): Definition {
  return {
    name: fields.name,
    description: fields.description,
    input: { mode: fields.mode, variables: [] },
    triggers: { api: true },
    approvals: [],
    limits: { ...DEFAULT_LIMITS },
  };
}

/** A new agent's prompt: the variant `default`, empty, with a user template unless it takes a conversation. */
export const newPrompt = (mode: PromptInput): PromptPart => ({
  variants: { [DEFAULT_VARIANT]: mode === "messages" ? { system: "" } : { system: "", user: "" } },
});

/** Another declarative agent of the project, as its published version has it. */
export type Peer = {
  agentId: string;
  name: string;
  /** The tool id it is offered to other agents as; null where it is not offered, or not published. */
  toolId: string | null;
  description: string;
  /** The tools its published version uses: catalogue ids and other agents' tool ids. */
  tools: string[];
};

/** Which peers use a flagged tool: directly, or through a sub-agent that does, however deep. */
function peerFlagOf(peers: readonly Peer[], flagged: ReadonlySet<string>): Map<string, boolean> {
  const byToolId = new Map(peers.filter((p) => p.toolId !== null).map((p) => [p.toolId!, p]));
  const out = new Map<string, boolean>();
  const visit = (peer: Peer, path: Set<string>): boolean => {
    const known = out.get(peer.agentId);
    if (known !== undefined) return known;
    if (path.has(peer.agentId)) return false;
    path.add(peer.agentId);
    const hit = peer.tools.some((id) => {
      if (flagged.has(id)) return true;
      const callee = byToolId.get(id);
      return callee !== undefined && visit(callee, path);
    });
    path.delete(peer.agentId);
    out.set(peer.agentId, hit);
    return hit;
  };
  for (const peer of peers) visit(peer, new Set());
  return out;
}

/** Which peers handle patient data: a catalogue tool that does, or a sub-agent that does, however deep. */
export const peerPhiOf = (peers: readonly Peer[], catalog: readonly CatalogTool[]): Map<string, boolean> =>
  peerFlagOf(peers, new Set(catalog.filter((tool) => tool.phi).map((tool) => tool.id)));

const ownerOnlyIds = (catalog: readonly CatalogTool[]) =>
  new Set(catalog.filter((tool) => tool.area !== undefined && OWNER_ONLY_TOOL_AREAS.includes(tool.area)).map((tool) => tool.id));

/**
 * Whether an agent's tools need an owner-only area (OWNER_ONLY_TOOL_AREAS),
 * directly or through a sub-agent, however deep: then only the owner
 * publishes it, and its runs and outputs are the owner's alone.
 */
export function usesOwnerOnlyTools(tools: readonly string[], catalog: readonly CatalogTool[], peers: readonly Peer[]): boolean {
  const flagged = ownerOnlyIds(catalog);
  const viaPeer = peerFlagOf(peers, flagged);
  const byToolId = new Map(peers.filter((p) => p.toolId !== null).map((p) => [p.toolId!, p.agentId]));
  return tools.some((id) => flagged.has(id) || viaPeer.get(byToolId.get(id) ?? "") === true);
}

/** The tools an agent built here may switch on: the catalogue's, and each published peer offered as a sub-agent. */
export function toolDeclsOf(catalog: readonly CatalogTool[], peers: readonly Peer[]): ToolDecl[] {
  const phi = peerPhiOf(peers, catalog);
  return [
    ...catalog.map((tool) => ({ id: tool.id, name: tool.name, description: tool.description, phi: tool.phi, kind: tool.kind })),
    ...peers
      .filter((peer) => peer.toolId !== null)
      .map((peer) => ({
        id: peer.toolId!,
        name: peer.name,
        description: peer.description,
        phi: phi.get(peer.agentId) === true,
        kind: "function" as const,
      })),
  ];
}

/**
 * What a declarative agent's harness is checked against, in the place of a
 * code's defaults: its own variables and input, its own variants (it may add
 * or drop any but `default`), and the tools it may switch on. With these, the
 * harness rules and the test jobs read a built agent as they read any other.
 */
export function declarativeDefaults(
  definition: Definition,
  parts: HarnessParts,
  catalog: readonly CatalogTool[],
  peers: readonly Peer[],
): HarnessDefaults {
  const names = parts.prompt === undefined ? [DEFAULT_VARIANT] : variantNames(parts.prompt.variants);
  const user = definition.input.mode === "text";
  const variants: Variants = Object.fromEntries(names.map((name) => [name, user ? { system: "", user: "" } : { system: "" }]));
  return {
    prompt: {
      version: "built-here",
      input: definition.input.mode,
      variables: definition.input.variables.map((v) => ({ name: v.name, required: v.required })),
      variants,
    },
    tools: toolDeclsOf(catalog, peers),
  };
}

/** What a rule needs besides the agent: the project's catalogue, its other built agents, its policy. */
export type BuilderContext = {
  agentId: string;
  catalog: readonly CatalogTool[];
  /** The project's other declarative agents, as published (one never published: no toolId, no tools). */
  peers: readonly Peer[];
  policy: { holdsPatientData: boolean; allowedProviders: readonly string[] };
  /** Publishing (and rolling back) also needs a model and a way to run it. */
  publishing: boolean;
  /** The tool id its published version is offered as: other agents may call it by that id. */
  publishedToolId: string | null;
  /** Whether the one publishing is the owner: tools of an owner-only area need it. Left out: not asked. */
  ownerPublishing?: boolean;
  /** Startup OS runs it itself (the project `startup-os`): no chat box there. */
  runsHere?: boolean;
  /** One of Startup OS's own four that runs on the Mac: no act tool but `propose` and `brief_write` (convex/lib/osAgents.ts). */
  macRun?: boolean;
};

/** A triggered run is depth 0, its sub-agent 1: at most 3. */
const MAX_DEPTH = 3;

/**
 * Whether a sub-agent it calls, however deep, cannot run: it uses a tool that
 * is neither in the catalogue nor another published agent's (the package does
 * not run an agent whose sub-agent is not runnable).
 */
function brokenCallee(
  tools: readonly string[],
  owner: ReadonlyMap<string, string>,
  catalogIds: ReadonlySet<string>,
  context: BuilderContext,
): boolean {
  const peers = new Map(context.peers.map((peer) => [peer.agentId, peer]));
  const seen = new Set<string>([context.agentId]);
  const queue = tools.map((id) => owner.get(id)).filter((id): id is string => id !== undefined && id !== context.agentId);
  while (queue.length > 0) {
    const agentId = queue.shift()!;
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const peer = peers.get(agentId);
    if (peer === undefined) return true;
    for (const id of peer.tools) {
      if (catalogIds.has(id)) continue;
      const callee = owner.get(id);
      if (callee === undefined) return true;
      queue.push(callee);
    }
  }
  return false;
}

/**
 * Sub-agents: the graph of agents built here, this agent as its draft has it
 * and every other as published. No cycle, and no chain deeper than 3.
 */
function graphProblems(tools: readonly string[], exposure: string | null, context: BuilderContext): Issue[] {
  const self = context.agentId;
  const owner = new Map<string, string>();
  for (const peer of context.peers) if (peer.toolId !== null) owner.set(peer.toolId, peer.agentId);
  // A catalogue tool's id stays the catalogue's: an exposure that takes it is refused below.
  const catalogIds = new Set(context.catalog.map((tool) => tool.id));
  for (const id of [context.publishedToolId, exposure]) if (id !== null && !catalogIds.has(id)) owner.set(id, self);
  const edges = new Map<string, string[]>();
  const calls = (list: readonly string[]) => list.map((id) => owner.get(id)).filter((id): id is string => id !== undefined);
  for (const peer of context.peers) edges.set(peer.agentId, calls(peer.tools));
  edges.set(self, calls(tools));

  let cycle = false;
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (node: string): number => {
    const known = depth.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) {
      cycle = true;
      return 0;
    }
    visiting.add(node);
    let deepest = 0;
    for (const next of edges.get(node) ?? []) deepest = Math.max(deepest, 1 + depthOf(next));
    visiting.delete(node);
    depth.set(node, deepest);
    return deepest;
  };
  let tooDeep = false;
  for (const node of edges.keys()) if (depthOf(node) > MAX_DEPTH) tooDeep = true;
  const issues: Issue[] = [];
  if (cycle) issues.push({ path: "subAgents", message: BUILDER_WORDS.cycle });
  else if (tooDeep) issues.push({ path: "subAgents", message: BUILDER_WORDS.depth });
  else if (brokenCallee(tools, owner, catalogIds, context)) issues.push({ path: "subAgents", message: BUILDER_WORDS.subAgentBroken });
  return issues;
}

function inBounds(value: number | undefined, min: number, max: number): boolean {
  return value !== undefined && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Every rule a declarative agent is held to before it is tested (and, with
 * `publishing`, published): its name and description; its variables; its
 * instructions and harness by the harness rules (its own variables and
 * variants); its model, held to the project's providers; tools from the
 * catalogue or published sub-agents only, each once; every write tool
 * approved, and approvals only on approvable tools it uses; a tool for
 * patient data (or a sub-agent using one) only on providers for patient
 * data, fallback included; no sub-agent cycle and at most 3 deep; a valid
 * UTC cron with its variables; a chat box only for a conversation; at least
 * one way to run it; limits in bounds.
 */
export function declarativeProblems(definition: Definition, parts: HarnessParts, context: BuilderContext): Issue[] {
  const issues: Issue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!AGENT_NAME_PATTERN.test(definition.name.trim())) push("name", BUILDER_WORDS.name);
  const description = definition.description.trim();
  if (description.length === 0 || description.length > MAX_DESCRIPTION) push("description", BUILDER_WORDS.description);

  const variables = definition.input.variables;
  if (variables.length > MAX_VARIABLES) push("input.variables", BUILDER_WORDS.variablesTooMany);
  if (variables.some((v) => !VARIABLE_NAME_PATTERN.test(v.name))) push("input.variables", BUILDER_WORDS.variableName);
  if (new Set(variables.map((v) => v.name)).size !== variables.length) push("input.variables", BUILDER_WORDS.variableRepeated);

  // The model, held to the project's providers and to patient data where its tools need it.
  const model = definition.model;
  if (model === undefined) {
    if (context.publishing) push("model", BUILDER_WORDS.modelMissing);
  } else {
    const problem = providerPolicyProblem(model.provider, context.policy, false);
    if (problem !== null) push("model", problem);
    if ((model.fallbackProvider === undefined) !== (model.fallbackModel === undefined)) push("model", BUILDER_WORDS.fallbackPair);
    else if (model.fallbackProvider !== undefined) {
      if (model.fallbackProvider === model.provider && model.fallbackModel === model.model) push("model", BUILDER_WORDS.fallbackSame);
      const fallback = providerPolicyProblem(model.fallbackProvider, context.policy, false);
      if (fallback !== null && problem === null) push("model", fallback);
    }
  }

  // The harness: its prompt (written; its own variants, `default` among them), parameters, schema.
  const prompt = parts.prompt;
  const decls = toolDeclsOf(context.catalog, context.peers);
  const defaults = declarativeDefaults(definition, parts, context.catalog, context.peers);
  if (prompt === undefined) push(`prompt.${DEFAULT_VARIANT}.system`, BUILDER_WORDS.instructions);
  else if (prompt.variants[DEFAULT_VARIANT] === undefined) push("prompt", HARNESS_WORDS.variantDefault);
  else if (prompt.variants[DEFAULT_VARIANT].system.trim() === "") push(`prompt.${DEFAULT_VARIANT}.system`, BUILDER_WORDS.instructions);
  const harness = harnessProblems(
    { ...(prompt === undefined ? {} : { prompt }), ...(parts.params === undefined ? {} : { params: parts.params }), ...(parts.outputSchema === undefined ? {} : { outputSchema: parts.outputSchema }) },
    { defaults: { ...defaults, tools: [] }, patientProviders: true },
  );
  issues.push(...harness);

  // Tools: the catalogue's, or a published agent offered as a sub-agent; itself is a cycle, below.
  const tools = parts.tools ?? [];
  const exposure = definition.triggers.subAgent?.toolId ?? null;
  const known = new Map(decls.map((tool) => [tool.id, tool]));
  const ownIds = new Set([exposure, context.publishedToolId].filter((id): id is string => id !== null));
  if (tools.length > MAX_TOOLS) push("tools", HARNESS_WORDS.toolsTooMany);
  if (new Set(tools).size !== tools.length) push("tools", HARNESS_WORDS.toolRepeated);
  if (tools.some((id) => !known.has(id) && !ownIds.has(id))) push("tools", BUILDER_WORDS.toolUnknown);
  const phi = tools.some((id) => known.get(id)?.phi === true);
  if (phi && !(model !== undefined && patientDataOnly(model.provider, model.fallbackProvider ?? null))) {
    push("tools", HARNESS_WORDS.phiTool);
  }
  // On the Mac nothing waits for an approval: only proposing and the brief may change anything.
  if (context.macRun === true && tools.some(macActForbidden)) push("tools", OS_AGENT_WORDS.macActTool);
  if (context.publishing && context.ownerPublishing === false && usesOwnerOnlyTools(tools, context.catalog, context.peers)) {
    push("tools", BUILDER_WORDS.ownerOnlyTool);
  }

  // Approvals: forced for every write tool it uses; only on approvable tools it uses.
  const catalog = new Map(context.catalog.map((tool) => [tool.id, tool]));
  const approvals = new Set(definition.approvals);
  for (const id of tools) {
    if (catalog.get(id)?.effect === "write" && !approvals.has(id)) push("approvals", BUILDER_WORDS.writeNeedsApproval(id));
  }
  if (definition.approvals.some((id) => !tools.includes(id))) push("approvals", BUILDER_WORDS.approvalNotOn);
  // A sub-agent may be approved before each call; a catalogue tool only where it is approvable.
  else if (definition.approvals.some((id) => catalog.has(id) && catalog.get(id)!.approvable !== true)) {
    push("approvals", BUILDER_WORDS.approvalNotApprovable);
  }

  issues.push(...graphProblems(tools, exposure, context));

  // Triggers.
  const triggers = definition.triggers;
  const schedule = triggers.schedule;
  if (schedule !== undefined) {
    const cron = cronProblem(schedule.cron);
    if (cron !== null) push("triggers.schedule.cron", cron);
    else if (context.runsHere === true && (minGapMinutes(schedule.cron) ?? 0) < MIN_RUNS_HERE_GAP_MINUTES) {
      push("triggers.schedule.cron", BUILDER_WORDS.scheduleTooOften);
    }
    if (definition.input.mode === "messages") push("triggers.schedule", BUILDER_WORDS.scheduleMessages);
    else {
      const declared = new Set(variables.map((v) => v.name));
      for (const name of Object.keys(schedule.variables)) {
        if (!declared.has(name)) {
          push("triggers.schedule.variables", BUILDER_WORDS.scheduleVariable(VARIABLE_NAME_PATTERN.test(name) ? name : "*"));
        }
      }
      for (const variable of variables) {
        if (variable.required && (schedule.variables[variable.name] ?? "").trim() === "") {
          push("triggers.schedule.variables", BUILDER_WORDS.scheduleRequired(variable.name));
        }
      }
      if (Object.values(schedule.variables).some((value) => value.length > MAX_SCHEDULE_VALUE)) {
        push("triggers.schedule.variables", BUILDER_WORDS.scheduleValue);
      }
    }
  }
  const subAgent = triggers.subAgent;
  if (subAgent !== undefined) {
    const peerIds = new Set(context.peers.map((peer) => peer.toolId).filter((id): id is string => id !== null));
    if (!CATALOG_TOOL_ID_PATTERN.test(subAgent.toolId)) push("triggers.subAgent.toolId", BUILDER_WORDS.exposureId);
    else if (catalog.has(subAgent.toolId) || peerIds.has(subAgent.toolId)) push("triggers.subAgent.toolId", BUILDER_WORDS.exposureTaken);
    const sub = subAgent.description.trim();
    if (sub.length === 0 || sub.length > MAX_DESCRIPTION) push("triggers.subAgent.description", BUILDER_WORDS.exposureDescription);
  }
  // Published and called by others: it keeps the tool id they call it by.
  const calledBy = context.publishedToolId;
  if (calledBy !== null && context.peers.some((peer) => peer.tools.includes(calledBy)) && subAgent?.toolId !== calledBy) {
    push("triggers.subAgent.toolId", BUILDER_WORDS.exposureKept(calledBy));
  }
  const chat = triggers.chat;
  if (chat?.enabled === true) {
    if (context.runsHere === true) push("triggers.chat", BUILDER_WORDS.chatRunsHere);
    if (definition.input.mode !== "messages") push("triggers.chat", BUILDER_WORDS.chatMessages);
    if (!AGENT_NAME_PATTERN.test(chat.title.trim())) push("triggers.chat.title", BUILDER_WORDS.chatTitle);
    if (chat.greeting.length > MAX_GREETING) push("triggers.chat.greeting", BUILDER_WORDS.chatGreeting);
  }
  const runnable = triggers.api || schedule !== undefined || subAgent !== undefined || chat?.enabled === true;
  if (!runnable && context.publishing) push("triggers", BUILDER_WORDS.noTrigger);

  // Limits.
  const limits = definition.limits;
  if (!inBounds(limits.maxSteps, LIMIT_BOUNDS.maxSteps.min, LIMIT_BOUNDS.maxSteps.max)) push("limits.maxSteps", BUILDER_WORDS.maxSteps);
  if (!inBounds(limits.timeoutMs, LIMIT_BOUNDS.timeoutMs.min, LIMIT_BOUNDS.timeoutMs.max)) push("limits.timeoutMs", BUILDER_WORDS.timeout);
  const budget = limits.monthlyBudgetUsd;
  if (budget !== undefined && !(Number.isFinite(budget) && budget > 0 && budget <= MAX_BUDGET_USD)) {
    push("limits.monthlyBudgetUsd", BUILDER_WORDS.budget);
  }
  return issues;
}

/** Whether a declarative agent's tools (or its sub-agents', however deep) handle patient data. */
export function definitionPhi(tools: readonly string[], catalog: readonly CatalogTool[], peers: readonly Peer[]): boolean {
  const decls = new Map(toolDeclsOf(catalog, peers).map((tool) => [tool.id, tool]));
  return tools.some((id) => decls.get(id)?.phi === true);
}

// ── What goes out ────────────────────────────────────────────────────────────

/** `definition` on an agent in GET /agents/v1/config (v1.3). */
export type ConfigDefinition = {
  name: string;
  description: string;
  input: { mode: PromptInput; variables: Variable[] };
  harness: {
    version: string;
    prompt: PromptPart;
    params?: Params;
    tools: string[];
    output?: { schema: unknown };
  };
  triggers: Triggers;
  approvals: string[];
  limits: Limits;
};

const schemaValue = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
};

/**
 * A declarative version as the config (and a test job) carries it: the
 * harness whole, its prompt always as variants, `version` its name ("h3",
 * or a draft's "draft-h3.2"). The model is not in it: it is the agent's
 * provider and model beside it.
 */
export function definitionOut(number: number | string, definition: Definition, parts: HarnessParts): ConfigDefinition {
  const variants = parts.prompt?.variants ?? {};
  const triggers = definition.triggers;
  return {
    name: definition.name,
    description: definition.description,
    input: {
      mode: definition.input.mode,
      variables: definition.input.variables.map((v) => ({ name: v.name, required: v.required })),
    },
    harness: {
      version: typeof number === "number" ? versionName(number) : number,
      prompt: {
        variants: Object.fromEntries(
          variantNames(variants).map((name) => {
            const variant = variants[name]!;
            return [name, variant.user === undefined ? { system: variant.system } : { system: variant.system, user: variant.user }];
          }),
        ),
      },
      ...(parts.params === undefined ? {} : { params: cleanParams(parts.params) }),
      tools: [...(parts.tools ?? [])],
      ...(parts.outputSchema === undefined ? {} : { output: { schema: schemaValue(parts.outputSchema) } }),
    },
    triggers: {
      api: triggers.api,
      ...(triggers.schedule === undefined
        ? {}
        : { schedule: { cron: triggers.schedule.cron.trim().split(/\s+/).join(" "), variables: { ...triggers.schedule.variables } } }),
      ...(triggers.subAgent === undefined
        ? {}
        : { subAgent: { toolId: triggers.subAgent.toolId, description: triggers.subAgent.description } }),
      ...(triggers.chat === undefined || !triggers.chat.enabled
        ? {}
        : { chat: { enabled: true, title: triggers.chat.title, greeting: triggers.chat.greeting } }),
    },
    approvals: [...definition.approvals],
    limits: {
      maxSteps: definition.limits.maxSteps,
      timeoutMs: definition.limits.timeoutMs,
      ...(definition.limits.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: definition.limits.monthlyBudgetUsd }),
    },
  };
}

/** Where a project serves an agent's API trigger (the package's handler; the host authorises). */
export const runPath = (agentId: string) => `/api/startup-agents/run/${agentId}`;
/** Where a project serves an agent's chat box. */
export const chatPath = (agentId: string) => `/api/startup-agents/chat/${agentId}`;
/** The chat box, as the project's app embeds it (`@startup/agents/react`). */
export const embedSnippet = (agentId: string) => `<StartupAgentChat agentId="${agentId}" />`;

/**
 * The model a new agent built here starts on (the owner's choice,
 * 2026-10-17): Gemini on Google AI Studio, where the project may use it. A
 * project that holds patient data has none preselected (Vertex AI only).
 */
export const DEFAULT_BUILDER_MODEL = { provider: "ai_studio", model: "gemini-3.8-flash" } as const;

/** The model a new agent starts on in a project with this policy, or none. */
export function defaultModelFor(policy: { holdsPatientData: boolean; allowedProviders: readonly string[] }): ModelChoice | undefined {
  if (policy.holdsPatientData || !policy.allowedProviders.includes(DEFAULT_BUILDER_MODEL.provider)) return undefined;
  return { provider: DEFAULT_BUILDER_MODEL.provider, model: DEFAULT_BUILDER_MODEL.model };
}
