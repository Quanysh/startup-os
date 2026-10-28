import { describe, expect, test } from "vitest";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { burnBefore, cashBefore, closeOf, runwayBefore, trendOf } from "./trend";

const day = (periodStart: string, value: number) => ({ periodStart, value });

describe("trendOf: a figure against the same figure a month before", () => {
  test("the change as a share of the figure before, and how far it moved", () => {
    expect(trendOf(110, 100, "2026-09-01")).toEqual({
      kind: "change",
      diff: 10,
      ratio: 0.1,
      versus: "2026-09-01",
    });
    expect(trendOf(90, 100, "2026-09-01")).toMatchObject({ kind: "change", diff: -10, ratio: -0.1 });
  });

  test("no figure now or before is not a trend, never a change from zero", () => {
    expect(trendOf(null, 100, "2026-09-01")).toEqual({ kind: "unknown" });
    expect(trendOf(100, null, "2026-09-01")).toEqual({ kind: "unknown" });
    expect(trendOf(Number.NaN, 100, "2026-09-01")).toEqual({ kind: "unknown" });
  });

  test("from zero there is a difference but no percentage", () => {
    expect(trendOf(5, 0, "2026-09-01")).toEqual({
      kind: "change",
      diff: 5,
      ratio: null,
      versus: "2026-09-01",
    });
  });
});

describe("closeOf: a month's closing balance from daily balances", () => {
  test("the balance nearest the month's last day closes it", () => {
    const daily = [day("2026-09-12", 300), day("2026-09-30", 410), day("2026-10-14", 500)];
    expect(closeOf(daily, "2026-09-01")).toBe(410);
  });

  test("a month with no balance near its end has no close: not the latest, not zero", () => {
    expect(closeOf([day("2026-09-12", 300), day("2026-10-14", 500)], "2026-09-01")).toBeNull();
    expect(closeOf([], "2026-09-01")).toBeNull();
  });
});

const summary = (patch: Partial<FinanceSummary>): FinanceSummary => ({
  currentMonth: "2026-10-01",
  markets: ["us"],
  burn: [],
  coverage: { us: true, kz: false },
  average: null,
  cash: null,
  mrr: null,
  runway: null,
  burnMultiple: null,
  lateCloses: [],
  financingProblems: [],
  kzClosedMonths: [],
  unfinishedUsMonths: [],
  usFlowsReadAt: null,
  funding: null,
  ...patch,
});
const burnPoint = (periodStart: string, value: number) => ({
  periodStart,
  value,
  complete: true,
  missing: [],
  rate: null,
  ratePeriodStart: null,
  parts: { us: value, kz: null },
});

describe("burnBefore: the average net burn as it stood a month ago", () => {
  test("the three months before last month, by the same rule as today's", () => {
    const s = summary({
      average: { value: 20, months: [], expected: [] },
      burn: [
        burnPoint("2026-06-01", 30),
        burnPoint("2026-07-01", 20),
        burnPoint("2026-08-01", 10),
        burnPoint("2026-09-01", 50),
      ],
    });
    // Jun, Jul, Aug: before September was in.
    expect(burnBefore(s)).toBe(20);
  });

  test("withheld today means withheld then: no average now, no trend", () => {
    const s = summary({ average: null, burn: [burnPoint("2026-08-01", 10)] });
    expect(burnBefore(s)).toBeNull();
  });

  test("no complete month among those three: not known", () => {
    const s = summary({ average: { value: 5, months: [], expected: [] }, burn: [burnPoint("2026-09-01", 5)] });
    expect(burnBefore(s)).toBeNull();
  });
});

describe("cashBefore: cash at the month-end before today's balance, in the hero's terms", () => {
  const US_PART = { scope: "us" as const, native: 500, usd: 500, periodStart: "2026-10-14" };
  const KZ_PART = { scope: "kz" as const, native: 4_950, usd: 11, periodStart: "2026-09-30" };

  test("Mercury's daily balance: the US close of last month, in dollars", () => {
    const s = summary({
      cash: { usd: 500, parts: [US_PART], missing: [], rate: null, ratePeriodStart: null },
    });
    expect(cashBefore(s, { us: [day("2026-09-30", 410), day("2026-10-14", 500)], kz: [] })).toEqual({
      usd: 410,
      native: 410,
      month: "2026-09-01",
    });
  });

  test("a typed month-end is set against the month-end before it, never against itself", () => {
    const s = summary({
      markets: ["kz"],
      cash: { usd: 11, parts: [KZ_PART], missing: [], rate: 450, ratePeriodStart: "2026-09-01" },
    });
    const kz = [day("2026-08-31", 4_500), day("2026-09-30", 4_950)];
    // Tenge, and dollars at today's rate, so the rate itself is no trend.
    expect(cashBefore(s, { us: [], kz })).toEqual({ usd: 10, native: 4_500, month: "2026-08-01" });
    // Typed on the 1st, it still closes September.
    const first = { ...KZ_PART, periodStart: "2026-10-01" };
    const late = summary({
      markets: ["kz"],
      cash: { usd: 11, parts: [first], missing: [], rate: 450, ratePeriodStart: "2026-09-01" },
    });
    expect(cashBefore(late, { us: [], kz: [day("2026-08-31", 4_500), day("2026-10-01", 4_950)] })).toEqual({
      usd: 10,
      native: 4_500,
      month: "2026-08-01",
    });
  });

  test("no month-end before it: not known, never the latest balance or zero", () => {
    const s = summary({
      cash: { usd: 500, parts: [US_PART], missing: [], rate: null, ratePeriodStart: null },
    });
    expect(cashBefore(s, { us: [day("2026-10-14", 500)], kz: [] })).toBeNull();
    expect(cashBefore(s, { us: [day("2026-09-12", 300), day("2026-10-14", 500)], kz: [] })).toBeNull();
  });

  test("both markets need both closes: one is never the total; their months may differ", () => {
    const s = summary({
      markets: ["us", "kz"],
      cash: { usd: 511, parts: [US_PART, KZ_PART], missing: [], rate: 450, ratePeriodStart: "2026-09-01" },
    });
    expect(cashBefore(s, { us: [day("2026-09-30", 400)], kz: [] })).toBeNull();
    expect(
      cashBefore(s, { us: [day("2026-09-30", 400)], kz: [day("2026-08-31", 4_500), day("2026-09-30", 4_950)] }),
    ).toEqual({ usd: 410, native: null, month: null });
  });

  test("no cash today, or a partial total today: no comparison", () => {
    expect(cashBefore(summary({ cash: null }), { us: [day("2026-09-30", 1)], kz: [] })).toBeNull();
    const partial = summary({
      cash: { usd: 5, parts: [US_PART], missing: ["kz"], rate: null, ratePeriodStart: null },
    });
    expect(cashBefore(partial, { us: [day("2026-09-30", 1)], kz: [] })).toBeNull();
  });
});

describe("runwayBefore: cash then over burn then", () => {
  test("months, from the two figures a month ago", () => {
    expect(runwayBefore(400, 20)).toBe(20);
  });
  test("not burning then, or not known: no runway to compare", () => {
    expect(runwayBefore(400, 0)).toBeNull();
    expect(runwayBefore(400, -3)).toBeNull();
    expect(runwayBefore(null, 20)).toBeNull();
    expect(runwayBefore(400, null)).toBeNull();
  });
});
