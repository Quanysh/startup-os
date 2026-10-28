// Testing a harness draft through its project (Agents Protocol v1.1 and
// v1.2, docs/agents-protocol.md): test cases (v1.2: a prompt variant, and a
// conversation for an agent that sends its own), the jobs a project polls for and
// leases, the results it sends back, and the gate a draft passes before it
// may be published.
//
// A test case is made-up data, never a real patient: the page says so and
// asks for a tick each time one is saved. The project runs the draft on each
// chosen model against each case and sends what came back, which is the
// model's answer to made-up data.
//
// Pure: the UI imports the words and the shapes; the server asks the rules.

import { CATALOG_TOOL_ID_PATTERN } from "./agentBuilder";
import { z } from "zod";
import { ERROR_CLASSES, MAX_LATENCY_MS, MODEL_PATTERN, SLUG_PATTERN, type ModelPair } from "./agentControl";
import {
  DEFAULT_VARIANT,
  MAX_TOOLS,
  TOOL_ID_PATTERN,
  VARIABLE_NAME_PATTERN,
  VARIANT_NAME_PATTERN,
  type Issue,
  type PromptInput,
  type Variable,
} from "./agentHarness";
import { stableStringify, utf8Bytes } from "./agentSchemaCompat";

// ── Bounds ───────────────────────────────────────────────────────────────────

/** The most cases one agent keeps, and one job carries. */
export const MAX_CASES = 50;
/** The most models one run tests on. */
export const MAX_RUN_MODELS = 4;
export const MAX_ASSERTIONS = 30;
/** A case as stored, variables, conversation, fixtures and expectations together, in UTF-8 bytes (32 KB in v1.1). */
export const MAX_CASE_BYTES = 64 * 1024;
/** A case's conversation (v1.2), for an agent that sends its own: at most this many messages… */
export const MAX_MESSAGES = 50;
/** …each at most this many UTF-8 bytes of text. */
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type CaseMessage = { role: MessageRole; content: string };
export const MAX_CASE_NAME = 80;
/** A model's output in one result, as JSON, in UTF-8 bytes. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** A results body, in bytes: 50 cases on 4 models at 64 KB each, and room for the rest. */
export const MAX_RESULTS_BYTES = 14 * 1024 * 1024;
/** A `matches` pattern. */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_ASSERT_PATH = 200;
/** A path into the output: `$`, `$.codes`, `$.codes[0].code`. */
export const ASSERT_PATH_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])*$/;

/** How long a project holds a job it was handed before another poll may take it. */
export const LEASE_MS = 10 * 60 * 1000;
/** A job handed out this many times without results is given up on. */
export const MAX_LEASES = 3;
/** The most jobs one poll is handed. */
export const MAX_JOBS_PER_POLL = 2;
/** Runs shown for one agent. */
export const RUNS_SHOWN = 20;

export const MADE_UP_NOTE = "Made-up data only — never a real patient.";

// ── Test cases ───────────────────────────────────────────────────────────────

export const ASSERT_OPS = ["equals", "contains", "exists", "matches"] as const;
export type AssertOp = (typeof ASSERT_OPS)[number];

export const ASSERT_OP_WORDS: Record<AssertOp, string> = {
  equals: "equals",
  contains: "contains",
  exists: "exists",
  matches: "matches the pattern",
};

/** One expectation as stored: its value as JSON text (`true`, `"99213"`, `{"a":1}`). */
export type Assertion = { path: string; op: AssertOp; value: string };

export type CaseInput = {
  name: string;
  variables: Record<string, string>;
  /** JSON text: an object of tool id to what that tool returns in the test. */
  toolFixtures?: string | null;
  expect: readonly Assertion[];
  /** v1.2: the prompt variant to run; left out, `default`. */
  variant?: string | null;
  /** v1.2: the conversation, for an agent that sends its own (`input: "messages"`). */
  messages?: readonly CaseMessage[] | null;
  /**
   * v1.3, an agent built here: JSON text, an object of sub-agent tool id to an
   * object of tool id to what that tool returns, for the sub-agent's own tools.
   */
  subAgentFixtures?: string | null;
};

export const CASE_WORDS = {
  madeUp: "Tick that this is made-up data, never a real patient.",
  name: `A case's name is 1 to ${MAX_CASE_NAME} characters.`,
  variableName: "A variable's name is a letter, then up to 39 letters, digits and underscores.",
  tooManyVariables: "A case has at most 30 variables.",
  fixtures: "Tool fixtures are a JSON object of tool id to what the tool returns.",
  fixtureTool: "Tool fixtures name a tool id that is not one.",
  subAgentFixtures:
    "Sub-agent fixtures are a JSON object of a sub-agent's tool id to an object of tool id to what that tool returns.",
  tooManyAssertions: `A case has at most ${MAX_ASSERTIONS} expectations.`,
  path: "An expectation's path is $, then .name or [number] parts: $.codes[0].code.",
  value: "An expectation's value is JSON.",
  exists: "exists takes true or false.",
  matches: `matches takes a regular expression of at most ${MAX_PATTERN_LENGTH} characters; it must match the whole value.`,
  unsafePattern: "A pattern may not use backreferences or nested quantifiers such as (a+)+.",
  size: "A case is at most 64 KB.",
  tooMany: `An agent has at most ${MAX_CASES} test cases.`,
  variant: "A variant's name is a lowercase letter, then up to 31 of a-z, 0-9 and _.",
  messagesEmpty: "A conversation has at least one message.",
  tooManyMessages: `A conversation has at most ${MAX_MESSAGES} messages.`,
  messageRole: "A message is the user's or the assistant's.",
  messageEmpty: "A message has some text.",
  messageSize: "A message is at most 32 KB.",
} as const;

const parse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A backreference: `\1`…`\9`, or `\k<name>`. */
const BACKREFERENCE = /\\[1-9]|\\k</;
/** A group holding a repeat that is itself repeated: `(a+)+`, `(\d*x)*`, `(a{2,})+`. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;

/**
 * Why a `matches` value cannot be a pattern, or null. The project anchors it
 * (`^(?:pattern)$`: the whole value must match) and refuses a pattern that
 * could run away: a backreference or a nested quantifier.
 */
export function patternProblem(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_LENGTH) return CASE_WORDS.matches;
  if (BACKREFERENCE.test(pattern) || NESTED_QUANTIFIER.test(pattern)) return CASE_WORDS.unsafePattern;
  try {
    new RegExp(`^(?:${pattern})$`);
  } catch {
    return CASE_WORDS.matches;
  }
  return null;
}

/** Why a case cannot be saved, in fixed words by path; empty where it can. */
export function caseProblems(input: CaseInput): Issue[] {
  const issues: Issue[] = [];
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_CASE_NAME) issues.push({ path: "name", message: CASE_WORDS.name });
  const names = Object.keys(input.variables);
  if (names.length > 30) issues.push({ path: "variables", message: CASE_WORDS.tooManyVariables });
  for (const key of names) {
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      issues.push({ path: "variables", message: CASE_WORDS.variableName });
      break;
    }
  }
  if (input.toolFixtures != null && input.toolFixtures.trim() !== "") {
    const parsed = parse(input.toolFixtures);
    if (!parsed.ok || !isPlainObject(parsed.value)) issues.push({ path: "toolFixtures", message: CASE_WORDS.fixtures });
    else if (Object.keys(parsed.value).some((id) => !TOOL_ID_PATTERN.test(id) && !CATALOG_TOOL_ID_PATTERN.test(id))) {
      issues.push({ path: "toolFixtures", message: CASE_WORDS.fixtureTool });
    }
  }
  if (input.subAgentFixtures != null && input.subAgentFixtures.trim() !== "") {
    const parsed = parse(input.subAgentFixtures);
    const fits =
      parsed.ok &&
      isPlainObject(parsed.value) &&
      Object.entries(parsed.value).every(
        ([id, tools]) =>
          CATALOG_TOOL_ID_PATTERN.test(id) && isPlainObject(tools) && Object.keys(tools).every((tool) => CATALOG_TOOL_ID_PATTERN.test(tool)),
      );
    if (!fits) issues.push({ path: "subAgentFixtures", message: CASE_WORDS.subAgentFixtures });
  }
  if (input.expect.length > MAX_ASSERTIONS) issues.push({ path: "expect", message: CASE_WORDS.tooManyAssertions });
  input.expect.forEach((assertion, i) => {
    if (assertion.path.length > MAX_ASSERT_PATH || !ASSERT_PATH_PATTERN.test(assertion.path)) {
      issues.push({ path: `expect.${i}.path`, message: CASE_WORDS.path });
    }
    const parsed = parse(assertion.value);
    if (!parsed.ok) {
      issues.push({ path: `expect.${i}.value`, message: CASE_WORDS.value });
      return;
    }
    if (assertion.op === "exists" && typeof parsed.value !== "boolean") {
      issues.push({ path: `expect.${i}.value`, message: CASE_WORDS.exists });
    }
    if (assertion.op === "matches" && patternProblem(parsed.value) !== null) {
      issues.push({ path: `expect.${i}.value`, message: patternProblem(parsed.value)! });
    }
  });
  if (input.variant != null && input.variant !== "" && !VARIANT_NAME_PATTERN.test(input.variant)) {
    issues.push({ path: "variant", message: CASE_WORDS.variant });
  }
  if (input.messages != null) {
    if (input.messages.length === 0) issues.push({ path: "messages", message: CASE_WORDS.messagesEmpty });
    else if (input.messages.length > MAX_MESSAGES) issues.push({ path: "messages", message: CASE_WORDS.tooManyMessages });
    else {
      input.messages.forEach((message, i) => {
        if (!(MESSAGE_ROLES as readonly string[]).includes(message.role)) {
          issues.push({ path: `messages.${i}.role`, message: CASE_WORDS.messageRole });
        }
        if (typeof message.content !== "string" || message.content.trim() === "") {
          issues.push({ path: `messages.${i}.content`, message: CASE_WORDS.messageEmpty });
        } else if (utf8Bytes(message.content) > MAX_MESSAGE_BYTES) {
          issues.push({ path: `messages.${i}.content`, message: CASE_WORDS.messageSize });
        }
      });
    }
  }
  if (utf8Bytes(stableStringify({ ...input, name })) > MAX_CASE_BYTES) issues.push({ path: "case", message: CASE_WORDS.size });
  return issues;
}

/** What a case is tested against (v1.2): the code's variants, whether it sends its own conversation, its provider tools. */
export type CaseAgent = {
  variants?: readonly string[];
  input?: PromptInput;
  providerTools?: readonly string[];
  /** v1.3: the tool ids of the sub-agents an agent built here may call; none for a code agent. */
  subAgentTools?: readonly string[];
};

/**
 * What a case must be for its agent whatever the draft (v1.2), asked when it
 * is saved and again before a run: a variant the code declares, and a
 * conversation exactly where the agent sends its own. In words that name it.
 */
export function caseAgentProblems(
  name: string,
  test: { variant?: string | null; messages?: readonly CaseMessage[] | null },
  agent: CaseAgent = {},
): string[] {
  const problems: string[] = [];
  const variants = agent.variants ?? [DEFAULT_VARIANT];
  if (test.variant != null && test.variant !== "" && !variants.includes(test.variant)) {
    problems.push(
      VARIANT_NAME_PATTERN.test(test.variant)
        ? `${name}: uses the variant ${test.variant}, which the code does not declare.`
        : `${name}: uses a variant the code does not declare.`,
    );
  }
  const conversation = test.messages != null && test.messages.length > 0;
  if ((agent.input ?? "text") === "messages") {
    if (!conversation) problems.push(`${name}: gives no conversation, and this agent sends its own.`);
  } else if (test.messages != null) {
    problems.push(`${name}: has a conversation, but this agent sends one user turn from its template.`);
  }
  return problems;
}

/**
 * Why a case cannot test a draft: a required variable it leaves out (or
 * blank), a variable the code does not declare, or a fixture for a tool it
 * does not declare. In words that name the case.
 */
export function caseFitProblems(
  name: string,
  test: {
    variables: Record<string, string>;
    toolFixtures?: string | null;
    variant?: string | null;
    messages?: readonly CaseMessage[] | null;
    subAgentFixtures?: string | null;
  },
  variables: readonly Variable[],
  tools: readonly string[],
  agent: CaseAgent = {},
): string[] {
  const problems = caseAgentProblems(name, test, agent);
  const declared = new Set(variables.map((v) => v.name));
  for (const variable of variables) {
    if (variable.required && (test.variables[variable.name] ?? "").trim() === "") {
      problems.push(`${name}: gives no value for the required variable ${variable.name}.`);
    }
  }
  for (const key of Object.keys(test.variables)) {
    if (!declared.has(key)) problems.push(`${name}: ${key} is not a variable the code declares.`);
  }
  if (test.toolFixtures != null && test.toolFixtures.trim() !== "") {
    const parsed = parse(test.toolFixtures);
    if (parsed.ok && isPlainObject(parsed.value)) {
      const known = new Set(tools);
      const provider = new Set(agent.providerTools ?? []);
      for (const id of Object.keys(parsed.value)) {
        if (!known.has(id)) problems.push(`${name}: has a fixture for a tool the code does not declare.`);
        else if (provider.has(id)) problems.push(`${name}: has a fixture for a tool built into the provider, which test runs skip.`);
      }
    }
  }
  if (test.subAgentFixtures != null && test.subAgentFixtures.trim() !== "") {
    const parsed = parse(test.subAgentFixtures);
    if (parsed.ok && isPlainObject(parsed.value)) {
      const subAgents = new Set(agent.subAgentTools ?? []);
      if (Object.keys(parsed.value).some((id) => !subAgents.has(id))) {
        problems.push(`${name}: has sub-agent fixtures for a sub-agent this agent cannot call.`);
      }
    }
  }
  return problems;
}

/** One case as a job carries it. */
export type JobCase = {
  id: string;
  variables: Record<string, string>;
  /** v1.2: left out for the variant `default`. */
  variant?: string;
  /** v1.2: the conversation, for an agent that sends its own. */
  messages?: CaseMessage[];
  toolFixtures?: Record<string, unknown>;
  /** v1.3: answers for each sub-agent's own tools, by the sub-agent's tool id. */
  subAgentFixtures?: Record<string, unknown>;
  expect: Record<string, unknown>[];
};

export function jobCaseOf(id: string, test: CaseInput): JobCase {
  const fixtures = test.toolFixtures != null && test.toolFixtures.trim() !== "" ? parse(test.toolFixtures) : null;
  const subAgent = test.subAgentFixtures != null && test.subAgentFixtures.trim() !== "" ? parse(test.subAgentFixtures) : null;
  return {
    id,
    variables: { ...test.variables },
    ...(test.variant != null && test.variant !== "" ? { variant: test.variant } : {}),
    ...(test.messages != null ? { messages: test.messages.map((m) => ({ role: m.role, content: m.content })) } : {}),
    ...(fixtures !== null && fixtures.ok && isPlainObject(fixtures.value) ? { toolFixtures: fixtures.value } : {}),
    ...(subAgent !== null && subAgent.ok && isPlainObject(subAgent.value) ? { subAgentFixtures: subAgent.value } : {}),
    expect: test.expect.map((assertion) => {
      const value = parse(assertion.value);
      return { path: assertion.path, [assertion.op]: value.ok ? value.value : null };
    }),
  };
}

// ── Leasing ──────────────────────────────────────────────────────────────────

export const RUN_STATUSES = ["queued", "running", "done", "expired"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type Lease = "available" | "leased" | "expire" | "closed";

/**
 * What a poll may do with a job: hand it out (queued, or its lease ran out
 * with leases left), leave it (another poll holds it), give up on it (its
 * last lease ran out), or nothing (finished).
 */
export function leaseOf(job: { status: RunStatus; leaseUntil?: number | null; leases: number }, now: number): Lease {
  if (job.status === "queued") return "available";
  if (job.status !== "running") return "closed";
  if (job.leaseUntil != null && job.leaseUntil > now) return "leased";
  return job.leases < MAX_LEASES ? "available" : "expire";
}

// ── Results ──────────────────────────────────────────────────────────────────

export const RESULT_ERRORS = [...ERROR_CLASSES, "refused"] as const;
/** v1.3: how a tool call in a test went. No tool runs in a test: each is answered from a fixture. */
export const TEST_CALL_STATUSES = ["ok", "error", "skipped"] as const;
export type TestCallStatus = (typeof TEST_CALL_STATUSES)[number];
export const MAX_TEST_TOOL_CALLS = 100;
export type ResultError = (typeof RESULT_ERRORS)[number];

/**
 * A job's or a case's id: a Convex id, letters and digits (the local test
 * backend's also carry `;` and their table's name). Checked against the
 * table before it is used.
 */
export const JOB_ID_PATTERN = /^[A-Za-z0-9;]{1,64}$/;
const CASE_ID_PATTERN = JOB_ID_PATTERN;

const count = z.number().int().nonnegative().max(1_000_000_000);

export const resultRow = z.strictObject({
  caseId: z.string().regex(CASE_ID_PATTERN),
  provider: z.string().regex(SLUG_PATTERN),
  model: z.string().regex(MODEL_PATTERN),
  output: z
    .json()
    .nullable()
    .refine((value) => utf8Bytes(JSON.stringify(value)) <= MAX_OUTPUT_BYTES, "is more than 64 KB."),
  schemaValid: z.boolean(),
  assertions: z
    .array(z.strictObject({ index: z.number().int().nonnegative().max(MAX_ASSERTIONS - 1), passed: z.boolean() }))
    .max(MAX_ASSERTIONS),
  latencyMs: z.number().nonnegative().max(MAX_LATENCY_MS),
  inputTokens: count,
  outputTokens: count,
  costUsd: z.number().nonnegative().max(1_000).nullable(),
  error: z.enum(RESULT_ERRORS).nullable(),
  /** v1.2: the tools built into the provider that the test run skipped. */
  skippedTools: z.array(z.string().regex(CATALOG_TOOL_ID_PATTERN)).max(MAX_TOOLS).optional(),
  /** v1.3, an agent built here: its model turns. */
  steps: z.number().int().nonnegative().max(1_000).optional(),
  /** v1.3, an agent built here: its tool calls in order (`skipped`: no fixture, or not available). */
  toolCalls: z
    .array(z.strictObject({ toolId: z.string().regex(CATALOG_TOOL_ID_PATTERN), status: z.enum(TEST_CALL_STATUSES) }))
    .max(MAX_TEST_TOOL_CALLS)
    .optional(),
});
export type ResultRow = z.infer<typeof resultRow>;

export const resultsBody = z.strictObject({
  results: z.array(resultRow).max(MAX_CASES * MAX_RUN_MODELS),
});
export type ResultsBody = z.infer<typeof resultsBody>;

/**
 * What a results body cannot say about itself, against the job it answers:
 * each result is one of the job's cases on one of its models, once, and its
 * assertions are the case's, each once.
 */
export function resultsProblems(
  body: ResultsBody,
  job: { cases: ReadonlyMap<string, number>; models: readonly ModelPair[]; tools?: readonly string[] },
): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  body.results.forEach((row, i) => {
    const expected = job.cases.get(row.caseId);
    if (expected === undefined) issues.push({ path: `results.${i}.caseId`, message: "is not a case of this job." });
    if (!job.models.some((m) => m.provider === row.provider && m.model === row.model)) {
      issues.push({ path: `results.${i}.model`, message: "is not a model of this job." });
    }
    const key = `${row.caseId}|${row.provider}|${row.model}`;
    if (seen.has(key)) issues.push({ path: `results.${i}`, message: "repeats an earlier result's case and model." });
    seen.add(key);
    const indexes = new Set<number>();
    row.assertions.forEach((assertion, j) => {
      if (expected !== undefined && assertion.index >= expected) {
        issues.push({ path: `results.${i}.assertions.${j}.index`, message: "is not an expectation of this case." });
      }
      if (indexes.has(assertion.index)) {
        issues.push({ path: `results.${i}.assertions.${j}`, message: "repeats an earlier assertion's index." });
      }
      indexes.add(assertion.index);
    });
    const skipped = new Set<string>();
    (row.skippedTools ?? []).forEach((id, j) => {
      if (job.tools !== undefined && !job.tools.includes(id)) {
        issues.push({ path: `results.${i}.skippedTools.${j}`, message: "is not a tool this job switched on." });
      } else if (skipped.has(id)) {
        issues.push({ path: `results.${i}.skippedTools.${j}`, message: "repeats an earlier tool." });
      }
      skipped.add(id);
    });
  });
  return issues;
}

/** A result passes: no error, output that fits the schema, and every one of the case's expectations met. */
export function resultPassed(
  row: { error?: ResultError | null; schemaValid: boolean; assertions: readonly { index: number; passed: boolean }[] },
  expected: number,
): boolean {
  if (row.error != null || !row.schemaValid) return false;
  for (let index = 0; index < expected; index += 1) {
    if (!row.assertions.some((a) => a.index === index && a.passed)) return false;
  }
  return true;
}

// ── The gate ─────────────────────────────────────────────────────────────────

export type GateState = "passed" | "no_run" | "running" | "stale" | "failed";

export const GATE_WORDS: Record<GateState, string> = {
  passed: "Its latest test run passed every expectation on every model.",
  no_run: "Run its tests before publishing.",
  running: "Its test run has not finished.",
  stale: "It changed after its latest test run: run its tests again.",
  failed: "Its latest test run did not pass every expectation on every model.",
};

export type RunSummary = { expected: number; received: number; passed: number };

/**
 * Whether a draft may be published on its tests: its latest finished run is
 * of the draft as it is now, and every case passed on every model (a result
 * missing is not a pass). A run still out is said before a stale one.
 */
export function gateOf(
  draft: { revision: number },
  runs: readonly { revision: number; status: RunStatus; summary?: RunSummary | null }[],
): GateState {
  const latestDone = runs.find((run) => run.status === "done");
  const outNow = runs.some(
    (run) => (run.status === "queued" || run.status === "running") && run.revision === draft.revision,
  );
  if (latestDone === undefined || latestDone.revision !== draft.revision) {
    if (outNow) return "running";
    return latestDone === undefined ? "no_run" : "stale";
  }
  const summary = latestDone.summary;
  if (summary == null || summary.expected === 0) return "failed";
  return summary.passed === summary.expected && summary.received === summary.expected ? "passed" : "failed";
}
