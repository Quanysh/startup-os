import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { HARNESS_ACTION_WORDS } from "./agentHarness";
import { HARNESS_WORDS } from "./lib/agentHarness";
import { TEMPLATE_WORDS } from "./lib/agentTemplate";
import { CASE_WORDS, GATE_WORDS, LEASE_MS, MAX_LEASES } from "./lib/agentJobs";
import { API_WORDS } from "./lib/agentProjects";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// Harnesses, Protocol v1.1: the code's defaults in the usage report, drafts,
// made-up test cases, test jobs leased by the project and answered, the
// publish gate, publishing into the config, rollback, and who may do what.
// Every project, agent, prompt, model and case is made up; no test reaches a
// real endpoint.

const NOW = Date.parse("2026-10-16T12:00:00Z");
const TODAY = "2026-10-16";
const ENTROPY = "a".repeat(43);
const PROJECT = "sample-search";
const AGENT = "sample.rank";

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

const SCHEMA = {
  type: "object",
  required: ["codes"],
  properties: { codes: { type: "array", items: { type: "string" } }, $comment: { type: "string" } },
};

const HARNESS = {
  prompt: {
    version: "v1+made0up1",
    system: "You rank made-up policies.",
    user: "Query: {{query}}",
    variables: [{ name: "query", required: true }],
  },
  params: { temperature: 0.2, maxOutputTokens: 2048, thinkingBudget: 1024, timeoutMs: 60000, retries: 1 },
  tools: [
    { id: "web_search", name: "Web search", description: "Searches the made-up web.", phi: false },
    { id: "chart_lookup", name: "Chart lookup", description: "Reads a chart.", phi: true },
  ],
  defaultTools: ["web_search"],
  output: { schemaVersion: "1", schema: SCHEMA },
};

const usageRow = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  promptVersion: "v1+made0up1",
  provider: "ai_studio",
  model: "made-up-flash",
  day: TODAY,
  calls: 10,
  errors: 0,
  schemaFailures: 0,
  fallbacks: 0,
  refusals: 0,
  inputTokens: 2000,
  outputTokens: 300,
  costUsd: 0.05,
  p50Ms: 900,
  p95Ms: 2100,
  ...over,
});
const providerRow = (provider: string, model: string) => ({
  provider,
  model,
  state: "up",
  checkedAt: "2026-10-16T11:00:00Z",
  lastErrorClass: null,
});
const body = (known: Record<string, unknown> = { harness: HARNESS }, over: Record<string, unknown> = {}) => ({
  batchId: "sample-2026-10-16",
  observedAt: "2026-10-16T12:00:00Z",
  agentUsage: [usageRow()],
  providers: [providerRow("ai_studio", "made-up-flash"), providerRow("vertex", "made-up-pro")],
  agentsKnown: [{ agentId: AGENT, name: "Sample rank", phi: false, kind: "declarative", ...known }],
  configApplied: { version: 0, appliedAt: null },
  ...over,
});

const post = (t: TestBackend, token: string, path: string, payload: unknown) =>
  t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const get = (t: TestBackend, token: string, path: string) =>
  t.fetch(path, { method: "GET", headers: { Authorization: `Bearer ${token}` } });

async function setup() {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const { token } = await owner.mutation(api.agentProjects.connect, {
    name: "Sample Search",
    slug: PROJECT,
    region: "US",
    holdsPatientData: false,
    allowedProviders: ["ai_studio", "vertex"],
    entropy: ENTROPY,
  });
  expect((await post(t, token, "/agents/v1/usage", body())).status).toBe(200);
  return { t, owner, token };
}

const CODE_PROMPT = { system: HARNESS.prompt.system, user: HARNESS.prompt.user };

/** The editor's state for a draft: every part as it would run. */
const editorOf = (over: Record<string, unknown> = {}) => ({
  prompt: CODE_PROMPT,
  params: HARNESS.params,
  tools: ["web_search"],
  outputSchema: JSON.stringify(SCHEMA),
  note: "",
  ...over,
});

const madeUpCase = (over: Record<string, unknown> = {}) => ({
  project: PROJECT,
  agentId: AGENT,
  name: "Made-up knee query",
  variables: { query: "made-up knee brace policy" },
  expect: [{ path: "$.codes", op: "exists" as const, value: "true" }],
  madeUp: true,
  ...over,
});

async function draftWithCase(owner: Client, over: Record<string, unknown> = { params: { ...HARNESS.params, temperature: 0.7 } }) {
  const { id } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" });
  const saved = await owner.mutation(api.agentHarness.saveDraft, { id, revision: 1, ...editorOf(over) });
  const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, madeUpCase());
  return { id, caseId, revision: saved.revision };
}

const MODEL = { provider: "ai_studio", model: "made-up-flash" };

const passing = (caseId: string, over: Record<string, unknown> = {}) => ({
  caseId,
  ...MODEL,
  output: { codes: ["made-up"] },
  schemaValid: true,
  assertions: [{ index: 0, passed: true }],
  latencyMs: 800,
  inputTokens: 900,
  outputTokens: 40,
  costUsd: 0.0004,
  error: null,
  ...over,
});

/** A draft tested and passed: the run made, leased by the project, answered. */
async function passedDraft(t: TestBackend, owner: Client, token: string) {
  const draft = await draftWithCase(owner);
  await owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [draft.caseId] });
  const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
  const answered = await post(t, token, `/agents/v1/jobs/${jobs[0].id}/results`, { results: [passing(draft.caseId)] });
  expect(answered.status).toBe(200);
  return draft;
}

describe("the code's defaults in the usage report", () => {
  test("are stored per agent with the schema as JSON text, and shown on the agent's harness", async () => {
    const { owner } = await setup();
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.defaults?.prompt?.variables).toEqual([{ name: "query", required: true }]);
    expect(JSON.parse(view.defaults!.output!.schema)).toEqual(SCHEMA);
    expect(view.published).toBeNull();
    expect(view.draft).toBeNull();
  });

  test("an unchanged harness is not rewritten; a report without one keeps it; a changed one replaces it", async () => {
    const { t, token } = await setup();
    const stamp = () => t.run(async (ctx) => (await ctx.db.query("agentHarnessDefaults").first())!);
    const first = await stamp();
    vi.setSystemTime(NOW + 60_000);
    await post(t, token, "/agents/v1/usage", body());
    expect((await stamp()).reportedAt).toBe(first.reportedAt);
    await post(t, token, "/agents/v1/usage", body({}));
    expect((await stamp()).harness).toEqual(first.harness);
    await post(t, token, "/agents/v1/usage", body({ harness: { ...HARNESS, params: { temperature: 1 } } }));
    expect((await stamp()).harness.params).toEqual({ temperature: 1 });
  });

  test("a harness that breaks a bound or names a tool twice refuses the report, by path", async () => {
    const { t, token } = await setup();
    const tooLong = await post(
      t,
      token,
      "/agents/v1/usage",
      body({ harness: { ...HARNESS, prompt: { ...HARNESS.prompt, system: "x".repeat(128 * 1024 + 1) } } }),
    );
    expect(tooLong.status).toBe(422);
    expect((await tooLong.json()).issues[0].path).toBe("agentsKnown.0.harness.prompt.system");
    const twice = await post(
      t,
      token,
      "/agents/v1/usage",
      body({ harness: { ...HARNESS, tools: [HARNESS.tools[0], HARNESS.tools[0]] } }),
    );
    expect(twice.status).toBe(422);
    expect(await twice.json()).toMatchObject({
      error: "invalid_body",
      message: API_WORDS.invalid_body,
      issues: [{ path: "agentsKnown.0.harness.tools.1", message: "repeats an earlier tool's id." }],
    });
  });
});

describe("drafts", () => {
  test("one at a time, from the code's defaults; a part the same as the code's is kept as the code's", async () => {
    const { owner } = await setup();
    await expect(
      owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "published" }),
    ).rejects.toThrow(HARNESS_ACTION_WORDS.noPublished);
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" });
    await expect(
      owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" }),
    ).rejects.toThrow(HARNESS_ACTION_WORDS.draftOpen);

    expect(await owner.mutation(api.agentHarness.saveDraft, { id, revision: 1, ...editorOf() })).toEqual({
      revision: 1,
      changed: false,
    });
    const saved = await owner.mutation(api.agentHarness.saveDraft, {
      id,
      revision: 1,
      ...editorOf({ prompt: { ...CODE_PROMPT, system: "Rank made-up policies, briefly." } }),
    });
    expect(saved).toEqual({ revision: 2, changed: true });
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.draft?.parts).toEqual({
      prompt: { variants: { default: { ...CODE_PROMPT, system: "Rank made-up policies, briefly." } } },
    });
    expect(view.draft?.name).toBe("h1");
    expect(view.draft?.gate).toBe("no_run");
    expect(view.draft?.problems).toEqual([]);

    await expect(owner.mutation(api.agentHarness.saveDraft, { id, revision: 1, ...editorOf() })).rejects.toThrow(
      HARNESS_ACTION_WORDS.stale,
    );
    await owner.mutation(api.agentHarness.discardDraft, { id });
    const after = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(after.draft).toBeNull();
    expect(after.versions.map((row) => [row.name, row.status])).toEqual([["h1", "archived"]]);
  });

  test("the rules show on the draft as it is typed", async () => {
    const { owner } = await setup();
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" });
    await owner.mutation(api.agentHarness.saveDraft, {
      id,
      revision: 1,
      ...editorOf({
        prompt: { system: "", user: "{{patientName}}" },
        params: { temperature: 3 },
        tools: ["web_search", "made_up"],
        outputSchema: JSON.stringify({ ...SCHEMA, required: [] }),
      }),
    });
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.draft?.problems).toEqual([
      { path: "prompt.default.user", message: "uses {{patientName}}, which is not a declared variable.", at: { line: 1, column: 1 } },
      { path: "prompt", message: "must use the required variable {{query}}." },
      { path: "params.temperature", message: "is 0 to 2." },
      { path: "tools", message: HARNESS_WORDS.toolUndeclared },
      { path: "output:$.codes", message: "is required by the code and must stay required." },
    ]);
  });
});

describe("test cases", () => {
  test("are saved only when ticked as made-up data, and held to their bounds", async () => {
    const { owner } = await setup();
    await expect(owner.mutation(api.agentHarness.saveCase, madeUpCase({ madeUp: false }))).rejects.toThrow(
      CASE_WORDS.madeUp,
    );
    await expect(
      owner.mutation(api.agentHarness.saveCase, madeUpCase({ expect: [{ path: "codes", op: "exists", value: "true" }] })),
    ).rejects.toThrow(CASE_WORDS.path);
    const { id } = await owner.mutation(api.agentHarness.saveCase, madeUpCase());
    await owner.mutation(api.agentHarness.saveCase, madeUpCase({ id, name: "Renamed made-up query" }));
    const tests = await owner.query(api.agentHarness.tests, { project: PROJECT, agentId: AGENT });
    expect(tests.cases.map((c) => c.name)).toEqual(["Renamed made-up query"]);
    expect(tests.variables).toEqual([{ name: "query", required: true }]);
    await owner.mutation(api.agentHarness.removeCase, { id });
    expect((await owner.query(api.agentHarness.tests, { project: PROJECT, agentId: AGENT })).cases).toEqual([]);
  });
});

describe("test runs and jobs", () => {
  test("a run needs a draft that keeps its rules, models the project saw up, and cases that fit", async () => {
    const { owner } = await setup();
    const bad = await draftWithCase(owner, { tools: ["made_up"] });
    await expect(
      owner.mutation(api.agentHarness.startRun, { draftId: bad.id, models: [MODEL], caseIds: [bad.caseId] }),
    ).rejects.toThrow(`Fix the draft first: tools: ${HARNESS_WORDS.toolUndeclared}`);
    await owner.mutation(api.agentHarness.discardDraft, { id: bad.id });

    const { id: draftId } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" });
    const { id: misfit } = await owner.mutation(api.agentHarness.saveCase, madeUpCase({ name: "No query", variables: {} }));
    await expect(
      owner.mutation(api.agentHarness.startRun, { draftId, models: [{ provider: "ai_studio", model: "made-up-other" }], caseIds: [bad.caseId] }),
    ).rejects.toThrow(HARNESS_ACTION_WORDS.model);
    await expect(owner.mutation(api.agentHarness.startRun, { draftId, models: [], caseIds: [bad.caseId] })).rejects.toThrow(
      HARNESS_ACTION_WORDS.models,
    );
    await expect(owner.mutation(api.agentHarness.startRun, { draftId, models: [MODEL], caseIds: [] })).rejects.toThrow(
      HARNESS_ACTION_WORDS.cases,
    );
    await expect(owner.mutation(api.agentHarness.startRun, { draftId, models: [MODEL], caseIds: [misfit] })).rejects.toThrow(
      "No query: gives no value for the required variable query.",
    );
    await owner.mutation(api.agentHarness.startRun, { draftId, models: [MODEL], caseIds: [bad.caseId] });
    await expect(owner.mutation(api.agentHarness.startRun, { draftId, models: [MODEL], caseIds: [bad.caseId] })).rejects.toThrow(
      HARNESS_ACTION_WORDS.runOpen,
    );
  });

  test("a poll leases each job once; it comes back after its lease, and is given up on after the last", async () => {
    const { t, owner, token } = await setup();
    const draft = await draftWithCase(owner);
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, {
      draftId: draft.id,
      models: [MODEL],
      caseIds: [draft.caseId],
    });
    const first = await get(t, token, "/agents/v1/jobs");
    expect(first.status).toBe(200);
    const { jobs } = await first.json();
    expect(jobs).toEqual([
      {
        id: runId,
        agentId: AGENT,
        harness: {
          version: `draft-h1.${draft.revision}`,
          prompt: CODE_PROMPT,
          params: { ...HARNESS.params, temperature: 0.7 },
          tools: ["web_search"],
          output: { schema: SCHEMA },
        },
        models: [MODEL],
        cases: [
          {
            id: draft.caseId,
            variables: { query: "made-up knee brace policy" },
            expect: [{ path: "$.codes", exists: true }],
          },
        ],
      },
    ]);
    expect((await (await get(t, token, "/agents/v1/jobs")).json()).jobs).toEqual([]);
    for (let lease = 2; lease <= MAX_LEASES; lease += 1) {
      vi.setSystemTime(NOW + (lease - 1) * (LEASE_MS + 1));
      expect((await (await get(t, token, "/agents/v1/jobs")).json()).jobs).toHaveLength(1);
    }
    vi.setSystemTime(NOW + MAX_LEASES * (LEASE_MS + 1));
    expect((await (await get(t, token, "/agents/v1/jobs")).json()).jobs).toEqual([]);
    const runs = (await owner.query(api.agentHarness.tests, { project: PROJECT, agentId: AGENT })).runs;
    expect(runs[0]!.status).toBe("expired");
    const late = await post(t, token, `/agents/v1/jobs/${runId}/results`, { results: [passing(draft.caseId)] });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe("job_closed");
  });

  test("results are checked against the job, close it, and are read back with each output", async () => {
    const { t, owner, token } = await setup();
    const draft = await draftWithCase(owner);
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, {
      draftId: draft.id,
      models: [MODEL],
      caseIds: [draft.caseId],
    });
    await get(t, token, "/agents/v1/jobs");
    const at = `/agents/v1/jobs/${runId}/results`;

    expect((await post(t, token, at, "{")).status).toBe(400);
    const shape = await post(t, token, at, { results: [{ ...passing(draft.caseId), error: "said no" }] });
    expect(shape.status).toBe(422);
    expect((await shape.json()).issues[0].path).toBe("results.0.error");
    const wrong = await post(t, token, at, { results: [passing(draft.caseId, { model: "made-up-other" })] });
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).issues).toEqual([{ path: "results.0.model", message: "is not a model of this job." }]);
    expect((await post(t, token, "/agents/v1/jobs/nosuchjob/results", { results: [] })).status).toBe(404);
    expect((await post(t, token, "/agents/v1/jobs/../results", { results: [] })).status).toBe(404);

    const ok = await post(t, token, at, { results: [passing(draft.caseId)] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: 1 });
    expect((await post(t, token, at, { results: [passing(draft.caseId)] })).status).toBe(409);

    const read = await owner.query(api.agentHarness.run, { id: runId });
    expect(read?.status).toBe("done");
    expect(read?.results).toEqual([
      expect.objectContaining({ caseId: draft.caseId, passed: true, output: JSON.stringify({ codes: ["made-up"] }) }),
    ]);
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.draft?.gate).toBe("passed");
  });

  test("another project's token cannot see or answer a job", async () => {
    const { t, owner } = await setup();
    const draft = await draftWithCase(owner);
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, {
      draftId: draft.id,
      models: [MODEL],
      caseIds: [draft.caseId],
    });
    const { token: other } = await owner.mutation(api.agentProjects.connect, {
      name: "Sample Other",
      slug: "sample-other",
      region: "US",
      holdsPatientData: false,
      allowedProviders: ["ai_studio"],
      entropy: ENTROPY,
    });
    expect((await (await get(t, other, "/agents/v1/jobs")).json()).jobs).toEqual([]);
    const answered = await post(t, other, `/agents/v1/jobs/${runId}/results`, { results: [] });
    expect(answered.status).toBe(404);
    expect((await get(t, "rap_not-a-token", "/agents/v1/jobs")).status).toBe(401);
  });

  test("a failed or stale run keeps the gate shut", async () => {
    const { t, owner, token } = await setup();
    const draft = await draftWithCase(owner);
    await owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [draft.caseId] });
    const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
    await post(t, token, `/agents/v1/jobs/${jobs[0].id}/results`, {
      results: [passing(draft.caseId, { assertions: [{ index: 0, passed: false }] })],
    });
    const gate = async () => (await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT })).draft?.gate;
    expect(await gate()).toBe("failed");
    await expect(owner.mutation(api.agentHarness.publish, { id: draft.id })).rejects.toThrow(GATE_WORDS.failed);
    await owner.mutation(api.agentHarness.saveDraft, {
      id: draft.id,
      revision: draft.revision,
      ...editorOf({ params: { ...HARNESS.params, temperature: 0.9 } }),
    });
    expect(await gate()).toBe("stale");
  });
});

describe("publishing and rolling back", () => {
  test("a passed draft goes live as a new config version, carried in the config with its name", async () => {
    const { t, owner, token } = await setup();
    const draft = await passedDraft(t, owner, token);
    const published = await owner.mutation(api.agentHarness.publish, { id: draft.id });
    expect(published).toEqual({ configVersion: 1, version: "h1" });

    const config = await (await get(t, token, "/agents/v1/config")).json();
    expect(config.version).toBe(1);
    expect(config.agents).toEqual([
      {
        agentId: AGENT,
        name: "Sample rank",
        enabled: true,
        provider: "ai_studio",
        model: "made-up-flash",
        harness: { version: "h1", params: { ...HARNESS.params, temperature: 0.7 } },
      },
    ]);
    const overview = await owner.query(api.agentControl.overview, { today: TODAY, project: PROJECT });
    expect(overview.agents[0]).toMatchObject({ harnessVersion: "h1", pending: true });
    const changes = await owner.query(api.agentControl.changes, { project: PROJECT });
    expect(changes[0]!.after.harnessVersion).toBe("h1");

    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.published?.name).toBe("h1");
    expect(view.published?.publishedBy).toBe("You");
    expect(view.events.map((e) => [e.action, e.name, e.configVersion])).toEqual([["publish", "h1", 1]]);
  });

  test("rollback publishes an older version again, in a new config version; the newer one is archived", async () => {
    const { t, owner, token } = await setup();
    const first = await passedDraft(t, owner, token);
    await owner.mutation(api.agentHarness.publish, { id: first.id });
    const { id: secondId } = await owner.mutation(api.agentHarness.newDraft, {
      project: PROJECT,
      agentId: AGENT,
      from: "published",
    });
    await owner.mutation(api.agentHarness.saveDraft, {
      id: secondId,
      revision: 1,
      ...editorOf({ params: { ...HARNESS.params, temperature: 0.7 }, tools: [] }),
    });
    await owner.mutation(api.agentHarness.publish, { id: secondId, overrideReason: "Made-up urgent fix." });

    await expect(owner.mutation(api.agentHarness.rollback, { id: secondId })).rejects.toThrow(
      HARNESS_ACTION_WORDS.notRollback,
    );
    const rolled = await owner.mutation(api.agentHarness.rollback, { id: first.id });
    expect(rolled).toEqual({ configVersion: 3, version: "h1" });
    const config = await (await get(t, token, "/agents/v1/config")).json();
    expect(config.agents[0].harness).toEqual({ version: "h1", params: { ...HARNESS.params, temperature: 0.7 } });

    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.versions.map((v) => [v.name, v.status])).toEqual([
      ["h2", "archived"],
      ["h1", "published"],
    ]);
    expect(view.events.map((e) => [e.action, e.name, e.configVersion, e.overrideReason])).toEqual([
      ["rollback", "h1", 3, null],
      ["publish", "h2", 2, "Made-up urgent fix."],
      ["publish", "h1", 1, null],
    ]);
  });

  test("without a passing run only the owner may publish, and only saying why", async () => {
    const { t, owner } = await setup();
    const draft = await draftWithCase(owner);
    await expect(owner.mutation(api.agentHarness.publish, { id: draft.id })).rejects.toThrow(GATE_WORDS.no_run);
    await expect(owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "  " })).rejects.toThrow(
      HARNESS_ACTION_WORDS.overrideReason,
    );
    const engineer = await signInAsEngineer(t);
    await expect(
      engineer.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up reason." }),
    ).rejects.toThrow(HARNESS_ACTION_WORDS.overrideOwner);
    expect(await owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up reason." })).toEqual({
      configVersion: 1,
      version: "h1",
    });
  });

  test("a tool that handles patient data needs patient-data providers, and then holds the agent to them", async () => {
    const { t, owner, token } = await setup();
    const draft = await draftWithCase(owner, { tools: ["web_search", "chart_lookup"] });
    await expect(owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up." })).rejects.toThrow(
      `It cannot go live: tools: ${HARNESS_WORDS.phiTool}`,
    );
    // On Vertex AI, the tool may be switched on, and the agent stays on Vertex AI.
    await owner.mutation(api.agentControl.change, { project: PROJECT, agentId: AGENT, provider: "vertex", model: "made-up-pro" });
    const tests = await owner.query(api.agentHarness.tests, { project: PROJECT, agentId: AGENT });
    expect(tests.choices).toEqual([{ provider: "vertex", model: "made-up-pro" }]);
    await owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up." });
    await expect(
      owner.mutation(api.agentControl.change, { project: PROJECT, agentId: AGENT, provider: "ai_studio", model: "made-up-flash" }),
    ).rejects.toThrow("This agent handles patient data");
    expect((await (await get(t, token, "/agents/v1/config")).json()).agents[0].harness.tools).toEqual([
      "web_search",
      "chart_lookup",
    ]);
  });
});

describe("who may", () => {
  test("the agents area views, drafts and tests; sales cannot", async () => {
    const { t, owner } = await setup();
    const sales = await signInAsSales(t);
    await expect(sales.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT })).rejects.toThrow(
      "not_allowed",
    );
    await expect(
      sales.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" }),
    ).rejects.toThrow("not_allowed");
    const cofounder = await signInAsCofounder(t);
    const { id } = await cofounder.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: AGENT, from: "default" });
    expect((await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT })).draft?.createdBy).not.toBe(
      "You",
    );
    expect(id).toBeTruthy();
  });

  test("publishing and rolling back: the owner and engineers; agents without engineering may not", async () => {
    const { t, owner, token } = await setup();
    const draft = await passedDraft(t, owner, token);
    const agentsOnly = await signInWithAreas(t, "cofounder", ["agents"]);
    expect((await agentsOnly.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT })).mayPublish).toBe(false);
    await expect(agentsOnly.mutation(api.agentHarness.publish, { id: draft.id })).rejects.toThrow("not_allowed");
    await expect(agentsOnly.mutation(api.agentHarness.rollback, { id: draft.id })).rejects.toThrow("not_allowed");
    const engineer = await signInAsEngineer(t);
    expect((await engineer.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT })).mayPublish).toBe(true);
    expect(await engineer.mutation(api.agentHarness.publish, { id: draft.id })).toEqual({ configVersion: 1, version: "h1" });
  });

  test("Startup OS's own project and a made-up id are refused in their own words", async () => {
    const { owner } = await setup();
    await expect(owner.query(api.agentHarness.harness, { project: "startup-os", agentId: AGENT })).rejects.toThrow(
      "Startup OS's own agents are not connected with a token.",
    );
    await expect(owner.query(api.agentHarness.harness, { project: PROJECT, agentId: "made-up.none" })).rejects.toThrow(
      HARNESS_ACTION_WORDS.noAgent,
    );
  });
});

// ── Protocol v1.2 ────────────────────────────────────────────────────────────

const V12_AGENT = "sample.answer";
const CHAT_AGENT = "sample.chat";
const V12_VARIANTS = {
  default: {
    system: "Answer made-up policy questions.{{#denial}} Denied: {{denial}}.{{/denial}}",
    user: "Query: {{query}}",
  },
  retry: { system: "Retry, more firmly.{{^denial}} No denial given.{{/denial}}", user: "Again: {{query}}" },
};
const V12_HARNESS = {
  prompt: {
    version: "v2+made0up2",
    variables: [
      { name: "query", required: true },
      { name: "denial", required: false },
    ],
    variants: V12_VARIANTS,
  },
  tools: [
    { id: "lookup_codes", name: "Code lookup", description: "Made-up codes.", phi: false },
    { id: "google_search", name: "Google search", description: "The provider's own.", phi: false, kind: "provider" },
  ],
  defaultTools: ["lookup_codes", "google_search"],
};
const CHAT_HARNESS = {
  prompt: {
    version: "v3+made0up3",
    input: "messages",
    variables: [{ name: "payer", required: true }],
    variants: { default: { system: "Answer about {{payer}}." }, rubric: { system: "Grade {{payer}} by the rubric." } },
  },
};

const v12Body = () =>
  body(
    {},
    {
      agentUsage: [usageRow({ agentId: V12_AGENT }), usageRow({ agentId: CHAT_AGENT })],
      agentsKnown: [
        { agentId: V12_AGENT, name: "Sample answer", phi: false, kind: "declarative", harness: V12_HARNESS },
        { agentId: CHAT_AGENT, name: "Sample chat", phi: false, kind: "declarative", harness: CHAT_HARNESS },
      ],
    },
  );

async function setupV12() {
  const base = await setup();
  expect((await post(base.t, base.token, "/agents/v1/usage", v12Body())).status).toBe(200);
  return base;
}

const v12Draft = async (owner: Client, agentId: string, prompt: unknown) => {
  const { id } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId, from: "default" });
  const saved = await owner.mutation(api.agentHarness.saveDraft, {
    id,
    revision: 1,
    prompt: prompt as never,
    params: null,
    tools: agentId === V12_AGENT ? ["lookup_codes", "google_search"] : null,
    outputSchema: null,
    note: "",
  });
  return { id, revision: saved.revision };
};

describe("v1.2: variants, sections and messages", () => {
  test("the code's variants are stored as sent, and a draft edits every one of them", async () => {
    const { owner } = await setupV12();
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: V12_AGENT });
    expect(view.defaults?.prompt?.variants).toEqual(V12_VARIANTS);
    const edited = { variants: { ...V12_VARIANTS, retry: { ...V12_VARIANTS.retry, system: "Retry, made-up." } } };
    const draft = await v12Draft(owner, V12_AGENT, edited);
    expect(draft.revision).toBe(2);
    const after = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: V12_AGENT });
    expect(after.draft?.parts.prompt).toEqual(edited);
    expect(after.draft?.problems).toEqual([]);
    // The list of versions names the variants; it never carries a prompt.
    expect(after.versions[0]).toMatchObject({ changed: ["prompt"], promptVariants: ["default", "retry"] });
    expect(after.versions[0]).not.toHaveProperty("parts");
  });

  test("a dropped variant and an unbalanced section are problems with the variant and place, and cannot go live", async () => {
    const { owner } = await setupV12();
    const draft = await v12Draft(owner, V12_AGENT, {
      variants: { default: { system: "Line one.\n{{#denial}}never closed", user: "{{query}}" } },
    });
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: V12_AGENT });
    expect(view.draft?.problems).toEqual([
      { path: "prompt.retry", message: HARNESS_WORDS.variantDropped },
      { path: "prompt.default.system", message: TEMPLATE_WORDS.unclosed("#denial"), at: { line: 2, column: 1 } },
    ]);
    await expect(
      owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up." }),
    ).rejects.toThrow(`It cannot go live: prompt.retry: ${HARNESS_WORDS.variantDropped} (and 1 more)`);
  });

  test("a variant name that is not one, or a template over 128 KB, is not stored at all", async () => {
    const { owner } = await setupV12();
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: V12_AGENT, from: "default" });
    const save = (prompt: unknown) =>
      owner.mutation(api.agentHarness.saveDraft, {
        id,
        revision: 1,
        prompt: prompt as never,
        params: null,
        tools: null,
        outputSchema: null,
        note: "",
      });
    await expect(save({ variants: { ...V12_VARIANTS, "Bad-Name": V12_VARIANTS.retry } })).rejects.toThrow(
      HARNESS_ACTION_WORDS.variantName,
    );
    await expect(
      save({ variants: { ...V12_VARIANTS, retry: { system: "x".repeat(128 * 1024 + 1), user: "{{query}}" } } }),
    ).rejects.toThrow(HARNESS_ACTION_WORDS.tooBig);
  });

  test("published variants go out as variants, kept apart from the version and read back whole", async () => {
    const { t, owner, token } = await setupV12();
    const edited = { variants: { ...V12_VARIANTS, retry: { ...V12_VARIANTS.retry, system: "Retry, made-up." } } };
    const draft = await v12Draft(owner, V12_AGENT, edited);
    await owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up." });
    const config = await (await get(t, token, "/agents/v1/config")).json();
    const agent = config.agents.find((row: { agentId: string }) => row.agentId === V12_AGENT);
    expect(agent.harness).toEqual({ version: "h1", prompt: edited });
    const stored = await t.run(async (ctx) => ctx.db.query("agentHarnessVersions").collect());
    expect(stored[0]).not.toHaveProperty("prompt");
    expect(stored[0]!.promptVariants).toEqual(["default", "retry"]);
    const read = await owner.query(api.agentHarness.version, { id: draft.id });
    expect(read?.parts.prompt).toEqual(edited);
    // A new draft from it carries the prompt over.
    const { id: next } = await owner.mutation(api.agentHarness.newDraft, { project: PROJECT, agentId: V12_AGENT, from: "published" });
    expect((await owner.query(api.agentHarness.version, { id: next }))?.parts.prompt).toEqual(edited);
  });

  test("a messages agent: system templates only; cases carry a conversation and a variant to the job", async () => {
    const { t, owner, token } = await setupV12();
    const withUser = await v12Draft(owner, CHAT_AGENT, {
      variants: { default: { system: "Answer about {{payer}}.", user: "x" }, rubric: CHAT_HARNESS.prompt.variants.rubric },
    });
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: CHAT_AGENT });
    expect(view.draft?.problems).toEqual([{ path: "prompt.default.user", message: HARNESS_WORDS.messagesUser }]);
    await owner.mutation(api.agentHarness.discardDraft, { id: withUser.id });

    const draft = await v12Draft(owner, CHAT_AGENT, {
      variants: { ...CHAT_HARNESS.prompt.variants, rubric: { system: "Grade {{payer}} strictly." } },
    });
    const conversation = [
      { role: "user" as const, content: "Made-up: is a knee brace covered?" },
      { role: "assistant" as const, content: "Made-up: which plan?" },
      { role: "user" as const, content: "Made-up plan B." },
    ];
    const chatCase = (over: Record<string, unknown>) => ({ ...madeUpCase({ agentId: CHAT_AGENT, variables: { payer: "Made-up Payer" } }), ...over });
    await expect(owner.mutation(api.agentHarness.saveCase, chatCase({ name: "No conversation" }))).rejects.toThrow(
      "No conversation: gives no conversation, and this agent sends its own.",
    );
    // A text agent's case may not carry one.
    await expect(
      owner.mutation(api.agentHarness.saveCase, madeUpCase({ name: "Chatty", messages: [{ role: "user", content: "Made-up." }] })),
    ).rejects.toThrow("Chatty: has a conversation, but this agent sends one user turn from its template.");
    const { id: caseId } = await owner.mutation(
      api.agentHarness.saveCase,
      chatCase({ name: "Made-up chat", variant: "rubric", messages: conversation }),
    );
    const tests = await owner.query(api.agentHarness.tests, { project: PROJECT, agentId: CHAT_AGENT });
    expect(tests.input).toBe("messages");
    expect(tests.variants).toEqual(["default", "rubric"]);
    expect(tests.cases.find((c) => c.id === caseId)).toMatchObject({ variant: "rubric", messages: conversation });

    await owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [caseId] });
    const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
    expect(jobs[0].harness.prompt).toEqual({
      variants: { ...CHAT_HARNESS.prompt.variants, rubric: { system: "Grade {{payer}} strictly." } },
    });
    expect(jobs[0].cases).toEqual([
      {
        id: caseId,
        variables: { payer: "Made-up Payer" },
        variant: "rubric",
        messages: conversation,
        expect: [{ path: "$.codes", exists: true }],
      },
    ]);
  });

  test("a case's variant must be one the code declares, when it is saved and again before a run", async () => {
    const { t, owner } = await setupV12();
    const draft = await v12Draft(owner, V12_AGENT, { variants: V12_VARIANTS });
    await expect(
      owner.mutation(api.agentHarness.saveCase, madeUpCase({ agentId: V12_AGENT, name: "Odd variant", variant: "rubric" })),
    ).rejects.toThrow("Odd variant: uses the variant rubric, which the code does not declare.");
    // A case saved before its code dropped the variant is refused by the run.
    const { id } = await owner.mutation(api.agentHarness.saveCase, madeUpCase({ agentId: V12_AGENT, name: "Old", variant: "retry" }));
    await t.run(async (ctx) => ctx.db.patch(id, { variant: "rubric" }));
    await expect(owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [id] })).rejects.toThrow(
      "Old: uses the variant rubric, which the code does not declare.",
    );
    await expect(
      owner.mutation(api.agentHarness.saveCase, madeUpCase({ agentId: V12_AGENT, variant: "Not A Name" })),
    ).rejects.toThrow(CASE_WORDS.variant);
  });

  test("tools built into the provider are skipped in a test run, and the result says so", async () => {
    const { t, owner, token } = await setupV12();
    const draft = await v12Draft(owner, V12_AGENT, {
      variants: { ...V12_VARIANTS, retry: { ...V12_VARIANTS.retry, system: "Retry, made-up." } },
    });
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, madeUpCase({ agentId: V12_AGENT, variant: "retry" }));
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [caseId] });
    const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
    expect(jobs[0].cases[0].variant).toBe("retry");
    const at = `/agents/v1/jobs/${runId}/results`;
    const wrong = await post(t, token, at, { results: [passing(caseId, { skippedTools: ["web_search"] })] });
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).issues).toEqual([
      { path: "results.0.skippedTools.0", message: "is not a tool this job switched on." },
    ]);
    expect((await post(t, token, at, { results: [passing(caseId, { skippedTools: ["google_search"] })] })).status).toBe(200);
    const read = await owner.query(api.agentHarness.run, { id: runId });
    expect(read?.results[0]).toMatchObject({ passed: true, skippedTools: ["google_search"] });
    expect(read?.cases[0]).toMatchObject({ variant: "retry" });
  });

  test("a harness near 512 KB rides in a usage report and is stored whole", async () => {
    const { t, token } = await setup();
    const big = "x".repeat(120 * 1024);
    const harness = {
      prompt: {
        version: "v9",
        variables: [],
        variants: { default: { system: big, user: big }, retry: { system: big, user: big } },
      },
    };
    const response = await post(t, token, "/agents/v1/usage", body({ harness }));
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("harnessWanted");
    const stored = await t.run(async (ctx) => (await ctx.db.query("agentHarnessDefaults").first())!);
    expect(stored.harness.prompt?.variants?.retry?.user).toHaveLength(big.length);
    const tooBig = { prompt: { ...harness.prompt, variants: { ...harness.prompt.variants, more: { system: big, user: big } } } };
    const refused = await post(t, token, "/agents/v1/usage", body({ harness: tooBig }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).issues).toEqual([{ path: "agentsKnown.0.harness", message: HARNESS_WORDS.harnessSize }]);
  });

  test("a variant name that is not one is never quoted back in a path", async () => {
    const { t, token } = await setup();
    const harness = { prompt: { ...V12_HARNESS.prompt, variants: { ...V12_VARIANTS, "Made Up Name!": { system: 5 } } } };
    const refused = await post(t, token, "/agents/v1/usage", body({ harness }));
    expect(refused.status).toBe(422);
    const text = JSON.stringify(await refused.json());
    expect(text).not.toContain("Made Up Name");
  });
});

describe("v1.1 rows from before v1.2", () => {
  test("a version with its prompt inline is read, published and sent as v1.1 sent it", async () => {
    const { t, owner, token } = await setup();
    const userId = await t.run(async (ctx) => (await ctx.db.query("users").first())!._id);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("agentHarnessVersions", {
        project: PROJECT,
        agentId: AGENT,
        number: 1,
        status: "draft",
        revision: 1,
        prompt: { system: "Made-up v1.1 system.", user: "{{query}}" },
        note: "",
        createdBy: userId,
        createdAt: NOW,
        updatedBy: userId,
        updatedAt: NOW,
      }),
    );
    const view = await owner.query(api.agentHarness.harness, { project: PROJECT, agentId: AGENT });
    expect(view.draft?.parts.prompt).toEqual({ variants: { default: { system: "Made-up v1.1 system.", user: "{{query}}" } } });
    expect(view.versions[0]?.promptVariants).toEqual(["default"]);
    await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up." });
    const config = await (await get(t, token, "/agents/v1/config")).json();
    expect(config.agents[0].harness).toEqual({
      version: "h1",
      prompt: { system: "Made-up v1.1 system.", user: "{{query}}" },
    });
  });

  test("a run with its harness inline is still handed out", async () => {
    const { t, owner, token } = await setup();
    const draft = await draftWithCase(owner);
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [MODEL], caseIds: [draft.caseId] });
    await t.run(async (ctx) => {
      const payload = (await ctx.db.query("agentHarnessRunPayloads").first())!;
      await ctx.db.patch(runId, { harness: payload.harness, tools: undefined });
      await ctx.db.delete(payload._id);
    });
    const { jobs } = await (await get(t, token, "/agents/v1/jobs")).json();
    expect(jobs[0].harness.prompt).toEqual(CODE_PROMPT);
    const answered = await post(t, token, `/agents/v1/jobs/${runId}/results`, { results: [passing(draft.caseId)] });
    expect(answered.status).toBe(200);
  });
});
