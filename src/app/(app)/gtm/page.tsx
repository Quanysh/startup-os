"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { getMetric, type MetricDef } from "@convex/lib/metricRegistry";
import { AttentionList } from "@/components/attention-list";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { ApolloSections } from "@/components/gtm/apollo-sections";
import { GtmSummary } from "@/components/gtm/summary-tiles";
import { MarketingSections } from "@/components/marketing/marketing-sections";
import { MetricTile } from "@/components/metrics/metric-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { attentionItems, homeTiles, sourcesOfSection } from "@/lib/metrics/scorecard";
import { dealsCreated, dealsCreatedWindow } from "@/lib/pipeline/created";

const FIGURES: MetricDef[] = [
  "meetings_booked",
  "outbound_delivered",
  "outbound_opened",
  "outbound_replied",
].flatMap((key) => {
  const metric = getMetric(key);
  return metric ? [metric] : [];
});

// The sources whose failed run belongs on this page: the ones that feed it.
const GTM_SOURCES = new Set(sourcesOfSection("gtm").map((id) => `source:${id}`));

export default function GtmPage() {
  const data = useQuery(api.metrics.scorecard);
  const now = useNow();
  const viewer = useViewer();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Go to market"
        purpose={`Who finds ${COMPANIES.us.name}, the outbound that goes after the rest, the meetings it books and the pipeline they create.`}
        aside={<PageFreshness page="gtm" />}
      />

      {/* Inbound first: it is where the funnel starts. */}
      {viewer.can("marketing") && <MarketingSections />}

      <div>
        <h2 className="text-xl">Outbound</h2>
        <p className="mt-1 max-w-xl text-sm text-ink-2">
          Sequences, the meetings they book and the deals those become.
        </p>
      </div>

      {data === undefined || now === null ? (
        <div className="space-y-6" aria-busy>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-card" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-card" />
            ))}
          </div>
        </div>
      ) : (
        <Loaded data={data} now={now} />
      )}
    </div>
  );
}

function Loaded({
  data,
  now,
}: {
  data: FunctionReturnType<typeof api.metrics.scorecard>;
  now: number;
}) {
  // Deals created in the four weeks that have ended: what was created since
  // they began, less the week in progress. The window comes from this page's
  // clock, never from a query, and moves only when a week ends.
  const { from, to } = dealsCreatedWindow(now);
  // Deals are the sales area's. A viewer without it is not asked, which
  // Convex would refuse, and gets the page without that tile.
  const sells = useViewer().can("sales");
  const sinceFrom = useQuery(api.deals.createdSince, sells ? { since: from } : "skip");
  const sinceTo = useQuery(api.deals.createdSince, sells ? { since: to } : "skip");
  const created = !sells
    ? null
    : sinceFrom === undefined || sinceTo === undefined
      ? undefined
      : dealsCreated(sinceFrom, sinceTo);

  // Apollo is Startup's: its lists are for the people on Startup, and Convex
  // refuses anyone else. Nobody else is asked, and they get the page without
  // those sections (whose numbers the scorecard did not send them either).
  const onStartup = useViewer().companies.includes("us");
  const lists = useQuery(api.workTools.outbound, onStartup ? {} : "skip");

  // Only failed runs, and only of sources that feed this page's numbers.
  const failures = attentionItems(data.tiles, data.sources, now).filter(
    (item) => item.severity === "error" && GTM_SOURCES.has(item.id),
  );

  return (
    <>
      {failures.length > 0 && <AttentionList items={failures} />}

      <GtmSummary tiles={data.tiles} now={now} dealsCreated={created} />

      {/* No benchmark on these: the design gives a band for the reply rate only. */}
      <section aria-labelledby="reported-figures" className="space-y-3">
        <h3 id="reported-figures" className="text-base">
          Reported figures
        </h3>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-2">
          {
            "Apollo counts to date, across every sequence. Each week's tile holds the totals as last read in that week; the week in progress moves until it ends."
          }
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FIGURES.flatMap((metric) =>
            homeTiles(metric, data.tiles).map((tile) => (
              <MetricTile key={`${tile.key}:${tile.scope}`} metric={metric} tile={tile} now={now} />
            )),
          )}
        </div>
      </section>

      {/* Apollo beyond its totals: the sequences, who they go to, and what waits on a person. */}
      {onStartup && <ApolloSections tiles={data.tiles} now={now} lists={lists} />}
    </>
  );
}
