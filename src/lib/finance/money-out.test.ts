import { describe, expect, test } from "vitest";
import type { CostSummary } from "@convex/lib/costs";
import type { CurrencyTotals } from "@convex/lib/payroll";
import {
  MIN_CHART_MONTHS,
  costsShare,
  groupMoneyOut,
  payrollShare,
  remainderOf,
  sentShare,
  shownMonths,
  type CostsShare,
  type MoneyOutRow,
  type PayrollShare,
  type SentShare,
} from "./money-out";

// Amounts are minor units (cents, tiyn) of the company's own currency.
const totals = (currency: "USD" | "KZT", cost: number, notComputed = 0): CurrencyTotals => {
  const t = { people: 2, gross: 0, adjustment: 0, withheld: 0, net: 0, companyPaid: 0, cost, notComputed };
  return { currency, byKind: { employee: t, contractor: t }, overall: t };
};

describe("payrollShare: what pay cost the company in a month", () => {
  test("a paid month is its frozen total cost", () => {
    expect(
      payrollShare({ paid: [totals("USD", 2_400_000)], live: { kind: "known", parts: [] }, currency: "USD", fx: null }),
    ).toEqual({ kind: "known", amount: 2_400_000, basis: "paid" });
  });

  test("a month not paid is what the Payroll page works out for it", () => {
    expect(
      payrollShare({
        paid: null,
        live: { kind: "known", parts: [{ currency: "USD", cost: 1_900_000 }] },
        currency: "USD",
        fx: null,
      }),
    ).toEqual({ kind: "known", amount: 1_900_000, basis: "live" });
  });

  test("nobody on payroll is a known nothing", () => {
    expect(payrollShare({ paid: null, live: { kind: "known", parts: [] }, currency: "KZT", fx: null })).toEqual({
      kind: "known",
      amount: 0,
      basis: "live",
    });
  });

  test("another currency is converted at the rate on record, and is not known without one", () => {
    const live = {
      kind: "known" as const,
      parts: [
        { currency: "KZT" as const, cost: 450_000_00 },
        { currency: "USD" as const, cost: 1_000_00 },
      ],
    };
    expect(payrollShare({ paid: null, live, currency: "KZT", fx: 450 })).toEqual({
      kind: "known",
      amount: 450_000_00 + 450_000_00,
      basis: "live",
    });
    expect(payrollShare({ paid: null, live, currency: "KZT", fx: null })).toEqual({
      kind: "unknown",
      reason: "no_rate",
    });
    expect(
      payrollShare({ paid: [totals("KZT", 900_000_00), totals("USD", 1_000_00)], live, currency: "KZT", fx: null }),
    ).toEqual({ kind: "unknown", reason: "no_rate" });
  });

  test("a viewer without Payroll is told nothing of it, whatever was passed", () => {
    expect(
      payrollShare({ paid: [totals("USD", 5)], live: { kind: "no_access" }, currency: "USD", fx: null }),
    ).toEqual({ kind: "hidden" });
  });

  test("rates not set, or lines in a circle, are not known: never the part that is", () => {
    expect(
      payrollShare({ paid: null, live: { kind: "unknown", reason: "rates" }, currency: "USD", fx: null }),
    ).toEqual({ kind: "unknown", reason: "rates" });
    expect(
      payrollShare({ paid: null, live: { kind: "unknown", reason: "circle" }, currency: "USD", fx: null }),
    ).toEqual({ kind: "unknown", reason: "circle" });
    // A paid month always has every amount; one that does not is not trusted either.
    expect(
      payrollShare({ paid: [totals("USD", 100, 1)], live: { kind: "known", parts: [] }, currency: "USD", fx: null }),
    ).toEqual({ kind: "unknown", reason: "rates" });
  });

  test("still loading is loading", () => {
    expect(payrollShare({ paid: null, live: { kind: "loading" }, currency: "USD", fx: null })).toEqual({
      kind: "loading",
    });
  });
});

const figures = (currency: "USD" | "KZT", byCategory: { category: "cloud" | "software" | "office"; cashDue: number }[]) => ({
  currency,
  runRate: 0,
  cashDue: byCategory.reduce((sum, row) => sum + row.cashDue, 0),
  next3: 0,
  yearly: 0,
  byCategory: byCategory.map((row) => ({ ...row, runRate: 0 })),
  cashByMonth: [],
});
const summary = (currencies: ReturnType<typeof figures>[]): CostSummary => ({
  month: "2026-09",
  months: [],
  lines: 3,
  estimates: 0,
  currencies,
  combined: { kind: "unknown" },
});

describe("costsShare: what the cost register says fell due in a month", () => {
  test("cash due by category, the largest first", () => {
    expect(
      costsShare(
        summary([figures("USD", [{ category: "software", cashDue: 900_00 }, { category: "cloud", cashDue: 2_300_00 }])]),
        "USD",
        null,
      ),
    ).toEqual({
      kind: "known",
      amount: 3_200_00,
      byCategory: [
        { category: "cloud", amount: 2_300_00 },
        { category: "software", amount: 900_00 },
      ],
    });
  });

  test("a category in two currencies is one figure in the company's own, at the rate", () => {
    expect(
      costsShare(
        summary([
          figures("KZT", [{ category: "cloud", cashDue: 450_000_00 }]),
          figures("USD", [{ category: "cloud", cashDue: 100_00 }, { category: "software", cashDue: 20_00 }]),
        ]),
        "KZT",
        450,
      ),
    ).toEqual({
      kind: "known",
      amount: 450_000_00 + 45_000_00 + 9_000_00,
      byCategory: [
        { category: "cloud", amount: 495_000_00 },
        { category: "software", amount: 9_000_00 },
      ],
    });
  });

  test("another currency with no rate is not known: never the part in the company's own", () => {
    expect(
      costsShare(summary([figures("USD", [{ category: "cloud", cashDue: 1 }]), figures("KZT", [{ category: "cloud", cashDue: 1 }])]), "USD", null),
    ).toEqual({ kind: "unknown", reason: "no_rate" });
  });

  test("nothing due is a known nothing; hidden and loading pass through", () => {
    expect(costsShare(summary([figures("USD", [])]), "USD", null)).toEqual({
      kind: "known",
      amount: 0,
      byCategory: [],
    });
    expect(costsShare("hidden", "USD", null)).toEqual({ kind: "hidden" });
    expect(costsShare("loading", "USD", null)).toEqual({ kind: "loading" });
  });
});

const PAY: PayrollShare = { kind: "known", amount: 24_000_00, basis: "paid" };
const COSTS: CostsShare = { kind: "known", amount: 6_000_00, byCategory: [] };

describe("remainderOf: money out that is in neither register", () => {
  test("money out, less pay, less what the cost register had fall due", () => {
    // $40,000 out; $24,000 pay; $6,000 of registered costs: $10,000 is in neither.
    expect(remainderOf(40_000_00, PAY, COSTS)).toEqual({ kind: "known", amount: 10_000_00, share: 0.25 });
  });

  test("the registers holding more than went out is said as that, never a negative slice", () => {
    expect(remainderOf(28_000_00, PAY, COSTS)).toEqual({ kind: "over", amount: 2_000_00 });
  });

  test("exactly accounted for is a known nothing", () => {
    expect(remainderOf(30_000_00, PAY, COSTS)).toEqual({ kind: "known", amount: 0, share: 0 });
  });

  test("a hidden register is said first: no remainder is worked out around it", () => {
    expect(remainderOf(40_000_00, { kind: "hidden" }, COSTS)).toEqual({ kind: "unknown", reason: "payroll_hidden" });
    expect(remainderOf(40_000_00, PAY, { kind: "hidden" })).toEqual({ kind: "unknown", reason: "costs_hidden" });
    expect(remainderOf(null, { kind: "hidden" }, { kind: "hidden" })).toEqual({ kind: "unknown", reason: "payroll_hidden" });
  });

  test("still loading, no money out, or a register not known: not known, never zero", () => {
    expect(remainderOf(40_000_00, { kind: "loading" }, COSTS)).toEqual({ kind: "unknown", reason: "loading" });
    expect(remainderOf(null, PAY, COSTS)).toEqual({ kind: "unknown", reason: "no_actual" });
    expect(remainderOf(40_000_00, { kind: "unknown", reason: "rates" }, COSTS)).toEqual({
      kind: "unknown",
      reason: "payroll_unknown",
    });
    expect(remainderOf(40_000_00, PAY, { kind: "unknown", reason: "no_rate" })).toEqual({
      kind: "unknown",
      reason: "costs_unknown",
    });
  });

  test("Startup's month: what it sent Globex is a part of its own, not in the remainder", () => {
    // $100,000 out; $24,000 pay; $6,000 registered; $60,000 sent to Globex: $10,000 is in none.
    expect(remainderOf(100_000_00, PAY, COSTS, { kind: "known", amount: 60_000_00 })).toEqual({
      kind: "known",
      amount: 10_000_00,
      share: 0.1,
    });
    expect(remainderOf(80_000_00, PAY, COSTS, { kind: "known", amount: 60_000_00 })).toEqual({
      kind: "over",
      amount: 10_000_00,
    });
    // Nothing sent is a known nothing: the remainder is as it was.
    expect(remainderOf(40_000_00, PAY, COSTS, { kind: "known", amount: 0 })).toEqual(remainderOf(40_000_00, PAY, COSTS));
  });

  test("what Startup sent not known: the remainder is not known, never the rest as if nothing went", () => {
    const notCounted = { kind: "unknown", reason: "not_counted" } as const;
    expect(remainderOf(40_000_00, PAY, COSTS, notCounted)).toEqual({ kind: "unknown", reason: "sent_unknown" });
    // What is hidden or missing before it is said first.
    expect(remainderOf(40_000_00, { kind: "hidden" }, COSTS, notCounted)).toEqual({ kind: "unknown", reason: "payroll_hidden" });
    expect(remainderOf(null, PAY, COSTS, { kind: "unknown", reason: "no_actual" })).toEqual({
      kind: "unknown",
      reason: "no_actual",
    });
  });

  test("no money out at all has no share to give", () => {
    expect(remainderOf(0, { kind: "known", amount: 0, basis: "live" }, { kind: "known", amount: 0, byCategory: [] })).toEqual({
      kind: "known",
      amount: 0,
      share: null,
    });
  });
});

describe("sentShare: what Startup sent Globex in a month, inside its money out", () => {
  test("the figure Mercury's run counted, a zero included", () => {
    expect(sentShare(40_000_00, 30_000_00)).toEqual({ kind: "known", amount: 30_000_00 });
    expect(sentShare(40_000_00, 0)).toEqual({ kind: "known", amount: 0 });
  });

  test("money out on record and this not: read before it was counted, so not known, never zero", () => {
    expect(sentShare(40_000_00, null)).toEqual({ kind: "unknown", reason: "not_counted" });
  });

  test("no money out: not known until the month is", () => {
    expect(sentShare(null, 30_000_00)).toEqual({ kind: "unknown", reason: "no_actual" });
    expect(sentShare(null, null)).toEqual({ kind: "unknown", reason: "no_actual" });
  });
});

describe("shownMonths: which months the chart draws", () => {
  const month = (m: string, actual: number | null) => ({ month: m, actual });
  test("the months with money out on record, oldest first, from three of them", () => {
    const rows = [month("2026-04", null), month("2026-05", 1), month("2026-06", 2), month("2026-07", 3)];
    expect(shownMonths(rows)).toEqual({ kind: "chart", months: rows.slice(1) });
    expect(MIN_CHART_MONTHS).toBe(3);
  });
  test("fewer than three: the latest one alone, as one composition", () => {
    const rows = [month("2026-07", 3), month("2026-08", null), month("2026-09", 4)];
    expect(shownMonths(rows)).toEqual({ kind: "one", month: rows[2] });
  });
  test("none: nothing to show", () => {
    expect(shownMonths([month("2026-09", null)])).toEqual({ kind: "none" });
  });
});

describe("groupMoneyOut: the group's money out, in dollars", () => {
  const pay = (amount: number, basis: "paid" | "live" = "live"): PayrollShare => ({ kind: "known", amount, basis });
  const costs = (rows: [string, number][]): CostsShare => ({
    kind: "known",
    amount: rows.reduce((sum, [, amount]) => sum + amount, 0),
    byCategory: rows.map(([category, amount]) => ({ category: category as "cloud", amount })),
  });
  /** A company's month. Startup's carries what it sent Globex (`sent`); Globex's has none. */
  const row = (
    month: string,
    actual: number | null,
    payroll: PayrollShare,
    cost: CostsShare,
    sent: SentShare | null = null,
  ): MoneyOutRow => ({
    month,
    actual,
    moneyIn: 1_00,
    payroll,
    costs: cost,
    sent,
    remainder: remainderOf(actual, payroll, cost, sent),
  });
  const of = (currency: "USD" | "KZT", rows: MoneyOutRow[]) => ({
    currency,
    fx: 500,
    rows,
    holdsPayroll: true,
    holdsCosts: true,
  });
  const nothingSent: SentShare = { kind: "known", amount: 0 };
  const us = of("USD", [row("2026-08", 10_000_00, pay(6_000_00, "paid"), costs([["cloud", 1_000_00]]), nothingSent)]);
  const kz = of("KZT", [
    row("2026-08", 2_500_000_00, pay(1_000_000_00, "paid"), costs([["cloud", 500_000_00], ["office", 250_000_00]])),
  ]);

  test("each company's money out and registers added at the rate, by category, with what is left", () => {
    const [august] = groupMoneyOut(us, kz, 500).rows;
    expect(august).toEqual({
      month: "2026-08",
      actual: 15_000_00,
      moneyIn: null,
      payroll: { kind: "known", amount: 8_000_00, basis: "paid" },
      costs: {
        kind: "known",
        amount: 2_500_00,
        byCategory: [
          { category: "cloud", amount: 2_000_00 },
          { category: "office", amount: 500_00 },
        ],
      },
      sent: null,
      remainder: { kind: "known", amount: 4_500_00, share: 0.3 },
      group: { us: 10_000_00, sent: 0, kz: 2_500_000_00, missing: [] },
    });
  });

  test("what Startup sent Globex is taken out of Startup's part: its spending is in Globex's already", () => {
    // Startup: $69,000 out, $64,000 of it to Globex, no payroll, $4,000 of cloud.
    // Globex: ₸22.5M spent ($45,000 at 500), ₸17.5M of pay, ₸3M of office.
    const funding = of("USD", [
      row("2026-09", 69_000_00, pay(0, "paid"), costs([["cloud", 4_000_00]]), { kind: "known", amount: 64_000_00 }),
    ]);
    const subsidiary = of("KZT", [
      row("2026-09", 22_500_000_00, pay(17_500_000_00, "paid"), costs([["office", 3_000_000_00]])),
    ]);
    const [september] = groupMoneyOut(funding, subsidiary, 500).rows;
    // $5,000 of Startup's own and $45,000 of Globex's: $50,000, not $114,000.
    expect(september!.actual).toBe(50_000_00);
    expect(september!.group).toEqual({ us: 5_000_00, sent: 64_000_00, kz: 22_500_000_00, missing: [] });
    expect(september!.sent).toBeNull();
    expect(september!.payroll).toEqual({ kind: "known", amount: 35_000_00, basis: "paid" });
    expect(september!.costs).toMatchObject({ kind: "known", amount: 10_000_00 });
    expect(september!.remainder).toEqual({ kind: "known", amount: 5_000_00, share: 0.1 });
  });

  test("Startup's money out on record but what it sent not: Startup's part is not known, and says why", () => {
    const notCounted = of("USD", [
      row("2026-08", 10_000_00, pay(6_000_00, "paid"), costs([["cloud", 1_000_00]]), { kind: "unknown", reason: "not_counted" }),
    ]);
    const [august] = groupMoneyOut(notCounted, kz, 500).rows;
    expect(august!.actual).toBeNull();
    expect(august!.group).toEqual({ us: null, sent: null, kz: 2_500_000_00, missing: ["sent"] });
    expect(august!.remainder).toEqual({ kind: "unknown", reason: "no_actual" });
    // With no rate as well, both are said, Startup's first.
    expect(groupMoneyOut(notCounted, kz, null).rows[0]!.group!.missing).toEqual(["sent", "fx"]);
  });

  test("with no rate the month's group figures are not known, and say why; each company's own stays", () => {
    const [august] = groupMoneyOut(us, kz, null).rows;
    expect(august!.actual).toBeNull();
    expect(august!.group).toEqual({ us: 10_000_00, sent: 0, kz: 2_500_000_00, missing: ["fx"] });
    expect(august!.payroll).toEqual({ kind: "unknown", reason: "no_rate" });
    expect(august!.costs).toEqual({ kind: "unknown", reason: "no_rate" });
    expect(august!.remainder).toEqual({ kind: "unknown", reason: "no_actual" });
  });

  test("a company with no money out makes the group's not known; a register hidden from the viewer stays hidden", () => {
    const short = of("KZT", [row("2026-08", null, { kind: "hidden" }, costs([]))]);
    const [august] = groupMoneyOut(us, short, 500).rows;
    expect(august!.actual).toBeNull();
    expect(august!.group!.missing).toEqual(["kz"]);
    expect(august!.payroll).toEqual({ kind: "hidden" });
    expect(august!.remainder).toEqual({ kind: "unknown", reason: "payroll_hidden" });
  });
});
