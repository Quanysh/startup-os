import { describe, expect, test } from "vitest";
import { AGENTS_ALONE, AGENTS_EMPTY, agentPushProblems, projectPushProblems, projectUsageBody } from "./agentShape";
import { isAgentsEnvelope, parseIngestEnvelope } from "./ingestSchema";

// Every agent, model and figure here is made up.
const NOW = Date.parse("2026-10-16T12:00:00Z");

const usage = {
  product: "vertical_startup" as const,
  agentId: "note-coding.select",
  promptVersion: "3",
  provider: "ai_studio",
  model: "gemini-2.5-pro",
  day: "2026-10-16",
  calls: 12,
  errors: 0,
  schemaFailures: 0,
  fallbacks: 0,
  refusals: 0,
  inputTokens: 34000,
  outputTokens: 5200,
  costUsd: 0.12,
  p50Ms: 4100,
  p95Ms: 9800,
};
const provider = {
  provider: "astana_gpu",
  model: "made-up-open-72b",
  state: "up" as const,
  checkedAt: "2026-10-16T11:58:00Z",
  lastErrorClass: null,
};
const envelope = {
  version: 1,
  source: "vertical_agents",
  batchId: "vertical-agents-2026-10-16",
  observedAt: "2026-10-16T12:00:00Z",
  agentUsage: [usage],
  providers: [provider],
  agentConfigApplied: { version: 7, appliedAt: "2026-10-16T11:00:00Z" },
};

const parse = (raw: unknown) => parseIngestEnvelope(raw);
const issuesOf = (raw: unknown) => {
  const result = parse(raw);
  return result.ok ? [] : result.issues;
};
const paths = (raw: unknown) => issuesOf(raw).map((issue) => issue.path);

describe("an agents push", () => {
  test("the contract's envelope parses as an agents push", () => {
    const result = parse(envelope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(isAgentsEnvelope(result.envelope)).toBe(true);
  });

  test("any one of the three keys alone", () => {
    const { agentUsage, providers, agentConfigApplied, ...header } = envelope;
    expect(parse({ ...header, agentUsage }).ok).toBe(true);
    expect(parse({ ...header, providers }).ok).toBe(true);
    expect(parse({ ...header, agentConfigApplied }).ok).toBe(true);
  });

  test("an empty list beside something is fine; nothing at all is refused", () => {
    const { agentUsage: _u, providers: _p, agentConfigApplied: _a, ...header } = envelope;
    expect(parse({ ...header, agentUsage: [], providers: [provider] }).ok).toBe(true);
    expect(issuesOf({ ...header, agentUsage: [], providers: [] })).toEqual([
      { path: "envelope", message: AGENTS_EMPTY },
    ]);
  });

  test.each(["snapshots", "deals", "customers", "records", "plan", "mode", "kind"])(
    "%s may not travel with it",
    (field) => {
      const extra = {
        snapshots: [{ key: "searches", scope: "startup_insights", period: "week", periodStart: "2026-10-05", value: 1 }],
        deals: [],
        customers: [],
        records: [],
        plan: { modelVersion: "a1b2c3d", rows: [{ scenario: "base", year: 2027, key: "arr", value: 1 }] },
        mode: "upsert",
        kind: "sequence",
      }[field];
      expect(issuesOf({ ...envelope, [field]: extra })).toContainEqual({ path: field, message: AGENTS_ALONE });
    },
  );

  test("an unknown field is refused, wherever it is: no free text can ride along", () => {
    expect(paths({ ...envelope, agentUsage: [{ ...usage, patientName: "x" }] })).toEqual(["agentUsage.0"]);
    expect(paths({ ...envelope, providers: [{ ...provider, message: "x" }] })).toEqual(["providers.0"]);
    expect(paths({ ...envelope, agentConfigApplied: { version: 1, appliedAt: envelope.observedAt, by: "x" } })).toEqual([
      "agentConfigApplied",
    ]);
    expect(paths({ ...envelope, notes: "x" })).toEqual(["envelope"]);
  });

  test.each([
    ["agentId", "Note Coding"],
    ["agentId", "a".repeat(65)],
    ["agentId", "../etc"],
    ["product", "startup_insights"],
    ["provider", "AI Studio"],
    ["model", "gemini 2.5"],
    ["promptVersion", ""],
    ["day", "2026-02-30"],
    ["day", "16/10/2026"],
    ["calls", -1],
    ["calls", 1.5],
    ["calls", 10_000_001],
    ["inputTokens", -5],
    ["costUsd", -0.01],
    ["costUsd", 100_001],
    ["p95Ms", 3_600_001],
  ])("%s %j is refused", (field, value) => {
    expect(paths({ ...envelope, agentUsage: [{ ...usage, [field]: value }] })).toContain(`agentUsage.0.${field}`);
  });

  test("a count above the day's calls, and p50 above p95, are refused", () => {
    expect(paths({ ...envelope, agentUsage: [{ ...usage, errors: 13 }] })).toEqual(["agentUsage.0.errors"]);
    expect(paths({ ...envelope, agentUsage: [{ ...usage, p50Ms: 9900 }] })).toEqual(["agentUsage.0.p50Ms"]);
  });

  test("cost and timings may be null or left out: not known, never zero", () => {
    const { costUsd: _c, p50Ms: _5, p95Ms: _9, ...bare } = usage;
    expect(parse({ ...envelope, agentUsage: [bare] }).ok).toBe(true);
    expect(parse({ ...envelope, agentUsage: [{ ...usage, costUsd: null, p50Ms: null, p95Ms: null }] }).ok).toBe(true);
  });

  test("an unknown provider that is slug-shaped is taken; its state and error class are enums", () => {
    expect(parse({ ...envelope, agentUsage: [{ ...usage, provider: "other_cloud" }] }).ok).toBe(true);
    expect(paths({ ...envelope, providers: [{ ...provider, state: "flaky" }] })).toEqual(["providers.0.state"]);
    expect(paths({ ...envelope, providers: [{ ...provider, lastErrorClass: "oops" }] })).toEqual([
      "providers.0.lastErrorClass",
    ]);
    for (const lastErrorClass of ["timeout", "auth", "rate_limit", "server", "network", "schema", null]) {
      expect(parse({ ...envelope, providers: [{ ...provider, lastErrorClass }] }).ok).toBe(true);
    }
  });

  test("as Vertical Startup builds them: a prompt version with a hash, dotted agent ids, nothing applied yet", () => {
    for (const promptVersion of ["v1+2e092415", "3", "2026-10-01.b"]) {
      expect(parse({ ...envelope, agentUsage: [{ ...usage, promptVersion }] }).ok).toBe(true);
    }
    expect(paths({ ...envelope, agentUsage: [{ ...usage, promptVersion: "v1 2e09" }] })).toEqual([
      "agentUsage.0.promptVersion",
    ]);
    expect(paths({ ...envelope, agentUsage: [{ ...usage, promptVersion: "v".repeat(41) }] })).toEqual([
      "agentUsage.0.promptVersion",
    ]);
    for (const agentId of ["note-coding.verify", "icd.select", "draft.appeal_letter", "cdi.draft", "wc.rfa"]) {
      expect(parse({ ...envelope, agentUsage: [{ ...usage, agentId }] }).ok).toBe(true);
    }
    expect(parse({ ...envelope, agentConfigApplied: { version: 0, appliedAt: null } }).ok).toBe(true);
    expect(agentPushProblems({ agentConfigApplied: { version: 0, appliedAt: null } }, NOW)).toEqual([]);
  });

  test("a version is a whole number", () => {
    expect(paths({ ...envelope, agentConfigApplied: { version: 1.5, appliedAt: envelope.observedAt } })).toEqual([
      "agentConfigApplied.version",
    ]);
  });
});

describe("what needs the time the push arrived", () => {
  test("a day ahead of every time zone, or very old, is refused; tomorrow in Almaty is not", () => {
    expect(agentPushProblems({ agentUsage: [{ ...usage, day: "2026-10-17" }] }, NOW)).toEqual([]);
    expect(agentPushProblems({ agentUsage: [{ ...usage, day: "2026-10-18" }] }, NOW)).toEqual([
      { path: "agentUsage.0.day", message: "is in the future." },
    ]);
    expect(agentPushProblems({ agentUsage: [{ ...usage, day: "2025-01-01" }] }, NOW)).toEqual([
      { path: "agentUsage.0.day", message: "is more than 400 days old." },
    ]);
  });

  test("the same agent, prompt, provider, model and day twice is refused", () => {
    expect(agentPushProblems({ agentUsage: [usage, { ...usage, calls: 1 }] }, NOW)).toEqual([
      { path: "agentUsage.1", message: "repeats an earlier row's agent, prompt, provider, model and day." },
    ]);
    expect(agentPushProblems({ agentUsage: [usage, { ...usage, promptVersion: "4" }] }, NOW)).toEqual([]);
  });

  test("a provider checked, or a config applied, in the future is refused; a pair twice too", () => {
    expect(
      agentPushProblems(
        {
          providers: [{ ...provider, checkedAt: "2026-10-16T13:00:00Z" }, provider],
          agentConfigApplied: { version: 1, appliedAt: "2026-10-17T00:00:00Z" },
        },
        NOW,
      ),
    ).toEqual([
      { path: "providers.0.checkedAt", message: "is in the future." },
      { path: "providers.1", message: "repeats an earlier row's provider and model." },
      { path: "agentConfigApplied.appliedAt", message: "is in the future." },
    ]);
  });
});

describe("a Protocol v1 usage report", () => {
  const { product: _product, ...row } = usage;
  const body = {
    batchId: "made-up-project-2026-10-16",
    observedAt: "2026-10-16T12:00:00Z",
    agentUsage: [row],
    providers: [provider],
    agentsKnown: [{ agentId: "note-coding.select", name: "Note coding, select", phi: true, kind: "code" as const }],
    configApplied: { version: 3, appliedAt: "2026-10-16T11:00:00Z" },
  };

  test("the contract's body parses and has no problem", () => {
    const parsed = projectUsageBody.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(projectPushProblems(parsed.data!, NOW)).toEqual([]);
  });

  test("a row naming a product or a project is refused: the token says which project it is", () => {
    expect(projectUsageBody.safeParse({ ...body, agentUsage: [usage] }).success).toBe(false);
    expect(projectUsageBody.safeParse({ ...body, agentUsage: [{ ...row, project: "other" }] }).success).toBe(false);
    expect(projectUsageBody.safeParse({ ...body, project: "other" }).success).toBe(false);
  });

  test("every key is required; a list may be empty", () => {
    for (const key of Object.keys(body)) {
      const rest: Record<string, unknown> = { ...body };
      delete rest[key];
      expect([key, projectUsageBody.safeParse(rest).success]).toEqual([key, false]);
    }
    expect(projectUsageBody.safeParse({ ...body, agentUsage: [], providers: [], agentsKnown: [] }).success).toBe(true);
  });

  test("an agent's name is short and charset-limited; its kind is code or declarative", () => {
    const known = body.agentsKnown[0]!;
    for (const bad of [
      { ...known, name: "<script>" },
      { ...known, name: "x".repeat(61) },
      { ...known, name: "line\nbreak" },
      { ...known, kind: "other" },
      { ...known, phi: "yes" },
      { ...known, extra: 1 },
    ]) {
      expect(projectUsageBody.safeParse({ ...body, agentsKnown: [bad] }).success).toBe(false);
    }
  });

  test("an agent known twice, a report from the future and a row twice are problems, by path", () => {
    const parsed = projectUsageBody.parse({
      ...body,
      observedAt: "2026-10-16T13:00:00Z",
      agentUsage: [row, row],
      agentsKnown: [body.agentsKnown[0], body.agentsKnown[0]],
    });
    expect(projectPushProblems(parsed, NOW).map((issue) => issue.path)).toEqual([
      "agentUsage.1",
      "observedAt",
      "agentsKnown.1",
    ]);
  });
});
