import { describe, expect, test } from "vitest";
import {
  CASE_WORDS,
  LEASE_MS,
  MAX_MESSAGES,
  MAX_LEASES,
  caseFitProblems,
  caseProblems,
  gateOf,
  jobCaseOf,
  leaseOf,
  patternProblem,
  resultPassed,
  resultsBody,
  resultsProblems,
  type CaseInput,
} from "./agentJobs";

// Test cases, leasing, results and the publish gate. Every case is made up.

const CASE: CaseInput = {
  name: "Made-up knee visit",
  variables: { note: "Made-up note: knee pain, x-ray taken." },
  toolFixtures: '{"web_search": {"hits": []}}',
  expect: [
    { path: "$.codes[0]", op: "equals", value: '"73560"' },
    { path: "$.codes", op: "contains", value: '"73560"' },
    { path: "$.confidence", op: "exists", value: "true" },
    { path: "$.codes[0]", op: "matches", value: '"^7\\\\d{4}$"' },
  ],
};

describe("a test case", () => {
  test("a good one has no problem", () => {
    expect(caseProblems(CASE)).toEqual([]);
  });

  test("its name, variables, fixtures and expectations are bounded, in fixed words", () => {
    expect(caseProblems({ ...CASE, name: "  " })).toEqual([{ path: "name", message: CASE_WORDS.name }]);
    expect(caseProblems({ ...CASE, variables: { "Bad Name": "x" } })).toEqual([
      { path: "variables", message: CASE_WORDS.variableName },
    ]);
    expect(caseProblems({ ...CASE, toolFixtures: "[1]" })).toEqual([{ path: "toolFixtures", message: CASE_WORDS.fixtures }]);
    expect(caseProblems({ ...CASE, toolFixtures: '{"Bad Tool": 1}' })).toEqual([
      { path: "toolFixtures", message: CASE_WORDS.fixtureTool },
    ]);
    expect(caseProblems({ ...CASE, toolFixtures: "" })).toEqual([]);
    expect(caseProblems({ ...CASE, expect: [{ path: "codes", op: "equals", value: "1" }] })).toEqual([
      { path: "expect.0.path", message: CASE_WORDS.path },
    ]);
    expect(caseProblems({ ...CASE, expect: [{ path: "$", op: "equals", value: "{" }] })).toEqual([
      { path: "expect.0.value", message: CASE_WORDS.value },
    ]);
    expect(caseProblems({ ...CASE, expect: [{ path: "$", op: "exists", value: '"yes"' }] })).toEqual([
      { path: "expect.0.value", message: CASE_WORDS.exists },
    ]);
    expect(caseProblems({ ...CASE, expect: [{ path: "$", op: "matches", value: '"("' }] })).toEqual([
      { path: "expect.0.value", message: CASE_WORDS.matches },
    ]);
    const many = Array.from({ length: 31 }, () => ({ path: "$", op: "exists" as const, value: "true" }));
    expect(caseProblems({ ...CASE, expect: many })).toEqual([{ path: "expect", message: CASE_WORDS.tooManyAssertions }]);
    expect(caseProblems({ ...CASE, variables: { note: "x".repeat(65 * 1024) } })).toEqual([
      { path: "case", message: CASE_WORDS.size },
    ]);
  });

  test("a matches pattern is anchored by the project, bounded, and may not run away", () => {
    expect(patternProblem("^7\\d{4}$")).toBeNull();
    expect(patternProblem("7\\d{4}")).toBeNull();
    expect(patternProblem("(cpt|icd)-\\d+")).toBeNull();
    expect(patternProblem("(a+)?")).toBeNull();
    expect(patternProblem("x".repeat(201))).toBe(CASE_WORDS.matches);
    expect(patternProblem(5)).toBe(CASE_WORDS.matches);
    expect(patternProblem("(")).toBe(CASE_WORDS.matches);
    expect(patternProblem("(a+)+")).toBe(CASE_WORDS.unsafePattern);
    expect(patternProblem("(\\d*x)*")).toBe(CASE_WORDS.unsafePattern);
    expect(patternProblem("(a{2,})+")).toBe(CASE_WORDS.unsafePattern);
    expect(patternProblem("(a)\\1")).toBe(CASE_WORDS.unsafePattern);
    expect(patternProblem("(?<x>a)\\k<x>")).toBe(CASE_WORDS.unsafePattern);
    expect(CASE_WORDS.matches).toContain("must match the whole value");
  });

  test("it fits a draft: required variables given, declared variables and tools only", () => {
    const variables = [
      { name: "note", required: true },
      { name: "payer", required: false },
    ];
    expect(caseFitProblems("A", CASE, variables, ["web_search"])).toEqual([]);
    expect(caseFitProblems("A", { variables: { note: " " } }, variables, [])).toEqual([
      "A: gives no value for the required variable note.",
    ]);
    expect(caseFitProblems("A", { variables: { note: "x", extra: "y" } }, variables, [])).toEqual([
      "A: extra is not a variable the code declares.",
    ]);
    expect(caseFitProblems("A", CASE, variables, [])).toEqual(["A: has a fixture for a tool the code does not declare."]);
  });

  test("a job carries it with its values as JSON, each expectation keyed by its kind", () => {
    expect(jobCaseOf("k1", CASE)).toEqual({
      id: "k1",
      variables: CASE.variables,
      toolFixtures: { web_search: { hits: [] } },
      expect: [
        { path: "$.codes[0]", equals: "73560" },
        { path: "$.codes", contains: "73560" },
        { path: "$.confidence", exists: true },
        { path: "$.codes[0]", matches: "^7\\d{4}$" },
      ],
    });
    expect(jobCaseOf("k2", { ...CASE, toolFixtures: null })).not.toHaveProperty("toolFixtures");
  });
});

describe("leasing", () => {
  const NOW = 1_000_000;
  test("a queued job is handed out; a held one is left; an expired lease is taken again until the last", () => {
    expect(leaseOf({ status: "queued", leases: 0 }, NOW)).toBe("available");
    expect(leaseOf({ status: "running", leaseUntil: NOW + 1, leases: 1 }, NOW)).toBe("leased");
    expect(leaseOf({ status: "running", leaseUntil: NOW, leases: 1 }, NOW)).toBe("available");
    expect(leaseOf({ status: "running", leaseUntil: NOW - LEASE_MS, leases: MAX_LEASES - 1 }, NOW)).toBe("available");
    expect(leaseOf({ status: "running", leaseUntil: NOW - 1, leases: MAX_LEASES }, NOW)).toBe("expire");
    expect(leaseOf({ status: "done", leases: 1 }, NOW)).toBe("closed");
    expect(leaseOf({ status: "expired", leases: 3 }, NOW)).toBe("closed");
  });
});

const RESULT = {
  caseId: "k1",
  provider: "vertex",
  model: "made-up-pro",
  output: { codes: ["73560"], confidence: 0.9 },
  schemaValid: true,
  assertions: [
    { index: 0, passed: true },
    { index: 1, passed: true },
  ],
  latencyMs: 900,
  inputTokens: 1200,
  outputTokens: 80,
  costUsd: 0.001,
  error: null,
};

describe("results", () => {
  test("the shape: strict, bounded, an error class or null, output JSON or null", () => {
    expect(resultsBody.safeParse({ results: [RESULT] }).success).toBe(true);
    expect(resultsBody.safeParse({ results: [{ ...RESULT, output: null, error: "timeout" }] }).success).toBe(true);
    expect(resultsBody.safeParse({ results: [{ ...RESULT, error: "refused" }] }).success).toBe(true);
    expect(resultsBody.safeParse({ results: [{ ...RESULT, costUsd: null }] }).success).toBe(true);
    const fails = (over: Record<string, unknown>) => !resultsBody.safeParse({ results: [{ ...RESULT, ...over }] }).success;
    expect(fails({ error: "the model said no" })).toBe(true);
    expect(fails({ output: { text: "x".repeat(64 * 1024) } })).toBe(true);
    expect(fails({ output: undefined })).toBe(true);
    expect(fails({ extra: 1 })).toBe(true);
    expect(fails({ latencyMs: -1 })).toBe(true);
    expect(fails({ inputTokens: 1.5 })).toBe(true);
    expect(fails({ assertions: [{ index: 30, passed: true }] })).toBe(true);
    expect(fails({ caseId: "../x" })).toBe(true);
    expect(resultsBody.safeParse({ results: Array.from({ length: 201 }, () => RESULT) }).success).toBe(false);
    expect(resultsBody.safeParse({ results: [], extra: 1 }).success).toBe(false);
  });

  test("against the job: its cases and models only, each once, its expectations only", () => {
    const job = { cases: new Map([["k1", 2]]), models: [{ provider: "vertex", model: "made-up-pro" }] };
    const body = (rows: unknown[]) => resultsBody.parse({ results: rows });
    expect(resultsProblems(body([RESULT]), job)).toEqual([]);
    expect(resultsProblems(body([{ ...RESULT, caseId: "k9" }]), job).map((i) => i.path)).toEqual(["results.0.caseId"]);
    expect(resultsProblems(body([{ ...RESULT, model: "other" }]), job).map((i) => i.path)).toEqual(["results.0.model"]);
    expect(resultsProblems(body([RESULT, RESULT]), job).map((i) => i.path)).toEqual(["results.1"]);
    expect(
      resultsProblems(body([{ ...RESULT, assertions: [{ index: 2, passed: true }, { index: 2, passed: true }] }]), job).map(
        (i) => i.path,
      ),
    ).toEqual(["results.0.assertions.0.index", "results.0.assertions.1.index", "results.0.assertions.1"]);
  });

  test("a result passes with no error, a valid schema and every expectation met", () => {
    expect(resultPassed(RESULT, 2)).toBe(true);
    expect(resultPassed(RESULT, 3)).toBe(false);
    expect(resultPassed({ ...RESULT, error: "timeout" }, 2)).toBe(false);
    expect(resultPassed({ ...RESULT, schemaValid: false }, 2)).toBe(false);
    expect(resultPassed({ ...RESULT, assertions: [{ index: 0, passed: true }, { index: 1, passed: false }] }, 2)).toBe(false);
    expect(resultPassed({ ...RESULT, assertions: [] }, 0)).toBe(true);
  });
});

describe("the publish gate", () => {
  const done = (revision: number, passed: number, expected = 4, received = expected) => ({
    revision,
    status: "done" as const,
    summary: { expected, received, passed },
  });
  test("passed only when the latest finished run is of the draft as it is and passed everything", () => {
    expect(gateOf({ revision: 2 }, [])).toBe("no_run");
    expect(gateOf({ revision: 2 }, [done(2, 4)])).toBe("passed");
    expect(gateOf({ revision: 2 }, [done(2, 3)])).toBe("failed");
    expect(gateOf({ revision: 2 }, [done(2, 3, 4, 3)])).toBe("failed");
    expect(gateOf({ revision: 2 }, [done(2, 0, 0)])).toBe("failed");
    expect(gateOf({ revision: 3 }, [done(2, 4)])).toBe("stale");
    expect(gateOf({ revision: 3 }, [{ revision: 3, status: "queued" }, done(2, 4)])).toBe("running");
    expect(gateOf({ revision: 2 }, [{ revision: 2, status: "expired" }, done(2, 4)])).toBe("passed");
    expect(gateOf({ revision: 2 }, [{ revision: 2, status: "expired" }])).toBe("no_run");
  });
});

// ── Protocol v1.2 ────────────────────────────────────────────────────────────

describe("v1.2 cases: a variant, and a conversation for an agent that sends its own", () => {
  const CONVERSATION = [
    { role: "user" as const, content: "Made-up: is a knee brace covered?" },
    { role: "assistant" as const, content: "Made-up: which payer?" },
    { role: "user" as const, content: "Made-up Payer A." },
  ];

  test("a variant is a variant name; messages are at most 50, each user or assistant text of at most 32 KB", () => {
    expect(caseProblems({ ...CASE, variant: "retry" })).toEqual([]);
    expect(caseProblems({ ...CASE, variant: "Retry!" })).toEqual([{ path: "variant", message: CASE_WORDS.variant }]);
    expect(caseProblems({ ...CASE, messages: CONVERSATION })).toEqual([]);
    expect(caseProblems({ ...CASE, messages: [] })).toEqual([{ path: "messages", message: CASE_WORDS.messagesEmpty }]);
    const many = Array.from({ length: MAX_MESSAGES + 1 }, () => CONVERSATION[0]!);
    expect(caseProblems({ ...CASE, messages: many })).toEqual([{ path: "messages", message: CASE_WORDS.tooManyMessages }]);
    expect(caseProblems({ ...CASE, messages: [{ role: "user", content: "x".repeat(32 * 1024 + 1) }] })).toEqual([
      { path: "messages.0.content", message: CASE_WORDS.messageSize },
    ]);
    expect(caseProblems({ ...CASE, messages: [{ role: "user", content: "  " }] })).toEqual([
      { path: "messages.0.content", message: CASE_WORDS.messageEmpty },
    ]);
    expect(caseProblems({ ...CASE, messages: [{ role: "system" as never, content: "x" }] })).toEqual([
      { path: "messages.0.role", message: CASE_WORDS.messageRole },
    ]);
  });

  test("a case is at most 64 KB as a whole, so a conversation fits", () => {
    expect(caseProblems({ ...CASE, messages: [{ role: "user", content: "x".repeat(32 * 1024) }] })).toEqual([]);
    const twice = [
      { role: "user" as const, content: "x".repeat(32 * 1024) },
      { role: "assistant" as const, content: "x".repeat(32 * 1024) },
    ];
    expect(caseProblems({ ...CASE, messages: twice })).toEqual([{ path: "case", message: CASE_WORDS.size }]);
  });

  test("it fits: a variant the code declares; messages exactly where the agent sends its own", () => {
    const variables = [{ name: "note", required: true }];
    const text = { variants: ["default", "retry"], input: "text" as const, providerTools: [] };
    expect(caseFitProblems("A", { ...CASE, variant: "retry" }, variables, ["web_search"], text)).toEqual([]);
    expect(caseFitProblems("A", { ...CASE, variant: "rubric" }, variables, ["web_search"], text)).toEqual([
      "A: uses the variant rubric, which the code does not declare.",
    ]);
    expect(caseFitProblems("A", { ...CASE, messages: CONVERSATION }, variables, ["web_search"], text)).toEqual([
      "A: has a conversation, but this agent sends one user turn from its template.",
    ]);
    const messages = { variants: ["default"], input: "messages" as const, providerTools: [] };
    expect(caseFitProblems("A", CASE, variables, ["web_search"], messages)).toEqual([
      "A: gives no conversation, and this agent sends its own.",
    ]);
    expect(caseFitProblems("A", { ...CASE, messages: CONVERSATION }, variables, ["web_search"], messages)).toEqual([]);
    // Without what the code declares, a case is v1.1's: the variant default only, no conversation.
    expect(caseFitProblems("A", { ...CASE, variant: "default" }, variables, ["web_search"])).toEqual([]);
    expect(caseFitProblems("A", { ...CASE, variant: "retry" }, variables, ["web_search"])).toEqual([
      "A: uses the variant retry, which the code does not declare.",
    ]);
  });

  test("a fixture for a tool built into the provider is refused: test runs skip it", () => {
    const fit = { variants: ["default"], input: "text" as const, providerTools: ["web_search"] };
    expect(caseFitProblems("A", CASE, [{ name: "note", required: true }], ["web_search"], fit)).toEqual([
      "A: has a fixture for a tool built into the provider, which test runs skip.",
    ]);
  });

  test("a job carries the variant and the conversation; a v1.1 case is carried exactly as before", () => {
    expect(jobCaseOf("k1", { ...CASE, variant: "retry", messages: CONVERSATION })).toMatchObject({
      id: "k1",
      variant: "retry",
      messages: CONVERSATION,
    });
    expect(Object.keys(jobCaseOf("k2", CASE))).toEqual(["id", "variables", "toolFixtures", "expect"]);
  });
});

describe("v1.2 results: tools skipped in a test run", () => {
  const job = {
    cases: new Map([["k1", 2]]),
    models: [{ provider: "vertex", model: "made-up-pro" }],
    tools: ["google_search", "lookup_codes"],
  };
  const body = (rows: unknown[]) => resultsBody.parse({ results: rows });

  test("skippedTools is optional: ids of tools, at most 40", () => {
    expect(resultsBody.safeParse({ results: [{ ...RESULT, skippedTools: ["google_search"] }] }).success).toBe(true);
    expect(resultsBody.safeParse({ results: [{ ...RESULT, skippedTools: ["Google Search"] }] }).success).toBe(false);
    const many = Array.from({ length: 41 }, (_, i) => `t${i}`);
    expect(resultsBody.safeParse({ results: [{ ...RESULT, skippedTools: many }] }).success).toBe(false);
  });

  test("each is a tool the job switched on, once", () => {
    expect(resultsProblems(body([{ ...RESULT, skippedTools: ["google_search"] }]), job)).toEqual([]);
    expect(resultsProblems(body([{ ...RESULT, skippedTools: ["made_up"] }]), job)).toEqual([
      { path: "results.0.skippedTools.0", message: "is not a tool this job switched on." },
    ]);
    expect(resultsProblems(body([{ ...RESULT, skippedTools: ["google_search", "google_search"] }]), job)).toEqual([
      { path: "results.0.skippedTools.1", message: "repeats an earlier tool." },
    ]);
  });

  test("a skipped tool does not fail a result", () => {
    const skipped = resultsBody.parse({ results: [{ ...RESULT, skippedTools: ["google_search"] }] }).results[0]!;
    expect(resultPassed(skipped, 2)).toBe(true);
  });
});
