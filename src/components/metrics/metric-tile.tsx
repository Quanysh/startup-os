import { CircleCheckIcon, CircleXIcon, PlusIcon } from "lucide-react";
import { GatedLink } from "@/components/gated-link";
import { SCOPE_LABELS, type MetricDef, type Scope } from "@convex/lib/metricRegistry";
import { formatExact, formatPeriod, formatValue } from "@/lib/format";
import { changeFromPrevious } from "@/lib/metrics/derive";
import { metricFreshness, supplyOf, type Tile } from "@/lib/metrics/scorecard";
import { targetStatus } from "@/lib/metrics/targets";
import { ChangeBadge } from "./change-badge";
import { FreshnessLine } from "./freshness-line";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";
import { useTileFrame } from "./tile-frame";

/**
 * One number on the scorecard: label, value, change against the previous
 * bucket, trend, and where it came from. With no value yet it becomes a
 * prompt to add one.
 */
export function MetricTile({
  metric,
  tile,
  now,
  target,
  minTrend = 1,
}: {
  metric: MetricDef;
  tile: Tile;
  now: number | null;
  /** The owner's own target for this number, if one is set. */
  target?: number;
  /**
   * The fewest buckets the trend line is drawn for. The dashboard asks for
   * three (two points are a change, which the badge already says) or, with
   * `Infinity`, for none where a chart beside the tile shows the trend.
   */
  minTrend?: number;
}) {
  const { frame } = useTileFrame();
  const scope = SCOPE_LABELS[tile.scope as Scope] ?? tile.scope;
  const supply = supplyOf(metric, tile.scope);

  return (
    <article className={cn("flex min-w-0 flex-col", frame)}>
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-2">{metric.label}</h3>
        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-2">
          {scope}
        </span>
      </header>

      {tile.latest === null ? (
        <div className="mt-3 flex flex-1 flex-col justify-between">
          <p className="text-2xl font-semibold text-ink-3">No value yet</p>
          {/* The entry form and the sources page are the owner's. Anyone else is
              told how the figure arrives, with nowhere to go. */}
          {supply.how === "enter" ? (
            <GatedLink
              href={supply.href}
              className="inline-flex w-fit items-center gap-1 rounded-full text-xs font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              otherwise={<p className="text-[11px] text-ink-3">The owner enters this figure.</p>}
            >
              <PlusIcon aria-hidden className="size-3.5" />
              Add a value
            </GatedLink>
          ) : (
            <GatedLink
              href={supply.href}
              className="w-fit rounded-full text-[11px] text-ink-3 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              otherwise={<p className="text-[11px] text-ink-3">Arrives with {supply.source}.</p>}
            >
              Arrives with {supply.source}.
            </GatedLink>
          )}
        </div>
      ) : (
        <FilledTile
          metric={metric}
          tile={tile}
          latest={tile.latest}
          now={now}
          target={target}
          minTrend={minTrend}
        />
      )}
    </article>
  );
}

function FilledTile({
  metric,
  tile,
  latest,
  now,
  target,
  minTrend,
}: {
  metric: MetricDef;
  tile: Tile;
  latest: NonNullable<Tile["latest"]>;
  now: number | null;
  target?: number;
  minTrend: number;
}) {
  const change = changeFromPrevious(metric.grain, tile.series);
  const display = (value: number) => formatValue(value, metric.unit, latest.currency);
  return (
    <>
      <p
        className="mt-2 text-3xl font-semibold tracking-tight text-ink"
        title={formatExact(latest.value, metric.unit, latest.currency)}
      >
        {display(latest.value)}
      </p>
      <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
        {change && (
          <ChangeBadge
            ratio={change.ratio}
            better={metric.better}
            versus={formatPeriod(metric.grain, change.previousPeriodStart, "short")}
          />
        )}
        {target !== undefined && (
          <TargetLine
            met={targetStatus(latest.value, target, metric.better) === "met"}
            target={display(target)}
          />
        )}
      </div>
      {tile.series.length >= minTrend && (
        <Sparkline
          className="mt-auto"
          ariaLabel={`${metric.label} trend over ${tile.series.length} ${metric.grain}s`}
          points={tile.series.map((p) => ({
            label: formatPeriod(metric.grain, p.periodStart),
            value: p.value,
            display: display(p.value),
          }))}
        />
      )}
      <FreshnessLine
        className="mt-2"
        latest={latest}
        freshness={
          now === null ? null : metricFreshness(now, metric, tile.scope, latest.periodStart)
        }
        now={now}
        period={formatPeriod(metric.grain, latest.periodStart)}
      />
    </>
  );
}

/** On or off the owner's target: an icon and words, with the target itself. */
function TargetLine({ met, target }: { met: boolean; target: string }) {
  const Icon = met ? CircleCheckIcon : CircleXIcon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-2">
      <Icon aria-hidden className={met ? "size-3.5 text-good" : "size-3.5 text-weak"} />
      <span className="font-medium text-ink">{met ? "On target" : "Off target"}</span>
      <span className="font-num">{target}</span>
    </span>
  );
}
