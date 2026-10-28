// Rows for the finance page's money in and out. Pure, so the page stays a layout.

import type { Point } from "./derive";
import { readWhole } from "./finance";

/** One month of a chart: a value per series, null where there is no figure. */
export type MonthRow = {
  periodStart: string;
  values: Record<string, number | null>;
  /** Why this month should not be read like the others: "partial", "so far". */
  note?: "partial" | "so far";
};

/**
 * Money in and out by month, oldest first, before financing: "in" is cash in
 * less the financing recorded for the month, as net burn counts it, so one
 * round does not flatten every other bar. Where financing exceeds cash in
 * (one of the two was typed wrong) there is no figure for "in", and the month
 * is "partial".
 *
 * The month in progress is marked "so far". So is a past month Mercury last
 * read before it ended ("partial"): its totals hold what that run saw, not
 * the month. `usFlowsReadAt` is when Mercury's last successful run finished,
 * null when none is on record.
 */
export function cashFlowRows(
  cashIn: readonly Point[],
  cashOut: readonly Point[],
  financing: readonly Point[],
  currentMonth: string,
  usFlowsReadAt: number | null,
): MonthRow[] {
  const ins = new Map(cashIn.map((x) => [x.periodStart, x.value]));
  const outs = new Map(cashOut.map((x) => [x.periodStart, x.value]));
  const financed = new Map(financing.map((x) => [x.periodStart, x.value]));
  return [...new Set([...ins.keys(), ...outs.keys()])].sort().map((periodStart) => {
    const cameIn = ins.get(periodStart);
    const outside = financed.get(periodStart) ?? 0;
    const impossible = cameIn !== undefined && outside > cameIn;
    const short = periodStart < currentMonth && !readWhole(periodStart, usFlowsReadAt);
    const note: MonthRow["note"] =
      periodStart === currentMonth ? "so far" : impossible || short ? "partial" : undefined;
    return {
      periodStart,
      values: {
        in: cameIn === undefined || impossible ? null : cameIn - outside,
        out: outs.get(periodStart) ?? null,
      },
      ...(note ? { note } : {}),
    };
  });
}

/**
 * The financing the chart leaves out of "Cash in": what is recorded for the
 * months it shows, oldest first.
 */
export function financingLeftOut(rows: readonly MonthRow[], financing: readonly Point[]): Point[] {
  const shown = new Set(rows.map((row) => row.periodStart));
  return financing
    .filter((x) => x.value > 0 && shown.has(x.periodStart))
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}
