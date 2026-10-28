import { getMetric } from "@convex/lib/metricRegistry";
import { MetricTile } from "@/components/metrics/metric-tile";
import { knownTile, type SourceStates, type Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

/** What every tab is given: the scorecard's tiles and sources, and the clock. */
export type TabProps = { tiles: readonly Tile[]; sources: SourceStates; now: number };

/**
 * Stored figures as tiles, in the order given. Each is named by metric and
 * scope, because one metric can belong to two products (weekly active users).
 * A pair this build's registry does not know is passed over.
 */
export function TileGrid({
  figures,
  tiles,
  now,
  four = false,
}: {
  figures: readonly { key: string; scope: string }[];
  tiles: readonly Tile[];
  now: number;
  /** A set of four: two by two, or four a row on a wide screen, never three and one. */
  four?: boolean;
}) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", four ? "xl:grid-cols-4" : "lg:grid-cols-3")}>
      {figures.flatMap(({ key, scope }) => {
        const metric = getMetric(key);
        const tile = tiles.find((t) => t.key === key && t.scope === scope);
        if (!metric || !tile || !knownTile(metric, tile)) return [];
        return [<MetricTile key={`${key}:${scope}`} metric={metric} tile={tile} now={now} />];
      })}
    </div>
  );
}
