"use client";

import { useState } from "react";
import { offeredCurrencies } from "@convex/lib/customerShape";
import { hireCost, type HireCost } from "@convex/lib/hireCost";
import type { Currency } from "@convex/lib/metricRegistry";
import type { PayrollLineRow } from "@convex/lib/payroll";
import { CHANGE_KINDS, CHANGE_LABELS, isOneOff, type ChangeKind } from "@convex/lib/runway";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";
import { formatMinor } from "@/lib/format";
import { moneyInput, parseMoney } from "@/lib/payroll/input";

/** A change as the server stores it. */
export type SavedChange = {
  kind: ChangeKind;
  label: string;
  startMonth: string;
  endMonth?: string;
  amount: number;
  currency: Currency;
  fromPayroll?: { salary: number; basis: "net" | "gross" };
};

type Draft = {
  kind: ChangeKind;
  label: string;
  startMonth: string;
  endMonth: string;
  amount: string;
  currency: Currency;
  usePayroll: boolean;
  salary: string;
  basis: "net" | "gross";
};

const AMOUNT_HINT: Record<ChangeKind, string> = {
  hire: "Monthly total cost",
  cost: "Monthly change (negative saves)",
  revenue: "Monthly change in MRR",
  cash_in: "Amount, once",
  cash_out: "Amount, once",
};

const NO_HIRE_COST: Record<Exclude<HireCost, { known: true }>["reason"], string> = {
  rate_not_set: "Not known yet: a payroll rate is not set.",
  other_currency: "Not known yet: a payroll line is not worked out in that currency.",
  no_gross: "Not known yet: no gross gives that net at these rates.",
  circle: "Not known yet: payroll lines subtract each other in a circle.",
};

const draftOf = (change: SavedChange): Draft => ({
  kind: change.kind,
  label: change.label,
  startMonth: change.startMonth,
  endMonth: change.endMonth ?? "",
  amount: moneyInput(change.amount),
  currency: change.currency,
  usePayroll: change.fromPayroll !== undefined,
  salary: change.fromPayroll ? moneyInput(change.fromPayroll.salary) : "",
  basis: change.fromPayroll?.basis ?? "net",
});

/** A hire's cost at the payroll rates, for a viewer who holds Payroll. */
function costOf(draft: Draft, companyCurrency: Currency, lines: readonly PayrollLineRow[]): HireCost | null {
  const salary = parseMoney(draft.salary);
  if (salary === null || salary <= 0) return null;
  return hireCost({ salary, basis: draft.basis, sameCurrency: draft.currency === companyCurrency, lines });
}

/**
 * One scenario's name and changes. A hire takes a monthly total cost, or,
 * for a viewer who holds Payroll, a salary that the company's payroll rates
 * are applied to (worked out here, in the browser, by payroll's own
 * arithmetic); the figure is what is saved.
 */
export function ScenarioEditor({
  name: initialName,
  changes: initial,
  companyCurrency,
  defaultMonth,
  payrollLines,
  onSave,
  onCancel,
}: {
  name: string;
  changes: readonly SavedChange[];
  companyCurrency: Currency;
  defaultMonth: string;
  /** Null: the viewer does not hold Payroll; undefined: still loading. */
  payrollLines: readonly PayrollLineRow[] | null | undefined;
  onSave: (name: string, changes: SavedChange[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [drafts, setDrafts] = useState<Draft[]>(initial.map(draftOf));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const blank = (): Draft => ({
    kind: "hire",
    label: "",
    startMonth: defaultMonth,
    endMonth: "",
    amount: "",
    // The company's own, where it is a currency this OS offers (convex/lib/customerShape.ts).
    currency: offeredCurrencies().includes(companyCurrency) ? companyCurrency : "USD",
    usePayroll: false,
    salary: "",
    basis: "net",
  });
  const edit = (i: number, patch: Partial<Draft>) =>
    setDrafts((was) => was.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const save = async () => {
    const changes: SavedChange[] = [];
    for (const d of drafts) {
      let amount = parseMoney(d.amount, { signed: d.kind === "cost" || d.kind === "revenue" });
      let fromPayroll: SavedChange["fromPayroll"];
      if (d.kind === "hire" && d.usePayroll && payrollLines) {
        const cost = costOf(d, companyCurrency, payrollLines);
        if (cost === null || !cost.known) {
          setProblem("A hire at the payroll rates needs a salary whose cost is known.");
          return;
        }
        amount = cost.cost;
        fromPayroll = { salary: parseMoney(d.salary)!, basis: d.basis };
      }
      if (amount === null || !/^\d{4}-\d{2}$/.test(d.startMonth)) {
        setProblem("Each change needs a start month and an amount.");
        return;
      }
      changes.push({
        kind: d.kind,
        label: d.label.trim() || CHANGE_LABELS[d.kind],
        startMonth: d.startMonth,
        ...(isOneOff(d.kind) || d.endMonth === "" ? {} : { endMonth: d.endMonth }),
        amount,
        currency: d.currency,
        ...(fromPayroll ? { fromPayroll } : {}),
      });
    }
    setProblem(null);
    setSaving(true);
    try {
      await onSave(name, changes);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block max-w-sm space-y-1 text-sm">
        <span className="text-ink-2">Scenario name</span>
        <input className={`${fieldClass} h-10`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <ul className="space-y-3">
        {drafts.map((d, i) => {
          const cost = d.kind === "hire" && d.usePayroll && payrollLines ? costOf(d, companyCurrency, payrollLines) : null;
          return (
            <li key={i} className="grid gap-2 rounded-inner bg-surface p-3 sm:grid-cols-6">
              <label className="space-y-1 text-xs sm:col-span-1">
                <span className="text-ink-2">Kind</span>
                <select className={`${fieldClass} h-9`} value={d.kind} onChange={(e) => edit(i, { kind: e.target.value as ChangeKind })}>
                  {CHANGE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {CHANGE_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="text-ink-2">Label</span>
                <input className={`${fieldClass} h-9`} value={d.label} maxLength={80} onChange={(e) => edit(i, { label: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-ink-2">{isOneOff(d.kind) ? "Month" : "From"}</span>
                <input type="month" className={`${fieldClass} h-9`} value={d.startMonth} onChange={(e) => edit(i, { startMonth: e.target.value })} />
              </label>
              {!isOneOff(d.kind) && (
                <label className="space-y-1 text-xs">
                  <span className="text-ink-2">Until (optional)</span>
                  <input type="month" className={`${fieldClass} h-9`} value={d.endMonth} onChange={(e) => edit(i, { endMonth: e.target.value })} />
                </label>
              )}
              <label className="space-y-1 text-xs">
                <span className="text-ink-2">Currency</span>
                <select className={`${fieldClass} h-9`} value={d.currency} onChange={(e) => edit(i, { currency: e.target.value as Currency })}>
                  {offeredCurrencies().map((one) => (
                    <option key={one} value={one}>
                      {one}
                    </option>
                  ))}
                </select>
              </label>
              {d.kind === "hire" && payrollLines !== null && (
                <label className="flex items-center gap-2 text-xs text-ink sm:col-span-6">
                  <input type="checkbox" checked={d.usePayroll} onChange={(e) => edit(i, { usePayroll: e.target.checked })} />
                  Work the cost out at the payroll rates
                </label>
              )}
              {d.kind === "hire" && payrollLines === null && (
                <p className="text-xs text-ink-2 sm:col-span-6">
                  Costing a hire at the payroll rates is for whoever holds the Payroll page: type the monthly total cost.
                </p>
              )}
              {d.kind === "hire" && d.usePayroll && payrollLines ? (
                <>
                  <label className="space-y-1 text-xs sm:col-span-2">
                    <span className="text-ink-2">Monthly salary</span>
                    <input inputMode="decimal" className={`${fieldClass} h-9`} value={d.salary} onChange={(e) => edit(i, { salary: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-ink-2">Typed as</span>
                    <select className={`${fieldClass} h-9`} value={d.basis} onChange={(e) => edit(i, { basis: e.target.value as "net" | "gross" })}>
                      <option value="net">Net</option>
                      <option value="gross">Gross</option>
                    </select>
                  </label>
                  <p className="self-end pb-2 text-xs text-ink sm:col-span-3" aria-live="polite">
                    {cost === null
                      ? "Type a salary to see its monthly total cost."
                      : cost.known
                        ? `Monthly total cost ${formatMinor(cost.cost, d.currency)} (gross ${formatMinor(cost.gross, d.currency)}).`
                        : NO_HIRE_COST[cost.reason]}
                  </p>
                </>
              ) : (
                <label className="space-y-1 text-xs sm:col-span-2">
                  <span className="text-ink-2">{AMOUNT_HINT[d.kind]}</span>
                  <input inputMode="decimal" className={`${fieldClass} h-9`} value={d.amount} onChange={(e) => edit(i, { amount: e.target.value })} />
                </label>
              )}
              <div className="flex items-end justify-end sm:col-span-6">
                <button type="button" className={quietButtonClass} onClick={() => setDrafts((was) => was.filter((_, j) => j !== i))}>
                  Remove change
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {problem !== null && (
        <p role="alert" className="text-sm text-danger-ink">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={quietButtonClass} disabled={drafts.length >= 20} onClick={() => setDrafts((was) => [...was, blank()])}>
          Add a change
        </button>
        <span className="flex-1" />
        <button type="button" className={quietButtonClass} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={primaryButtonClass} disabled={saving} onClick={() => void save()}>
          Save scenario
        </button>
      </div>
    </div>
  );
}
