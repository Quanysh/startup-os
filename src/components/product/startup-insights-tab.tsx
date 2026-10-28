import { periodStart } from "@convex/lib/periods";
import { activationRate, visitorToSignup } from "@/lib/metrics/product";
import { ActivationTile, VisitorSignupTile } from "./rate-tiles";
import { TileGrid, type TabProps } from "./tile-grid";

const SCOPE = "startup_insights";
// Activated signups are stored but are not a tile: the newest week's count
// keeps rising for seven days, so it would read as a fall every week. The
// activation rate above waits for a week to settle.
const FIGURES = [
  "weekly_active_users",
  "searches",
  "web_visitors",
  "signups",
  "site_pageviews",
  "deploys",
  "deploys_failed",
].map((key) => ({ key, scope: SCOPE }));

export function StartupInsightsTab({ tiles, sources, now }: TabProps) {
  // Which week is still in progress is the client's to say: a query cannot
  // know what "now" is.
  const currentWeek = periodStart("week", now);
  // When PostHog last finished a run decides which weeks are whole and which
  // signup weeks have settled. Not a tile's `syncedAt`: a write leaves that
  // alone when the value is unchanged.
  const readAt = sources.posthog?.lastOkAt ?? null;
  const seriesOf = (key: string) =>
    tiles.find((tile) => tile.key === key && tile.scope === SCOPE)?.series ?? [];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <ActivationTile
          rate={activationRate(seriesOf("signups"), seriesOf("signups_activated"), currentWeek, readAt)}
        />
        <VisitorSignupTile
          rate={visitorToSignup(seriesOf("web_visitors"), seriesOf("signups"), currentWeek, readAt)}
        />
      </div>
      <section aria-labelledby="weekly-figures" className="space-y-3">
        <h2 id="weekly-figures" className="text-base">
          Weekly figures
        </h2>
        <TileGrid figures={FIGURES} tiles={tiles} now={now} />
        <p className="text-xs text-ink-2">
          Weeks run Monday to Sunday, UTC. Only weeks that have ended are shown.
        </p>
      </section>
    </>
  );
}
