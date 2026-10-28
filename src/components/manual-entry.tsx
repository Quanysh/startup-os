"use client";

import { useMutation, useQuery } from "convex/react";
import { CheckIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  METRICS,
  SCOPE_CURRENCY,
  SCOPE_LABELS,
  metricScopes,
  type Scope,
} from "@convex/lib/metricRegistry";
import { fieldClass } from "@/components/panel";
import { AREA_PAGES } from "@/components/team/page-checks";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableDownload } from "@/components/ui/table-download";
import { useViewer } from "@/hooks/use-viewer";
import { companyOfMetric } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { formatPeriod, formatValue } from "@/lib/format";

// Every (metric, scope) typed in by hand.
const ALL_OPTIONS = METRICS.flatMap((metric) =>
  metricScopes(metric)
    .filter((scope) => metric.sources[scope] === "manual")
    .map((scope) => ({
      id: `${metric.key}:${scope}`,
      metric,
      scope,
      label: `${metric.label} · ${SCOPE_LABELS[scope]}`,
    })),
);

const today = () => localIsoDate(Date.now());


/**
 * Type a number in. For whoever has the sources page (the `settings` area),
 * and for the numbers of their own companies: the server refuses any other
 * (`snapshots.setManual`), so they are not offered.
 */
export function ManualEntry() {
  const { companies, can } = useViewer();
  const OPTIONS = ALL_OPTIONS.filter((o) =>
    companies.includes(companyOfMetric(o.metric.key, o.scope)),
  );
  const params = useSearchParams();
  const requested = `${params.get("metric")}:${params.get("scope")}`;
  const [selected, setSelected] = useState(
    OPTIONS.find((o) => o.id === requested)?.id ?? OPTIONS[0]?.id ?? "",
  );
  const [date, setDate] = useState(today);
  const [value, setValue] = useState("");
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  // The period whose value is awaiting a second click before it is removed.
  const [removing, setRemoving] = useState<string | null>(null);

  const ids = { metric: useId(), date: useId(), value: useId(), status: useId() };
  const option = OPTIONS.find((o) => o.id === selected);
  const setManual = useMutation(api.snapshots.setManual);
  const removeManual = useMutation(api.snapshots.removeManual);
  const history = useQuery(
    api.metrics.series,
    option ? { key: option.metric.key, scope: option.scope, limit: 12 } : "skip",
  );

  if (!option) return <p className="text-sm text-ink-2">No metric takes manual entry.</p>;

  const currency = option.metric.unit === "currency" ? SCOPE_CURRENCY[option.scope as Scope] : undefined;
  const display = (v: number, c?: string | null) => formatValue(v, option.metric.unit, c);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number)) {
      setState({ kind: "error", message: "Enter a number." });
      return;
    }
    setState({ kind: "saving" });
    try {
      await setManual({ key: option.metric.key, scope: option.scope, date, value: number });
      setValue("");
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: messageOf(error) });
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form onSubmit={submit} className="space-y-4" aria-describedby={ids.status}>
        <div className="space-y-1.5">
          <Label htmlFor={ids.metric}>Metric</Label>
          <select
            id={ids.metric}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setState({ kind: "idle" });
            }}
            className={`${fieldClass} h-10`}
          >
            {OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={ids.date}>Date</Label>
            <Input
              id={ids.date}
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-10 rounded-inner bg-panel"
            />
            <p className="text-xs text-ink-3">
              {option.metric.key === "cash" && option.scope === "kz"
                ? "For a month-end balance, set the date to the last day of the month it closes (the last three days of the month, or the first three of the next, are accepted)."
                : `Stored per ${option.metric.grain}: any day inside it works.`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.value}>Value{currency ? ` (${currency})` : ""}</Label>
            <Input
              id={ids.value}
              type="number"
              inputMode="decimal"
              step="any"
              required
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (state.kind !== "idle") setState({ kind: "idle" });
              }}
              className="h-10 rounded-inner bg-panel font-num"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={state.kind === "saving"}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-fill px-5 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            {state.kind === "saving" && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            Save
          </button>
          <p id={ids.status} role="status" className="text-sm">
            {state.kind === "saved" && (
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <CheckIcon aria-hidden className="size-4 text-good" />
                Saved
              </span>
            )}
            {state.kind === "error" && <span className="text-destructive">{state.message}</span>}
          </p>
        </div>
      </form>

      <div className="min-w-0">
        <h3 className="text-sm font-medium text-ink-2">Recent values</h3>
        {history === undefined ? (
          <p className="mt-3 text-sm text-ink-3">Loading…</p>
        ) : history.length === 0 ? (
          // A figure's values go by the page the figure is on, not by this one:
          // an empty list is not "nothing" for someone who lacks that page.
          <p className="mt-3 text-sm text-ink-3">
            {can(option.metric.section)
              ? "Nothing entered yet."
              : `Earlier values show only to people with the ${AREA_PAGES[option.metric.section]} page. What you save here is stored all the same.`}
          </p>
        ) : (
          // The table and its download (`TableDownload` finds the table in this wrap).
          <div data-slot="data-table-wrap" className="mt-2">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {[...history].reverse().map((row) => (
                  <tr key={row.periodStart}>
                    <td className="py-2 pr-3 text-ink-2">
                      {formatPeriod(option.metric.grain, row.periodStart)}
                    </td>
                    <td className="py-2 pr-3 text-right font-num text-ink">
                      {display(row.value, row.currency)}
                    </td>
                    {/* Remove and its confirmation: not in the download. */}
                    <td data-export-skip="" className="py-2 text-right whitespace-nowrap">
                      {row.source !== "manual" ? null : removing === row.periodStart ? (
                        <span className="inline-flex items-center gap-1 text-xs text-ink-2">
                          <button
                            type="button"
                            onClick={async () => {
                              setRemoving(null);
                              try {
                                await removeManual({
                                  key: option.metric.key,
                                  scope: option.scope,
                                  periodStart: row.periodStart,
                                });
                              } catch (failure) {
                                setState({ kind: "error", message: messageOf(failure) });
                              }
                            }}
                            className="rounded-full px-2 py-1 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setRemoving(null)}
                            className="rounded-full px-2 py-1 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Remove ${formatPeriod(option.metric.grain, row.periodStart)}`}
                          onClick={() => setRemoving(row.periodStart)}
                          className="rounded-full p-1.5 text-ink-3 outline-none hover:bg-surface hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <Trash2Icon aria-hidden className="size-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TableDownload name={`Recent values: ${option.label}`} />
          </div>
        )}
      </div>
    </div>
  );
}
