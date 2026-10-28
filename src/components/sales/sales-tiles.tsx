import { SCOPE_CURRENCY } from "@convex/lib/metricRegistry";
import { Note } from "@/components/finance/notes";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { QuietTile } from "@/components/pipeline/quiet-tile";
import { agree, countOf } from "@/components/pipeline/words";
import { formatExact, formatValue } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import {
  DEAL_STALE_DAYS,
  WIN_RATE_MIN_CLOSED,
  WIN_RATE_WINDOW_DAYS,
  coverageNeeded,
  pipelineValue,
  quietDeals,
  winRate,
  type Coverage,
  type PipelineBoard,
  type PipelineValue,
  type WinRate,
} from "@/lib/pipeline/derive";

type Market = "us" | "kz";

/**
 * The four numbers above a market's sales board: open pipeline, win rate,
 * the pipeline coverage that win rate asks for, and deals gone quiet. Each
 * is computed from the board, so each says what it rests on and, where it
 * cannot be given, why not.
 *
 * The win-rate benchmark is US and EU data: it is never shown for Kazakhstan.
 */
export function SalesTiles({
  board,
  market,
  now,
}: {
  board: PipelineBoard;
  market: Market;
  now: number;
}) {
  const currency = SCOPE_CURRENCY[market]!;
  const value = pipelineValue(board);
  const rate = winRate(board, now);
  return (
    // The page's heading for the market (an h2) sits above these tiles' h3s.
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <PipelineValueTile value={value} currency={currency} />
      <WinRateTile rate={rate} benchmarked={market === "us"} />
      <CoverageTile coverage={coverageNeeded(rate)} rate={rate} value={value} currency={currency} />
      <QuietTile
        quiet={quietDeals(board, now)}
        limitDays={DEAL_STALE_DAYS}
        one="open deal"
        many="open deals"
        nobody="There are no open deals."
      />
    </div>
  );
}

function PipelineValueTile({ value, currency }: { value: PipelineValue; currency: string }) {
  const label = "Open pipeline";
  const unsorted = value.unsorted > 0 && (
    <Note caution>
      {`${countOf(value.unsorted, "deal", "deals")} ${agree(value.unsorted, "is", "are")} in a stage the OS does not know and ${agree(value.unsorted, "is", "are")} left out.`}
    </Note>
  );

  if (value.open === 0) {
    return (
      <DerivedTile label={label} value="No open deals">
        <Note>Nothing is in Lead, Qualified, Demo or Proposal.</Note>
        {unsorted}
      </DerivedTile>
    );
  }
  if (value.value === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note>
          {value.open === 1
            ? "The one open deal has no amount yet."
            : `None of the ${value.open} open deals has an amount yet.`}
        </Note>
        {unsorted}
      </DerivedTile>
    );
  }
  const priced = value.open - value.withoutAmount;
  return (
    <DerivedTile
      label={label}
      value={formatValue(value.value, "currency", currency)}
      exact={formatExact(value.value, "currency", currency)}
      badge={value.withoutAmount > 0 ? "partial" : undefined}
    >
      <Note>
        {value.withoutAmount > 0
          ? `Monthly fees across ${priced} of ${value.open} open deals, unweighted.`
          : `Monthly fees across ${countOf(value.open, "open deal", "open deals")}, unweighted.`}
      </Note>
      {value.withoutAmount > 0 && (
        <Note caution>
          {`${countOf(value.withoutAmount, "open deal", "open deals")} ${agree(value.withoutAmount, "has", "have")} no amount and ${agree(value.withoutAmount, "is", "are")} left out.`}
        </Note>
      )}
      {unsorted}
    </DerivedTile>
  );
}

export function WinRateTile({ rate, benchmarked }: { rate: WinRate; benchmarked: boolean }) {
  const label = "Win rate";
  const undated = rate.undated > 0 && (
    <Note caution>
      {`${countOf(rate.undated, "closed deal", "closed deals")} ${agree(rate.undated, "has", "have")} no close date and ${agree(rate.undated, "is", "are")} left out.`}
    </Note>
  );

  if (rate.kind === "none") {
    return (
      <DerivedTile label={label} value={null}>
        <Note>{`No deal has closed in the last ${WIN_RATE_WINDOW_DAYS} days.`}</Note>
        {undated}
      </DerivedTile>
    );
  }
  const closed = rate.won + rate.lost;
  const percent = rate.rate * 100;
  const enough = closed >= WIN_RATE_MIN_CLOSED;
  return (
    <DerivedTile
      label={label}
      value={formatValue(percent, "percent")}
      exact={formatExact(percent, "percent")}
    >
      {benchmarked && enough && (
        <BenchmarkChip value={percent} benchmark={BENCHMARKS.win_rate_new_logo} />
      )}
      <Note>{`${rate.won} won of ${closed} closed in the last ${WIN_RATE_WINDOW_DAYS} days.`}</Note>
      {benchmarked && !enough && (
        <Note>{`Too few to hold against a benchmark: that needs ${WIN_RATE_MIN_CLOSED} closed deals.`}</Note>
      )}
      {undated}
    </DerivedTile>
  );
}

function CoverageTile({
  coverage,
  rate,
  value,
  currency,
}: {
  coverage: Coverage;
  rate: WinRate;
  value: PipelineValue;
  currency: string;
}) {
  const label = "Coverage needed";
  if (coverage.kind === "none") {
    return (
      <DerivedTile label={label} value={null}>
        <Note>Needs a win rate first.</Note>
      </DerivedTile>
    );
  }
  if (coverage.kind === "no_wins") {
    return (
      <DerivedTile label={label} value="No wins yet">
        <Note>{`Nothing was won in the last ${WIN_RATE_WINDOW_DAYS} days, so there is no multiple to give.`}</Note>
      </DerivedTile>
    );
  }
  const covers =
    rate.kind === "value" && value.value !== null ? value.value * rate.rate : null;
  return (
    <DerivedTile
      label={label}
      value={`${formatValue(coverage.multiple, "ratio")}×`}
      exact={`${formatExact(coverage.multiple, "ratio")}×`}
    >
      <Note>1 ÷ win rate: the open pipeline needed for each unit of new monthly fees.</Note>
      {covers !== null && (
        <Note>{`At that rate today's open pipeline closes about ${formatValue(covers, "currency", currency)} a month.`}</Note>
      )}
      {coverage.closed < WIN_RATE_MIN_CLOSED && (
        <Note caution>
          {`Rests on ${countOf(coverage.closed, "closed deal", "closed deals")}, so treat it as rough.`}
        </Note>
      )}
    </DerivedTile>
  );
}
