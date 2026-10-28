// Planned burn: what the company plans to spend a month. The cost lines'
// run-rate (convex/lib/costs.ts) plus what payroll comes to (payroll's own
// summary, convex/lib/payroll.ts), for a viewer who holds both pages. Pure:
// it adds what those two worked out and works out nothing of its own.
//
// A missing number is not a zero. Pay that is not known, or not this
// viewer's to see, is left out and said to be; a total that would need an
// exchange rate nobody recorded is not known.

import { kztToUsd, type CostSummary } from "@convex/lib/costs";
import { CURRENCIES, type Currency } from "@convex/lib/metricRegistry";
import { isWhole, type CurrencySummary } from "@convex/lib/payroll";

/** What pay comes to, as far as this viewer may know it. */
export type Pay =
  /** The viewer does not hold the Payroll page: nothing of pay was asked for. */
  | { kind: "no_access" }
  | { kind: "loading" }
  /** Payroll's total cost is not known for everyone (rates not set), or its lines are in a circle. */
  | { kind: "unknown"; reason: "rates" | "circle" }
  /** The total cost per currency, for the currencies somebody is paid in. None: nobody is on payroll. */
  | { kind: "known"; parts: { currency: Currency; cost: number }[] };

/**
 * Pay from payroll's own summary (`summarise`): its total cost, and only when
 * that is known for every person. Null is what the page holds when the lines
 * subtract each other in a circle.
 */
export function payOf(summary: readonly CurrencySummary[] | null): Pay {
  if (summary === null) return { kind: "unknown", reason: "circle" };
  const paid = summary.filter((set) => set.overall.people > 0);
  if (paid.some((set) => !isWhole(set.overall.cost, set.overall))) {
    return { kind: "unknown", reason: "rates" };
  }
  return { kind: "known", parts: paid.map((set) => ({ currency: set.currency, cost: set.overall.cost.sum })) };
}

/** An amount in one currency (with the rate, where it was converted), or not known for want of a rate. */
export type Amount =
  | { kind: "amount"; currency: Currency; minor: number; rate?: number }
  | { kind: "unknown" };

type ByCurrency = Record<Currency, number>;
const none = (): ByCurrency => ({ USD: 0, KZT: 0 });

/** One amount from sums per currency: the one in play, or US dollars at the rate, or not known. */
function amountOf(sums: ByCurrency, fallback: Currency, fxRate: number | null): Amount {
  const inPlay = CURRENCIES.filter((currency) => sums[currency] > 0);
  if (inPlay.length === 0) return { kind: "amount", currency: fallback, minor: 0 };
  if (inPlay.length === 1) return { kind: "amount", currency: inPlay[0]!, minor: sums[inPlay[0]!] };
  if (fxRate === null || !Number.isFinite(fxRate) || fxRate <= 0) return { kind: "unknown" };
  return { kind: "amount", currency: "USD", minor: sums.USD + kztToUsd(sums.KZT, fxRate), rate: fxRate };
}

export type Planned = {
  /** Whether pay is in `total`. */
  includesPay: boolean;
  /** Why it is not; null when it is. */
  payOut: null | "no_access" | "rates" | "circle" | "loading";
  /** Run-rate costs, plus pay when it is included. */
  total: Amount;
  /** The cost lines' run-rate alone. */
  costs: Amount;
  /** What pay comes to; null when it is left out. */
  pay: Amount | null;
  /** Each currency's own share, for when the total is not known. */
  parts: { currency: Currency; costs: number; pay: number }[];
};

export function plannedBurn(input: { costs: CostSummary; pay: Pay; fxRate: number | null }): Planned {
  const { costs, pay, fxRate } = input;
  // The company's own currency when nothing is in play.
  const fallback = costs.currencies[0]!.currency;
  const costSums = none();
  for (const set of costs.currencies) costSums[set.currency] += set.runRate;
  const paySums = none();
  const includesPay = pay.kind === "known";
  if (pay.kind === "known") for (const part of pay.parts) paySums[part.currency] += part.cost;

  const total = none();
  for (const currency of CURRENCIES) total[currency] = costSums[currency] + paySums[currency];

  return {
    includesPay,
    payOut: pay.kind === "known" ? null : pay.kind === "unknown" ? pay.reason : pay.kind,
    total: amountOf(total, fallback, fxRate),
    costs: amountOf(costSums, fallback, fxRate),
    pay: includesPay ? amountOf(paySums, fallback, fxRate) : null,
    parts: CURRENCIES.filter((currency) => total[currency] > 0).map((currency) => ({
      currency,
      costs: costSums[currency],
      pay: paySums[currency],
    })),
  };
}

/** Planned burn beside the actual net burn the Finance page shows, both in US dollar minor units. */
export type Comparison =
  | { kind: "compared"; plannedUsd: number; actualUsd: number; difference: number }
  | { kind: "not_compared"; reason: "pay_out" | "planned_unknown" | "no_actual" | "no_rate" };

/**
 * `actualUsd` is the Finance page's average net burn in dollars, or null
 * where it has none. Compared only when the plan holds pay and is known: a
 * plan short of pay set against what was spent would read as a saving.
 */
export function compare(planned: Planned, actualUsd: number | null, fxRate: number | null): Comparison {
  if (!planned.includesPay) return { kind: "not_compared", reason: "pay_out" };
  if (planned.total.kind === "unknown") return { kind: "not_compared", reason: "planned_unknown" };
  if (actualUsd === null || !Number.isFinite(actualUsd)) return { kind: "not_compared", reason: "no_actual" };
  let plannedUsd = planned.total.minor;
  if (planned.total.currency === "KZT") {
    if (fxRate === null || !Number.isFinite(fxRate) || fxRate <= 0) {
      return { kind: "not_compared", reason: "no_rate" };
    }
    plannedUsd = kztToUsd(planned.total.minor, fxRate);
  }
  const actual = Math.round(actualUsd * 100);
  return { kind: "compared", plannedUsd, actualUsd: actual, difference: plannedUsd - actual };
}
