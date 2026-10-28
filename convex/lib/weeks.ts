// Weeks as the product connectors count them: Monday to Monday, in UTC. A
// week is named by its Monday ("YYYY-MM-DD"), the same bucket periods.ts
// gives, and numbered from the first Monday after the epoch so a source can
// be asked for weeks with plain arithmetic on a Unix timestamp.

import { BACKFILL_MONTHS, clampLimit } from "./limits";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** 1970-01-05, the first Monday after the epoch: week 0 starts here. */
export const FIRST_MONDAY_MS = 4 * DAY_MS;
export const WEEK_SECONDS = WEEK_MS / 1000;
export const FIRST_MONDAY_SECONDS = FIRST_MONDAY_MS / 1000;

/** The closed weeks a plain run re-reads, so late events land. */
export const DEFAULT_SYNC_WEEKS = 8;

/** Which week `at` falls in, counted from the first Monday after the epoch. */
export function weekIndex(at: number): number {
  return Math.floor((at - FIRST_MONDAY_MS) / WEEK_MS);
}

/** The Monday a numbered week starts on, as a bucket start. */
export function weekStartOfIndex(index: number): string {
  return new Date(FIRST_MONDAY_MS + index * WEEK_MS).toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a "YYYY-MM-DD" day. */
export function msOfDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** The `count` most recent weeks that have ended by `now`, oldest first. */
export function closedWeeks(now: number, count: number): string[] {
  const current = weekIndex(now);
  return Array.from({ length: count }, (_, i) => weekStartOfIndex(current - count + i));
}

/**
 * The closed weeks one sync reads: eight on a plain run, or as many weeks as
 * `months` months hold when a backfill passes it (thirteen months: 57).
 */
export function syncWeeks(now: number, months: number | undefined): string[] {
  if (months === undefined) return closedWeeks(now, DEFAULT_SYNC_WEEKS);
  const safe = clampLimit(months, BACKFILL_MONTHS, BACKFILL_MONTHS);
  return closedWeeks(now, Math.ceil((safe * 365) / 12 / 7));
}
