import { describe, expect, test } from "vitest";
import { PLAN_KEYS, type PlanKey, type PlanRow, type PlanScenario } from "@convex/lib/planShape";
import {
  burnSentence,
  cashSentence,
  mrrPath,
  mrrSentence,
  planChart,
  planYears,
  readBurn,
  readCash,
  readMrr,
} from "./plan";

// A made-up plan, whole dollars: ARR ends 2025 at 120K in base and 2026 at 600K.
const VALUES: Record<number, Record<PlanScenario, Partial<Record<PlanKey, number>>>> = {
  2025: {
    bear: { arr: 96_000, net_burn: 900_000, cash_end: 1_000_000 },
    base: { arr: 120_000, net_burn: 1_000_000, cash_end: 1_000_000 },
    bull: { arr: 144_000, net_burn: 1_100_000, cash_end: 1_000_000 },
  },
  2026: {
    bear: { arr: 360_000, net_burn: 1_200_000, cash_end: 2_000_000 },
    base: { arr: 600_000, net_burn: 1_296_000, cash_end: 2_500_000, capital_raised: 4_000_000 },
    bull: { arr: 840_000, net_burn: 1_400_000, cash_end: 3_000_000 },
  },
};
const plan = (years: number[]): PlanRow[] =>
  years.flatMap((year) =>
    (["bear", "base", "bull"] as const).flatMap((scenario) =>
      PLAN_KEYS.map((key) => ({ scenario, year, key, value: VALUES[year]![scenario][key] ?? 0 })),
    ),
  );
const BOTH = plan([2025, 2026]);
const ONLY_2026 = plan([2026]);
const mrr = (pairs: [string, number][]) => pairs.map(([periodStart, value]) => ({ periodStart, value }));

describe("planYears", () => {
  test("the years the plan covers, oldest first", () => {
    expect(planYears(BOTH)).toEqual([2025, 2026]);
    expect(planYears([])).toEqual([]);
  });
});

describe("mrrPath: the plan's MRR month by month", () => {
  test("a straight line from last year-end's ARR to this year-end's, a twelfth of it", () => {
    const path = mrrPath(BOTH, "base", 2026)!;
    expect(path).toHaveLength(12);
    // 10K a month at the end of 2025, 50K at the end of 2026.
    expect(path[0]).toBeCloseTo(10_000 + 40_000 / 12);
    expect(path[8]).toBeCloseTo(10_000 + (40_000 * 9) / 12);
    expect(path[11]).toBe(50_000);
  });

  test("no line without the year before: it is never guessed", () => {
    expect(mrrPath(ONLY_2026, "base", 2026)).toBeNull();
    expect(mrrPath(BOTH, "base", 2027)).toBeNull();
  });
});

describe("readMrr: this year's latest MRR against the plan", () => {
  test("against the plan's line for that month", () => {
    // September: 10K + 40K × 9/12 = 40K planned; 35.2K actual is 12% under.
    const reading = readMrr(BOTH, 2026, mrr([["2026-08-01", 30_000], ["2026-09-01", 35_200]]));
    expect(reading).toEqual({ kind: "path", month: "2026-09-01", actual: 35_200, planned: 40_000, ratio: expect.closeTo(-0.12) });
    expect(mrrSentence(reading, 2026)).toBe("MRR for Sep is 12% under the base plan's $40K.");
  });

  test("over, and on, the plan", () => {
    expect(mrrSentence(readMrr(BOTH, 2026, mrr([["2026-09-01", 44_000]])), 2026)).toBe(
      "MRR for Sep is 10% over the base plan's $40K.",
    );
    expect(mrrSentence(readMrr(BOTH, 2026, mrr([["2026-09-01", 40_100]])), 2026)).toBe(
      "MRR for Sep is in line with the base plan's $40K.",
    );
  });

  test("with no line, against where the plan ends the year", () => {
    const reading = readMrr(ONLY_2026, 2026, mrr([["2026-09-01", 35_000]]));
    expect(reading).toEqual({ kind: "year_end", month: "2026-09-01", actual: 35_000, planned: 50_000 });
    expect(mrrSentence(reading, 2026)).toBe(
      "The base plan ends 2026 at $50K MRR; Sep's is 30% below that.",
    );
    expect(mrrSentence(readMrr(ONLY_2026, 2026, mrr([["2026-09-01", 52_000]])), 2026)).toBe(
      "The base plan ends 2026 at $50K MRR; Sep's is already above it.",
    );
  });

  test("no MRR this year, or no plan for the year: said, never compared with zero", () => {
    const none = readMrr(BOTH, 2026, mrr([["2025-12-01", 9_000]]));
    expect(none).toEqual({ kind: "none", reason: "no_mrr" });
    expect(mrrSentence(none, 2026)).toBe("No MRR figure for 2026 yet, so there is nothing to set against the plan.");
    expect(readMrr(BOTH, 2027, mrr([["2027-01-01", 1]]))).toEqual({ kind: "none", reason: "no_year" });
  });
});

describe("readBurn: today's average net burn against the plan's", () => {
  test("a twelfth of the year's planned net burn a month", () => {
    // 1,296,000 a year is 108K a month; 99.36K is 8% below.
    const reading = readBurn(BOTH, 2026, 99_360);
    expect(reading).toEqual({ kind: "compared", actual: 99_360, planned: 108_000, ratio: expect.closeTo(-0.08) });
    expect(burnSentence(reading, 2026)).toBe("Net burn is 8% below the base plan's $108K a month for 2026.");
    expect(burnSentence(readBurn(BOTH, 2026, 118_800), 2026)).toBe(
      "Net burn is 10% above the base plan's $108K a month for 2026.",
    );
  });

  test("not burning, or a plan that is not burning, in words", () => {
    expect(burnSentence(readBurn(BOTH, 2026, -500), 2026)).toBe(
      "Money in is above money out, where the base plan burns $108K a month in 2026.",
    );
    const surplus = BOTH.map((row) =>
      row.year === 2026 && row.scenario === "base" && row.key === "net_burn" ? { ...row, value: -120_000 } : row,
    );
    expect(burnSentence(readBurn(surplus, 2026, 5_000), 2026)).toBe(
      "The base plan has no net burn in 2026: it brings in $10K a month more than it spends.",
    );
  });

  test("no burn figure: not known, never set against the plan as zero", () => {
    expect(readBurn(BOTH, 2026, null)).toEqual({ kind: "none", reason: "no_burn" });
    expect(burnSentence(readBurn(BOTH, 2026, null), 2026)).toBe(
      "Net burn is not known yet, so it is not set against the plan.",
    );
    expect(readBurn(BOTH, 2030, 1)).toEqual({ kind: "none", reason: "no_year" });
  });
});

describe("readCash: where today's burn leaves cash at year-end, against the plan", () => {
  const projected = (dec: number) => ({
    kind: "projected" as const,
    currency: "USD" as const,
    months: [
      { month: "2026-11", cash: dec * 100 + 50_000_00 },
      { month: "2026-12", cash: dec * 100 },
    ],
    runOut: { kind: "beyond" as const },
  });

  test("December's month-end cash in the projection, beside the plan's, and what the plan raises", () => {
    const reading = readCash(BOTH, 2026, projected(350_000));
    expect(reading).toEqual({ kind: "compared", projected: 350_000, planned: 2_500_000, raised: 4_000_000 });
    expect(cashSentence(reading, 2026)).toBe(
      "At today's net burn, cash at the end of 2026 would be $350K, against $2.5M in the base plan, which raises $4M that year.",
    );
  });

  test("below zero is said as running out, not as a negative balance", () => {
    expect(cashSentence(readCash(BOTH, 2026, projected(-20_000)), 2026)).toBe(
      "At today's net burn, cash runs out before the end of 2026; the base plan ends the year with $2.5M.",
    );
  });

  test("no projection: not known", () => {
    const reading = readCash(BOTH, 2026, { kind: "unknown", reason: "no_burn" });
    expect(reading).toEqual({ kind: "none", reason: "no_projection" });
    expect(cashSentence(reading, 2026)).toBe(
      "Year-end cash at today's burn is not known yet, so it is not set against the plan.",
    );
  });
});

describe("planChart: MRR this year against the plan's range", () => {
  test("the actual months, the base line and the bear-to-bull band", () => {
    const chart = planChart(BOTH, 2026, mrr([["2025-12-01", 9_000], ["2026-01-01", 12_000], ["2026-02-01", 15_000], ["2026-03-01", 17_000]]));
    expect(chart.months).toHaveLength(12);
    expect(chart.months[0]).toBe("2026-01-01");
    expect(chart.actual.slice(0, 4)).toEqual([12_000, 15_000, 17_000, null]);
    expect(chart.base![11]).toBe(50_000);
    expect(chart.band![11]).toEqual({ low: 30_000, high: 70_000 });
    expect(chart.yearEnd).toEqual({ bear: 30_000, base: 50_000, bull: 70_000 });
    expect(chart.drawable).toBe(true);
  });

  test("with no line, the year-end range alone; fewer than three months is not a chart", () => {
    const chart = planChart(ONLY_2026, 2026, mrr([["2026-01-01", 12_000], ["2026-02-01", 15_000]]));
    expect(chart.base).toBeNull();
    expect(chart.band).toBeNull();
    expect(chart.yearEnd).toEqual({ bear: 30_000, base: 50_000, bull: 70_000 });
    expect(chart.drawable).toBe(false);
  });
});
