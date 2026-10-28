import { describe, expect, test } from "vitest";
import type { ConfigDefinition } from "./agentBuilder";
import { nextRuns } from "./agentCron";
import {
  MAX_STATE_BYTES,
  RUNTIME_WORDS,
  budgetState,
  dueAt,
  evaluateAssertions,
  percentile,
  runRefusal,
  resumeRun,
  resultErrorOf,
  schemaFits,
  startRun,
  type Outcome,
  type RunMode,
  type RuntimeAgent,
  type ToolOutcome,
  type World,
} from "./agentRuntime";
import { ModelError, type ModelReply, type ModelRequest } from "./modelClients";

// The runner for the agents Startup OS runs itself: the prompt, the tool loop,
// steps and time, sub-agents in process, the output schema, approvals that
// pause and resume a run, and the test mode that answers every tool from a
// fixture. Every model is a fake that answers from a script and every tool a
// fake: no test reaches a provider, and every agent, tool and value is made up.

const T0 = Date.parse("2026-10-17T12:00:00Z");

const definition = (over: Partial<ConfigDefinition> = {}): ConfigDefinition => ({
  name: "Made-up agent",
  description: "Does a made-up thing.",
  input: { mode: "text", variables: [{ name: "request", required: true }] },
  harness: {
    version: "h1",
    prompt: { variants: { default: { system: "You sort {{request}}.", user: "Request: {{request}}{{#note}} ({{note}}){{/note}}" } } },
    tools: ["tasks", "task_create"],
  },
  triggers: { api: true },
  approvals: ["task_create"],
  limits: { maxSteps: 5, timeoutMs: 60_000 },
  ...over,
});

const agent = (over: Partial<RuntimeAgent> & { def?: Partial<ConfigDefinition> } = {}): RuntimeAgent => {
  const { def, ...rest } = over;
  return {
    agentId: "os.sorter",
    version: "h1",
    versionNumber: 1,
    definition: definition(def),
    model: { provider: "ai_studio", model: "gemini-3.8-flash" },
    refusal: null,
    ...rest,
  };
};

const reply = (over: Partial<ModelReply> = {}): ModelReply => ({
  text: "",
  toolCalls: [],
  finish: "stop",
  usage: { inputTokens: 100, outputTokens: 10 },
  ...over,
});
const say = (text: string) => reply({ text });
const call = (name: string, args: Record<string, unknown> = {}, id = `c-${name}`) =>
  reply({ toolCalls: [{ id, name, args }], finish: "tool_calls" });

type Script = (request: ModelRequest, model: string, provider: string) => ModelReply | Promise<ModelReply>;

/** A world of fakes: a scripted model per provider, a clock, tools that answer from a table. */
function world(script: Script | ModelReply[], more: Partial<World> & { tools?: Record<string, ToolOutcome>; peers?: RuntimeAgent[] } = {}) {
  let clock = T0;
  let ids = 0;
  const requests: { provider: string; request: ModelRequest }[] = [];
  const executed: { toolId: string; args: Record<string, unknown>; agentId: string }[] = [];
  const queue = Array.isArray(script) ? [...script] : null;
  const answer: Script = queue !== null ? () => queue.shift() ?? say("Out of script.") : (script as Script);
  const clientFor = (provider: string) =>
    provider === "missing"
      ? null
      : {
          provider,
          generate: async (request: ModelRequest) => {
            requests.push({ provider, request: structuredClone(request) });
            return await answer(request, request.model, provider);
          },
        };
  const peers = more.peers ?? [];
  const w: World = {
    catalog: new Map([
      ["tasks", { description: "Reads the made-up board.", parameters: { type: "object", properties: { company: { type: "string" } } }, effect: "read" as const }],
      ["deals", { description: "Reads made-up deals.", parameters: { type: "object", properties: {} }, effect: "read" as const }],
      ["task_create", { description: "Adds a made-up card.", parameters: { type: "object", properties: { title: { type: "string" } } }, effect: "write" as const }],
    ]),
    subAgent: (toolId) => peers.find((peer) => peer.definition.triggers.subAgent?.toolId === toolId) ?? null,
    agentAt: (agentId) => peers.find((peer) => peer.agentId === agentId) ?? null,
    clientFor,
    execute: async (run) => {
      executed.push({ toolId: run.toolId, args: run.args, agentId: run.agentId });
      return more.tools?.[run.toolId] ?? { status: "ok", output: { rows: [`made-up ${run.toolId}`] } };
    },
    now: () => clock,
    newRunId: () => `run-${(ids += 1)}`,
    ...more,
  };
  return {
    w,
    requests,
    executed,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const RUN: RunMode = { kind: "run" };
const start = (a: RuntimeAgent, w: World, variables: Record<string, string> = { request: "made-up" }, mode: RunMode = RUN) =>
  startRun(a, { variables }, { trigger: "api", runId: "run-root", world: w, mode });

const rootOf = (outcome: Outcome) => outcome.records.find((r) => r.runId === "run-root")!;

describe("one run, start to finish", () => {
  test("the prompt is rendered with its variables, and the answer is the output", async () => {
    const { w, requests } = world([say("Sorted: made-up.")]);
    const outcome = await start(agent(), w, { request: "made-up", note: "" });
    expect(outcome.kind).toBe("finished");
    expect(requests[0]!.request.system).toBe("You sort made-up.");
    expect(requests[0]!.request.messages).toEqual([{ role: "user", text: "Request: made-up" }]);
    expect(requests[0]!.request.tools.map((tool) => tool.name)).toEqual(["tasks", "task_create"]);
    expect(rootOf(outcome)).toMatchObject({
      runId: "run-root",
      parentRunId: null,
      agentId: "os.sorter",
      version: "h1",
      trigger: "api",
      status: "ok",
      errorClass: null,
      steps: 1,
      inputTokens: 100,
      outputTokens: 10,
      provider: "ai_studio",
      model: "gemini-3.8-flash",
      usedFallback: false,
      toolCalls: [],
      output: { format: "text", text: "Sorted: made-up.", truncated: false },
    });
  });

  test("a required variable left out is refused before any model call", async () => {
    const { w, requests } = world([say("never")]);
    const outcome = await start(agent(), w, {});
    expect(rootOf(outcome)).toMatchObject({ status: "error", errorClass: "invalid_input", steps: 0 });
    expect(requests).toHaveLength(0);
  });

  test("a conversation agent takes its messages, and its system prompt alone", async () => {
    const { w, requests } = world([say("Hello.")]);
    const chat = agent({
      def: {
        input: { mode: "messages", variables: [] },
        harness: { version: "h1", prompt: { variants: { default: { system: "Be brief." } } }, tools: [] },
      },
    });
    const outcome = await startRun(
      chat,
      { variables: {}, messages: [{ role: "user", content: "Made-up question?" }] },
      { trigger: "api", runId: "run-root", world: w, mode: RUN },
    );
    expect(rootOf(outcome).status).toBe("ok");
    expect(requests[0]!.request.messages).toEqual([{ role: "user", text: "Made-up question?" }]);
  });
});

describe("the tool loop", () => {
  test("a read tool runs, its answer goes back to the model, and the model finishes", async () => {
    const { w, requests, executed } = world([call("tasks", { company: "us" }), say("Two made-up cards.")]);
    const outcome = await start(agent(), w);
    expect(executed).toEqual([{ toolId: "tasks", args: { company: "us" }, agentId: "os.sorter" }]);
    expect(requests[1]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-tasks", name: "tasks", output: { rows: ["made-up tasks"] } }],
    });
    expect(rootOf(outcome)).toMatchObject({ status: "ok", steps: 2, toolCalls: [{ toolId: "tasks", status: "ok" }] });
  });

  test("a tool's refusal goes back as an error the model can read", async () => {
    const { w, requests } = world([call("tasks"), say("It refused.")], { tools: { tasks: { status: "error", message: "not_allowed" } } });
    const outcome = await start(agent(), w);
    expect(requests[1]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-tasks", name: "tasks", output: { error: "not_allowed" } }],
    });
    expect(rootOf(outcome).toolCalls).toEqual([{ toolId: "tasks", status: "error" }]);
  });

  test("a tool the agent was not given is not run", async () => {
    const { w, executed, requests } = world([call("deals"), say("Done.")]);
    const outcome = await start(agent(), w);
    expect(executed).toEqual([]);
    expect(requests[1]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-deals", name: "deals", output: { error: RUNTIME_WORDS.notATool } }],
    });
    expect(rootOf(outcome).toolCalls).toEqual([{ toolId: "deals", status: "error" }]);
  });

  test("a run stops at its most steps", async () => {
    const { w, requests } = world(() => call("tasks"));
    const outcome = await start(agent({ def: { limits: { maxSteps: 3, timeoutMs: 60_000 } } }), w);
    expect(requests).toHaveLength(3);
    expect(rootOf(outcome)).toMatchObject({ status: "error", errorClass: "max_steps", steps: 3 });
  });

  test("a run past its time limit times out, and no call is given more time than is left", async () => {
    const ticking = world(() => {
      ticking.tick(25_000);
      return call("tasks");
    });
    const outcome = await start(agent({ def: { limits: { maxSteps: 10, timeoutMs: 60_000 } } }), ticking.w);
    expect(rootOf(outcome)).toMatchObject({ status: "timeout", errorClass: "timeout", durationMs: 75_000 });
    expect(ticking.requests.map((r) => r.request.timeoutMs)).toEqual([60_000, 35_000, 10_000]);
  });

  test("a harness timeout bounds each call too", async () => {
    const { w, requests } = world([say("ok")]);
    await start(agent({ def: { harness: { ...definition().harness, params: { timeoutMs: 5_000 } } } }), w);
    expect(requests[0]!.request.timeoutMs).toBe(5_000);
  });
});

describe("model failures, retries and the fallback", () => {
  test("a refused key ends the run as `auth`, with no retry", async () => {
    const { w, requests } = world(() => {
      throw new ModelError("auth");
    });
    const outcome = await start(agent({ def: { harness: { ...definition().harness, params: { retries: 2 } } } }), w);
    expect(requests).toHaveLength(1);
    expect(rootOf(outcome)).toMatchObject({ status: "error", errorClass: "auth" });
  });

  test("a quota error is retried, then the fallback answers", async () => {
    const { w, requests } = world((_request, _model, provider) => {
      if (provider === "ai_studio") throw new ModelError("quota");
      return say("From the fallback.");
    });
    const outcome = await start(
      agent({
        model: { provider: "ai_studio", model: "gemini-3.8-flash", fallbackProvider: "astana_gpu", fallbackModel: "made-up-open" },
        def: { harness: { ...definition().harness, params: { retries: 1 } } },
      }),
      w,
    );
    expect(requests.map((r) => r.provider)).toEqual(["ai_studio", "ai_studio", "astana_gpu"]);
    expect(rootOf(outcome)).toMatchObject({ status: "ok", usedFallback: true, provider: "astana_gpu", model: "made-up-open" });
  });

  test("each class, as the run records it", async () => {
    for (const [cls, status, errorClass] of [
      ["quota", "error", "rate_limit"],
      ["server", "error", "server"],
      ["network", "error", "network"],
      ["timeout", "timeout", "timeout"],
      ["bad_request", "error", "invalid_input"],
    ] as const) {
      const { w } = world(() => {
        throw new ModelError(cls);
      });
      expect(rootOf(await start(agent(), w))).toMatchObject({ status, errorClass });
    }
  });

  test("a provider with no client is `provider_not_configured`", async () => {
    const { w } = world([say("never")]);
    const outcome = await start(agent({ model: { provider: "missing", model: "made-up" } }), w);
    expect(rootOf(outcome)).toMatchObject({ status: "error", errorClass: "provider_not_configured" });
  });

  test("a model's refusal is a refused run", async () => {
    const { w } = world([reply({ finish: "refused" })]);
    expect(rootOf(await start(agent(), w))).toMatchObject({ status: "refused", errorClass: null });
  });
});

describe("a run refused before it starts", () => {
  test.each(["agent_off", "over_budget", "provider_not_configured"] as const)("%s: no model call, a refused run", async (refusal) => {
    const { w, requests } = world([say("never")]);
    const outcome = await start(agent({ refusal }), w);
    expect(outcome.kind).toBe("finished");
    expect(rootOf(outcome)).toMatchObject({ status: "refused", errorClass: refusal, steps: 0 });
    expect(requests).toHaveLength(0);
  });
});

describe("the output schema", () => {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false };
  const typed = () => agent({ def: { harness: { ...definition().harness, output: { schema } } } });

  test("the model is asked for it, and JSON that fits it is the output", async () => {
    const { w, requests } = world([say('```json\n{"label":"made-up"}\n```')]);
    const outcome = await start(typed(), w);
    expect(requests[0]!.request.outputSchema).toEqual(schema);
    expect(rootOf(outcome)).toMatchObject({ status: "ok", schemaValid: true, output: { format: "json", text: '{"label":"made-up"}' } });
  });

  test("JSON that does not fit, or no JSON at all, is a schema error", async () => {
    const wrong = world([say('{"label": 3}')]);
    expect(rootOf(await start(typed(), wrong.w))).toMatchObject({ status: "error", errorClass: "schema", schemaValid: false });
    const prose = world([say("Not JSON.")]);
    expect(rootOf(await start(typed(), prose.w))).toMatchObject({
      status: "error",
      errorClass: "schema",
      schemaValid: false,
      output: { format: "text", text: "Not JSON." },
    });
  });

  test("schemaFits reads $defs and $ref", () => {
    const withRef = { type: "object", properties: { n: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer", minimum: 1 } } };
    expect(schemaFits(withRef, { n: 2 })).toBe(true);
    expect(schemaFits(withRef, { n: 0 })).toBe(false);
  });
});

describe("approvals: a write never runs without the owner's click", () => {
  test("a write tool pauses the run, its call and arguments waiting", async () => {
    const { w, executed } = world([call("task_create", { title: "Made-up card" })]);
    const outcome = await start(agent(), w);
    expect(executed).toEqual([]);
    expect(outcome.kind).toBe("paused");
    if (outcome.kind !== "paused") return;
    expect(outcome.pending).toEqual({ runId: "run-root", agentId: "os.sorter", toolId: "task_create", args: { title: "Made-up card" } });
    expect(rootOf(outcome)).toMatchObject({
      status: "awaiting_approval",
      toolCalls: [{ toolId: "task_create", status: "skipped", approval: "pending" }],
    });
  });

  test("approved: the tool runs and the run goes on", async () => {
    const first = world([call("task_create", { title: "Made-up card" })]);
    const paused = await start(agent(), first.w);
    if (paused.kind !== "paused") throw new Error("expected a pause");
    const second = world([say("Made the card.")], { peers: [agent()] });
    const done = await resumeRun(paused.state, "approved", second.w);
    expect(second.executed).toEqual([{ toolId: "task_create", args: { title: "Made-up card" }, agentId: "os.sorter" }]);
    expect(rootOf(done)).toMatchObject({
      status: "ok",
      steps: 2,
      toolCalls: [{ toolId: "task_create", status: "ok", approval: "approved" }],
      output: { text: "Made the card." },
    });
    expect(second.requests[0]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-task_create", name: "task_create", output: { rows: ["made-up task_create"] } }],
    });
  });

  test("denied: the tool does not run, and the model is told so", async () => {
    const first = world([call("task_create", { title: "Made-up card" })]);
    const paused = await start(agent(), first.w);
    if (paused.kind !== "paused") throw new Error("expected a pause");
    const second = world([say("Understood.")], { peers: [agent()] });
    const done = await resumeRun(paused.state, "denied", second.w);
    expect(second.executed).toEqual([]);
    expect(second.requests[0]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-task_create", name: "task_create", output: { denied: RUNTIME_WORDS.denied } }],
    });
    expect(rootOf(done).toolCalls).toEqual([{ toolId: "task_create", status: "denied", approval: "denied" }]);
  });

  test("a read tool listed in approvals pauses too", async () => {
    const { w, executed } = world([call("tasks")]);
    const outcome = await start(agent({ def: { approvals: ["tasks"] } }), w);
    expect(outcome.kind).toBe("paused");
    expect(executed).toEqual([]);
  });

  test("time spent waiting is not the run's", async () => {
    const first = world([call("task_create")]);
    const paused = await start(agent(), first.w);
    if (paused.kind !== "paused") throw new Error("expected a pause");
    const second = world([say("ok")], { peers: [agent()] });
    second.tick(3 * 86_400_000);
    const done = await resumeRun(paused.state, "approved", second.w);
    expect(rootOf(done)).toMatchObject({ status: "ok", startedAt: T0, durationMs: 0 });
  });

  test("an agent switched off while it waited is refused when it resumes", async () => {
    const first = world([call("task_create")]);
    const paused = await start(agent(), first.w);
    if (paused.kind !== "paused") throw new Error("expected a pause");
    const second = world([say("never")], { peers: [agent({ refusal: "agent_off" })] });
    const done = await resumeRun(paused.state, "approved", second.w);
    expect(second.executed).toEqual([]);
    expect(rootOf(done)).toMatchObject({ status: "refused", errorClass: "agent_off" });
  });

  test("arguments too large to keep are refused, never stored", async () => {
    const { w } = world([call("task_create", { title: "x".repeat(20_000) }), say("ok")]);
    const outcome = await start(agent(), w);
    expect(outcome.kind).toBe("finished");
    expect(rootOf(outcome).toolCalls).toEqual([{ toolId: "task_create", status: "error" }]);
  });

  test("a paused run whose state is too large to keep fails as `store`", async () => {
    const big = "y".repeat(MAX_STATE_BYTES);
    const { w } = world([call("task_create")]);
    // A conversation agent whose own message is past the limit.
    const chat = agent({ def: { input: { mode: "messages", variables: [] }, harness: { ...definition().harness, prompt: { variants: { default: { system: "s" } } } } } });
    const outcome = await startRun(chat, { variables: {}, messages: [{ role: "user", content: big }] }, { trigger: "api", runId: "run-root", world: w, mode: RUN });
    expect(outcome.kind).toBe("finished");
    expect(rootOf(outcome)).toMatchObject({ status: "error", errorClass: "store" });
  });
});

describe("sub-agents, in process", () => {
  const helper = (agentId: string, toolId: string, tools: string[] = ["tasks"], over: Partial<ConfigDefinition> = {}) =>
    agent({
      agentId,
      def: {
        input: { mode: "text", variables: [{ name: "question", required: true }] },
        harness: { version: "h2", prompt: { variants: { default: { system: "Help.", user: "{{question}}" } } }, tools },
        triggers: { api: false, subAgent: { toolId, description: `Calls ${agentId}.` } },
        approvals: [],
        ...over,
      },
    });

  test("its run is its own, under the run that called it, and its answer is the tool's", async () => {
    const sub = helper("os.helper", "helper");
    const { w, requests } = world(
      (request) =>
        request.system === "Help."
          ? say("Made-up help.")
          : request.messages.length === 1
            ? call("helper", { question: "What is made up?" })
            : say("Thanks."),
      { peers: [sub] },
    );
    const outcome = await start(agent({ def: { harness: { ...definition().harness, tools: ["helper"] }, approvals: [] } }), w);
    expect(requests[0]!.request.tools).toEqual([
      {
        name: "helper",
        description: "Calls os.helper.",
        parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
      },
    ]);
    const child = outcome.records.find((r) => r.agentId === "os.helper")!;
    expect(child).toMatchObject({ trigger: "subagent", parentRunId: "run-root", status: "ok", version: "h1", output: { text: "Made-up help." } });
    expect(rootOf(outcome)).toMatchObject({ status: "ok", toolCalls: [{ toolId: "helper", status: "ok" }] });
    expect(requests[2]!.request.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ id: "c-helper", name: "helper", output: { result: "Made-up help." } }],
    });
  });

  test("no deeper than three", async () => {
    const d = helper("os.d", "d", []);
    const c = helper("os.c", "c", ["d"]);
    const b = helper("os.b", "b", ["c"]);
    const a = helper("os.a", "a", ["b"]);
    const e = helper("os.e", "e", ["a"]);
    // Every agent calls the next one down, once, then answers.
    const { w } = world(
      (request) => {
        const own = request.tools[0]?.name;
        return own !== undefined && request.messages.length === 1 ? call(own, { question: "deeper?" }) : say("Done.");
      },
      { peers: [a, b, c, d] },
    );
    const outcome = await startRun(e, { variables: { question: "start" } }, { trigger: "api", runId: "run-root", world: w, mode: RUN });
    const byAgent = new Map(outcome.records.map((r) => [r.agentId, r]));
    expect(byAgent.get("os.c")!.toolCalls).toEqual([{ toolId: "d", status: "error" }]);
    expect(byAgent.has("os.d")).toBe(false);
    expect(byAgent.get("os.e")!.status).toBe("ok");
  });

  test("a sub-agent that is switched off is a refused run, and an error to its caller", async () => {
    const sub = { ...helper("os.helper", "helper"), refusal: "agent_off" as const };
    const { w } = world((request) => (request.messages.length === 1 ? call("helper", { question: "?" }) : say("ok")), { peers: [sub] });
    const outcome = await start(agent({ def: { harness: { ...definition().harness, tools: ["helper"] }, approvals: [] } }), w);
    expect(outcome.records.find((r) => r.agentId === "os.helper")).toMatchObject({ status: "refused", errorClass: "agent_off" });
    expect(rootOf(outcome).toolCalls).toEqual([{ toolId: "helper", status: "error" }]);
  });

  test("a write inside a sub-agent pauses the whole run, and resumes where it waited", async () => {
    const sub = helper("os.helper", "helper", ["task_create"], { approvals: ["task_create"] });
    const parent = agent({ def: { harness: { ...definition().harness, tools: ["helper"] }, approvals: [] } });
    const script: Script = (request) =>
      request.system === "Help."
        ? request.messages.length === 1
          ? call("task_create", { title: "Made-up" })
          : say("Card made.")
        : request.messages.length === 1
          ? call("helper", { question: "Make a card?" })
          : say("All done.");
    const first = world(script, { peers: [sub, parent] });
    const paused = await start(parent, first.w);
    if (paused.kind !== "paused") throw new Error("expected a pause");
    expect(paused.pending).toMatchObject({ agentId: "os.helper", toolId: "task_create" });
    expect(paused.records.map((r) => [r.agentId, r.status])).toEqual([
      ["os.helper", "awaiting_approval"],
      ["os.sorter", "awaiting_approval"],
    ]);
    const second = world(script, { peers: [sub, parent] });
    const done = await resumeRun(paused.state, "approved", second.w);
    expect(second.executed).toEqual([{ toolId: "task_create", args: { title: "Made-up" }, agentId: "os.helper" }]);
    expect(done.records.map((r) => [r.agentId, r.status])).toEqual([
      ["os.helper", "ok"],
      ["os.sorter", "ok"],
    ]);
  });
});

describe("test mode: every tool answered from a fixture", () => {
  const testMode = (fixtures: Record<string, unknown>, subAgentFixtures: Record<string, unknown> = {}): RunMode => ({
    kind: "test",
    fixtures,
    subAgentFixtures,
    model: { provider: "astana_gpu", model: "made-up-open" },
  });

  test("no tool runs, a write does not pause, and a tool with no fixture is skipped", async () => {
    const { w, executed, requests } = world([call("task_create", { title: "x" }), call("tasks"), say("Done.")]);
    const outcome = await start(agent(), w, { request: "made-up" }, testMode({ task_create: { id: "made-up" } }));
    expect(executed).toEqual([]);
    expect(requests.map((r) => [r.provider, r.request.model])).toEqual([
      ["astana_gpu", "made-up-open"],
      ["astana_gpu", "made-up-open"],
      ["astana_gpu", "made-up-open"],
    ]);
    expect(rootOf(outcome).toolCalls).toEqual([
      { toolId: "task_create", status: "ok" },
      { toolId: "tasks", status: "skipped" },
    ]);
  });

  test("a sub-agent runs with its own fixtures, or is answered by one of the agent's", async () => {
    const sub = agent({
      agentId: "os.helper",
      def: {
        input: { mode: "text", variables: [{ name: "question", required: false }] },
        harness: { version: "h2", prompt: { variants: { default: { system: "Help.", user: "{{question}}" } } }, tools: ["deals"] },
        triggers: { api: false, subAgent: { toolId: "helper", description: "Helps." } },
        approvals: [],
      },
    });
    const parent = agent({ def: { harness: { ...definition().harness, tools: ["helper"] }, approvals: [] } });
    const script: Script = (request) =>
      request.system === "Help."
        ? request.messages.length === 1
          ? call("deals")
          : say("Helped.")
        : request.messages.length === 1
          ? call("helper", { question: "?" })
          : say("Done.");
    const ran = world(script, { peers: [sub] });
    const outcome = await start(parent, ran.w, { request: "made-up" }, testMode({}, { helper: { deals: { made: "up" } } }));
    expect(outcome.records.find((r) => r.agentId === "os.helper")!.toolCalls).toEqual([{ toolId: "deals", status: "ok" }]);
    const answered = world(script, { peers: [sub] });
    const direct = await start(parent, answered.w, { request: "made-up" }, testMode({ helper: "Made-up answer." }));
    expect(direct.records.map((r) => r.agentId)).toEqual(["os.sorter"]);
  });
});

describe("what a test result says", () => {
  test("expectations: equals, contains, exists and matches, at a path", () => {
    const output = { ranked: [{ id: "SAMPLE-101" }], tags: ["brace", "knee"], note: "made-up note" };
    expect(
      evaluateAssertions(output, [
        { path: "$.ranked", exists: true },
        { path: "$.ranked[0].id", matches: "SAMPLE-\\d+" },
        { path: "$.ranked[0].id", equals: "SAMPLE-101" },
        { path: "$.tags", contains: "brace" },
        { path: "$.note", contains: "made-up" },
        { path: "$.missing", exists: false },
        { path: "$.missing", exists: true },
        { path: "$.ranked[1].id", equals: "SAMPLE-101" },
      ]),
    ).toEqual([
      { index: 0, passed: true },
      { index: 1, passed: true },
      { index: 2, passed: true },
      { index: 3, passed: true },
      { index: 4, passed: true },
      { index: 5, passed: true },
      { index: 6, passed: false },
      { index: 7, passed: false },
    ]);
    expect(evaluateAssertions("plain text", [{ path: "$", contains: "plain" }])).toEqual([{ index: 0, passed: true }]);
  });

  test("a run's error as a result's error class", () => {
    expect(resultErrorOf("ok", null)).toBeNull();
    expect(resultErrorOf("timeout", "timeout")).toBe("timeout");
    expect(resultErrorOf("error", "rate_limit")).toBe("rate_limit");
    expect(resultErrorOf("error", "schema")).toBe("schema");
    expect(resultErrorOf("error", "max_steps")).toBe("refused");
    expect(resultErrorOf("refused", null)).toBe("refused");
  });
});

describe("before a run, and around it", () => {
  const guard = {
    enabled: true,
    budgetUsd: 10,
    spentUsd: 2,
    provider: "ai_studio",
    configured: { ai_studio: true, astana_gpu: false },
    runsToday: 3,
    maxRunsPerDay: 200,
  };

  test("the day's cap on runs is the brake that always holds", () => {
    expect(runRefusal({ ...guard, runsToday: 199 })).toBeNull();
    expect(runRefusal({ ...guard, runsToday: 200, spentUsd: null })).toBe("over_budget");
    expect(runRefusal({ ...guard, runsToday: 200, enabled: false })).toBe("agent_off");
  });

  test("a budget is said to be enforced only where the runs are priced", () => {
    expect(budgetState({ budgetUsd: null, spentUsd: null })).toBe("none");
    expect(budgetState({ budgetUsd: 10, spentUsd: null })).toBe("not_priced");
    expect(budgetState({ budgetUsd: 10, spentUsd: 4 })).toBe("within");
    expect(budgetState({ budgetUsd: 10, spentUsd: 10 })).toBe("reached");
  });

  test("off, over budget, not configured, in that order; an unpriced month is not judged", () => {
    expect(runRefusal(guard)).toBeNull();
    expect(runRefusal({ ...guard, enabled: false, spentUsd: 99 })).toBe("agent_off");
    expect(runRefusal({ ...guard, spentUsd: 10 })).toBe("over_budget");
    expect(runRefusal({ ...guard, spentUsd: null })).toBeNull();
    expect(runRefusal({ ...guard, budgetUsd: null, spentUsd: 99 })).toBeNull();
    expect(runRefusal({ ...guard, provider: "astana_gpu" })).toBe("provider_not_configured");
    expect(runRefusal({ ...guard, provider: null })).toBe("provider_not_configured");
  });

  test("a schedule is due at its latest time in the window, once", () => {
    const at6 = Date.parse("2026-10-17T06:00:00Z");
    const next = (after: number) => nextRuns("0 6 * * *", after, 3);
    expect(dueAt(next, at6 + 30_000, 120_000)).toBe(at6);
    expect(dueAt(next, at6 + 100_000, 120_000)).toBe(at6);
    expect(dueAt(next, at6 + 130_000, 120_000)).toBeNull();
    expect(dueAt(next, at6 - 1, 120_000)).toBeNull();
    const every = (after: number) => nextRuns("* * * * *", after, 5);
    expect(dueAt(every, at6 + 90_000, 120_000)).toBe(at6 + 60_000);
  });

  test("percentiles, nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([300, 100, 200], 50)).toBe(200);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
