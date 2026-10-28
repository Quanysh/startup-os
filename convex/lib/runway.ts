// Runway scenarios: where cash goes month by month from today's cash and
// today's net burn, with "what if" changes on top. Pure: the Finance plan
// page and the owner's agent (the `budget` tool) both read this one module.
//
// Money is whole minor units (cents, tiyn). A month is "YYYY-MM". Nothing
// here reads a clock: the month the projection starts in is handed in.
//
// A missing number is not a zero. With no cash or no burn there is no
// projection ("Not known yet"), and a change in another currency with no
// exchange rate on record is never converted at a guess.

import { addMonths, kztToUsd } from "./costs";
import type { Currency } from "./metricRegistry";

/** How far a projection reaches. */
export const PROJECTION_MONTHS = 24;

/** The kinds of change a scenario holds. */
export const CHANGE_KINDS = ["hire", "cost", "revenue", "cash_in", "cash_out"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  hire: "Hire",
  cost: "Cost",
  revenue: "Revenue",
  cash_in: "Cash in, once",
  cash_out: "Cash out, once",
};

/** A change that happens once, in its start month; the rest are monthly. */
export const isOneOff = (kind: ChangeKind) => kind === "cash_in" || kind === "cash_out";

export type Change = {
  kind: ChangeKind;
  label: string;
  /** "YYYY-MM": the first month it applies; a one-off's only month. */
  startMonth: string;
  /** "YYYY-MM", inclusive. Not read for a one-off. */
  endMonth: string | null;
  /**
   * Minor units. A hire's monthly total cost (salary and the company's taxes),
   * a cost's or revenue's monthly change (negative for a saving or a loss),
   * or a one-off's amount.
   */
  amount: number;
  currency: Currency;
};

/** Whether a change applies in a month. */
export function appliesIn(change: Pick<Change, "kind" | "startMonth" | "endMonth">, month: string) {
  if (isOneOff(change.kind)) return month === change.startMonth;
  return change.startMonth <= month && (change.endMonth === null || month <= change.endMonth);
}

/**
 * What a change does to a month's cash, in its own currency: a hire and a
 * cost take it out, revenue and cash in bring it in.
 */
export function monthlyDelta(change: Change, month: string): number {
  if (!appliesIn(change, month)) return 0;
  switch (change.kind) {
    case "hire":
    case "cost":
    case "cash_out":
      return -change.amount;
    case "revenue":
    case "cash_in":
      return change.amount;
  }
}

/** An amount in another currency, at so many tenge to the dollar. Null with no usable rate. */
export function convert(minor: number, from: Currency, to: Currency, fxUsdKzt: number | null) {
  if (from === to) return minor;
  if (fxUsdKzt === null || !Number.isFinite(fxUsdKzt) || fxUsdKzt <= 0) return null;
  return from === "USD" ? Math.round(minor * fxUsdKzt) : kztToUsd(minor, fxUsdKzt);
}

export type RunOut = { kind: "month"; month: string } | { kind: "beyond" };

export type Projection =
  | { kind: "unknown"; reason: "no_cash" | "no_burn" | "no_rate" }
  | {
      kind: "projected";
      currency: Currency;
      /** Each month's month-end cash, the starting month first. */
      months: { month: string; cash: number }[];
      /** The first month that ends with cash below zero, or "beyond" the 24. */
      runOut: RunOut;
    };

/**
 * Month-end cash for 24 months from `startMonth` (the month in progress):
 * the cash now, less the net burn each month (positive is burning), plus
 * what each change does that month. Cash runs out in the first month that
 * ends below zero; a month that ends at exactly zero has not.
 */
export function project(input: {
  startMonth: string;
  currency: Currency;
  /** Today's balance, or null where it is not known. */
  cash: number | null;
  /** The average monthly net burn the Finance page shows, or null where it has none. */
  netBurn: number | null;
  changes: readonly Change[];
  fxUsdKzt: number | null;
}): Projection {
  const { startMonth, currency, cash, netBurn, changes, fxUsdKzt } = input;
  if (cash === null || !Number.isFinite(cash)) return { kind: "unknown", reason: "no_cash" };
  if (netBurn === null || !Number.isFinite(netBurn)) return { kind: "unknown", reason: "no_burn" };

  // Each change in the projection's currency, once.
  const own: Change[] = [];
  for (const change of changes) {
    const amount = convert(change.amount, change.currency, currency, fxUsdKzt);
    if (amount === null) return { kind: "unknown", reason: "no_rate" };
    own.push({ ...change, amount, currency });
  }

  const months: { month: string; cash: number }[] = [];
  let runOut: RunOut = { kind: "beyond" };
  let balance = cash;
  for (let i = 0; i < PROJECTION_MONTHS; i += 1) {
    const month = addMonths(startMonth, i);
    balance += own.reduce((sum, change) => sum + monthlyDelta(change, month), -netBurn);
    months.push({ month, cash: balance });
    if (balance < 0 && runOut.kind === "beyond") runOut = { kind: "month", month };
  }
  return { kind: "projected", currency, months, runOut };
}

/**
 * The mean actual spend over `months` (the months the average net burn is
 * of, as "YYYY-MM-01" or "YYYY-MM"), from the actuals by "YYYY-MM". A month
 * with no actual makes it not known: a part is not the whole.
 */
export function averageSpend(months: readonly string[], actuals: ReadonlyMap<string, number>): number | null {
  if (months.length === 0) return null;
  let sum = 0;
  for (const month of months) {
    const spent = actuals.get(month.slice(0, 7));
    if (spent === undefined) return null;
    sum += spent;
  }
  return Math.round(sum / months.length);
}

export type BudgetProjection =
  | { kind: "unknown"; reason: "no_cash" | "no_burn" | "no_spend" | "no_budget" }
  | Extract<Projection, { kind: "projected" }>;

/**
 * Month-end cash if the company spends its budget: for each of the budget's
 * months from `startMonth`, cash less that month's budget, plus money in as
 * it has been (the average actual spend less the average net burn, over the
 * same months). Only as far as the budget reaches: "beyond" means past its
 * last month, not past 24. A budget month that is not known, or that leaves
 * a register out (the caller passes null), makes it not known: a budget
 * short of pay would flatter the runway.
 */
export function projectBudget(input: {
  startMonth: string;
  currency: Currency;
  cash: number | null;
  /** The average monthly net burn the Finance page shows. */
  netBurn: number | null;
  /** The average actual spend over the months that burn is of. */
  spend: number | null;
  /** The budget's total for each month from `startMonth`, or null where it is not whole. */
  budget: readonly (number | null)[];
}): BudgetProjection {
  const { startMonth, currency, cash, netBurn, spend, budget } = input;
  if (cash === null || !Number.isFinite(cash)) return { kind: "unknown", reason: "no_cash" };
  if (netBurn === null || !Number.isFinite(netBurn)) return { kind: "unknown", reason: "no_burn" };
  if (spend === null || !Number.isFinite(spend)) return { kind: "unknown", reason: "no_spend" };
  if (budget.length === 0 || budget.some((total) => total === null)) return { kind: "unknown", reason: "no_budget" };
  const moneyIn = spend - netBurn;
  const months: { month: string; cash: number }[] = [];
  let runOut: RunOut = { kind: "beyond" };
  let balance = cash;
  budget.forEach((total, i) => {
    const month = addMonths(startMonth, i);
    balance += moneyIn - total!;
    months.push({ month, cash: balance });
    if (balance < 0 && runOut.kind === "beyond") runOut = { kind: "month", month };
  });
  return { kind: "projected", currency, months, runOut };
}
