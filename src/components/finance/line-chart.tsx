"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { niceTicks } from "@/lib/budget/chart";
import { cn } from "@/lib/utils";

// A small line chart for the Finance page: one axis, hairline grid, 2px
// lines that draw in (`motion-safe:animate-wipe`), ringed dots, an optional
// range band and zero line, and a crosshair with one tooltip listing every
// series at the month under the pointer or the keyboard. Every figure is
// also in a table for a screen reader. Colours are tokens, passed in.

export type ChartLine = {
  id: string;
  label: string;
  color: string;
  /** A second encoding beside colour: a dash. */
  dashed?: boolean;
  /** One per x; null where there is no figure (the line breaks there). */
  values: readonly (number | null)[];
  /** Ringed dots on each figure. */
  dots?: boolean;
};

export type ChartBand = {
  label: string;
  color: string;
  values: readonly ({ low: number; high: number } | null)[];
};

export type ChartRing = {
  index: number;
  value: number;
  color: string;
  label: string;
  /** Words written beside the ring on the chart itself, not only in the tooltip. */
  callout?: string;
};

/** Runs of consecutive indexes holding a figure. */
function runs(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length > 0) out.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length > 0) out.push(run);
  return out;
}

export function LineChart({
  label,
  xs,
  xLabel,
  xName,
  lines,
  band,
  rings = [],
  zeroLine = false,
  format,
  height = 176,
  labelEvery = 1,
  positions,
  axis,
}: {
  /** What the chart shows, for the group a screen reader enters. */
  label: string;
  /** One key per position along the x axis. */
  xs: readonly string[];
  /** The short label under a position: "Sep". */
  xLabel: (index: number) => string;
  /** A position in full, as the tooltip and the table name it: "Sep 2026". */
  xName: (index: number) => string;
  lines: readonly ChartLine[];
  band?: ChartBand | null;
  rings?: readonly ChartRing[];
  zeroLine?: boolean;
  format: (value: number) => string;
  height?: number;
  /** Write every nth label under the axis. */
  labelEvery?: number;
  /**
   * Where each x sits along the axis, 0 to 1, for points that are not evenly
   * spaced (a time axis); evenly spaced without it.
   */
  positions?: readonly number[];
  /** With `positions`: the labels under the axis and where they sit, 0 to 1, in place of one per x. */
  axis?: readonly { at: number; label: string }[];
}) {
  const [at, setAt] = useState<number | null>(null);
  const every = [
    ...lines.flatMap((line) => line.values.filter((v): v is number => v !== null)),
    ...(band?.values ?? []).flatMap((v) => (v === null ? [] : [v.low, v.high])),
    ...rings.map((r) => r.value),
  ];
  const ticks = niceTicks(Math.min(0, ...every), Math.max(0, ...every));
  const min = ticks[0]!;
  const max = ticks.at(-1)!;
  const y = (value: number) => ((max - value) / (max - min || 1)) * 100;
  const x = (index: number) =>
    positions !== undefined ? positions[index]! * 100 : xs.length <= 1 ? 50 : (index / (xs.length - 1)) * 100;
  const last = xs.length - 1;

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - box.left) / Math.max(box.width, 1), 0), 1);
    if (positions === undefined) {
      setAt(Math.round(fraction * last));
      return;
    }
    // The nearest point along a time axis.
    let nearest = 0;
    positions.forEach((at, i) => {
      if (Math.abs(at - fraction) < Math.abs(positions[nearest]! - fraction)) nearest = i;
    });
    setAt(nearest);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = at ?? last;
    const to =
      event.key === "ArrowLeft" ? Math.max(from - 1, 0)
      : event.key === "ArrowRight" ? Math.min(from + 1, last)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (event.key === "Escape") setAt(null);
    if (to === null) return;
    event.preventDefault();
    setAt(to);
  };
  const bandPoints =
    band == null
      ? null
      : (() => {
          const shown = band.values.flatMap((v, i) => (v === null ? [] : [{ i, ...v }]));
          if (shown.length < 2) return null;
          const upper = shown.map((p) => `${x(p.i)},${y(p.high)}`);
          const lower = [...shown].reverse().map((p) => `${x(p.i)},${y(p.low)}`);
          return [...upper, ...lower].join(" ");
        })();

  return (
    <div className="min-w-0">
      <div className="flex gap-2">
        <div aria-hidden className="relative w-12 shrink-0 font-num text-[11px] text-ink-3" style={{ height }}>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(tick)}%` }}>
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            role="group"
            tabIndex={0}
            aria-label={`${label}. Use the left and right arrow keys to move between months.`}
            className="relative rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            style={{ height }}
            onPointerMove={pick}
            onPointerLeave={() => setAt(null)}
            onKeyDown={key}
            onBlur={() => setAt(null)}
          >
            <svg aria-hidden className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
              {ticks.map((tick) => (
                <line key={tick} x1="0" x2="100" y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
              {zeroLine && min < 0 && (
                <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="var(--color-ink-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              )}
              {at !== null && (
                <line data-crosshair x1={x(at)} x2={x(at)} y1="0" y2="100" stroke="var(--color-ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            <div aria-hidden className="pointer-events-none absolute inset-0 motion-safe:animate-wipe">
              <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                {bandPoints !== null && band != null && (
                  <polygon points={bandPoints} fill={band.color} fillOpacity="0.12" stroke="none" />
                )}
                {lines.flatMap((line) =>
                  runs(line.values).map((run) => (
                    <polyline
                      key={`${line.id}:${run[0]}`}
                      data-line={line.id}
                      fill="none"
                      stroke={line.color}
                      strokeWidth="2"
                      strokeDasharray={line.dashed ? "6 4" : undefined}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                      points={run.map((i) => `${x(i)},${y(line.values[i]!)}`).join(" ")}
                    />
                  )),
                )}
              </svg>
              {lines.flatMap((line) =>
                line.dots
                  ? line.values.map((value, i) =>
                      value === null ? null : (
                        <span
                          key={`${line.id}:${i}`}
                          className={cn(
                            "absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel forced-color-adjust-none",
                            at === i ? "size-3" : "size-2",
                          )}
                          style={{ left: `${x(i)}%`, top: `${y(value)}%`, backgroundColor: line.color }}
                        />
                      ),
                    )
                  : [],
              )}
              {rings.map((ring) => (
                <span
                  key={`ring:${ring.index}:${ring.color}`}
                  className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-panel ring-2 ring-panel forced-color-adjust-none"
                  style={{ left: `${x(ring.index)}%`, top: `${y(ring.value)}%`, borderColor: ring.color }}
                />
              ))}
            </div>
            {/* Outside the wipe, so the words are never clipped as the line draws in. */}
            <div className="pointer-events-none absolute inset-0">
              {rings
                .filter((ring) => ring.callout !== undefined)
                .map((ring) => (
                  <span
                    key={`callout:${ring.index}:${ring.color}`}
                    data-callout
                    className={cn(
                      "absolute -translate-y-full rounded-sm bg-panel px-1 pb-1.5 text-xs font-medium whitespace-nowrap text-ink",
                      x(ring.index) > 60 ? "-translate-x-full" : "",
                    )}
                    style={{ left: `${x(ring.index)}%`, top: `${y(ring.value)}%` }}
                  >
                    {ring.callout}
                  </span>
                ))}
            </div>

            {at !== null && (
              <div
                aria-hidden
                data-tooltip
                className="pointer-events-none absolute top-1 z-20 w-max rounded-inner bg-panel px-3 py-2 text-[11px] leading-4 shadow-soft ring-1 ring-line"
                style={at > last / 2 ? { right: `${100 - x(at) + 2}%` } : { left: `${x(at) + 2}%` }}
              >
                <p className="font-medium text-ink">{xName(at)}</p>
                <ul className="mt-1 grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-0.5">
                  {lines.map((line) => (
                    <li key={line.id} className="contents">
                      <span className="block h-0.5 w-3 rounded-full forced-color-adjust-none" style={{ backgroundColor: line.color }} />
                      <span className={cn("text-right font-num", line.values[at] == null ? "text-ink-3" : "font-medium text-ink")}>
                        {line.values[at] == null ? "no figure" : format(line.values[at]!)}
                      </span>
                      <span className="text-ink-2">{line.label}</span>
                    </li>
                  ))}
                  {band != null && band.values[at] != null && (
                    <li className="contents">
                      <span className="block h-2 w-3 rounded-[2px] opacity-30 forced-color-adjust-none" style={{ backgroundColor: band.color }} />
                      <span className="text-right font-num font-medium text-ink">
                        {format(band.values[at]!.low)}–{format(band.values[at]!.high)}
                      </span>
                      <span className="text-ink-2">{band.label}</span>
                    </li>
                  )}
                  {rings
                    .filter((ring) => ring.index === at)
                    .map((ring) => (
                      <li key={ring.label} className="contents">
                        <span />
                        <span />
                        <span className="text-ink-2">{ring.label}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
          {axis !== undefined ? (
            <ol aria-hidden className="relative h-5 border-t border-line font-num text-[11px] text-ink-2">
              {axis.map((tick) => (
                <li
                  key={tick.at}
                  className={cn(
                    "absolute top-1.5 whitespace-nowrap",
                    tick.at === 0 ? "" : tick.at === 1 ? "-translate-x-full" : "-translate-x-1/2",
                  )}
                  style={{ left: `${tick.at * 100}%` }}
                >
                  {tick.label}
                </li>
              ))}
            </ol>
          ) : (
            <ol aria-hidden className="flex justify-between border-t border-line pt-1.5 font-num text-[11px] text-ink-2">
              {xs.map((id, i) => (
                <li key={id} className={cn("w-0 text-center whitespace-nowrap", at === i && "text-ink")}>
                  <span className="inline-block -translate-x-1/2 pl-[1ch]">{i % labelEvery === 0 || (i === last && last % labelEvery >= labelEvery / 2) ? xLabel(i) : ""}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {lines.map((line) => (
                <th key={line.id} scope="col">
                  {line.label}
                </th>
              ))}
              {band != null && <th scope="col">{band.label}</th>}
            </tr>
          </thead>
          <tbody>
            {xs.map((id, i) => (
              <tr key={id}>
                <th scope="row">{xName(i)}</th>
                {lines.map((line) => (
                  <td key={line.id}>{line.values[i] == null ? "no figure" : format(line.values[i]!)}</td>
                ))}
                {band != null && (
                  <td>{band.values[i] == null ? "no figure" : `${format(band.values[i]!.low)} to ${format(band.values[i]!.high)}`}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
