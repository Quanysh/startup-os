import { ClockAlertIcon } from "lucide-react";
import { ageLabel, type Freshness } from "@/lib/freshness";
import { sourceLabel, type Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";

/**
 * Which period a number is for, where it came from and when it last changed.
 * A number with nothing newer than it should have says so with an icon and
 * the word, rather than quietly looking current.
 */
export function FreshnessLine({
  latest,
  freshness,
  now,
  period,
  className,
}: {
  latest: NonNullable<Tile["latest"]>;
  /**
   * Decided by `metricFreshness`, the one place a scope's own limit is
   * applied. null while there is no clock (server render): nothing is then
   * called stale.
   */
  freshness: Freshness | null;
  /** null while rendering on the server: the age is then left out. */
  now: number | null;
  /** The bucket's name, e.g. "Oct 2026". */
  period: string;
  className?: string;
}) {
  const stale = freshness === "stale";
  return (
    <p
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-ink-3",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {stale && <ClockAlertIcon aria-hidden className="size-3 text-watch" />}
        <span className={stale ? "font-medium text-ink" : undefined}>
          {stale && "Stale · "}
          {period}
        </span>
      </span>
      <span className="whitespace-nowrap">
        {sourceLabel(latest.source, "short")}
        {now !== null && ` · ${ageLabel(now, latest.syncedAt)}`}
      </span>
    </p>
  );
}
