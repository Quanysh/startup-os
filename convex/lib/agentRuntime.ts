// The runner for the agents Startup OS runs itself (the project `startup-os`;
// convex/agentRuntime.ts drives it). Given an agent as it is published (or a
// draft, in a test), what it was given, a model client and a tool executor,
// it runs the tool loop: the prompt rendered (convex/lib/agentTemplate.ts),
// at most `limits.maxSteps` model turns within `limits.timeoutMs`, each tool
// call answered, other agents built here called as tools and run in process
// (at most 3 deep), the answer checked against the output schema.
//
// **A tool that changes something never runs without the owner's click.** A
// `write` tool, and any tool the definition lists in `approvals`, pauses the
// run: the outcome is `paused` with the call and its arguments, and the run's
// whole state as JSON text to keep. `resumeRun` takes that state back with
// the owner's decision: approved, the tool runs and the run goes on; denied,
// the model is told so and the run goes on. A sub-agent's call pauses the run
// that called it, however deep. Time spent waiting is not the run's.
//
// In a test (`mode.kind === "test"`) nothing runs: every tool is answered
// from the case's fixtures (a tool with none is skipped), so nothing pauses,
// and every agent runs on the case's model.
//
// What comes out is one record a run: ids, states and numbers, and the
// answer; the caller keeps the answer apart and the rest as the run summary.
// Pure: no clock but the world's, no logging, no table.

import { z } from "zod";
import type {
  AgentRunStatus,
  ConfigDefinition,
  ModelChoice,
  RunErrorClass,
  RunTrigger,
  ToolCall,
} from "./agentBuilder";
import { CATALOG_TOOL_ID_PATTERN, MAX_TOOL_CALLS_PER_RUN } from "./agentBuilder";
import { DEFAULT_VARIANT } from "./agentHarness";
import { MAX_OUTPUT_BYTES, type CaseMessage, type ResultError } from "./agentJobs";
import { utf8Bytes } from "./agentSchemaCompat";
import { renderTemplate } from "./agentTemplate";
import {
  ModelError,
  type ModelClient,
  type ModelErrorClass,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ToolCallRequest,
  type ToolDeclaration,
} from "./modelClients";

/** A triggered run is depth 0, its sub-agent 1: at most 3. */
export const MAX_RUNTIME_DEPTH = 3;
/** A tool's arguments kept while the owner decides, in UTF-8 bytes. */
export const MAX_ARGUMENT_BYTES = 16 * 1024;
/** A tool's answer as the model is given it, in UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
/** A paused run's whole state, in UTF-8 bytes. */
export const MAX_STATE_BYTES = 512 * 1024;
/** A run's answer as kept, in UTF-8 bytes. */
export const MAX_RUN_OUTPUT_BYTES = MAX_OUTPUT_BYTES;

/** What the model is told, in fixed words. */
export const RUNTIME_WORDS = {
  notATool: "This agent does not have that tool.",
  denied: "The owner denied this call. It was not run.",
  noFixture: "No fixture answers this tool in the test.",
  tooLarge: "The arguments are too large to hold for the owner's approval.",
  failed: "The tool failed.",
  depth: "Sub-agents go no more than 3 deep.",
  subInput: "The arguments do not fit what the sub-agent takes.",
  subFailed: "The sub-agent did not finish.",
  answerTooLarge: "The tool's answer was too large and was cut.",
} as const;

/** An agent as the runner reads it: its definition as the config carries it, its model, and why it may not run. */
export type RuntimeAgent = {
  agentId: string;
  /** What a run of it records: "h3", or a draft's "draft-h3.2". */
  version: string;
  /** Its harness version's number, to find it again when a paused run resumes. */
  versionNumber: number;
  definition: ConfigDefinition;
  model: ModelChoice | null;
  /** Null, or why it may not run now: switched off, over its budget, its provider not configured. */
  refusal: RunErrorClass | null;
};

export type RunInput = {
  variables: Record<string, string>;
  /** A conversation agent's messages. */
  messages?: readonly CaseMessage[];
  /** A prompt variant; left out, `default`. */
  variant?: string;
};

export type ToolOutcome = { status: "ok"; output: unknown } | { status: "error"; message: string };

/** Everything a run touches, given in: the tests give fakes. */
export type World = {
  /** The project's tools by id: what the model is told of each, and whether it reads or changes. */
  catalog: ReadonlyMap<string, { description: string; parameters: Record<string, unknown>; effect: "read" | "write" }>;
  /** A published agent offered as a sub-agent, by the tool id it is called by. */
  subAgent: (toolId: string) => RuntimeAgent | null;
  /** An agent at a version, for a paused run that resumes. */
  agentAt: (agentId: string, versionNumber: number) => RuntimeAgent | null;
  clientFor: (provider: string) => ModelClient | null;
  /** Run one of the catalogue's tools for real (never in a test). */
  execute: (call: { runId: string; agentId: string; versionNumber: number; toolId: string; args: Record<string, unknown> }) => Promise<ToolOutcome>;
  now: () => number;
  newRunId: () => string;
};

export type RunMode =
  | { kind: "run" }
  | {
      kind: "test";
      /** The case's `toolFixtures`: tool id to what it returns. */
      fixtures: Record<string, unknown>;
      /** The case's `subAgentFixtures`: a sub-agent's tool id to its own tools' answers, at any depth. */
      subAgentFixtures: Record<string, unknown>;
      /** The model the case runs on, for the agent and every sub-agent. */
      model: { provider: string; model: string };
    };

export type RunOutput = { format: "text" | "json"; text: string; truncated: boolean };

/** One run, as the caller keeps it. */
export type RunRecord = {
  runId: string;
  parentRunId: string | null;
  agentId: string;
  version: string;
  versionNumber: number;
  trigger: RunTrigger;
  status: AgentRunStatus;
  errorClass: RunErrorClass | null;
  startedAt: number;
  /** Time it ran, not time it waited for the owner. */
  durationMs: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered last; the agent's own where none was called. */
  provider: string | null;
  model: string | null;
  usedFallback: boolean;
  toolCalls: ToolCall[];
  output: RunOutput | null;
  /** Whether its answer fit the output schema; null with no schema or no answer. */
  schemaValid: boolean | null;
};

export type PendingCall = { runId: string; agentId: string; toolId: string; args: Record<string, unknown> };

/** How a stretch of running ended. `records` are the runs it finished and, when paused, the runs that wait. */
export type Outcome =
  | { kind: "finished"; records: RunRecord[] }
  | { kind: "paused"; records: RunRecord[]; pending: PendingCall; state: string };

// ── The state of a run, kept while it waits ─────────────────────────────────

type Turn = {
  calls: ToolCallRequest[];
  next: number;
  results: { id: string; name: string; output: unknown }[];
  /** The owner's decision on `calls[next]`, set when the run resumes. */
  decision?: "approved" | "denied";
};

type Frame = {
  runId: string;
  parentRunId: string | null;
  agentId: string;
  version: string;
  versionNumber: number;
  trigger: RunTrigger;
  depth: number;
  startedAt: number;
  activeMs: number;
  system: string;
  messages: ModelMessage[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  provider: string | null;
  model: string | null;
  usedFallback: boolean;
  toolCalls: ToolCall[];
  turn: Turn | null;
  /** The sub-agent this run waits on, itself waiting. */
  child: Frame | null;
};

type Env = {
  world: World;
  mode: RunMode;
  /** Test only: the fixtures that answer this run's tools, and (at depth 0) each sub-agent's. */
  fixtures: Record<string, unknown>;
  subAgentFixtures: Record<string, unknown>;
  /** The latest moment this run may still work: its own limit and its callers'. */
  deadline: number;
};

type Step =
  | { kind: "finished"; record: RunRecord; records: RunRecord[] }
  | { kind: "paused"; pending: PendingCall; records: RunRecord[] };

// ── Small pieces ─────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool id as a summary may carry it; a name the model made up that is not one is left out. */
const recordable = (id: string) => CATALOG_TOOL_ID_PATTERN.test(id);

function cut(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && utf8Bytes(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
  return { text: text.slice(0, end), truncated: true };
}

/** A tool's answer as the model is given it: bounded. */
function bounded(output: unknown): unknown {
  const text = JSON.stringify(output ?? null);
  if (utf8Bytes(text) <= MAX_TOOL_RESULT_BYTES) return output ?? null;
  return { truncated: true, note: RUNTIME_WORDS.answerTooLarge, part: cut(text, MAX_TOOL_RESULT_BYTES - 200).text };
}

/** JSON in an answer, with or without a ```json fence; undefined where there is none. */
function jsonIn(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  try {
    return JSON.parse(fenced === null ? text : fenced[1]!) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a value fits a JSON Schema (`$defs` and `$ref` read). A schema that cannot be read fits nothing. */
export function schemaFits(schema: unknown, value: unknown): boolean {
  if (!isObject(schema)) return false;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(value).success;
  } catch {
    return false;
  }
}

const MODEL_RUN_ERRORS: Record<ModelErrorClass, RunErrorClass> = {
  auth: "auth",
  quota: "rate_limit",
  timeout: "timeout",
  server: "server",
  network: "network",
  // The provider refused the request as it was built from this agent's definition.
  bad_request: "invalid_input",
};

/** Worth trying the same model again: the provider may answer next time. */
const RETRYABLE: ReadonlySet<ModelErrorClass> = new Set(["quota", "server", "network"]);

/** A run's error as a test result's (RESULT_ERRORS): the runtime's own reasons are `refused`. */
export function resultErrorOf(status: AgentRunStatus, errorClass: RunErrorClass | null): ResultError | null {
  if (status === "ok") return null;
  switch (errorClass) {
    case "timeout":
    case "auth":
    case "rate_limit":
    case "server":
    case "network":
    case "schema":
      return errorClass;
    default:
      return status === "timeout" ? "timeout" : "refused";
  }
}

// ── Expectations (a test case's) ─────────────────────────────────────────────

const PATH_PART = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d{1,4})\]/g;

/** The value at a path (`$`, `$.codes[0].code`), or `missing`. */
function at(value: unknown, path: string): { found: true; value: unknown } | { found: false } {
  let here: unknown = value;
  for (const match of path.slice(1).matchAll(PATH_PART)) {
    if (match[1] !== undefined) {
      if (!isObject(here) || !Object.prototype.hasOwnProperty.call(here, match[1])) return { found: false };
      here = here[match[1]];
    } else {
      const index = Number(match[2]);
      if (!Array.isArray(here) || index >= here.length) return { found: false };
      here = here[index];
    }
  }
  return { found: true, value: here };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

/** Each expectation of a case (as a job carries it: a path and one of equals, contains, exists, matches), passed or not. */
export function evaluateAssertions(output: unknown, expect: readonly Record<string, unknown>[]): { index: number; passed: boolean }[] {
  return expect.map((assertion, index) => {
    const path = typeof assertion.path === "string" ? assertion.path : "$";
    const found = at(output, path);
    let passed = false;
    if ("exists" in assertion) passed = found.found === (assertion.exists === true);
    else if (found.found) {
      const value = found.value;
      if ("equals" in assertion) passed = same(value, assertion.equals);
      else if ("contains" in assertion) {
        passed =
          typeof value === "string"
            ? typeof assertion.contains === "string" && value.includes(assertion.contains)
            : Array.isArray(value) && value.some((item) => same(item, assertion.contains));
      } else if ("matches" in assertion && typeof assertion.matches === "string") {
        const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
        try {
          passed = text !== null && new RegExp(`^(?:${assertion.matches})$`).test(text);
        } catch {
          passed = false;
        }
      }
    }
    return { index, passed };
  });
}

// ── The tools an agent is given ─────────────────────────────────────────────

/** What a sub-agent takes as a tool: its variables, or one message for a conversation agent. */
function subParameters(agent: RuntimeAgent): Record<string, unknown> {
  const input = agent.definition.input;
  if (input.mode === "messages") {
    return {
      type: "object",
      properties: { message: { type: "string", description: "What to ask it." } },
      required: ["message"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(input.variables.map((v) => [v.name, { type: "string" }])),
    required: input.variables.filter((v) => v.required).map((v) => v.name),
    additionalProperties: false,
  };
}

function declarations(agent: RuntimeAgent, world: World): ToolDeclaration[] {
  const out: ToolDeclaration[] = [];
  for (const id of agent.definition.harness.tools) {
    const tool = world.catalog.get(id);
    if (tool !== undefined) {
      out.push({ name: id, description: tool.description, parameters: tool.parameters });
      continue;
    }
    const sub = world.subAgent(id);
    if (sub !== null) out.push({ name: id, description: sub.definition.triggers.subAgent?.description ?? sub.definition.description, parameters: subParameters(sub) });
  }
  return out;
}

/** A sub-agent's input from the arguments its caller's model sent, or null where they do not fit. */
function subInput(agent: RuntimeAgent, args: Record<string, unknown>): RunInput | null {
  const input = agent.definition.input;
  if (input.mode === "messages") {
    const message = args.message;
    return typeof message === "string" && message.trim() !== "" ? { variables: {}, messages: [{ role: "user", content: message }] } : null;
  }
  const declared = new Set(input.variables.map((v) => v.name));
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    if (!declared.has(name) || typeof value !== "string") return null;
    variables[name] = value;
  }
  return { variables };
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** A new run's frame, its prompt rendered; null where its input does not fit (a required variable left out). */
function newFrame(
  agent: RuntimeAgent,
  input: RunInput,
  meta: { runId: string; parentRunId: string | null; trigger: RunTrigger; depth: number; startedAt: number },
): Frame | null {
  const definition = agent.definition;
  const variants = definition.harness.prompt.variants;
  const variant = variants[input.variant ?? DEFAULT_VARIANT] ?? variants[DEFAULT_VARIANT];
  if (variant === undefined) return null;
  const values = input.variables;
  for (const variable of definition.input.variables) {
    if (variable.required && (values[variable.name] ?? "").trim() === "") return null;
  }
  let messages: ModelMessage[];
  if (definition.input.mode === "messages") {
    const given = input.messages ?? [];
    if (!given.some((m) => m.role === "user")) return null;
    messages = given.map((m) => (m.role === "user" ? { role: "user", text: m.content } : { role: "assistant", text: m.content, toolCalls: [] }));
  } else {
    messages = [{ role: "user", text: renderTemplate(variant.user ?? "", values) }];
  }
  return {
    ...meta,
    agentId: agent.agentId,
    version: agent.version,
    versionNumber: agent.versionNumber,
    activeMs: 0,
    system: renderTemplate(variant.system, values),
    messages,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    provider: agent.model?.provider ?? null,
    model: agent.model?.model ?? null,
    usedFallback: false,
    toolCalls: [],
    turn: null,
    child: null,
  };
}

/** A run that never got going (refused, or its input did not fit): a record with no step. */
function unstarted(
  agent: RuntimeAgent,
  meta: { runId: string; parentRunId: string | null; trigger: RunTrigger; startedAt: number },
  status: AgentRunStatus,
  errorClass: RunErrorClass,
  mode: RunMode,
): RunRecord {
  const model = mode.kind === "test" ? mode.model : agent.model;
  return {
    ...meta,
    agentId: agent.agentId,
    version: agent.version,
    versionNumber: agent.versionNumber,
    status,
    errorClass,
    durationMs: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    usedFallback: false,
    toolCalls: [],
    output: null,
    schemaValid: null,
  };
}

function recordOf(
  frame: Frame,
  status: AgentRunStatus,
  errorClass: RunErrorClass | null,
  output: RunOutput | null,
  schemaValid: boolean | null,
  pendingTool?: string,
): RunRecord {
  const calls = pendingTool === undefined ? frame.toolCalls : [...frame.toolCalls, { toolId: pendingTool, status: "skipped" as const, approval: "pending" as const }];
  return {
    runId: frame.runId,
    parentRunId: frame.parentRunId,
    agentId: frame.agentId,
    version: frame.version,
    versionNumber: frame.versionNumber,
    trigger: frame.trigger,
    status,
    errorClass,
    startedAt: frame.startedAt,
    durationMs: frame.activeMs,
    steps: frame.steps,
    inputTokens: frame.inputTokens,
    outputTokens: frame.outputTokens,
    provider: frame.provider,
    model: frame.model,
    usedFallback: frame.usedFallback,
    toolCalls: calls.slice(0, MAX_TOOL_CALLS_PER_RUN),
    output,
    schemaValid,
  };
}

const textOutput = (text: string): RunOutput => ({ format: "text", ...cut(text, MAX_RUN_OUTPUT_BYTES) });
const jsonOutput = (value: unknown): RunOutput => ({ format: "json", ...cut(JSON.stringify(value), MAX_RUN_OUTPUT_BYTES) });

/** A finished run's answer as its caller's tool result. */
function answerOf(record: RunRecord): unknown {
  if (record.status !== "ok" || record.output === null) return { error: RUNTIME_WORDS.subFailed };
  if (record.output.format === "json" && !record.output.truncated) return JSON.parse(record.output.text) as unknown;
  return { result: record.output.text };
}

// ── The loop ─────────────────────────────────────────────────────────────────

/** One model turn: the agent's model, retried as its parameters say, then its fallback. */
async function ask(frame: Frame, agent: RuntimeAgent, env: Env): Promise<ModelReply> {
  const { world, mode } = env;
  const harness = agent.definition.harness;
  const params = harness.params ?? {};
  const choices =
    mode.kind === "test"
      ? [mode.model]
      : [
          ...(agent.model === null ? [] : [{ provider: agent.model.provider, model: agent.model.model }]),
          ...(agent.model?.fallbackProvider === undefined || agent.model.fallbackModel === undefined
            ? []
            : [{ provider: agent.model.fallbackProvider, model: agent.model.fallbackModel }]),
        ];
  const tools = declarations(agent, world);
  let last: ModelError | null = null;
  let anyClient = false;
  for (const [i, choice] of choices.entries()) {
    const client = world.clientFor(choice.provider);
    if (client === null) continue;
    anyClient = true;
    const attempts = i === 0 ? 1 + (params.retries ?? 0) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const left = env.deadline - world.now();
      if (left <= 0) throw new ModelError("timeout");
      const request: ModelRequest = {
        model: choice.model,
        system: frame.system,
        messages: frame.messages,
        tools,
        params: {
          ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
          ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
          ...(params.thinkingBudget === undefined ? {} : { thinkingBudget: params.thinkingBudget }),
        },
        ...(harness.output === undefined ? {} : { outputSchema: harness.output.schema }),
        timeoutMs: Math.min(left, params.timeoutMs ?? left),
      };
      try {
        const reply = await client.generate(request);
        frame.provider = choice.provider;
        frame.model = choice.model;
        if (i > 0) frame.usedFallback = true;
        return reply;
      } catch (error) {
        if (!(error instanceof ModelError)) throw new ModelError("server");
        last = error;
        if (!RETRYABLE.has(error.errorClass)) break;
      }
    }
  }
  if (!anyClient) throw new NoProvider();
  throw last ?? new ModelError("server");
}

class NoProvider extends Error {
  constructor() {
    super("provider_not_configured");
  }
}

type Handled = { kind: "done"; output: unknown; call: ToolCall | null } | { kind: "paused"; pending: PendingCall };

const done = (output: unknown, call: ToolCall | null): Handled => ({ kind: "done", output, call });

/** One tool call of a turn: run, answered from a fixture, paused for the owner, or a sub-agent run. */
async function handleCall(frame: Frame, agent: RuntimeAgent, call: ToolCallRequest, env: Env, records: RunRecord[]): Promise<Handled> {
  const { world, mode } = env;
  const turn = frame.turn!;
  const decision = turn.decision;
  const tools = new Set(agent.definition.harness.tools);
  const asCall = (status: ToolCall["status"], approval?: ToolCall["approval"]): ToolCall | null =>
    recordable(call.name) ? { toolId: call.name, status, ...(approval === undefined ? {} : { approval }) } : null;
  if (!tools.has(call.name)) return done({ error: RUNTIME_WORDS.notATool }, asCall("error"));

  const approvals = new Set(agent.definition.approvals);
  const catalogTool = world.catalog.get(call.name);
  const sub = catalogTool === undefined ? world.subAgent(call.name) : null;
  const needsApproval = mode.kind === "run" && (approvals.has(call.name) || catalogTool?.effect === "write");
  const approval = needsApproval ? (decision === "denied" ? "denied" : "approved") : undefined;

  // The owner's click, before anything runs.
  if (frame.child === null && needsApproval) {
    if (decision === undefined) {
      if (utf8Bytes(JSON.stringify(call.args)) > MAX_ARGUMENT_BYTES) return done({ error: RUNTIME_WORDS.tooLarge }, asCall("error"));
      return { kind: "paused", pending: { runId: frame.runId, agentId: frame.agentId, toolId: call.name, args: call.args } };
    }
    if (decision === "denied") return done({ denied: RUNTIME_WORDS.denied }, asCall("denied", "denied"));
  }

  // A sub-agent this run waits on, resumed.
  if (frame.child !== null) {
    const waiting = frame.child;
    const childAgent = world.agentAt(waiting.agentId, waiting.versionNumber);
    if (childAgent === null) {
      frame.child = null;
      records.push(recordOf(waiting, "error", "config_unavailable", null, null));
      return done({ error: RUNTIME_WORDS.subFailed }, asCall("error", approval));
    }
    const step = await drive(waiting, childAgent, env);
    records.push(...step.records);
    if (step.kind === "paused") return { kind: "paused", pending: step.pending };
    frame.child = null;
    return done(answerOf(step.record), asCall(step.record.status === "ok" ? "ok" : "error", approval));
  }

  if (sub !== null) {
    if (mode.kind === "test" && Object.prototype.hasOwnProperty.call(env.fixtures, call.name)) {
      return done(env.fixtures[call.name], asCall("ok"));
    }
    const meta = { runId: world.newRunId(), parentRunId: frame.runId, trigger: "subagent" as const, startedAt: world.now() };
    if (frame.depth + 1 > MAX_RUNTIME_DEPTH) return done({ error: RUNTIME_WORDS.depth }, asCall("error", approval));
    if (sub.refusal !== null) {
      records.push(unstarted(sub, meta, "refused", sub.refusal, mode));
      return done({ error: RUNTIME_WORDS.subFailed }, asCall("error", approval));
    }
    const input = subInput(sub, call.args);
    const child = input === null ? null : newFrame(sub, input, { ...meta, depth: frame.depth + 1 });
    if (child === null) {
      records.push(unstarted(sub, meta, "error", "invalid_input", mode));
      return done({ error: RUNTIME_WORDS.subInput }, asCall("error", approval));
    }
    const fixtures =
      mode.kind !== "test" ? {} : frame.depth === 0 ? (isObject(env.subAgentFixtures[call.name]) ? (env.subAgentFixtures[call.name] as Record<string, unknown>) : {}) : env.fixtures;
    const step = await drive(child, sub, { ...env, fixtures, subAgentFixtures: {} });
    records.push(...step.records);
    if (step.kind === "paused") {
      frame.child = child;
      return { kind: "paused", pending: step.pending };
    }
    return done(answerOf(step.record), asCall(step.record.status === "ok" ? "ok" : "error", approval));
  }

  if (catalogTool === undefined) return done({ error: RUNTIME_WORDS.notATool }, asCall("error"));
  if (mode.kind === "test") {
    return Object.prototype.hasOwnProperty.call(env.fixtures, call.name)
      ? done(env.fixtures[call.name], asCall("ok"))
      : done({ error: RUNTIME_WORDS.noFixture }, asCall("skipped"));
  }
  let outcome: ToolOutcome;
  try {
    outcome = await world.execute({ runId: frame.runId, agentId: frame.agentId, versionNumber: frame.versionNumber, toolId: call.name, args: call.args });
  } catch {
    outcome = { status: "error", message: RUNTIME_WORDS.failed };
  }
  return outcome.status === "ok"
    ? done(outcome.output, asCall("ok", approval))
    : done({ error: outcome.message }, asCall("error", approval));
}

/** Run a frame until it finishes or waits for the owner. */
async function drive(frame: Frame, agent: RuntimeAgent, outer: Env): Promise<Step> {
  const { world } = outer;
  const entry = world.now();
  const env: Env = { ...outer, deadline: Math.min(outer.deadline, entry + agent.definition.limits.timeoutMs - frame.activeMs) };
  const records: RunRecord[] = [];
  const settle = () => {
    frame.activeMs += Math.max(0, world.now() - entry);
  };
  const close = (status: AgentRunStatus, errorClass: RunErrorClass | null, output: RunOutput | null = null, schemaValid: boolean | null = null): Step => {
    settle();
    const record = recordOf(frame, status, errorClass, output, schemaValid);
    records.push(record);
    return { kind: "finished", record, records };
  };
  const pause = (pending: PendingCall): Step => {
    settle();
    records.push(recordOf(frame, "awaiting_approval", null, null, null, pending.runId === frame.runId ? pending.toolId : undefined));
    return { kind: "paused", pending, records };
  };
  const timedOut = () => world.now() >= env.deadline;
  const maxSteps = agent.definition.limits.maxSteps;

  for (;;) {
    const turn = frame.turn;
    if (turn !== null) {
      while (turn.next < turn.calls.length) {
        if (timedOut() && frame.child === null) return close("timeout", "timeout");
        const call = turn.calls[turn.next]!;
        const handled = await handleCall(frame, agent, call, env, records);
        if (handled.kind === "paused") return pause(handled.pending);
        turn.results.push({ id: call.id, name: call.name, output: bounded(handled.output) });
        if (handled.call !== null) frame.toolCalls.push(handled.call);
        turn.next += 1;
        delete turn.decision;
      }
      frame.messages.push({ role: "tool", results: turn.results });
      frame.turn = null;
    }
    if (timedOut()) return close("timeout", "timeout");
    if (frame.steps >= maxSteps) return close("error", "max_steps");
    let reply: ModelReply;
    try {
      reply = await ask(frame, agent, env);
    } catch (error) {
      if (error instanceof NoProvider) return close("error", "provider_not_configured");
      const errorClass = error instanceof ModelError ? error.errorClass : "server";
      return errorClass === "timeout" ? close("timeout", "timeout") : close("error", MODEL_RUN_ERRORS[errorClass]);
    }
    frame.steps += 1;
    frame.inputTokens += reply.usage.inputTokens;
    frame.outputTokens += reply.usage.outputTokens;
    if (reply.finish === "refused") return close("refused", null);
    if (reply.toolCalls.length === 0) {
      const schema = agent.definition.harness.output?.schema;
      if (schema === undefined) return close("ok", null, textOutput(reply.text));
      const value = jsonIn(reply.text);
      if (value === undefined) return close("error", "schema", textOutput(reply.text), false);
      if (!schemaFits(schema, value)) return close("error", "schema", jsonOutput(value), false);
      return close("ok", null, jsonOutput(value), true);
    }
    frame.messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, ...(reply.raw === undefined ? {} : { raw: reply.raw }) });
    frame.turn = { calls: reply.toolCalls, next: 0, results: [] };
  }
}

/** The runs of a paused chain, failed: its state could not be kept. */
function failed(records: RunRecord[], errorClass: RunErrorClass): RunRecord[] {
  return records.map((record) =>
    record.status === "awaiting_approval"
      ? { ...record, status: "error" as const, errorClass, toolCalls: record.toolCalls.filter((call) => call.approval !== "pending") }
      : record,
  );
}

function outcomeOf(root: Frame, step: Step): Outcome {
  if (step.kind === "finished") return { kind: "finished", records: step.records };
  const state = JSON.stringify(root);
  if (utf8Bytes(state) > MAX_STATE_BYTES) return { kind: "finished", records: failed(step.records, "store") };
  return { kind: "paused", records: step.records, pending: step.pending, state };
}

/** Start a run: refused before it starts, finished, or paused for the owner. */
export async function startRun(
  agent: RuntimeAgent,
  input: RunInput,
  options: { trigger: RunTrigger; runId: string; parentRunId?: string; world: World; mode: RunMode },
): Promise<Outcome> {
  const { world, mode } = options;
  const meta = { runId: options.runId, parentRunId: options.parentRunId ?? null, trigger: options.trigger, startedAt: world.now() };
  if (agent.refusal !== null) return { kind: "finished", records: [unstarted(agent, meta, "refused", agent.refusal, mode)] };
  const frame = newFrame(agent, input, { ...meta, depth: 0 });
  if (frame === null) return { kind: "finished", records: [unstarted(agent, meta, "error", "invalid_input", mode)] };
  const env: Env = {
    world,
    mode,
    fixtures: mode.kind === "test" ? mode.fixtures : {},
    subAgentFixtures: mode.kind === "test" ? mode.subAgentFixtures : {},
    deadline: Number.POSITIVE_INFINITY,
  };
  return outcomeOf(frame, await drive(frame, agent, env));
}

/** Resume a paused run with the owner's decision on the call it waits on. */
export async function resumeRun(state: string, decision: "approved" | "denied", world: World): Promise<Outcome> {
  const root = JSON.parse(state) as Frame;
  let waiting = root;
  const chain: Frame[] = [root];
  while (waiting.child !== null) {
    waiting = waiting.child;
    chain.push(waiting);
  }
  if (waiting.turn === null) return { kind: "finished", records: chain.reverse().map((f) => recordOf(f, "error", "store", null, null)) };
  waiting.turn.decision = decision;
  const agent = world.agentAt(root.agentId, root.versionNumber);
  if (agent === null || agent.refusal !== null) {
    const errorClass = agent === null ? "config_unavailable" : agent.refusal!;
    const status = agent === null ? "error" : "refused";
    return { kind: "finished", records: chain.reverse().map((frame) => recordOf(frame, status, errorClass, null, null)) };
  }
  const env: Env = { world, mode: { kind: "run" }, fixtures: {}, subAgentFixtures: {}, deadline: Number.POSITIVE_INFINITY };
  return outcomeOf(root, await drive(root, agent, env));
}

// ── Before a run: may it run? ────────────────────────────────────────────────

/** What a run is checked against before it starts: its switch, its month's spending, its provider. */
export type RunGuard = {
  enabled: boolean;
  budgetUsd: number | null;
  /** This month's spending; null where a day of it has no price (then it cannot be judged). */
  spentUsd: number | null;
  provider: string | null;
  configured: Readonly<Record<string, boolean>>;
  /** Its runs started today (UTC), sub-agent runs included, and the most it may start in a day. */
  runsToday: number;
  maxRunsPerDay: number;
};

/**
 * Why an agent may not run now, or null: off; its day's runs spent (the
 * brake that always holds, priced or not); over a budget its priced runs
 * reached; its provider not configured. A budget over unpriced runs cannot
 * be reached (`budgetState` says so).
 */
export function runRefusal(guard: RunGuard): RunErrorClass | null {
  if (!guard.enabled) return "agent_off";
  if (guard.runsToday >= guard.maxRunsPerDay) return "over_budget";
  if (guard.budgetUsd !== null && guard.spentUsd !== null && guard.spentUsd >= guard.budgetUsd) return "over_budget";
  if (guard.provider === null || guard.configured[guard.provider] !== true) return "provider_not_configured";
  return null;
}

/** What a monthly budget is doing: none set, not enforced (its runs are not priced), within it, or reached. */
export function budgetState(guard: { budgetUsd: number | null; spentUsd: number | null }): "none" | "not_priced" | "within" | "reached" {
  if (guard.budgetUsd === null) return "none";
  if (guard.spentUsd === null) return "not_priced";
  return guard.spentUsd >= guard.budgetUsd ? "reached" : "within";
}

/** The latest time a schedule was due in the window that ends now, or null: so a late tick still runs it, once. */
export function dueAt(next: (after: number) => number[], now: number, windowMs: number): number | null {
  const due = next(now - windowMs).filter((at) => at <= now);
  return due.length === 0 ? null : due[due.length - 1]!;
}

/** A nearest-rank percentile of durations; null with none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((a, b) => a - b);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1))]!;
}
