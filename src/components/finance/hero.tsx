"use client";

import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Point } from "@convex/lib/attention/metricDerive";
import { runwayInputs } from "@convex/lib/budget";
import type { CompanyId } from "@convex/lib/company";
import { project } from "@convex/lib/runway";
import { runOutWords } from "@/components/budget/runway-chart";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { ChangeBadge } from "@/components/metrics/change-badge";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { GROWTH_WAITING, partialReasons, supplySentence } from "@/components/metrics/hero-mrr";
import { Sparkline } from "@/components/metrics/sparkline";
import { HeroTiles } from "@/components/metrics/tile-frame";
import { formatExact, formatPeriod, formatUsd, formatValue } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import type { FinanceSummary } from "@/lib/metrics/finance";
import type { Tile } from "@/lib/metrics/scorecard";
import { burnBefore, cashBefore, lastMonthOf, runwayBefore, trendOf, type Trend } from "@/lib/finance/trend";
import { cn } from "@/lib/utils";
import { CashTile } from "./cash-tile";
import { Reveal } from "./motion";
import { NetBurnTile } from "./net-burn-tile";
import { Note, sourceWords } from "./notes";
import { RunwayTile } from "./runway-tile";

const MINUS = "−";
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * A change in months ("+0.6 mo vs a month ago"): the arrow carries good or
 * bad in colour, the number stays in ink, and the words say which.
 */
function MonthsChange({ diff, versus }: { diff: number; versus: string }) {
  const body = oneDecimal.format(Math.abs(diff));
  const flat = body === "0";
  const Icon = flat ? MinusIcon : diff > 0 ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-2">
      <Icon aria-hidden className={cn("size-3.5", flat ? "text-ink-3" : diff > 0 ? "text-good" : "text-weak")} />
      <span className="font-num font-medium text-ink">{flat ? "0 mo" : `${diff > 0 ? "+" : MINUS}${body} mo`}</span>
      <span>vs {versus}</span>
      <span className="sr-only">{flat ? "(no change)" : diff > 0 ? "(an improvement)" : "(a decline)"}</span>
    </span>
  );
}

/** A hero figure's change against last month, or why there is none. */
function TrendLine({
  trend,
  better,
  versus,
  months = false,
}: {
  trend: Trend;
  better: "up" | "down";
  versus: string;
  months?: boolean;
}) {
  if (trend.kind === "unknown") {
    return <p className="text-xs text-ink-3">{`No figure for ${versus} to compare with yet.`}</p>;
  }
  if (months) return <MonthsChange diff={trend.diff} versus={versus} />;
  if (trend.ratio === null) {
    return <p className="text-xs text-ink-3">{`Nothing to compare with: ${versus} was zero.`}</p>;
  }
  return <ChangeBadge ratio={trend.ratio} better={better} versus={versus} />;
}

/** The operator between two figures of the runway equation: decoration, said in the notes. */
function Operator({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="hidden self-start pt-9 text-4xl font-light text-ink-3 lg:block">
      {children}
    </span>
  );
}

/**
 * The money story in one glance: cash ÷ net burn = runway, drawn as the sum
 * it is, and MRR under it, the figure that changes the sum. Each figure
 * counts up once, says its change against last month and where it comes
 * from, and is "Not known yet" where it cannot be given. Globex's figures
 * are in tenge first, with dollars alongside.
 *
 * Every figure here is the Finance summary's (`financeSummary`), so the
 * Dashboard and the investor update cannot disagree with it.
 */
export function FinanceHero({
  summary,
  now,
  tiles,
  daily,
  company,
}: {
  summary: FinanceSummary;
  now: number;
  /** The scorecard's tiles of the markets in view: where MRR came from, and Kazakhstan's own tenge. */
  tiles: readonly Tile[];
  /** Each market's daily balances, for last month's close. */
  daily: { us: readonly Point[]; kz: readonly Point[] };
  /** The company in view, for when cash runs out; null where both are in view. */
  company: CompanyId | null;
}) {
  const headingId = useId();
  const own = summary.markets.length === 1 && summary.markets[0] === "kz";
  const lastMonth = lastMonthOf(summary);
  const cashThen = cashBefore(summary, daily);
  // Mercury's balance is today's, set against last month's end; a typed
  // month-end is set against the month-end before it.
  const cashVersus =
    cashThen !== null && cashThen.month === null
      ? "the month-end before"
      : `the end of ${formatPeriod("month", cashThen?.month ?? lastMonth, "short")}`;
  const cashNow =
    summary.cash === null || summary.cash.missing.length > 0
      ? null
      : own
        ? (summary.cash.parts[0]?.native ?? null)
        : summary.cash.usd;
  const cashTrend = trendOf(cashNow, own ? (cashThen?.native ?? null) : (cashThen?.usd ?? null), lastMonth);
  const burnThen = burnBefore(summary);
  const burnTrend = trendOf(summary.average?.value ?? null, burnThen, lastMonth);
  const runwayTrend = trendOf(
    summary.runway?.kind === "months" ? summary.runway.months : null,
    runwayBefore(cashThen?.usd ?? null, burnThen),
    lastMonth,
  );

  // When cash runs out at today's burn: the runway projection's own baseline
  // (convex/lib/runway.ts), the one the Budget and runway tab draws.
  let runOut: string | undefined;
  if (company !== null && summary.runway?.kind === "months") {
    const start = runwayInputs(summary, company);
    const projection = project({
      startMonth: summary.currentMonth.slice(0, 7),
      currency: start.currency,
      cash: start.cash,
      netBurn: start.netBurn,
      changes: [],
      fxUsdKzt: null,
    });
    if (projection.kind === "projected") runOut = runOutWords(projection.runOut);
  }

  return (
    <section
      aria-labelledby={headingId}
      className="wash-brand relative overflow-hidden rounded-card bg-panel p-6 shadow-soft sm:p-8"
    >
      <h2 id={headingId} className="sr-only">
        Summary
      </h2>
      <HeroTiles>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-6">
          <Reveal order={0} className="min-w-0">
            <CashTile
              cash={summary.cash}
              now={now}
              markets={summary.markets}
              hero={{
                own,
                trend: <TrendLine trend={cashTrend} better="up" versus={cashVersus} />,
              }}
            />
          </Reveal>
          <Operator>÷</Operator>
          <Reveal order={1} className="min-w-0">
            <NetBurnTile
              summary={summary}
              now={now}
              hero={{
                own,
                trend: <TrendLine trend={burnTrend} better="down" versus="a month ago" />,
              }}
            />
          </Reveal>
          <Operator>=</Operator>
          <Reveal order={2} className="min-w-0">
            <RunwayTile
              summary={summary}
              now={now}
              hero={{
                runOut,
                trend: <TrendLine trend={runwayTrend} better="up" versus="a month ago" months />,
              }}
            />
          </Reveal>
        </div>
        <Reveal order={3} className="mt-8 border-t border-line pt-6">
          <MrrFigure summary={summary} tiles={tiles} own={own} />
        </Reveal>
      </HeroTiles>
    </section>
  );
}

/**
 * MRR, under the runway sum: its change against last month (withheld, with
 * the reason, while a month is partial), where it comes from, and its trend
 * over the comparable months. Kazakhstan's is in tenge first.
 */
function MrrFigure({
  summary,
  tiles,
  own,
}: {
  summary: FinanceSummary;
  tiles: readonly Tile[];
  own: boolean;
}) {
  const { mrr, markets } = summary;
  const only = markets.length === 1 ? markets[0]! : null;

  if (mrr === null) {
    return (
      <DerivedTile label="MRR" value={null}>
        <Note>
          {supplySentence("mrr", only ?? "us", {
            enter: (link) => <>Enter this month&apos;s {link("MRR figure")} to start the trend.</>,
            source: (source) => `It arrives with ${source}.`,
          })}
        </Note>
      </DerivedTile>
    );
  }

  const { latest } = mrr;
  const tileOf = (scope: string) => tiles.find((tile) => tile.key === "mrr" && tile.scope === scope);
  const kzTile = tileOf("kz");
  const tenge = own ? (kzTile?.series.find((p) => p.periodStart === latest.periodStart)?.value ?? null) : null;
  const month = formatPeriod("month", latest.periodStart);
  const source =
    only === null
      ? `US typed in, Kazakhstan from the CFO workbook · ${month}`
      : `${sourceWords(tileOf(only)?.latest?.source ?? "manual")} · ${month}`;
  const kzFormat = (n: number) => formatValue(n, "currency", "KZT");
  const trendPoints =
    own && kzTile !== undefined
      ? kzTile.series.map((p) => ({ label: formatPeriod("month", p.periodStart), value: p.value, display: kzFormat(p.value) }))
      : mrr.trend.map((p) => ({ label: formatPeriod("month", p.periodStart), value: p.value, display: formatUsd(p.value) }));

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:items-end">
      <DerivedTile
        label="MRR"
        value={tenge === null ? formatUsd(latest.value) : kzFormat(tenge)}
        exact={tenge === null ? formatExact(latest.value, "currency", "USD") : formatExact(tenge, "currency", "KZT")}
        badge={latest.complete ? undefined : "partial"}
        count={tenge === null ? { value: latest.value, format: formatUsd } : { value: tenge, format: kzFormat }}
        alongside={tenge === null ? undefined : `≈ ${formatUsd(latest.value)}`}
        trend={
          mrr.growthPercent !== null && mrr.previousPeriodStart !== null ? (
            <ChangeBadge
              ratio={mrr.growthPercent / 100}
              better="up"
              versus={formatPeriod("month", mrr.previousPeriodStart, "short")}
            />
          ) : mrr.growthWithheld !== null && mrr.growthWithheld !== "partial" ? (
            <p className="text-xs text-ink-3">{GROWTH_WAITING[mrr.growthWithheld]}</p>
          ) : undefined
        }
        source={source}
      >
        {!latest.complete && (
          <>
            {partialReasons(latest, only === "kz").map((reason, i) => (
              <Note key={i} caution>
                {reason}
              </Note>
            ))}
            <Note>Growth is shown once the month is complete.</Note>
          </>
        )}
        {/* The published bands are US and EU data: never on Kazakhstan's own figure. */}
        {only !== "kz" && mrr.growthPercent !== null && (
          <BenchmarkChip value={mrr.growthPercent} benchmark={BENCHMARKS.mrr_growth_mom} />
        )}
      </DerivedTile>
      {/* One point is not a trend, and two are a change, which the badge already says. */}
      {trendPoints.length >= 3 && (
        <Sparkline
          className="h-20"
          ariaLabel={`MRR over ${trendPoints.length} months`}
          points={trendPoints}
        />
      )}
    </div>
  );
}
