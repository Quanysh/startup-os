// Each hero figure against the same figure a month before. Pure, and read by
// the Finance page alone; nothing here reads a clock (the summary carries the
// month in progress).
//
// A missing number is not a zero: a figure with nothing to compare against
// has no trend ("unknown"), never a change from 0. "A month before" is worked
// out by the same rules as today's figure, so the two can be compared:
//   cash     the month-end before today's balance (`monthCloses`): last
//            month's for Mercury's daily balance, the one before for a typed
//            month-end; Kazakhstan's tenge at today's rate, so a move in the
//            rate is not read as a move in cash;
//   net burn the average of the three complete months before last month
//            (`averageBurn`), withheld whenever today's average is;
//   runway   those two divided.

import { periodStart, previousPeriodStart } from "@convex/lib/periods";
import type { Point } from "@convex/lib/attention/metricDerive";
import { averageBurn, monthCloses, type FinanceSummary } from "@/lib/metrics/finance";

export type Trend =
  | {
      kind: "change";
      /** Now less before, in the figure's own unit. */
      diff: number;
      /** `diff` as a share of the figure before; null from a figure of zero. */
      ratio: number | null;
      /** The month compared against (its first day). */
      versus: string;
    }
  | { kind: "unknown" };

const known = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** A figure now against the same figure before. Either one missing: no trend. */
export function trendOf(now: number | null, before: number | null, versus: string): Trend {
  if (!known(now) || !known(before)) return { kind: "unknown" };
  const diff = now - before;
  return { kind: "change", diff, ratio: before === 0 ? null : diff / before, versus };
}

/** A month's closing balance from daily balances (`monthCloses`), or null where none closes it. */
export function closeOf(daily: readonly Point[], month: string): number | null {
  return monthCloses(daily).find((close) => close.periodStart === month)?.value ?? null;
}

/** The month before the summary's month in progress. */
export const lastMonthOf = (summary: Pick<FinanceSummary, "currentMonth">) =>
  previousPeriodStart("month", summary.currentMonth);

/**
 * The month-end before a balance: the close of the month before the one the
 * balance is in, or before the one it closes. A balance typed on the 30th,
 * or on the 1st of the next month, is itself a month-end, and is compared
 * with the one before it, never with itself.
 */
function previousClose(daily: readonly Point[], balanceDay: string): { month: string; value: number } | null {
  const closes = monthCloses(daily);
  const own =
    closes.find((close) => close.date === balanceDay)?.periodStart ??
    periodStart("month", Date.parse(`${balanceDay}T00:00:00Z`));
  const month = previousPeriodStart("month", own);
  const close = closes.find((c) => c.periodStart === month);
  return close === undefined ? null : { month, value: close.value };
}

/**
 * Cash at the month-end before today's balance, for the markets in view: in
 * dollars (tenge at today's rate, the one today's figure used) and, in one
 * market's view, in that market's own currency. `month` is that month-end's
 * month where every market's is the same one. Null where today's total is
 * not whole, or where a market in view has no such close.
 */
export function cashBefore(
  summary: Pick<FinanceSummary, "cash" | "markets">,
  daily: { us: readonly Point[]; kz: readonly Point[] },
): { usd: number; native: number | null; month: string | null } | null {
  const { cash, markets } = summary;
  if (cash === null || cash.missing.length > 0) return null;
  // Whole cash with tenge in it always carries the rate it was converted at.
  const rate = cash.rate;
  let usd = 0;
  const months = new Set<string>();
  let native: number | null = null;
  for (const market of markets) {
    const part = cash.parts.find((p) => p.scope === market);
    if (part === undefined) return null;
    const close = previousClose(daily[market], part.periodStart);
    if (close === null) return null;
    months.add(close.month);
    if (market === "us") {
      usd += close.value;
    } else {
      if (rate === null) return null;
      usd += close.value / rate;
    }
    native = markets.length === 1 ? close.value : null;
  }
  return { usd, native, month: months.size === 1 ? [...months][0]! : null };
}

/**
 * The average net burn as it stood a month ago: the complete months among
 * the three before last month. Null whenever today's average is withheld
 * (a market not reporting withholds both), or none of those months is complete.
 */
export function burnBefore(summary: Pick<FinanceSummary, "average" | "burn" | "currentMonth">): number | null {
  if (summary.average === null) return null;
  return averageBurn(summary.burn, lastMonthOf(summary))?.value ?? null;
}

/** Runway a month ago: cash then over burn then. Only while burning, and only with both known. */
export function runwayBefore(cashUsd: number | null, burnUsd: number | null): number | null {
  if (!known(cashUsd) || !known(burnUsd) || burnUsd <= 0) return null;
  return cashUsd / burnUsd;
}
