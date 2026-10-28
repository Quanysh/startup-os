import { describe, expect, test } from "vitest";
import type { Live } from "@convex/lib/budget";
import type { CostCategory } from "@convex/lib/costs";
import type { CurrencyTotals, PayPerson, PayrollLineRow } from "@convex/lib/payroll";
import {
  CHART_SLOTS,
  allCosts,
  companyCosts,
  isLoaded,
  payrollByKind,
  nextSort,
  readSort,
  sortRows,
  writeSort,
  type CostLineRow,
  type LoadedCosts,
} from "./all-costs";

// Every name, amount and rate here is made up.

const MONTH = "2026-10";
const FX = 500; // tenge to the dollar

const person = (extra: Partial<PayPerson>): PayPerson => ({
  id: "p1",
  name: "Example Person",
  kind: "employee",
  currency: "USD",
  monthlyGross: 5_000_00,
  order: 0,
  ...extra,
});
/** A company-paid line on top of gross: 10% for employees. */
const companyLine: PayrollLineRow = {
  id: "l1",
  name: "Made-up contribution",
  paidBy: "company",
  rateBp: 1_000,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  appliesTo: "employee",
  order: 0,
  active: true,
};
const kindTotals = (people: number, cost: number, notComputed = 0) => ({
  people,
  gross: cost,
  adjustment: 0,
  withheld: 0,
  net: 0,
  companyPaid: 0,
  cost,
  notComputed,
});
const frozen = (currency: "USD" | "KZT", employee: number, contractor: number, notComputed = 0): CurrencyTotals => ({
  currency,
  byKind: { employee: kindTotals(1, employee, notComputed), contractor: kindTotals(1, contractor) },
  overall: kindTotals(2, employee + contractor, notComputed),
});

const cost = (extra: Partial<CostLineRow> & { name: string }): CostLineRow => ({
  id: extra.name,
  category: "cloud",
  amount: 1_000_00,
  currency: "USD",
  cadence: "monthly",
  startsOn: "2025-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
  ...extra,
});

describe("Payroll by kind, this month", () => {
  test("live: each kind's total cost, gross and what the company pays on top, adding up to Payroll's total", () => {
    const reads = {
      people: [
        person({}),
        person({ id: "p2", name: "Sample Contractor", kind: "contractor", monthlyGross: 2_000_00 }),
      ],
      lines: [companyLine],
      runs: [],
    };
    const kinds = payrollByKind({ month: MONTH, holds: true, reads, currency: "USD", fx: null });
    // 5,000 gross + 10% on top; the contractor has no line.
    expect(kinds).toEqual({
      employee: { kind: "known", amount: 5_500_00 },
      contractor: { kind: "known", amount: 2_000_00 },
    });
    const own = companyCosts({
      company: "us",
      month: MONTH,
      fx: null,
      holdsPayroll: true,
      holdsCosts: false,
      payroll: reads,
      costLines: undefined,
    });
    expect(own.payroll.total).toEqual({ kind: "known", amount: 7_500_00 });
  });

  test("a paid month: each kind's frozen total cost, never worked out again", () => {
    const kinds = payrollByKind({
      month: MONTH,
      holds: true,
      reads: {
        people: [person({ monthlyGross: 9_999_00 })],
        lines: [],
        runs: [{ month: "2026-10-01", status: "paid", totals: [frozen("USD", 4_000_00, 1_000_00)] }],
      },
      currency: "USD",
      fx: null,
    });
    expect(kinds).toEqual({
      employee: { kind: "known", amount: 4_000_00 },
      contractor: { kind: "known", amount: 1_000_00 },
    });
  });

  test("a paid month with an uncomputed line: that kind is not known, never its part", () => {
    const kinds = payrollByKind({
      month: MONTH,
      holds: true,
      reads: { people: [], lines: [], runs: [{ month: "2026-10-01", status: "paid", totals: [frozen("USD", 4_000_00, 1_000_00, 1)] }] },
      currency: "USD",
      fx: null,
    });
    expect(kinds.employee).toEqual({ kind: "unknown", reason: "rates" });
    expect(kinds.contractor).toEqual({ kind: "known", amount: 1_000_00 });
  });

  test("a rate not set: the kind it applies to is not known", () => {
    const kinds = payrollByKind({
      month: MONTH,
      holds: true,
      reads: { people: [person({})], lines: [{ ...companyLine, rateBp: null }], runs: [] },
      currency: "USD",
      fx: null,
    });
    expect(kinds.employee).toEqual({ kind: "unknown", reason: "rates" });
    expect(kinds.contractor).toEqual({ kind: "known", amount: 0 });
  });

  test("lines that subtract each other in a circle: not known, payroll's own word", () => {
    const a = { ...companyLine, id: "a", lessLineIds: ["b"] };
    const b = { ...companyLine, id: "b", lessLineIds: ["a"] };
    const kinds = payrollByKind({ month: MONTH, holds: true, reads: { people: [person({})], lines: [a, b], runs: [] }, currency: "USD", fx: null });
    expect(kinds.employee).toEqual({ kind: "unknown", reason: "circle" });
  });

  test("someone paid in the other currency: converted at the rate, not known without one", () => {
    const reads = { people: [person({ kind: "contractor", currency: "KZT", monthlyGross: 1_000_000_00 })], lines: [], runs: [] };
    expect(payrollByKind({ month: MONTH, holds: true, reads, currency: "USD", fx: FX }).contractor).toEqual({
      kind: "known",
      amount: 2_000_00,
    });
    expect(payrollByKind({ month: MONTH, holds: true, reads, currency: "USD", fx: null }).contractor).toEqual({
      kind: "unknown",
      reason: "no_rate",
    });
    // Nobody is an employee, in either currency: a known nothing, no rate needed.
    expect(payrollByKind({ month: MONTH, holds: true, reads, currency: "USD", fx: null }).employee).toEqual({
      kind: "known",
      amount: 0,
    });
  });

  test("a paid month with a currency nobody of a kind is paid in: that kind needs no rate for it", () => {
    const kzEmployeesOnly: CurrencyTotals = {
      currency: "KZT",
      byKind: { employee: kindTotals(1, 500_000_00), contractor: kindTotals(0, 0) },
      overall: kindTotals(1, 500_000_00),
    };
    const kinds = payrollByKind({
      month: MONTH,
      holds: true,
      reads: { people: [], lines: [], runs: [{ month: "2026-10-01", status: "paid", totals: [frozen("USD", 4_000_00, 1_000_00), kzEmployeesOnly] }] },
      currency: "USD",
      fx: null,
    });
    expect(kinds).toEqual({
      employee: { kind: "unknown", reason: "no_rate" },
      contractor: { kind: "known", amount: 1_000_00 },
    });
  });

  test("without the Payroll page nothing is worked out; while a read is out, loading", () => {
    const none = { people: undefined, lines: undefined, runs: undefined };
    expect(payrollByKind({ month: MONTH, holds: false, reads: none, currency: "USD", fx: null })).toEqual({
      employee: { kind: "hidden" },
      contractor: { kind: "hidden" },
    });
    expect(payrollByKind({ month: MONTH, holds: true, reads: none, currency: "USD", fx: null })).toEqual({
      employee: { kind: "loading" },
      contractor: { kind: "loading" },
    });
  });
});

describe("one company's costs this month", () => {
  const LINES = [
    cost({ name: "Example Cloud", amount: 2_300_00 }),
    cost({ name: "Sample Tool", category: "software", amount: 900_00, variable: true }),
    // A yearly bill: a twelfth a month in the run-rate, whole in its month as cash due.
    cost({ name: "Example Filing", category: "taxes_fees", amount: 1_200_00, cadence: "yearly", startsOn: "2025-10" }),
    // A one-off this month: cash due, never in the run-rate.
    cost({ name: "Sample Laptop", category: "other", amount: 1_500_00, cadence: "once", startsOn: "2026-10" }),
    // Ended, and archived: in nothing.
    cost({ name: "Old Example", amount: 50_00, endsOn: "2026-09" }),
    cost({ name: "Archived Sample", amount: 70_00, archivedAt: 1 }),
  ];
  const own = companyCosts({
    company: "us",
    month: MONTH,
    fx: null,
    holdsPayroll: false,
    holdsCosts: true,
    payroll: { people: undefined, lines: undefined, runs: undefined },
    costLines: LINES,
  });

  test("the register's run-rate by category, and its cash due", () => {
    expect(own.register).toMatchObject({
      kind: "known",
      runRate: {
        cloud: { kind: "known", amount: 2_300_00 },
        software: { kind: "known", amount: 900_00 },
        taxes_fees: { kind: "known", amount: 100_00 },
      },
      cashDue: { kind: "known", amount: 2_300_00 + 900_00 + 1_200_00 + 1_500_00 },
    });
    // The one-off is not a monthly cost: no category of its own here.
    expect(own.register.kind === "known" && own.register.runRate.other).toBeUndefined();
  });

  test("each category's lines: the ones in its run-rate, with their monthly equivalent", () => {
    if (own.register.kind !== "known") throw new Error("expected the register");
    expect(own.register.lines.map((line) => [line.name, line.category, line.monthly, line.variable])).toEqual([
      ["Example Cloud", "cloud", 2_300_00, false],
      ["Sample Tool", "software", 900_00, true],
      ["Example Filing", "taxes_fees", 100_00, false],
    ]);
  });

  test("Payroll without its page is hidden, and nothing of it was worked out", () => {
    expect(own.payroll).toEqual({
      total: { kind: "hidden" },
      byKind: { employee: { kind: "hidden" }, contractor: { kind: "hidden" } },
    });
  });

  test("the register without its page is hidden; while it loads, loading", () => {
    const base = { company: "us" as const, month: MONTH, fx: null, holdsPayroll: false, payroll: { people: undefined, lines: undefined, runs: undefined } };
    expect(companyCosts({ ...base, holdsCosts: false, costLines: LINES }).register).toEqual({ kind: "hidden" });
    expect(companyCosts({ ...base, holdsCosts: true, costLines: undefined }).register).toEqual({ kind: "loading" });
  });

  test("loaded once nothing asked for is still on its way, hidden registers included", () => {
    const none = { people: undefined, lines: undefined, runs: undefined };
    const base = { company: "us" as const, month: MONTH, fx: null };
    expect(isLoaded(companyCosts({ ...base, holdsPayroll: false, holdsCosts: false, payroll: none, costLines: undefined }))).toBe(true);
    expect(isLoaded(companyCosts({ ...base, holdsPayroll: false, holdsCosts: true, payroll: none, costLines: undefined }))).toBe(false);
    expect(isLoaded(companyCosts({ ...base, holdsPayroll: true, holdsCosts: false, payroll: none, costLines: undefined }))).toBe(false);
    expect(isLoaded(own)).toBe(true);
  });

  test("a line in the other currency with no rate: its category and the cash due are not known", () => {
    const kz = companyCosts({
      company: "kz",
      month: MONTH,
      fx: null,
      holdsPayroll: false,
      holdsCosts: true,
      payroll: { people: undefined, lines: undefined, runs: undefined },
      costLines: [cost({ name: "Example Cloud", amount: 100_00, currency: "USD" }), cost({ name: "Sample Rent", category: "office", amount: 300_000_00, currency: "KZT" })],
    });
    expect(kz.register).toMatchObject({
      runRate: { cloud: { kind: "unknown", reason: "no_rate" }, office: { kind: "known", amount: 300_000_00 } },
      cashDue: { kind: "unknown", reason: "no_rate" },
    });
  });
});

// ── Merging: the lens's rows, totals and shares ────────────────────────────

const known = (amount: number): Live => ({ kind: "known", amount });
const company = (
  id: "us" | "kz",
  payroll: Live,
  runRate: Partial<Record<CostCategory, Live>> | "hidden",
  cashDue: Live = known(0),
  byKind = { employee: payroll, contractor: known(0) },
): LoadedCosts => ({
  company: id,
  currency: id === "us" ? "USD" : "KZT",
  payroll: { total: payroll, byKind },
  register: runRate === "hidden" ? { kind: "hidden" } : { kind: "known", runRate, cashDue, lines: [] },
});

// Startup: $24,000 of pay, $2,300 of cloud, $900 of software; $2,300 of the register falls due this month.
const US = company("us", known(24_000_00), { cloud: known(2_300_00), software: known(900_00) }, known(2_300_00));
// Globex: ₸6M of pay, ₸500K of rent, ₸250K of cloud. At 500 to the dollar: $12,000, $1,000, $500.
const KZ = company("kz", known(6_000_000_00), { office: known(500_000_00), cloud: known(250_000_00) }, known(750_000_00));

describe("the group: both companies in dollars", () => {
  const view = allCosts({ lens: "group", companies: [US, KZ], fx: FX });

  test("Payroll first, then every category either company has, each company's own and the group's", () => {
    expect(view.rows.map((row) => row.key)).toEqual(["payroll", "cloud", "software", "office"]);
    const cloud = view.rows.find((row) => row.key === "cloud")!;
    expect(cloud.own).toEqual({ us: known(2_300_00), kz: known(250_000_00) });
    expect(cloud.kzUsd).toBe(500_00);
    expect(cloud.main).toEqual(known(2_800_00));
    // A category one company does not have is a known nothing there, not a gap.
    expect(view.rows.find((row) => row.key === "office")!.own.us).toEqual(known(0));
  });

  test("monthly costs: Payroll's total cost plus the register's run-rate; a year at that rate; each company's share", () => {
    // 24,000 + 2,300 + 900 = 27,200; 12,000 + 1,000 + 500 = 13,500.
    expect(view.monthly.main).toEqual(known(40_700_00));
    expect(view.monthly.own).toEqual({ us: known(27_200_00), kz: known(6_750_000_00) });
    expect(view.yearly.main).toEqual(known(488_400_00));
    // With a rate on record, nothing is missing.
    expect(view.gaps).toEqual([]);
    expect(view.split).toEqual([
      { company: "us", usd: 27_200_00, share: 27_200_00 / 40_700_00 },
      { company: "kz", usd: 13_500_00, share: 13_500_00 / 40_700_00 },
    ]);
  });

  test("cash due: Payroll plus what the register has fall due this month", () => {
    // 24,000 + 2,300 and 6,000,000 + 750,000 tenge ($13,500).
    expect(view.cashDue.own).toEqual({ us: known(26_300_00), kz: known(6_750_000_00) });
    expect(view.cashDue.main).toEqual(known(39_800_00));
  });

  test("each row's share of the total, the shares adding to the whole", () => {
    const shares = view.rows.map((row) => row.share!);
    expect(shares[0]).toBeCloseTo(36_000_00 / 40_700_00);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  test("Payroll's row holds employees and contractors, each company's and the group's", () => {
    const payroll = view.rows[0]!;
    expect(payroll.kinds?.map((k) => [k.kind, k.main])).toEqual([
      ["employee", known(36_000_00)],
      ["contractor", known(0)],
    ]);
  });

  test("with no rate on record: no group figure, each company's own still stands, and the rate is the reason", () => {
    const none = allCosts({ lens: "group", companies: [US, KZ], fx: null });
    expect(none.monthly.main).toEqual({ kind: "unknown", reason: "no_rate" });
    expect(none.monthly.own.kz).toEqual(known(6_750_000_00));
    expect(none.rows.every((row) => row.share === null)).toBe(true);
    expect(none.split).toBeNull();
    expect(none.chart).toEqual({ kind: "not_drawn", reason: "not_known" });
    expect(none.gaps).toEqual([{ company: null, what: "fx", reason: "no_rate" }]);
  });

  test("tenge of nothing needs no rate", () => {
    const noKz = company("kz", known(0), {});
    const view = allCosts({ lens: "group", companies: [US, noKz], fx: null });
    expect(view.monthly.main).toEqual(known(27_200_00));
    expect(view.gaps).toEqual([]);
  });

  test("Globex's pay not known: the group's is not known for the same reason, and no dollars alongside", () => {
    const short = { ...KZ, payroll: { total: { kind: "unknown", reason: "rates" } as Live, byKind: KZ.payroll.byKind } };
    const view = allCosts({ lens: "group", companies: [US, short], fx: FX });
    expect(view.rows[0]).toMatchObject({ main: { kind: "unknown", reason: "rates" }, kzUsd: null });
    expect(view.monthly.kzUsd).toBeNull();
    expect(view.gaps).toEqual([{ company: "kz", what: "payroll", reason: "rates" }]);
  });

  test("a cost in the other currency with no rate: the register's gap, said once", () => {
    const short: LoadedCosts = {
      ...KZ,
      register: {
        kind: "known",
        runRate: { office: { kind: "unknown", reason: "no_rate" }, cloud: known(250_000_00) },
        cashDue: { kind: "unknown", reason: "no_rate" },
        lines: [],
      },
    };
    const view = allCosts({ lens: "group", companies: [US, short], fx: FX });
    expect(view.gaps).toEqual([{ company: "kz", what: "costs", reason: "no_rate" }]);
    expect(view.cashDue.main).toEqual({ kind: "unknown", reason: "no_rate" });
  });

  test("nothing at all: no share, no split and no chart, never a division by nothing", () => {
    const view = allCosts({ lens: "group", companies: [company("us", known(0), {}), company("kz", known(0), {})], fx: FX });
    expect(view.monthly.main).toEqual(known(0));
    expect(view.rows.map((row) => row.share)).toEqual([null]);
    expect(view.split).toBeNull();
    expect(view.chart).toEqual({ kind: "not_drawn", reason: "nothing" });
  });

  test("one company's pay not known: the group's is not known either, never the rest as the whole", () => {
    const short = { ...US, payroll: { total: { kind: "unknown", reason: "rates" } as Live, byKind: US.payroll.byKind } };
    const view = allCosts({ lens: "group", companies: [short, KZ], fx: FX });
    const payroll = view.rows[0]!;
    expect(payroll.main).toEqual({ kind: "unknown", reason: "rates" });
    expect(view.monthly.main.kind).toBe("unknown");
    expect(view.yearly.main.kind).toBe("unknown");
    expect(view.monthly.own.kz).toEqual(known(6_750_000_00));
    expect(view.gaps).toContainEqual({ company: "us", what: "payroll", reason: "rates" });
  });
});

describe("a category's lines", () => {
  const line = (company: "us" | "kz", name: string, category: CostCategory, currency: "USD" | "KZT", monthly: number) => ({
    id: name,
    name,
    category,
    cadence: "monthly" as const,
    currency,
    monthly,
    variable: false,
  });
  const withLines = (c: LoadedCosts, lines: ReturnType<typeof line>[]): LoadedCosts => {
    if (c.register.kind !== "known") throw new Error("expected the register");
    return { ...c, register: { ...c.register, lines: lines.map(({ ...rest }) => rest) } };
  };
  // Startup's software: $900 is Sample Tool's, made up as two lines; Globex's cloud is one line.
  const us = withLines(US, [
    line("us", "Example Cloud", "cloud", "USD", 2_300_00),
    line("us", "Sample Tool", "software", "USD", 300_00),
    line("us", "Example Assistant", "software", "USD", 600_00),
  ]);
  const kz = withLines(KZ, [
    line("kz", "Sample Rent", "office", "KZT", 500_000_00),
    line("kz", "Example Hosting", "cloud", "KZT", 250_000_00),
  ]);

  test("in the group: each line in dollars and its share of the whole, the largest first", () => {
    const view = allCosts({ lens: "group", companies: [us, kz], fx: FX });
    const software = view.rows.find((row) => row.key === "software")!;
    expect(software.lines.map((l) => [l.name, l.company, l.main, l.share])).toEqual([
      ["Example Assistant", "us", 600_00, 600_00 / 40_700_00],
      ["Sample Tool", "us", 300_00, 300_00 / 40_700_00],
    ]);
    // Globex's tenge at the rate, beside Startup's dollars, the larger first.
    const cloud = view.rows.find((row) => row.key === "cloud")!;
    expect(cloud.lines.map((l) => [l.name, l.company, l.main])).toEqual([
      ["Example Cloud", "us", 2_300_00],
      ["Example Hosting", "kz", 500_00],
    ]);
  });

  test("with no rate: a tenge line has no dollars and no share, and sits last", () => {
    const view = allCosts({ lens: "group", companies: [us, kz], fx: null });
    const cloud = view.rows.find((row) => row.key === "cloud")!;
    expect(cloud.lines.map((l) => [l.name, l.main, l.share])).toEqual([
      ["Example Cloud", 2_300_00, null],
      ["Example Hosting", null, null],
    ]);
  });

  test("in a company's lens: each line in that company's currency, its share of the company's total", () => {
    const view = allCosts({ lens: "kz", companies: [kz], fx: FX });
    const office = view.rows.find((row) => row.key === "office")!;
    expect(office.lines.map((l) => [l.name, l.main, l.share])).toEqual([
      ["Sample Rent", 500_000_00, 500_000_00 / 6_750_000_00],
    ]);
  });
});

describe("one company's lens", () => {
  test("that company alone, in its own currency, with no group figure", () => {
    const view = allCosts({ lens: "kz", companies: [KZ], fx: FX });
    expect(view.currency).toBe("KZT");
    expect(view.rows.map((row) => [row.key, Object.keys(row.own)])).toEqual([
      ["payroll", ["kz"]],
      ["cloud", ["kz"]],
      ["office", ["kz"]],
    ]);
    expect(view.monthly.main).toEqual(known(6_750_000_00));
    expect(view.monthly.kzUsd).toBe(13_500_00);
    expect(view.split).toBeNull();
  });

  test("Globex with no rate: its own figures, and no dollars alongside", () => {
    const view = allCosts({ lens: "kz", companies: [KZ], fx: null });
    expect(view.monthly.main).toEqual(known(6_750_000_00));
    expect(view.monthly.kzUsd).toBeNull();
    expect(view.yearly.kzUsd).toBeNull();
    expect(view.gaps).toEqual([]);
  });
});

describe("what the viewer does not hold", () => {
  test("without Payroll: its row is hidden, no figure, and every total excludes it", () => {
    const hidden: Live = { kind: "hidden" };
    const view = allCosts({
      lens: "us",
      companies: [company("us", hidden, { cloud: known(2_300_00), software: known(900_00) }, known(3_200_00), { employee: hidden, contractor: hidden })],
      fx: null,
    });
    expect(view.excludes).toEqual(["payroll"]);
    expect(view.rows[0]).toMatchObject({ key: "payroll", main: hidden, share: null, kinds: null });
    expect(view.monthly.main).toEqual(known(3_200_00));
    expect(view.cashDue.main).toEqual(known(3_200_00));
    // Shares are of what is shown.
    expect(view.rows[1]!.share).toBeCloseTo(2_300_00 / 3_200_00);
  });

  test("without Costs: one row for the register, hidden, and every total excludes it", () => {
    const view = allCosts({ lens: "us", companies: [company("us", known(24_000_00), "hidden")], fx: null });
    expect(view.excludes).toEqual(["costs"]);
    expect(view.rows.map((row) => [row.key, row.main.kind])).toEqual([
      ["payroll", "known"],
      ["costs", "hidden"],
    ]);
    expect(view.monthly.main).toEqual(known(24_000_00));
    // Payroll alone is one piece: nothing to compose.
    expect(view.chart).toEqual({ kind: "not_drawn", reason: "too_few" });
  });

  test("with neither: nothing to add, every total hidden", () => {
    const hidden: Live = { kind: "hidden" };
    const view = allCosts({ lens: "us", companies: [company("us", hidden, "hidden", hidden, { employee: hidden, contractor: hidden })], fx: null });
    expect(view.excludes).toEqual(["payroll", "costs"]);
    expect(view.monthly.main).toEqual(hidden);
    expect(view.yearly.main).toEqual(hidden);
    expect(view.chart).toEqual({ kind: "not_drawn", reason: "nothing" });
    // The group's too: no dollars for Globex where it has no figure shown.
    const both = allCosts({
      lens: "group",
      companies: (["us", "kz"] as const).map((id) => company(id, hidden, "hidden", hidden, { employee: hidden, contractor: hidden })),
      fx: FX,
    });
    expect(both.monthly.main).toEqual(hidden);
    expect(both.monthly.kzUsd).toBeNull();
  });

  test("while a register loads, nothing is a total yet", () => {
    const view = allCosts({ lens: "us", companies: [company("us", { kind: "loading" }, {})], fx: null });
    expect(view.monthly.main).toEqual({ kind: "loading" });
    expect(view.chart).toEqual({ kind: "not_drawn", reason: "not_known" });
  });
});

describe("the composition chart", () => {
  test("Payroll, then the categories in a fixed order, the smaller ones folded into one", () => {
    const us = company("us", known(20_000_00), {
      cloud: known(1_000_00),
      software: known(500_00),
      office: known(2_000_00),
      services: known(1_500_00),
      marketing: known(300_00),
      travel: known(200_00),
    });
    const view = allCosts({ lens: "us", companies: [us], fx: null });
    if (view.chart.kind !== "drawn") throw new Error("expected a chart");
    expect(view.chart.segments.map((s) => [s.slot, s.value, s.parts])).toEqual([
      ["payroll", 20_000_00, ["payroll"]],
      ["services", 1_500_00, ["services"]],
      ["office", 2_000_00, ["office"]],
      ["cloud", 1_000_00, ["cloud"]],
      ["software", 500_00, ["software"]],
      ["rest", 500_00, ["marketing", "travel"]],
    ]);
    expect(view.chart.total).toBe(25_500_00);
    expect(view.chart.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
  });

  test("the slots never move: a category that is absent leaves no gap and repaints nothing", () => {
    const view = allCosts({ lens: "group", companies: [US, KZ], fx: FX });
    if (view.chart.kind !== "drawn") throw new Error("expected a chart");
    expect(view.chart.segments.map((s) => s.slot)).toEqual(["payroll", "office", "cloud", "software"]);
    expect(CHART_SLOTS).toEqual(["payroll", "services", "office", "cloud", "software", "rest"]);
  });

  test("a figure not known is no chart: the parts would not be the whole", () => {
    const us = company("us", known(20_000_00), { cloud: { kind: "unknown", reason: "no_rate" }, software: known(500_00) });
    expect(allCosts({ lens: "us", companies: [us], fx: null }).chart).toEqual({ kind: "not_drawn", reason: "not_known" });
  });
});

describe("sorting the rows", () => {
  const view = allCosts({ lens: "group", companies: [US, KZ], fx: FX });
  const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

  test("by the group's figure, the largest first, by default", () => {
    expect(readSort(new URLSearchParams(""), "group")).toEqual({ key: "group", dir: "desc" });
    expect(keys(sortRows(view.rows, { key: "group", dir: "desc" }))).toEqual(["payroll", "cloud", "office", "software"]);
  });

  test("by one company's column, a figure not known always last", () => {
    const short = allCosts({
      lens: "group",
      companies: [US, { ...KZ, register: { kind: "known", runRate: { office: { kind: "unknown", reason: "no_rate" }, cloud: known(250_000_00) }, cashDue: known(0), lines: [] } }],
      fx: FX,
    });
    expect(keys(sortRows(short.rows, { key: "kz", dir: "desc" }))).toEqual(["payroll", "cloud", "software", "office"]);
    expect(keys(sortRows(short.rows, { key: "kz", dir: "asc" }))).toEqual(["software", "cloud", "payroll", "office"]);
  });

  test("by category name, and by share as by the figure", () => {
    expect(keys(sortRows(view.rows, { key: "category", dir: "asc" }))).toEqual(["cloud", "office", "payroll", "software"]);
    expect(keys(sortRows(view.rows, { key: "share", dir: "asc" }))).toEqual(["software", "office", "cloud", "payroll"]);
  });

  test("a click: a figure the largest first, a name from A; a second click turns it round", () => {
    expect(nextSort({ key: "group", dir: "desc" }, "kz")).toEqual({ key: "kz", dir: "desc" });
    expect(nextSort({ key: "group", dir: "desc" }, "category")).toEqual({ key: "category", dir: "asc" });
    expect(nextSort({ key: "kz", dir: "desc" }, "kz")).toEqual({ key: "kz", dir: "asc" });
    expect(nextSort({ key: "kz", dir: "asc" }, "kz")).toEqual({ key: "kz", dir: "desc" });
  });

  test("the sort lives in the address, beside whatever else is there", () => {
    const params = new URLSearchParams("metric=cash&scope=kz");
    const written = writeSort(params, { key: "kz", dir: "asc" }, "group");
    expect(written).toBe("metric=cash&scope=kz&costs-sort=kz&costs-dir=asc");
    expect(readSort(new URLSearchParams(written), "group")).toEqual({ key: "kz", dir: "asc" });
    // The default writes nothing.
    expect(writeSort(new URLSearchParams(written), { key: "group", dir: "desc" }, "group")).toBe("metric=cash&scope=kz");
  });

  test("a column the lens does not have is the lens's default", () => {
    expect(readSort(new URLSearchParams("costs-sort=kz&costs-dir=asc"), "us")).toEqual({ key: "us", dir: "desc" });
    expect(readSort(new URLSearchParams("costs-sort=group"), "kz")).toEqual({ key: "kz", dir: "desc" });
    expect(readSort(new URLSearchParams("costs-sort=nonsense"), "group")).toEqual({ key: "group", dir: "desc" });
  });
});
