"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { Panel } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { kzHref, lastWeek, seriesOf } from "@/lib/metrics/kz-detail";
import { eventHealth, costCoverage, trackingWarning, type EventState } from "@/lib/metrics/kz-tracking";
import type { Tile } from "@/lib/metrics/scorecard";

const count = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const STATE: Record<EventState, { tone: StatusTone; label: string }> = {
  silent: { tone: "danger", label: "Silent" },
  dropped: { tone: "warning", label: "Dropped" },
  ok: { tone: "success", label: "Steady" },
  rare: { tone: "neutral", label: "Rare" },
};

/** A row's weeks as small bars, the newest in full ink. For the eye only: the figures are beside it. */
function Bars({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg aria-hidden width={values.length * 9} height={20} viewBox={`0 0 ${values.length * 9} 20`} className="block">
      {values.map((v, i) => {
        const h = v === 0 ? 1.5 : Math.max(2, (v / max) * 18);
        return (
          <rect key={i} x={i * 9} y={20 - h} width={6} height={h} rx={1} fill="var(--chart-1)" opacity={i === values.length - 1 ? 1 : 0.5} />
        );
      })}
    </svg>
  );
}

/**
 * One line on top of the overview, only when an event the figures are made
 * of went silent or dropped: those figures may read low for no reason in the
 * app. Nothing while every event is steady, or before the events are read.
 */
export function TrackingWarning({ span, end }: { span: number; end: string | null }) {
  const { companies } = useViewer();
  const events = useQuery(api.kzProduct.breakdowns, companies.includes("kz") ? { kind: "event" } : "skip");
  if (events === undefined) return null;
  const words = trackingWarning(eventHealth(events).rows);
  if (words === null) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-card bg-panel px-4 py-3 text-sm text-ink shadow-soft">
      <StatusChip tone="warning">Tracking</StatusChip>
      <span>{words}</span>
      <Link
        href={kzHref({ view: "tracking", module: null }, span, end)}
        scroll={false}
        className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Open Tracking health
      </Link>
    </div>
  );
}

/**
 * Product › Kazakhstan › Tracking health: whether the app is still sending
 * what the figures are made of. An event that went quiet makes a figure fall
 * for no reason in the app; a field that arrives empty makes it unknowable.
 * Event names and counts only, for viewers on Globex.
 */
export function TrackingView({ tiles }: { tiles: readonly Tile[] }) {
  const { companies } = useViewer();
  const onKz = companies.includes("kz");
  const events = useQuery(api.kzProduct.breakdowns, onKz ? { kind: "event" } : "skip");
  const fields = useQuery(api.kzProduct.breakdowns, onKz ? { kind: "field" } : "skip");
  if (!onKz) {
    return (
      <Panel>
        <p className="text-sm text-ink-2">Tracking health is {COMPANIES.kz.name}&apos;s, and you are not on {COMPANIES.kz.name}.</p>
      </Panel>
    );
  }
  if (events === undefined || fields === undefined) return <Skeleton className="h-96 w-full rounded-card" />;

  const health = eventHealth(events);
  const coverage = costCoverage(events);
  const trials = lastWeek(seriesOf(tiles, "trial_ended_per_doctor"));
  const weeks = [...new Set(fields.map((f) => f.weekStart))].sort();
  const newestFields = fields.filter((f) => f.weekStart === weeks.at(-1));
  const troubled = health.rows.filter((r) => r.state === "silent" || r.state === "dropped").length;

  return (
    <section aria-label="Tracking health" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-card bg-panel p-4 shadow-soft">
          <p className="text-xs text-ink-2">Events silent or dropped</p>
          <p className="mt-2 text-xl text-ink">
            {troubled === 0 ? <StatusChip tone="success">None</StatusChip> : <StatusChip tone="danger">{troubled} events</StatusChip>}
          </p>
          <p className="mt-2 text-xs text-ink-2">of {health.rows.length} the app sends; a figure made of one is wrong</p>
        </div>
        <div className="rounded-card bg-panel p-4 shadow-soft">
          <p className="text-xs text-ink-2">trial_ended events a doctor</p>
          <p className="mt-2 text-xl text-ink">
            {trials === null ? (
              <span className="text-base text-ink-3">Not read yet</span>
            ) : (
              <span className="inline-flex items-center gap-2">
                {count(trials.value)}
                {trials.value > 1.5 && <StatusChip tone="warning">Sent more than once</StatusChip>}
              </span>
            )}
          </p>
          <p className="mt-2 text-xs text-ink-2">should be one, when the trial ends; more inflates the trials ended</p>
        </div>
        <div className="rounded-card bg-panel p-4 shadow-soft">
          <p className="text-xs text-ink-2">Fields arriving empty</p>
          <p className="mt-2 text-xl text-ink">
            {count(newestFields.filter((f) => (f.values.missing ?? 0) / Math.max(1, f.values.total ?? 0) >= 0.2).length)}
          </p>
          <p className="mt-2 text-xs text-ink-2">empty in a fifth of their events or more, last week</p>
        </div>
      </div>

      <Panel aria-label="Events" className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-ink">What the app sends, by week</h2>
          <p className="mt-1 text-xs text-ink-2">
            Silent: none in the last two weeks, after usually 5 or more a week while it was sent.
            Dropped: last week under half its usual (the 4 weeks before). Silent and dropped first.
          </p>
        </div>
        <DataTable caption="Events, the last 8 weeks" className="min-w-[48rem]">
          <DataHead>
            <DataHeader>Event</DataHeader>
            <DataHeader>Weeks{health.weeks.length > 0 ? ` from ${short(health.weeks[0]!)}` : ""}</DataHeader>
            <DataHeader numeric>Last week</DataHeader>
            <DataHeader numeric>Usual</DataHeader>
            <DataHeader numeric>Doctors</DataHeader>
            <DataHeader>Last seen</DataHeader>
            <DataHeader>State</DataHeader>
          </DataHead>
          <DataBody>
            {health.rows.map((r) => (
              <DataRow key={r.event} tone={r.state === "silent" ? "danger" : r.state === "dropped" ? "warning" : undefined}>
                <DataRowHeader className="font-mono text-xs font-normal">{r.event}</DataRowHeader>
                <DataCell exportValue={r.counts.join(" ")}>
                  <Bars values={r.counts} />
                </DataCell>
                <DataCell numeric>{count(r.counts.at(-1) ?? 0)}</DataCell>
                <DataCell numeric className="text-ink-2">{r.usual === null ? "—" : count(r.usual)}</DataCell>
                <DataCell numeric className="text-ink-2">{count(r.users)}</DataCell>
                <DataCell className="text-ink-2">{r.lastSeen === null ? "—" : `week of ${short(r.lastSeen)}`}</DataCell>
                <DataCell>
                  <StatusChip variant="outline" tone={STATE[r.state].tone}>
                    {STATE[r.state].label}
                  </StatusChip>
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel aria-label="AI cost recorded" className="min-w-0 space-y-2">
          <h2 className="text-base font-medium text-ink">AI cost recorded for each result</h2>
          <p className="text-xs text-ink-2">
            Cost events against results last week. Under 80% the AI cost of the module is understated.
          </p>
          <DataTable caption="AI cost recorded, by module" download={false}>
            <DataHead>
              <DataHeader>Module</DataHeader>
              <DataHeader numeric>Results</DataHeader>
              <DataHeader numeric>Cost events</DataHeader>
              <DataHeader>Recorded</DataHeader>
            </DataHead>
            <DataBody>
              {coverage.map((c) => (
                <DataRow key={c.label} tone={c.share !== null && c.share < 80 ? "warning" : undefined}>
                  <DataRowHeader className="font-normal">{c.label}</DataRowHeader>
                  <DataCell numeric>{count(c.results)}</DataCell>
                  <DataCell numeric>{count(c.costs)}</DataCell>
                  <DataCell>
                    {c.share === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <StatusChip variant="outline" tone={c.share < 80 ? "warning" : "success"}>
                        {count(c.share)}%
                      </StatusChip>
                    )}
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        </Panel>
        <Panel aria-label="Fields arriving empty" className="min-w-0 space-y-2">
          <h2 className="text-base font-medium text-ink">Fields arriving empty</h2>
          <p className="text-xs text-ink-2">
            Last week, the share of an event that came without the field. A figure that needs it
            cannot be worked out where it is missing.
          </p>
          <DataTable caption="Empty fields" download={false}>
            <DataHead>
              <DataHeader>Event · field</DataHeader>
              <DataHeader>Empty</DataHeader>
            </DataHead>
            <DataBody>
              {[...newestFields]
                .map((f) => ({ key: f.key, share: Math.round(((f.values.missing ?? 0) / Math.max(1, f.values.total ?? 0)) * 100) }))
                .sort((a, b) => b.share - a.share)
                .map((f) => (
                  <DataRow key={f.key}>
                    <DataRowHeader className="font-mono text-xs font-normal">{f.key}</DataRowHeader>
                    <DataCell>
                      <StatusChip variant="outline" tone={f.share >= 50 ? "danger" : f.share >= 20 ? "warning" : "success"}>
                        {f.share}%
                      </StatusChip>
                    </DataCell>
                  </DataRow>
                ))}
            </DataBody>
          </DataTable>
        </Panel>
      </div>
    </section>
  );
}
