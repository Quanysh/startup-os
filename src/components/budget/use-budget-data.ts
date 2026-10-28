"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import {
  BUDGET_MONTHS,
  REGISTERS,
  budgetMonths,
  budgetTotal,
  effectiveBudget,
  startupActuals,
  runRateByCategory,
  runwayInputs,
} from "@convex/lib/budget";
import { averageSpend, projectBudget } from "@convex/lib/runway";
import type { CompanyId } from "@convex/lib/company";
import { addMonths, firstDayOf } from "@convex/lib/costs";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import { SENT_TO_SUBSIDIARY, financeSummary, moneyTilesOf } from "@convex/lib/finance";
import { tilesOf } from "@/lib/company";
import { payrollByMonth, registerFigures } from "@/lib/budget/live";
import { useViewer } from "@/hooks/use-viewer";

/** How many months before the current one the plan-against-actual table shows. */
export const ACTUAL_MONTHS_BEFORE = 6;

/**
 * Everything the plan page reads for one company, from the same functions
 * and pure modules the Finance page and the owner's agent use. The budget is
 * the registers' figures (Payroll's total cost and Costs' cash due, month by
 * month) with what was typed over them. Costs and Payroll are asked for only
 * by a viewer who holds them: every other viewer sends no such query (the
 * server would refuse it), and their rows are hidden.
 */
export function useBudgetData(company: CompanyId, currentMonth: string) {
  const viewer = useViewer();
  const holdsCosts = viewer.can("costs");
  const holdsPayroll = viewer.can("payroll");
  const first = addMonths(currentMonth, -ACTUAL_MONTHS_BEFORE);
  const count = ACTUAL_MONTHS_BEFORE + BUDGET_MONTHS;
  const view = useQuery(api.budget.view, { company, first, count });
  const scenarios = useQuery(api.scenarios.list, { company });
  const card = useQuery(api.metrics.scorecard);
  const kzCash = useQuery(api.metrics.series, company === "kz" ? { key: "cash", scope: "kz", limit: 400 } : "skip");
  const costs = useQuery(api.costs.summary, holdsCosts ? { company, month: currentMonth } : "skip");
  const costLines = useQuery(api.costs.list, holdsCosts ? { company } : "skip");
  const ask = holdsPayroll ? { company } : "skip";
  const people = useQuery(api.payroll.listPeople, ask);
  const payrollLines = useQuery(api.payroll.listLines, ask);
  const runs = useQuery(api.payroll.listRuns, ask);

  return useMemo(() => {
    if (view === undefined || scenarios === undefined || card === undefined) return undefined;
    if (company === "kz" && kzCash === undefined) return undefined;
    const tiles = tilesOf(company, card.tiles);
    const readAt = card.sources.mercury?.lastOkAt ?? null;
    // In Globex's, with what Startup sent it, which its burn takes out.
    const summary = financeSummary(
      moneyTilesOf(company, card.tiles, viewer.companies),
      kzCash ?? [],
      firstDayOf(currentMonth),
      readAt,
      [company],
    );
    const fx = card.tiles.find((tile) => tile.key === "fx_usd_kzt")?.latest?.value ?? null;
    const currency = MARKET_CURRENCY[company];

    // Startup's actual is its own spending: Mercury's money out less what it
    // sent Globex, which is Globex's money and in Globex's actual.
    const usSeries = (key: string) => tiles.find((tile) => tile.key === key && tile.scope === "us")?.series ?? [];
    const actuals =
      company === "us"
        ? startupActuals(usSeries("cash_out"), usSeries(SENT_TO_SUBSIDIARY), currentMonth, readAt)
        : new Map(view.actuals.map((row) => [row.month, row.amount]));

    const pay = payrollByMonth({
      months: view.months,
      holds: holdsPayroll,
      reads: { people, lines: payrollLines, runs },
      currency,
      fx,
    });
    const live = registerFigures({
      months: view.months,
      pay,
      costLines: holdsCosts ? costLines : null,
      currency,
      fx,
    });

    const cells = effectiveBudget(view.months, view.cells, live);
    const start = runwayInputs(summary, company);
    // The budget's next twelve months, each whole or null, for the "On budget" line.
    const ahead = budgetMonths(currentMonth).map((month) => budgetTotal(cells.filter((c) => c.month === month)));
    const leftOut = REGISTERS.filter((r) => ahead.some((t) => t.kind !== "loading" && t.excludes.includes(r)));
    const onBudget = {
      leftOut,
      projection: projectBudget({
        startMonth: currentMonth,
        currency,
        cash: start.cash,
        netBurn: start.netBurn,
        spend: averageSpend(summary.average?.months ?? [], actuals),
        budget: ahead.map((t) => (t.kind === "known" && t.excludes.length === 0 ? t.amount : null)),
      }),
    };

    return {
      view,
      currency,
      scenarios,
      actuals,
      fx,
      summary,
      /** Every month the page shows, each category: typed over the registers' figures. */
      cells,
      start,
      onBudget,
      runRate: holdsCosts ? (costs === undefined ? undefined : runRateByCategory(costs.currencies, currency, fx)) : null,
      payrollLines: holdsPayroll ? payrollLines : null,
    };
  }, [view, scenarios, card, kzCash, company, currentMonth, holdsPayroll, holdsCosts, people, payrollLines, runs, costLines, costs, viewer.companies]);
}

export type BudgetData = NonNullable<ReturnType<typeof useBudgetData>>;
