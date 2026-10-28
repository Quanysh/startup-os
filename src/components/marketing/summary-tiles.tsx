import { useId } from "react";
import { getMetric } from "@convex/lib/metricRegistry";
import { periodStart } from "@convex/lib/periods";
import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { VisitorSignupTile } from "@/components/product/rate-tiles";
import { formatExact, formatPeriod, formatValue } from "@/lib/format";
import { latestSearchWeek } from "@/lib/metrics/marketing";
import { visitorToSignup } from "@/lib/metrics/product";
import { metricFreshness, type Tile } from "@/lib/metrics/scorecard";

const weekOf = (start: string) => `the week of ${formatPeriod("week", start, "short")}`;
const counted = (n: number, one: string, many: string) =>
  `${formatValue(n, "count")} ${n === 1 ? one : many}`;

/**
 * The marketing numbers that are computed rather than stored. Each says what
 * it rests on, and, where it cannot be given, why not.
 *
 * Visitor to signup is the product page's tile and the product page's sum
 * (`visitorToSignup`, PostHog's weeks for Startup Insights), shown here as well:
 * one figure in two places, never a second way of working it out.
 */
export function MarketingSummary({
  tiles,
  now,
  posthogReadAt,
  signups = true,
}: {
  tiles: readonly Tile[];
  now: number;
  /** Whether the viewer is sent visitor to signup (`readsVisitorSignup`); left out otherwise. */
  signups?: boolean;
  /** When PostHog last finished a run (`sources.posthog.lastOkAt`), or null. */
  posthogReadAt: number | null;
}) {
  const headingId = useId();
  const currentWeek = periodStart("week", now);
  const seriesIn = (scope: string) => (key: string) =>
    tiles.find((t) => t.key === key && t.scope === scope)?.series ?? [];
  const series = seriesIn("company");
  const search = seriesIn("startup_insights");
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        Summary
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SearchCtrTile
          week={latestSearchWeek(
            series("search_clicks"),
            series("search_impressions"),
            currentWeek,
          )}
          now={now}
        />
        {signups && (
          <VisitorSignupTile
            rate={visitorToSignup(
              search("web_visitors"),
              search("signups"),
              currentWeek,
              posthogReadAt,
            )}
          />
        )}
      </div>
    </section>
  );
}

// No benchmark: the design gives no band for click-through rate.
function SearchCtrTile({
  week,
  now,
}: {
  week: ReturnType<typeof latestSearchWeek>;
  now: number;
}) {
  const label = "Search click-through rate";
  if (week === null) {
    return (
      <DerivedTile label={label} value={null}>
        <Note>Arrives with Search Console.</Note>
        <Note>
          {
            "Google's figures arrive 2–3 days late, so a week appears once Google has finished it."
          }
        </Note>
      </DerivedTile>
    );
  }
  const old =
    metricFreshness(now, getMetric("search_clicks")!, "company", week.week) === "stale";
  return (
    <DerivedTile
      label={label}
      value={formatValue(week.ctrPercent, "percent")}
      exact={formatExact(week.ctrPercent, "percent")}
    >
      <Note>
        {`${counted(week.clicks, "click", "clicks")} from ${counted(week.impressions, "impression", "impressions")}, ${weekOf(week.week)}.`}
      </Note>
      <Note>
        {
          "Google's figures arrive 2–3 days late, so this is the last week Google has finished."
        }
      </Note>
      {old && <Note caution>{`Out of date: nothing newer than ${weekOf(week.week)}.`}</Note>}
    </DerivedTile>
  );
}
