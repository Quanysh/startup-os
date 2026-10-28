"use client";

import { periodStart } from "@convex/lib/periods";
import { useCompany } from "@/components/company-provider";
import { DeliveredTile, ReplyRateTile } from "@/components/gtm/summary-tiles";
import { FlatTiles } from "@/components/metrics/tile-frame";
import { VisitorSignupTile } from "@/components/product/rate-tiles";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { pageServes } from "@/lib/company";
import { readsVisitorSignup, replyRate } from "@/lib/metrics/gtm";
import { visitorToSignup } from "@/lib/metrics/product";
import { DashboardSection, SectionSkeleton } from "./section";

/**
 * The go-to-market page in three numbers: how many visitors sign up, how much
 * of the outbound is answered, and how much went out last week. Each is
 * /gtm's own tile and /gtm's own sum. Startup's alone.
 */
export function GtmSection() {
  const company = useCompany();
  const { can, companies } = useViewer();
  const data = useScorecard();
  const now = useNow();
  if (!can("gtm") || !companies.includes("us") || !pageServes(company, "/gtm")) return null;

  if (data === undefined || now === null) {
    return (
      <DashboardSection title="Go to market" href="/gtm">
        <SectionSkeleton />
      </DashboardSection>
    );
  }

  const currentWeek = periodStart("week", now);
  const seriesOf = (key: string, scope: string) =>
    data.tiles.find((tile) => tile.key === key && tile.scope === scope)?.series ?? [];
  const delivered = seriesOf("outbound_delivered", "us");
  // Inbound's visitor to signup: with Marketing and Product (`readsVisitorSignup`).
  const inbound = readsVisitorSignup(can);

  return (
    <DashboardSection title="Go to market" href="/gtm">
      <FlatTiles>
        <div className="grid gap-x-6 gap-y-5 @md:grid-cols-2 @2xl:grid-cols-3">
          {inbound && (
            <VisitorSignupTile
              rate={visitorToSignup(
                seriesOf("web_visitors", "startup_insights"),
                seriesOf("signups", "startup_insights"),
                currentWeek,
                data.sources.posthog?.lastOkAt ?? null,
              )}
            />
          )}
          <ReplyRateTile rate={replyRate(delivered, seriesOf("outbound_replied", "us"))} now={now} />
          <DeliveredTile totals={delivered} currentWeek={currentWeek} />
        </div>
      </FlatTiles>
    </DashboardSection>
  );
}
