"use client";

import type { CategoryRow } from "@convex/lib/budget";
import { CATEGORY_LABELS } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { formatMinor } from "@/lib/format";
import { NOT_KNOWN, VarianceChip } from "./actual-table";

/**
 * A month's plan per cost category against the cost register's run-rate:
 * what is planned to be paid, which is not what was spent. Only for a viewer
 * who holds Costs; anyone else is told where it is.
 */
export function CategoryTable({
  rows,
  currency,
  monthName,
}: {
  /** Null: the viewer does not hold Costs. */
  rows: readonly CategoryRow[] | null;
  currency: Currency;
  monthName: string;
}) {
  if (rows === null) {
    return (
      <p className="text-sm text-ink-2">
        The cost register&apos;s run-rate is on the Costs page, which you do not hold.
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="text-sm text-ink-2">Nothing planned or on the cost register for {monthName}.</p>;
  }
  const money = (minor: number | null) => (minor === null ? <Blank>{NOT_KNOWN}</Blank> : formatMinor(minor, currency));
  return (
    <div className="space-y-2">
      <DataTable caption={`Budget against the cost register's run-rate, ${monthName}`}>
        <DataHead>
          <DataHeader pinned>Category</DataHeader>
          <DataHeader numeric>Budget</DataHeader>
          <DataHeader numeric>Run-rate</DataHeader>
          <DataHeader>Run-rate against budget</DataHeader>
        </DataHead>
        <DataBody>
          {rows.map((row) => (
            <DataRow key={row.category}>
              <DataRowHeader pinned>{CATEGORY_LABELS[row.category]}</DataRowHeader>
              <DataCell numeric>{row.plan === null ? <Blank /> : money(row.plan)}</DataCell>
              <DataCell numeric>{money(row.runRate)}</DataCell>
              <DataCell>
                <VarianceChip variance={row.variance} currency={currency} />
              </DataCell>
            </DataRow>
          ))}
        </DataBody>
      </DataTable>
      <p className="text-xs text-ink-2">
        Run-rate is the recurring lines on the Costs page, spread evenly: what is planned to be
        paid, not what was spent. Spending by category needs categorised bank data, which the OS
        does not hold yet.
      </p>
    </div>
  );
}
