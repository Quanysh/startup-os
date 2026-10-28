// The projects' agents for the local backend (convex/devSeed.ts), so the
// Agents page shows locally. Every project, agent, model and figure is made
// up and reads as made up. Pure: rows from a clock, checked by the same rules
// the endpoints hold a report to (convex/lib/devSeedAgents.test.ts).

import type { CatalogToolWire, Definition, RunSummaryWire, ToolCall } from "./agentBuilder";
import { addDays, dayOf } from "./agentControl";
import type { AgentKind, Region } from "./agentProjects";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Three made-up projects. Two look connected: their token's hash is a value
 * no token hashes to, so nothing can call as them; the third has no token
 * yet. A token is made on the page and shown once, never seeded.
 */
export const SEED_PROJECTS: readonly {
  slug: string;
  name: string;
  region: Region;
  holdsPatientData: boolean;
  allowedProviders: string[];
  /** Minutes since its last call; null: it has no token. */
  lastSeenMinutesAgo: number | null;
}[] = [
  {
    slug: "sample-clinic",
    name: "Sample Clinic App",
    region: "US",
    holdsPatientData: true,
    allowedProviders: ["vertex"],
    lastSeenMinutesAgo: 4,
  },
  {
    slug: "sample-research",
    name: "Sample Research Assistant",
    region: "US",
    holdsPatientData: false,
    allowedProviders: ["ai_studio", "vertex"],
    lastSeenMinutesAgo: 95,
  },
  {
    slug: "sample-kz",
    name: "Sample KZ Imaging",
    region: "KZ",
    holdsPatientData: false,
    allowedProviders: ["ai_studio", "astana_gpu"],
    lastSeenMinutesAgo: null,
  },
];

/** A SHA-256 no token has (one a project): the seeded projects look connected, and nothing can call as them. */
export const seedNoTokenHash = (index: number) => (index + 1).toString(16).padStart(64, "0");

/** What each project says it can run. One per project is known and not launched, for "Launch agent". */
export const SEED_CATALOG: readonly { project: string; agentId: string; name: string; phi: boolean; kind: AgentKind }[] = [
  { project: "sample-clinic", agentId: "sample-coding.extract", name: "Sample coding, extract", phi: true, kind: "code" },
  { project: "sample-clinic", agentId: "sample-coding.select", name: "Sample coding, select", phi: true, kind: "code" },
  { project: "sample-clinic", agentId: "sample-coding.verify", name: "Sample coding, verify", phi: true, kind: "code" },
  { project: "sample-research", agentId: "sample-search.rank", name: "Sample search, rank", phi: false, kind: "declarative" },
  { project: "sample-research", agentId: "sample-search.answer", name: "Sample search, answer", phi: false, kind: "code" },
  { project: "sample-kz", agentId: "sample.draft", name: "Sample draft", phi: false, kind: "code" },
];

type Agent = {
  project: string;
  agentId: string;
  promptVersion: string;
  /** Calls on an ordinary day. */
  calls: number;
  errorRate: number;
  p95Ms: number;
  /** [provider, model] by days ago: the first whose `from` the day is at or after. */
  runsOn: readonly { fromDaysAgo: number; provider: string; model: string; costPerCall: number | null }[];
};

const AGENTS: readonly Agent[] = [
  {
    project: "sample-clinic",
    agentId: "sample-coding.extract",
    promptVersion: "v2+made0up1",
    calls: 140,
    errorRate: 0.01,
    p95Ms: 3800,
    runsOn: [{ fromDaysAgo: 35, provider: "vertex", model: "made-up-pro", costPerCall: 0.004 }],
  },
  {
    // Moved from AI Studio to Vertex ten days ago: the model comparison shows both.
    project: "sample-clinic",
    agentId: "sample-coding.select",
    promptVersion: "v3+made0up2",
    calls: 120,
    errorRate: 0.03,
    p95Ms: 9200,
    runsOn: [
      { fromDaysAgo: 9, provider: "vertex", model: "made-up-pro", costPerCall: 0.006 },
      { fromDaysAgo: 35, provider: "ai_studio", model: "made-up-flash", costPerCall: 0.002 },
    ],
  },
  {
    project: "sample-research",
    agentId: "sample-search.rank",
    promptVersion: "v1+made0up4",
    calls: 600,
    errorRate: 0.005,
    p95Ms: 1400,
    runsOn: [{ fromDaysAgo: 35, provider: "ai_studio", model: "made-up-flash", costPerCall: 0.0004 }],
  },
  {
    // Self-hosted: no price, so its cost is "Not priced", never $0.
    project: "sample-kz",
    agentId: "sample.draft",
    promptVersion: "v1+made0up3",
    calls: 30,
    errorRate: 0.08,
    p95Ms: 14_500,
    runsOn: [{ fromDaysAgo: 35, provider: "astana_gpu", model: "made-up-open-72b", costPerCall: null }],
  },
];

/** A small, repeatable wobble: the same seed gives the same figures. */
const wobble = (seed: string, i: number) => {
  let h = 2166136261;
  for (const ch of `${seed}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000 - 0.5;
};

/** Thirty-five days of daily totals for each made-up agent, up to today, with its project. */
export function seedAgentUsage(now: number) {
  const today = dayOf(now);
  const rows = [];
  for (const agent of AGENTS) {
    for (let ago = 34; ago >= 0; ago--) {
      // A quiet weekend day now and then: no row, not a zero.
      if (agent.agentId === "sample.draft" && ago % 7 === 3) continue;
      const on = agent.runsOn.find((run) => ago <= run.fromDaysAgo)!;
      const calls = Math.max(1, Math.round(agent.calls * (1 + wobble(agent.agentId, ago) * 0.4)));
      const errors = Math.min(calls, Math.round(calls * agent.errorRate * (1 + wobble(`${agent.agentId}e`, ago))));
      rows.push({
        project: agent.project,
        agentId: agent.agentId,
        promptVersion: agent.promptVersion,
        provider: on.provider,
        model: on.model,
        day: addDays(today, -ago),
        calls,
        errors,
        schemaFailures: Math.min(calls - errors, Math.round(errors / 2)),
        fallbacks: Math.round(errors / 3),
        refusals: 0,
        inputTokens: calls * 2400,
        outputTokens: calls * 380,
        costUsd: on.costPerCall === null ? null : Math.round(calls * on.costPerCall * 1e4) / 1e4,
        p50Ms: Math.round(agent.p95Ms * 0.45),
        p95Ms: Math.round(agent.p95Ms * (1 + wobble(`${agent.agentId}p`, ago) * 0.3)),
      });
    }
  }
  return rows;
}

/** Each project's providers at their last check: the Kazakhstan GPU down. */
export function seedAgentProviders(now: number) {
  const at = (hours: number) => new Date(now - hours * HOUR_MS).toISOString();
  const up = (project: string, provider: string, model: string, hours: number) => ({
    project,
    provider,
    model,
    state: "up" as const,
    checkedAt: at(hours),
    lastErrorClass: null,
  });
  return [
    up("sample-clinic", "vertex", "made-up-pro", 1),
    up("sample-clinic", "vertex", "made-up-flash", 1),
    // Up, and not for patient data: never offered in this project.
    up("sample-clinic", "ai_studio", "made-up-flash", 1),
    up("sample-research", "ai_studio", "made-up-flash", 2),
    up("sample-research", "vertex", "made-up-pro", 2),
    {
      project: "sample-kz",
      provider: "astana_gpu",
      model: "made-up-open-72b",
      state: "down" as const,
      checkedAt: at(2),
      lastErrorClass: "timeout" as const,
    },
  ];
}

type Desired = {
  enabled: boolean;
  provider: string;
  model: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  monthlyBudgetUsd?: number;
};

/**
 * What was changed from the OS, oldest first in each project: the clinic's
 * three applied; the KZ project's switch still pending; and one agent
 * launched in the research project that it has not reported yet.
 */
export const SEED_AGENT_CHANGES: readonly {
  project: string;
  version: number;
  agentId: string;
  hoursAgo: number;
  before: Desired | null;
  after: Desired;
  launched?: true;
  name?: string;
}[] = [
  {
    project: "sample-clinic",
    version: 1,
    agentId: "sample-coding.select",
    hoursAgo: 10 * 24,
    before: null,
    after: { enabled: true, provider: "vertex", model: "made-up-pro" },
  },
  {
    project: "sample-clinic",
    version: 2,
    agentId: "sample-coding.select",
    hoursAgo: 9 * 24,
    before: { enabled: true, provider: "vertex", model: "made-up-pro" },
    after: {
      enabled: true,
      provider: "vertex",
      model: "made-up-pro",
      fallbackProvider: "vertex",
      fallbackModel: "made-up-flash",
    },
  },
  {
    // A budget it has since gone past this month.
    project: "sample-clinic",
    version: 3,
    agentId: "sample-coding.extract",
    hoursAgo: 5 * 24,
    before: null,
    after: { enabled: true, provider: "vertex", model: "made-up-pro", monthlyBudgetUsd: 5 },
  },
  {
    project: "sample-kz",
    version: 1,
    agentId: "sample.draft",
    hoursAgo: 3,
    before: null,
    after: { enabled: false, provider: "astana_gpu", model: "made-up-open-72b" },
  },
  {
    project: "sample-research",
    version: 1,
    agentId: "sample-search.digest",
    hoursAgo: 1,
    before: null,
    after: { enabled: true, provider: "vertex", model: "made-up-pro", monthlyBudgetUsd: 20 },
    launched: true,
    name: "Sample search, digest",
  },
];

/** Each project's latest version made, and the latest it applied. */
export const SEED_AGENT_CONFIG: readonly { project: string; latestVersion: number; appliedVersion: number }[] = [
  { project: "sample-clinic", latestVersion: 3, appliedVersion: 3 },
  { project: "sample-kz", latestVersion: 1, appliedVersion: 0 },
  { project: "sample-research", latestVersion: 1, appliedVersion: 0 },
];

// ── A harness (Protocol v1.1) ────────────────────────────────────────────────

/**
 * One made-up agent's harness, so the Harness, Tests and Versions tabs show
 * locally: the code's defaults (as its usage report would declare them),
 * nothing published (it runs the code's own harness), a draft that changes
 * the prompt, two made-up test cases, and a finished run that passed.
 */
export const SEED_HARNESS = {
  project: "sample-research",
  agentId: "sample-search.rank",
  defaults: {
    prompt: {
      version: "v1+made0up4",
      system: "You rank made-up documents for a made-up query. Answer in JSON.",
      user: "Query: {{query}}\nSource: {{source}}",
      variables: [
        { name: "query", required: true },
        { name: "source", required: false },
      ],
    },
    params: { temperature: 0.2, maxOutputTokens: 2048, thinkingBudget: 1024, timeoutMs: 60_000, retries: 1 },
    tools: [{ id: "web_search", name: "Web search", description: "Searches made-up sites.", phi: false }],
    defaultTools: ["web_search"],
    output: {
      schemaVersion: "1",
      schema: {
        type: "object",
        required: ["ranked"],
        properties: {
          ranked: {
            type: "array",
            items: {
              type: "object",
              required: ["docId", "score"],
              properties: { docId: { type: "string" }, score: { type: "number" } },
            },
          },
        },
      },
    },
  },
  draft: {
    number: 1,
    revision: 2,
    hoursAgo: 6,
    prompt: {
      system:
        "You rank made-up documents for a made-up query. Put the most specific document first. Answer in JSON.",
      user: "Query: {{query}}\nSource: {{source}}",
    },
    note: "Made-up: the most specific document first.",
  },
  cases: [
    {
      name: "Made-up sample query",
      variables: { query: "made-up sample question", source: "Sample Source" },
      expect: [
        { path: "$.ranked", op: "exists" as const, value: "true" },
        { path: "$.ranked[0].docId", op: "matches" as const, value: '"SAMPLE-\\\\d+"' },
      ],
    },
    {
      name: "Made-up query, no source",
      variables: { query: "made-up sleep study" },
      expect: [{ path: "$.ranked", op: "exists" as const, value: "true" }],
    },
  ],
  run: {
    hoursAgo: 5,
    model: { provider: "ai_studio", model: "made-up-flash" },
    outputs: [
      { ranked: [{ docId: "SAMPLE-101", score: 0.92 }, { docId: "SAMPLE-7", score: 0.4 }] },
      { ranked: [{ docId: "SAMPLE-55", score: 0.71 }] },
    ],
  },
} as const;

// ── Agents built here (Protocol v1.3) ────────────────────────────────────────

/**
 * Two made-up agents built on the page for the research project, so the
 * Builder, Runs and Tools tabs show locally: the project's tool catalogue; a
 * lookup agent offered as a sub-agent; a weekday sweep on a schedule that
 * calls it and writes a made-up note (approved by a person first); and the
 * sweep's runs, one still waiting for approval, each with its lookup run.
 */
export const SEED_BUILT = {
  project: "sample-research",
  tools: [
    {
      id: "sample.research_search",
      name: "Sample research search",
      description: "Searches made-up documents by a made-up query.",
      phi: false,
      kind: "function",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      effect: "read",
      approvable: true,
    },
    {
      id: "sample.note_write",
      name: "Sample note, write",
      description: "Adds a made-up note to the made-up document list.",
      phi: false,
      kind: "function",
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      effect: "write",
      approvable: true,
    },
    {
      id: "google_search",
      name: "Google search",
      description: "The provider's own search, on made-up queries.",
      phi: false,
      kind: "provider",
      inputSchema: { type: "object" },
      effect: "read",
      approvable: false,
    },
  ] satisfies CatalogToolWire[],
  agents: [
    {
      agentId: "sample-desk.lookup",
      hoursAgo: 30,
      definition: {
        name: "Sample record lookup",
        description: "Finds the made-up document that answers a made-up question.",
        input: { mode: "text", variables: [{ name: "query", required: true }] },
        model: { provider: "ai_studio", model: "made-up-flash" },
        triggers: { api: false, subAgent: { toolId: "doc_lookup", description: "Looks a made-up document up by a question." } },
        approvals: [],
        limits: { maxSteps: 4, timeoutMs: 30_000 },
      } satisfies Definition,
      prompt: { variants: { default: { system: "Find the made-up document that answers the question.", user: "Question: {{query}}" } } },
      tools: ["sample.research_search"],
    },
    {
      agentId: "sample-desk.sweep",
      hoursAgo: 26,
      definition: {
        name: "Sample weekday sweep",
        description: "Each weekday, notes made-up document changes for the team.",
        input: { mode: "text", variables: [{ name: "focus", required: true }] },
        model: { provider: "ai_studio", model: "made-up-flash" },
        triggers: { api: true, schedule: { cron: "0 6 * * 1-5", variables: { focus: "made-up denial rules" } } },
        approvals: ["sample.note_write"],
        limits: { maxSteps: 10, timeoutMs: 120_000, monthlyBudgetUsd: 15 },
      } satisfies Definition,
      prompt: {
        variants: {
          default: {
            system: "Sweep made-up document changes.{{#focus}} Look at {{focus}} first.{{/focus}} Write one note.",
            user: "Today's focus: {{focus}}",
          },
        },
      },
      tools: ["sample.research_search", "doc_lookup", "sample.note_write"],
    },
  ],
} as const;

/** The sweep's last three weekday runs, made up, each with the lookup it called. Newest waits for approval. */
export function seedBuiltRuns(now: number): RunSummaryWire[] {
  const runs: RunSummaryWire[] = [];
  for (const [i, hoursAgo] of [2, 26, 50].entries()) {
    const startedAt = new Date(now - hoursAgo * HOUR_MS).toISOString();
    const waiting = i === 0;
    const id = `sample-sweep-${i + 1}`;
    runs.push({
      runId: id,
      agentId: "sample-desk.sweep",
      version: "h1",
      trigger: "schedule",
      status: waiting ? "awaiting_approval" : "ok",
      startedAt,
      durationMs: waiting ? 7_200_000 : 14_000 + i * 900,
      steps: waiting ? 3 : 4,
      costUsd: 0.0031 + i * 0.0004,
      errorClass: null,
      toolCalls: [
        { toolId: "sample.research_search", status: "ok" },
        { toolId: "doc_lookup", status: "ok" },
        waiting
          ? { toolId: "sample.note_write", status: "skipped", approval: "pending" }
          : { toolId: "sample.note_write", status: "ok", approval: "approved" },
      ],
    });
    runs.push({
      runId: `${id}-lookup`,
      agentId: "sample-desk.lookup",
      version: "h1",
      trigger: "subagent",
      parentRunId: id,
      status: i === 2 ? "error" : "ok",
      startedAt: new Date(now - hoursAgo * HOUR_MS + 4_000).toISOString(),
      durationMs: 3_100,
      steps: 2,
      costUsd: 0.0006,
      errorClass: i === 2 ? "rate_limit" : null,
      toolCalls: [{ toolId: "sample.research_search", status: i === 2 ? "error" : "ok" }],
    });
  }
  return runs;
}

/**
 * An agent built to run in Startup OS itself (the project `startup-os`), so its
 * Runs tab shows locally: Run now, a run that finished with its answer, and
 * one waiting for the owner to approve a made-up card. Its waiting run's
 * state is one the runner can resume (convex/lib/agentRuntime.ts); locally
 * no provider is configured, so a resumed run is refused as such.
 */
export const SEED_STARTUP_OS = {
  agentId: "sample-os.board-check",
  hoursAgo: 20,
  definition: {
    name: "Sample board check",
    description: "Reads the made-up board and suggests one card to add.",
    input: { mode: "text", variables: [{ name: "focus", required: true }] },
    model: { provider: "ai_studio", model: "gemini-3.8-flash" },
    triggers: { api: true },
    approvals: ["task_create"],
    limits: { maxSteps: 6, timeoutMs: 60_000 },
  } satisfies Definition,
  prompt: { variants: { default: { system: "Read the made-up board. Suggest one card at most.", user: "Focus: {{focus}}" } } },
  tools: ["tasks", "task_create"],
} as const;

/** The waiting card's arguments, as the model sent them: made up. */
const SEED_WAITING_ARGS = { title: "Sample: review the placeholder runway", company: "us" };

/** The Startup OS agent's two runs (one done, one waiting), its answer, its runtime rows and the call that waits. */
export function seedStartupOsRuns(now: number) {
  const { agentId } = SEED_STARTUP_OS;
  const doneAt = now - 5 * HOUR_MS;
  const waitingAt = now - 40 * 60_000;
  const call = { id: "call_0", name: "task_create", args: SEED_WAITING_ARGS };
  const state = {
    runId: "os-sample-2",
    parentRunId: null,
    agentId,
    version: "h1",
    versionNumber: 1,
    trigger: "api",
    depth: 0,
    startedAt: waitingAt,
    activeMs: 2_400,
    system: SEED_STARTUP_OS.prompt.variants.default.system,
    messages: [
      { role: "user", text: "Focus: made-up stuck cards" },
      { role: "assistant", text: "", toolCalls: [{ id: "call_t", name: "tasks", args: {} }] },
      { role: "tool", results: [{ id: "call_t", name: "tasks", output: { cards: [] } }] },
      { role: "assistant", text: "", toolCalls: [call] },
    ],
    steps: 2,
    inputTokens: 900,
    outputTokens: 40,
    provider: "ai_studio",
    model: "gemini-3.8-flash",
    usedFallback: false,
    toolCalls: [{ toolId: "tasks", status: "ok" }],
    turn: { calls: [call], next: 0, results: [] },
    child: null,
  };
  return {
    runs: [
      {
        runId: "os-sample-1",
        agentId,
        version: "h1",
        trigger: "api" as const,
        status: "ok" as const,
        startedAt: doneAt,
        durationMs: 3_800,
        steps: 2,
        errorClass: null,
        toolCalls: [{ toolId: "tasks", status: "ok" }] as ToolCall[],
        output: "Made-up: three sample cards have sat in Doing for a week. No card to add." as string | null,
      },
      {
        runId: "os-sample-2",
        agentId,
        version: "h1",
        trigger: "api" as const,
        status: "awaiting_approval" as const,
        startedAt: waitingAt,
        durationMs: 2_400,
        steps: 2,
        errorClass: null,
        toolCalls: [
          { toolId: "tasks", status: "ok" },
          { toolId: "task_create", status: "skipped", approval: "pending" },
        ] as ToolCall[],
        output: null as string | null,
      },
    ],
    waiting: { runId: "os-sample-2", toolId: "task_create", arguments: JSON.stringify(SEED_WAITING_ARGS), createdAt: waitingAt + 2_400, state: JSON.stringify(state) },
  };
}
