// "Is this number current?" is answered here, on the client, against a
// ticking clock. A Convex query cannot answer it: its result is cached until
// the data it read changes, so a tile would stay "fresh" forever.

import { nextPeriodStart, type Period } from "../periods";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type Freshness = "fresh" | "stale" | "empty";

/**
 * Whether a metric's newest figure is recent enough.
 *
 * Judged by the period the figure describes, not by when it was written: a
 * metric is stale when `staleAfterDays` have passed since its latest bucket
 * ended with nothing newer. So typing July's number in October does not make
 * the metric current, and a sync that ran today without reporting a metric
 * does not vouch for it.
 */
export function freshness(
  now: number,
  grain: Period,
  latestPeriodStart: string | null,
  staleAfterDays: number,
): Freshness {
  if (latestPeriodStart === null) return "empty";
  const ended = Date.parse(`${nextPeriodStart(grain, latestPeriodStart)}T00:00:00Z`);
  return now - ended > staleAfterDays * DAY ? "stale" : "fresh";
}

export function ageLabel(now: number, at: number): string {
  const age = now - at;
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 60 * DAY) return `${Math.floor(age / DAY)}d ago`;
  return `${Math.floor(age / (30 * DAY))}mo ago`;
}
