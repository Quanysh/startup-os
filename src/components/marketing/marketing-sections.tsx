"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { getMetric, type MetricDef } from "@convex/lib/metricRegistry";
import { AttentionList } from "@/components/attention-list";
import { MarketingSummary } from "@/components/marketing/summary-tiles";
import { MetricTile } from "@/components/metrics/metric-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { readsVisitorSignup } from "@/lib/metrics/gtm";
import { attentionItems, homeTiles, sourcesOfSection } from "@/lib/metrics/scorecard";

const metrics = (keys: string[]): MetricDef[] =>
  keys.flatMap((key) => {
    const metric = getMetric(key);
    return metric ? [metric] : [];
  });
const SEARCH = metrics(["search_clicks", "search_impressions", "search_position"]);
const AUDIENCE = metrics(["linkedin_followers"]);

// The sources whose failed run belongs on this page: the ones that feed it.
// PostHog is one of them through visitor to signup, whose two metrics are
// declared with the product's.
const MARKETING_SOURCES = new Set(
  [...sourcesOfSection("marketing"), "posthog"].map((id) => `source:${id}`),
);

/**
 * Who finds Startup, and where from: the inbound half of the go-to-market page.
 * It reads the scorecard itself, so the page can show it or leave it out whole.
 */
export function MarketingSections() {
  const data = useScorecard();
  const now = useNow();
  return (
    <section aria-labelledby="inbound" className="space-y-6">
      <div>
        <h2 id="inbound" className="text-xl">
          Inbound
        </h2>
        <p className="mt-1 max-w-xl text-sm text-ink-2">Who finds {COMPANIES.us.name}, and where from.</p>
      </div>
      {data === undefined || now === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-card" />
          ))}
        </div>
      ) : (
        <Loaded data={data} now={now} />
      )}
    </section>
  );
}

function Loaded({
  data,
  now,
}: {
  data: FunctionReturnType<typeof api.metrics.scorecard>;
  now: number;
}) {
  const { can } = useViewer();
  // Only failed runs, and only of sources that feed this page's numbers.
  const failures = attentionItems(data.tiles, data.sources, now).filter(
    (item) => item.severity === "error" && MARKETING_SOURCES.has(item.id),
  );
  const stored = (list: MetricDef[]) =>
    list.flatMap((metric) =>
      homeTiles(metric, data.tiles).map((tile) => (
        <MetricTile key={`${tile.key}:${tile.scope}`} metric={metric} tile={tile} now={now} />
      )),
    );

  return (
    <>
      {failures.length > 0 && <AttentionList items={failures} />}

      <MarketingSummary
        signups={readsVisitorSignup(can)}
        tiles={data.tiles}
        now={now}
        posthogReadAt={data.sources.posthog?.lastOkAt ?? null}
      />

      {/* No benchmark on these: the design gives no band for search figures. */}
      <section aria-labelledby="search-console" className="space-y-3">
        <h3 id="search-console" className="text-base">
          Search Console
        </h3>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
          {
            "Weeks run Monday to Sunday in Google's dates (Pacific time). Google's figures arrive 2–3 days late, so the newest week here is the last one Google has finished: last week from about Wednesday, the week before until then."
          }
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{stored(SEARCH)}</div>
      </section>

      <section aria-labelledby="audience" className="space-y-3">
        <h3 id="audience" className="text-base">
          Audience
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{stored(AUDIENCE)}</div>
      </section>
    </>
  );
}
