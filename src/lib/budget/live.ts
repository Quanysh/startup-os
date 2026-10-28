// The registers' figures for the budget, worked out in the browser for a
// viewer who holds each page: the Payroll row from payroll's own functions
// (a paid month's frozen total cost, else `summarise` over the people on the
// payroll that month at today's rates, as the Payroll page shows it), and the
// Costs rows from the cost register's cash due (`cashDueLive`). A register the
// viewer does not hold is `hidden`: nothing of it was asked for.

import type { BudgetCategory, Live } from "@convex/lib/budget";
import { cashDueLive } from "@convex/lib/budget";
import { firstDayOf, type CostCategory, type CostLine } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { summarise, type CurrencyTotals, type PayPerson, type PayrollLineRow } from "@convex/lib/payroll";
import { payOf, type Pay } from "@/lib/costs/planned";
import { payrollShare, type PayrollShare } from "@/lib/finance/money-out";

/** A payroll share as the budget counts it. */
export function liveOfPay(share: PayrollShare): Live {
  switch (share.kind) {
    case "known":
      return { kind: "known", amount: share.amount };
    case "unknown":
      return { kind: "unknown", reason: share.reason };
    default:
      return share;
  }
}

/** What Payroll's queries returned, or undefined while one is loading. */
export type PayrollReads = {
  people: readonly PayPerson[] | undefined;
  lines: readonly PayrollLineRow[] | undefined;
  runs: readonly { month: string; status: string; totals: readonly CurrencyTotals[] }[] | undefined;
};

/**
 * Each month's payroll total cost in the company's currency: the month's
 * frozen total when it was marked paid, else payroll's own `summarise` over
 * today's people and rates for that month. Hidden for a viewer without the
 * Payroll page (nothing was asked for), loading until every read is in.
 */
export function payrollByMonth(input: {
  months: readonly string[];
  holds: boolean;
  reads: PayrollReads;
  currency: Currency;
  fx: number | null;
}): Map<string, PayrollShare> {
  const { months, holds, reads, currency, fx } = input;
  const out = new Map<string, PayrollShare>();
  const { people, lines, runs } = reads;
  const paid = new Map(
    (runs ?? []).filter((run) => run.status === "paid").map((run) => [run.month.slice(0, 7), run.totals]),
  );
  for (const month of months) {
    let live: Pay;
    if (!holds) live = { kind: "no_access" };
    else if (people === undefined || lines === undefined || runs === undefined) live = { kind: "loading" };
    else {
      try {
        live = payOf(summarise({ people, lines, month: firstDayOf(month), companyCurrency: currency }));
      } catch {
        // Lines that subtract each other in a circle: payroll's own word for it.
        live = payOf(null);
      }
    }
    const frozen = live.kind === "known" || live.kind === "unknown" ? (paid.get(month) ?? null) : null;
    out.set(month, payrollShare({ paid: frozen, live, currency, fx }));
  }
  return out;
}

/**
 * The registers' figure for each budget cell: Payroll's by month, and each
 * Costs category's cash due. `costLines` is null for a viewer who does not
 * hold Costs, undefined while it loads.
 */
export function registerFigures(input: {
  months: readonly string[];
  pay: ReadonlyMap<string, PayrollShare>;
  costLines: readonly CostLine[] | null | undefined;
  currency: Currency;
  fx: number | null;
}): (category: BudgetCategory, month: string) => Live {
  const { months, pay, costLines, currency, fx } = input;
  const due = new Map(
    costLines ? months.map((month) => [month, cashDueLive(costLines, month, currency, fx)] as const) : [],
  );
  return (category, month) => {
    if (category === "payroll") {
      const share = pay.get(month);
      return share === undefined ? { kind: "loading" } : liveOfPay(share);
    }
    if (costLines === null) return { kind: "hidden" };
    if (costLines === undefined) return { kind: "loading" };
    return (due.get(month) ?? cashDueLive(costLines, month, currency, fx))[category as CostCategory];
  };
}
