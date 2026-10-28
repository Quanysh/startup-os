"use client";

import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import {
  BUDGET_CATEGORIES,
  BUDGET_LABELS,
  REGISTER_LABELS,
  budgetTotal,
  registerOf,
  type BudgetCategory,
  type BudgetCell,
  type BudgetTotal,
  type Effective,
  type Register,
} from "@convex/lib/budget";
import { firstDayOf } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
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
import { formatMinor, formatPeriod } from "@/lib/format";
import { moneyInput, parseMoney } from "@/lib/payroll/input";
import { cn } from "@/lib/utils";

export type CellSave = { month: string; category: BudgetCategory; amount: number | null };

export const NOT_KNOWN = "Not known yet";
const keyOf = (category: string, month: string) => `${category}:${month}`;
const monthName = (month: string) => formatPeriod("month", firstDayOf(month));

/** Where a hidden register's figures are, in place of its row. */
const ON_ITS_PAGE: Record<Register, string> = {
  payroll: "On the Payroll page",
  costs: "On the Costs page",
};

/** What a register's figure that is not known lacks, as a cell's title says it. */
const WHY_NOT_KNOWN = {
  rates: "a payroll rate is not set",
  circle: "two pay lines subtract each other",
  no_rate: "it is in the other currency and no USD/KZT rate is on record",
} as const;

/** "Payroll", "Payroll and Costs". */
export const registersWords = (registers: readonly Register[]) =>
  registers.map((r) => REGISTER_LABELS[r]).join(" and ");

/** A total as a cell reads it. */
function TotalFigure({ total, money }: { total: BudgetTotal; money: (minor: number) => string }) {
  if (total.kind === "known") return <>{money(total.amount)}</>;
  if (total.kind === "loading") return <Blank>…</Blank>;
  return <Blank>{NOT_KNOWN}</Blank>;
}

/**
 * The budget: months across, categories down. Each cell is the register's
 * figure for that month (Payroll's total cost, a Costs category's cash due),
 * in quiet ink and marked "from Payroll" / "from Costs", until someone types
 * over it: then it is an override, tinted, with a button that resets it to
 * the register's figure. A cell is saved when it is left changed; emptying an
 * override resets it too. A register the viewer does not hold is one row
 * saying where it is, and the totals say they leave it out.
 */
export function BudgetGrid({
  months,
  currency,
  cells,
  onSave,
}: {
  months: readonly string[];
  currency: Currency;
  /** The effective budget for at least these months, every category. */
  cells: readonly BudgetCell[];
  onSave: (cells: CellSave[]) => Promise<void> | void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const money = (minor: number) => formatMinor(minor, currency);
  const inView = cells.filter((c) => months.includes(c.month));
  const cellOf = new Map(inView.map((c) => [keyOf(c.category, c.month), c.cell]));
  const at = (category: BudgetCategory, month: string): Effective =>
    cellOf.get(keyOf(category, month)) ?? { kind: "loading" };
  const hiddenRow = (category: BudgetCategory) => months.every((m) => at(category, m).kind === "hidden");
  const categories = BUDGET_CATEGORIES.filter((c) => !hiddenRow(c));
  const hidden = (["payroll", "costs"] as const).filter((register) =>
    BUDGET_CATEGORIES.some((c) => registerOf(c) === register && hiddenRow(c)),
  );

  const forget = (key: string) =>
    setDrafts((was) => {
      const { [key]: _gone, ...rest } = was;
      return rest;
    });
  const save = (key: string, next: CellSave) =>
    void Promise.resolve(onSave([next])).then(
      () => forget(key),
      () => {},
    );

  const leave = (category: BudgetCategory, month: string) => {
    const key = keyOf(category, month);
    const text = drafts[key];
    if (text === undefined) return;
    const cell = at(category, month);
    if (text.trim() === "") {
      setInvalid((was) => ({ ...was, [key]: false }));
      // Emptying an override puts the register's figure back; anything else had nothing typed.
      return cell.kind === "override" ? save(key, { month, category, amount: null }) : forget(key);
    }
    const amount = parseMoney(text);
    if (amount === null) {
      setInvalid((was) => ({ ...was, [key]: true }));
      return;
    }
    setInvalid((was) => ({ ...was, [key]: false }));
    // The same figure as the cell already holds is not an override of it.
    if ((cell.kind === "override" || cell.kind === "live") && cell.amount === amount) return forget(key);
    save(key, { month, category, amount });
  };

  const rowTotal = (category: BudgetCategory) => budgetTotal(inView.filter((c) => c.category === category));
  const columnTotal = (month: string) => budgetTotal(inView.filter((c) => c.month === month));
  const grand = budgetTotal(inView);

  if (categories.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        The budget is Payroll&apos;s and Costs&apos; figures, which are on those pages: you do not hold them, so
        there is nothing here for you to see.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <DataTable caption={`The budget in ${currency}, by month and category`} className="min-w-[76rem]">
        <DataHead>
          <DataHeader pinned>Category</DataHeader>
          {months.map((month) => (
            <DataHeader key={month} numeric>
              {monthName(month)}
            </DataHeader>
          ))}
          <DataHeader numeric strong>
            12 months
          </DataHeader>
        </DataHead>
        <DataBody>
          {categories.map((category) => {
            const register = REGISTER_LABELS[registerOf(category)];
            return (
              <DataRow key={category}>
                <DataRowHeader pinned>
                  <span className="block">{BUDGET_LABELS[category]}</span>
                  <span className="block text-[11px] font-normal text-ink-3">from {register}</span>
                </DataRowHeader>
                {months.map((month) => {
                  const key = keyOf(category, month);
                  const cell = at(category, month);
                  const label = `${BUDGET_LABELS[category]}, ${monthName(month)}`;
                  const shown =
                    cell.kind === "override" || cell.kind === "live" ? moneyInput(cell.amount) : "";
                  const title =
                    cell.kind === "override"
                      ? `Typed in. ${register} says ${
                          cell.live.kind === "known" ? money(cell.live.amount) : "nothing it knows yet"
                        }.`
                      : cell.kind === "live"
                        ? `From ${register}. Type to set your own figure.`
                        : cell.kind === "unknown"
                          ? `Not known yet: ${WHY_NOT_KNOWN[cell.reason]}. Type to set your own figure.`
                          : undefined;
                  return (
                    <DataCell key={month} numeric className="py-1.5">
                      <span className="inline-flex items-center justify-end gap-0.5">
                        <input
                          inputMode="decimal"
                          aria-label={label}
                          aria-description={
                            cell.kind === "override" ? "Typed in" : cell.kind === "live" ? `From ${register}` : undefined
                          }
                          aria-invalid={invalid[key] ? true : undefined}
                          data-source={cell.kind}
                          title={title}
                          value={drafts[key] ?? shown}
                          placeholder={cell.kind === "unknown" ? "Not known" : cell.kind === "loading" ? "…" : "—"}
                          disabled={cell.kind === "loading"}
                          onChange={(event) => setDrafts((was) => ({ ...was, [key]: event.target.value }))}
                          onBlur={() => leave(category, month)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              forget(key);
                              event.currentTarget.blur();
                            }
                          }}
                          className={cn(
                            "h-8 w-24 rounded-inner border border-transparent px-2 text-right font-num text-sm outline-none placeholder:text-ink-3 hover:border-line focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                            "aria-invalid:border-destructive",
                            cell.kind === "override"
                              ? "bg-info-soft font-medium text-info-ink"
                              : "bg-transparent text-ink-2",
                          )}
                        />
                        {cell.kind === "override" ? (
                          <button
                            type="button"
                            aria-label={`Reset ${label} to ${register}`}
                            title={`Reset to ${register}${cell.live.kind === "known" ? ` (${money(cell.live.amount)})` : ""}`}
                            onClick={() => save(key, { month, category, amount: null })}
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-3 outline-none hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <RotateCcwIcon aria-hidden className="size-3.5" />
                          </button>
                        ) : (
                          <span aria-hidden className="size-6 shrink-0" />
                        )}
                      </span>
                    </DataCell>
                  );
                })}
                <DataCell numeric strong>
                  <TotalFigure total={rowTotal(category)} money={money} />
                </DataCell>
              </DataRow>
            );
          })}
          {hidden.map((register) => (
            <DataRow key={register}>
              <DataRowHeader pinned>{REGISTER_LABELS[register]}</DataRowHeader>
              <DataCell colSpan={months.length + 1}>
                <Blank>{ON_ITS_PAGE[register]}</Blank>
              </DataCell>
            </DataRow>
          ))}
        </DataBody>
        <DataFoot>
          <DataRow plain>
            <DataRowHeader pinned>Total</DataRowHeader>
            {months.map((month) => (
              <DataCell key={month} numeric>
                <TotalFigure total={columnTotal(month)} money={money} />
              </DataCell>
            ))}
            <DataCell numeric strong>
              <TotalFigure total={grand} money={money} />
            </DataCell>
          </DataRow>
        </DataFoot>
      </DataTable>
      {hidden.length > 0 && (
        <p className="text-xs text-ink-2">
          {`Total excludes ${registersWords(hidden)}: ${hidden.length > 1 ? "they are" : "it is"} on ${
            hidden.length > 1 ? "those pages" : `the ${registersWords(hidden)} page`
          }, which you do not hold.`}
        </p>
      )}
      {grand.kind === "unknown" && (
        <p className="text-xs text-ink-2">
          A total is not known while a figure in it is not: set the missing rate on Payroll or Costs, or type the
          figure in its cell.
        </p>
      )}
      {Object.values(invalid).some(Boolean) && (
        <p role="alert" className="text-xs text-danger-ink">
          A cell holds an amount in {currency}, like 1200 or 1,200.50. It was not saved.
        </p>
      )}
    </div>
  );
}
