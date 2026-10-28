// Unit economics: what one paying customer brings in and costs, per company,
// in the company's own currency. Pure, read by the Finance page alone, which
// composes its inputs in the browser from what the registers already send (as
// All costs does). Nothing here reads a clock: the month in progress is
// handed in.
//
//   paying customers      the latest `paying_clinics`
//   revenue / customer    the latest MRR ÷ paying customers
//   COGS / month          this month's run-rate of the cost lines counted as
//                         COGS (`bucketOf`) + each person's total cost (gross
//                         and company-paid, payroll's own `summarise`) × their
//                         time serving customers + AI tokens (Globex's last
//                         complete month, dollars to tenge at the stored rate)
//   gross margin          (MRR − COGS) ÷ MRR
//   CAC                   sales and marketing paid over the last three
//                         complete months (each month's cash due of the lines
//                         counted as sales and marketing: a one-off in its own
//                         month, a yearly bill whole in its month; + pay × time
//                         on sales and marketing) ÷ the clinics whose contract
//                         date falls in those months
//   CAC payback (months)  CAC ÷ (revenue per customer × gross margin)
//   LTV                   revenue per customer × gross margin ÷ monthly churn
//   LTV:CAC               LTV ÷ CAC
//
// A missing number is not a zero. Each figure is known, not known (with why),
// hidden (the viewer does not hold a register it needs: nothing of it was
// asked for) or loading. A sum the viewer holds only part of (COGS without
// Payroll, say) is given with what it excludes, as All costs gives a total;
// a ratio is never worked out from such a part, which would flatter it.

import type { CompanyId } from "@convex/lib/company";
import {
  COST_CATEGORIES,
  addMonths,
  bucketOf,
  cashDueOf,
  firstDayOf,
  runRateOf,
  type CostBucket,
  type CostCategory,
  type CostLine,
} from "@convex/lib/costs";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import type { Currency } from "@convex/lib/metricRegistry";
import { summarise, type PayPerson, type PayrollLineRow } from "@convex/lib/payroll";
import { convert } from "@convex/lib/runway";
import { payOf } from "@/lib/costs/planned";
import type { Tile } from "@/lib/metrics/scorecard";

// ── What goes in ────────────────────────────────────────────────────────────

/** A cost line as `costs.list` returns it, as far as this needs. */
export type UnitCostLine = CostLine & { id: string; name: string; bucket: CostBucket | null };

/** A person as `payroll.listPeople` returns them, with their two shares of time. */
export type UnitPerson = PayPerson & { cogsPercent: number; salesPercent: number };

/**
 * A clinic as `customers.list` returns it, as far as this needs. One won on
 * the Sales board (`fromSales`) counts as a new customer only with a monthly
 * fee on record: without one it may not pay at all.
 */
export type UnitCustomer = {
  market: CompanyId;
  contractDate: string | null;
  archived: boolean;
  fromSales?: boolean;
  monthlyFee?: number | null;
};

export type UnitInput = {
  company: CompanyId;
  /** The month in progress, "YYYY-MM". */
  month: string;
  /** The newest stored USD/KZT rate, tenge to the dollar; null where none is on record. */
  fx: number | null;
  /** The scorecard's tiles, as the Finance page has them. */
  tiles: readonly Tile[];
  /** `costs.list`: null for a viewer without Costs (nothing asked), undefined while it loads. */
  costLines: readonly UnitCostLine[] | null | undefined;
  /** `payroll.listPeople` / `listLines`: null for a viewer without Payroll. */
  payroll: { people: readonly UnitPerson[] | undefined; lines: readonly PayrollLineRow[] | undefined } | null;
  /** `customers.list`'s clinics: null for a viewer without Customers. */
  customers: readonly UnitCustomer[] | null | undefined;
};

// ── What comes out ──────────────────────────────────────────────────────────

/** A register a figure needs: the page that holds it. */
export type Need = "costs" | "payroll" | "customers";

/** Why a figure is not known. */
export type Why =
  /** No MRR figure on record. */
  | "no_mrr"
  /** No paying customers figure on record. */
  | "no_paying"
  /** No paying customers: nothing is per customer. */
  | "no_customers"
  /** MRR is zero: no margin. */
  | "no_revenue"
  /** No clinic's contract date falls in the three months. */
  | "no_new_customers"
  /** No monthly churn figure is kept for the company. */
  | "no_churn"
  /** Churn is zero: a lifetime with no end. */
  | "no_churn_yet"
  /** A gross margin at or below zero: nothing pays back. */
  | "no_margin"
  /** Last month's AI token cost has not arrived. */
  | "no_tokens"
  /** A pay rate is not set for someone counted. */
  | "rates"
  /** Two pay lines subtract each other in a circle. */
  | "circle"
  /** Dollars or tenge to convert, and no USD/KZT rate on record. */
  | "no_rate";

export type Figure =
  /** `excludes`: registers a sum leaves out because the viewer does not hold them. */
  | { kind: "known"; value: number; excludes: Need[] }
  | { kind: "unknown"; why: Why }
  | { kind: "hidden"; needs: Need[] }
  | { kind: "loading" };

type Part<T> = ({ kind: "known" } & T) | { kind: "unknown"; why: Why } | { kind: "hidden" } | { kind: "loading" };

/** What a COGS or a sales-and-marketing figure is made of, for the page to say. */
export type Made = {
  /** The cost lines counted, by category, in the company's currency. */
  costs: Part<{ total: number; parts: { category: CostCategory; amount: number }[] }>;
  /** Pay counted (the shares of time marked), and its share of all pay in the same months. */
  pay: Part<{ amount: number; share: number | null }>;
  /** AI tokens: last complete month's, in cents and in the company's currency. Null where none is measured. */
  tokens:
    | { kind: "known"; usd: number; amount: number; month: string; clinics: number | null }
    | { kind: "unknown"; why: "no_tokens" | "no_rate"; month: string }
    | null;
};

export type CompanyUnitEconomics = {
  company: CompanyId;
  currency: Currency;
  month: string;
  /** The three complete months CAC is over, oldest first. */
  window: string[];
  /** No paying customers yet (MRR or paying customers at zero), or figures to read. */
  stage: "measured" | "no_customers_yet";
  paying: Figure;
  /** "YYYY-MM" of the figures read; null where there is none. */
  payingMonth: string | null;
  mrr: Figure;
  mrrMonth: string | null;
  revenuePerCustomer: Figure;
  cogs: Figure;
  cogsMade: Made;
  cogsPerCustomer: Figure;
  /** A fraction: 0.845 is 84.5%. */
  grossMargin: Figure;
  newCustomers: Figure;
  /** Clinics of the company with no contract date, not counted in new customers; null when hidden. */
  undated: number | null;
  /** Sales and marketing paid over the window. */
  smSpend: Figure;
  smMade: Made;
  cac: Figure;
  /** Months. */
  cacPayback: Figure;
  /** Monthly logo churn, a percent. */
  churn: Figure;
  churnMonth: string | null;
  ltv: Figure;
  /** A ratio. */
  ltvToCac: Figure;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const known = (value: number, excludes: Need[] = []): Figure => ({ kind: "known", value, excludes });
const unknown = (why: Why): Figure => ({ kind: "unknown", why });

/** The three complete months before the month in progress, oldest first. */
export const windowOf = (month: string): string[] => [-3, -2, -1].map((by) => addMonths(month, by));

/** Which scope a company's AI token cost is kept in, where it is kept. */
const TOKEN_SCOPE: Partial<Record<CompanyId, string>> = { kz: "kz_product" };

function latest(tiles: readonly Tile[], key: string, scope: string): { value: number; month: string } | null {
  const point = tiles.find((t) => t.key === key && t.scope === scope)?.latest;
  return point ? { value: point.value, month: point.periodStart.slice(0, 7) } : null;
}

function pointIn(tiles: readonly Tile[], key: string, scope: string, month: string): number | null {
  const point = tiles
    .find((t) => t.key === key && t.scope === scope)
    ?.series.find((p) => p.periodStart === firstDayOf(month));
  return point === undefined ? null : point.value;
}

/**
 * A figure worked out from others. Something still loading makes it loading;
 * then the first reason one is not known; then whatever registers they need
 * that the viewer does not hold (a sum given without one counts as needing
 * it: a ratio of a part would flatter). Otherwise `work` of their values.
 */
function derive(inputs: readonly Figure[], work: (values: number[]) => Figure): Figure {
  if (inputs.some((f) => f.kind === "loading")) return { kind: "loading" };
  const gap = inputs.find((f) => f.kind === "unknown");
  if (gap !== undefined) return gap;
  const needs = new Set<Need>();
  for (const f of inputs) {
    if (f.kind === "hidden") f.needs.forEach((n) => needs.add(n));
    if (f.kind === "known") f.excludes.forEach((n) => needs.add(n));
  }
  if (needs.size > 0) return { kind: "hidden", needs: ORDER.filter((n) => needs.has(n)) };
  return work(inputs.map((f) => (f as { value: number }).value));
}

const ORDER: readonly Need[] = ["costs", "payroll", "customers"];

/** A sum per customer, keeping what the sum leaves out. */
function perCustomer(sum: Figure, paying: Figure): Figure {
  if (sum.kind === "loading" || paying.kind === "loading") return { kind: "loading" };
  if (paying.kind === "unknown") return paying;
  if (paying.kind !== "known") return paying;
  if (sum.kind !== "known") return sum;
  if (paying.value === 0) return unknown("no_customers");
  return known(Math.round(sum.value / paying.value), sum.excludes);
}

/** A figure from what it is made of: the parts shown, added; what is hidden, left out and named. */
function sumOf(made: Made): Figure {
  const registers: [Need, Made["costs"] | Made["pay"]][] = [
    ["costs", made.costs],
    ["payroll", made.pay],
  ];
  const parts = [...registers.map(([, part]) => part), ...(made.tokens === null ? [] : [made.tokens])];
  if (parts.some((p) => p.kind === "loading")) return { kind: "loading" };
  const hidden = registers.filter(([, part]) => part.kind === "hidden").map(([need]) => need);
  if (hidden.length === registers.length) return { kind: "hidden", needs: hidden };
  const gap = parts.find((p) => p.kind === "unknown");
  if (gap?.kind === "unknown") return unknown(gap.why);
  let total = 0;
  if (made.costs.kind === "known") total += made.costs.total;
  if (made.pay.kind === "known") total += made.pay.amount;
  if (made.tokens?.kind === "known") total += made.tokens.amount;
  return known(total, hidden);
}

// ── The registers' parts ────────────────────────────────────────────────────

/** The lines counted as `bucket`, by category: each month's run-rate, or what fell due. */
function costsPart(
  lines: UnitInput["costLines"],
  bucket: CostBucket,
  months: readonly string[],
  figure: (line: CostLine, month: string) => number,
  currency: Currency,
  fx: number | null,
): Made["costs"] {
  if (lines === null) return { kind: "hidden" };
  if (lines === undefined) return { kind: "loading" };
  const byCategory = new Map<CostCategory, number>();
  for (const line of lines) {
    if (bucketOf(line) !== bucket) continue;
    for (const month of months) {
      const amount = figure(line, month);
      if (amount === 0) continue;
      const converted = convert(amount, line.currency, currency, fx);
      if (converted === null) return { kind: "unknown", why: "no_rate" };
      byCategory.set(line.category, (byCategory.get(line.category) ?? 0) + converted);
    }
  }
  const parts = COST_CATEGORIES.flatMap((category) =>
    byCategory.has(category) ? [{ category, amount: byCategory.get(category)! }] : [],
  );
  return { kind: "known", total: parts.reduce((sum, p) => sum + p.amount, 0), parts };
}

/** One person's total cost in a month (gross and company-paid), in the company's currency. */
function costOf(
  person: UnitPerson,
  lines: readonly PayrollLineRow[],
  month: string,
  currency: Currency,
  fx: number | null,
): { kind: "known"; amount: number } | { kind: "unknown"; why: Why } {
  let pay;
  try {
    pay = payOf(summarise({ people: [person], lines, month: firstDayOf(month), companyCurrency: currency }));
  } catch {
    return { kind: "unknown", why: "circle" };
  }
  if (pay.kind !== "known") return { kind: "unknown", why: pay.kind === "unknown" ? pay.reason : "rates" };
  let amount = 0;
  for (const part of pay.parts) {
    const converted = convert(part.cost, part.currency, currency, fx);
    if (converted === null) return { kind: "unknown", why: "no_rate" };
    amount += converted;
  }
  return { kind: "known", amount };
}

/**
 * Pay counted over some months: each person's cost × their share of time,
 * rounded half up to a whole minor unit. Someone with no share counts for
 * nothing, so a cost not known for them leaves the figure known; only the
 * share of all pay (for the page to say) then cannot be given.
 */
function payPart(
  payroll: UnitInput["payroll"],
  share: (person: UnitPerson) => number,
  months: readonly string[],
  currency: Currency,
  fx: number | null,
): Made["pay"] {
  if (payroll === null) return { kind: "hidden" };
  const { people, lines } = payroll;
  if (people === undefined || lines === undefined) return { kind: "loading" };
  let amount = 0;
  let all: number | null = 0;
  for (const month of months) {
    for (const person of people) {
      const percent = share(person);
      const cost = costOf(person, lines, month, currency, fx);
      if (cost.kind === "unknown") {
        if (percent > 0) return cost;
        all = null;
        continue;
      }
      amount += Math.round((cost.amount * percent) / 100);
      if (all !== null) all += cost.amount;
    }
  }
  return { kind: "known", amount, share: all === null || all === 0 ? null : amount / all };
}

/** Last complete month's AI token cost, in the company's currency. Null where the company has none measured. */
function tokensPart(input: UnitInput, currency: Currency): Made["tokens"] {
  const scope = TOKEN_SCOPE[input.company];
  if (scope === undefined) return null;
  const month = addMonths(input.month, -1);
  const usd = pointIn(input.tiles, "ai_token_cost", scope, month);
  if (usd === null) return { kind: "unknown", why: "no_tokens", month };
  const cents = Math.round(usd * 100);
  const amount = convert(cents, "USD", currency, input.fx);
  if (amount === null) return { kind: "unknown", why: "no_rate", month };
  return { kind: "known", usd: cents, amount, month, clinics: pointIn(input.tiles, "ai_token_clinics", scope, month) };
}

// ── One company ─────────────────────────────────────────────────────────────

export function unitEconomics(input: UnitInput): CompanyUnitEconomics {
  const { company, month, fx, tiles } = input;
  const currency = MARKET_CURRENCY[company];
  const window = windowOf(month);

  const mrrRead = latest(tiles, "mrr", company);
  const payingRead = latest(tiles, "paying_clinics", company);
  const churnRead = latest(tiles, "logo_churn_monthly", company);
  const mrr = mrrRead === null ? unknown("no_mrr") : known(Math.round(mrrRead.value * 100));
  const paying = payingRead === null ? unknown("no_paying") : known(payingRead.value);
  const churn = churnRead === null ? unknown("no_churn") : known(churnRead.value);
  const stage = mrrRead?.value === 0 || payingRead?.value === 0 ? "no_customers_yet" : "measured";

  // What a figure is divided by to be per customer. MRR of nothing is no
  // paying customer to divide by, whether or not a count is on record; the
  // count itself is never made up from it.
  const customers = mrrRead?.value === 0 ? unknown("no_customers") : paying;
  const revenuePerCustomer = derive([mrr, customers], ([m, p]) =>
    p === 0 ? unknown("no_customers") : known(Math.round(m! / p!)),
  );

  const cogsMade: Made = {
    costs: costsPart(input.costLines, "cogs", [month], runRateOf, currency, fx),
    pay: payPart(input.payroll, (person) => person.cogsPercent, [month], currency, fx),
    tokens: tokensPart(input, currency),
  };
  const cogs = sumOf(cogsMade);
  const cogsPerCustomer = perCustomer(cogs, customers);
  const grossMargin = derive([mrr, cogs], ([m, c]) => (m === 0 ? unknown("no_revenue") : known((m! - c!) / m!)));

  const smMade: Made = {
    costs: costsPart(input.costLines, "sales_marketing", window, cashDueOf, currency, fx),
    pay: payPart(input.payroll, (person) => person.salesPercent, window, currency, fx),
    tokens: null,
  };
  const smSpend = sumOf(smMade);

  const clinics = input.customers;
  const theirs =
    clinics?.filter((c) => c.market === company && !c.archived && (c.fromSales !== true || (c.monthlyFee ?? null) !== null)) ?? [];
  const newCustomers: Figure =
    clinics === null
      ? { kind: "hidden", needs: ["customers"] }
      : clinics === undefined
        ? { kind: "loading" }
        : known(theirs.filter((c) => c.contractDate !== null && window.includes(c.contractDate.slice(0, 7))).length);
  const undated = clinics === null || clinics === undefined ? null : theirs.filter((c) => c.contractDate === null).length;

  const cac = derive([smSpend, newCustomers], ([s, n]) =>
    n === 0 ? unknown("no_new_customers") : known(Math.round(s! / n!)),
  );
  const cacPayback = derive([cac, revenuePerCustomer, grossMargin], ([c, r, g]) =>
    g! <= 0 ? unknown("no_margin") : known(c! / (r! * g!)),
  );
  const ltv = derive([revenuePerCustomer, grossMargin, churn], ([r, g, ch]) =>
    g! <= 0 ? unknown("no_margin") : ch === 0 ? unknown("no_churn_yet") : known(Math.round((r! * g!) / (ch! / 100))),
  );
  const ltvToCac = derive([ltv, cac], ([l, c]) => known(l! / c!));

  return {
    company,
    currency,
    month,
    window,
    stage,
    paying,
    payingMonth: payingRead?.month ?? null,
    mrr,
    mrrMonth: mrrRead?.month ?? null,
    revenuePerCustomer,
    cogs,
    cogsMade,
    cogsPerCustomer,
    grossMargin,
    newCustomers,
    undated,
    smSpend,
    smMade,
    cac,
    cacPayback,
    churn,
    churnMonth: churnRead?.month ?? null,
    ltv,
    ltvToCac,
  };
}
