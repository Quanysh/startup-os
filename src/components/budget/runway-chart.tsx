"use client";

import { useState } from "react";
import { firstDayOf } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import type { RunOut } from "@convex/lib/runway";
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
import { chartScale } from "@/lib/budget/chart";
import { formatMinor, formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The fixed categorical order: baseline first, then the scenarios in the order they were picked. */
export const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
/** A second encoding beside colour: each line its own dash. */
const DASHES = [undefined, "6 3", "2 3", "8 3 2 3"];

export type RunwaySeries = {
  id: string;
  label: string;
  months: { month: string; cash: number }[];
  runOut: RunOut;
};

const monthName = (month: string, style: "long" | "short" = "long") =>
  formatPeriod("month", firstDayOf(month), style);

export const runOutWords = (runOut: RunOut) =>
  runOut.kind === "beyond" ? "Lasts beyond 24 months" : `Runs out in ${monthName(runOut.month)}`;

/** The reference line (on budget): ink, not a series hue, and dotted. It reaches only as far as the budget. */
const REFERENCE_COLOR = "var(--color-ink-2)";
const REFERENCE_DASH = "1 4";
const referenceWords = (s: RunwaySeries) =>
  s.runOut.kind === "beyond" ? `Lasts past ${monthName(s.months.at(-1)!.month)}` : runOutWords(s.runOut);

/**
 * Month-end cash over 24 months: the baseline and up to three scenarios, one
 * hue each in the fixed order, each with its own dash and a legend that says
 * when it runs out; and, where it is known, the budget spent month by month
 * as a dotted ink reference line over the budget's own months. A zero line, a
 * ring on each run-out month, a crosshair and tooltip on hover, and the same
 * figures as a table.
 */
export function RunwayChart({
  series,
  currency,
  reference,
}: {
  series: readonly RunwaySeries[];
  currency: Currency;
  reference?: RunwaySeries;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hovered, setHovered] = useState<number | null>(null);
  const months = series[0]?.months.map((m) => m.month) ?? [];
  const drawn = reference === undefined ? series : [...series, reference];
  const scale = chartScale(drawn.map((s) => s.months.map((m) => m.cash)));
  const colorOf = (s: RunwaySeries, i: number) => (s === reference ? REFERENCE_COLOR : SERIES_COLORS[i]);
  const dashOf = (s: RunwaySeries, i: number) => (s === reference ? REFERENCE_DASH : DASHES[i]);
  const wordsOf = (s: RunwaySeries) => (s === reference ? referenceWords(s) : runOutWords(s.runOut));
  const cashAt = (s: RunwaySeries, j: number) => s.months.find((m) => m.month === months[j])?.cash ?? null;
  const money = (minor: number) => formatMinor(Math.round(minor / 100) * 100, currency);
  const x = (index: number) => (months.length <= 1 ? 50 : (index / (months.length - 1)) * 100);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm" aria-label="Lines">
          {drawn.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <svg aria-hidden width="22" height="8" className="shrink-0">
                <line x1="1" y1="4" x2="21" y2="4" stroke={colorOf(s, i)} strokeWidth="2.5" strokeDasharray={dashOf(s, i)} strokeLinecap="round" />
              </svg>
              <span className="text-ink">{s.label}</span>
              <span className="text-ink-2">{wordsOf(s)}</span>
            </li>
          ))}
        </ul>
        <div role="group" aria-label="Show as" className="flex gap-1 rounded-full bg-surface p-1">
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "h-7 rounded-full px-3 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                view === v ? "bg-panel text-ink shadow-soft-sm" : "text-ink-2 hover:text-ink",
              )}
            >
              {v === "chart" ? "Chart" : "Table"}
            </button>
          ))}
        </div>
      </div>

      {view === "chart" ? (
        <div className="flex gap-2">
          <div aria-hidden className="relative h-56 w-16 shrink-0 text-right text-[11px] text-ink-3 font-num">
            {scale.ticks.map((tick) => (
              <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${scale.y(tick)}%` }}>
                {formatMinor(tick, currency).replace(/\.00$/, "")}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative h-56" onPointerLeave={() => setHovered(null)}>
              <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                {scale.ticks.map((tick) => (
                  <line key={tick} x1="0" x2="100" y1={scale.y(tick)} y2={scale.y(tick)} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                ))}
                {/* The zero line: where cash runs out. */}
                <line x1="0" x2="100" y1={scale.y(0)} y2={scale.y(0)} stroke="var(--color-ink-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                {hovered !== null && (
                  <line x1={x(hovered)} x2={x(hovered)} y1="0" y2="100" stroke="var(--color-ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                )}
                {drawn.map((s, i) => (
                  <polyline
                    key={s.id}
                    fill="none"
                    stroke={colorOf(s, i)}
                    strokeWidth="2"
                    strokeDasharray={dashOf(s, i)}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    points={s.months
                      .flatMap((m) => {
                        const j = months.indexOf(m.month);
                        return j < 0 ? [] : [`${x(j)},${scale.y(m.cash)}`];
                      })
                      .join(" ")}
                  />
                ))}
              </svg>
              {/* Run-out marks: a ring with the surface round it, on the month cash ends below zero. */}
              {drawn.map((s, i) => {
                if (s.runOut.kind !== "month") return null;
                const runOutMonth = s.runOut.month;
                const at = months.indexOf(runOutMonth);
                const cash = cashAt(s, at);
                if (at < 0 || cash === null) return null;
                return (
                  <span
                    key={s.id}
                    aria-hidden
                    className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-panel ring-2 ring-panel"
                    style={{ left: `${x(at)}%`, top: `${scale.y(cash)}%`, borderColor: colorOf(s, i) }}
                  />
                );
              })}
              {/* Hit areas, wider than the marks: one per month. */}
              <div className="absolute inset-0 flex">
                {months.map((month, j) => (
                  <div key={month} className="h-full flex-1" onPointerEnter={() => setHovered(j)} />
                ))}
              </div>
              {hovered !== null && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-1 z-10 w-max rounded-inner bg-panel px-3 py-2 text-xs shadow-soft"
                  style={hovered > months.length / 2 ? { right: `${100 - x(hovered) + 2}%` } : { left: `${x(hovered) + 2}%` }}
                >
                  <p className="font-medium text-ink">End of {monthName(months[hovered]!)}</p>
                  {drawn.map((s, i) => {
                    const cash = cashAt(s, hovered);
                    return cash === null ? null : (
                      <p key={s.id} className="mt-0.5 flex items-center gap-2 text-ink-2">
                        <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(s, i) }} />
                        {s.label}: <span className="font-num text-ink">{money(cash)}</span>
                      </p>
                    );
                  })}
                </div>
              )}
            </div>
            <div aria-hidden className="mt-1 flex justify-between text-[11px] text-ink-3">
              {months.filter((_, j) => j % 6 === 0 || j === months.length - 1).map((month) => (
                <span key={month}>{monthName(month, "short")} {month.slice(2, 4)}</span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className={view === "chart" ? "sr-only" : undefined}>
        {/* A download only once the table is shown: an unseen button would take focus out of sight. */}
        <DataTable
          caption={`Month-end cash in ${currency}`}
          className="min-w-[32rem]"
          download={view === "chart" ? false : undefined}
        >
          <DataHead>
            <DataHeader pinned>Month</DataHeader>
            {drawn.map((s) => (
              <DataHeader key={s.id} numeric>
                {s.label}
              </DataHeader>
            ))}
          </DataHead>
          <DataBody>
            {months.map((month, j) => (
              <DataRow key={month}>
                <DataRowHeader pinned>{monthName(month)}</DataRowHeader>
                {drawn.map((s) => {
                  const cash = cashAt(s, j);
                  return (
                    <DataCell key={s.id} numeric className={cash !== null && cash < 0 ? "text-danger-ink" : undefined}>
                      {cash === null ? <Blank /> : money(cash)}
                    </DataCell>
                  );
                })}
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      </div>
    </div>
  );
}
