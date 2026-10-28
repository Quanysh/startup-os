"use client";

import { getMetric } from "@convex/lib/metricRegistry";
import { useTargets } from "@/components/dashboard/reads";
import { MetricTile } from "@/components/metrics/metric-tile";
import { FlatTiles } from "@/components/metrics/tile-frame";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { homeTiles } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

// Who pays, and what is owed where a company reports that. Both are money
// figures: Convex sends them to a viewer with finance, and a tile that was
// not sent is simply not drawn. Nor is one with no value yet: an empty tile
// asking for a figure says nothing about the company, and /finance asks.
const FIGURES = ["paying_clinics", "receivables"].flatMap((key) => {
  const metric = getMetric(key);
  return metric ? [metric] : [];
});

/**
 * Paying clinics and receivables for the company in view: the one rendering
 * of these two figures, shared by Dashboard › Customers and the Customers
 * page so the Dashboard's link lands on the same numbers. Nothing while the
 * scorecard or the clock loads, and nothing where neither figure was sent.
 */
export function PayingFigures({ flat = false, className }: { flat?: boolean; className?: string }) {
  const data = useScorecard();
  const now = useNow();
  const targetOf = useTargets();
  if (data === undefined || now === null) return null;
  const figures = FIGURES.flatMap((metric) =>
    homeTiles(metric, data.tiles)
      .filter((tile) => tile.latest !== null)
      .map((tile) => ({ metric, tile })),
  );
  if (figures.length === 0) return null;
  const tiles = figures.map(({ metric, tile }) => (
    <MetricTile
      key={`${tile.key}:${tile.scope}`}
      metric={metric}
      tile={tile}
      now={now}
      target={targetOf(tile.key, tile.scope)}
      minTrend={3}
    />
  ));
  // In a section's panel the tiles are drawn flat; on a page of their own, as cards.
  return flat ? (
    <FlatTiles>
      <div className={cn("grid gap-x-6 gap-y-5 @md:grid-cols-2", className)}>{tiles}</div>
    </FlatTiles>
  ) : (
    <section aria-label="Paying clinics and receivables" className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {tiles}
    </section>
  );
}
