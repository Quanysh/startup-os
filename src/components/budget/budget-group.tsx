"use client";

import { useId } from "react";
import { budgetMonths, budgetTotal, type BudgetCell, type BudgetTotal } from "@convex/lib/budget";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { firstDayOf } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { Panel } from "@/components/panel";
import {
  Blank,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { groupBudgetTotal } from "@/lib/finance/group";
import { formatMinor, formatPeriod } from "@/lib/format";
import { NOT_KNOWN, registersWords } from "./budget-grid";
import { useBudgetData, type BudgetData } from "./use-budget-data";

// Each company's own currency, from its identity (convex/lib/identity.ts).
const CURRENCY: Record<CompanyId, Currency> = { us: COMPANIES.us.currency, kz: COMPANIES.kz.currency };

function Total({ total, currency }: { total: BudgetTotal; currency: Currency }) {
  if (total.kind === "known") return <>{formatMinor(total.amount, currency)}</>;
  if (total.kind === "loading") return <Blank>…</Blank>;
  if (total.kind === "hidden") return <Blank />;
  return <Blank>{NOT_KNOWN}</Blank>;
}

/**
 * The group's budget, for a viewer on both companies: each company's monthly
 * total in its own currency, and the group's in dollars (Globex's tenge
 * at the stored rate; "Not known yet" without one, or while either company's
 * is not known). Each company's grid, its actual and its runway are under its
 * own name: a budget is typed in its company's currency, and runway
 * projections are never added.
 */
export function BudgetGroup({ currentMonth }: { currentMonth: string }) {
  const us = useBudgetData("us", currentMonth);
  const kz = useBudgetData("kz", currentMonth);
  const heading = useId();
  if (us === undefined || kz === undefined) {
    return <Skeleton className="h-80 rounded-card" aria-busy />;
  }
  return <Loaded us={us} kz={kz} currentMonth={currentMonth} heading={heading} />;
}

function Loaded({
  us,
  kz,
  currentMonth,
  heading,
}: {
  us: BudgetData;
  kz: BudgetData;
  currentMonth: string;
  heading: string;
}) {
  const months = budgetMonths(currentMonth);
  const fx = us.fx ?? kz.fx;
  const of = (cells: readonly BudgetCell[], month: string | null) =>
    budgetTotal(cells.filter((c) => (month === null ? months.includes(c.month) : c.month === month)));
  const rows = [...months.map((month) => month as string | null), null].map((month) => {
    const own = { us: of(us.cells, month), kz: of(kz.cells, month) };
    return { month, own, group: groupBudgetTotal(own.us, own.kz, fx) };
  });
  const body = rows.slice(0, -1);
  const year = rows.at(-1)!;
  const nothing = year.own.us.kind === "hidden" && year.own.kz.kind === "hidden";
  const excludes = "excludes" in year.group ? year.group.excludes : [];

  return (
    <Panel aria-labelledby={heading} className="space-y-4">
      <div>
        <h2 id={heading} className="text-base">
          Budget, both companies
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          The next 12 months: each company&apos;s budget in its own currency, filled from its Payroll and Costs,
          and the group&apos;s in US dollars
          {fx === null ? "." : `, ${COMPANIES.kz.name}'s tenge at ₸${fx.toLocaleString("en-US")} per $1.`} Pick {COMPANIES.us.name} or{" "}
          {COMPANIES.kz.name} above for its grid, its budget against actual and its runway.
        </p>
      </div>
      {nothing ? (
        <p className="text-sm text-ink-2">
          The budget is Payroll&apos;s and Costs&apos; figures, which are on those pages: you do not hold them, so
          there is nothing here for you to see.
        </p>
      ) : (
        <>
          <DataTable caption="Each company's budget and the group's, by month">
            <DataHead>
              <DataHeader pinned>Month</DataHeader>
              <DataHeader numeric>{COMPANIES.us.name}</DataHeader>
              <DataHeader numeric>{COMPANIES.kz.name}</DataHeader>
              <DataHeader numeric strong>
                Group, USD
              </DataHeader>
            </DataHead>
            <DataBody>
              {body.map(({ month, own, group }) => (
                <DataRow key={month}>
                  <DataRowHeader pinned>{formatPeriod("month", firstDayOf(month!))}</DataRowHeader>
                  <DataCell numeric>
                    <Total total={own.us} currency={CURRENCY.us} />
                  </DataCell>
                  <DataCell numeric>
                    <Total total={own.kz} currency={CURRENCY.kz} />
                  </DataCell>
                  <DataCell numeric strong>
                    <GroupFigure group={group} />
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
            <DataFoot>
              <DataRow plain>
                <DataRowHeader pinned>12 months</DataRowHeader>
                <DataCell numeric>
                  <Total total={year.own.us} currency={CURRENCY.us} />
                </DataCell>
                <DataCell numeric>
                  <Total total={year.own.kz} currency={CURRENCY.kz} />
                </DataCell>
                <DataCell numeric strong>
                  <GroupFigure group={year.group} />
                </DataCell>
              </DataRow>
            </DataFoot>
          </DataTable>
          {excludes.length > 0 && (
            <p className="text-xs text-ink-2">
              {`Totals exclude ${registersWords(excludes)}: ${
                excludes.length > 1 ? "those pages are" : `the ${registersWords(excludes)} page is`
              } not yours to see.`}
            </p>
          )}
          {fx === null && (
            <p className="text-xs text-ink-2">
              The group&apos;s figures wait for a USD/KZT rate: it arrives with the CFO workbook.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function GroupFigure({ group }: { group: ReturnType<typeof groupBudgetTotal> }) {
  if ("kind" in group) return <Blank>…</Blank>;
  return group.amount.kind === "known" ? <>{formatMinor(group.amount.usd, "USD")}</> : <Blank>{NOT_KNOWN}</Blank>;
}
