import { describe, expect, test } from "vitest";
import {
  BUCKET_LABELS,
  COST_BUCKETS,
  COST_CATEGORIES,
  activeIn,
  bucketOf,
  defaultBucket,
  addMonths,
  cashDueOf,
  hasEnded,
  isMonth,
  looksLikeAccountNumber,
  monthlyEquivalent,
  runRateOf,
  summarise,
  type CostLine,
} from "./costs";

// Every vendor and amount here is made up.

const line = (extra: Partial<CostLine> = {}): CostLine => ({
  category: "software",
  amount: 120_00,
  currency: "USD",
  cadence: "monthly",
  startsOn: "2026-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
  ...extra,
});

describe("what a line counts as", () => {
  test("three buckets, each with the words the page uses", () => {
    expect(COST_BUCKETS).toEqual(["cogs", "sales_marketing", "operating"]);
    expect(BUCKET_LABELS).toEqual({
      cogs: "Cost of serving customers",
      sales_marketing: "Sales and marketing",
      operating: "Running the company",
    });
  });

  test("with none chosen: cloud serves customers, marketing is sales and marketing, the rest runs the company", () => {
    expect(Object.fromEntries(COST_CATEGORIES.map((category) => [category, defaultBucket(category)]))).toEqual({
      cloud: "cogs",
      software: "operating",
      office: "operating",
      services: "operating",
      marketing: "sales_marketing",
      travel: "operating",
      taxes_fees: "operating",
      other: "operating",
    });
  });

  test("a chosen bucket stands whatever the category; none (or null) is the category's default", () => {
    expect(bucketOf({ category: "software", bucket: "cogs" })).toBe("cogs");
    expect(bucketOf({ category: "cloud", bucket: "operating" })).toBe("operating");
    expect(bucketOf({ category: "marketing" })).toBe("sales_marketing");
    expect(bucketOf({ category: "cloud", bucket: null })).toBe("cogs");
  });
});

describe("months", () => {
  test("a month is YYYY-MM and nothing else", () => {
    for (const good of ["2026-01", "2026-12", "1999-09"]) expect(isMonth(good)).toBe(true);
    for (const bad of ["2026-13", "2026-00", "2026-1", "2026-01-01", "26-01", "", "2026/01"]) {
      expect([bad, isMonth(bad)]).toEqual([bad, false]);
    }
  });

  test("adding months crosses a year end, both ways", () => {
    expect(addMonths("2026-11", 1)).toBe("2026-12");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-12", 13)).toBe("2028-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-10", 0)).toBe("2026-10");
  });
});

describe("when a line is active", () => {
  test("from its start, inclusive", () => {
    const l = line({ startsOn: "2026-10" });
    expect(activeIn(l, "2026-09")).toBe(false);
    expect(activeIn(l, "2026-10")).toBe(true);
    expect(activeIn(l, "2027-03")).toBe(true);
  });

  test("to its end, inclusive", () => {
    const l = line({ startsOn: "2026-10", endsOn: "2027-01" });
    expect(activeIn(l, "2027-01")).toBe(true);
    expect(activeIn(l, "2027-02")).toBe(false);
  });

  test("a one-off has only its month, whatever end it carries", () => {
    const l = line({ cadence: "once", startsOn: "2026-11", endsOn: "2027-06" });
    expect(activeIn(l, "2026-10")).toBe(false);
    expect(activeIn(l, "2026-11")).toBe(true);
    expect(activeIn(l, "2026-12")).toBe(false);
  });

  test("an archived line is never active", () => {
    expect(activeIn(line({ archivedAt: 1 }), "2026-10")).toBe(false);
  });

  test("ended: archived, past its end, or a one-off whose month has gone", () => {
    expect(hasEnded(line(), "2026-10")).toBe(false);
    expect(hasEnded(line({ archivedAt: 1 }), "2026-10")).toBe(true);
    expect(hasEnded(line({ endsOn: "2026-09" }), "2026-10")).toBe(true);
    expect(hasEnded(line({ endsOn: "2026-10" }), "2026-10")).toBe(false);
    expect(hasEnded(line({ cadence: "once", startsOn: "2026-09" }), "2026-10")).toBe(true);
    expect(hasEnded(line({ cadence: "once", startsOn: "2026-11" }), "2026-10")).toBe(false);
    // Not started yet is not ended.
    expect(hasEnded(line({ startsOn: "2027-01" }), "2026-10")).toBe(false);
  });
});

describe("the monthly equivalent", () => {
  test("monthly is the amount, quarterly a third, yearly a twelfth, a one-off nothing", () => {
    expect(monthlyEquivalent(line({ amount: 120_00 }))).toBe(120_00);
    expect(monthlyEquivalent(line({ cadence: "quarterly", amount: 300_00 }))).toBe(100_00);
    expect(monthlyEquivalent(line({ cadence: "yearly", amount: 1_200_00 }))).toBe(100_00);
    expect(monthlyEquivalent(line({ cadence: "once", amount: 999_00 }))).toBe(0);
  });

  test("a division that does not come out even is rounded half up to a whole minor unit", () => {
    expect(monthlyEquivalent(line({ cadence: "quarterly", amount: 100 }))).toBe(33);
    expect(monthlyEquivalent(line({ cadence: "quarterly", amount: 101 }))).toBe(34);
    expect(monthlyEquivalent(line({ cadence: "yearly", amount: 100 }))).toBe(8);
    expect(monthlyEquivalent(line({ cadence: "yearly", amount: 6 }))).toBe(1);
  });
});

describe("run-rate and cash due, one line, one month", () => {
  test("monthly: the amount in both, while active", () => {
    const l = line({ amount: 50_00, startsOn: "2026-10", endsOn: "2026-12" });
    expect([runRateOf(l, "2026-09"), cashDueOf(l, "2026-09")]).toEqual([0, 0]);
    expect([runRateOf(l, "2026-12"), cashDueOf(l, "2026-12")]).toEqual([50_00, 50_00]);
    expect([runRateOf(l, "2027-01"), cashDueOf(l, "2027-01")]).toEqual([0, 0]);
  });

  test("quarterly: a third every month, the whole amount every third month from its start", () => {
    const l = line({ cadence: "quarterly", amount: 300_00, startsOn: "2026-11" });
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-05"];
    expect(months.map((m) => runRateOf(l, m))).toEqual([0, 100_00, 100_00, 100_00, 100_00, 100_00, 100_00]);
    expect(months.map((m) => cashDueOf(l, m))).toEqual([0, 300_00, 0, 0, 300_00, 0, 300_00]);
  });

  test("yearly: a twelfth every month, the whole amount in its anniversary month", () => {
    const l = line({ cadence: "yearly", amount: 1_200_00, startsOn: "2025-12" });
    expect(runRateOf(l, "2026-10")).toBe(100_00);
    expect(cashDueOf(l, "2026-10")).toBe(0);
    expect(cashDueOf(l, "2026-12")).toBe(1_200_00);
    expect(cashDueOf(l, "2027-12")).toBe(1_200_00);
    expect(cashDueOf(l, "2027-11")).toBe(0);
    expect(cashDueOf(l, "2025-12")).toBe(1_200_00);
  });

  test("a yearly line that ends before its anniversary pays nothing more", () => {
    const l = line({ cadence: "yearly", amount: 1_200_00, startsOn: "2025-12", endsOn: "2026-11" });
    expect(cashDueOf(l, "2026-12")).toBe(0);
    expect(runRateOf(l, "2026-11")).toBe(100_00);
    expect(runRateOf(l, "2026-12")).toBe(0);
  });

  test("a one-off: all of it as cash in its month, never in the run-rate", () => {
    const l = line({ cadence: "once", amount: 5_000_00, startsOn: "2026-11" });
    expect([runRateOf(l, "2026-11"), cashDueOf(l, "2026-11")]).toEqual([0, 5_000_00]);
    expect([runRateOf(l, "2026-12"), cashDueOf(l, "2026-12")]).toEqual([0, 0]);
  });

  test("an archived line is in neither figure", () => {
    const l = line({ archivedAt: 5 });
    expect([runRateOf(l, "2026-10"), cashDueOf(l, "2026-10")]).toEqual([0, 0]);
  });
});

describe("a month's summary", () => {
  const OCT = "2026-10";
  const lines: CostLine[] = [
    line({ category: "cloud", amount: 400_00, variable: true }),
    line({ category: "software", amount: 100_00 }),
    line({ category: "software", cadence: "yearly", amount: 1_200_00, startsOn: "2026-01" }),
    line({ category: "office", cadence: "quarterly", amount: 900_00, startsOn: "2026-10" }),
    line({ category: "services", cadence: "once", amount: 2_000_00, startsOn: "2026-11" }),
    line({ category: "travel", amount: 70_00, endsOn: "2026-09" }),
    line({ category: "marketing", amount: 55_00, archivedAt: 1 }),
  ];
  const us = summarise({ lines, month: OCT, companyCurrency: "USD", fxUsdKzt: null });

  test("run-rate and cash due are two figures, per category and overall", () => {
    expect(us.currencies).toHaveLength(1);
    const usd = us.currencies[0]!;
    expect(usd.currency).toBe("USD");
    // 400 + 100 + 1200/12 + 900/3
    expect(usd.runRate).toBe(900_00);
    // 400 + 100 + the quarter's 900; the yearly line falls in January.
    expect(usd.cashDue).toBe(1_400_00);
    expect(usd.byCategory).toEqual([
      { category: "cloud", runRate: 400_00, cashDue: 400_00 },
      { category: "office", runRate: 300_00, cashDue: 900_00 },
      { category: "software", runRate: 200_00, cashDue: 100_00 },
    ]);
    expect(usd.yearly).toBe(900_00 * 12);
  });

  test("twelve months of cash due, this month first, across the year end", () => {
    expect(us.months).toEqual([
      "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
      "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09",
    ]);
    const cash = us.currencies[0]!.cashByMonth;
    expect(cash).toHaveLength(12);
    expect(cash[0]).toBe(1_400_00);
    // November: the monthlies and the one-off.
    expect(cash[1]).toBe(500_00 + 2_000_00);
    expect(cash[2]).toBe(500_00);
    // January: the monthlies, the quarter and the year.
    expect(cash[3]).toBe(500_00 + 900_00 + 1_200_00);
  });

  test("the next three months are the three after this one", () => {
    expect(us.currencies[0]!.next3).toBe(2_500_00 + 500_00 + 2_600_00);
  });

  test("lines and estimates are counted over the lines active this month", () => {
    expect([us.lines, us.estimates]).toEqual([4, 1]);
  });

  test("one currency: the combined figures are that currency's, with no rate needed", () => {
    expect(us.combined).toMatchObject({ kind: "single", currency: "USD", runRate: 900_00 });
  });

  test("no line at all: zeros in the company's currency, which is a known nothing", () => {
    const none = summarise({ lines: [], month: OCT, companyCurrency: "KZT", fxUsdKzt: null });
    expect(none.currencies.map((c) => [c.currency, c.runRate, c.cashDue])).toEqual([["KZT", 0, 0]]);
    expect(none.combined).toMatchObject({ kind: "single", currency: "KZT", runRate: 0 });
    expect([none.lines, none.estimates]).toEqual([0, 0]);
  });

  const mixed: CostLine[] = [
    line({ category: "cloud", amount: 100_00, currency: "USD" }),
    line({ category: "office", amount: 500_000_00, currency: "KZT" }),
    line({ category: "cloud", amount: 250_000_00, currency: "KZT" }),
  ];

  test("two currencies: each has its own subtotal, the company's own first", () => {
    const kz = summarise({ lines: mixed, month: OCT, companyCurrency: "KZT", fxUsdKzt: 500 });
    expect(kz.currencies.map((c) => [c.currency, c.runRate])).toEqual([
      ["KZT", 750_000_00],
      ["USD", 100_00],
    ]);
  });

  test("two currencies and a rate: one total, in US dollars, at that rate", () => {
    const kz = summarise({ lines: mixed, month: OCT, companyCurrency: "KZT", fxUsdKzt: 500 });
    expect(kz.combined).toMatchObject({
      kind: "converted",
      currency: "USD",
      rate: 500,
      // 100 + 750,000 / 500
      runRate: 100_00 + 1_500_00,
      cashDue: 1_600_00,
      yearly: 1_600_00 * 12,
    });
    if (kz.combined.kind !== "converted") throw new Error("unreachable");
    expect(kz.combined.byCategory).toEqual([
      { category: "office", runRate: 1_000_00, cashDue: 1_000_00 },
      { category: "cloud", runRate: 600_00, cashDue: 600_00 },
    ]);
    expect(kz.combined.cashByMonth).toHaveLength(12);
  });

  test("two currencies and no rate: the total is not known, and each subtotal still stands", () => {
    for (const fxUsdKzt of [null, 0, -1, Number.NaN]) {
      const kz = summarise({ lines: mixed, month: OCT, companyCurrency: "KZT", fxUsdKzt });
      expect(kz.combined).toEqual({ kind: "unknown" });
      expect(kz.currencies.map((c) => c.runRate)).toEqual([750_000_00, 100_00]);
    }
  });

  test("a company whose lines are all in the other currency needs no rate either", () => {
    const kz = summarise({ lines: [mixed[0]!], month: OCT, companyCurrency: "KZT", fxUsdKzt: null });
    expect(kz.currencies.map((c) => c.currency)).toEqual(["USD"]);
    expect(kz.combined).toMatchObject({ kind: "single", currency: "USD", runRate: 100_00 });
  });

  test("a second currency that is only archived or ended does not ask for a rate", () => {
    const one = summarise({
      lines: [mixed[0]!, { ...mixed[1]!, archivedAt: 1 }, { ...mixed[2]!, endsOn: "2026-09" }],
      month: OCT,
      companyCurrency: "USD",
      fxUsdKzt: null,
    });
    expect(one.combined).toMatchObject({ kind: "single", currency: "USD", runRate: 100_00 });
    expect(one.currencies).toHaveLength(1);
  });

  test("every category is one of the closed list", () => {
    expect(COST_CATEGORIES).toEqual([
      "cloud", "software", "office", "services", "marketing", "travel", "taxes_fees", "other",
    ]);
  });
});

describe("what looks like a card or account number", () => {
  test.each([
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "card 4111111111111111",
    "acct 123456789",
    "KZ86125KZT5004100100",
    "pay to GB29NWBK60161331926819",
    "0012 3456 7890",
    // The shape of an IBAN, with no long run of digits in it.
    "DE89ABCD1234EFGH5678",
  ])("%s is refused", (text) => {
    expect(looksLikeAccountNumber(text)).toBe(true);
  });

  test.each([
    "AWS",
    "Mercury card",
    "Kaspi",
    "card ending 4242",
    "Seat count 12, renews 2026-11",
    "2026-10-13 to 2027-10-13",
    // Two dates side by side are sixteen digits in groups, and still dates.
    "2026-10-13 2027-10-13",
    "renews 2026-11 2027-11 2028-11",
    "Invoice 20261013",
    "Office 204, floor 3",
    "",
  ])("%s is let through", (text) => {
    expect(looksLikeAccountNumber(text)).toBe(false);
  });
});
