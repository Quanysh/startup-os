"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { featureOn } from "@convex/lib/featureGates";
import type { Currency } from "@convex/lib/metricRegistry";
import type { PayrollLineRow } from "@convex/lib/payroll";
import { REGISTER_LABELS, type Register } from "@convex/lib/budget";
import {
  CHANGE_LABELS,
  isOneOff,
  project,
  type BudgetProjection,
  type Change,
  type Projection,
} from "@convex/lib/runway";
import { subsidiaryWords } from "@/components/finance/notes";
import { primaryButtonClass } from "@/components/panel";
import { rowActionClass } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import { formatMinor, formatPeriod, monthRange } from "@/lib/format";
import { firstDayOf } from "@convex/lib/costs";
import { RunwayChart, runOutWords, type RunwaySeries } from "./runway-chart";
import { ScenarioEditor, type SavedChange } from "./scenario-editor";

type Scenario = FunctionReturnType<typeof api.scenarios.list>[number];

export const NO_PROJECTION: Record<Extract<Projection, { kind: "unknown" }>["reason"], string> = {
  no_cash: "Not known yet: there is no whole cash figure on the Finance page.",
  no_burn: "Not known yet: the Finance page has no average net burn from complete months.",
  no_rate: "Not known yet: a change is in the other currency and no exchange rate is on record.",
};

/** Why the "On budget" line is not drawn. */
const NO_BUDGET_LINE: Record<Extract<BudgetProjection, { kind: "unknown" }>["reason"], string> = {
  no_cash: "it needs a whole cash figure",
  no_burn: "it needs an average net burn from complete months",
  no_spend: "it needs the actual spend of every month the average net burn is of",
  no_budget: "a month of the budget below is not known yet",
};

/** Which figure drives which line, said once above the chart. */
export const DRIVES =
  "As things are, and each scenario, start from today's cash and the average net burn of the last complete months (what actually went out). On budget spends the budget below, month by month, with money in as it has averaged.";

/** When a change applies, in words: " in Dec 2026", " a month from Nov 2026", " a month, Nov–Dec 2026". */
function whenOf(change: Pick<Change, "kind" | "startMonth" | "endMonth">): string {
  const start = firstDayOf(change.startMonth);
  if (isOneOff(change.kind)) return ` in ${formatPeriod("month", start)}`;
  if (change.endMonth === null) return ` a month from ${formatPeriod("month", start)}`;
  return ` a month, ${monthRange(start, firstDayOf(change.endMonth))}`;
}

/** The most scenarios drawn beside the baseline. */
export const MAX_DRAWN = 3;

const toSaved = (change: Scenario["changes"][number]): SavedChange => ({
  kind: change.kind,
  label: change.label,
  startMonth: change.startMonth,
  ...(change.endMonth === null ? {} : { endMonth: change.endMonth }),
  amount: change.amount,
  currency: change.currency,
  ...(change.fromPayroll === null ? {} : { fromPayroll: change.fromPayroll }),
});

/**
 * Runway: cash over 24 months from the Finance page's cash and average net
 * burn, the baseline and up to three scenarios, and each scenario's changes.
 */
export function RunwaySection({
  company,
  currency,
  currentMonth,
  start,
  fx,
  scenarios,
  payrollLines,
  onBudget,
}: {
  company: CompanyId;
  currency: Currency;
  currentMonth: string;
  start: { cash: number | null; netBurn: number | null };
  fx: number | null;
  scenarios: readonly Scenario[];
  payrollLines: readonly PayrollLineRow[] | null | undefined;
  /**
   * Month-end cash spending the budget (`projectBudget`); `leftOut` names the
   * registers the viewer's budget leaves out, for whom it is not drawn.
   */
  onBudget?: { projection: BudgetProjection; leftOut: Register[] };
}) {
  const save = useMutation(api.scenarios.save);
  const remove = useMutation(api.scenarios.remove);
  const { companies } = useViewer();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<Scenario | "new" | null>(null);
  const [deleting, setDeleting] = useState<Scenario | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = (picked ?? scenarios.slice(0, 2).map((s) => s.id)).filter((id) =>
    scenarios.some((s) => s.id === id),
  );
  const projectWith = (changes: readonly Change[]) =>
    project({ startMonth: currentMonth, currency, ...start, changes, fxUsdKzt: fx });
  const baseline = projectWith([]);
  const series: RunwaySeries[] = [];
  if (baseline.kind === "projected") {
    series.push({ id: "baseline", label: "As things are", months: baseline.months, runOut: baseline.runOut });
    for (const id of shown) {
      const scenario = scenarios.find((s) => s.id === id)!;
      const p = projectWith(scenario.changes);
      if (p.kind === "projected") series.push({ id, label: scenario.name, months: p.months, runOut: p.runOut });
    }
  }
  const toggle = (id: string) => {
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    if (next.length <= MAX_DRAWN) setPicked(next);
  };

  const budgetLine =
    onBudget !== undefined && onBudget.leftOut.length === 0 && onBudget.projection.kind === "projected"
      ? { id: "on-budget", label: "On budget", months: onBudget.projection.months, runOut: onBudget.projection.runOut }
      : undefined;
  const noBudgetLine =
    onBudget === undefined || budgetLine !== undefined
      ? null
      : onBudget.leftOut.length > 0
        ? `On budget is not drawn: the budget leaves out ${onBudget.leftOut.map((r) => REGISTER_LABELS[r]).join(" and ")}, so it would flatter the runway.`
        : onBudget.projection.kind === "unknown"
          ? `On budget is not drawn yet: ${NO_BUDGET_LINE[onBudget.projection.reason]}.`
          : null;

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-xs text-ink-2">{DRIVES}</p>
      {/* Startup's actual is its own spending, so its money in as it has
          averaged is net of what it sent Globex: On budget keeps sending
          that. Left out, the line would flatter Startup's runway. */}
      {company === "us" && featureOn("subsidiaryFunding") && onBudget !== undefined && (
        <p className="max-w-3xl text-xs text-ink-2">
          {`${COMPANIES.us.name}'s On budget keeps sending ${subsidiaryWords(companies)} what it has averaged: ${COMPANIES.us.name}'s money pays it, and the budget does not hold it.`}
        </p>
      )}
      {baseline.kind === "unknown" ? (
        <p className="text-sm text-ink-2">{NO_PROJECTION[baseline.reason]}</p>
      ) : (
        <RunwayChart series={series} currency={currency} reference={budgetLine} />
      )}
      {noBudgetLine !== null && <p className="text-xs text-ink-2">{noBudgetLine}</p>}

      {editing !== null ? (
        <ScenarioEditor
          name={editing === "new" ? "" : editing.name}
          changes={editing === "new" ? [] : editing.changes.map(toSaved)}
          companyCurrency={currency}
          defaultMonth={currentMonth}
          payrollLines={payrollLines}
          onCancel={() => setEditing(null)}
          onSave={async (name, changes) => {
            await save({ company, ...(editing === "new" ? {} : { id: editing.id }), name, changes });
            setEditing(null);
          }}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">Scenarios ({scenarios.length} of 10)</h3>
            <button type="button" className={primaryButtonClass} disabled={scenarios.length >= 10} onClick={() => setEditing("new")}>
              New scenario
            </button>
          </div>
          {scenarios.length === 0 ? (
            <p className="text-sm text-ink-2">
              No scenarios yet. Add one to see what a hire, a cost, new revenue or a raise does to the run-out month.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {scenarios.map((scenario) => {
                const p = projectWith(scenario.changes);
                return (
                  <li key={scenario.id} className="space-y-1.5 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <label className="flex items-center gap-2 text-sm font-medium text-ink">
                        <input
                          type="checkbox"
                          checked={shown.includes(scenario.id)}
                          disabled={!shown.includes(scenario.id) && shown.length >= MAX_DRAWN}
                          onChange={() => toggle(scenario.id)}
                        />
                        {scenario.name}
                      </label>
                      <span className="text-sm text-ink-2">
                        {p.kind === "projected" ? runOutWords(p.runOut) : NO_PROJECTION[p.reason]}
                      </span>
                      <span className="flex-1" />
                      <button type="button" className={rowActionClass} onClick={() => setEditing(scenario)}>
                        Edit
                      </button>
                      <button type="button" className={rowActionClass} onClick={() => setDeleting(scenario)}>
                        Delete
                      </button>
                    </div>
                    {scenario.changes.length > 0 && (
                      <ul className="space-y-0.5 pl-6 text-xs text-ink-2">
                        {scenario.changes.map((change, i) => (
                          <li key={i}>
                            {CHANGE_LABELS[change.kind]}: {change.label},{" "}
                            <span className="font-num">{formatMinor(change.amount, change.currency)}</span>
                            {whenOf(change)}
                            {change.fromPayroll ? " (at the payroll rates)" : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {scenarios.length > 0 && (
            <p className="text-xs text-ink-2">Tick up to three to draw them beside the line as things are.</p>
          )}
        </div>
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete"
          busy={busy}
          error={error}
          onKeep={() => {
            setDeleting(null);
            setError(null);
          }}
          onConfirm={async () => {
            setBusy(true);
            try {
              await remove({ id: deleting.id });
              setDeleting(null);
              setError(null);
            } catch (e) {
              setError(messageOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          The scenario and its changes go for good. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
