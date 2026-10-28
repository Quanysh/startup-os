"use client";

import { useQuery } from "convex/react";
import { useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { KZ_MODULES, moduleKey, type KzModuleId } from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import { MonthBars } from "@/components/metrics/month-bars";
import { Panel, fieldClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { FLAT_SECONDS_PERCENT, chartSeries, changeOf, spanOf, type Week } from "@/lib/metrics/kz-detail";
import { weekRows } from "@/lib/metrics/product";
import type { Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

const count = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const seconds = (n: number) => `${count(n)} s`;
const percent = (n: number) => `${count(n)}%`;
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const tokens = (n: number) => (n >= 1000 ? `${count(Math.round(n / 100) / 10)}k` : count(n));
/** Over this share of answers taking a minute, a module is slow (the review's alert). */
const SLOW_SHARE_ALERT = 10;
const SLOW_SHARE_WATCH = 5;

function Move({
  week,
  format = count,
  flat,
  better = "down",
}: {
  week: Week | null;
  format?: (v: number) => string;
  flat?: number;
  better?: "up" | "down";
}) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{format(week.previous)} → </span>}
        <span className="font-medium text-ink">{format(week.value)}</span>
      </span>
      <Delta change={changeOf(week, better, "relative", flat)} />
    </span>
  );
}

function Figure({ label, children, note }: { label: string; children: ReactNode; note: string }) {
  return (
    <div className="min-w-0 rounded-card bg-panel p-4 shadow-soft">
      <p className="text-xs text-ink-2">{label}</p>
      <div className="mt-2 text-xl text-ink">{children}</div>
      <p className="mt-2 text-xs text-ink-2">{note}</p>
    </div>
  );
}

/** Interface response by the web's own bands: good to 200 ms, poor past 500. */
const inpTone = (ms: number): StatusTone => (ms <= 200 ? "success" : ms <= 500 ? "warning" : "danger");

/**
 * Product › Kazakhstan › Speed & AI: how long doctors wait, what the model
 * costs and which model answered, and how the interface responds, from
 * PostHog's app.globex.example.com project. Weekly figures over the period picked;
 * pages from the breakdowns, for viewers on Globex.
 */
export function SpeedView({ tiles, span, end }: { tiles: readonly Tile[]; span: number; end: string | null }) {
  const { companies, can } = useViewer();
  // AI cost a result is a finance figure: its column is left out without Finance.
  const finance = can("finance");
  const pages = useQuery(api.kzProduct.breakdowns, companies.includes("kz") ? { kind: "page" } : "skip");
  const week = (key: string) => spanOf(tiles, key, span, end);
  const rows = KZ_MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    p50: week(moduleKey("p50", m.id)),
    p95: week(moduleKey("p95", m.id)),
    slow: week(moduleKey("slow_share", m.id)),
    hedged: week(moduleKey("hedged_share", m.id)),
    unit: week(moduleKey("cost_per_result", m.id)),
    tokens: week(moduleKey("tokens_p95", m.id)),
  }))
    .filter((r) => r.p50 !== null || r.p95 !== null)
    .sort((a, b) => (b.slow?.value ?? -1) - (a.slow?.value ?? -1));
  const [picked, setPicked] = useState<KzModuleId | null>(null);
  const chartModule = picked ?? rows[0]?.id ?? "search";
  const offModel = week("ai_calls_off_model");

  const newest = pages === undefined ? [] : [...new Set(pages.map((p) => p.weekStart))].sort();
  const lastWeekPages = (pages ?? []).filter((p) => p.weekStart === newest.at(-1));
  const before = new Map((pages ?? []).filter((p) => p.weekStart === newest.at(-2)).map((p) => [p.key, p.values]));

  return (
    <section aria-label="Speed & AI" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label="AI calls" note={span === 1 ? "the week before → last week" : `the ${span} weeks before → the last ${span}`}>
          <Move week={week("ai_calls")} better="up" />
        </Figure>
        <Figure label="Calls by a model not on the list" note="any is a sign the provider switched models">
          {offModel === null ? (
            <span className="text-base text-ink-3">Not read yet</span>
          ) : offModel.value > 0 ? (
            <StatusChip tone="danger">{count(offModel.value)} calls</StatusChip>
          ) : (
            <StatusChip tone="success">None</StatusChip>
          )}
        </Figure>
        <Figure label="Interface response (INP p75)" note="good to 200 ms, poor past 500">
          <Move week={week("inp_p75")} format={(v) => `${count(v)} ms`} flat={FLAT_SECONDS_PERCENT} />
        </Figure>
        <Figure label="Rage clicks" note={`in ${week("rage_session_share")?.value ?? "—"}% of sessions`}>
          <Move week={week("rage_clicks")} flat={FLAT_SECONDS_PERCENT} />
        </Figure>
      </div>

      <Panel aria-label="Speed by module" className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-ink">{finance ? "How long doctors wait, and what it costs" : "How long doctors wait"}</h2>
          <p className="mt-1 text-xs text-ink-2">
            The slowest modules first. Over 60 s for more than {SLOW_SHARE_ALERT}% of answers is slow;
            answer times move a lot from week to week, so only a fifth or more is coloured.
          </p>
        </div>
        <DataTable caption="Speed and AI by module" className="min-w-[68rem]">
          <DataHead>
            <DataHeader pinned>Module</DataHeader>
            <DataHeader>Median answer</DataHeader>
            <DataHeader>Slowest (p95)</DataHeader>
            <DataHeader>Over 60 s</DataHeader>
            <DataHeader>Sent twice (hedged)</DataHeader>
            {finance && <DataHeader>AI cost a result</DataHeader>}
            <DataHeader>Largest requests (tokens)</DataHeader>
          </DataHead>
          <DataBody>
            {rows.map((r) => (
              <DataRow key={r.id} tone={(r.slow?.value ?? 0) > SLOW_SHARE_ALERT ? "danger" : undefined}>
                <DataRowHeader pinned className="font-normal">
                  <button
                    type="button"
                    onClick={() => setPicked(r.id)}
                    aria-pressed={chartModule === r.id}
                    className={cn(
                      "rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50",
                      chartModule === r.id ? "font-medium text-ink" : "text-brand",
                    )}
                  >
                    {r.label}
                  </button>
                </DataRowHeader>
                <DataCell>
                  <Move week={r.p50} format={seconds} flat={FLAT_SECONDS_PERCENT} />
                </DataCell>
                <DataCell>
                  <Move week={r.p95} format={seconds} flat={FLAT_SECONDS_PERCENT} />
                </DataCell>
                <DataCell>
                  {r.slow === null ? (
                    <span className="text-ink-3">Not read yet</span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <Move week={r.slow} format={percent} flat={FLAT_SECONDS_PERCENT} />
                      {r.slow.value > SLOW_SHARE_ALERT ? (
                        <StatusChip variant="outline" tone="danger">Slow</StatusChip>
                      ) : r.slow.value > SLOW_SHARE_WATCH ? (
                        <StatusChip variant="outline" tone="warning">Watch</StatusChip>
                      ) : null}
                    </span>
                  )}
                </DataCell>
                <DataCell>
                  <Move week={r.hedged} format={percent} flat={FLAT_SECONDS_PERCENT} />
                </DataCell>
                {finance && (
                  <DataCell>
                    <Move week={r.unit} format={dollars} flat={FLAT_SECONDS_PERCENT} />
                  </DataCell>
                )}
                <DataCell>
                  <Move week={r.tokens} format={tokens} flat={FLAT_SECONDS_PERCENT} />
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
        <p className="text-xs text-ink-2">
          Hedged: the backend sent the same request twice because the first was slow, an early sign
          the model is slowing down. Largest requests: the 95th percentile of input tokens; when it
          grows, answers get slower and dearer. Pick a module for its weeks.
        </p>
      </Panel>

      <Panel className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-ink">
            {KZ_MODULES.find((m) => m.id === chartModule)?.label}: answer time by week
          </h2>
          <select
            aria-label="Module"
            value={chartModule}
            onChange={(e) => setPicked(e.target.value as KzModuleId)}
            className={cn(fieldClass, "h-9 w-auto rounded-full pr-8")}
          >
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <MonthBars
          title="Median and slowest answer, seconds"
          grain="week"
          mode="grouped"
          series={[
            { id: "p50", label: "Median (p50)", color: "var(--chart-1)" },
            { id: "p95", label: "Slowest (p95)", color: "var(--chart-2)" },
          ]}
          rows={weekRows({
            p50: chartSeries(tiles, moduleKey("p50", chartModule)),
            p95: chartSeries(tiles, moduleKey("p95", chartModule)),
          })}
          format={count}
        />
      </Panel>

      <Panel aria-label="Interface by page" className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-ink">The interface, by page</h2>
          <p className="mt-1 text-xs text-ink-2">
            Last week: how fast a page answers a click (INP p75), how often it is slow, and rage
            clicks (several fast clicks on one spot: something did not respond).
          </p>
        </div>
        {lastWeekPages.length === 0 ? (
          <p className="text-sm text-ink-2">No page read yet.</p>
        ) : (
          <DataTable caption="Pages" className="min-w-[44rem]">
            <DataHead>
              <DataHeader>Page</DataHeader>
              <DataHeader>Interface response (INP p75)</DataHeader>
              <DataHeader numeric>Slow responses</DataHeader>
              <DataHeader>Rage clicks</DataHeader>
            </DataHead>
            <DataBody>
              {[...lastWeekPages]
                .sort((a, b) => (b.values.inp_p75 ?? 0) - (a.values.inp_p75 ?? 0))
                .map((p) => {
                  const was = before.get(p.key);
                  const inp = p.values.inp_p75 ?? 0;
                  return (
                    <DataRow key={p.key} tone={inp > 500 ? "danger" : undefined}>
                      <DataRowHeader className="font-mono text-xs font-normal">{p.key}</DataRowHeader>
                      <DataCell className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <span className="font-num">
                            {was?.inp_p75 !== undefined && <span className="text-ink-3">{count(was.inp_p75)} → </span>}
                            <span className="font-medium text-ink">{count(inp)} ms</span>
                          </span>
                          <StatusChip variant="outline" tone={inpTone(inp)}>
                            {inp <= 200 ? "Good" : inp <= 500 ? "Needs work" : "Poor"}
                          </StatusChip>
                        </span>
                      </DataCell>
                      <DataCell numeric>{percent(p.values.inp_poor ?? 0)}</DataCell>
                      <DataCell>
                        <Move
                          week={{ periodStart: p.weekStart, value: p.values.rage ?? 0, previous: was?.rage ?? null }}
                          flat={FLAT_SECONDS_PERCENT}
                        />
                      </DataCell>
                    </DataRow>
                  );
                })}
            </DataBody>
          </DataTable>
        )}
      </Panel>
    </section>
  );
}
