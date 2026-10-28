import { describe, expect, test } from "vitest";
import type { CostLine } from "./costs";
import {
  BUDGET_CATEGORIES,
  budgetMonths,
  budgetTotal,
  cashDueLive,
  categoryVsRunRate,
  effectiveBudget,
  effectiveCell,
  planVsActual,
  runwayInputs,
  mercuryActuals,
  startupActuals,
  runRateByCategory,
  variance,
  type BudgetCategory,
  type Live,
} from "./budget";

// Every figure here is made up. Money is whole minor units.

describe("the budget's rows and months", () => {
  test("the Costs categories, then Payroll", () => {
    expect(BUDGET_CATEGORIES.at(-1)).toBe("payroll");
    expect(BUDGET_CATEGORIES).toContain("cloud");
  });

  test("twelve months from the one given, across a year end", () => {
    const months = budgetMonths("2026-10");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-10");
    expect(months[3]).toBe("2027-01");
  });
});

const known = (amount: number): Live => ({ kind: "known", amount });

describe("a cell: what was typed, else what the register says", () => {
  test("a typed figure overrides the register's, which is kept to go back to", () => {
    expect(effectiveCell(500, known(400))).toEqual({ kind: "override", amount: 500, live: known(400) });
    // A typed zero is a figure, not "nothing typed".
    expect(effectiveCell(0, known(400))).toEqual({ kind: "override", amount: 0, live: known(400) });
  });

  test("nothing typed: the register's figure, a known zero included", () => {
    expect(effectiveCell(null, known(400))).toEqual({ kind: "live", amount: 400 });
    expect(effectiveCell(undefined, known(0))).toEqual({ kind: "live", amount: 0 });
  });

  test("a register figure that is not known stays not known, never a zero", () => {
    expect(effectiveCell(null, { kind: "unknown", reason: "rates" })).toEqual({ kind: "unknown", reason: "rates" });
    expect(effectiveCell(null, { kind: "loading" })).toEqual({ kind: "loading" });
  });

  test("a row the caller may not see is hidden, whatever was typed in it", () => {
    expect(effectiveCell(null, { kind: "hidden" })).toEqual({ kind: "hidden" });
    expect(effectiveCell(500, { kind: "hidden" })).toEqual({ kind: "hidden" });
  });

  test("a register figure withheld here (never given to a token) leaves a typed figure standing", () => {
    expect(effectiveCell(500, { kind: "withheld" })).toEqual({
      kind: "override",
      amount: 500,
      live: { kind: "withheld" },
    });
    expect(effectiveCell(null, { kind: "withheld" })).toEqual({ kind: "hidden" });
  });
});

describe("the cost register's cash due, by category, as the budget's figure", () => {
  const line = (extra: Partial<CostLine>): CostLine => ({
    category: "cloud",
    amount: 100_00,
    currency: "USD",
    cadence: "monthly",
    startsOn: "2026-01",
    endsOn: null,
    variable: false,
    archivedAt: null,
    ...extra,
  });

  test("what falls due in the month: a yearly bill whole in its month, nothing in the others", () => {
    const lines = [line({}), line({ category: "software", cadence: "yearly", amount: 1_200_00, startsOn: "2026-03" })];
    const march = cashDueLive(lines, "2027-03", "USD", null);
    expect(march.cloud).toEqual(known(100_00));
    expect(march.software).toEqual(known(1_200_00));
    expect(cashDueLive(lines, "2027-04", "USD", null).software).toEqual(known(0));
    // A category with no line is a known zero: the register holds nothing for it.
    expect(march.office).toEqual(known(0));
  });

  test("a line in the other currency is converted at the stored rate", () => {
    const lines = [line({}), line({ currency: "KZT", amount: 50_000_00 })];
    expect(cashDueLive(lines, "2026-10", "USD", 500).cloud).toEqual(known(100_00 + 100_00));
  });

  test("with no rate, only the category that needs one is not known", () => {
    const lines = [line({ currency: "KZT", amount: 50_000_00 }), line({ category: "office" })];
    const got = cashDueLive(lines, "2026-10", "USD", null);
    expect(got.cloud).toEqual({ kind: "unknown", reason: "no_rate" });
    expect(got.office).toEqual(known(100_00));
  });

  test("an archived line, or one not yet started, falls due in no month", () => {
    const lines = [line({ archivedAt: 1 }), line({ category: "office", startsOn: "2027-01" })];
    const got = cashDueLive(lines, "2026-10", "USD", null);
    expect(got.cloud).toEqual(known(0));
    expect(got.office).toEqual(known(0));
  });
});

describe("the budget as the caller sees it, and a month's total", () => {
  const months = ["2026-10", "2026-11"];
  const live = (category: BudgetCategory, month: string): Live =>
    category === "payroll" ? known(month === "2026-10" ? 1_000 : 1_100) : category === "cloud" ? known(100) : known(0);

  test("every month and category: typed cells over the registers' figures", () => {
    const cells = effectiveBudget(months, [{ month: "2026-11", category: "cloud", amount: 150 }], live);
    expect(cells).toHaveLength(months.length * BUDGET_CATEGORIES.length);
    const at = (category: BudgetCategory, month: string) =>
      cells.find((c) => c.category === category && c.month === month)!.cell;
    expect(at("cloud", "2026-10")).toEqual({ kind: "live", amount: 100 });
    expect(at("cloud", "2026-11")).toEqual({ kind: "override", amount: 150, live: known(100) });
    expect(at("payroll", "2026-11")).toEqual({ kind: "live", amount: 1_100 });
  });

  test("the total adds what was typed and what the registers say", () => {
    const cells = effectiveBudget(months, [{ month: "2026-11", category: "cloud", amount: 150 }], live);
    expect(budgetTotal(cells.filter((c) => c.month === "2026-10"))).toEqual({
      kind: "known",
      amount: 1_100,
      excludes: [],
    });
    expect(budgetTotal(cells.filter((c) => c.month === "2026-11"))).toEqual({
      kind: "known",
      amount: 1_250,
      excludes: [],
    });
  });

  test("a hidden row is left out and named; a part that is not known makes the total not known", () => {
    const noPay = (category: BudgetCategory, month: string): Live =>
      category === "payroll" ? { kind: "hidden" } : live(category, month);
    expect(budgetTotal(effectiveBudget(["2026-10"], [], noPay))).toEqual({
      kind: "known",
      amount: 100,
      excludes: ["payroll"],
    });

    const unset = (category: BudgetCategory, month: string): Live =>
      category === "payroll" ? { kind: "unknown", reason: "rates" } : live(category, month);
    expect(budgetTotal(effectiveBudget(["2026-10"], [], unset))).toEqual({ kind: "unknown", excludes: [] });
    // Typing the figure the register cannot give makes the total known again.
    expect(
      budgetTotal(effectiveBudget(["2026-10"], [{ month: "2026-10", category: "payroll", amount: 900 }], unset)),
    ).toEqual({ kind: "known", amount: 1_000, excludes: [] });
  });

  test("with every row hidden there is no total to give", () => {
    const none = (): Live => ({ kind: "hidden" });
    expect(budgetTotal(effectiveBudget(["2026-10"], [], none))).toEqual({
      kind: "hidden",
      excludes: ["payroll", "costs"],
    });
  });

  test("while a register loads, so does the total", () => {
    const waiting = (category: BudgetCategory, month: string): Live =>
      category === "cloud" ? { kind: "loading" } : live(category, month);
    expect(budgetTotal(effectiveBudget(["2026-10"], [], waiting))).toEqual({ kind: "loading" });
  });
});

describe("variance", () => {
  test("over plan is actual above plan, with the share", () => {
    expect(variance(1_000_00, 1_200_00)).toEqual({ kind: "over", diff: 200_00, share: 0.2 });
  });

  test("under plan", () => {
    expect(variance(1_000_00, 900_00)).toEqual({ kind: "under", diff: -100_00, share: -0.1 });
  });

  test("on plan", () => {
    expect(variance(500, 500)).toEqual({ kind: "on", diff: 0, share: 0 });
  });

  test("a missing plan or actual is not known, never a zero", () => {
    expect(variance(null, 100)).toEqual({ kind: "unknown", reason: "no_plan" });
    expect(variance(100, null)).toEqual({ kind: "unknown", reason: "no_actual" });
  });

  test("a plan of zero has no share", () => {
    expect(variance(0, 100)).toEqual({ kind: "over", diff: 100, share: null });
  });
});

describe("Startup's actual: Mercury's money out", () => {
  const out = [
    { periodStart: "2026-07-01", value: 41_000.5 },
    { periodStart: "2026-08-01", value: 39_000 },
    { periodStart: "2026-09-01", value: 40_000 },
    { periodStart: "2026-10-01", value: 9_000 },
  ];
  const readAt = Date.parse("2026-10-02T06:00:00Z");

  test("months Mercury read whole, in cents", () => {
    const actuals = mercuryActuals(out, "2026-10", readAt);
    expect(actuals.get("2026-07")).toBe(41_000_50);
    expect(actuals.get("2026-09")).toBe(40_000_00);
  });

  test("the month in progress is not an actual", () => {
    expect(mercuryActuals(out, "2026-10", readAt).has("2026-10")).toBe(false);
  });

  test("a month last read before it ended is not an actual", () => {
    const early = Date.parse("2026-09-20T06:00:00Z");
    expect(mercuryActuals(out, "2026-10", early).has("2026-09")).toBe(false);
    expect(mercuryActuals(out, "2026-10", null).size).toBe(0);
  });
});

describe("Startup's actual: its own spending, Mercury's money out less what it sent Globex", () => {
  const out = [
    { periodStart: "2026-07-01", value: 41_000.5 },
    { periodStart: "2026-08-01", value: 39_000 },
    { periodStart: "2026-09-01", value: 40_000 },
    { periodStart: "2026-10-01", value: 9_000 },
  ];
  // Startup funded Globex in July; nothing is on record for August (read
  // before what was sent was counted); nothing was sent in September.
  const sent = [
    { periodStart: "2026-07-01", value: 30_000.25 },
    { periodStart: "2026-09-01", value: 0 },
    { periodStart: "2026-10-01", value: 5_000 },
  ];
  const readAt = Date.parse("2026-10-02T06:00:00Z");

  test("money out less what was sent, in cents: the funding is Globex's money, and in its actual", () => {
    const actuals = startupActuals(out, sent, "2026-10", readAt);
    expect(actuals.get("2026-07")).toBe(11_000_25);
    expect(actuals.get("2026-09")).toBe(40_000_00);
  });

  test("a month with money out and no figure of what was sent is not known, never the whole money out", () => {
    expect(startupActuals(out, sent, "2026-10", readAt).has("2026-08")).toBe(false);
  });

  test("the month in progress, and a month read before it ended, are not actuals", () => {
    expect(startupActuals(out, sent, "2026-10", readAt).has("2026-10")).toBe(false);
    const early = Date.parse("2026-09-20T06:00:00Z");
    expect(startupActuals(out, sent, "2026-10", early).has("2026-09")).toBe(false);
    expect(startupActuals(out, sent, "2026-10", null).size).toBe(0);
  });
});

describe("the cost register's run-rate by category, in the company's currency", () => {
  const usd = { currency: "USD" as const, byCategory: [{ category: "cloud" as const, runRate: 100_00 }] };
  const kzt = {
    currency: "KZT" as const,
    byCategory: [
      { category: "cloud" as const, runRate: 50_000_00 },
      { category: "office" as const, runRate: 200_000_00 },
    ],
  };

  test("one currency: its own figures", () => {
    expect(runRateByCategory([usd], "USD", null)).toEqual({ cloud: 100_00 });
  });

  test("the other currency is converted at the stored rate", () => {
    expect(runRateByCategory([kzt, usd], "KZT", 500)).toEqual({
      cloud: 50_000_00 + 50_000_00,
      office: 200_000_00,
    });
  });

  test("with no rate, a category that needs one is not known; the others still are", () => {
    expect(runRateByCategory([kzt, usd], "KZT", null)).toEqual({ cloud: null, office: 200_000_00 });
  });
});

describe("plan against actual, month by month", () => {
  const typed = (cells: { month: string; category: BudgetCategory; amount: number }[]) =>
    effectiveBudget(["2026-08", "2026-09", "2026-10"], cells, () => known(0));

  test("budget totals, actual where known, and the variance", () => {
    const rows = planVsActual(
      ["2026-08", "2026-09", "2026-10"],
      typed([
        { month: "2026-08", category: "cloud", amount: 100 },
        { month: "2026-08", category: "office", amount: 50 },
        { month: "2026-09", category: "cloud", amount: 100 },
      ]),
      new Map([
        ["2026-08", 180],
        ["2026-10", 10],
      ]),
    );
    expect(rows).toEqual([
      { month: "2026-08", plan: 150, actual: 180, excludes: [], variance: { kind: "over", diff: 30, share: 0.2 } },
      { month: "2026-09", plan: 100, actual: null, excludes: [], variance: { kind: "unknown", reason: "no_actual" } },
      // The registers say nothing falls due: a budget of zero, compared.
      { month: "2026-10", plan: 0, actual: 10, excludes: [], variance: { kind: "over", diff: 10, share: null } },
    ]);
  });

  test("a budget that leaves a register out is not set against everything spent", () => {
    const cells = effectiveBudget(["2026-09"], [], (category) =>
      category === "payroll" ? { kind: "hidden" } : known(100),
    );
    const [row] = planVsActual(["2026-09"], cells, new Map([["2026-09", 5_000]]));
    expect(row).toEqual({
      month: "2026-09",
      plan: 800,
      actual: 5_000,
      excludes: ["payroll"],
      variance: { kind: "unknown", reason: "left_out" },
    });
  });

  test("a budget left out whole (neither register is the caller's) is not compared either", () => {
    const cells = effectiveBudget(["2026-09"], [], () => ({ kind: "hidden" }));
    const [row] = planVsActual(["2026-09"], cells, new Map([["2026-09", 5_000]]));
    expect(row).toMatchObject({
      plan: null,
      excludes: ["payroll", "costs"],
      variance: { kind: "unknown", reason: "left_out" },
    });
  });

  test("a budget that is not known has no variance", () => {
    const cells = effectiveBudget(["2026-09"], [], () => ({ kind: "unknown", reason: "no_rate" }));
    const [row] = planVsActual(["2026-09"], cells, new Map([["2026-09", 5_000]]));
    expect(row).toMatchObject({ plan: null, variance: { kind: "unknown", reason: "no_plan" } });
  });
});

describe("a category's budget against the cost register's run-rate", () => {
  test("each Costs category with either, run-rate above budget is over, and never Payroll", () => {
    const cells = effectiveBudget(
      ["2026-10", "2026-11"],
      [
        { month: "2026-10", category: "cloud", amount: 100 },
        { month: "2026-10", category: "payroll", amount: 999 },
        { month: "2026-11", category: "office", amount: 5 },
      ],
      (category) => (category === "software" ? { kind: "unknown", reason: "no_rate" } : known(0)),
    );
    const rows = categoryVsRunRate("2026-10", cells, { cloud: 120, software: null });
    expect(rows).toEqual([
      { category: "cloud", plan: 100, runRate: 120, variance: { kind: "over", diff: 20, share: 0.2 } },
      { category: "software", plan: null, runRate: null, variance: { kind: "unknown", reason: "no_plan" } },
    ]);
  });
});

describe("what a runway projection starts from: the Finance page's figures", () => {
  const summary = (extra: object) =>
    ({ cash: null, average: null, ...extra }) as unknown as Parameters<typeof runwayInputs>[0];

  test("Startup: dollars as the page has them, in cents", () => {
    const got = runwayInputs(
      summary({ cash: { usd: 1000.5, parts: [], missing: [], rate: null }, average: { value: 250 } }),
      "us",
    );
    expect(got).toEqual({ currency: "USD", cash: 1000_50, netBurn: 250_00 });
  });

  test("a partial cash figure is not known", () => {
    const got = runwayInputs(summary({ cash: { usd: 1, parts: [], missing: ["us"], rate: null } }), "us");
    expect(got).toEqual({ currency: "USD", cash: null, netBurn: null });
  });

  test("Globex: its tenge balance, and the dollar burn back in tenge at the page's rate", () => {
    const got = runwayInputs(
      summary({
        cash: {
          usd: 2000,
          parts: [{ scope: "kz", native: 1_000_000, usd: 2000, periodStart: "2026-09-30" }],
          missing: [],
          rate: 500,
        },
        average: { value: 100 },
      }),
      "kz",
    );
    expect(got).toEqual({ currency: "KZT", cash: 1_000_000_00, netBurn: 50_000_00 });
  });

  test("Globex with no rate: neither is known", () => {
    const got = runwayInputs(
      summary({ cash: { usd: 0, parts: [], missing: ["fx"], rate: null }, average: null }),
      "kz",
    );
    expect(got).toEqual({ currency: "KZT", cash: null, netBurn: null });
  });
});
