"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { featureOn } from "@convex/lib/featureGates";
import { firstDayOf } from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import { niceTicks } from "@/lib/budget/chart";
import { MIN_CHART_MONTHS, groupMoneyOut, shownMonths, type SentShare } from "@/lib/finance/money-out";
import { formatPeriod, formatUsd, formatValue } from "@/lib/format";
import { financingLeftOut } from "@/lib/metrics/finance-rows";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { ENTER_US_FINANCING, NoteLink } from "./notes";
import { useMoneyOut, type MoneyOut, type MoneyOutRow } from "./use-money-out";

// Where the money goes: each finished month's money out, piled by what the
// OS's registers say it was for (Payroll, then the cost register), what
// neither register holds, and on top, in Startup's lens, what Startup sent its
// subsidiary Globex. The colours are the chart series in a fixed order
// (`--chart-1`, `--chart-2`, `--chart-4`, `--chart-3`), validated together on
// both panels (CLAUDE.md, "Charts and tiles"); a month that cannot be broken down is one
// grey pile, and the money-in line is ink. Every figure is also in the table
// a screen reader reads and in the month panel beside the chart.

type SeriesId = "payroll" | "costs" | "rest" | "sent" | "out" | "unbroken";
type Series = { id: SeriesId; label: string; color: string };
const SERIES: Record<SeriesId, Series> = {
  payroll: { id: "payroll", label: "Payroll", color: "var(--chart-1)" },
  costs: { id: "costs", label: "Costs in the register", color: "var(--chart-2)" },
  rest: { id: "rest", label: "Not in the registers", color: "var(--chart-4)" },
  sent: { id: "sent", label: `Sent to ${COMPANIES.kz.name}`, color: "var(--chart-3)" },
  out: { id: "out", label: "Money out", color: "var(--chart-1)" },
  unbroken: { id: "unbroken", label: "Money out, not broken down", color: "var(--color-ink-3)" },
};
/** The same part for a viewer on Startup alone, who is not told the other company's name. */
const SENT_UNNAMED: Series = { ...SERIES.sent, label: "Sent to the subsidiary" };
/** The legend's order: the pile's, bottom first. */
const ORDER: readonly SeriesId[] = ["payroll", "costs", "rest", "sent", "out", "unbroken"];
const IN_COLOR = "var(--color-ink-2)";
const PLOT_HEIGHT = 200;

/** A minor-unit amount as a figure reads: "$40K", "₸4.4M". */
const moneyOf = (currency: Currency) => (minor: number) => formatValue(minor / 100, "currency", currency);
const monthName = (month: string, style: "long" | "short" = "long") =>
  formatPeriod("month", firstDayOf(month), style);

/**
 * A month's pile, bottom first: what the registers account for, the rest,
 * and what Startup sent its subsidiary; or money out whole. A part not known
 * (what was sent, in a month read before it was counted) makes the month one
 * pile that is not broken down: the remainder is not known either.
 */
function segmentsOf(row: MoneyOutRow, breakdown: boolean, sentSeries: Series = SERIES.sent): { series: Series; value: number }[] {
  if (row.actual === null) return [];
  if (!breakdown) return [{ series: SERIES.out, value: row.actual }];
  const { payroll, costs, remainder, sent } = row;
  if (
    payroll.kind === "known" &&
    costs.kind === "known" &&
    sent?.kind !== "unknown" &&
    (remainder.kind === "known" || remainder.kind === "over")
  ) {
    return [
      { series: SERIES.payroll, value: payroll.amount },
      { series: SERIES.costs, value: costs.amount },
      ...(remainder.kind === "known" ? [{ series: SERIES.rest, value: remainder.amount }] : []),
      ...(sent?.kind === "known" ? [{ series: sentSeries, value: sent.amount }] : []),
    ].filter((s) => s.value > 0);
  }
  return [{ series: SERIES.unbroken, value: row.actual }];
}

/** A label inside a sentence: "Payroll" is "payroll", "Sent to Globex" keeps its name. */
const phrase = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** Whose money the section is: one company's, or the group's in dollars. */
type Whose = CompanyId | "group";

/**
 * One company's months of money out, by register. Mounted by the Finance
 * page for the company in view; Payroll's and Costs' figures arrive only for
 * a viewer who holds those pages (`useMoneyOut`).
 */
export function MoneyOutSection({
  company,
  currentMonth,
  card,
}: {
  company: CompanyId;
  currentMonth: string;
  card: { tiles: readonly Tile[]; sources: SourceStates };
}) {
  const data = useMoneyOut(company, currentMonth, card);
  // A viewer on Startup alone is told of a subsidiary, never of Globex by name.
  const sentSeries = useViewer().companies.includes("kz") ? SERIES.sent : SENT_UNNAMED;
  return (
    <Frame
      whose={company}
      byline={`${company === "us" ? "Money out from Mercury" : "Money out as typed on the Budget tab"}, set against Payroll and the cost register`}
    >
      {data === undefined ? (
        <Skeleton className="mt-4 h-64 rounded-inner" />
      ) : (
        <>
          <Loaded data={data} company={company} sentSeries={sentSeries} />
          {company === "us" && <FinancingNote rows={data.rows} tiles={card.tiles} />}
        </>
      )}
    </Frame>
  );
}

/**
 * The group's months of money out in dollars: Startup's and Globex's piled
 * together by register, Globex's tenge at the stored rate, and what Startup
 * sent Globex left out of Startup's (Globex's spending of it is in Globex
 * AI's). A month either company has no money out for, Startup's with what it
 * sent not on record, or with no rate, is not a group figure.
 */
export function GroupMoneyOutSection({
  currentMonth,
  card,
}: {
  currentMonth: string;
  card: { tiles: readonly Tile[]; sources: SourceStates };
}) {
  const us = useMoneyOut("us", currentMonth, card);
  const kz = useMoneyOut("kz", currentMonth, card);
  const data = useMemo(
    () => (us === undefined || kz === undefined ? undefined : groupMoneyOut(us, kz, us.fx)),
    [us, kz],
  );
  return (
    <Frame
      whose="group"
      byline={`Both companies in dollars: ${COMPANIES.us.name}'s money out from Mercury, ${COMPANIES.kz.name}'s as typed on the Budget tab, set against Payroll and the cost registers`}
    >
      {data === undefined ? (
        <Skeleton className="mt-4 h-64 rounded-inner" />
      ) : (
        <>
          <Loaded data={data} company="group" />
          {featureOn("subsidiaryFunding") && (
            <p className="mt-4 text-xs leading-relaxed text-ink-2">
              {`${COMPANIES.us.name}'s money out here leaves out what it sent ${COMPANIES.kz.name} (${COMPANIES.kz.legalName}, its subsidiary): that is ${COMPANIES.kz.name}'s money, and what ${COMPANIES.kz.name} spent of it is in ${COMPANIES.kz.name}'s money out already.`}
            </p>
          )}
        </>
      )}
    </Frame>
  );
}

function Frame({ whose, byline, children }: { whose: Whose; byline: string; children: ReactNode }) {
  const heading = useId();
  return (
    <Panel aria-labelledby={heading} className="min-w-0" data-whose={whose}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={heading} className="text-base">
          Where the money goes
        </h2>
        <p className="max-w-xl text-xs text-ink-3">{byline}</p>
      </div>
      {children}
    </Panel>
  );
}

/**
 * Money in is counted as net burn counts it: financing taken out. Said under
 * the chart with what was left out of the months it shows, and the way to
 * record a round (the form is the settings area's: anyone else reads words).
 */
function FinancingNote({ rows, tiles }: { rows: readonly MoneyOutRow[]; tiles: readonly Tile[] }) {
  const financing = tiles.find((tile) => tile.key === "financing_in" && tile.scope === "us")?.series ?? [];
  const leftOut = financingLeftOut(
    rows.map((row) => ({ periodStart: firstDayOf(row.month), values: {} })),
    financing,
  )
    .map((point) => `${formatUsd(point.value)} in ${formatPeriod("month", point.periodStart)}`)
    .join(", ");
  return (
    <p className="mt-4 text-xs leading-relaxed text-ink-2">
      Financing is left out of &quot;Money in&quot;{leftOut && `: ${leftOut}`}.{" "}
      {/* The spaces are explicit: a build can drop one beside a tag or a line break. */}
      <NoteLink href={ENTER_US_FINANCING}>Record financing received</NoteLink>
      {` when investor money arrives, so it is not counted as income. Outside money only: a transfer between ${COMPANIES.us.name}'s own entities is not financing.`}
    </p>
  );
}

function Loaded({ data, company, sentSeries = SERIES.sent }: { data: MoneyOut; company: Whose; sentSeries?: Series }) {
  const shown = shownMonths(data.rows);
  const known = data.rows.filter((row) => row.actual !== null).length;
  const [picked, setPicked] = useState<string | null>(null);
  const latest = shown.kind === "chart" ? shown.months.at(-1)! : shown.kind === "one" ? shown.month : data.rows.at(-1)!;
  const selected = data.rows.find((row) => row.month === picked) ?? latest;

  if (shown.kind !== "chart") {
    // No chart: a short notice saying what is missing, and the month under it
    // at a readable width, rather than an empty column beside it.
    const sofar = known === 0 ? "there are none yet" : known === 1 ? "there is one so far" : `there are ${known} so far`;
    const what =
      company === "us"
        ? `Mercury reads a month whole once it has ended: the chart needs ${MIN_CHART_MONTHS} months, ${sofar}.`
        : company === "kz"
          ? `Type ${COMPANIES.kz.name}'s actual spend on the Budget tab: the chart needs ${MIN_CHART_MONTHS} months, ${sofar}.`
          : `A group month needs both companies' money out, what ${COMPANIES.us.name} sent ${COMPANIES.kz.name} and a USD/KZT rate: the chart needs ${MIN_CHART_MONTHS} such months, ${sofar}.`;
    const title = "No chart yet";
    return (
      <div data-layout="no-chart" className="mt-5 max-w-2xl space-y-4">
        <div
          role="status"
          aria-label={title}
          className="rounded-inner border border-dashed border-line px-4 py-3 text-sm"
        >
          <p className="font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-ink-2">{what}</p>
        </div>
        <MonthPanel row={selected} data={data} company={company} sentSeries={sentSeries} />
      </div>
    );
  }

  return (
    <div data-layout="chart" className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <MoneyChart data={data} rows={shown.months} selected={selected.month} onPick={setPicked} sentSeries={sentSeries} />
      </div>
      <MonthPanel row={selected} data={data} company={company} sentSeries={sentSeries} />
    </div>
  );
}

/** Money out by month: one pile a month, the money-in line over it, a tooltip on hover and focus. */
function MoneyChart({
  data,
  rows,
  selected,
  onPick,
  sentSeries,
}: {
  data: MoneyOut;
  rows: readonly MoneyOutRow[];
  selected: string;
  onPick: (month: string) => void;
  sentSeries: Series;
}) {
  const breakdown = data.holdsPayroll && data.holdsCosts;
  const money = moneyOf(data.currency);
  const [hovered, setHovered] = useState<string | null>(null);
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const piles = rows.map((row) => ({ row, segments: segmentsOf(row, breakdown, sentSeries) }));
  const withIn = rows.some((row) => row.moneyIn !== null);
  const top = Math.max(
    1,
    ...piles.map((p) => p.segments.reduce((sum, s) => sum + s.value, 0)),
    ...rows.map((row) => row.moneyIn ?? 0),
    ...rows.map((row) => row.actual ?? 0),
  );
  const ticks = niceTicks(0, top);
  const max = ticks.at(-1)!;
  const y = (value: number) => (1 - value / max) * 100;
  const x = (index: number) => ((index + 0.5) / rows.length) * 100;
  const used = [...new Map(piles.flatMap((p) => p.segments.map((s) => [s.series.id, s.series] as const))).values()].sort(
    (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );
  const active = rows.findIndex((row) => row.month === hovered);
  const tickLabel = (value: number) => (value === 0 ? "0" : money(value));

  return (
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2">
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1.5">
          {used.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px] forced-color-adjust-none" style={{ backgroundColor: s.color }} />
              {s.label}
            </li>
          ))}
          {withIn && (
            <li className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="16" height="8" className="shrink-0">
                <line x1="1" y1="4" x2="15" y2="4" stroke={IN_COLOR} strokeWidth="2" strokeLinecap="round" />
              </svg>
              Money in, before financing
            </li>
          )}
        </ul>
      </figcaption>

      <div className="mt-4 flex gap-2">
        <div aria-hidden className="relative w-12 shrink-0 font-num text-[11px] text-ink-3" style={{ height: PLOT_HEIGHT }}>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(tick)}%` }}>
              {tickLabel(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: PLOT_HEIGHT }}>
            {/* Hairline grid, recessive. */}
            <svg aria-hidden className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              {ticks.map((tick) => (
                <line key={tick} x1="0" x2="100" y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>

            <div role="group" aria-label="Money out by month" className="absolute inset-0 flex">
              {piles.map(({ row, segments }, index) => {
                const total = segments.reduce((sum, s) => sum + s.value, 0);
                return (
                  <div
                    key={row.month}
                    ref={(element) => {
                      columns.current[index] = element;
                    }}
                    role="img"
                    tabIndex={row.month === selected ? 0 : -1}
                    aria-label={`${monthName(row.month)}: ${describe(row, breakdown, money, sentSeries)}`}
                    aria-current={row.month === selected ? "true" : undefined}
                    className={cn(
                      "relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center rounded-t-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      (active === index || row.month === selected) && "bg-surface",
                    )}
                    onPointerEnter={() => setHovered(row.month)}
                    onPointerLeave={() => setHovered(null)}
                    onFocus={() => {
                      setHovered(row.month);
                      onPick(row.month);
                    }}
                    onBlur={() => setHovered(null)}
                    onClick={(event) => {
                      onPick(row.month);
                      event.currentTarget.focus();
                    }}
                    onKeyDown={(event) => {
                      const last = piles.length - 1;
                      const target =
                        event.key === "ArrowLeft" ? Math.max(index - 1, 0)
                        : event.key === "ArrowRight" ? Math.min(index + 1, last)
                        : event.key === "Home" ? 0
                        : event.key === "End" ? last
                        : null;
                      if (event.key === "Escape") setHovered(null);
                      if (target === null) return;
                      event.preventDefault();
                      columns.current[target]?.focus();
                    }}
                  >
                    <span
                      data-pile
                      className="flex w-full max-w-7 origin-bottom flex-col-reverse motion-safe:animate-grow"
                      style={{ height: `${(total / max) * 100}%`, animationDelay: `${index * 60}ms` }}
                    >
                      {segments.map(({ series, value }, i) => (
                        <span
                          key={series.id}
                          data-series={series.id}
                          className={cn(
                            "shrink-0 forced-color-adjust-none",
                            i === 0 ? "min-h-px" : "min-h-[3px] border-b-2 border-transparent bg-clip-padding",
                            i === segments.length - 1 && "rounded-t-[4px]",
                          )}
                          style={{ height: `${(value / total) * 100}%`, backgroundColor: series.color }}
                        />
                      ))}
                    </span>
                    {/* Registers above money out: the bank's figure marked across the pile. */}
                    {row.remainder.kind === "over" && row.actual !== null && (
                      <span
                        aria-hidden
                        data-money-out
                        className="absolute h-0.5 w-9 rounded-full bg-ink"
                        style={{ bottom: `${(row.actual / max) * 100}%` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {withIn && (
              <div aria-hidden className="pointer-events-none absolute inset-0 motion-safe:animate-wipe">
                <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {lineSegments(rows.map((row) => row.moneyIn)).map((run) => (
                    <polyline
                      key={run[0]}
                      fill="none"
                      stroke={IN_COLOR}
                      strokeWidth="2"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                      points={run.map((i) => `${x(i)},${y(rows[i]!.moneyIn!)}`).join(" ")}
                    />
                  ))}
                </svg>
                {rows.map((row, i) =>
                  row.moneyIn === null ? null : (
                    <span
                      key={row.month}
                      className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel forced-color-adjust-none"
                      style={{ left: `${x(i)}%`, top: `${y(row.moneyIn)}%`, backgroundColor: IN_COLOR }}
                    />
                  ),
                )}
              </div>
            )}

            {active !== -1 && (
              <ChartTooltip row={rows[active]!} breakdown={breakdown} money={money} across={x(active)} sentSeries={sentSeries} />
            )}
          </div>
          <ol aria-hidden className="flex border-t border-line pt-1.5 font-num text-[11px] text-ink-2">
            {rows.map((row, i) => (
              <li key={row.month} className={cn("flex-1 text-center", active === i && "text-ink")}>
                {monthName(row.month, "short")}
                {(i === 0 || row.month.endsWith("-01")) && <span className="text-ink-3"> ’{row.month.slice(2, 4)}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="sr-only">Use the left and right arrow keys to move between months.</p>
      <MoneyTable rows={rows} breakdown={breakdown} money={money} sentSeries={sentSeries} />
    </figure>
  );
}

/** Runs of consecutive months that have a figure: the line breaks where one is missing. */
function lineSegments(values: readonly (number | null)[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/** A month in words, for its column's label and the table. */
function describe(row: MoneyOutRow, breakdown: boolean, money: (minor: number) => string, sentSeries: Series): string {
  const parts: string[] = [];
  if (row.moneyIn !== null) parts.push(`money in ${money(row.moneyIn)}`);
  parts.push(`money out ${row.actual === null ? "not known" : money(row.actual)}`);
  if (breakdown) {
    for (const s of segmentsOf(row, true, sentSeries)) if (s.series.id !== "unbroken") parts.push(`${phrase(s.series.label)} ${money(s.value)}`);
    if (row.remainder.kind === "over") parts.push(`the registers hold ${money(row.remainder.amount)} more than went out`);
  }
  return parts.join(", ");
}

function ChartTooltip({
  row,
  breakdown,
  money,
  across,
  sentSeries,
}: {
  row: MoneyOutRow;
  breakdown: boolean;
  money: (minor: number) => string;
  across: number;
  sentSeries: Series;
}) {
  const lines: { key: string; label: string; color: string | null; value: string }[] = [];
  for (const s of segmentsOf(row, breakdown, sentSeries)) lines.push({ key: s.series.id, label: s.series.label, color: s.series.color, value: money(s.value) });
  if (row.remainder.kind === "over") lines.push({ key: "over", label: "Registers above money out", color: null, value: money(row.remainder.amount) });
  if (row.moneyIn !== null) lines.push({ key: "in", label: "Money in", color: IN_COLOR, value: money(row.moneyIn) });
  return (
    <div
      aria-hidden
      data-tooltip
      className="pointer-events-none absolute top-1 z-20 w-max rounded-inner bg-panel px-3 py-2 text-[11px] leading-4 shadow-soft ring-1 ring-line"
      style={{ left: `${across}%`, transform: `translateX(-${across}%)` }}
    >
      <p className="font-medium text-ink">{monthName(row.month)}</p>
      <ul className="mt-1 grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-0.5">
        {lines.map((line) => (
          <li key={line.key} className="contents">
            <span className="block h-0.5 w-3 rounded-full forced-color-adjust-none" style={{ backgroundColor: line.color ?? "transparent" }} />
            <span className="text-right font-num font-medium text-ink">{line.value}</span>
            <span className="text-ink-2">{line.label}</span>
          </li>
        ))}
        {row.actual !== null && breakdown && (
          <li className="contents">
            <span />
            <span className="text-right font-num font-medium text-ink">{money(row.actual)}</span>
            <span className="text-ink-2">Money out</span>
          </li>
        )}
      </ul>
    </div>
  );
}

/** The chart's figures for a screen reader. */
function MoneyTable({
  rows,
  breakdown,
  money,
  sentSeries,
}: {
  rows: readonly MoneyOutRow[];
  breakdown: boolean;
  money: (minor: number) => string;
  sentSeries: Series;
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>Money out by month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">What it holds</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month}>
              <th scope="row">{monthName(row.month)}</th>
              <td>{describe(row, breakdown, money, sentSeries)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PAYROLL_UNKNOWN = {
  rates: "Not known yet: a rate is not set on the Payroll page.",
  circle: "Not known yet: two pay lines subtract each other.",
  no_rate: "Not known yet: someone is paid in the other currency and no USD/KZT rate is on record.",
} as const;
const COSTS_UNKNOWN = "Not known yet: a cost is in the other currency and no USD/KZT rate is on record.";

/** Why the group's money out for a month is not known, a sentence each. */
const GROUP_MISSING = {
  us: (month: string) => `Mercury has not read ${COMPANIES.us.name}'s ${month} to its end.`,
  sent: (month: string) => `Mercury read ${COMPANIES.us.name}'s ${month} before what it sent ${COMPANIES.kz.name} was counted on its own.`,
  kz: (month: string) => `${COMPANIES.kz.name}'s actual spend for ${month} is not typed in.`,
  fx: () => `No USD/KZT rate is on record to add ${COMPANIES.kz.name}'s tenge.`,
} as const;

/** What Startup sent its subsidiary in a month: where it comes from, or why it is not known. */
function sentNote(sent: SentShare, month: string): string {
  if (sent.kind === "known") return `From Mercury: ${COMPANIES.us.name}'s payments to its subsidiary.`;
  return sent.reason === "no_actual"
    ? "Not known until Mercury has read the month to its end."
    : `Not known yet: Mercury read ${month} before payments to the subsidiary were counted on their own. A Mercury backfill fills it in.`;
}

/** The money-out figure's note: where it comes from, or why it is not known. */
function moneyOutNote(row: MoneyOutRow, company: Whose, month: string, fx: number | null): string {
  if (company === "group") {
    const parts = row.group!;
    const startup =
      parts.us === null
        ? "not known"
        : `${moneyOf("USD")(parts.us)}${parts.sent ? ` (${moneyOf("USD")(parts.sent)} sent to ${COMPANIES.kz.name} left out)` : ""}`;
    const own = `${COMPANIES.us.name} ${startup}, ${COMPANIES.kz.name} ${parts.kz === null ? "not known" : moneyOf("KZT")(parts.kz)}.`;
    if (row.actual !== null) {
      return parts.kz === 0 || fx === null ? own : `${own} Tenge at ₸${fx.toLocaleString("en-US")} per $1.`;
    }
    return `Not known yet: ${parts.missing.map((what) => GROUP_MISSING[what](month)).join(" ")} ${own}`;
  }
  if (row.actual === null) {
    return company === "us"
      ? `Not known yet: Mercury has not read ${month} to its end.`
      : `Not known yet: no actual spend is typed for ${month}.`;
  }
  return company === "us" ? "Mercury" : "Typed in on the Budget tab";
}

/**
 * One month, in figures: money out, pay, the cost register by category, what
 * Startup sent its subsidiary (Startup's lens), and what none of them holds. A
 * register the viewer does not hold is named and given no figure, and the
 * remainder is then not worked out.
 */
function MonthPanel({
  row,
  data,
  company,
  sentSeries,
}: {
  row: MoneyOutRow;
  data: MoneyOut;
  company: Whose;
  sentSeries: Series;
}) {
  const heading = useId();
  const money = moneyOf(data.currency);
  const usd = (minor: number) =>
    data.currency === "KZT" && data.fx !== null ? `≈ ${formatUsd(minor / 100 / data.fx)}` : null;
  const month = monthName(row.month);
  const { payroll, costs, sent, remainder } = row;
  const typedMissing =
    row.actual === null && (company === "kz" || (company === "group" && row.group!.missing.includes("kz")));

  return (
    <section aria-labelledby={heading} className="min-w-0 rounded-inner bg-surface p-4 sm:p-5">
      <h3 id={heading} className="text-sm font-medium text-ink">
        {month}
      </h3>
      <dl className="mt-3 space-y-3 text-sm">
        <Figure
          label="Money out"
          value={row.actual === null ? null : money(row.actual)}
          alongside={row.actual === null ? null : usd(row.actual)}
          note={moneyOutNote(row, company, month, data.fx)}
          link={typedMissing ? { href: "/finance/plan", label: "Open the Budget tab" } : null}
        />
        {row.moneyIn !== null && <Figure label="Money in, before financing" value={money(row.moneyIn)} note="Mercury" />}

        <div className="border-t border-line pt-3">
          <Figure
            label="Payroll"
            swatch={payroll.kind === "known" && data.holdsCosts ? SERIES.payroll.color : null}
            value={payroll.kind === "known" ? money(payroll.amount) : null}
            note={
              payroll.kind === "hidden"
                ? "On the Payroll page."
                : payroll.kind === "loading"
                  ? "Loading."
                  : payroll.kind === "unknown"
                    ? PAYROLL_UNKNOWN[payroll.reason]
                    : payroll.basis === "paid"
                      ? "Paid: the month's total cost"
                      : "As the Payroll page works it out: the month is not marked paid"
            }
          />
        </div>
        <div>
          <Figure
            label="Costs in the register"
            swatch={costs.kind === "known" && data.holdsPayroll ? SERIES.costs.color : null}
            value={costs.kind === "known" ? money(costs.amount) : null}
            note={
              costs.kind === "hidden"
                ? "On the Costs page."
                : costs.kind === "loading"
                  ? "Loading."
                  : costs.kind === "unknown"
                    ? COSTS_UNKNOWN
                    : "What fell due that month"
            }
          />
          {/* By category is All costs' (this month's run-rate), not repeated here. */}
          {costs.kind === "known" && costs.amount > 0 && (
            <p className="mt-0.5 text-xs text-ink-3">
              <a href="#all-costs" className="rounded-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                Costs by category
              </a>
              {" are in All costs."}
            </p>
          )}
        </div>
        {sent !== null && (
          <Figure
            label={sentSeries.label}
            swatch={sent.kind === "known" && data.holdsPayroll && data.holdsCosts ? sentSeries.color : null}
            value={sent.kind === "known" ? money(sent.amount) : null}
            note={sentNote(sent, month)}
          />
        )}

        <div className="border-t border-line pt-3">
          <Figure
            label="Not in the registers"
            swatch={remainder.kind === "known" ? SERIES.rest.color : null}
            strong
            value={remainder.kind === "known" ? money(remainder.amount) : null}
            alongside={
              remainder.kind === "known" && remainder.share !== null
                ? `${Math.round(remainder.share * 100)}% of money out`
                : null
            }
            note={remainderWords(row, company, money)}
          />
        </div>
      </dl>
    </section>
  );
}

/** What the remainder is, or why it is not worked out. */
function remainderWords(row: MoneyOutRow, company: Whose, money: (minor: number) => string): string {
  const { remainder } = row;
  switch (remainder.kind) {
    case "known":
      return row.sent === null
        ? "Money out that neither Payroll nor the cost register accounts for: card spend, one-offs, transfers and anything not entered."
        : "Money out less Payroll, the cost register and what went to the subsidiary: card spend, one-offs, other transfers and anything not entered.";
    case "over":
      return `${row.sent?.kind === "known" && row.sent.amount > 0 ? "The registers and what went to the subsidiary hold" : "The registers hold"} ${money(remainder.amount)} more than went out: something in them was paid from elsewhere, or not yet.`;
    case "unknown":
      switch (remainder.reason) {
        case "payroll_hidden":
          return "Not worked out: pay is on the Payroll page, and without it the rest would include pay.";
        case "costs_hidden":
          return "Not worked out: the cost register is on the Costs page, and without it the rest would include those costs.";
        case "loading":
          return "Loading.";
        case "no_actual":
          return company === "us"
            ? "Not worked out until Mercury has read the month to its end."
            : company === "kz"
              ? "Not worked out until the month's actual spend is typed in."
              : "Not worked out until the group's money out is known.";
        case "payroll_unknown":
          return "Not worked out while pay for the month is not known.";
        case "costs_unknown":
          return "Not worked out while the cost register's month is not known.";
        case "sent_unknown":
          return `Not worked out while what ${COMPANIES.us.name} sent its subsidiary that month is not known.`;
      }
  }
}

function Figure({
  label,
  value,
  alongside = null,
  note,
  swatch = null,
  strong = false,
  link = null,
}: {
  label: string;
  value: string | null;
  alongside?: string | null;
  note: string;
  swatch?: string | null;
  strong?: boolean;
  link?: { href: string; label: string } | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className={cn("inline-flex items-center gap-1.5", strong ? "font-medium text-ink" : "text-ink-2")}>
          {swatch !== null && (
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] forced-color-adjust-none" style={{ backgroundColor: swatch }} />
          )}
          {label}
        </dt>
        <dd className={cn("font-num", value === null ? "text-ink-3" : "font-medium text-ink", strong && value !== null && "text-base")}>
          {value ?? "—"}
        </dd>
      </div>
      {alongside !== null && <p className="text-right text-xs text-ink-2">{alongside}</p>}
      <p className="mt-0.5 text-xs text-ink-3">
        {note}
        {link !== null && (
          <>
            {" "}
            <Link href={link.href} className="rounded-sm font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
              {link.label}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
