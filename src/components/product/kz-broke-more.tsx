"use client";

import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { KZ_APP_UTC_OFFSET_HOURS } from "@convex/lib/features";
import { KZ_ERROR_KINDS, errorKindKey } from "@convex/lib/kzProductDetail";
import { Delta } from "@/components/metrics/change-chip";
import { MonthBars } from "@/components/metrics/month-bars";
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
import { StatusChip } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { chartSeries, changeOf, spanOf, utcWords, type Week } from "@/lib/metrics/kz-detail";
import { weekRows } from "@/lib/metrics/product";
import type { Tile } from "@/lib/metrics/scorecard";

const count = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
/** A week with more than this share of uploads failing is a problem (the review's alert). */
const UPLOAD_FAILS_ALERT = 25;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Move({ week, better = "down", format = count }: { week: Week | null; better?: "up" | "down"; format?: (v: number) => string }) {
  if (week === null) return <span className="text-ink-3">Not read yet</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-num">
        {week.previous !== null && <span className="text-ink-3">{format(week.previous)} → </span>}
        <span className="font-medium text-ink">{format(week.value)}</span>
      </span>
      <Delta change={changeOf(week, better)} />
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

/**
 * Errors, beyond the causes: failed uploads as a share of uploads, the
 * busiest hours, and failures by technical type (from the events' own error
 * type, stage and HTTP status, never their text).
 */
export function BrokeFigures({ tiles, span, end }: { tiles: readonly Tile[]; span: number; end: string | null }) {
  const week = (key: string) => spanOf(tiles, key, span, end);
  const uploads = week("uploads");
  const failed = week("uploads_failed");
  const share: Week | null =
    uploads === null || failed === null || uploads.value + failed.value === 0
      ? null
      : {
          periodStart: uploads.periodStart,
          value: Math.round((failed.value / (uploads.value + failed.value)) * 1000) / 10,
          previous:
            uploads.previous === null || failed.previous === null || uploads.previous + failed.previous === 0
              ? null
              : Math.round((failed.previous / (uploads.previous + failed.previous)) * 1000) / 10,
        };
  const kinds = KZ_ERROR_KINDS.map((k) => ({ ...k, week: week(errorKindKey(k.id)) })).sort(
    (a, b) => (b.week?.value ?? -1) - (a.week?.value ?? -1),
  );
  // Four colours at most in a chart: the three that matter most, and the rest together.
  const series = (key: string) => chartSeries(tiles, errorKindKey(key as never));
  const rest = ["network", "auth", "validation", "schema", "unknown"].map(series);
  const restSeries = rest[0]!.map((p, i) => ({
    periodStart: p.periodStart,
    value: rest.reduce((t, s) => t + (s[i]?.value ?? 0), 0),
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label="Failed uploads" note={`of all uploads; over ${UPLOAD_FAILS_ALERT}% is a problem`}>
          <span className="inline-flex flex-wrap items-center gap-2">
            <Move week={share} format={(v) => `${count(v)}%`} />
            {share !== null && share.value > UPLOAD_FAILS_ALERT && <StatusChip tone="danger">Too many</StatusChip>}
          </span>
        </Figure>
        <Figure label="Hours with 5 or more failures" note="a spike shows as many in one day">
          <Move week={week("failure_hours_busy")} />
        </Figure>
        <Figure label="Failures in the worst hour" note="the busiest hour of the period">
          <Move week={week("failure_worst_hour")} />
        </Figure>
        <Figure label="Expired sessions retried" note={`and ${week("auth_redirects")?.value ?? "—"} requests sent to sign-in`}>
          <Move week={week("stale_session_retries")} />
        </Figure>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel className="min-w-0 space-y-2">
          <DataTable caption="Failures by type, from the events' own fields" showCaption>
            <DataHead>
              <DataHeader>Type</DataHeader>
              <DataHeader>Failures</DataHeader>
            </DataHead>
            <DataBody>
              {kinds.map((k) => (
                <DataRow key={k.id} tone={k.id === "http_5xx" && (k.week?.value ?? 0) >= 5 ? "danger" : undefined}>
                  <DataRowHeader className="font-normal">{k.label}</DataRowHeader>
                  <DataCell>
                    <Move week={k.week} />
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
          <p className="text-xs text-ink-2">
            Read from each failure&apos;s error type, stage and HTTP status, so it is exact and holds no
            text; the causes above are read from the message. Server errors (5xx) from 5 a week are red.
          </p>
        </Panel>
        <Panel className="min-w-0">
          <MonthBars
            title="Failures by type, by week"
            grain="week"
            mode="stacked"
            series={[
              { id: "timeout", label: "Timeout", color: "var(--chart-1)" },
              { id: "http", label: "Server error (5xx)", color: "var(--chart-4)" },
              { id: "rest", label: "Everything else", color: "var(--chart-2)" },
            ]}
            rows={weekRows({ timeout: series("timeout"), http: series("http_5xx"), rest: restSeries })}
            format={count}
          />
        </Panel>
      </div>
    </div>
  );
}

/**
 * Failures by day and hour (on the app's users' clock, KZ_APP_UTC_OFFSET_HOURS)
 * for the newest week on record, as a heat
 * map: a cell's shade is its failures against the week's worst hour, and the
 * figure is in it. One hue, for the eye: the numbers carry the meaning.
 */
export function FailureHeatmap() {
  const { companies } = useViewer();
  const hours = useQuery(api.kzProduct.breakdowns, companies.includes("kz") ? { kind: "hour" } : "skip");
  if (hours === undefined) return null;
  const weeks = [...new Set(hours.map((h) => h.weekStart))].sort();
  const newest = weeks.at(-1);
  const cells = new Map(hours.filter((h) => h.weekStart === newest).map((h) => [h.key, h.values]));
  const max = Math.max(1, ...[...cells.values()].map((v) => v.failures ?? 0));
  const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return (
    <Panel aria-label="Failures by day and hour" className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-ink">Failures by day and hour</h2>
        <p className="mt-1 text-xs text-ink-2">
          {newest === undefined
            ? "No week read yet."
            : `The week from ${short(newest)}, hours in ${utcWords(KZ_APP_UTC_OFFSET_HOURS)}. A dark cell is a spike: many failures in one hour.`}
        </p>
      </div>
      {newest !== undefined && (
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-[11px]" aria-label="Failures by day and hour">
            <thead>
              <tr>
                <th className="px-1 text-left font-normal text-ink-3" scope="col">
                  <span className="sr-only">Day</span>
                </th>
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className="w-7 font-normal text-ink-3">
                    {h % 3 === 0 ? h : ""}
                    <span className="sr-only">{h % 3 === 0 ? "" : `${h}:00`}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((day, d) => (
                <tr key={day}>
                  <th scope="row" className="pr-2 text-left font-normal text-ink-2">
                    {day}
                  </th>
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = cells.get(`${d + 1}-${h}`);
                    const failures = v?.failures ?? 0;
                    const strength = failures / max;
                    return (
                      <td
                        key={h}
                        title={`${day} ${h}:00 — ${failures} failures of ${v?.actions ?? 0} actions`}
                        className="h-6 w-7 rounded-sm text-center font-num text-ink"
                        style={{
                          background: failures === 0 ? "var(--color-surface)" : "var(--chart-1)",
                          opacity: failures === 0 ? 1 : 0.2 + 0.8 * strength,
                          color: strength > 0.55 ? "var(--color-on-brand)" : undefined,
                        }}
                      >
                        {failures > 0 ? failures : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
