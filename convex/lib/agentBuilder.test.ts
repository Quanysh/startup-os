import { describe, expect, test } from "vitest";
import {
  BUILDER_WORDS,
  DEFAULT_BUILDER_MODEL,
  RUN_RETENTION_DAYS,
  catalogProblems,
  catalogToolWire,
  declarativeDefaults,
  declarativeProblems,
  defaultModelFor,
  definitionOut,
  embedSnippet,
  newDefinition,
  newPrompt,
  peerPhiOf,
  retainedRun,
  runPath,
  runSummaryWire,
  runsProblems,
  usesOwnerOnlyTools,
  type BuilderContext,
  type CatalogTool,
  type Definition,
  type Peer,
} from "./agentBuilder";
import { CRON_WORDS } from "./agentCron";
import { HARNESS_WORDS, type HarnessParts } from "./agentHarness";
import { LAUNCH_WORDS } from "./agentProjects";

// Agents built in Startup OS (Agents Protocol v1.3): the tool catalogue and the
// run summaries a project reports, and the rules a declarative agent is held
// to before it is tested or published. Every tool, agent and run is made up.

const NOW = Date.parse("2026-10-17T12:00:00Z");

const tool = (over: Partial<CatalogTool> & { id: string }): CatalogTool => ({
  name: "Made-up tool",
  description: "Does a made-up thing.",
  phi: false,
  kind: "function",
  effect: "read",
  approvable: true,
  ...over,
});

const CATALOG: CatalogTool[] = [
  tool({ id: "policy.search", name: "Policy search" }),
  tool({ id: "claim.note", name: "Claim note", effect: "write" }),
  tool({ id: "chart.read", name: "Chart read", phi: true }),
  tool({ id: "web_search", name: "Web search", kind: "provider" }),
];

const peer = (over: Partial<Peer> & { agentId: string }): Peer => ({
  name: "Made-up helper",
  toolId: null,
  description: "Helps.",
  tools: [],
  ...over,
});

const ctx = (over: Partial<BuilderContext> = {}): BuilderContext => ({
  agentId: "sample.triage",
  catalog: CATALOG,
  peers: [],
  policy: { holdsPatientData: false, allowedProviders: ["ai_studio", "vertex"] },
  publishing: true,
  publishedToolId: null,
  ...over,
});

const definition = (over: Partial<Definition> = {}): Definition => ({
  ...newDefinition({ name: "Sample triage", description: "Sorts made-up requests.", mode: "text" }),
  input: { mode: "text", variables: [{ name: "request", required: true }] },
  model: { provider: "ai_studio", model: "made-up-flash" },
  ...over,
});

const parts = (over: HarnessParts = {}): HarnessParts => ({
  prompt: { variants: { default: { system: "Sort the request.", user: "Request: {{request}}" } } },
  tools: ["policy.search"],
  ...over,
});

const messagesOf = (issues: { path: string; message: string }[]) => issues.map((issue) => `${issue.path}: ${issue.message}`);

describe("the tool catalogue", () => {
  const wire = {
    id: "claim.note",
    name: "Claim note",
    description: "Adds a made-up note to a claim.",
    phi: false,
    kind: "function",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, $defs: {} },
    effect: "write",
    approvable: true,
  };

  test("a tool is strict: its id, name, description, schema, effect and approvability", () => {
    expect(catalogToolWire.safeParse(wire).success).toBe(true);
    expect(catalogToolWire.safeParse({ ...wire, note: "x" }).success).toBe(false);
    expect(catalogToolWire.safeParse({ ...wire, effect: "delete" }).success).toBe(false);
    expect(catalogToolWire.safeParse({ ...wire, id: "Claim Note" }).success).toBe(false);
    expect(catalogToolWire.safeParse({ ...wire, inputSchema: [] }).success).toBe(false);
    const big = { type: "object", description: "x".repeat(16 * 1024) };
    expect(catalogToolWire.safeParse({ ...wire, inputSchema: big }).success).toBe(false);
  });

  test("a function tool is approvable, a provider one is not and only reads, and no id is reported twice", () => {
    const list = [
      catalogToolWire.parse(wire),
      catalogToolWire.parse({ ...wire, approvable: false }),
      catalogToolWire.parse({ ...wire, id: "google_search", kind: "provider", effect: "read", approvable: false }),
      catalogToolWire.parse({ ...wire, id: "Built_in", kind: "provider", effect: "write", approvable: true }),
    ];
    expect(messagesOf(catalogProblems(list))).toEqual([
      "toolsCatalog.1: repeats an earlier tool's id.",
      `toolsCatalog.1.approvable: ${BUILDER_WORDS.functionApprovable}`,
      `toolsCatalog.3.approvable: ${BUILDER_WORDS.providerNotApprovable}`,
      `toolsCatalog.3.effect: ${BUILDER_WORDS.providerReads}`,
    ]);
  });

  test("the package's bounds: ids with capitals or a leading _, names to 200, descriptions to 4,096", () => {
    expect(catalogToolWire.safeParse({ ...wire, id: "_Lookup.CPT", name: "N".repeat(200), description: "d".repeat(4096) }).success).toBe(true);
    expect(catalogToolWire.safeParse({ ...wire, name: "N".repeat(201) }).success).toBe(false);
    expect(catalogToolWire.safeParse({ ...wire, id: "1tool" }).success).toBe(false);
  });
});

describe("run summaries", () => {
  const run = {
    runId: "run_01",
    agentId: "sample.triage",
    version: "h2",
    trigger: "api",
    status: "awaiting_approval",
    startedAt: "2026-10-17T11:00:00Z",
    durationMs: 1200,
    steps: 3,
    costUsd: 0.002,
    errorClass: null,
    toolCalls: [
      { toolId: "policy.search", status: "ok" },
      { toolId: "claim.note", status: "skipped", approval: "pending" },
    ],
  };

  test("ids and numbers only: an unknown field, a message or a bad state is refused", () => {
    expect(runSummaryWire.safeParse(run).success).toBe(true);
    expect(runSummaryWire.safeParse({ ...run, output: "a made-up answer" }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, errorClass: "Something went wrong for a patient" }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, status: "paused" }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, steps: 1.5 }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, toolCalls: [{ toolId: "claim.note", status: "ok", args: {} }] }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, costUsd: undefined }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, costUsd: null, errorClass: "rate_limit" }).success).toBe(true);
    // A closed list of classes; a version may carry `#`; at most 100 calls.
    expect(runSummaryWire.safeParse({ ...run, errorClass: "depth_exceeded" }).success).toBe(true);
    expect(runSummaryWire.safeParse({ ...run, errorClass: "tool" }).success).toBe(false);
    expect(runSummaryWire.safeParse({ ...run, version: "dec-2026-10-17#3", startedAt: "2026-10-17T09:00:00.000Z" }).success).toBe(true);
    expect(runSummaryWire.safeParse({ ...run, toolCalls: Array(101).fill({ toolId: "policy.search", status: "ok" }) }).success).toBe(false);
  });

  test("no run twice, none from the future, and a sub-agent's run names its parent", () => {
    const list = [
      runSummaryWire.parse(run),
      runSummaryWire.parse(run),
      runSummaryWire.parse({ ...run, runId: "run_02", startedAt: "2026-10-17T13:00:00Z" }),
      runSummaryWire.parse({ ...run, runId: "run_03", trigger: "subagent" }),
      runSummaryWire.parse({ ...run, runId: "run_04", parentRunId: "run_04" }),
    ];
    expect(messagesOf(runsProblems(list, NOW))).toEqual([
      "runs.1: repeats an earlier run's runId.",
      "runs.2.startedAt: is in the future.",
      "runs.3.parentRunId: is required for a sub-agent's run.",
      "runs.4.parentRunId: is the run itself.",
    ]);
  });

  test("a run is kept for ninety days", () => {
    expect(retainedRun(NOW - (RUN_RETENTION_DAYS - 1) * 86_400_000, NOW)).toBe(true);
    expect(retainedRun(NOW - (RUN_RETENTION_DAYS + 1) * 86_400_000, NOW)).toBe(false);
  });
});

describe("a declarative agent's rules", () => {
  test("a fresh agent has a text prompt to write and an API trigger on", () => {
    const fresh = newDefinition({ name: "Sample triage", description: "Sorts made-up requests.", mode: "messages" });
    expect(fresh.triggers).toEqual({ api: true });
    expect(fresh.limits).toEqual({ maxSteps: 10, timeoutMs: 120_000 });
    expect(newPrompt("messages")).toEqual({ variants: { default: { system: "" } } });
    expect(newPrompt("text")).toEqual({ variants: { default: { system: "", user: "" } } });
  });

  test("a well-formed agent has no problems", () => {
    expect(declarativeProblems(definition(), parts(), ctx())).toEqual([]);
  });

  test("tools come from the catalogue, and every write tool needs approval", () => {
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["made.up"] }), ctx()))).toEqual([
      `tools: ${BUILDER_WORDS.toolUnknown}`,
    ]);
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["claim.note"] }), ctx()))).toEqual([
      `approvals: ${BUILDER_WORDS.writeNeedsApproval("claim.note")}`,
    ]);
    expect(declarativeProblems(definition({ approvals: ["claim.note"] }), parts({ tools: ["claim.note"] }), ctx())).toEqual([]);
    expect(messagesOf(declarativeProblems(definition({ approvals: ["policy.search"] }), parts({ tools: [] }), ctx()))).toEqual([
      `approvals: ${BUILDER_WORDS.approvalNotOn}`,
    ]);
    const unapprovable = ctx({ catalog: [...CATALOG, tool({ id: "rank", kind: "provider", approvable: false })] });
    expect(messagesOf(declarativeProblems(definition({ approvals: ["rank"] }), parts({ tools: ["rank"] }), unapprovable))).toEqual([
      `approvals: ${BUILDER_WORDS.approvalNotApprovable}`,
    ]);
  });

  test("a tool for patient data needs patient-data providers, fallback included", () => {
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["chart.read"] }), ctx()))).toEqual([
      `tools: ${HARNESS_WORDS.phiTool}`,
    ]);
    const vertex = definition({ model: { provider: "vertex", model: "made-up-pro" } });
    expect(declarativeProblems(vertex, parts({ tools: ["chart.read"] }), ctx())).toEqual([]);
    const fallback = definition({
      model: { provider: "vertex", model: "made-up-pro", fallbackProvider: "ai_studio", fallbackModel: "made-up-flash" },
    });
    expect(messagesOf(declarativeProblems(fallback, parts({ tools: ["chart.read"] }), ctx()))).toEqual([
      `tools: ${HARNESS_WORDS.phiTool}`,
    ]);
  });

  test("a project that holds patient data: its providers for patient data only", () => {
    const clinic = ctx({ policy: { holdsPatientData: true, allowedProviders: ["vertex"] } });
    expect(messagesOf(declarativeProblems(definition(), parts(), clinic))).toEqual([`model: ${LAUNCH_WORDS.notAllowed}`]);
  });

  test("a model is needed to publish, not to test", () => {
    const none = definition({ model: undefined });
    expect(messagesOf(declarativeProblems(none, parts(), ctx()))).toEqual([`model: ${BUILDER_WORDS.modelMissing}`]);
    expect(declarativeProblems(none, parts(), ctx({ publishing: false }))).toEqual([]);
  });

  test("instructions are written, and the prompt uses only its own variables", () => {
    const blank = parts({ prompt: { variants: { default: { system: "  ", user: "{{request}}" } } } });
    expect(messagesOf(declarativeProblems(definition(), blank, ctx()))).toEqual([`prompt.default.system: ${BUILDER_WORDS.instructions}`]);
    const stray = parts({ prompt: { variants: { default: { system: "Sort {{other}}.", user: "{{request}}" } } } });
    expect(messagesOf(declarativeProblems(definition(), stray, ctx()))).toEqual([
      "prompt.default.system: uses {{other}}, which is not a declared variable.",
    ]);
    const unused = parts({ prompt: { variants: { default: { system: "Sort it.", user: "Hello" } } } });
    expect(messagesOf(declarativeProblems(definition(), unused, ctx()))).toEqual([
      "prompt: must use the required variable {{request}}.",
    ]);
    const noDefault = parts({ prompt: { variants: { retry: { system: "Again.", user: "{{request}}" } } } });
    expect(messagesOf(declarativeProblems(definition(), noDefault, ctx()))).toEqual([`prompt: ${HARNESS_WORDS.variantDefault}`]);
  });

  test("limits in bounds: 1 to 30 steps, 1 second to 10 minutes", () => {
    const bad = definition({ limits: { maxSteps: 31, timeoutMs: 999, monthlyBudgetUsd: 0 } });
    expect(messagesOf(declarativeProblems(bad, parts(), ctx()))).toEqual([
      `limits.maxSteps: ${BUILDER_WORDS.maxSteps}`,
      `limits.timeoutMs: ${BUILDER_WORDS.timeout}`,
      `limits.monthlyBudgetUsd: ${BUILDER_WORDS.budget}`,
    ]);
    const edge = definition({ limits: { maxSteps: 1, timeoutMs: 600_000, monthlyBudgetUsd: 25 } });
    expect(declarativeProblems(edge, parts(), ctx())).toEqual([]);
  });

  test("a schedule: a valid cron, variables only, every required one given", () => {
    const good = definition({ triggers: { api: false, schedule: { cron: "0 6 * * 1-5", variables: { request: "made-up daily sweep" } } } });
    expect(declarativeProblems(good, parts(), ctx())).toEqual([]);
    const bad = definition({ triggers: { api: false, schedule: { cron: "0 25 * * *", variables: { other: "x" } } } });
    expect(messagesOf(declarativeProblems(bad, parts(), ctx()))).toEqual([
      `triggers.schedule.cron: ${CRON_WORDS.field("hour")}`,
      `triggers.schedule.variables: ${BUILDER_WORDS.scheduleVariable("other")}`,
      `triggers.schedule.variables: ${BUILDER_WORDS.scheduleRequired("request")}`,
    ]);
    const messages = definition({
      input: { mode: "messages", variables: [] },
      triggers: { api: false, schedule: { cron: "0 6 * * *", variables: {} } },
    });
    const messageParts = parts({ prompt: { variants: { default: { system: "Sort it." } } } });
    expect(messagesOf(declarativeProblems(messages, messageParts, ctx()))).toEqual([
      `triggers.schedule: ${BUILDER_WORDS.scheduleMessages}`,
    ]);
  });

  test("a chat box takes a conversation, and something must run it", () => {
    const chat = definition({ triggers: { api: false, chat: { enabled: true, title: "Sample help", greeting: "Ask me." } } });
    expect(messagesOf(declarativeProblems(chat, parts(), ctx()))).toEqual([`triggers.chat: ${BUILDER_WORDS.chatMessages}`]);
    const none = definition({ triggers: { api: false } });
    expect(messagesOf(declarativeProblems(none, parts(), ctx()))).toEqual([`triggers: ${BUILDER_WORDS.noTrigger}`]);
    expect(declarativeProblems(none, parts(), ctx({ publishing: false }))).toEqual([]);
  });

  test("a sub-agent exposure has its own tool id, not the catalogue's or another agent's", () => {
    const exposed = (toolId: string) =>
      definition({ triggers: { api: true, subAgent: { toolId, description: "Sorts a request." } } });
    expect(declarativeProblems(exposed("triage"), parts(), ctx())).toEqual([]);
    expect(messagesOf(declarativeProblems(exposed("policy.search"), parts(), ctx()))).toEqual([
      `triggers.subAgent.toolId: ${BUILDER_WORDS.exposureTaken}`,
    ]);
    const taken = ctx({ peers: [peer({ agentId: "sample.other", toolId: "triage" })] });
    expect(messagesOf(declarativeProblems(exposed("triage"), parts(), taken))).toEqual([
      `triggers.subAgent.toolId: ${BUILDER_WORDS.exposureTaken}`,
    ]);
    // Published, and called by another agent as `triage`: it keeps that id.
    const called = ctx({ publishedToolId: "triage", peers: [peer({ agentId: "sample.boss", toolId: "boss", tools: ["triage"] })] });
    expect(messagesOf(declarativeProblems(exposed("triage2"), parts(), called))).toEqual([
      `triggers.subAgent.toolId: ${BUILDER_WORDS.exposureKept("triage")}`,
    ]);
  });
});

describe("sub-agents", () => {
  const helper = peer({ agentId: "sample.lookup", toolId: "lookup", tools: ["policy.search"] });

  test("a published agent exposed as a sub-agent can be used as a tool, and approved before each call", () => {
    expect(declarativeProblems(definition(), parts({ tools: ["lookup"] }), ctx({ peers: [helper] }))).toEqual([]);
    expect(declarativeProblems(definition({ approvals: ["lookup"] }), parts({ tools: ["lookup"] }), ctx({ peers: [helper] }))).toEqual([]);
    const notExposed = peer({ agentId: "sample.lookup", toolId: null, tools: [] });
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["lookup"] }), ctx({ peers: [notExposed] })))).toEqual([
      `tools: ${BUILDER_WORDS.toolUnknown}`,
    ]);
  });

  test("calling itself, directly or round a loop, is a cycle", () => {
    const self = definition({ triggers: { api: true, subAgent: { toolId: "triage", description: "Sorts." } } });
    expect(messagesOf(declarativeProblems(self, parts({ tools: ["triage"] }), ctx()))).toEqual([`subAgents: ${BUILDER_WORDS.cycle}`]);
    const loop = [
      peer({ agentId: "sample.a", toolId: "a", tools: ["b"] }),
      peer({ agentId: "sample.b", toolId: "b", tools: ["triage"] }),
    ];
    expect(messagesOf(declarativeProblems(self, parts({ tools: ["a"] }), ctx({ peers: loop, publishedToolId: "triage" })))).toEqual([
      `subAgents: ${BUILDER_WORDS.cycle}`,
    ]);
  });

  test("a sub-agent that cannot run (a tool gone from the catalogue, however deep) is refused", () => {
    const gone = peer({ agentId: "sample.lookup", toolId: "lookup", tools: ["gone.tool"] });
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["lookup"] }), ctx({ peers: [gone] })))).toEqual([
      `subAgents: ${BUILDER_WORDS.subAgentBroken}`,
    ]);
    const viaChain = [peer({ agentId: "sample.a", toolId: "a", tools: ["lookup"] }), gone];
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["a"] }), ctx({ peers: viaChain })))).toEqual([
      `subAgents: ${BUILDER_WORDS.subAgentBroken}`,
    ]);
  });

  test("at most 3 deep", () => {
    const chain = [
      peer({ agentId: "sample.a", toolId: "a", tools: ["b"] }),
      peer({ agentId: "sample.b", toolId: "b", tools: ["c"] }),
      peer({ agentId: "sample.c", toolId: "c", tools: ["policy.search"] }),
    ];
    // triage → a → b → c: three deep, allowed.
    expect(declarativeProblems(definition(), parts({ tools: ["a"] }), ctx({ peers: chain }))).toEqual([]);
    const deeper = [...chain.slice(0, 2), peer({ agentId: "sample.c", toolId: "c", tools: ["d"] }), peer({ agentId: "sample.d", toolId: "d" })];
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["a"] }), ctx({ peers: deeper })))).toEqual([
      `subAgents: ${BUILDER_WORDS.depth}`,
    ]);
  });

  test("a sub-agent that reads patient data makes its caller a patient-data agent", () => {
    const reader = peer({ agentId: "sample.reader", toolId: "reader", tools: ["chart.read"] });
    const boss = peer({ agentId: "sample.boss", toolId: "boss", tools: ["reader"] });
    expect(peerPhiOf([reader, boss], CATALOG)).toEqual(new Map([["sample.reader", true], ["sample.boss", true]]));
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["boss"] }), ctx({ peers: [reader, boss] })))).toEqual([
      `tools: ${HARNESS_WORDS.phiTool}`,
    ]);
  });
});

describe("tools of the owner's pages", () => {
  const OS: CatalogTool[] = [
    tool({ id: "metrics", name: "Company figures", area: "scorecard" }),
    tool({ id: "costs", name: "Run-rate", area: "costs" }),
    tool({ id: "brief_write", name: "Write the daily brief", effect: "write", area: "personal" }),
  ];
  const os = (over: Partial<BuilderContext> = {}) =>
    ctx({ agentId: "os.helper", catalog: OS, policy: { holdsPatientData: false, allowedProviders: ["ai_studio"] }, ...over });

  test("only the owner publishes an agent that uses a sensitive or owner's tool, directly or through a sub-agent", () => {
    expect(usesOwnerOnlyTools(["metrics"], OS, [])).toBe(false);
    expect(usesOwnerOnlyTools(["costs"], OS, [])).toBe(true);
    expect(declarativeProblems(definition(), parts({ tools: ["metrics"] }), os({ ownerPublishing: false }))).toEqual([]);
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["costs"] }), os({ ownerPublishing: false })))).toEqual([
      `tools: ${BUILDER_WORDS.ownerOnlyTool}`,
    ]);
    expect(declarativeProblems(definition(), parts({ tools: ["costs"] }), os({ ownerPublishing: true }))).toEqual([]);
    const spender = peer({ agentId: "os.spend", toolId: "spend", tools: ["costs"] });
    expect(usesOwnerOnlyTools(["spend"], OS, [spender])).toBe(true);
    expect(messagesOf(declarativeProblems(definition(), parts({ tools: ["spend"] }), os({ peers: [spender], ownerPublishing: false })))).toEqual([
      `tools: ${BUILDER_WORDS.ownerOnlyTool}`,
    ]);
    // A draft is not held to it: only publishing is.
    expect(declarativeProblems(definition(), parts({ tools: ["costs"] }), os({ ownerPublishing: false, publishing: false }))).toEqual([]);
  });

  test("an agent Startup OS runs is scheduled at most every five minutes", () => {
    const every = (cron: string) => definition({ triggers: { api: true, schedule: { cron, variables: { request: "made-up" } } } });
    expect(messagesOf(declarativeProblems(every("*/2 * * * *"), parts({ tools: ["metrics"] }), os({ runsHere: true })))).toEqual([
      `triggers.schedule.cron: ${BUILDER_WORDS.scheduleTooOften}`,
    ]);
    expect(declarativeProblems(every("*/5 * * * *"), parts({ tools: ["metrics"] }), os({ runsHere: true }))).toEqual([]);
    // A project's own runner is not held to it.
    expect(declarativeProblems(every("*/2 * * * *"), parts({ tools: ["metrics"] }), os())).toEqual([]);
  });
});

describe("what goes out", () => {
  test("the config's definition: the harness as variants, its tools, triggers, approvals and limits", () => {
    const def = definition({
      approvals: ["claim.note"],
      triggers: {
        api: true,
        schedule: { cron: "0 6 * * *", variables: { request: "made-up sweep" } },
        subAgent: { toolId: "triage", description: "Sorts a request." },
      },
      limits: { maxSteps: 8, timeoutMs: 60_000, monthlyBudgetUsd: 20 },
    });
    const out = definitionOut(3, def, parts({ tools: ["policy.search", "claim.note"], params: { temperature: 0.1 }, outputSchema: '{"type":"object"}' }));
    expect(out).toEqual({
      name: "Sample triage",
      description: "Sorts made-up requests.",
      input: { mode: "text", variables: [{ name: "request", required: true }] },
      harness: {
        version: "h3",
        prompt: { variants: { default: { system: "Sort the request.", user: "Request: {{request}}" } } },
        params: { temperature: 0.1 },
        tools: ["policy.search", "claim.note"],
        output: { schema: { type: "object" } },
      },
      triggers: {
        api: true,
        schedule: { cron: "0 6 * * *", variables: { request: "made-up sweep" } },
        subAgent: { toolId: "triage", description: "Sorts a request." },
      },
      approvals: ["claim.note"],
      limits: { maxSteps: 8, timeoutMs: 60_000, monthlyBudgetUsd: 20 },
    });
    expect(JSON.stringify(out)).not.toContain("made-up-flash");
  });

  test("the defaults a test of it is checked against: its variables, variants and tools", () => {
    const defaults = declarativeDefaults(definition(), parts(), CATALOG, [peer({ agentId: "sample.lookup", toolId: "lookup", description: "Looks up." })]);
    expect(defaults.prompt?.variables).toEqual([{ name: "request", required: true }]);
    expect(Object.keys(defaults.prompt?.variants ?? {})).toEqual(["default"]);
    expect(defaults.prompt?.input).toBe("text");
    expect(defaults.tools?.map((t) => t.id)).toEqual(["policy.search", "claim.note", "chart.read", "web_search", "lookup"]);
  });

  test("a new agent starts on the default model where the project may use it; none for patient data", () => {
    expect(DEFAULT_BUILDER_MODEL).toEqual({ provider: "ai_studio", model: "gemini-3.8-flash" });
    expect(defaultModelFor({ holdsPatientData: false, allowedProviders: ["ai_studio", "vertex"] })).toEqual({
      provider: "ai_studio",
      model: "gemini-3.8-flash",
    });
    expect(defaultModelFor({ holdsPatientData: false, allowedProviders: ["vertex"] })).toBeUndefined();
    expect(defaultModelFor({ holdsPatientData: true, allowedProviders: ["vertex"] })).toBeUndefined();
  });

  test("the endpoint and the embed", () => {
    expect(runPath("sample.triage")).toBe("/api/startup-agents/run/sample.triage");
    expect(embedSnippet("sample.triage")).toBe('<StartupAgentChat agentId="sample.triage" />');
  });
});
