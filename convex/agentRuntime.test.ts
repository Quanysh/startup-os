import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BUILDER_WORDS, DEFAULT_BUILDER_MODEL } from "./lib/agentBuilder";
import { MAX_PENDING_APPROVALS, MAX_RUNS_PER_DAY, STARTUP_OS_PROJECT, RUNTIME_ACTION_WORDS } from "./lib/agentStartupOs";
import { GEMINI_ENDPOINT } from "./lib/modelClients";
import schema from "./schema";
import { NETWORK_REFUSED } from "./test.network";
import { OWNER, modules, signInAsEngineer, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// Startup OS runs its own built agents (the project `startup-os`) on Gemini:
// Run now, the schedule, approvals that pause a write until the owner's
// click, test runs on fixtures, and who may read what came of it. Every
// agent, tool argument, answer and key is made up; the model is a fake fetch
// that answers in Gemini's shape, so no test reaches a provider.

const NOW = Date.parse("2026-10-17T12:00:00Z");
const KEY = "made-up-not-a-key";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("GOOGLE_GENAI_API_KEY", KEY);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;
type Body = { contents: { role: string; parts: Record<string, unknown>[] }[] };

const usage = { promptTokenCount: 50, candidatesTokenCount: 5 };
const says = (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: usage });
const calls = (name: string, args: Record<string, unknown>) => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
  usageMetadata: usage,
});
/** Whether the model has been given a tool's answer in this request. */
const answered = (body: Body) => body.contents.at(-1)?.parts.some((part) => "functionResponse" in part) === true;

/** A fake Gemini: answers each request from the body it was sent. */
function gemini(answer: (body: Body) => unknown) {
  const seen: { url: string; headers: Headers; body: Body }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      seen.push({ url: String(url), headers: new Headers(init?.headers), body });
      return new Response(JSON.stringify(answer(body)), { status: 200 });
    }),
  );
  return seen;
}

const finish = (t: TestBackend) => t.finishAllScheduledFunctions(vi.runAllTimers);

type Built = {
  tools?: string[];
  approvals?: string[];
  schedule?: { cron: string; variables: Record<string, string> };
  subAgent?: { toolId: string; description: string };
  system?: string;
  publish?: boolean;
  outputSchema?: string | null;
};

/** An agent built to run in Startup OS, saved and (unless said) published by the owner past the gate. */
async function built(owner: Client, agentId: string, over: Built = {}) {
  const { id } = await owner.mutation(api.agentBuilder.create, {
    project: STARTUP_OS_PROJECT,
    agentId,
    name: "Made-up helper",
    description: "Does a made-up thing.",
    mode: "text",
  });
  await owner.mutation(api.agentBuilder.saveDefinition, {
    id: id as Id<"agentHarnessVersions">,
    revision: 1,
    definition: {
      name: "Made-up helper",
      description: "Does a made-up thing.",
      input: { mode: "text", variables: [{ name: "request", required: true }] },
      model: { ...DEFAULT_BUILDER_MODEL },
      triggers: {
        api: true,
        ...(over.schedule === undefined ? {} : { schedule: over.schedule }),
        ...(over.subAgent === undefined ? {} : { subAgent: over.subAgent }),
      },
      approvals: over.approvals ?? [],
      limits: { maxSteps: 6, timeoutMs: 60_000 },
    },
    prompt: { variants: { default: { system: over.system ?? "Help with the made-up request.", user: "Request: {{request}}" } } },
    params: null,
    tools: over.tools ?? ["tasks"],
    outputSchema: over.outputSchema ?? null,
    note: "",
  });
  if (over.publish !== false) {
    await owner.mutation(api.agentHarness.publish, { id: id as Id<"agentHarnessVersions">, overrideReason: "Made-up: published for a test." });
  }
  return id as Id<"agentHarnessVersions">;
}

const runsOf = (owner: Client, agentId: string) => owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId });

describe("Run now", () => {
  test("a read tool runs as the owner; the summary, the day's usage and the answer are kept", async () => {
    const seen = gemini((body) => (answered(body) ? says("Made-up summary of the board.") : calls("tasks", { company: "us" })));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.reader");
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "os.reader", variables: { request: "made-up" } });
    await finish(t);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe(`${GEMINI_ENDPOINT}/${DEFAULT_BUILDER_MODEL.model}:generateContent`);
    expect(seen[0]!.headers.get("x-goog-api-key")).toBe(KEY);
    expect(seen[1]!.body.contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { name: "tasks" } });

    const view = await runsOf(owner, "os.reader");
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({
      runId,
      version: "h1",
      trigger: "api",
      status: "ok",
      steps: 2,
      costUsd: null,
      errorClass: null,
      toolCalls: [{ toolId: "tasks", status: "ok" }],
      pendingApprovals: 0,
    });
    const rows = await t.run((ctx) => ctx.db.query("agentUsage").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project: STARTUP_OS_PROJECT,
      agentId: "os.reader",
      promptVersion: "h1",
      provider: "ai_studio",
      model: DEFAULT_BUILDER_MODEL.model,
      day: "2026-10-17",
      calls: 1,
      errors: 0,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(rows[0]!.costUsd).toBeUndefined();
    expect(rows[0]!.p95Ms).toBeTypeOf("number");
    expect(await owner.query(api.agentRuntime.output, { runId })).toEqual({
      runId,
      agentId: "os.reader",
      format: "text",
      text: "Made-up summary of the board.",
      truncated: false,
    });
    // What the run's tools read never reaches a stored row other than its answer.
    const runtime = await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect());
    expect(runtime[0]).toMatchObject({ state: "done", trigger: "api" });
    expect(runtime[0]!.resume).toBeUndefined();
  });

  test("refused in words while it is off, over its budget, not configured or given too little, and only for the owner", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.reader");
    const run = (variables: Record<string, string> = { request: "made-up" }) =>
      owner.mutation(api.agentRuntime.runNow, { agentId: "os.reader", variables });

    await expect(run({})).rejects.toThrow(BUILDER_WORDS.scheduleRequired("request"));
    await expect(run({ request: "made-up", other: "x" })).rejects.toThrow(BUILDER_WORDS.scheduleVariable("other"));
    await expect(owner.mutation(api.agentRuntime.runNow, { agentId: "os.nobody", variables: {} })).rejects.toThrow(RUNTIME_ACTION_WORDS.noAgent);

    vi.stubEnv("GOOGLE_GENAI_API_KEY", "");
    await expect(run()).rejects.toThrow(RUNTIME_ACTION_WORDS.notConfigured(["GOOGLE_GENAI_API_KEY"]));
    vi.stubEnv("GOOGLE_GENAI_API_KEY", KEY);

    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect()).find((row) => row.agentId === "os.reader")!;
      await ctx.db.patch(control._id, { monthlyBudgetUsd: 20 });
      await ctx.db.insert("agentUsage", {
        project: STARTUP_OS_PROJECT,
        agentId: "os.reader",
        promptVersion: "h1",
        provider: "ai_studio",
        model: DEFAULT_BUILDER_MODEL.model,
        day: "2026-10-16",
        calls: 3,
        errors: 0,
        schemaFailures: 0,
        fallbacks: 0,
        refusals: 0,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 25,
        syncedAt: NOW,
      });
    });
    await expect(run()).rejects.toThrow(RUNTIME_ACTION_WORDS.overBudget);
    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect()).find((row) => row.agentId === "os.reader")!;
      await ctx.db.patch(control._id, { enabled: false, monthlyBudgetUsd: undefined });
    });
    await expect(run()).rejects.toThrow(RUNTIME_ACTION_WORDS.off);

    const engineer = await signInAsEngineer(t);
    await expect(engineer.mutation(api.agentRuntime.runNow, { agentId: "os.reader", variables: { request: "x" } })).rejects.toThrow("not_owner");
    expect(await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect())).toEqual([]);
  });

  test("an agent not yet published does not run", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.draft", { publish: false });
    await expect(owner.mutation(api.agentRuntime.runNow, { agentId: "os.draft", variables: { request: "x" } })).rejects.toThrow(
      RUNTIME_ACTION_WORDS.notPublished,
    );
  });
});

describe("a change waits for the owner's click", () => {
  async function waiting() {
    const seen = gemini((body) => (answered(body) ? says("Done.") : calls("task_create", { title: "Made-up card" })));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.writer", { tools: ["task_create"], approvals: ["task_create"] });
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "os.writer", variables: { request: "made-up" } });
    await finish(t);
    return { t, owner, runId, seen };
  }

  test("the run pauses with the call and its arguments, which only the owner sees; nothing is changed", async () => {
    const { t, owner, runId } = await waiting();
    const view = await runsOf(owner, "os.writer");
    expect(view.runs[0]).toMatchObject({
      runId,
      status: "awaiting_approval",
      pendingApprovals: 1,
      toolCalls: [{ toolId: "task_create", status: "skipped", approval: "pending" }],
    });
    expect(view.pendingApprovals).toBe(1);
    const pending = await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ rootRunId: runId, runId, agentId: "os.writer", toolId: "task_create", arguments: '{"title":"Made-up card"}' });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // The usage counts a run when it ends, not while it waits.
    expect(await t.run((ctx) => ctx.db.query("agentUsage").collect())).toEqual([]);

    const engineer = await signInAsEngineer(t);
    await expect(engineer.query(api.agentRuntime.approvals, { agentId: "os.writer" })).rejects.toThrow("not_owner");
    await expect(engineer.mutation(api.agentRuntime.decide, { id: pending[0]!.id, decision: "approve" })).rejects.toThrow("not_owner");
  });

  test("approved: the tool runs as the owner, once, and the run goes on", async () => {
    const { t, owner, runId } = await waiting();
    const [pending] = await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" });
    await owner.mutation(api.agentRuntime.decide, { id: pending!.id, decision: "approve" });
    await finish(t);
    const cards = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(cards.map((card) => card.title)).toEqual(["Made-up card"]);
    const view = await runsOf(owner, "os.writer");
    expect(view.runs[0]).toMatchObject({
      runId,
      status: "ok",
      pendingApprovals: 0,
      toolCalls: [{ toolId: "task_create", status: "ok", approval: "approved" }],
    });
    expect(await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" })).toEqual([]);
    await expect(owner.mutation(api.agentRuntime.decide, { id: pending!.id, decision: "approve" })).rejects.toThrow(RUNTIME_ACTION_WORDS.decided);
    expect((await t.run((ctx) => ctx.db.query("agentUsage").collect()))[0]).toMatchObject({ calls: 1, errors: 0 });
  });

  test("denied: nothing is changed, the model is told, and the run goes on", async () => {
    const { t, owner, runId, seen } = await waiting();
    const [pending] = await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" });
    // One rule with a proposal's rejection: no denial without a reason, and a refused one changes nothing.
    for (const reason of [undefined, "   "]) {
      await expect(
        owner.mutation(api.agentRuntime.decide, { id: pending!.id, decision: "deny", ...(reason === undefined ? null : { reason }) }),
      ).rejects.toThrow(RUNTIME_ACTION_WORDS.denyReason);
    }
    expect(await t.run((ctx) => ctx.db.get(pending!.id))).toMatchObject({ state: "pending" });
    await owner.mutation(api.agentRuntime.decide, { id: pending!.id, decision: "deny", reason: "  Not this week  " });
    await finish(t);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // The owner's reason (typed on /approvals) is kept on the row, cleaned.
    expect(await t.run((ctx) => ctx.db.get(pending!.id))).toMatchObject({ state: "denied", denyReason: "Not this week" });
    expect(seen.at(-1)!.body.contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { name: "task_create", response: { denied: expect.any(String) } } });
    expect((await runsOf(owner, "os.writer")).runs[0]).toMatchObject({
      runId,
      status: "ok",
      toolCalls: [{ toolId: "task_create", status: "denied", approval: "denied" }],
    });    // Listed among what was decided on /approvals, with the owner's words.
    expect(await owner.query(api.assistant.decided, { since: 0 })).toEqual([
      expect.objectContaining({ source: "tool_call", id: pending!.id, status: "denied", rejectReason: "Not this week" }),
    ]);
  });

  test("an approval lets through only the exact call it was given for, once", async () => {
    const { t, owner, runId } = await waiting();
    const [pending] = await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" });
    // Approved by hand, the run still held waiting so nothing resumes it.
    await t.run(async (ctx) => {
      await ctx.db.patch(pending!.id, { state: "approved", decidedAt: NOW });
      const run = (await ctx.db.query("agentRuntimeRuns").collect())[0]!;
      await ctx.db.patch(run._id, { state: "running" });
    });
    const call = (over: Record<string, unknown> = {}) =>
      t.mutation(internal.agentRuntime.actTool, {
        rootRunId: runId,
        runId,
        agentId: "os.writer",
        versionNumber: 1,
        toolId: "task_create",
        input: JSON.stringify({ title: "Made-up card" }),
        now: NOW,
        today: "2026-10-17",
        ...over,
      });
    const refused = { status: "error", message: "That change was not approved." };
    expect(await call({ input: JSON.stringify({ title: "Another made-up card" }) })).toEqual(refused);
    expect(await call({ runId: "os-other" })).toEqual(refused);
    expect(await call({ agentId: "os.reader" })).toMatchObject({ status: "error" });
    expect(await call({ toolId: "task_update", input: "{}" })).toMatchObject({ status: "error" });
    const kept = await t.run((ctx) => ctx.db.get(pending!.id));
    expect(kept?.state).toBe("approved");
    expect(kept?.usedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // The same arguments in another key order are the same call.
    expect(await call({ input: '{ "title" : "Made-up card" }' })).toMatchObject({ status: "ok" });
    expect(await call()).toEqual(refused);
    expect((await t.run((ctx) => ctx.db.query("tasks").collect())).map((card) => card.title)).toEqual(["Made-up card"]);
  });

  test("a tool not in the version's own list never runs, approved or not", async () => {
    const { t, runId } = await waiting();
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("agentRuntimeRuns").collect())[0]!;
      await ctx.db.patch(run._id, { state: "running" });
    });
    const ran = await t.query(internal.agentRuntime.readTool, {
      rootRunId: runId,
      runId,
      agentId: "os.writer",
      versionNumber: 1,
      toolId: "deals",
      input: "{}",
      now: NOW,
      today: "2026-10-17",
    });
    expect(ran).toMatchObject({ status: "error" });
  });
});

describe("the schedule", () => {
  const AT_SIX = Date.parse("2026-10-18T06:00:00Z");
  const schedule = { cron: "0 6 * * *", variables: { request: "made-up daily sweep" } };

  test("a due minute runs once, however often the tick comes, and a late tick still runs it", async () => {
    gemini(() => says("Swept."));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.daily", { schedule });
    vi.setSystemTime(AT_SIX - 30_000);
    await t.mutation(internal.agentRuntime.tick, {});
    expect(await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect())).toEqual([]);

    vi.setSystemTime(AT_SIX + 20_000);
    await t.mutation(internal.agentRuntime.tick, {});
    await t.mutation(internal.agentRuntime.tick, {});
    vi.setSystemTime(AT_SIX + 90_000);
    await t.mutation(internal.agentRuntime.tick, {});
    await finish(t);
    const runs = await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule", scheduledFor: AT_SIX, state: "done" });
    expect((await runsOf(owner, "os.daily")).runs[0]).toMatchObject({ trigger: "schedule", status: "ok" });

    vi.setSystemTime(AT_SIX + 5 * 60_000);
    await t.mutation(internal.agentRuntime.tick, {});
    expect(await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect())).toHaveLength(1);
  });

  test("an agent switched off is not started; one whose provider is not configured is a refused run", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.daily", { schedule });
    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect())[0]!;
      await ctx.db.patch(control._id, { enabled: false });
    });
    vi.setSystemTime(AT_SIX + 10_000);
    await t.mutation(internal.agentRuntime.tick, {});
    expect(await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect())).toEqual([]);

    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect())[0]!;
      await ctx.db.patch(control._id, { enabled: true });
    });
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "");
    await t.mutation(internal.agentRuntime.tick, {});
    await finish(t);
    expect((await runsOf(owner, "os.daily")).runs[0]).toMatchObject({ trigger: "schedule", status: "refused", errorClass: "provider_not_configured" });
    expect((await t.run((ctx) => ctx.db.query("agentUsage").collect()))[0]).toMatchObject({ calls: 1, refusals: 1 });
  });

  test("a run whose action died is ended as timed out", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.reader");
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect())[0]!._id);
    await t.run((ctx) =>
      ctx.db.insert("agentRuntimeRuns", {
        project: STARTUP_OS_PROJECT,
        runId: "os-stuck",
        agentId: "os.reader",
        versionNumber: 1,
        trigger: "api",
        state: "running",
        actAs: ownerId,
        input: "{}",
        createdAt: NOW - 20 * 60_000,
        claimedAt: NOW - 20 * 60_000,
      }),
    );
    await t.mutation(internal.agentRuntime.tick, {});
    expect((await runsOf(owner, "os.reader")).runs[0]).toMatchObject({ runId: "os-stuck", status: "timeout", errorClass: "timeout" });
  });
});

describe("test runs of a Startup OS draft", () => {
  test("run here on the case's fixtures, nothing changed, and the gate opens", async () => {
    const seen = gemini((body) => (answered(body) ? says("Done: made-up card added.") : calls("task_create", { title: "Made-up card" })));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await built(owner, "os.tested", { tools: ["task_create"], approvals: ["task_create"], publish: false });
    const tests = await owner.query(api.agentHarness.tests, { project: STARTUP_OS_PROJECT, agentId: "os.tested" });
    expect(tests.choices).toContainEqual({ provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model });
    expect(tests.choices.some((choice) => choice.provider === "astana_gpu")).toBe(false);
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
      project: STARTUP_OS_PROJECT,
      agentId: "os.tested",
      name: "Made-up request",
      variables: { request: "add a made-up card" },
      toolFixtures: JSON.stringify({ task_create: { id: "made-up", created: true } }),
      expect: [{ path: "$", op: "contains", value: '"made-up card"' }],
      madeUp: true,
    });
    const { id: runId } = await owner.mutation(api.agentHarness.startRun, {
      draftId: id,
      models: [{ provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model }],
      caseIds: [caseId],
    });
    await finish(t);
    expect(seen).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    const result = await owner.query(api.agentHarness.run, { id: runId });
    expect(result?.status).toBe("done");
    expect(result?.results[0]).toMatchObject({
      passed: true,
      error: null,
      schemaValid: true,
      output: '"Done: made-up card added."',
      steps: 2,
      toolCalls: [{ toolId: "task_create", status: "ok" }],
      costUsd: null,
    });
    const harness = await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "os.tested" });
    expect(harness.draft?.gate).toBe("passed");
    expect(await owner.mutation(api.agentHarness.publish, { id })).toMatchObject({ version: "h1" });
    // A test run is no run of the agent: nothing in its runs or its usage.
    expect((await runsOf(owner, "os.tested")).runs).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("agentUsage").collect())).toEqual([]);
  });

  test("a case that fails its expectation fails the gate", async () => {
    gemini(() => says("Something else."));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await built(owner, "os.tested", { publish: false });
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
      project: STARTUP_OS_PROJECT,
      agentId: "os.tested",
      name: "Made-up request",
      variables: { request: "made-up" },
      expect: [{ path: "$", op: "contains", value: '"made-up card"' }],
      madeUp: true,
    });
    await owner.mutation(api.agentHarness.startRun, { draftId: id, models: [{ provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model }], caseIds: [caseId] });
    await finish(t);
    expect((await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "os.tested" })).draft?.gate).toBe("failed");
  });
});

describe("who reads what came of a run", () => {
  test("an agent using an owner-only tool: its answers and its test runs are the owner's alone", async () => {
    gemini((body) => (answered(body) ? says("Made-up costs summary.") : calls("costs", {})));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await built(owner, "os.spend", { tools: ["costs"] });
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "os.spend", variables: { request: "made-up" } });
    await finish(t);
    expect((await owner.query(api.agentRuntime.output, { runId }))?.text).toBe("Made-up costs summary.");
    const engineer = await signInAsEngineer(t);
    await expect(engineer.query(api.agentRuntime.output, { runId })).rejects.toThrow("not_allowed");
    await expect(engineer.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "os.spend" })).rejects.toThrow("not_allowed");
    // Its test runs too.
    await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "os.spend", from: "published" });
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
      project: STARTUP_OS_PROJECT,
      agentId: "os.spend",
      name: "Made-up",
      variables: { request: "made-up" },
      toolFixtures: JSON.stringify({ costs: { lines: [] } }),
      expect: [],
      madeUp: true,
    });
    const draft = (await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "os.spend" })).draft!;
    expect(id).not.toBe(draft.id);
    const { id: testRun } = await owner.mutation(api.agentHarness.startRun, {
      draftId: draft.id,
      models: [{ provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model }],
      caseIds: [caseId],
    });
    await finish(t);
    expect((await owner.query(api.agentHarness.run, { id: testRun }))?.results).toHaveLength(1);
    await expect(engineer.query(api.agentHarness.run, { id: testRun })).rejects.toThrow("not_allowed");
  });

  test("otherwise: whoever may read the runs and holds every page its tools read", async () => {
    gemini((body) => (answered(body) ? says("Made-up deals summary.") : calls("deals", {})));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.deals", { tools: ["deals"] });
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "os.deals", variables: { request: "made-up" } });
    await finish(t);
    // The engineer's pages are product, engineering, board and agents: not sales.
    const engineer = await signInAsEngineer(t);
    expect((await runsOf(engineer, "os.deals")).runs).toHaveLength(1);
    await expect(engineer.query(api.agentRuntime.output, { runId })).rejects.toThrow("not_allowed");
    const seller = await signInWithAreas(t, "sales", ["agents", "sales"]);
    expect((await seller.query(api.agentRuntime.output, { runId }))?.text).toBe("Made-up deals summary.");
    const noAgents = await signInWithAreas(t, "cofounder", ["sales"]);
    await expect(noAgents.query(api.agentRuntime.output, { runId })).rejects.toThrow("not_allowed");
  });
});

describe("a chat box is the Assistant's, not an agent's here", () => {
  test("saving one on a Startup OS agent is refused, pointing at /assistant", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const { id } = await owner.mutation(api.agentBuilder.create, {
      project: STARTUP_OS_PROJECT,
      agentId: "os.chatty",
      name: "Made-up chat",
      description: "Talks about made-up things.",
      mode: "messages",
    });
    await expect(
      owner.mutation(api.agentBuilder.saveDefinition, {
        id: id as Id<"agentHarnessVersions">,
        revision: 1,
        definition: {
          name: "Made-up chat",
          description: "Talks about made-up things.",
          input: { mode: "messages", variables: [] },
          model: { ...DEFAULT_BUILDER_MODEL },
          triggers: { api: true, chat: { enabled: true, title: "Help", greeting: "Ask me." } },
          approvals: [],
          limits: { maxSteps: 6, timeoutMs: 60_000 },
        },
        prompt: { variants: { default: { system: "Be brief." } } },
        params: null,
        tools: [],
        outputSchema: null,
        note: "",
      }),
    ).rejects.toThrow(BUILDER_WORDS.chatRunsHere);
  });
});

describe("how it is written", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const sources = (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => /\.(ts|tsx|js|mjs|cjs|mts|cts|jsx)$/.test(path) && !/\.test\.|\.kit\.|test\.setup|fixtures|^_generated/.test(path))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const MODEL_CLIENTS = join("lib", "modelClients.ts");

  test("only the model-client module reads a provider's variables or calls a provider", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const { path, text } of sources) {
      if (path === MODEL_CLIENTS) continue;
      expect(text, path).not.toMatch(/generativelanguage\.googleapis\.com|x-goog-api-key|\/chat\/completions/i);
      expect(text, path).not.toMatch(/process\.env\.(GOOGLE_GENAI_API_KEY|OPEN_MODELS_BASE_URL|OPEN_MODELS_API_KEY)/);
      // A module that holds the variables' names (to say them) never reads the environment.
      if (/GOOGLE_GENAI_API_KEY|OPEN_MODELS_|STARTUP_OS_PROVIDER_ENV|providersConfigured/.test(text)) {
        expect(text, path).not.toMatch(/process\.env/);
      }
    }
  });

  test("the chat, the owner's agent endpoint and the Assistant still reach no model and hold no model key", () => {
    const shut = sources.filter(({ path }) =>
      ["chat.ts", "mcp.ts", "assistant.ts", join("lib", "mcpTools.ts")].includes(path) || path.startsWith(join("lib", "chat")),
    );
    expect(shut.length).toBeGreaterThanOrEqual(6);
    for (const { path, text } of shut) {
      expect(text, path).not.toMatch(/GOOGLE_GENAI_API_KEY|OPEN_MODELS_|modelClients|agentRuntime|generativelanguage|x-goog-api-key/);
    }
  });

  test("a test that forgot to stub fetch fails instead of reaching the network", async () => {
    vi.unstubAllGlobals();
    await expect(fetch(GEMINI_ENDPOINT)).rejects.toThrow(NETWORK_REFUSED);
  });

  test("nothing in the runtime logs", () => {
    for (const path of ["agentRuntime.ts", join("lib", "agentRuntime.ts"), MODEL_CLIENTS]) {
      expect(sources.find((source) => source.path === path)?.text, path).not.toMatch(/console\./);
    }
  });
});

describe("what keeps the spend and the waiting bounded", () => {
  const schedule = { cron: "0 6 * * *", variables: { request: "made-up daily sweep" } };
  const AT_SIX = Date.parse("2026-10-18T06:00:00Z");

  test("a schedule is skipped while the agent has a run queued, running or waiting", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.daily", { schedule });
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect())[0]!._id);
    for (const state of ["queued", "running", "awaiting_approval"] as const) {
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("agentRuntimeRuns").collect()) await ctx.db.delete(row._id);
        await ctx.db.insert("agentRuntimeRuns", {
          project: STARTUP_OS_PROJECT,
          runId: `os-busy-${state}`,
          agentId: "os.daily",
          versionNumber: 1,
          trigger: "api",
          state,
          actAs: ownerId,
          input: "{}",
          createdAt: AT_SIX - 1_000,
          claimedAt: AT_SIX - 1_000,
        });
      });
      vi.setSystemTime(AT_SIX + 10_000);
      await t.mutation(internal.agentRuntime.tick, {});
      expect((await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect())).map((row) => row.runId)).toEqual([`os-busy-${state}`]);
    }
  });

  test("a Startup OS agent's schedule runs at most every five minutes", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(built(owner, "os.busy", { schedule: { cron: "*/2 * * * *", variables: { request: "x" } }, publish: false })).rejects.toThrow(
      BUILDER_WORDS.scheduleTooOften,
    );
  });

  test("Run now is refused past the day's cap on runs, and past ten calls waiting", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.reader");
    const run = () => owner.mutation(api.agentRuntime.runNow, { agentId: "os.reader", variables: { request: "made-up" } });
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
        await ctx.db.insert("agentApprovals", {
          project: STARTUP_OS_PROJECT,
          rootAgentId: "os.reader",
          rootRunId: `os-wait-${i}`,
          agentId: "os.reader",
          runId: `os-wait-${i}`,
          toolId: "tasks",
          arguments: "{}",
          state: "pending",
          createdAt: NOW - i,
        });
      }
    });
    await expect(run()).rejects.toThrow(RUNTIME_ACTION_WORDS.tooManyWaiting);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("agentApprovals").collect()) await ctx.db.delete(row._id);
      for (let i = 0; i < MAX_RUNS_PER_DAY; i += 1) {
        await ctx.db.insert("agentRuns", {
          project: STARTUP_OS_PROJECT,
          runId: `os-today-${i}`,
          agentId: "os.reader",
          version: "h1",
          trigger: "api",
          status: "ok",
          startedAt: NOW - 1_000 - i,
          durationMs: 1,
          steps: 1,
          toolCalls: [],
          pendingApprovals: 0,
          receivedAt: NOW,
        });
      }
    });
    await expect(run()).rejects.toThrow(RUNTIME_ACTION_WORDS.dailyCap);
  });

  test("the owner's list of waiting calls is newest first and never hides a new one", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 70; i += 1) {
        await ctx.db.insert("agentApprovals", {
          project: STARTUP_OS_PROJECT,
          rootAgentId: "os.writer",
          rootRunId: `os-wait-${i}`,
          agentId: "os.writer",
          runId: `os-wait-${i}`,
          toolId: "task_create",
          arguments: "{}",
          state: "pending",
          createdAt: NOW + i,
        });
      }
    });
    const listed = await owner.query(api.agentRuntime.approvals, { agentId: "os.writer" });
    expect(listed[0]!.runId).toBe("os-wait-69");
    expect(listed.map((row) => row.createdAt)).toEqual([...listed.map((row) => row.createdAt)].sort((a, b) => b - a));
  });

  test("the purge gets past old rows it must keep", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    void owner;
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect())[0]!._id);
    const old = NOW - 100 * 86_400_000;
    await t.run(async (ctx) => {
      const base = { project: STARTUP_OS_PROJECT, agentId: "os.writer", versionNumber: 1, trigger: "api" as const, actAs: ownerId, input: "{}" };
      for (let i = 0; i < 600; i += 1) {
        await ctx.db.insert("agentRuntimeRuns", { ...base, runId: `os-wait-${i}`, state: "awaiting_approval", createdAt: old + i });
        await ctx.db.insert("agentApprovals", {
          project: STARTUP_OS_PROJECT,
          rootAgentId: "os.writer",
          rootRunId: `os-wait-${i}`,
          agentId: "os.writer",
          runId: `os-wait-${i}`,
          toolId: "task_create",
          arguments: "{}",
          state: "pending",
          createdAt: old + i,
        });
      }
      await ctx.db.insert("agentRuntimeRuns", { ...base, runId: "os-done", state: "done", createdAt: old + 1_000 });
      await ctx.db.insert("agentApprovals", {
        project: STARTUP_OS_PROJECT,
        rootAgentId: "os.writer",
        rootRunId: "os-done",
        agentId: "os.writer",
        runId: "os-done",
        toolId: "task_create",
        arguments: "{}",
        state: "denied",
        createdAt: old + 1_000,
      });
    });
    await t.mutation(internal.agentRuntime.purge, {});
    await finish(t);
    const runs = await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect());
    expect(runs.some((row) => row.runId === "os-done")).toBe(false);
    expect(runs).toHaveLength(600);
    expect((await t.run((ctx) => ctx.db.query("agentApprovals").collect())).some((row) => row.state === "denied")).toBe(false);
  });

  test("a run queued and never started is ended with a class", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.reader");
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect())[0]!._id);
    await t.run((ctx) =>
      ctx.db.insert("agentRuntimeRuns", {
        project: STARTUP_OS_PROJECT,
        runId: "os-never",
        agentId: "os.reader",
        versionNumber: 1,
        trigger: "api",
        state: "queued",
        actAs: ownerId,
        input: "{}",
        createdAt: NOW - 10 * 60_000,
      }),
    );
    await t.mutation(internal.agentRuntime.tick, {});
    expect((await runsOf(owner, "os.reader")).runs[0]).toMatchObject({ runId: "os-never", status: "error", errorClass: "server" });
    expect((await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect()))[0]).toMatchObject({ state: "done" });
  });

  test("a test run is refused while the agent is off, and to anyone who may not read its runs", async () => {
    gemini(() => says("never"));
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.spend", { tools: ["costs"] });
    await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "os.spend", from: "published" });
    const draft = (await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "os.spend" })).draft!;
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
      project: STARTUP_OS_PROJECT,
      agentId: "os.spend",
      name: "Made-up",
      variables: { request: "made-up" },
      expect: [],
      madeUp: true,
    });
    const start = (client: Client) =>
      client.mutation(api.agentHarness.startRun, { draftId: draft.id, models: [{ provider: "ai_studio", model: DEFAULT_BUILDER_MODEL.model }], caseIds: [caseId] });
    const engineer = await signInAsEngineer(t);
    await expect(start(engineer)).rejects.toThrow("not_allowed");
    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect())[0]!;
      await ctx.db.patch(control._id, { enabled: false });
    });
    await expect(start(owner)).rejects.toThrow(RUNTIME_ACTION_WORDS.off);
  });
});

describe("who may read an answer is decided when it is kept", () => {
  test("republishing a sub-agent without the owner-only tool does not open an old answer", async () => {
    gemini((body) => {
      const system = JSON.stringify((body as unknown as { systemInstruction: unknown }).systemInstruction);
      if (system.includes("Spend")) return answered(body) ? says("Made-up spend.") : calls("costs", {});
      return answered(body) ? says("Made-up answer from the boss.") : calls("spend", { request: "made-up" });
    });
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await built(owner, "os.spender", { tools: ["costs"], system: "Spend.", subAgent: { toolId: "spend", description: "Reads made-up costs." } });
    await built(owner, "os.boss", { tools: ["spend"], system: "Boss." });
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "os.boss", variables: { request: "made-up" } });
    await finish(t);
    expect((await owner.query(api.agentRuntime.output, { runId }))?.text).toBe("Made-up answer from the boss.");
    const kept = await t.run((ctx) => ctx.db.query("agentRunOutputs").collect());
    expect(kept.find((row) => row.runId === runId)).toMatchObject({ ownerOnly: true, areas: ["costs"] });

    // The sub-agent now reads the scorecard only.
    await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "os.spender", from: "published" });
    const draft = (await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "os.spender" })).draft!;
    await owner.mutation(api.agentBuilder.saveDefinition, {
      id: draft.id,
      revision: draft.revision,
      definition: { ...draft.definition!, triggers: { api: true, subAgent: { toolId: "spend", description: "Reads made-up figures." } } },
      prompt: draft.parts.prompt!,
      params: null,
      tools: ["metrics"],
      outputSchema: null,
      note: "",
    });
    await owner.mutation(api.agentHarness.publish, { id: draft.id, overrideReason: "Made-up: no costs any more." });

    const cofounder = await signInWithAreas(t, "cofounder", ["agents", "scorecard", "finance"]);
    await expect(cofounder.query(api.agentRuntime.output, { runId })).rejects.toThrow("not_allowed");
    await expect(cofounder.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "os.boss" })).rejects.toThrow("not_allowed");
  });
});
