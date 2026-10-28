// What the go-to-market page works out from Apollo's lists and weekly counts.
// Nothing here is stored, and nothing here reads a clock: a function that
// depends on "now" takes it, or the week in progress, as an argument.

import { previousPeriodStart } from "@convex/lib/periods";
import type { Point } from "./derive";
import { MIN_DELIVERED_FOR_VERDICT } from "./gtm";

const DAY = 24 * 60 * 60 * 1000;

/** An active sequence unused for this many days is called idle. */
export const IDLE_AFTER_DAYS = 30;
/** Fewer finished weeks than this are figures, not a chart. */
export const MIN_WEEKS_FOR_CHART = 3;
/**
 * A list is pushed whole by each daily Apollo read. Past this many days
 * without one it says so: the same limit the daily Apollo levels have.
 */
export const LIST_STALE_DAYS = 4;

/** A sequence as `workTools.outbound` returns it. */
export type SequenceRow = {
  sequenceId: string;
  name: string;
  active: boolean;
  archived: boolean;
  steps: number;
  /** UTC days, "YYYY-MM-DD". */
  createdAt: string;
  lastUsedAt?: string;
  delivered: number;
  opened: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  clicked?: number;
};
export type StageCount = { entity: "contact" | "account"; stage: string; count: number };

/**
 * How a sequence stands. First matching row wins:
 *   archived            → Archived (neutral)
 *   active              → Active   (success)
 *   otherwise           → Paused   (neutral)
 */
export function sequenceStatus(row: Pick<SequenceRow, "active" | "archived">): {
  label: "Active" | "Paused" | "Archived";
  tone: "success" | "neutral";
} {
  if (row.archived) return { label: "Archived", tone: "neutral" };
  if (row.active) return { label: "Active", tone: "success" };
  return { label: "Paused", tone: "neutral" };
}

/**
 * A count as a percentage of emails delivered, or null where no rate is
 * given: under the page's minimum for a verdict (one reply would move it by
 * points), or where the count is above what was delivered.
 */
export function rateOf(part: number, delivered: number): number | null {
  if (delivered < MIN_DELIVERED_FOR_VERDICT || part > delivered) return null;
  return (part * 100) / delivered;
}

/**
 * How many days an active sequence has gone unused, once that is
 * `IDLE_AFTER_DAYS` or more; null otherwise. A sequence never used is counted
 * from the day it was made. Paused and archived ones are never idle.
 */
export function idleDays(row: SequenceRow, now: number): number | null {
  if (sequenceStatus(row).label !== "Active") return null;
  const since = Date.parse(`${row.lastUsedAt ?? row.createdAt}T00:00:00Z`);
  const days = Math.floor((now - since) / DAY);
  return days >= IDLE_AFTER_DAYS ? days : null;
}

export function sequenceTotals(rows: readonly SequenceRow[]) {
  return rows.reduce(
    (sum, row) => ({
      delivered: sum.delivered + row.delivered,
      opened: sum.opened + row.opened,
      replied: sum.replied + row.replied,
      bounced: sum.bounced + row.bounced,
    }),
    { delivered: 0, opened: 0, replied: 0, bounced: 0 },
  );
}

/** One entity's stages, each with its share of that entity's total (null with nobody in any). */
export function stageRows(
  stages: readonly StageCount[],
  entity: StageCount["entity"],
): { stage: string; count: number; share: number | null }[] {
  const own = stages.filter((row) => row.entity === entity);
  const total = own.reduce((sum, row) => sum + row.count, 0);
  return own.map(({ stage, count }) => ({
    stage,
    count,
    share: total > 0 ? (count * 100) / total : null,
  }));
}

// Shared with the attention list the owner's agent reads (convex/lib/attention/engineering.ts).
export { newestPoint } from "@convex/lib/attention/engineering";

/**
 * A week's-own-count series (contacts added, calls) as the page shows it.
 * Only weeks that have ended count. `lastWeek` is the week before the one in
 * progress and nothing older; `chart` is true from `MIN_WEEKS_FOR_CHART`
 * finished weeks with at least one above zero: one bar is not a trend, and no
 * bar at all is an empty box.
 */
export function weeklyCounts(
  series: readonly Point[],
  currentWeek: string,
): { weeks: Point[]; lastWeek: Point | null; newest: Point | null; chart: boolean } {
  const weeks = series
    .filter((point) => point.periodStart < currentWeek)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const last = previousPeriodStart("week", currentWeek);
  return {
    weeks,
    lastWeek: weeks.find((point) => point.periodStart === last) ?? null,
    newest: weeks.at(-1) ?? null,
    chart: weeks.length >= MIN_WEEKS_FOR_CHART && weeks.some((point) => point.value > 0),
  };
}

/** How many whole days ago a list was read, once that is past its limit; null while current. */
export function listAgeDays(readAt: number, now: number): number | null {
  const age = now - readAt;
  return age > LIST_STALE_DAYS * DAY ? Math.floor(age / DAY) : null;
}
