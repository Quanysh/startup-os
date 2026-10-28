"use client";

import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { budgetMonths, categoryVsRunRate, planVsActual } from "@convex/lib/budget";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { addMonths, firstDayOf } from "@convex/lib/costs";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/errors";
import { formatPeriod } from "@/lib/format";
import { ActualTable } from "./actual-table";
import { BudgetGrid, type CellSave } from "./budget-grid";
import { CategoryTable } from "./category-table";
import { RunwaySection } from "./runway-section";
import { ACTUAL_MONTHS_BEFORE, useBudgetData } from "./use-budget-data";

/** One company's budget and runway, in its own currency. */
export function BudgetView({ company, currentMonth }: { company: CompanyId; currentMonth: string }) {
  const data = useBudgetData(company, currentMonth);
  const setCells = useMutation(api.budget.setCells);
  const setActual = useMutation(api.budget.setActual);
  const [saveError, setSaveError] = useState<string | null>(null);
  const id = useId();

  if (data === undefined) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-80 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }

  const months = budgetMonths(currentMonth);
  const actualMonths = Array.from({ length: ACTUAL_MONTHS_BEFORE + 1 }, (_, i) =>
    addMonths(currentMonth, i - ACTUAL_MONTHS_BEFORE),
  );
  const save = async (next: CellSave[]) => {
    try {
      await setCells({ company, cells: next });
      setSaveError(null);
    } catch (e) {
      setSaveError(messageOf(e));
      throw e;
    }
  };
  const thisMonth = formatPeriod("month", firstDayOf(currentMonth));
  const name = COMPANIES[company].name;
  const heading = (what: string) => `${id}-${what}`;

  return (
    <div className="space-y-6">
      <Panel aria-labelledby={heading("runway")} className="space-y-4">
        <div>
          <h2 id={heading("runway")} className="text-base">
            Runway · {name}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Month-end cash for the next 24 months, in {data.currency}. Cash runs out in the first month it ends
            below zero.
          </p>
        </div>
        <RunwaySection
          company={company}
          currency={data.currency}
          currentMonth={currentMonth}
          start={data.start}
          fx={data.fx}
          scenarios={data.scenarios}
          payrollLines={data.payrollLines}
          onBudget={data.onBudget}
        />
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel aria-labelledby={heading("against-actual")} className="min-w-0 space-y-3">
          <h2 id={heading("against-actual")} className="text-base">
            Budget against actual · {name}
          </h2>
          <ActualTable
            rows={planVsActual(actualMonths, data.cells, data.actuals)}
            currency={data.currency}
            source={company === "us" ? "mercury" : "typed"}
            onSetActual={
              company === "kz"
                ? async (month, amount) => {
                    try {
                      await setActual({ company, month, amount });
                      setSaveError(null);
                    } catch (e) {
                      setSaveError(messageOf(e));
                      throw e;
                    }
                  }
                : undefined
            }
          />
        </Panel>
        <Panel aria-labelledby={heading("against-run-rate")} className="min-w-0 space-y-3">
          <h2 id={heading("against-run-rate")} className="text-base">
            Budget against the cost register, {thisMonth} · {name}
          </h2>
          {data.runRate === undefined ? (
            <Skeleton className="h-40 rounded-inner" />
          ) : (
            <CategoryTable
              rows={data.runRate === null ? null : categoryVsRunRate(currentMonth, data.cells, data.runRate)}
              currency={data.currency}
              monthName={thisMonth}
            />
          )}
        </Panel>
      </div>

      <Panel aria-labelledby={heading("budget")} className="space-y-4">
        <div>
          <h2 id={heading("budget")} className="text-base">
            Budget · {name}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            The next 12 months, in {data.currency}, filled from Payroll (that month&apos;s total cost) and Costs
            (what falls due that month) as they stand now. Type over a figure to set your own; it saves when you
            leave the cell, and <span className="whitespace-nowrap">↺</span> puts the register&apos;s figure back.
          </p>
        </div>
        {saveError !== null && (
          <p role="alert" className="text-sm text-danger-ink">
            {saveError}
          </p>
        )}
        <BudgetGrid months={months} currency={data.currency} cells={data.cells} onSave={save} />
      </Panel>
    </div>
  );
}
