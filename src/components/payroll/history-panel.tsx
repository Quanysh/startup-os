"use client";

import type { Totals } from "@convex/lib/payroll";
import { Panel } from "@/components/panel";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
  type ColumnGroup,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { dayLabel, formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Incomplete, Money, RunStatus, type RunSummary } from "./shared";

type Figure = {
  label: string;
  pick: (totals: Totals) => number;
  /** Teal is what a person is paid, violet what the company pays: as in the month's table. */
  group: ColumnGroup;
  strong?: boolean;
};

/** A month's figures, in the order the month's own table gives them. */
const FIGURES: readonly Figure[] = [
  { label: "Gross", pick: (totals) => totals.gross, group: "teal" },
  { label: "Withheld", pick: (totals) => totals.withheld, group: "teal" },
  { label: "Net", pick: (totals) => totals.net, group: "teal", strong: true },
  { label: "Company-paid", pick: (totals) => totals.companyPaid, group: "violet" },
  { label: "Total cost", pick: (totals) => totals.cost, group: "violet", strong: true },
];

/**
 * Every paid month, newest first, with what it came to. Each one opens in the
 * month's table above. A draft is left out: it only holds a month's
 * adjustments, and its other figures are not the month's.
 */
export function HistoryPanel({
  runs: all,
  now,
  onOpen,
}: {
  runs: readonly RunSummary[] | undefined;
  now: number;
  onOpen: (month: string) => void;
}) {
  const runs = all?.filter((run) => run.status === "paid");
  return (
    <Panel aria-labelledby="payroll-history">
      <h2 id="payroll-history" className="text-base">
        History
      </h2>
      {runs === undefined ? (
        <Skeleton className="mt-3 h-16 rounded-inner" />
      ) : runs.length === 0 ? (
        <p className="mt-2 text-sm text-ink-3">No month has been marked paid yet.</p>
      ) : (
        <DataTable caption="Paid months" className="min-w-[52rem]" boxClassName="mt-2">
          <DataHead>
            <DataHeader pinned>Month</DataHeader>
            <DataHeader>Status</DataHeader>
            <DataHeader numeric>People</DataHeader>
            {FIGURES.map(({ label, group, strong }) => (
              <DataHeader key={label} numeric group={group} strong={strong}>
                {label}
              </DataHeader>
            ))}
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {runs.map((run) => {
              // One line per currency someone is paid in: never added together.
              const sets = run.totals.filter((set) => set.overall.people > 0);
              const incomplete = sets.some((set) => set.overall.notComputed > 0);
              const name = formatPeriod("month", run.month);
              return (
                <DataRow key={run.month} tone={incomplete ? "warning" : undefined}>
                  <DataRowHeader pinned className="whitespace-nowrap">
                    {name}
                  </DataRowHeader>
                  <DataCell className="whitespace-nowrap">
                    <RunStatus status={run.status}>
                      {run.status === "draft"
                        ? "Draft"
                        : run.paidOn === null
                          ? "Paid"
                          : `Paid on ${dayLabel(run.paidOn, now)}`}
                    </RunStatus>
                    {incomplete && (
                      <>
                        <span className="sr-only">, </span>
                        <Incomplete className="ml-1.5" />
                      </>
                    )}
                  </DataCell>
                  <DataCell numeric>{run.people}</DataCell>
                  {FIGURES.map(({ label, pick, group, strong }) => (
                    <DataCell key={label} numeric group={group} strong={strong}>
                      {sets.map((set) => (
                        <span key={set.currency} className="block">
                          <Money minor={pick(set.overall)} currency={set.currency} />
                        </span>
                      ))}
                    </DataCell>
                  ))}
                  <DataCell actions>
                    <button
                      type="button"
                      onClick={() => onOpen(run.month)}
                      className={cn(rowActionClass, "text-brand hover:text-brand")}
                    >
                      Open<span className="sr-only"> {name}</span>
                    </button>
                  </DataCell>
                </DataRow>
              );
            })}
          </DataBody>
        </DataTable>
      )}
    </Panel>
  );
}
