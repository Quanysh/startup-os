"use client";

import { useState } from "react";
import { REGISTER_LABELS, type MonthRow, type Variance } from "@convex/lib/budget";
import { COMPANIES } from "@convex/lib/company";
import { firstDayOf } from "@convex/lib/costs";
import { featureOn } from "@convex/lib/featureGates";
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
import { subsidiaryWords } from "@/components/finance/notes";
import { StatusChip } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { formatChange, formatMinor, formatPeriod } from "@/lib/format";
import { moneyInput, parseMoney } from "@/lib/payroll/input";

export const NOT_KNOWN = "Not known yet";
/** "Not compared: the budget leaves out Payroll", "… Payroll and Costs". */
const leftOut = (row: MonthRow) =>
  `Not compared: the budget leaves out ${row.excludes.map((r) => REGISTER_LABELS[r]).join(" and ")}`;

/**
 * Where the actual comes from. Startup's is its own spending (`startupActuals`):
 * what it sent Globex is Globex's money, named only for a viewer on
 * Globex as well. Kazakhstan's month-end cash gives net burn only (money
 * out less money in), never money out, so the typed figure stays Globex's
 * one actual spend.
 */
const sourceLine = (source: "mercury" | "typed", companies: readonly string[]) =>
  // No subsidiary funded from Mercury (convex/lib/features.ts): money out is Startup's whole.
  source === "mercury" && !featureOn("subsidiaryFunding")
    ? `Actual is ${COMPANIES.us.name}'s spending: Mercury's money out, for each month Mercury read whole. The month in progress is not an actual yet.`
    : source === "mercury"
      ? `Actual is ${COMPANIES.us.name}'s own spending: Mercury's money out less what it sent ${subsidiaryWords(companies)}, which is ${companies.includes("kz") ? `${COMPANIES.kz.name}'s money and in ${COMPANIES.kz.name}'s actual` : "the subsidiary's money"}, for each month Mercury read whole. A month read before what was sent was counted is not known yet, and the month in progress is not an actual yet.`
      : `Actual is typed in for each month: ${COMPANIES.kz.name}'s bank has no feed in the OS. It is ${COMPANIES.kz.name}'s one actual spend: the Finance page's net burn (from cash) is money out less money in, from month-end balances, and is never set against the budget.`;

/** A variance as a chip: over plan in the danger tint, under in the success tint, always with words. */
export function VarianceChip({ variance, currency }: { variance: Variance; currency: Currency }) {
  if (variance.kind === "unknown") return <Blank>{NOT_KNOWN}</Blank>;
  if (variance.kind === "on") return <StatusChip tone="neutral">On budget</StatusChip>;
  const by = formatMinor(Math.abs(variance.diff), currency);
  const share = variance.share === null ? "" : ` (${formatChange(variance.share)})`;
  return variance.kind === "over" ? (
    <StatusChip tone="danger">{`Over by ${by}${share}`}</StatusChip>
  ) : (
    <StatusChip tone="success">{`Under by ${by}${share}`}</StatusChip>
  );
}

/**
 * Budget against actual, a month a row: the budget's total, what went out,
 * and the variance. A budget that leaves out a register the viewer does not
 * hold (Payroll, Costs) set against everything spent would read as
 * overspending, so it is not compared, and the row says what it leaves out.
 */
export function ActualTable({
  rows,
  currency,
  source,
  onSetActual,
}: {
  rows: readonly MonthRow[];
  currency: Currency;
  source: "mercury" | "typed";
  onSetActual?: (month: string, amount: number | null) => Promise<void> | void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const { companies } = useViewer();
  const money = (minor: number) => formatMinor(minor, currency);

  const leave = (row: MonthRow) => {
    const text = drafts[row.month];
    if (text === undefined || onSetActual === undefined) return;
    const amount = text.trim() === "" ? null : parseMoney(text);
    if (text.trim() !== "" && amount === null) return setInvalid(row.month);
    setInvalid(null);
    const forget = () =>
      setDrafts((was) => {
        const { [row.month]: _gone, ...rest } = was;
        return rest;
      });
    if (amount === row.actual) return forget();
    void Promise.resolve(onSetActual(row.month, amount)).then(forget, () => {});
  };

  return (
    <div className="space-y-2">
      <DataTable caption="Budget against actual, by month">
        <DataHead>
          <DataHeader pinned>Month</DataHeader>
          <DataHeader numeric>Budget</DataHeader>
          <DataHeader numeric>Actual</DataHeader>
          <DataHeader>Variance</DataHeader>
        </DataHead>
        <DataBody>
          {rows.map((row) => {
            const name = formatPeriod("month", firstDayOf(row.month));
            return (
              <DataRow key={row.month}>
                <DataRowHeader pinned>{name}</DataRowHeader>
                <DataCell numeric>
                  {row.plan !== null ? money(row.plan) : row.excludes.length > 0 ? <Blank /> : <Blank>{NOT_KNOWN}</Blank>}
                </DataCell>
                <DataCell numeric className={onSetActual ? "py-1.5" : undefined}>
                  {onSetActual ? (
                    <input
                      inputMode="decimal"
                      aria-label={`Actual spent, ${name}`}
                      aria-invalid={invalid === row.month ? true : undefined}
                      placeholder={NOT_KNOWN}
                      value={drafts[row.month] ?? (row.actual === null ? "" : moneyInput(row.actual))}
                      onChange={(event) =>
                        setDrafts((was) => ({ ...was, [row.month]: event.target.value }))
                      }
                      onBlur={() => leave(row)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className="h-8 w-32 rounded-inner border border-line bg-panel px-2 text-right font-num text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                    />
                  ) : row.actual === null ? (
                    <Blank>{NOT_KNOWN}</Blank>
                  ) : (
                    money(row.actual)
                  )}
                </DataCell>
                <DataCell>
                  {row.excludes.length > 0 ? (
                    <Blank>{leftOut(row)}</Blank>
                  ) : (
                    <VarianceChip variance={row.variance} currency={currency} />
                  )}
                </DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
      <p className="text-xs text-ink-2">{sourceLine(source, companies)}</p>
      {invalid !== null && (
        <p role="alert" className="text-xs text-danger-ink">
          An actual is an amount in {currency}, like 950000. It was not saved.
        </p>
      )}
    </div>
  );
}
