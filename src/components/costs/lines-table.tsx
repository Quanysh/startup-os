"use client";

import { useMutation } from "convex/react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  BUCKET_LABELS,
  CADENCE_LABELS,
  CATEGORY_LABELS,
  COST_CATEGORIES,
  bucketOf,
  firstDayOf,
  hasEnded,
  monthlyEquivalent,
  type CostCategory,
} from "@convex/lib/costs";
import { fieldClass } from "@/components/panel";
import { Confirm, Failure, useAction } from "@/components/payroll/shared";
import {
  ActionsHeader,
  Blank,
  DataBody,
  DataCell,
  DataFoot,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { StatusChip } from "@/components/ui/status-chip";
import {
  ariaSort,
  filterLines,
  nextSort,
  sortLines,
  totalsOf,
  type Sort,
  type SortKey,
  type View,
} from "@/lib/costs/view";
import { formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CategoryTag, Money, type Line } from "./shared";

const monthName = (month: string) => formatPeriod("month", firstDayOf(month));

/** A column's name as the button that sorts by it. The header cell carries `aria-sort`. */
function SortHeader({
  sort,
  column,
  numeric,
  pinned,
  onSort,
  children,
}: {
  sort: Sort;
  column: SortKey;
  numeric?: boolean;
  pinned?: boolean;
  onSort: (next: Sort) => void;
  children: string;
}) {
  const state = ariaSort(sort, column);
  const Icon =
    state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <DataHeader numeric={numeric} pinned={pinned} aria-sort={state}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
          state !== "none" && "text-ink",
        )}
      >
        {children}
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "none" && "opacity-50")} />
      </button>
    </DataHeader>
  );
}

/** What a line counts as in unit economics, and when that is only its category's default. */
function CountsAs({ line }: { line: Line }) {
  return (
    <>
      {BUCKET_LABELS[bucketOf(line)]}
      {line.bucket === null && <span className="block text-xs text-ink-2">by category</span>}
    </>
  );
}

/** A line's name, with "≈" when its amount is an estimate. */
function NameCell({ line }: { line: Line }) {
  return (
    <DataRowHeader pinned>
      {line.name}
      {line.variable && <span className="block text-xs font-normal text-ink-2">≈ estimate</span>}
    </DataRowHeader>
  );
}

/**
 * The cost lines, on the shared table: the lines in force or still to start,
 * then, folded away, the ones that ended or were archived. Sorting and the
 * category filter are worked out here on the rows already read, and live in
 * the address (`view`), not in this component.
 */
export function LinesTable({
  lines,
  month,
  view,
  onView,
  onEdit,
}: {
  lines: readonly Line[];
  /** This month, "YYYY-MM": what decides which lines have ended. */
  month: string;
  view: View;
  onView: (next: View) => void;
  onEdit: (line: Line) => void;
}) {
  const archive = useMutation(api.costs.archive);
  const restore = useMutation(api.costs.restore);
  const remove = useMutation(api.costs.remove);
  const { busy, error, run } = useAction();
  const [deleting, setDeleting] = useState<Line | null>(null);
  const filterId = useId();

  const shown = sortLines(filterLines(lines, view.category), view.sort);
  const current = shown.filter((line) => !hasEnded(line, month));
  const ended = shown.filter((line) => hasEnded(line, month));
  const totals = totalsOf(current.filter((line) => line.startsOn <= month));
  const onSort = (sort: Sort) => onView({ ...view, sort });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={filterId} className="text-sm text-ink-2">
          Category
        </label>
        <select
          id={filterId}
          value={view.category ?? ""}
          onChange={(e) =>
            onView({ ...view, category: e.target.value === "" ? null : (e.target.value as CostCategory) })
          }
          className={cn(fieldClass, "h-9 w-auto")}
        >
          <option value="">All categories</option>
          {COST_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>

      <Failure error={error} />

      {current.length === 0 ? (
        <p className="text-sm text-ink-2">
          {view.category === null
            ? "No line is in force."
            : `No line in ${CATEGORY_LABELS[view.category]} is in force.`}
        </p>
      ) : (
        <DataTable label="Cost lines" className="min-w-[72rem]">
          <DataHead>
            <SortHeader sort={view.sort} column="name" pinned onSort={onSort}>
              Name
            </SortHeader>
            <SortHeader sort={view.sort} column="category" onSort={onSort}>
              Category
            </SortHeader>
            <DataHeader>Counts as</DataHeader>
            <DataHeader numeric>Amount</DataHeader>
            <DataHeader>Cadence</DataHeader>
            <SortHeader sort={view.sort} column="monthly" numeric onSort={onSort}>
              Monthly equivalent
            </SortHeader>
            <DataHeader>Since</DataHeader>
            <DataHeader>Until</DataHeader>
            <DataHeader>Paid by</DataHeader>
            <DataHeader>Note</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {current.map((line) => (
              <DataRow key={line.id}>
                <NameCell line={line} />
                <DataCell>
                  <CategoryTag category={line.category} />
                </DataCell>
                <DataCell>
                  <CountsAs line={line} />
                </DataCell>
                <DataCell numeric>
                  <Money minor={line.amount} currency={line.currency} estimate={line.variable} />
                </DataCell>
                <DataCell>{CADENCE_LABELS[line.cadence]}</DataCell>
                <DataCell numeric strong>
                  {line.cadence === "once" ? (
                    <Blank>One-off</Blank>
                  ) : (
                    <Money
                      minor={monthlyEquivalent(line)}
                      currency={line.currency}
                      estimate={line.variable}
                    />
                  )}
                </DataCell>
                <DataCell className="whitespace-nowrap">
                  {monthName(line.startsOn)}
                  {line.startsOn > month && (
                    <span className="block text-xs text-ink-2">Not started</span>
                  )}
                </DataCell>
                <DataCell className="whitespace-nowrap">
                  {line.endsOn === null ? <Blank /> : monthName(line.endsOn)}
                </DataCell>
                <DataCell>{line.paidBy ?? <Blank />}</DataCell>
                <DataCell className="max-w-[16rem] text-ink-2">{line.note ?? <Blank />}</DataCell>
                <DataCell actions>
                  <button type="button" onClick={() => onEdit(line)} className={rowActionClass}>
                    Edit<span className="sr-only"> {line.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => run(() => archive({ id: line.id }))}
                    className={rowActionClass}
                  >
                    Archive<span className="sr-only"> {line.name}</span>
                  </button>
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
          <DataFoot>
            {totals.map((total) => (
              <DataRow key={total.currency} plain>
                <DataRowHeader pinned>Total a month, {total.currency}</DataRowHeader>
                <DataCell />
                <DataCell />
                <DataCell />
                <DataCell />
                <DataCell numeric strong>
                  <Money minor={total.monthly} currency={total.currency} />
                </DataCell>
                <DataCell colSpan={5} className="text-xs font-normal text-ink-2">
                  The lines shown that have started. One-offs are not in it.
                </DataCell>
              </DataRow>
            ))}
          </DataFoot>
        </DataTable>
      )}

      {ended.length > 0 && (
        <details className="rounded-inner border border-line p-3">
          <summary className="cursor-pointer rounded-sm text-sm font-medium text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Ended ({ended.length})
          </summary>
          <div className="mt-3 space-y-3">
            {deleting !== null && (
              <Confirm
                question={`Delete “${deleting.name}” for good? This cannot be undone.`}
                confirm="Delete"
                cancel="Keep it"
                busy={busy}
                onConfirm={async () => {
                  await run(() => remove({ id: deleting.id }));
                  setDeleting(null);
                }}
                onCancel={() => setDeleting(null)}
              />
            )}
            <DataTable label="Ended and archived cost lines" bleed={false} className="min-w-[44rem]">
              <DataHead>
                <DataHeader pinned>Name</DataHeader>
                <DataHeader>Category</DataHeader>
                <DataHeader numeric>Amount</DataHeader>
                <DataHeader>Cadence</DataHeader>
                <DataHeader>Since</DataHeader>
                <DataHeader>Until</DataHeader>
                <DataHeader>State</DataHeader>
                <ActionsHeader />
              </DataHead>
              <DataBody>
                {ended.map((line) => (
                  <DataRow key={line.id}>
                    <NameCell line={line} />
                    <DataCell>
                      <CategoryTag category={line.category} />
                    </DataCell>
                    <DataCell numeric>
                      <Money minor={line.amount} currency={line.currency} estimate={line.variable} />
                    </DataCell>
                    <DataCell>{CADENCE_LABELS[line.cadence]}</DataCell>
                    <DataCell className="whitespace-nowrap">{monthName(line.startsOn)}</DataCell>
                    <DataCell className="whitespace-nowrap">
                      {line.endsOn === null ? <Blank /> : monthName(line.endsOn)}
                    </DataCell>
                    <DataCell>
                      <StatusChip tone="neutral">
                        {line.archivedAt !== null ? "Archived" : line.cadence === "once" ? "Paid" : "Ended"}
                      </StatusChip>
                    </DataCell>
                    <DataCell actions>
                      {line.archivedAt === null ? (
                        <>
                          <button type="button" onClick={() => onEdit(line)} className={rowActionClass}>
                            Edit<span className="sr-only"> {line.name}</span>
                          </button>
                          <button
                            type="button"
                            aria-disabled={busy}
                            onClick={() => run(() => archive({ id: line.id }))}
                            className={rowActionClass}
                          >
                            Archive<span className="sr-only"> {line.name}</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-disabled={busy}
                            onClick={() => run(() => restore({ id: line.id }))}
                            className={rowActionClass}
                          >
                            Restore<span className="sr-only"> {line.name}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleting(line)}
                            className={rowActionClass}
                          >
                            Delete<span className="sr-only"> {line.name}</span>
                          </button>
                        </>
                      )}
                    </DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
          </div>
        </details>
      )}
    </div>
  );
}
