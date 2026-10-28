import { describe, expect, test } from "vitest";
import type { PayrollLineRow } from "@convex/lib/payroll";
import type { Tile } from "@/lib/metrics/scorecard";
import {
  unitEconomics,
  windowOf,
  type CompanyUnitEconomics,
  type UnitCostLine,
  type UnitCustomer,
  type UnitInput,
  type UnitPerson,
} from "./unit-economics";

// Every name, amount, rate and date here is made up. The figures are worked
// out by hand in the comments, so a change to the arithmetic shows up as a
// sum that no longer matches.

const MONTH = "2026-10";
const FX = 500; // tenge to the dollar

/** A monthly tile: its points, the newest last, as the scorecard sends one. */
function tile(key: string, scope: string, points: [month: string, value: number][], currency: string | null = null): Tile {
  const series = points.map(([month, value]) => ({ periodStart: `${month}-01`, value }));
  const newest = series.at(-1);
  return {
    key,
    scope,
    latest:
      newest === undefined
        ? null
        : { value: newest.value, periodStart: newest.periodStart, currency, source: "made_up", syncedAt: 1 },
    firstPeriodStart: series[0]?.periodStart ?? null,
    series,
  };
}

const KZ_TILES: Tile[] = [
  tile("mrr", "kz", [["2026-08", 5_800_000], ["2026-09", 6_000_000]], "KZT"),
  tile("paying_clinics", "kz", [["2026-09", 24]]),
  tile("logo_churn_monthly", "kz", [["2026-09", 2]]),
  // The month in progress is month to date: never read as a month's cost.
  tile("ai_token_cost", "kz_product", [["2026-08", 50], ["2026-09", 60], ["2026-10", 7]], "USD"),
  tile("ai_token_clinics", "kz_product", [["2026-09", 40], ["2026-10", 12]]),
  tile("fx_usd_kzt", "company", [["2026-09", FX]]),
];

const line = (extra: Partial<UnitCostLine> & Pick<UnitCostLine, "name" | "category" | "amount">): UnitCostLine => ({
  id: extra.name,
  currency: "KZT",
  cadence: "monthly",
  startsOn: "2026-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
  bucket: null,
  ...extra,
});

const KZ_LINES: UnitCostLine[] = [
  // COGS by default (cloud): ₸300,000 a month.
  line({ name: "Example Cloud", category: "cloud", amount: 300_000_00 }),
  // COGS by choice: ₸50,000 a month.
  line({ name: "Example CRM", category: "software", amount: 50_000_00, bucket: "cogs" }),
  // Cloud the owner marked as running the company: in neither.
  line({ name: "Example Backups", category: "cloud", amount: 40_000_00, bucket: "operating" }),
  // Running the company by default.
  line({ name: "Example Rent", category: "office", amount: 600_000_00 }),
  // Sales and marketing by default, from August: ₸200,000 a month.
  line({ name: "Example Clinic events", category: "marketing", amount: 200_000_00, startsOn: "2026-08" }),
  // Paid once, in July: ₸2,100,000 to an agency. No run-rate at all.
  line({ name: "Example Agency", category: "marketing", amount: 2_100_000_00, cadence: "once", startsOn: "2026-07" }),
  // A yearly tool from August: ₸120,000 paid whole in August (a run-rate of ₸10,000).
  line({ name: "Example Ads tool", category: "software", amount: 120_000_00, cadence: "yearly", startsOn: "2026-08", bucket: "sales_marketing" }),
];

/** A company-paid line of 10% for employees: a person's cost is gross × 1.1. */
const KZ_PAY_LINES: PayrollLineRow[] = [
  {
    id: "kz-levy",
    name: "Made-up employer levy",
    paidBy: "company",
    rateBp: 1_000,
    lessLineIds: [],
    allowance: 0,
    baseCap: null,
    appliesTo: "employee",
    order: 0,
    active: true,
  },
];

const person = (extra: Partial<UnitPerson> & Pick<UnitPerson, "id">): UnitPerson => ({
  name: `Person ${extra.id}`,
  kind: "employee",
  currency: "KZT",
  payBasis: "gross",
  monthlyGross: 0,
  order: 0,
  cogsPercent: 0,
  salesPercent: 0,
  ...extra,
});

const KZ_PEOPLE: UnitPerson[] = [
  // Costs ₸1,100,000; half of it serving customers: ₸550,000 in COGS.
  person({ id: "a", monthlyGross: 1_000_000_00, cogsPercent: 50 }),
  // Costs ₸550,000; 40% selling: ₸220,000 a month in CAC.
  person({ id: "b", monthlyGross: 500_000_00, salesPercent: 40 }),
];

const clinic = (market: "us" | "kz", contractDate: string | null, archived = false): UnitCustomer => ({
  market,
  contractDate,
  archived,
});

const KZ_CLINICS: UnitCustomer[] = [
  clinic("kz", "2026-06-30"), // before the window
  clinic("kz", "2026-07-01"),
  clinic("kz", "2026-08-12"),
  clinic("kz", "2026-08-20"),
  clinic("kz", "2026-09-30"),
  clinic("kz", "2026-10-01"), // the month in progress: not a complete month
  clinic("kz", "2026-08-15", true), // archived: no longer in the register
  clinic("us", "2026-08-15"), // the other company's
  clinic("kz", null), // no contract date: not counted, and said
];

const kzInput = (extra: Partial<UnitInput> = {}): UnitInput => ({
  company: "kz",
  month: MONTH,
  fx: FX,
  tiles: KZ_TILES,
  costLines: KZ_LINES,
  payroll: { people: KZ_PEOPLE, lines: KZ_PAY_LINES },
  customers: KZ_CLINICS,
  ...extra,
});

const value = (figure: CompanyUnitEconomics[keyof CompanyUnitEconomics]) => {
  if (typeof figure !== "object" || figure === null || !("kind" in figure) || figure.kind !== "known") {
    throw new Error(`not known: ${JSON.stringify(figure)}`);
  }
  return (figure as { value: number }).value;
};

describe("the window", () => {
  test("the three complete months before the month in progress, oldest first", () => {
    expect(windowOf("2026-10")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(windowOf("2026-02")).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("Globex, worked by hand", () => {
  const ue = unitEconomics(kzInput());

  test("in tenge, for the month in progress, over July to September", () => {
    expect(ue.currency).toBe("KZT");
    expect(ue.window).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(ue.stage).toBe("measured");
  });

  test("paying customers and revenue per customer: the latest MRR ÷ the latest count", () => {
    expect(ue.paying).toEqual({ kind: "known", value: 24, excludes: [] });
    expect(ue.payingMonth).toBe("2026-09");
    expect(ue.mrrMonth).toBe("2026-09");
    // ₸6,000,000 ÷ 24 = ₸250,000.
    expect(value(ue.revenuePerCustomer)).toBe(250_000_00);
  });

  test("COGS: COGS lines' run-rate + pay × time serving customers + last month's AI tokens in tenge", () => {
    // ₸300,000 cloud + ₸50,000 CRM + ₸550,000 pay + $60 × 500 = ₸30,000 tokens = ₸930,000.
    expect(ue.cogs).toEqual({ kind: "known", value: 930_000_00, excludes: [] });
    expect(ue.cogsMade.costs).toEqual({
      kind: "known",
      total: 350_000_00,
      parts: [
        { category: "cloud", amount: 300_000_00 },
        { category: "software", amount: 50_000_00 },
      ],
    });
    // Of ₸1,650,000 of pay, ₸550,000 is marked as serving customers: a third.
    expect(ue.cogsMade.pay).toEqual({ kind: "known", amount: 550_000_00, share: 550_000 / 1_650_000 });
    expect(ue.cogsMade.tokens).toEqual({
      kind: "known",
      usd: 60_00,
      amount: 30_000_00,
      month: "2026-09",
      clinics: 40,
    });
    // ₸930,000 ÷ 24 = ₸38,750.
    expect(value(ue.cogsPerCustomer)).toBe(38_750_00);
  });

  test("gross margin: (MRR − COGS) ÷ MRR", () => {
    // (6,000,000 − 930,000) ÷ 6,000,000 = 0.845.
    expect(value(ue.grossMargin)).toBeCloseTo(0.845, 10);
  });

  test("CAC: what was paid for sales and marketing over the three months ÷ the clinics contracted in them", () => {
    // July: the agency ₸2,100,000 + pay ₸220,000 = ₸2,320,000.
    // August: events ₸200,000 + the yearly tool whole ₸120,000 + pay ₸220,000 = ₸540,000.
    // September: events ₸200,000 + pay ₸220,000 = ₸420,000. Together ₸3,280,000.
    expect(ue.smSpend).toEqual({ kind: "known", value: 3_280_000_00, excludes: [] });
    expect(ue.smMade.costs).toEqual({
      kind: "known",
      total: 2_620_000_00,
      parts: [
        { category: "software", amount: 120_000_00 },
        { category: "marketing", amount: 2_500_000_00 },
      ],
    });
    expect(ue.smMade.pay).toEqual({ kind: "known", amount: 660_000_00, share: 660_000 / 4_950_000 });
    expect(ue.smMade.tokens).toBeNull();
    // July 1, August 12 and 20, September 30: four. Not June, October, the
    // archived one, Startup's, or the one with no date (which is said).
    expect(ue.newCustomers).toEqual({ kind: "known", value: 4, excludes: [] });
    expect(ue.undated).toBe(1);
    // ₸3,280,000 ÷ 4 = ₸820,000.
    expect(value(ue.cac)).toBe(820_000_00);
  });

  test("CAC payback, LTV and LTV:CAC", () => {
    // 820,000 ÷ (250,000 × 0.845 = 211,250) = 3.8816… months.
    expect(value(ue.cacPayback)).toBeCloseTo(820_000 / 211_250, 10);
    // 211,250 ÷ 2% = ₸10,562,500.
    expect(value(ue.ltv)).toBe(10_562_500_00);
    expect(value(ue.ltvToCac)).toBeCloseTo(10_562_500 / 820_000, 10);
    expect(ue.churnMonth).toBe("2026-09");
  });
});

describe("what CAC's spend is", () => {
  test("a one-off marketing payment counts in its own month, though it has no run-rate", () => {
    const once = [line({ name: "Example Agency", category: "marketing", amount: 2_100_000_00, cadence: "once", startsOn: "2026-08" })];
    const ue = unitEconomics(kzInput({ costLines: once, payroll: { people: [], lines: [] } }));
    expect(ue.smSpend).toEqual({ kind: "known", value: 2_100_000_00, excludes: [] });
    // In the month in progress it is not in the window at all.
    const now = [line({ name: "Example Agency", category: "marketing", amount: 2_100_000_00, cadence: "once", startsOn: "2026-10" })];
    expect(unitEconomics(kzInput({ costLines: now, payroll: { people: [], lines: [] } })).smSpend).toEqual({
      kind: "known",
      value: 0,
      excludes: [],
    });
  });

  test("a payment in another month of the window is that month's, a quarterly one whole when it falls", () => {
    const lines = [
      line({ name: "Example Agency", category: "marketing", amount: 300_000_00, cadence: "quarterly", startsOn: "2026-06" }),
    ];
    // June, September: only September is in the window.
    const ue = unitEconomics(kzInput({ costLines: lines, payroll: { people: [], lines: [] } }));
    expect(value(ue.smSpend)).toBe(300_000_00);
  });

  test("a clinic won on the Sales board is a new customer only with a monthly fee on record", () => {
    const won = (monthlyFee: number | null): UnitCustomer => ({ ...clinic("kz", "2026-09-20"), fromSales: true, monthlyFee });
    const ue = unitEconomics(kzInput({ customers: [clinic("kz", "2026-08-12"), won(null), won(250_000)] }));
    // The register's clinic and the won one with a fee: two. The one without a fee may not pay.
    expect(ue.newCustomers).toEqual({ kind: "known", value: 2, excludes: [] });
  });

  test("no new customer in the three months: CAC is not known, never zero or infinite", () => {
    const ue = unitEconomics(kzInput({ customers: [clinic("kz", "2026-05-01")] }));
    expect(ue.newCustomers).toEqual({ kind: "known", value: 0, excludes: [] });
    expect(ue.cac).toEqual({ kind: "unknown", why: "no_new_customers" });
    expect(ue.cacPayback).toEqual({ kind: "unknown", why: "no_new_customers" });
    expect(ue.ltvToCac).toEqual({ kind: "unknown", why: "no_new_customers" });
    // The rest stands.
    expect(value(ue.ltv)).toBe(10_562_500_00);
  });
});

describe("AI tokens", () => {
  test("no figure for last month: COGS is not known, and so is all that rests on it", () => {
    const tiles = KZ_TILES.map((t) =>
      t.key === "ai_token_cost" ? tile("ai_token_cost", "kz_product", [["2026-08", 50], ["2026-10", 7]], "USD") : t,
    );
    const ue = unitEconomics(kzInput({ tiles }));
    expect(ue.cogsMade.tokens).toEqual({ kind: "unknown", why: "no_tokens", month: "2026-09" });
    expect(ue.cogs).toEqual({ kind: "unknown", why: "no_tokens" });
    expect(ue.cogsPerCustomer).toEqual({ kind: "unknown", why: "no_tokens" });
    expect(ue.grossMargin).toEqual({ kind: "unknown", why: "no_tokens" });
    expect(ue.cacPayback).toEqual({ kind: "unknown", why: "no_tokens" });
    expect(ue.ltv).toEqual({ kind: "unknown", why: "no_tokens" });
    // CAC holds no tokens.
    expect(value(ue.cac)).toBe(820_000_00);
  });

  test("no tile at all is the same; no USD/KZT rate makes the dollars not known", () => {
    const ue = unitEconomics(kzInput({ tiles: KZ_TILES.filter((t) => t.key !== "ai_token_cost") }));
    expect(ue.cogs).toEqual({ kind: "unknown", why: "no_tokens" });
    const noRate = unitEconomics(kzInput({ fx: null }));
    expect(noRate.cogsMade.tokens).toEqual({ kind: "unknown", why: "no_rate", month: "2026-09" });
    expect(noRate.cogs).toEqual({ kind: "unknown", why: "no_rate" });
  });

  test("Startup has no token figure: its COGS is its lines and pay alone", () => {
    const ue = unitEconomics({
      company: "us",
      month: MONTH,
      fx: FX,
      tiles: [tile("mrr", "us", [["2026-09", 10_000]], "USD"), tile("paying_clinics", "us", [["2026-09", 4]])],
      costLines: [line({ name: "Example Hosting", category: "cloud", amount: 500_00, currency: "USD" })],
      payroll: { people: [], lines: [] },
      customers: [],
    });
    expect(ue.cogsMade.tokens).toBeNull();
    expect(ue.cogs).toEqual({ kind: "known", value: 500_00, excludes: [] });
    // (10,000 − 500) ÷ 10,000.
    expect(value(ue.grossMargin)).toBeCloseTo(0.95, 10);
    // No churn figure is kept for Startup.
    expect(ue.ltv).toEqual({ kind: "unknown", why: "no_churn" });
  });
});

describe("what the viewer does not hold is hidden, never a zero", () => {
  test("without Payroll: COGS and the spend leave pay out and say so; nothing set against them is given", () => {
    const ue = unitEconomics(kzInput({ payroll: null }));
    expect(ue.cogsMade.pay).toEqual({ kind: "hidden" });
    // ₸350,000 of lines + ₸30,000 of tokens.
    expect(ue.cogs).toEqual({ kind: "known", value: 380_000_00, excludes: ["payroll"] });
    expect(ue.cogsPerCustomer).toEqual({ kind: "known", value: Math.round(380_000_00 / 24), excludes: ["payroll"] });
    expect(ue.grossMargin).toEqual({ kind: "hidden", needs: ["payroll"] });
    expect(ue.smSpend).toEqual({ kind: "known", value: 2_620_000_00, excludes: ["payroll"] });
    expect(ue.cac).toEqual({ kind: "hidden", needs: ["payroll"] });
    expect(ue.cacPayback).toEqual({ kind: "hidden", needs: ["payroll"] });
    expect(ue.ltv).toEqual({ kind: "hidden", needs: ["payroll"] });
    expect(ue.ltvToCac).toEqual({ kind: "hidden", needs: ["payroll"] });
    // What needs neither register stands.
    expect(value(ue.revenuePerCustomer)).toBe(250_000_00);
  });

  test("without Costs: the lines are left out the same way", () => {
    const ue = unitEconomics(kzInput({ costLines: null }));
    expect(ue.cogsMade.costs).toEqual({ kind: "hidden" });
    // ₸550,000 pay + ₸30,000 tokens.
    expect(ue.cogs).toEqual({ kind: "known", value: 580_000_00, excludes: ["costs"] });
    expect(ue.grossMargin).toEqual({ kind: "hidden", needs: ["costs"] });
  });

  test("with neither register COGS and the spend are hidden, whatever the tokens", () => {
    const ue = unitEconomics(kzInput({ costLines: null, payroll: null }));
    expect(ue.cogs).toEqual({ kind: "hidden", needs: ["costs", "payroll"] });
    expect(ue.smSpend).toEqual({ kind: "hidden", needs: ["costs", "payroll"] });
    expect(ue.grossMargin).toEqual({ kind: "hidden", needs: ["costs", "payroll"] });
  });

  test("without the Customers page: new customers, and CAC with them, are hidden", () => {
    const ue = unitEconomics(kzInput({ customers: null }));
    expect(ue.newCustomers).toEqual({ kind: "hidden", needs: ["customers"] });
    expect(ue.undated).toBeNull();
    expect(ue.cac).toEqual({ kind: "hidden", needs: ["customers"] });
    expect(value(ue.grossMargin)).toBeCloseTo(0.845, 10);
  });

  test("anything still on its way makes what rests on it loading", () => {
    const ue = unitEconomics(kzInput({ costLines: undefined, customers: undefined }));
    expect(ue.cogs).toEqual({ kind: "loading" });
    expect(ue.newCustomers).toEqual({ kind: "loading" });
    expect(ue.cac).toEqual({ kind: "loading" });
    expect(value(ue.revenuePerCustomer)).toBe(250_000_00);
    expect(unitEconomics(kzInput({ payroll: { people: undefined, lines: KZ_PAY_LINES } })).cogs).toEqual({ kind: "loading" });
  });
});

describe("pay", () => {
  test("a person marked with time whose cost is not known makes it not known; one marked 0% does not", () => {
    const unset = [{ ...KZ_PAY_LINES[0]!, rateBp: null }];
    const marked = unitEconomics(kzInput({ payroll: { people: KZ_PEOPLE, lines: unset } }));
    expect(marked.cogs).toEqual({ kind: "unknown", why: "rates" });
    expect(marked.smSpend).toEqual({ kind: "unknown", why: "rates" });
    const nobody = unitEconomics(
      kzInput({ payroll: { people: [person({ id: "c", monthlyGross: 700_000_00 })], lines: unset } }),
    );
    expect(nobody.cogsMade.pay).toEqual({ kind: "known", amount: 0, share: null });
    expect(nobody.cogs).toEqual({ kind: "known", value: 380_000_00, excludes: [] });
  });

  test("only the months a person is on payroll count", () => {
    // Starts in September: one month of ₸220,000 in the spend, not three.
    const late = [person({ id: "b", monthlyGross: 500_000_00, salesPercent: 40, startDate: "2026-09-15" })];
    const ue = unitEconomics(kzInput({ costLines: [], payroll: { people: late, lines: KZ_PAY_LINES } }));
    expect(value(ue.smSpend)).toBe(220_000_00);
  });

  test("someone paid in dollars is counted in tenge at the rate, and not known without one", () => {
    const dollars = [person({ id: "d", currency: "USD", monthlyGross: 2_000_00, cogsPercent: 100 })];
    // A dollar-paid employee is held to the tenge levy only where it is computed; here: gross alone.
    const ue = unitEconomics(kzInput({ costLines: [], payroll: { people: dollars, lines: [] } }));
    // $2,000 × 500 = ₸1,000,000, + ₸30,000 tokens.
    expect(value(ue.cogs)).toBe(1_030_000_00);
    expect(unitEconomics(kzInput({ costLines: [], fx: null, payroll: { people: dollars, lines: [] } })).cogsMade.pay).toEqual({
      kind: "unknown",
      why: "no_rate",
    });
  });
});

describe("revenue", () => {
  test("no paying customers yet (MRR 0): the company's stage says so, and nothing per customer is given", () => {
    const ue = unitEconomics({
      company: "us",
      month: MONTH,
      fx: FX,
      tiles: [tile("mrr", "us", [["2026-09", 0]], "USD")],
      costLines: [],
      payroll: { people: [], lines: [] },
      customers: [],
    });
    expect(ue.stage).toBe("no_customers_yet");
    // No count is on record, and none is made up: MRR of nothing is no paying customer to divide by.
    expect(ue.paying).toEqual({ kind: "unknown", why: "no_paying" });
    expect(ue.revenuePerCustomer).toEqual({ kind: "unknown", why: "no_customers" });
    expect(ue.cogsPerCustomer).toEqual({ kind: "unknown", why: "no_customers" });
    expect(ue.grossMargin).toEqual({ kind: "unknown", why: "no_revenue" });
  });

  test("zero paying clinics: nothing per customer; no MRR figure: not known", () => {
    const zero = unitEconomics(kzInput({ tiles: [...KZ_TILES.filter((t) => t.key !== "paying_clinics"), tile("paying_clinics", "kz", [["2026-09", 0]])] }));
    expect(zero.stage).toBe("no_customers_yet");
    expect(zero.revenuePerCustomer).toEqual({ kind: "unknown", why: "no_customers" });
    expect(zero.cogsPerCustomer).toEqual({ kind: "unknown", why: "no_customers" });
    const noMrr = unitEconomics(kzInput({ tiles: KZ_TILES.filter((t) => t.key !== "mrr") }));
    expect(noMrr.stage).toBe("measured");
    expect(noMrr.revenuePerCustomer).toEqual({ kind: "unknown", why: "no_mrr" });
    expect(noMrr.grossMargin).toEqual({ kind: "unknown", why: "no_mrr" });
  });

  test("a margin at or below zero never pays back and has no lifetime value", () => {
    const thin = [...KZ_TILES.filter((t) => t.key !== "mrr"), tile("mrr", "kz", [["2026-09", 900_000]], "KZT")];
    const ue = unitEconomics(kzInput({ tiles: thin }));
    // (900,000 − 930,000) ÷ 900,000 < 0.
    expect(value(ue.grossMargin)).toBeLessThan(0);
    expect(ue.cacPayback).toEqual({ kind: "unknown", why: "no_margin" });
    expect(ue.ltv).toEqual({ kind: "unknown", why: "no_margin" });
  });

  test("no client has churned: lifetime value cannot be worked out", () => {
    const tiles = [...KZ_TILES.filter((t) => t.key !== "logo_churn_monthly"), tile("logo_churn_monthly", "kz", [["2026-09", 0]])];
    expect(unitEconomics(kzInput({ tiles })).ltv).toEqual({ kind: "unknown", why: "no_churn_yet" });
  });
});
