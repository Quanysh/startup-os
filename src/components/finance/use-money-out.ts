"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { mercuryActuals } from "@convex/lib/budget";
import type { CompanyId } from "@convex/lib/company";
import { addMonths, firstDayOf, summarise as costSummary } from "@convex/lib/costs";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import { featureOn } from "@convex/lib/featureGates";
import { summarise as paySummary } from "@convex/lib/payroll";
import { useViewer } from "@/hooks/use-viewer";
import { payOf, type Pay } from "@/lib/costs/planned";
import {
  costsShare,
  payrollShare,
  remainderOf,
  sentShare,
  type MoneyOut,
  type MoneyOutRow,
} from "@/lib/finance/money-out";
import { cashFlowRows } from "@/lib/metrics/finance-rows";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";

export type { MoneyOut, MoneyOutRow } from "@/lib/finance/money-out";

/** How many finished months the section looks back over. */
export const MONEY_OUT_MONTHS = 6;

/**
 * The months before the one in progress, each with its money out and what
 * the registers say of it, for one company, and for Startup what it sent
 * Globex (`cash_to_subsidiary`). Composed in the browser from the
 * functions the Budget tab, Payroll and Costs already use: Payroll's are asked
 * for only by a viewer who holds Payroll, and Costs' only by one who holds
 * Costs. Anyone else sends no such query (the server would refuse it) and is
 * told where the figures are, never shown one.
 */
export function useMoneyOut(
  company: CompanyId,
  currentMonth: string,
  card: { tiles: readonly Tile[]; sources: SourceStates },
): MoneyOut | undefined {
  const viewer = useViewer();
  const holdsPayroll = viewer.can("payroll");
  const holdsCosts = viewer.can("costs");
  const first = addMonths(currentMonth, -MONEY_OUT_MONTHS);
  // Globex's actual spend is the figure typed on the Budget tab; Startup's is Mercury's.
  const budget = useQuery(
    api.budget.view,
    company === "kz" ? { company, first, count: MONEY_OUT_MONTHS } : "skip",
  );
  const own = holdsPayroll ? { company } : "skip";
  const people = useQuery(api.payroll.listPeople, own);
  const payLines = useQuery(api.payroll.listLines, own);
  const runs = useQuery(api.payroll.listRuns, own);
  const costLines = useQuery(api.costs.list, holdsCosts ? { company } : "skip");

  return useMemo(() => {
    if (company === "kz" && budget === undefined) return undefined;
    const currency = MARKET_CURRENCY[company];
    const months = Array.from({ length: MONEY_OUT_MONTHS }, (_, i) => addMonths(first, i));
    const series = (key: string) =>
      card.tiles.find((tile) => tile.key === key && tile.scope === "us")?.series ?? [];
    const fx = card.tiles.find((tile) => tile.key === "fx_usd_kzt")?.latest?.value ?? null;
    const readAt = card.sources.mercury?.lastOkAt ?? null;

    const actuals =
      company === "us"
        ? mercuryActuals(series("cash_out"), currentMonth, readAt)
        : new Map((budget?.actuals ?? []).filter((row) => row.month < currentMonth).map((row) => [row.month, row.amount]));
    // What Startup sent Globex, inside its money out, for the months Mercury
    // read whole. A month read before it was counted has none: not a zero.
    // None where no subsidiary is funded from Mercury (convex/lib/features.ts).
    const sentByMonth =
      company === "us" && featureOn("subsidiaryFunding")
        ? mercuryActuals(series("cash_to_subsidiary"), currentMonth, readAt)
        : null;
    // Cash in less financing, for months Mercury read whole: the chart's note
    // ("partial") marks the rest, and those have no figure here.
    const moneyIn = new Map(
      company === "us"
        ? cashFlowRows(series("cash_in"), series("cash_out"), series("financing_in"), firstDayOf(currentMonth), readAt).flatMap(
            (row) =>
              row.note === undefined && row.values.in != null
                ? [[row.periodStart.slice(0, 7), Math.round(row.values.in * 100)] as const]
                : [],
          )
        : [],
    );

    const paidRuns = new Map((runs ?? []).filter((run) => run.status === "paid").map((run) => [run.month.slice(0, 7), run.totals]));
    const liveOf = (month: string): Pay => {
      if (!holdsPayroll) return { kind: "no_access" };
      if (people === undefined || payLines === undefined || runs === undefined) return { kind: "loading" };
      try {
        return payOf(paySummary({ people, lines: payLines, month: firstDayOf(month), companyCurrency: currency }));
      } catch {
        // Lines that subtract each other in a circle: payroll's own word for it.
        return payOf(null);
      }
    };

    const rows = months.map((month): MoneyOutRow => {
      const actual = actuals.get(month) ?? null;
      const live = liveOf(month);
      const payroll = payrollShare({
        paid: live.kind === "no_access" || live.kind === "loading" ? null : (paidRuns.get(month) ?? null),
        live,
        currency,
        fx,
      });
      const costs = costsShare(
        !holdsCosts
          ? "hidden"
          : costLines === undefined
            ? "loading"
            : costSummary({ lines: costLines, month, companyCurrency: currency, fxUsdKzt: fx }),
        currency,
        fx,
      );
      const sent = sentByMonth === null ? null : sentShare(actual, sentByMonth.get(month) ?? null);
      return {
        month,
        actual,
        moneyIn: moneyIn.get(month) ?? null,
        payroll,
        costs,
        sent,
        remainder: remainderOf(actual, payroll, costs, sent),
      };
    });
    return { currency, fx, rows, holdsPayroll, holdsCosts };
  }, [company, budget, card, currentMonth, first, holdsPayroll, holdsCosts, people, payLines, runs, costLines]);
}
