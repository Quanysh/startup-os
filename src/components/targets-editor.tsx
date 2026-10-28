"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import {
  METRICS,
  SCOPE_LABELS,
  currencyOf,
  metricScopes,
  type MetricDef,
  type Scope,
} from "@convex/lib/metricRegistry";
import { fieldClass } from "@/components/panel";
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
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, type KindTone } from "@/components/ui/status-chip";
import { useCompany } from "@/components/company-provider";
import { useViewer } from "@/hooks/use-viewer";
import { companyOfMetric } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { formatValue } from "@/lib/format";
import { cn } from "@/lib/utils";

// A scope wears its company's hue (teal Startup and its products, sand
// Kazakhstan), and the whole company the plain slate: the rows of one company
// are found at a glance. The same hues as the team table's companies.
const SCOPE_TONE: Record<Scope, KindTone> = {
  company: "slate",
  us: "teal",
  startup_insights: "teal",
  vertical_startup: "teal",
  kz: "sand",
  kz_product: "sand",
};

const ROWS = METRICS.filter((m) => m.home !== undefined)
  .sort((a, b) => (a.home ?? 0) - (b.home ?? 0))
  .flatMap((metric) => metricScopes(metric).map((scope) => ({ metric, scope })));

/**
 * The target for each scorecard number. A tile turns "on target" or "off
 * target" against it. This is a commitment, not a benchmark: the benchmark
 * says what the market does, the target says what Startup will do.
 *
 * Set by whoever holds the `settings` area, for the numbers of their own
 * companies: the server refuses any other (`targets.set`), so they are not
 * listed. Anyone else who is sent the targets (the scorecard) reads them,
 * with nothing to change. On Goals and targets, the company in view's.
 */
export function TargetsEditor() {
  const { companies, can } = useViewer();
  const inView = useCompany();
  const editable = can("settings");
  const targets = useQuery(api.targets.list);
  if (targets === undefined) return <Skeleton className="h-40 rounded-inner" />;

  return (
    <DataTable caption="Targets" className={editable ? "min-w-[40rem]" : "min-w-[28rem]"}>
      <DataHead>
        <DataHeader pinned>Number</DataHeader>
        <DataHeader>Scope</DataHeader>
        <DataHeader numeric>Target</DataHeader>
        <DataHeader>Per</DataHeader>
        {/* A field to type in: not in the download. */}
        {editable && <DataHeader noExport>New target</DataHeader>}
        {editable && <ActionsHeader />}
      </DataHead>
      <DataBody>
        {ROWS.filter(({ metric, scope }) => {
          const company = companyOfMetric(metric.key, scope);
          return companies.includes(company) && (inView === null || inView === company);
        }).map(({ metric, scope }) => (
          <TargetRow
            key={`${metric.key}:${scope}`}
            metric={metric}
            scope={scope}
            current={targets.find((t) => t.key === metric.key && t.scope === scope)?.target}
            editable={editable}
          />
        ))}
      </DataBody>
    </DataTable>
  );
}

function TargetRow({
  metric,
  scope,
  current,
  editable,
}: {
  metric: MetricDef;
  scope: Scope;
  current: number | undefined;
  editable: boolean;
}) {
  const set = useMutation(api.targets.set);
  const clear = useMutation(api.targets.clear);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currency = currencyOf(metric, scope);
  const label = `${metric.label} · ${SCOPE_LABELS[scope]}`;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) return setError("Enter a number.");
    try {
      await set({ key: metric.key, scope, target: value });
      setDraft("");
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const remove = async () => {
    try {
      await clear({ key: metric.key, scope });
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  return (
    <DataRow>
      <DataRowHeader pinned>{metric.label}</DataRowHeader>
      <DataCell className="whitespace-nowrap">
        <KindTag tone={SCOPE_TONE[scope]}>{SCOPE_LABELS[scope]}</KindTag>
      </DataCell>
      <DataCell numeric className={cn(current === undefined ? "font-sans text-ink-2" : "font-medium")}>
        {current === undefined ? "No target" : formatValue(current, metric.unit, currency)}
      </DataCell>
      <DataCell className="whitespace-nowrap text-ink-2">{metric.grain}</DataCell>
      {editable && (
        <>
      <DataCell actions className="text-left">
        <form onSubmit={save} className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            aria-label={`New target for ${label}${currency ? ` in ${currency}` : ""}`}
            aria-invalid={error !== null}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder={currency ?? "Value"}
            className={`${fieldClass} h-9 w-32 font-num`}
          />
          <button
            type="submit"
            className="h-9 rounded-full bg-brand-fill px-4 text-xs font-medium text-on-brand outline-none hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Set<span className="sr-only"> the target for {label}</span>
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-1 text-xs whitespace-normal text-destructive">
            {error}
          </p>
        )}
      </DataCell>
      <DataCell actions>
        <button
          type="button"
          disabled={current === undefined}
          onClick={remove}
          className={cn(rowActionClass, "text-xs disabled:invisible")}
        >
          Clear<span className="sr-only"> the target for {label}</span>
        </button>
      </DataCell>
        </>
      )}
    </DataRow>
  );
}
