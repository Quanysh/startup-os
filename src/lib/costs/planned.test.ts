import { describe, expect, test } from "vitest";
import { summarise, type CostLine } from "@convex/lib/costs";
import type { CurrencySummary, SummaryTotals } from "@convex/lib/payroll";
import { compare, payOf, plannedBurn, type Pay } from "./planned";

// Every amount here is made up.

const line = (extra: Partial<CostLine> = {}): CostLine => ({
  category: "cloud",
  amount: 1_000_00,
  currency: "USD",
  cadence: "monthly",
  startsOn: "2026-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
  ...extra,
});
const costs = (lines: CostLine[], companyCurrency: "USD" | "KZT" = "USD", fxUsdKzt: number | null = null) =>
  summarise({ lines, month: "2026-10", companyCurrency, fxUsdKzt });

const totals = (people: number, cost: number, known = people): SummaryTotals => ({
  people,
  net: { sum: cost, known: people },
  gross: { sum: cost, known },
  withheld: { sum: 0, known },
  companyPaid: { sum: 0, known },
  cost: { sum: cost, known },
});
const set = (currency: "USD" | "KZT", overall: SummaryTotals) =>
  ({ currency, overall }) as unknown as CurrencySummary;

describe("what pay comes to, from payroll's own summary", () => {
  test("whole for everyone: the total cost, per currency", () => {
    expect(payOf([set("USD", totals(3, 9_000_00)), set("KZT", totals(0, 0))])).toEqual({
      kind: "known",
      parts: [{ currency: "USD", cost: 9_000_00 }],
    });
  });

  test("nobody on payroll is a known nothing", () => {
    expect(payOf([set("USD", totals(0, 0))])).toEqual({ kind: "known", parts: [] });
  });

  test("a cost not known for everyone is not known, never the part that is", () => {
    expect(payOf([set("USD", totals(3, 6_000_00, 2))])).toEqual({ kind: "unknown", reason: "rates" });
    expect(payOf([set("USD", totals(3, 9_000_00)), set("KZT", totals(1, 0, 0))])).toEqual({
      kind: "unknown",
      reason: "rates",
    });
  });

  test("lines in a circle: not known", () => {
    expect(payOf(null)).toEqual({ kind: "unknown", reason: "circle" });
  });
});

describe("planned burn", () => {
  const known = (currency: "USD" | "KZT", cost: number): Pay => ({ kind: "known", parts: [{ currency, cost }] });

  test("costs plus pay, in the one currency", () => {
    const planned = plannedBurn({ costs: costs([line()]), pay: known("USD", 9_000_00), fxRate: null });
    expect(planned).toMatchObject({
      includesPay: true,
      payOut: null,
      total: { kind: "amount", currency: "USD", minor: 10_000_00 },
      costs: { kind: "amount", currency: "USD", minor: 1_000_00 },
      pay: { kind: "amount", currency: "USD", minor: 9_000_00 },
    });
  });

  test.each([
    [{ kind: "no_access" }, "no_access"],
    [{ kind: "unknown", reason: "rates" }, "rates"],
    [{ kind: "unknown", reason: "circle" }, "circle"],
    [{ kind: "loading" }, "loading"],
  ] as [Pay, string][])("pay %j is left out, and the figure is costs alone", (pay, payOut) => {
    const planned = plannedBurn({ costs: costs([line()]), pay, fxRate: null });
    expect(planned).toMatchObject({
      includesPay: false,
      payOut,
      total: { kind: "amount", currency: "USD", minor: 1_000_00 },
      pay: null,
    });
  });

  test("nobody on payroll: pay is in it, as nothing", () => {
    const planned = plannedBurn({ costs: costs([line()]), pay: { kind: "known", parts: [] }, fxRate: null });
    expect(planned).toMatchObject({
      includesPay: true,
      total: { kind: "amount", currency: "USD", minor: 1_000_00 },
      pay: { kind: "amount", currency: "USD", minor: 0 },
    });
  });

  test("costs in one currency and pay in another, with a rate: US dollars at that rate", () => {
    const planned = plannedBurn({
      costs: costs([line()], "KZT"),
      pay: known("KZT", 2_000_000_00),
      fxRate: 500,
    });
    expect(planned.total).toEqual({ kind: "amount", currency: "USD", minor: 1_000_00 + 4_000_00, rate: 500 });
    expect(planned.pay).toEqual({ kind: "amount", currency: "KZT", minor: 2_000_000_00 });
  });

  test("two currencies and no rate: the total is not known, and each part still stands", () => {
    const planned = plannedBurn({
      costs: costs([line()], "KZT"),
      pay: known("KZT", 2_000_000_00),
      fxRate: null,
    });
    expect(planned.total).toEqual({ kind: "unknown" });
    expect(planned.includesPay).toBe(true);
    expect(planned.parts).toEqual([
      { currency: "USD", costs: 1_000_00, pay: 0 },
      { currency: "KZT", costs: 0, pay: 2_000_000_00 },
    ]);
  });

  test("tenge costs and tenge pay stay in tenge, whatever the rate", () => {
    const planned = plannedBurn({
      costs: costs([line({ currency: "KZT", amount: 500_000_00 })], "KZT"),
      pay: known("KZT", 2_000_000_00),
      fxRate: 500,
    });
    expect(planned.total).toEqual({ kind: "amount", currency: "KZT", minor: 2_500_000_00 });
  });

  test("costs whose own total is not known stay not known when pay is left out", () => {
    const mixed = costs([line(), line({ currency: "KZT", amount: 500_000_00 })], "KZT");
    const planned = plannedBurn({ costs: mixed, pay: { kind: "no_access" }, fxRate: null });
    expect(planned.total).toEqual({ kind: "unknown" });
    expect(planned.costs).toEqual({ kind: "unknown" });
  });
});

describe("planned against actual", () => {
  const withPay = plannedBurn({
    costs: costs([line()]),
    pay: { kind: "known", parts: [{ currency: "USD", cost: 9_000_00 }] },
    fxRate: null,
  });

  test("both known: the difference is planned less actual, in US dollars", () => {
    expect(compare(withPay, 8_500.5, null)).toEqual({
      kind: "compared",
      plannedUsd: 10_000_00,
      actualUsd: 8_500_50,
      difference: 1_499_50,
    });
  });

  test("a tenge plan is compared at the stored rate, and not at all without one", () => {
    const kz = plannedBurn({
      costs: costs([line({ currency: "KZT", amount: 500_000_00 })], "KZT"),
      pay: { kind: "known", parts: [] },
      fxRate: 500,
    });
    expect(compare(kz, 900, 500)).toMatchObject({ kind: "compared", plannedUsd: 1_000_00, difference: 100_00 });
    expect(compare(kz, 900, null)).toEqual({ kind: "not_compared", reason: "no_rate" });
  });

  test("no actual burn on record: not compared, never against zero", () => {
    expect(compare(withPay, null, null)).toEqual({ kind: "not_compared", reason: "no_actual" });
  });

  test("pay left out: not compared, since the plan is short of what is spent", () => {
    const short = plannedBurn({ costs: costs([line()]), pay: { kind: "no_access" }, fxRate: null });
    expect(compare(short, 8_000, null)).toEqual({ kind: "not_compared", reason: "pay_out" });
  });

  test("a plan that is not known is not compared", () => {
    const unknown = plannedBurn({
      costs: costs([line()], "KZT"),
      pay: { kind: "known", parts: [{ currency: "KZT", cost: 5_00 }] },
      fxRate: null,
    });
    expect(compare(unknown, 8_000, null)).toEqual({ kind: "not_compared", reason: "planned_unknown" });
  });
});
