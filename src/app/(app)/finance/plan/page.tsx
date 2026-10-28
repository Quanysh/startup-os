"use client";

import { BudgetGroup } from "@/components/budget/budget-group";
import { BudgetView } from "@/components/budget/budget-view";
import { FinanceTabs } from "@/components/finance/finance-tabs";
import { BOTH_COMPANIES_NOTE, LensControl, lensesOf, useLens } from "@/components/finance/lens";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { costMonthOf } from "@/lib/costs/view";

/**
 * Budget and runway: a tab of the Finance page (the `finance` area). Like
 * the Overview it does not follow the sidebar's company switch: a viewer on
 * both companies picks the group (each company's budget beside the other's,
 * and the group's in dollars) or one company, in the lens the Overview uses;
 * a viewer on one company has that company's. A budget is one company's, in
 * its own currency, filled from its Payroll and Costs.
 */
export default function FinancePlanPage() {
  const viewer = useViewer();
  const lenses = lensesOf(viewer.companies);
  const lens = useLens(lenses);
  const now = useNow();

  return (
    <div className="space-y-6">
      {/* The tab reads the Finance page's figures (Mercury's actuals, the
          cash and burn behind the runway): the same sources, said the same way. */}
      <PageHeader
        title="Finance"
        purpose="What the company budgets, what it spent, and how long the cash lasts if things change."
        aside={<PageFreshness page="finance" />}
      />
      {lenses.length > 1 && <p className="-mt-4 max-w-xl text-xs text-ink-3">{BOTH_COMPANIES_NOTE}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FinanceTabs current="/finance/plan" />
        {lens !== null && <LensControl lenses={lenses} lens={lens} />}
      </div>

      {now === null || lens === null ? (
        <Skeleton className="h-80 rounded-card" />
      ) : lens === "group" ? (
        <BudgetGroup currentMonth={costMonthOf(now)} />
      ) : (
        <BudgetView key={lens} company={lens} currentMonth={costMonthOf(now)} />
      )}
    </div>
  );
}
