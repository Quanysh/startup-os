"use client";

import { useId, useRef, useState } from "react";
import { formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";

export type BarSeries = { id: string; label: string; color: string }; // a CSS colour or var()
export type BarRow = {
  periodStart: string;
  values: Record<string, number | null>;
  /** Why this month should not be read like the others, e.g. "partial", "so far". */
  note?: string;
};

type Mode = "grouped" | "stacked";
type Figure = { series: BarSeries; value: number | null; text: string };
/** A pile's sum, as the tooltip's last line. */
type Total = { label: "Total" | "Partial total"; text: string };
type Month = {
  row: BarRow;
  /** "Oct 2026" */
  month: string;
  /** Why the month is not like the others. An empty note is no note: null. */
  note: string | null;
  /** The month with its note: "Oct 2026 (so far)". */
  name: string;
  figures: Figure[];
  /** Stacked, with more than one series and at least one figure; else null. */
  total: Total | null;
  /** How high the month reaches, in the data's own unit. */
  peak: number;
  /** Why its bars are drawn lighter; null when they are drawn like the rest. */
  lighter: string | null;
};

/** The plot's height in px. The tooltip is placed against it. */
const PLOT_HEIGHT = 160;
/** Clear air between a month's tallest bar and its tooltip, in px. */
const TOOLTIP_GAP = 8;
/**
 * The tooltip's height in px, from its own classes: 8 + 8 of padding (py-2),
 * a 16px month line, 4px under it (mt-1), then a 16px line per series (and
 * one for a pile's total) with 2px between lines (gap-y-0.5). Two lines: 70px.
 */
const tooltipHeight = (lines: number) => 16 + 16 + 4 + lines * 16 + Math.max(lines - 1, 0) * 2;

/**
 * Where the tooltip's bottom edge sits above the baseline: just above the
 * month's tallest bar, but never so high that its top would leave the plot
 * (bottom + its height <= the plot's height). With two lines that limit is
 * 160 - 70 = 90px, reached once a month peaks above (90 - 8) / 160 = 51%;
 * from there up the tooltip stays put and overlaps the top of the bars.
 */
function tooltipBottom(peakPercent: number, lines: number): number {
  const aboveTheBars = (peakPercent / 100) * PLOT_HEIGHT + TOOLTIP_GAP;
  const limit = Math.max(PLOT_HEIGHT - tooltipHeight(lines), 0);
  return Math.round(Math.min(aboveTheBars, limit) * 10) / 10;
}

/** A figure is a finite number. Anything else (NaN, Infinity, absent) is missing. */
function figureOf(raw: number | null | undefined): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * What a pile adds up to: the sum of the figures that are there. It is a
 * "Partial total" only in a month the caller has noted and that is missing a
 * figure; a missing figure alone says nothing about the month (a market that
 * had not started reporting yet is not a gap). Null with a single series (the
 * figure is its own total) and with no figure at all (a sum of nothing is not
 * a zero).
 */
function totalOf(
  figures: readonly Figure[],
  noted: boolean,
  format: (value: number) => string,
): Total | null {
  const present = figures.flatMap((figure) => (figure.value === null ? [] : [figure.value]));
  if (figures.length < 2 || present.length === 0) return null;
  return {
    label: noted && present.length < figures.length ? "Partial total" : "Total",
    text: format(present.reduce((sum, value) => sum + value, 0)),
  };
}

/** How high a month reaches: its tallest bar (grouped) or its whole pile (stacked). */
function peakOf(figures: readonly Figure[], mode: Mode): number {
  const drawn = figures.map((figure) => Math.max(figure.value ?? 0, 0));
  return mode === "stacked" ? drawn.reduce((sum, value) => sum + value, 0) : Math.max(0, ...drawn);
}

/** A share of the plot's height, to two decimals so it prints cleanly ("20%"). */
function percentOf(value: number, max: number): number {
  return max > 0 ? Math.round((Math.max(value, 0) / max) * 10_000) / 100 : 0;
}

/** Whether a figure gets a bar. A missing one does not; nor a zero, nor a negative. */
function drawable(value: number | null, max: number): value is number {
  return value !== null && value > 0 && max > 0;
}

/** Where an arrow key, Home or End takes focus from `index`; null for any other key. */
function monthAfterKey(key: string, index: number, last: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "ArrowRight":
      return Math.min(index + 1, last);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

// Bars and swatches are background colours, which forced-colours mode
// (Windows high contrast) would otherwise remove.
const PAINTED = "forced-color-adjust-none";
const SWATCH = cn("size-2.5 shrink-0 rounded-[3px]", PAINTED);

/**
 * Up to thirteen months of one or two series as bars: side by side (grouped)
 * or piled into one bar per month (stacked). It brings no panel of its own.
 *
 * A missing number is not a zero, and does not look like one. A figure that
 * is null (or not a finite number) reads "no figure" and draws no bar. In
 * grouped mode its lane carries a short grey dash, where a true zero is left
 * empty. In stacked mode the segment is simply not drawn. Whether a month is
 * short is the caller's to say, with the row's note ("so far", "partial"):
 * only a noted month is drawn at half strength, so that it is not read as a
 * fall, and a line under the chart says what the lighter bars stand for. A pile with no figure at all leaves the same dash
 * at the baseline, and one with figures ends its tooltip with their total.
 *
 * Every month is described in words on its column, the tooltip repeats that
 * on hover and focus, and the same numbers sit in a visually hidden table.
 * The columns are one named group and one tab stop: the arrow keys, Home and
 * End move between months, and Escape puts the tooltip away. What is hovered
 * and focused is remembered by month, not by position, so when the months
 * change under the chart the tooltip and the focus ring stay on one month.
 */
export function MonthBars({
  title,
  series,
  rows,
  mode,
  format,
  grain = "month",
  className,
}: {
  title: string;
  /** What one bar spans. Weeks are named by their Monday. */
  grain?: "month" | "week";
  series: readonly BarSeries[];
  rows: readonly BarRow[];
  /** grouped: bars side by side. stacked: one bar per month, series piled up. */
  mode: Mode;
  /** How a value reads, e.g. (n) => "$12K". */
  format: (value: number) => string;
  className?: string;
}) {
  // Kept apart so that moving the pointer away does not hide the tooltip of a
  // month reached with the keyboard.
  // Each holds a month (its periodStart), resolved to a column at render: an
  // index would point at another month once the rows slide.
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // The one month Tab lands on: the first, then whichever was focused last.
  const [tabStop, setTabStop] = useState<string | null>(null);
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const hintId = useId();

  const months: Month[] = rows.map((row) => {
    const month = formatPeriod(grain, row.periodStart);
    const figures: Figure[] = series.map((s) => {
      const value = figureOf(row.values[s.id]);
      return { series: s, value, text: value === null ? "no figure" : format(value) };
    });
    // Whether a month is whole is decided by whoever built the rows, in one
    // place, and arrives as the note. Nothing is inferred from a null here.
    const note = row.note || null;
    return {
      row,
      month,
      note,
      name: note ? `${month} (${note})` : month,
      figures,
      total: mode === "stacked" ? totalOf(figures, note !== null, format) : null,
      peak: peakOf(figures, mode),
      lighter: note,
    };
  });
  const max = Math.max(0, ...months.map((m) => m.peak));
  // Only what is on the chart: a month with no bars has none drawn lighter.
  const lighter = [
    ...new Set(
      months.flatMap((m) =>
        m.lighter !== null && m.figures.some((f) => drawable(f.value, max)) ? [m.lighter] : [],
      ),
    ),
  ];
  // Three-letter month names stop fitting under ten or more columns in a
  // narrow panel (thirteen in about 300px on a phone); there they shrink to
  // initials, with the year still under the first month and each January.
  const crowded = months.length > 9;
  const last = months.length - 1;

  // A remembered month that is no longer on the chart is nothing for the
  // tooltip, and the first column for the tab stop.
  const indexOf = (periodStart: string | null) => {
    const index = months.findIndex((m) => m.row.periodStart === periodStart);
    return index === -1 ? null : index;
  };
  const active = indexOf(hovered) ?? indexOf(focused);
  const shown = active === null ? undefined : months[active];
  const tabIndexAt = indexOf(tabStop) ?? 0;

  return (
    <figure className={cn("min-w-0", className)}>
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <span className="text-sm font-medium text-ink-2">{title}</span>
        {months.length > 0 && (
          <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
            {series.map((s) => (
              <li key={s.id} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={SWATCH} style={{ backgroundColor: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      {months.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">Nothing to chart yet.</p>
      ) : (
        <>
          <div className="@container mt-4">
            {/* One group, so the arrow-key hint is announced once on entering
                it and not again on every month. */}
            <div
              role="group"
              aria-label={title}
              aria-describedby={hintId}
              className="relative flex"
              style={{ height: PLOT_HEIGHT }}
            >
              {months.map(({ row, note, name, figures, lighter: reason }, index) => (
                <div
                  key={row.periodStart}
                  ref={(element) => {
                    columns.current[index] = element;
                  }}
                  role="img"
                  tabIndex={index === tabIndexAt ? 0 : -1}
                  aria-label={`${name}: ${figures.map((f) => `${f.series.label} ${f.text}`).join(", ")}`}
                  data-noted={note ? "true" : undefined}
                  className={cn(
                    "relative flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 rounded-t-md px-[3px] outline-none focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring/50",
                    active === index && "bg-surface",
                  )}
                  onPointerEnter={() => setHovered(row.periodStart)}
                  onPointerLeave={() => setHovered(null)}
                  onFocus={() => {
                    setFocused(row.periodStart);
                    setTabStop(row.periodStart);
                  }}
                  onBlur={() => setFocused(null)}
                  // A tap does not focus a div everywhere (iOS Safari).
                  onClick={(event) => event.currentTarget.focus()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setHovered(null);
                      setFocused(null);
                      return;
                    }
                    const target = monthAfterKey(event.key, index, last);
                    if (target === null) return;
                    event.preventDefault();
                    columns.current[target]?.focus();
                  }}
                >
                  {mode === "grouped" ? (
                    <GroupedBars figures={figures} max={max} faded={reason !== null} />
                  ) : (
                    <StackedBar figures={figures} max={max} faded={reason !== null} />
                  )}
                </div>
              ))}

              {shown && active !== null && (
                <Tooltip
                  month={shown}
                  // Its own anchor slides with the column (left edge at the
                  // first month, right edge at the last), so it never leaves
                  // the plot sideways.
                  across={((active + 0.5) / months.length) * 100}
                  bottom={tooltipBottom(
                    percentOf(shown.peak, max),
                    shown.figures.length + (shown.total ? 1 : 0),
                  )}
                />
              )}
            </div>

            {/* The top border is the baseline every bar stands on. Month over
                year, so thirteen columns never need a line wider than a word. */}
            <ol
              aria-hidden="true"
              data-axis
              className="flex border-t border-line pt-1.5 font-num text-[11px] leading-4 text-ink-2"
            >
              {months.map(({ row }, index) => {
                const short = formatPeriod("month", row.periodStart, "short");
                const january = row.periodStart.slice(5, 7) === "01";
                if (grain === "week") {
                  // The Monday's day number, with the month under the first
                  // week and under each week that starts a new month.
                  const before = months[index - 1]?.row.periodStart;
                  const newMonth = before === undefined || before.slice(0, 7) !== row.periodStart.slice(0, 7);
                  return (
                    <li
                      key={row.periodStart}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col items-center",
                        active === index && "text-ink",
                      )}
                    >
                      <span>{Number(row.periodStart.slice(8, 10))}</span>
                      {newMonth && <span className="text-ink-3">{short}</span>}
                    </li>
                  );
                }
                return (
                  <li
                    key={row.periodStart}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col items-center",
                      active === index && "text-ink",
                    )}
                  >
                    <span>
                      {short.slice(0, 1)}
                      <span className={cn(crowded && "@max-sm:hidden")}>{short.slice(1)}</span>
                    </span>
                    {(index === 0 || january) && (
                      <>
                        {" "}
                        <span className="text-ink-3">’{row.periodStart.slice(2, 4)}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Half strength is never the only sign: say what it stands for. */}
          {lighter.length > 0 && (
            <p aria-hidden="true" className="mt-2 text-[11px] text-ink-3">
              Lighter bars: {lighter.join(", ")}
            </p>
          )}

          <p id={hintId} className="sr-only">
            Use the left and right arrow keys to move between {grain}s.
          </p>
          <HiddenTable series={series} months={months} />
        </>
      )}
    </figure>
  );
}

type BarsProps = { figures: readonly Figure[]; max: number; faded: boolean };

/**
 * One bar per series, 2px apart. A series with no bar keeps its lane, so the
 * bar that is there stays in its own; a missing figure marks that lane with a
 * short dash just above the baseline, and a zero leaves it empty.
 */
function GroupedBars({ figures, max, faded }: BarsProps) {
  return figures.map(({ series, value }) =>
    drawable(value, max) ? (
      <span
        key={series.id}
        data-series={series.id}
        className={cn("min-h-px max-w-4 flex-1 rounded-t-[4px]", PAINTED, faded && "opacity-50")}
        style={{ height: `${percentOf(value, max)}%`, backgroundColor: series.color }}
      />
    ) : (
      <span key={series.id} className="flex max-w-4 flex-1 justify-center">
        {value === null && (
          <span
            aria-hidden="true"
            data-missing={series.id}
            className={cn("mb-[3px] h-0.5 w-2 max-w-full rounded-full bg-ink-3", PAINTED)}
          />
        )}
      </span>
    ),
  );
}

/**
 * The series piled from the baseline up, the first at the bottom. The 2px
 * between two segments is taken out of the upper one (a transparent border
 * the fill stops short of), so the pile's height stays the month's total.
 *
 * A month with no figure in any series is not a zero month: it gets the dash
 * a missing figure gets in grouped mode, where a zero month is left empty.
 */
function StackedBar({ figures, max, faded }: BarsProps) {
  const segments = figures.flatMap(({ series, value }) =>
    drawable(value, max) ? [{ series, value }] : [],
  );
  const nothing = figures.length > 0 && figures.every((figure) => figure.value === null);
  return (
    <span data-pile className="flex h-full max-w-6 flex-1 flex-col-reverse">
      {nothing && (
        <span
          aria-hidden="true"
          data-missing="all"
          className={cn("mb-[3px] h-0.5 w-2 max-w-full self-center rounded-full bg-ink-3", PAINTED)}
        />
      )}
      {segments.map(({ series, value }, index) => (
        <span
          key={series.id}
          data-series={series.id}
          className={cn(
            "shrink-0",
            PAINTED,
            index === 0 ? "min-h-px" : "min-h-[3px] border-b-2 border-transparent bg-clip-padding",
            index === segments.length - 1 && "rounded-t-[4px]",
            faded && "opacity-50",
          )}
          style={{ height: `${percentOf(value, max)}%`, backgroundColor: series.color }}
        />
      ))}
    </span>
  );
}

/**
 * One month's figures, each beside its legend swatch. Hidden from assistive
 * technology: the column's own label already says the same.
 */
function Tooltip({ month, across, bottom }: { month: Month; across: number; bottom: number }) {
  return (
    <div
      data-tooltip
      aria-hidden="true"
      className="pointer-events-none absolute z-20 w-max rounded-inner bg-panel px-3 py-2 text-[11px] leading-4 whitespace-nowrap shadow-soft ring-1 ring-line"
      style={{ left: `${across}%`, transform: `translateX(-${across}%)`, bottom }}
    >
      <p className="flex items-center gap-1.5 font-medium text-ink">
        {month.month}
        {month.note && (
          <span className="rounded-full bg-surface px-1.5 text-[10px] font-normal text-ink-2">
            {month.note}
          </span>
        )}
      </p>
      <ul className="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5">
        {month.figures.map(({ series, value, text }) => (
          <li key={series.id} className="contents">
            <span data-swatch className={SWATCH} style={{ backgroundColor: series.color }} />
            <span className="text-ink-2">{series.label}</span>
            <span
              className={cn(
                "text-right",
                value === null ? "text-ink-3" : "font-num font-medium text-ink",
              )}
            >
              {text}
            </span>
          </li>
        ))}
        {month.total && (
          // No swatch: the total is no series' own.
          <li className="contents">
            <span />
            <span className="text-ink-2">{month.total.label}</span>
            <span className="text-right font-num font-medium text-ink">{month.total.text}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * The chart's numbers for a screen reader. The wrapper does the hiding: a
 * table grows to fit its cells whatever width it is given, so it cannot be
 * clipped to 1px itself.
 */
function HiddenTable({
  series,
  months,
}: {
  series: readonly BarSeries[];
  months: readonly Month[];
}) {
  return (
    <div className="sr-only">
      <table>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map(({ row, name, figures }) => (
            <tr key={row.periodStart}>
              <th scope="row">{name}</th>
              {figures.map((f) => (
                <td key={f.series.id}>{f.text}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
