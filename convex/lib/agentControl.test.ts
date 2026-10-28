import { describe, expect, test } from "vitest";
import {
  addDays,
  changeStatus,
  choiceProblem,
  configBody,
  desiredProblem,
  failureOfStatus,
  modelsOf,
  monthStartOf,
  overviewOf,
  pushAnswerOf,
  seriesOf,
  settleAnswer,
  steeringEndpoint,
  steeringMissing,
  type Control,
  type UsageDay,
} from "./agentControl";

// Every agent, model and figure here is made up.
const TODAY = "2026-10-16";

const usage = (over: Partial<UsageDay>): UsageDay => ({
  agentId: "sample.select",
  promptVersion: "3",
  provider: "vertex",
  model: "made-up-pro",
  day: TODAY,
  calls: 10,
  errors: 0,
  schemaFailures: 0,
  fallbacks: 0,
  refusals: 0,
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.5,
  p50Ms: 1000,
  p95Ms: 2000,
  ...over,
});

const control = (over: Partial<Control> = {}): Control => ({
  agentId: "sample.select",
  enabled: true,
  provider: "vertex",
  model: "made-up-pro",
  fallbackProvider: null,
  fallbackModel: null,
  monthlyBudgetUsd: null,
  version: 1,
  ...over,
});

describe("days", () => {
  test("addDays and the month's first day, in UTC calendar days", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(monthStartOf("2026-10-16")).toBe("2026-10-01");
  });
});

describe("the overview", () => {
  test("seven days of calls, and rates over the calls that were made", () => {
    const [row] = overviewOf(
      [
        usage({ day: TODAY, calls: 30, errors: 3, schemaFailures: 1, fallbacks: 2 }),
        usage({ day: addDays(TODAY, -6), calls: 10, errors: 1 }),
        // Eight days ago: outside the seven.
        usage({ day: addDays(TODAY, -7), calls: 500, errors: 500 }),
      ],
      [],
      TODAY,
    );
    expect(row!.calls7d).toBe(40);
    expect(row!.errorRate7d).toBeCloseTo(4 / 40);
    expect(row!.schemaFailureRate7d).toBeCloseTo(1 / 40);
    expect(row!.fallbackRate7d).toBeCloseTo(2 / 40);
  });

  test("no calls in seven days: no count, and no rate, never a zero", () => {
    const [row] = overviewOf([usage({ day: addDays(TODAY, -10) })], [], TODAY);
    expect(row!.calls7d).toBeNull();
    expect(row!.errorRate7d).toBeNull();
    expect(row!.schemaFailureRate7d).toBeNull();
    expect(row!.p95Ms7d).toBeNull();
    expect(row!.lastSeenDay).toBe(addDays(TODAY, -10));
  });

  test("a day that reported zero calls is a zero, and gives no rate", () => {
    const [row] = overviewOf([usage({ calls: 0, costUsd: 0, p50Ms: null, p95Ms: null })], [], TODAY);
    expect(row!.calls7d).toBe(0);
    expect(row!.errorRate7d).toBeNull();
  });

  test("p95 is the worst day's, from the days that have one", () => {
    const [row] = overviewOf(
      [
        usage({ day: TODAY, p95Ms: 2000 }),
        usage({ day: addDays(TODAY, -1), p95Ms: 9800 }),
        usage({ day: addDays(TODAY, -2), p95Ms: null }),
      ],
      [],
      TODAY,
    );
    expect(row!.p95Ms7d).toBe(9800);
  });

  test("p95 with no day that has one is not known", () => {
    const [row] = overviewOf([usage({ p95Ms: null })], [], TODAY);
    expect(row!.p95Ms7d).toBeNull();
  });

  test("cost today and month to date, summed over what was reported", () => {
    const [row] = overviewOf(
      [
        usage({ day: TODAY, costUsd: 0.25 }),
        usage({ day: TODAY, model: "made-up-flash", costUsd: 0.05 }),
        usage({ day: "2026-10-01", costUsd: 1 }),
        // Last month: not this month's.
        usage({ day: "2026-09-30", costUsd: 100 }),
      ],
      [control({ monthlyBudgetUsd: 10 })],
      TODAY,
    );
    expect(row!.costToday).toEqual({ usd: 0.3, why: null });
    expect(row!.costMonth).toEqual({ usd: 1.3, why: null });
    expect(row!.budgetUsd).toBe(10);
    expect(row!.budgetShare).toBeCloseTo(0.13);
  });

  test("a row with no price makes the total unknown, never a smaller number", () => {
    const [row] = overviewOf(
      [usage({ costUsd: 0.25 }), usage({ provider: "astana_gpu", model: "made-up-open", costUsd: null })],
      [control({ monthlyBudgetUsd: 10 })],
      TODAY,
    );
    expect(row!.costToday).toEqual({ usd: null, why: "unpriced" });
    expect(row!.costMonth).toEqual({ usd: null, why: "unpriced" });
    expect(row!.budgetShare).toBeNull();
  });

  test("nothing reported today is not a zero cost", () => {
    const [row] = overviewOf([usage({ day: addDays(TODAY, -1) })], [], TODAY);
    expect(row!.costToday).toEqual({ usd: null, why: "nothing_reported" });
    expect(row!.costMonth).toEqual({ usd: 0.5, why: null });
  });

  test("an agent never steered shows the model it was seen on, the busiest on its newest day", () => {
    const [row] = overviewOf(
      [
        usage({ day: TODAY, provider: "vertex", model: "made-up-pro", calls: 3, promptVersion: "3" }),
        usage({ day: TODAY, provider: "ai_studio", model: "made-up-flash", calls: 9, promptVersion: "4" }),
        usage({ day: addDays(TODAY, -1), provider: "astana_gpu", model: "made-up-open", calls: 99 }),
      ],
      [],
      TODAY,
    );
    expect(row).toMatchObject({
      steered: false,
      enabled: null,
      primary: { provider: "ai_studio", model: "made-up-flash" },
      primaryObserved: true,
      fallback: null,
      promptVersion: "4",
      lastSeenDay: TODAY,
    });
  });

  test("a steered agent shows its desired state, including one with no usage yet", () => {
    const rows = overviewOf(
      [usage({})],
      [
        control({ fallbackProvider: "ai_studio", fallbackModel: "made-up-flash", enabled: false }),
        control({ agentId: "sample.extract", version: 4 }),
      ],
      TODAY,
    );
    expect(rows.map((row) => row.agentId)).toEqual(["sample.extract", "sample.select"]);
    expect(rows[1]).toMatchObject({
      steered: true,
      enabled: false,
      primary: { provider: "vertex", model: "made-up-pro" },
      primaryObserved: false,
      fallback: { provider: "ai_studio", model: "made-up-flash" },
    });
    expect(rows[0]).toMatchObject({ calls7d: null, lastSeenDay: null, promptVersion: null });
  });
});

describe("the series", () => {
  test("thirty days, a gap where nothing was reported, the day's figures summed over models", () => {
    const series = seriesOf(
      [
        usage({ day: TODAY, calls: 10, errors: 1, costUsd: 0.5, p95Ms: 2000 }),
        usage({ day: TODAY, model: "made-up-flash", calls: 10, errors: 0, costUsd: 0.1, p95Ms: 5000 }),
        usage({ day: addDays(TODAY, -2), calls: 4, schemaFailures: 2, costUsd: null }),
        usage({ agentId: "another.agent", day: TODAY, calls: 1000 }),
      ],
      "sample.select",
      TODAY,
    );
    expect(series).toHaveLength(30);
    expect(series[0]!.day).toBe(addDays(TODAY, -29));
    expect(series[29]).toEqual({
      day: TODAY,
      calls: 20,
      errorRate: 0.05,
      schemaFailureRate: 0,
      costUsd: 0.6,
      p95Ms: 5000,
    });
    expect(series[28]).toEqual({
      day: addDays(TODAY, -1),
      calls: null,
      errorRate: null,
      schemaFailureRate: null,
      costUsd: null,
      p95Ms: null,
    });
    expect(series[27]).toMatchObject({ calls: 4, schemaFailureRate: 0.5, costUsd: null });
  });
});

describe("models compared", () => {
  test("each provider and model the agent ran on in thirty days", () => {
    const models = modelsOf(
      [
        usage({ day: TODAY, calls: 10, errors: 1, costUsd: 0.5, p95Ms: 2000 }),
        usage({ day: addDays(TODAY, -1), calls: 30, errors: 0, costUsd: 1.5, p95Ms: 3000 }),
        usage({ provider: "astana_gpu", model: "made-up-open", calls: 5, costUsd: null, p95Ms: 7000 }),
        usage({ day: addDays(TODAY, -40), provider: "ai_studio", model: "made-up-flash" }),
      ],
      "sample.select",
      TODAY,
    );
    expect(models).toEqual([
      {
        provider: "vertex",
        model: "made-up-pro",
        days: 2,
        calls: 40,
        errorRate: 1 / 40,
        schemaFailureRate: 0,
        p95Ms: 3000,
        costUsd: 2,
        costPerCallUsd: 0.05,
      },
      {
        provider: "astana_gpu",
        model: "made-up-open",
        days: 1,
        calls: 5,
        errorRate: 0,
        schemaFailureRate: 0,
        p95Ms: 7000,
        costUsd: null,
        costPerCallUsd: null,
      },
    ]);
  });
});

describe("a change's state", () => {
  test("applied once the applied version reaches it; failed while a failed push stands; else pending", () => {
    expect(changeStatus({ version: 3, push: "queued" }, null)).toBe("pending");
    expect(changeStatus({ version: 3, push: "sent" }, 2)).toBe("pending");
    expect(changeStatus({ version: 3, push: "sent" }, 3)).toBe("applied");
    // A later version applied carries this one with it.
    expect(changeStatus({ version: 3, push: "failed" }, 5)).toBe("applied");
    expect(changeStatus({ version: 3, push: "failed" }, 2)).toBe("failed");
    expect(changeStatus({ version: 3, push: "not_connected" }, null)).toBe("failed");
  });
});

describe("Vertical Startup's answers", () => {
  test("each refusal it can give is a key of its own, never its words", () => {
    expect([400, 401, 413, 502, 503, 500, 404, 0].map(failureOfStatus)).toEqual([
      "rejected",
      "unauthorized",
      "too_large",
      "storage_failed",
      "not_set_up_there",
      "refused",
      "refused",
      "refused",
    ]);
  });

  test("a 2xx answer: the version it holds, and whether ours was stale", () => {
    expect(pushAnswerOf({ appliedVersion: 7 })).toEqual({ appliedVersion: 7, stale: false });
    expect(pushAnswerOf({ appliedVersion: 9, stale: true })).toEqual({ appliedVersion: 9, stale: true });
    for (const bad of [null, "7", {}, { appliedVersion: -1 }, { appliedVersion: 1.5 }, { appliedVersion: "7" }]) {
      expect(pushAnswerOf(bad)).toBeNull();
    }
  });

  test("stale and ahead of ours is not applied; stale at ours is a repeat of one applied", () => {
    expect(settleAnswer({ appliedVersion: 7, stale: false }, 7)).toEqual({ outcome: "sent", appliedVersion: 7 });
    expect(settleAnswer({ appliedVersion: 7, stale: true }, 7)).toEqual({ outcome: "sent", appliedVersion: 7 });
    expect(settleAnswer({ appliedVersion: 9, stale: true }, 7)).toEqual({
      outcome: "failed",
      failure: "stale",
      remoteVersion: 9,
    });
  });

  test("a stale change stays failed whatever version is reported applied, until it is sent again", () => {
    expect(changeStatus({ version: 3, push: "failed", failure: "stale" }, 9)).toBe("failed");
  });
});

describe("what a model may be changed to", () => {
  const up = [
    { provider: "vertex", model: "made-up-pro", state: "up" as const },
    { provider: "ai_studio", model: "made-up-flash", state: "up" as const },
    { provider: "astana_gpu", model: "made-up-open", state: "down" as const },
    { provider: "other_cloud", model: "made-up-x", state: "up" as const },
  ];
  test("a pair seen up", () => {
    expect(choiceProblem({ provider: "ai_studio", model: "made-up-flash" }, up, null)).toBeNull();
  });
  test("the agent's current pair, even when it is not up", () => {
    const current = { provider: "astana_gpu", model: "made-up-open" };
    expect(choiceProblem(current, up, current)).toBeNull();
  });
  test("a pair that is down, never seen, or on a provider the OS does not know", () => {
    expect(choiceProblem({ provider: "astana_gpu", model: "made-up-open" }, up, null)).toBe(
      "Choose a model that is up.",
    );
    expect(choiceProblem({ provider: "vertex", model: "made-up-unseen" }, up, null)).toBe(
      "Choose a model that is up.",
    );
    expect(choiceProblem({ provider: "other_cloud", model: "made-up-x" }, up, null)).toBe(
      "Choose a model that is up.",
    );
  });
});

describe("a desired state", () => {
  test("a fallback is both halves or neither, and not the model itself", () => {
    expect(desiredProblem(control())).toBeNull();
    expect(desiredProblem(control({ fallbackProvider: "vertex", fallbackModel: null }))).toBe(
      "A fallback needs a provider and a model.",
    );
    expect(
      desiredProblem(control({ fallbackProvider: "vertex", fallbackModel: "made-up-pro" })),
    ).toBe("The fallback must differ from the model.");
  });
  test("a budget is above zero and within the limit", () => {
    expect(desiredProblem(control({ monthlyBudgetUsd: 0 }))).toBe(
      "A monthly budget is more than $0 and at most $1,000,000.",
    );
    expect(desiredProblem(control({ monthlyBudgetUsd: Number.NaN }))).toBe(
      "A monthly budget is more than $0 and at most $1,000,000.",
    );
    expect(desiredProblem(control({ monthlyBudgetUsd: 50 }))).toBeNull();
  });
});

describe("the config sent to Vertical Startup", () => {
  test("every steered agent in id order, with optional fields only where set", () => {
    expect(
      configBody(7, [
        control({ agentId: "sample.select", fallbackProvider: "ai_studio", fallbackModel: "made-up-flash", monthlyBudgetUsd: 40 }),
        control({ agentId: "sample.extract", enabled: false }),
      ]),
    ).toEqual({
      version: 7,
      agents: [
        { agentId: "sample.extract", enabled: false, provider: "vertex", model: "made-up-pro" },
        {
          agentId: "sample.select",
          enabled: true,
          provider: "vertex",
          model: "made-up-pro",
          fallbackProvider: "ai_studio",
          fallbackModel: "made-up-flash",
          monthlyBudgetUsd: 40,
        },
      ],
    });
  });
});

describe("where steering is sent", () => {
  test("an https origin and nothing else", () => {
    expect(steeringEndpoint("https://vertical.example.com")).toBe(
      "https://vertical.example.com/api/admin/agent-config",
    );
    expect(steeringEndpoint("https://vertical.example.com/")).toBe(
      "https://vertical.example.com/api/admin/agent-config",
    );
    for (const bad of [
      undefined,
      "",
      "http://vertical.example.com",
      "https://user:pw@vertical.example.com",
      "https://vertical.example.com/other",
      "https://vertical.example.com?x=1",
      "https://vertical.example.com:8443",
      "not a url",
    ]) {
      expect(steeringEndpoint(bad)).toBeNull();
    }
  });

  test("what is missing is named, never shown", () => {
    const secret = "s".repeat(32);
    expect(steeringMissing({})).toEqual(["VERTICAL_STARTUP_URL", "VERTICAL_AGENT_CONFIG_SECRET"]);
    expect(steeringMissing({ VERTICAL_STARTUP_URL: "https://vertical.example.com", VERTICAL_AGENT_CONFIG_SECRET: "short" })).toEqual([
      "VERTICAL_AGENT_CONFIG_SECRET",
    ]);
    expect(
      steeringMissing({ VERTICAL_STARTUP_URL: "https://vertical.example.com", VERTICAL_AGENT_CONFIG_SECRET: secret }),
    ).toEqual([]);
  });
});
