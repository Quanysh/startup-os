import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BUILT_MODEL } from "./agentControl";
import { BUILDER_WORDS, DEFAULT_BUILDER_MODEL } from "./lib/agentBuilder";
import { HARNESS_ACTION_WORDS } from "./agentHarness";
import schema from "./schema";
import { OWNER, modules, signInAsEngineer, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// Agents built here, Protocol v1.3: the tool catalogue and run summaries in
// the usage report, creating an agent from scratch, its draft, a test job
// that carries its definition, the publish rules on the server, the config
// that carries it, its runs, and agents built to run in Startup OS itself.
// Every project, tool, agent, model and run is made up; no test reaches a
// real endpoint or calls a model.

const NOW = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;
const ENTROPY = "b".repeat(43);
const PROJECT = "sample-desk";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

const tool = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "Made-up tool",
  description: "Does a made-up thing.",
  phi: false,
  kind: "function",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, $defs: {} },
  effect: "read",
  approvable: true,
  ...over,
});

const CATALOG = [tool("policy.search"), tool("claim.note", { effect: "write" }), tool("chart.read", { phi: true })];

const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId,
  agentId: "sample.triage",
  version: "h1",
  trigger: "api",
  status: "ok",
  startedAt: "2026-10-17T11:00:00Z",
  durationMs: 900,
  steps: 2,
  costUsd: 0.001,
  errorClass: null,
  toolCalls: [{ toolId: "policy.search", status: "ok" }],
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  batchId: "desk-2026-10-17",
  observedAt: "2026-10-17T12:00:00Z",
  agentUsage: [],
  providers: [
    { provider: "ai_studio", model: "made-up-flash", state: "up", checkedAt: "2026-10-17T11:00:00Z", lastErrorClass: null },
    { provider: "vertex", model: "made-up-pro", state: "up", checkedAt: "2026-10-17T11:00:00Z", lastErrorClass: null },
  ],
  agentsKnown: [],
  configApplied: { version: 0, appliedAt: null },
  toolsCatalog: CATALOG,
  ...over,
});

const post = (t: TestBackend, token: string, path: string, payload: unknown) =>
  t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
const get = (t: TestBackend, token: string, path: string) =>
  t.fetch(path, { method: "GET", headers: { Authorization: `Bearer ${token}` } });

async function setup(holdsPatientData = false) {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const { token } = await owner.mutation(api.agentProjects.connect, {
    name: "Sample Desk",
    slug: PROJECT,
    region: "US",
    holdsPatientData,
    allowedProviders: holdsPatientData ? ["vertex"] : ["ai_studio", "vertex"],
    entropy: ENTROPY,
  });
  const reported = await post(t, token, "/agents/v1/usage", body());
  expect(reported.status).toBe(200);
  return { t, owner, token };
}

const DEFINITION = {
  name: "Sample triage",
  description: "Sorts made-up requests.",
  input: { mode: "text" as const, variables: [{ name: "request", required: true }] },
  model: { provider: "ai_studio", model: "made-up-flash" },
  triggers: { api: true },
  approvals: [] as string[],
  limits: { maxSteps: 8, timeoutMs: 60_000 },
};

const editor = (over: Record<string, unknown> = {}) => ({
  definition: DEFINITION,
  prompt: { variants: { default: { system: "Sort the made-up request.", user: "Request: {{request}}" } } },
  params: { temperature: 0.2 },
  tools: ["policy.search"],
  outputSchema: null,
  note: "",
  ...over,
});

async function created(owner: Client, agentId = "sample.triage", project = PROJECT) {
  return await owner.mutation(api.agentBuilder.create, {
    project,
    agentId,
    name: "Sample triage",
    description: "Sorts made-up requests.",
    mode: "text",
  });
}

async function saved(owner: Client, id: string, revision: number, over: Record<string, unknown> = {}) {
  return await owner.mutation(api.agentBuilder.saveDefinition, { id: id as never, revision, ...editor(over) });
}

const MODEL = { provider: "ai_studio", model: "made-up-flash" };

/** A built agent's draft, tested on a made-up case and passed. */
async function passed(t: TestBackend, owner: Client, token: string, agentId = "sample.triage", over: Record<string, unknown> = {}) {
  const { id } = await created(owner, agentId);
  const { revision } = await saved(owner, id, 1, over);
  const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
    project: PROJECT,
    agentId,
    name: "Made-up request",
    variables: { request: "made-up refill question" },
    expect: [],
    madeUp: true,
  });
  await owner.mutation(api.agentHarness.startRun, { draftId: id as never, models: [MODEL], caseIds: [caseId] });
  const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
  const answered = await post(t, token, `/agents/v1/jobs/${jobs[0].id}/results`, {
    results: [
      {
        caseId,
        ...MODEL,
        output: "Sorted.",
        schemaValid: true,
        assertions: [],
        latencyMs: 700,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0001,
        error: null,
      },
    ],
  });
  expect(answered.status).toBe(200);
  return { id, revision, job: jobs[0] };
}

describe("the tool catalogue in the usage report", () => {
  test("is stored per project with its schema as JSON text, shown on the Tools tab, and replaced as a whole", async () => {
    const { t, owner, token } = await setup();
    const listed = await owner.query(api.agentBuilder.tools, { project: PROJECT });
    expect(listed.tools.map((row) => [row.id, row.effect, row.phi])).toEqual([
      ["chart.read", "read", true],
      ["claim.note", "write", false],
      ["policy.search", "read", false],
    ]);
    expect(JSON.parse(listed.tools[0]!.inputSchema)).toEqual(CATALOG[0]!.inputSchema);

    const smaller = await post(t, token, "/agents/v1/usage", body({ toolsCatalog: [tool("policy.search")] }));
    expect((await smaller.json()).accepted.toolsCatalog).toBe(1);
    const after = await owner.query(api.agentBuilder.tools, { project: PROJECT });
    expect(after.tools.map((row) => row.id)).toEqual(["policy.search"]);

    // Left out: the catalogue is kept.
    const { toolsCatalog: _gone, ...rest } = body();
    expect((await post(t, token, "/agents/v1/usage", rest)).status).toBe(200);
    expect((await owner.query(api.agentBuilder.tools, { project: PROJECT })).tools.length).toBe(1);
  });

  test("a function tool that is not approvable refuses the report", async () => {
    const { t, token } = await setup();
    const refused = await post(t, token, "/agents/v1/usage", body({ toolsCatalog: [tool("claim.note", { effect: "write", approvable: false })] }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).issues).toEqual([
      { path: "toolsCatalog.0.approvable", message: BUILDER_WORDS.functionApprovable },
    ]);
  });
});

describe("run summaries in the usage report", () => {
  test("are upserted by their id, a newer state replacing the older, and an old one is not kept", async () => {
    const { t, owner, token } = await setup();
    const { id } = await created(owner);
    expect(id).toBeTruthy();
    const waiting = run("run_01", {
      status: "awaiting_approval",
      toolCalls: [{ toolId: "claim.note", status: "skipped", approval: "pending" }],
    });
    const child = run("run_02", { trigger: "subagent", parentRunId: "run_01", agentId: "sample.helper" });
    const old = run("run_00", { startedAt: new Date(NOW - 91 * DAY).toISOString() });
    const first = await post(t, token, "/agents/v1/usage", body({ runs: [waiting, child, old] }));
    expect(first.status).toBe(200);
    expect((await first.json()).accepted.runs).toBe(3);

    let view = await owner.query(api.agentBuilder.runs, { project: PROJECT, agentId: "sample.triage" });
    expect(view.runs.map((r) => [r.runId, r.status, r.children.map((c) => c.runId)])).toEqual([
      ["run_01", "awaiting_approval", ["run_02"]],
    ]);
    expect(view.pendingApprovals).toBe(1);

    const approved = run("run_01", { toolCalls: [{ toolId: "claim.note", status: "ok", approval: "approved" }] });
    expect((await post(t, token, "/agents/v1/usage", body({ runs: [approved] }))).status).toBe(200);
    view = await owner.query(api.agentBuilder.runs, { project: PROJECT, agentId: "sample.triage" });
    expect(view.runs.map((r) => [r.runId, r.status, r.toolCalls[0]!.approval])).toEqual([["run_01", "ok", "approved"]]);
    expect(view.pendingApprovals).toBe(0);
    expect((await owner.query(api.agentBuilder.runs, { project: PROJECT, agentId: "sample.triage", status: "error" })).runs).toEqual([]);
  });

  test("text in a run, or a run twice, refuses the report", async () => {
    const { t, token } = await setup();
    const texty = await post(t, token, "/agents/v1/usage", body({ runs: [{ ...run("run_01"), output: "a made-up answer" }] }));
    expect(texty.status).toBe(422);
    const twice = await post(t, token, "/agents/v1/usage", body({ runs: [run("run_01"), run("run_01")] }));
    expect((await twice.json()).issues).toEqual([{ path: "runs.1", message: "repeats an earlier run's runId." }]);
  });

  test("ninety days on, the daily purge drops a run", async () => {
    const { t, owner, token } = await setup();
    await created(owner);
    await post(t, token, "/agents/v1/usage", body({ runs: [run("run_01")] }));
    vi.setSystemTime(NOW + 91 * DAY);
    expect(await t.mutation(internal.agentProjects.purgeRuns, {})).toEqual({ deleted: 1 });
    expect((await owner.query(api.agentBuilder.runs, { project: PROJECT, agentId: "sample.triage" })).runs).toEqual([]);
  });
});

describe("creating an agent from scratch", () => {
  test("a draft, built here, on the default model where the project may use it", async () => {
    const { owner } = await setup();
    await created(owner);
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.triage" });
    expect(view.built).toBe(true);
    expect(view.draft?.definition?.model).toEqual(DEFAULT_BUILDER_MODEL);
    expect(view.draft?.parts.prompt).toEqual({ variants: { default: { system: "", user: "" } } });
    const overview = await owner.query(api.agentControl.overview, { today: "2026-10-17", project: PROJECT });
    expect(overview.agents.map((row) => [row.agentId, row.builtHere, row.draftOnly, row.waiting])).toEqual([
      ["sample.triage", true, true, false],
    ]);
    // The id is now taken.
    await expect(created(owner)).rejects.toThrow(BUILDER_WORDS.taken);
  });

  test("a project that holds patient data has no model preselected", async () => {
    const { owner } = await setup(true);
    await created(owner);
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.triage" });
    expect(view.draft?.definition?.model).toBeUndefined();
  });

  test("saving a change makes a new revision; the rules show on the draft", async () => {
    const { owner } = await setup();
    const { id } = await created(owner);
    const { revision } = await saved(owner, id, 1, { tools: ["policy.search", "claim.note"] });
    expect(revision).toBe(2);
    expect((await saved(owner, id, 2, { tools: ["policy.search", "claim.note"] })).changed).toBe(false);
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.triage" });
    expect(view.draft?.problems).toEqual([{ path: "approvals", message: BUILDER_WORDS.writeNeedsApproval("claim.note") }]);
    await expect(saved(owner, id, 1)).rejects.toThrow("The draft changed since it was opened.");
  });
});

describe("testing and publishing it", () => {
  test("its job carries its definition; published, the config carries it whole, as declarative", async () => {
    const { t, owner, token } = await setup();
    const { id, job } = await passed(t, owner, token);
    expect(job.kind).toBe("declarative");
    expect(job.definition.harness.version).toBe("draft-h1.2");
    expect(job.definition.harness.tools).toEqual(["policy.search"]);
    expect(job.subAgents).toEqual([]);
    expect(await owner.mutation(api.agentHarness.publish, { id: id as never })).toEqual({ configVersion: 1, version: "h1" });

    const config = await (await get(t, token, "/agents/v1/config")).json();
    expect(config.agents).toEqual([
      {
        agentId: "sample.triage",
        name: "Sample triage",
        enabled: true,
        provider: "ai_studio",
        model: "made-up-flash",
        kind: "declarative",
        definition: {
          name: "Sample triage",
          description: "Sorts made-up requests.",
          input: { mode: "text", variables: [{ name: "request", required: true }] },
          harness: {
            version: "h1",
            prompt: { variants: { default: { system: "Sort the made-up request.", user: "Request: {{request}}" } } },
            params: { temperature: 0.2 },
            tools: ["policy.search"],
          },
          triggers: { api: true },
          approvals: [],
          limits: { maxSteps: 8, timeoutMs: 60_000 },
        },
      },
    ]);
    const overview = await owner.query(api.agentControl.overview, { today: "2026-10-17", project: PROJECT });
    expect(overview.agents[0]).toMatchObject({ builtHere: true, draftOnly: false, harnessVersion: "h1" });
    // Its model changes in its definition, not on its row.
    await expect(
      owner.mutation(api.agentControl.change, { project: PROJECT, agentId: "sample.triage", provider: "vertex", model: "made-up-pro" }),
    ).rejects.toThrow(BUILT_MODEL);
    expect(await owner.mutation(api.agentControl.change, { project: PROJECT, agentId: "sample.triage", enabled: false })).toMatchObject({
      changed: true,
    });
  });

  test("the server holds a publish to the rules: an unapproved write tool, a patient-data tool off Vertex", async () => {
    const { owner } = await setup();
    const { id } = await created(owner);
    await saved(owner, id, 1, { tools: ["policy.search", "claim.note"] });
    await expect(owner.mutation(api.agentHarness.startRun, { draftId: id, models: [MODEL], caseIds: [] })).rejects.toThrow(
      BUILDER_WORDS.writeNeedsApproval("claim.note"),
    );
    await expect(owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up reason." })).rejects.toThrow(
      BUILDER_WORDS.writeNeedsApproval("claim.note"),
    );
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.triage" });
    await saved(owner, id, view.draft!.revision, { tools: ["chart.read"] });
    await expect(owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up reason." })).rejects.toThrow(
      "switches on a tool that handles patient data",
    );
  });

  test("sub-agents: a published, offered agent is called by id; its job carries it; a cycle is refused", async () => {
    const { t, owner, token } = await setup();
    const helperDefinition = { ...DEFINITION, name: "Sample helper", triggers: { api: false, subAgent: { toolId: "helper", description: "Looks a made-up policy up." } } };
    const helper = await passed(t, owner, token, "sample.helper", { definition: helperDefinition });
    await owner.mutation(api.agentHarness.publish, { id: helper.id as never });

    const boss = await passed(t, owner, token, "sample.boss", { tools: ["helper"] });
    expect(boss.job.subAgents.map((s: { agentId: string }) => s.agentId)).toEqual(["sample.helper"]);
    expect(boss.job.subAgents[0].definition.harness.version).toBe("h1");
    await owner.mutation(api.agentHarness.publish, { id: boss.id as never });

    // The helper may not now call its caller back: boss calls helper, so helper calling helper (itself) or boss is a cycle.
    const back = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: "sample.helper", from: "published" });
    const helperView = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.helper" });
    await saved(owner, back.id, helperView.draft!.revision, { definition: helperDefinition, tools: ["helper"] });
    const again = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "sample.helper" });
    expect(again.draft?.problems).toContainEqual({ path: "subAgents", message: BUILDER_WORDS.cycle });
  });

  test("reported back in agentsKnown, a built agent stays built here: never offered to Launch", async () => {
    const { t, owner, token } = await setup();
    const { id } = await passed(t, owner, token);
    await owner.mutation(api.agentHarness.publish, { id: id as never });
    const known = [{ agentId: "sample.triage", name: "Sample triage", phi: true, kind: "declarative" }];
    expect((await post(t, token, "/agents/v1/usage", body({ agentsKnown: known }))).status).toBe(200);
    const options = await owner.query(api.agentProjects.launchOptions, { project: PROJECT });
    expect(options?.catalog.map((entry) => entry.agentId)).toEqual([]);
    const overview = await owner.query(api.agentControl.overview, { today: "2026-10-17", project: PROJECT });
    expect(overview.agents[0]).toMatchObject({ agentId: "sample.triage", builtHere: true, kind: "declarative" });
  });

  test("a teammate with agents drafts but does not publish; an engineer publishes", async () => {
    const { t, owner, token } = await setup();
    const { id } = await passed(t, owner, token);
    const agentsOnly = await signInWithAreas(t, "cofounder", ["agents"]);
    await expect(agentsOnly.mutation(api.agentHarness.publish, { id: id as never })).rejects.toThrow("not_allowed");
    const engineer = await signInAsEngineer(t);
    expect(await engineer.mutation(api.agentHarness.publish, { id: id as never })).toEqual({ configVersion: 1, version: "h1" });
  });
});

describe("a built agent's test cases and results (v1.3)", () => {
  test("a case carries fixtures for a sub-agent's own tools; a result's steps and tool calls are kept and shown", async () => {
    const { t, owner, token } = await setup();
    const helperDefinition = { ...DEFINITION, name: "Sample helper", triggers: { api: false, subAgent: { toolId: "helper", description: "Looks a made-up policy up." } } };
    const helper = await passed(t, owner, token, "sample.helper", { definition: helperDefinition });
    await owner.mutation(api.agentHarness.publish, { id: helper.id as never });

    const { id } = await created(owner, "sample.boss");
    await saved(owner, id, 1, { tools: ["helper"] });
    const madeUp = {
      project: PROJECT,
      agentId: "sample.boss",
      name: "Made-up with a sub-agent",
      variables: { request: "made-up question" },
      expect: [],
      madeUp: true,
    };
    await expect(
      owner.mutation(api.agentHarness.saveCase, { ...madeUp, subAgentFixtures: JSON.stringify({ other: { "policy.search": {} } }) }),
    ).rejects.toThrow("has sub-agent fixtures for a sub-agent this agent cannot call.");
    const fixtures = { helper: { "policy.search": { hits: ["SAMPLE-1"] } } };
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, { ...madeUp, subAgentFixtures: JSON.stringify(fixtures) });
    const run = await owner.mutation(api.agentHarness.startRun, { draftId: id, models: [MODEL], caseIds: [caseId] });
    const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
    expect(jobs[0].cases[0].subAgentFixtures).toEqual(fixtures);
    const answered = await post(t, token, `/agents/v1/jobs/${jobs[0].id}/results`, {
      results: [
        {
          caseId,
          ...MODEL,
          output: "Done.",
          schemaValid: true,
          assertions: [],
          latencyMs: 900,
          inputTokens: 120,
          outputTokens: 12,
          costUsd: null,
          error: null,
          steps: 2,
          toolCalls: [{ toolId: "helper", status: "ok" }],
        },
      ],
    });
    expect(answered.status).toBe(200);
    const results = await owner.query(api.agentHarness.run, { id: run.id });
    expect(results?.results[0]).toMatchObject({ steps: 2, toolCalls: [{ toolId: "helper", status: "ok" }] });
  });
});

describe("agents built to run in Startup OS", () => {
  test("its tools are Startup OS's own, its models its own (shown not configured, and then none to test on)", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const { id } = await created(owner, "os.helper", "startup-os");
    const builder = await owner.query(api.agentBuilder.builder, { project: "startup-os", agentId: "os.helper" });
    expect(builder.project.runsHere).toBe(true);
    expect(builder.tools.find((tool) => tool.id === "task_create")).toMatchObject({ effect: "write", area: "board", phi: false });
    expect(builder.providers).toEqual([
      { provider: "ai_studio", configured: false },
      { provider: "astana_gpu", configured: false },
    ]);
    const view = await owner.query(api.agentHarness.harness, { project: "startup-os", agentId: "os.helper" });
    expect(view.draft?.definition?.model).toEqual(DEFAULT_BUILDER_MODEL);
    // Tested here now, on its own providers: none is configured, so there is no model to choose.
    expect((await owner.query(api.agentHarness.tests, { project: "startup-os", agentId: "os.helper" })).choices).toEqual([]);
    await saved(owner, id, 1, { tools: ["tasks"], definition: { ...DEFINITION, model: { ...DEFAULT_BUILDER_MODEL } } });
    await expect(owner.mutation(api.agentHarness.startRun, { draftId: id, models: [], caseIds: [] })).rejects.toThrow(
      HARNESS_ACTION_WORDS.models,
    );
  });

  test("one using a sensitive page's tool: only the owner publishes it, and its runs are the owner's", async () => {
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "made-up-not-a-key");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const { id } = await created(owner, "os.spend", "startup-os");
    await saved(owner, id, 1, { tools: ["costs"], definition: { ...DEFINITION, model: { provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model } } });
    expect((await owner.query(api.agentBuilder.builder, { project: "startup-os", agentId: "os.spend" })).providers[0]).toEqual({
      provider: "ai_studio",
      configured: true,
    });

    const engineer = await signInAsEngineer(t);
    const seen = await engineer.query(api.agentHarness.harness, { project: "startup-os", agentId: "os.spend" });
    expect(seen.draft?.problems).toContainEqual({ path: "tools", message: BUILDER_WORDS.ownerOnlyTool });
    expect(seen.ownerOnly).toBe(true);
    await expect(engineer.query(api.agentBuilder.runs, { project: "startup-os", agentId: "os.spend" })).rejects.toThrow("not_allowed");

    expect(await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: published without a test." })).toEqual({
      configVersion: 1,
      version: "h1",
    });
    expect((await owner.query(api.agentBuilder.runs, { project: "startup-os", agentId: "os.spend" })).runs).toEqual([]);
    const overview = await owner.query(api.agentControl.overview, { today: "2026-10-17", project: "startup-os" });
    expect(overview.agents.map((row) => [row.agentId, row.builtHere, row.harnessVersion])).toEqual([["os.spend", true, "h1"]]);
  });
});
