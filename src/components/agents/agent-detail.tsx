"use client";

import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import {
  PROVIDER_INFO,
  isKnownProvider,
  providerLabel,
  type Control,
  type ModelPair,
  type ModelRow,
  type SeriesDay,
} from "@convex/lib/agentControl";
import { PRODUCT } from "@convex/lib/identity";
import { RUNS_ON, RUNS_ON_LINES, RUNS_ON_WORDS, type RunsOn } from "@convex/lib/osAgents";
import { LineChart } from "@/components/finance/line-chart";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
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
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { ms, pairWords, percent, usd } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { ChangeLog } from "./change-log";
import { BuilderTab } from "./builder-tab";
import { HarnessTab } from "./harness-tab";
import { PatientDataTag, RunsOnChip } from "./parts";
import { RunsTab } from "./runs-tab";
import { TestsTab } from "./tests-tab";
import { VersionsTab } from "./versions-tab";

const CODE_TABS = ["overview", "harness", "tests", "versions", "runs"] as const;
/** An agent built here: its Builder in place of the Harness tab. */
const BUILT_TABS = ["overview", "builder", "tests", "versions", "runs"] as const;
export type DetailTab = (typeof CODE_TABS)[number] | (typeof BUILT_TABS)[number];
const TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  harness: "Harness",
  builder: "Builder",
  tests: "Tests",
  versions: "Versions",
  runs: "Runs",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayName = (day: string) => `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** One figure over thirty days: one line in the first chart colour, a gap where nothing was reported. */
function Trend({
  title,
  series,
  pick,
  format,
}: {
  title: string;
  series: readonly SeriesDay[];
  pick: (day: SeriesDay) => number | null;
  format: (value: number) => string;
}) {
  const values = series.map(pick);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-xs font-medium text-ink-2">{title}</figcaption>
      {values.every((value) => value === null) ? (
        <p className="text-sm text-ink-3">Nothing reported in thirty days.</p>
      ) : (
        <LineChart
          label={`${title}, last thirty days`}
          xs={series.map((day) => day.day)}
          xLabel={(i) => dayName(series[i]!.day)}
          xName={(i) => dayName(series[i]!.day)}
          labelEvery={7}
          height={120}
          lines={[{ id: title, label: title, color: "var(--chart-1)", values, dots: false }]}
          format={format}
        />
      )}
    </figure>
  );
}

/** Each model the agent ran on in thirty days, side by side. */
function ModelComparison({ rows }: { rows: readonly ModelRow[] }) {
  return (
    <DataTable label="Models compared" download="Agent models" className="min-w-[44rem]">
      <DataHead>
        <DataHeader pinned>Model</DataHeader>
        <DataHeader numeric>Days</DataHeader>
        <DataHeader numeric>Calls</DataHeader>
        <DataHeader numeric>Errors</DataHeader>
        <DataHeader numeric>Schema failures</DataHeader>
        <DataHeader numeric>Worst p95</DataHeader>
        <DataHeader numeric strong>
          Cost a call
        </DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => (
          <DataRow key={`${row.provider}:${row.model}`}>
            <DataRowHeader pinned>
              {row.model}
              <p className="mt-0.5 text-xs font-normal text-ink-2">{providerLabel(row.provider)}</p>
            </DataRowHeader>
            <DataCell numeric>{row.days}</DataCell>
            <DataCell numeric>{row.calls.toLocaleString("en-US")}</DataCell>
            <DataCell numeric>{row.errorRate === null ? <Blank /> : percent(row.errorRate)}</DataCell>
            <DataCell numeric>{row.schemaFailureRate === null ? <Blank /> : percent(row.schemaFailureRate)}</DataCell>
            <DataCell numeric>{row.p95Ms === null ? <Blank /> : ms(row.p95Ms)}</DataCell>
            <DataCell numeric strong>
              {row.costPerCallUsd === null ? <Blank>Not priced</Blank> : `$${row.costPerCallUsd.toFixed(4)}`}
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}

const keyOf = (pair: ModelPair) => `${pair.provider}|${pair.model}`;
const pairOf = (key: string): ModelPair => {
  const [provider, ...rest] = key.split("|");
  return { provider: provider!, model: rest.join("|") };
};

const optionWords = (pair: ModelPair) => {
  const info = isKnownProvider(pair.provider) ? PROVIDER_INFO[pair.provider] : null;
  return `${pairWords(pair)}${info !== null && !info.patientData ? " (not for patient data)" : ""}`;
};

/** The model, fallback and budget, changed together; the switch is the table's. */
function Controls({
  project,
  agentId,
  current,
  desired,
  choices,
}: {
  project: string;
  agentId: string;
  current: ModelPair;
  desired: Control | null;
  choices: readonly ModelPair[];
}) {
  const change = useMutation(api.agentControl.change);
  const fallbackNow =
    desired?.fallbackProvider != null && desired.fallbackModel != null
      ? { provider: desired.fallbackProvider, model: desired.fallbackModel }
      : null;
  const [primary, setPrimary] = useState(keyOf(current));
  const [fallback, setFallback] = useState(fallbackNow === null ? "" : keyOf(fallbackNow));
  const [budget, setBudget] = useState(desired?.monthlyBudgetUsd == null ? "" : String(desired.monthlyBudgetUsd));
  const [state, setState] = useState<{ saving: boolean; error: string | null; saved: boolean }>({
    saving: false,
    error: null,
    saved: false,
  });

  // What may be chosen: the models up now, and whatever it has.
  const options = [current, ...(fallbackNow === null ? [] : [fallbackNow]), ...choices].filter(
    (pair, i, all) => all.findIndex((other) => keyOf(other) === keyOf(pair)) === i,
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = budget.trim();
    const amount = typed === "" ? null : Number(typed);
    setState({ saving: true, error: null, saved: false });
    try {
      await change({
        project,
        agentId,
        ...pairOf(primary),
        fallback: fallback === "" ? null : pairOf(fallback),
        monthlyBudgetUsd: amount,
      });
      setState({ saving: false, error: null, saved: true });
    } catch (failure) {
      setState({ saving: false, error: messageOf(failure), saved: false });
    }
  };

  const id = `agent-${agentId}`;
  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
      <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-model`}>
        Model
        <select
          id={`${id}-model`}
          value={primary}
          onChange={(event) => setPrimary(event.target.value)}
          className={`${fieldClass} mt-1 h-10`}
        >
          {options.map((pair) => (
            <option key={keyOf(pair)} value={keyOf(pair)}>
              {optionWords(pair)}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-fallback`}>
        Fallback
        <select
          id={`${id}-fallback`}
          value={fallback}
          onChange={(event) => setFallback(event.target.value)}
          className={`${fieldClass} mt-1 h-10`}
        >
          <option value="">No fallback</option>
          {options
            .filter((pair) => keyOf(pair) !== primary)
            .map((pair) => (
              <option key={keyOf(pair)} value={keyOf(pair)}>
                {optionWords(pair)}
              </option>
            ))}
        </select>
      </label>
      <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-budget`}>
        Monthly budget, USD
        <input
          id={`${id}-budget`}
          inputMode="decimal"
          placeholder="No budget"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          className={`${fieldClass} mt-1 h-10`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-3">
        <button type="submit" disabled={state.saving} className={primaryButtonClass}>
          {state.saving ? "Saving…" : "Save and send"}
        </button>
        {state.saved && <p className="text-sm text-ink-2">Saved. It is pending until the project applies it.</p>}
        {state.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * Where one of Startup OS's own four runs: Claude on the owner's Mac, or Gemini
 * in Startup OS. The owner's choice (the server refuses anyone else), a change
 * of its control with its record; only one runner ever runs it.
 */
function RunsOnControl({ project, agentId, runsOn }: { project: string; agentId: string; runsOn: RunsOn }) {
  const change = useMutation(api.agentControl.change);
  const [chosen, setChosen] = useState<RunsOn>(runsOn);
  const [state, setState] = useState<{ saving: boolean; error: string | null; saved: boolean }>({
    saving: false,
    error: null,
    saved: false,
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ saving: true, error: null, saved: false });
    try {
      await change({ project, agentId, runsOn: chosen });
      setState({ saving: false, error: null, saved: true });
    } catch (failure) {
      setState({ saving: false, error: messageOf(failure), saved: false });
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="grid gap-2 md:grid-cols-2">
        <legend className="sr-only">Runs on</legend>
        {RUNS_ON.map((where) => (
          <label
            key={where}
            className={cn(
              "flex min-w-0 cursor-pointer gap-3 rounded-inner border p-3 text-sm",
              chosen === where ? "border-brand bg-surface" : "border-line bg-panel",
            )}
          >
            <input
              type="radio"
              name={`${agentId}-runs-on`}
              value={where}
              checked={chosen === where}
              onChange={() => setChosen(where)}
              className="mt-1 shrink-0 accent-brand"
            />
            <span className="min-w-0">
              <span className="font-medium text-ink">{RUNS_ON_WORDS[where]}</span>
              <span className="mt-0.5 block text-xs text-ink-2">{RUNS_ON_LINES[where]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.saving || chosen === runsOn} className={primaryButtonClass}>
          {state.saving ? "Saving…" : "Save"}
        </button>
        {state.saved && <p className="text-sm text-ink-2">{`Saved: it runs on ${RUNS_ON_WORDS[chosen]} from its next run.`}</p>}
        {state.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

/** One agent opened from the table: its trends, its models, its controls and its changes. */
export function AgentDetail({
  project,
  agentId,
  today,
  now,
  initialTab = "overview",
  onClose,
}: {
  project: string;
  agentId: string;
  today: string;
  now: number;
  /** The tab it opens on: a new agent built here opens on its Builder. */
  initialTab?: DetailTab;
  onClose: () => void;
}) {
  const detail = useQuery(api.agentControl.agent, { project, agentId, today });
  const [tab, setTab] = useState<DetailTab>(initialTab);
  // The Harness, Builder, Versions and Runs tabs read the same query: only asked for while one is open.
  const harness = useQuery(
    api.agentHarness.harness,
    detail != null && tab !== "overview" && tab !== "tests" ? { project, agentId } : "skip",
  );
  if (detail === undefined) return <Skeleton className="h-96 rounded-inner" />;
  const close = (
    <button type="button" onClick={onClose} className={quietButtonClass}>
      Close
    </button>
  );
  if (detail === null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">There is no agent by that id.</p>
        {close}
      </div>
    );
  }
  const current = detail.current;
  const currentProvider = current !== null && isKnownProvider(current.provider) ? PROVIDER_INFO[current.provider] : null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base break-all">{detail.name ?? detail.agentId}</h3>
          <p className="mt-1 text-xs text-ink-2">
            {`${detail.name === null ? "" : `${detail.agentId} in `}${detail.projectName}. ${current === null ? "Not published yet" : `On ${pairWords(current)}`}${detail.promptVersion === null ? "" : `, prompt ${detail.promptVersion}`}.`}
          </p>
          {detail.waiting && <p className="mt-1 text-xs text-ink-2">Waiting for the project to report it.</p>}
          {detail.builtHere && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
              <KindTag tone="violet">Built here</KindTag>
              {detail.runsOn !== null && <RunsOnChip runsOn={detail.runsOn} />}
              {detail.osAgent
                ? `One of ${PRODUCT.name}'s own four: its instructions, tools and schedule are set on its Builder tab, then published. Yours alone.`
                : "Its model, tools and triggers are set on its Builder tab, then tested and published."}
            </p>
          )}
          {currentProvider !== null && (
            <div className="mt-2">
              <PatientDataTag allowed={currentProvider.patientData} />
            </div>
          )}
        </div>
        {close}
      </div>

      <div role="tablist" aria-label="This agent" className="inline-flex max-w-full flex-wrap gap-1 rounded-full bg-surface p-1">
        {(detail.builtHere ? BUILT_TABS : CODE_TABS).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              tab === name ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TAB_LABELS[tab]} className="space-y-6">
        {tab === "harness" || tab === "builder" || tab === "versions" || tab === "runs" ? (
          harness === undefined ? (
            <Skeleton className="h-64 rounded-inner" />
          ) : tab === "runs" ? (
            harness.ownerOnly && !harness.isOwner ? (
              <p className="text-sm text-ink-2">This agent&apos;s runs are the owner&apos;s to read: it uses a tool of a page only the owner may give.</p>
            ) : (
              <RunsTab
                project={detail.project}
                agentId={detail.agentId}
                now={now}
                isOwner={harness.isOwner}
                input={harness.published?.definition?.input ?? null}
                runsOn={detail.runsOn}
              />
            )
          ) : tab === "builder" || (tab === "harness" && harness.built) ? (
            <BuilderTab view={harness} now={now} runsOn={detail.runsOn} />
          ) : tab === "harness" ? (
            <HarnessTab view={harness} now={now} />
          ) : (
            <VersionsTab view={harness} now={now} />
          )
        ) : tab === "tests" ? (
          <TestsTab project={detail.project} agentId={detail.agentId} now={now} />
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <Trend title="Calls a day" series={detail.series} pick={(d) => d.calls} format={(v) => v.toLocaleString("en-US")} />
              <Trend title="Cost a day" series={detail.series} pick={(d) => d.costUsd} format={usd} />
              <Trend title="p95 latency, worst model" series={detail.series} pick={(d) => d.p95Ms} format={ms} />
              <Trend title="Errors, share of calls" series={detail.series} pick={(d) => d.errorRate} format={percent} />
            </div>

            {detail.models.length > 1 && (
              <section aria-label="Models compared" className="space-y-2">
                <h4 className="text-sm font-medium text-ink">Models compared, thirty days</h4>
                <ModelComparison rows={detail.models} />
              </section>
            )}

            {current !== null && !detail.builtHere && (
            <section aria-label="Controls" className="space-y-2">
              <h4 className="text-sm font-medium text-ink">Change the model, fallback or budget</h4>
              <p className="max-w-3xl text-xs text-ink-2">
                {`Only a model its project last saw up, on a provider it may use (${detail.holdsPatientData || detail.phi === true ? "for patient data only" : "any it was given"}), can be chosen, or the one it has. A budget is what this agent may spend in a month; the project decides what happens past it.`}
              </p>
              <Controls
                key={`${keyOf(current)}|${detail.desired?.version ?? 0}`}
                project={detail.project}
                agentId={detail.agentId}
                current={current}
                desired={detail.desired}
                choices={detail.choices}
              />
            </section>
            )}

            {detail.osAgent && detail.runsOn !== null && (
              <section aria-label="Where it runs" className="space-y-2">
                <h4 className="text-sm font-medium text-ink">Runs on</h4>
                <p className="max-w-3xl text-xs text-ink-2">
                  One runner runs it: the Mac skips it while it runs on Gemini, and {PRODUCT.name} skips it while it runs on the
                  Mac. Both run its published version, at its schedule.
                </p>
                <RunsOnControl key={detail.runsOn} project={detail.project} agentId={detail.agentId} runsOn={detail.runsOn} />
              </section>
            )}

            <section aria-label="This agent's changes" className="space-y-2">
              <h4 className="text-sm font-medium text-ink">Changes</h4>
              {detail.changes.length === 0 ? (
                <p className="text-sm text-ink-3">Not changed from here yet.</p>
              ) : (
                <ChangeLog rows={detail.changes} now={now} showAgent={false} />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
