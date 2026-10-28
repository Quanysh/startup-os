import { describe, expect, test } from "vitest";
import { PROJECTION_MONTHS, averageSpend, monthlyDelta, project, projectBudget, type Change } from "./runway";

// Every figure here is made up. Money is whole minor units (cents, tiyn).

const change = (extra: Partial<Change> & Pick<Change, "kind" | "amount">): Change => ({
  label: "Made-up change",
  startMonth: "2026-11",
  endMonth: null,
  currency: "USD",
  ...extra,
});

const base = {
  startMonth: "2026-10",
  currency: "USD" as const,
  cash: 100_000_00,
  netBurn: 30_000_00,
  changes: [] as Change[],
  fxUsdKzt: null,
};

describe("the baseline", () => {
  test("cash falls by the burn each month, and runs out in the first month it ends below zero", () => {
    const result = project(base);
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months).toHaveLength(PROJECTION_MONTHS);
    expect(result.months.slice(0, 4)).toEqual([
      { month: "2026-10", cash: 70_000_00 },
      { month: "2026-11", cash: 40_000_00 },
      { month: "2026-12", cash: 10_000_00 },
      { month: "2027-01", cash: -20_000_00 },
    ]);
    // Cash 100,000 over a burn of 30,000 is 3.3 months: gone during the fourth.
    expect(result.runOut).toEqual({ kind: "month", month: "2027-01" });
  });

  test("a month that ends at exactly zero has not run out", () => {
    const result = project({ ...base, cash: 90_000_00 });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months[2]).toEqual({ month: "2026-12", cash: 0 });
    expect(result.runOut).toEqual({ kind: "month", month: "2027-01" });
  });

  test("cash that lasts the 24 months is beyond them, never a month", () => {
    const result = project({ ...base, netBurn: 1_000_00 });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months.at(-1)).toEqual({ month: "2028-09", cash: 76_000_00 });
    expect(result.runOut).toEqual({ kind: "beyond" });
  });

  test("a company that is not burning grows its cash and does not run out", () => {
    const result = project({ ...base, netBurn: -5_000_00 });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months[0]!.cash).toBe(105_000_00);
    expect(result.runOut).toEqual({ kind: "beyond" });
  });
});

describe("what is not known is never zero", () => {
  test("no cash: not known", () => {
    expect(project({ ...base, cash: null })).toEqual({ kind: "unknown", reason: "no_cash" });
  });

  test("no burn: not known", () => {
    expect(project({ ...base, netBurn: null })).toEqual({ kind: "unknown", reason: "no_burn" });
  });

  test("neither: the cash is said first", () => {
    expect(project({ ...base, cash: null, netBurn: null })).toEqual({
      kind: "unknown",
      reason: "no_cash",
    });
  });

  test("a change in the other currency with no rate on record: not known, not converted at a guess", () => {
    const changes = [change({ kind: "cost", amount: 100_000_00, currency: "KZT" })];
    expect(project({ ...base, changes })).toEqual({ kind: "unknown", reason: "no_rate" });
  });
});

describe("changes", () => {
  test("a hire costs its monthly total from its first month, and brings the run-out month forward", () => {
    // Two made-up engineers at a total cost (salary plus the company's taxes) of 6,500 each.
    const changes = [change({ kind: "hire", label: "Two engineers", amount: 13_000_00 })];
    const result = project({ ...base, changes });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months.slice(0, 3).map((m) => m.cash)).toEqual([70_000_00, 27_000_00, -16_000_00]);
    expect(result.runOut).toEqual({ kind: "month", month: "2026-12" });
  });

  test("a change stops after its last month", () => {
    const changes = [change({ kind: "cost", amount: 10_000_00, startMonth: "2026-10", endMonth: "2026-11" })];
    const result = project({ ...base, netBurn: 0, changes });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months.slice(0, 4).map((m) => m.cash)).toEqual([
      90_000_00, 80_000_00, 80_000_00, 80_000_00,
    ]);
  });

  test("a change that starts before the projection counts from its first month in view", () => {
    const changes = [change({ kind: "revenue", amount: 5_000_00, startMonth: "2026-01" })];
    const result = project({ ...base, netBurn: 0, changes });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months[0]!.cash).toBe(105_000_00);
  });

  test("a negative cost is a saving, and a negative revenue a loss", () => {
    expect(monthlyDelta(change({ kind: "cost", amount: -2_000_00 }), "2026-11")).toBe(2_000_00);
    expect(monthlyDelta(change({ kind: "revenue", amount: -3_000_00 }), "2026-11")).toBe(-3_000_00);
  });

  test("a raise is cash in once, in its month, and pushes the run-out month back", () => {
    const changes = [change({ kind: "cash_in", label: "Made-up seed round", amount: 500_000_00, startMonth: "2026-12" })];
    const result = project({ ...base, changes });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months.slice(0, 4).map((m) => m.cash)).toEqual([
      70_000_00, 40_000_00, 510_000_00, 480_000_00,
    ]);
    // 510,000 at the end of December, less 30,000 a month: below zero during 2028-06.
    expect(result.runOut).toEqual({ kind: "month", month: "2028-06" });
  });

  test("a one-off counts in its own month only, and its end month is not read", () => {
    const out = change({ kind: "cash_out", amount: 1_000_00, startMonth: "2026-11", endMonth: "2027-05" });
    expect(monthlyDelta(out, "2026-11")).toBe(-1_000_00);
    expect(monthlyDelta(out, "2026-12")).toBe(0);
  });

  test("a change in the other currency is converted at the stored rate", () => {
    // A Globex projection in tenge, with a made-up USD subscription and 500 tenge to the dollar.
    const changes = [change({ kind: "cost", amount: 100_00, currency: "USD", startMonth: "2026-10" })];
    const result = project({
      ...base,
      currency: "KZT",
      cash: 10_000_000_00,
      netBurn: 0,
      changes,
      fxUsdKzt: 500,
    });
    if (result.kind !== "projected") throw new Error(result.kind);
    expect(result.months[0]!.cash).toBe(10_000_000_00 - 50_000_00);
  });

  test("a change in the projection's own currency needs no rate", () => {
    const changes = [change({ kind: "cost", amount: 1_00 })];
    expect(project({ ...base, changes }).kind).toBe("projected");
  });
});

describe("on budget: the budget spent month by month, with money in as it has been", () => {
  // Made-up: 100,000 cash; an average net burn of 30,000 from an average
  // spend of 40,000, so 10,000 a month came in.
  const input = {
    startMonth: "2026-10",
    currency: "USD" as const,
    cash: 100_000_00,
    netBurn: 30_000_00,
    spend: 40_000_00,
    budget: [50_000_00, 50_000_00, 20_000_00],
  };

  test("each month's budget less the money in, from today's cash", () => {
    const result = projectBudget(input);
    expect(result).toEqual({
      kind: "projected",
      currency: "USD",
      months: [
        { month: "2026-10", cash: 60_000_00 },
        { month: "2026-11", cash: 20_000_00 },
        { month: "2026-12", cash: 10_000_00 },
      ],
      runOut: { kind: "beyond" },
    });
  });

  test("runs out in the first month that ends below zero; past the budget's months it says nothing", () => {
    const result = projectBudget({ ...input, budget: [50_000_00, 50_000_00, 50_000_00] });
    expect(result.kind === "projected" && result.runOut).toEqual({ kind: "month", month: "2026-12" });
    expect(result.kind === "projected" && result.months).toHaveLength(3);
  });

  test("anything it rests on that is not known: not known, never a zero", () => {
    expect(projectBudget({ ...input, cash: null })).toEqual({ kind: "unknown", reason: "no_cash" });
    expect(projectBudget({ ...input, netBurn: null })).toEqual({ kind: "unknown", reason: "no_burn" });
    expect(projectBudget({ ...input, spend: null })).toEqual({ kind: "unknown", reason: "no_spend" });
    expect(projectBudget({ ...input, budget: [50_000_00, null, 1] })).toEqual({ kind: "unknown", reason: "no_budget" });
    expect(projectBudget({ ...input, budget: [] })).toEqual({ kind: "unknown", reason: "no_budget" });
  });
});

describe("average spend over the months the average net burn is of", () => {
  const actuals = new Map([
    ["2026-08", 40_000_00],
    ["2026-09", 50_000_00],
  ]);

  test("the mean of the actual spend in those months", () => {
    expect(averageSpend(["2026-08-01", "2026-09-01"], actuals)).toBe(45_000_00);
  });

  test("a month with no actual spend makes it not known; so do no months", () => {
    expect(averageSpend(["2026-07-01", "2026-08-01"], actuals)).toBeNull();
    expect(averageSpend([], actuals)).toBeNull();
  });
});
