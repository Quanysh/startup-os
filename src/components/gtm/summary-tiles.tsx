import { useId } from "react";
import { getMetric } from "@convex/lib/metricRegistry";
import { periodStart, previousPeriodStart } from "@convex/lib/periods";
import { Note } from "@/components/finance/notes";
import { BenchmarkChip } from "@/components/metrics/benchmark-chip";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { formatExact, formatPeriod, formatValue } from "@/lib/format";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import { MIN_DELIVERED_FOR_VERDICT, replyRate, weekDelta } from "@/lib/metrics/gtm";
import { metricFreshness, type Tile } from "@/lib/metrics/scorecard";
import { dealsCreatedSentence, type DealsCreated } from "@/lib/pipeline/created";

const short = (start: string) => formatPeriod("week", start, "short");
const count = (n: number) => formatValue(n, "count");

/** The go-to-market numbers that are computed rather than stored. */
export function GtmSummary({
  tiles,
  now,
  dealsCreated,
}: {
  tiles: readonly Tile[];
  now: number;
  /**
   * Deals created in the last four complete weeks; undefined while they load,
   * null where they are not this viewer's to read (no tile then).
   */
  dealsCreated: DealsCreated | null | undefined;
}) {
  const headingId = useId();
  const currentWeek = periodStart("week", now);
  const series = (key: string) =>
    tiles.find((t) => t.key === key && t.scope === "us")?.series ?? [];
  const delivered = series("outbound_delivered");
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        Summary
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ReplyRateTile rate={replyRate(delivered, series("outbound_replied"))} now={now} />
        <DeliveredTile totals={delivered} currentWeek={currentWeek} />
        {dealsCreated === undefined ? (
          <Skeleton className="h-44 rounded-card" />
        ) : (
          dealsCreated !== null && <DealsCreatedTile created={dealsCreated} />
        )}
      </div>
    </section>
  );
}

// US scope only: the benchmark is US and EU data.
export function ReplyRateTile({ rate, now }: { rate: ReturnType<typeof replyRate>; now: number }) {
  const label = "Outbound reply rate";
  if (rate.kind === "none") {
    return (
      <DerivedTile label={label} value={null}>
        {rate.reason === "no_data" && <Note>Arrives with Apollo.</Note>}
        {rate.reason === "nothing_delivered" && (
          <Note>No outbound email has been delivered yet.</Note>
        )}
        {rate.reason === "inconsistent" && (
          <Note caution>
            Apollo reports more replies than emails delivered, so no rate is given.
          </Note>
        )}
      </DerivedTile>
    );
  }
  const { percent, delivered, replied, week } = rate;
  const basis = (
    <Note>
      {`${count(replied)} ${replied === 1 ? "reply" : "replies"} to ${count(delivered)} delivered, every sequence to date.`}
    </Note>
  );
  const stale = metricFreshness(now, getMetric("outbound_delivered")!, "us", week) === "stale";
  return (
    <DerivedTile
      label={label}
      value={formatValue(percent, "percent")}
      exact={formatExact(percent, "percent")}
    >
      {delivered >= MIN_DELIVERED_FOR_VERDICT ? (
        <>
          <BenchmarkChip value={percent} benchmark={BENCHMARKS.cold_email_reply_rate} />
          {basis}
        </>
      ) : (
        <>
          {basis}
          <Note>{`Under ${MIN_DELIVERED_FOR_VERDICT} delivered, so no benchmark verdict yet.`}</Note>
        </>
      )}
      {stale && (
        <Note caution>{`Out of date: Apollo was last read in the week of ${short(week)}.`}</Note>
      )}
    </DerivedTile>
  );
}

export function DeliveredTile({ totals, currentWeek }: { totals: Tile["series"]; currentWeek: string }) {
  const label = "Delivered last week";
  const lastWeek = previousPeriodStart("week", currentWeek);
  const last = weekDelta(totals, lastWeek);
  const soFar = weekDelta(totals, currentWeek);
  const thisWeek = soFar.kind === "value" && (
    <Note>{`This week so far: ${count(soFar.value)}.`}</Note>
  );

  if (last.kind === "value") {
    return (
      <DerivedTile label={label} value={count(last.value)} exact={formatExact(last.value, "count")}>
        <Note>
          {`The week of ${short(lastWeek)}, measured between that week's last daily read and the one before.`}
        </Note>
        {thisWeek}
      </DerivedTile>
    );
  }
  return (
    <DerivedTile label={label} value={null}>
      {last.reason === "no_data" && <Note>Arrives with Apollo.</Note>}
      {last.reason === "no_previous" && (
        <Note>
          {`Needs Apollo's totals from two weeks in a row: the weeks of ${short(previousPeriodStart("week", lastWeek))} and ${short(lastWeek)}.`}
        </Note>
      )}
      {last.reason === "total_fell" && (
        <Note caution>
          {
            "Apollo's total fell between the two weeks, as it does when a sequence is deleted, so no weekly figure is given."
          }
        </Note>
      )}
      {thisWeek}
    </DerivedTile>
  );
}

// A count of deals, both markets together: no amounts, so nothing to convert
// and no benchmark. Zero is a real zero here, not a missing figure.
function DealsCreatedTile({ created }: { created: DealsCreated }) {
  return (
    <DerivedTile label="Deals created, last four weeks" value={count(created.total)}>
      <Note>{dealsCreatedSentence(created)}</Note>
      {created.kzMirrored > 0 && (
        <Note>Kazakhstan deals count from when the CRM first listed them here.</Note>
      )}
    </DerivedTile>
  );
}
