// The marketing number nobody stores: search click-through rate. Worked out
// from stored weekly snapshots at read time.
//
// Nothing here reads a clock. The function takes the week in progress and
// uses only weeks before it: the connector writes finished weeks only, and
// this is the second lock on the same door.

import type { Point } from "./derive";

/** The newest point of a week that has ended. */
function newestFinished(points: readonly Point[], currentWeek: string): Point | null {
  return (
    points
      .filter((point) => point.periodStart < currentWeek)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
      .at(-1) ?? null
  );
}

export type SearchWeek = { week: string; clicks: number; impressions: number; ctrPercent: number };

/** Clicks as a share of impressions, for the newest finished week that has both. */
export function latestSearchWeek(
  clicks: readonly Point[],
  impressions: readonly Point[],
  currentWeek: string,
): SearchWeek | null {
  const shown = newestFinished(impressions, currentWeek);
  const clicked = shown && clicks.find((point) => point.periodStart === shown.periodStart);
  if (!shown || !clicked || shown.value <= 0 || clicked.value > shown.value) return null;
  return {
    week: shown.periodStart,
    clicks: clicked.value,
    impressions: shown.value,
    // Multiplied first, so 105 of 2,100 is 5 and not 5.000000000000001.
    ctrPercent: (clicked.value * 100) / shown.value,
  };
}
