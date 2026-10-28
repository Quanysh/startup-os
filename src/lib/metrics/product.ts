// The product numbers nobody stores: activation rate and visitor-to-signup.
// Worked out from stored weekly snapshots at read time and never written
// back, so correcting a base value corrects everything here.
//
// Nothing here reads a clock. The caller says which week is in progress and
// when PostHog last finished a run, because a week's figure is only as whole
// as the last run that read it:
//
// - a week counts only if that run finished at or after the week ended;
// - a signup week's "activated" figure keeps rising for seven days after the
//   week ends, so it counts only if that run finished after those seven days.

import { nextPeriodStart, previousPeriodStart } from "@convex/lib/periods";
import { formatPeriod } from "@/lib/format";
import type { Point } from "./derive";
import type { MonthRow } from "./finance-rows";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** How many weeks a rate is taken over. */
export const RATE_WEEKS = 4;
/** Below these, one person moves the rate by points: no benchmark verdict. */
export const MIN_SIGNUPS_FOR_VERDICT = 20;
export const MIN_VISITORS_FOR_VERDICT = 200;

/** The `count` weeks that end where `week` starts, oldest first. */
export function weeksBefore(week: string, count: number): string[] {
  const weeks: string[] = [];
  let cursor = week;
  for (let i = 0; i < count; i++) {
    cursor = previousPeriodStart("week", cursor);
    weeks.unshift(cursor);
  }
  return weeks;
}

/**
 * Whether a source last read at `readAt` saw the whole of `week`: its last
 * successful run finished at or after the start of the next week. Never,
 * when there is no successful run on record.
 */
export function weekReadWhole(week: string, readAt: number | null): boolean {
  return readAt !== null && readAt >= dayMs(nextPeriodStart("week", week));
}

/**
 * Whether a signup week's activation figure is final: the last successful
 * run finished at least seven days after the week ended, so every signup in
 * it has had its seven days.
 */
export function activationSettled(week: string, readAt: number | null): boolean {
  const settles = nextPeriodStart("week", nextPeriodStart("week", week));
  return readAt !== null && readAt >= dayMs(settles);
}

export type Rate =
  /** Nothing has arrived, or no candidate week can be used yet. */
  | { kind: "none"; reason: "no_data" | "no_complete_week" }
  /** The weeks are there and the denominator is zero. */
  | { kind: "empty"; from: string; to: string }
  /** More on top than underneath: the figures disagree, so nothing is divided. */
  | { kind: "impossible"; numerator: number; denominator: number; from: string; to: string }
  | {
      kind: "value";
      percent: number;
      numerator: number;
      denominator: number;
      /** The first and last week used, by their Mondays. */
      from: string;
      to: string;
      /** How many of the `expected` candidate weeks were used. */
      weeks: number;
      expected: number;
    };

/**
 * `top` over `bottom`, added up across the candidate weeks that hold both
 * figures and pass `usable`. A week missing either figure is skipped: a
 * missing number is not a zero.
 */
function rate(
  top: readonly Point[],
  bottom: readonly Point[],
  candidates: readonly string[],
  usable: (week: string) => boolean,
): Rate {
  if (top.length === 0 && bottom.length === 0) return { kind: "none", reason: "no_data" };
  const tops = new Map(top.map((p) => [p.periodStart, p.value]));
  const bottoms = new Map(bottom.map((p) => [p.periodStart, p.value]));
  const used = candidates.filter((week) => tops.has(week) && bottoms.has(week) && usable(week));
  const from = used[0];
  const to = used.at(-1);
  if (from === undefined || to === undefined) return { kind: "none", reason: "no_complete_week" };

  const sum = (by: Map<string, number>) => used.reduce((total, week) => total + by.get(week)!, 0);
  const numerator = sum(tops);
  const denominator = sum(bottoms);
  if (denominator === 0) return { kind: "empty", from, to };
  if (numerator > denominator) return { kind: "impossible", numerator, denominator, from, to };
  return {
    kind: "value",
    // Multiplied first, so 16 of 40 is exactly 40.
    percent: (numerator * 100) / denominator,
    numerator,
    denominator,
    from,
    to,
    weeks: used.length,
    expected: candidates.length,
  };
}

/**
 * Of the people who signed up, the share who searched within seven days.
 * Taken over the four weeks before last week: last week's signups have not
 * had their seven days. `readAt` is when PostHog's last successful run
 * finished, null when none is on record.
 */
export function activationRate(
  signups: readonly Point[],
  activated: readonly Point[],
  currentWeek: string,
  readAt: number | null,
): Rate {
  const lastWeek = previousPeriodStart("week", currentWeek);
  return rate(activated, signups, weeksBefore(lastWeek, RATE_WEEKS), (week) =>
    activationSettled(week, readAt),
  );
}

/**
 * Signups over visitors, across the four weeks before this one. The
 * denominator is the sum of each week's visitors, so a person who visited in
 * two of the weeks is in it twice: the tile calls them "weekly visitors".
 */
export function visitorToSignup(
  visitors: readonly Point[],
  signups: readonly Point[],
  currentWeek: string,
  readAt: number | null,
): Rate {
  return rate(signups, visitors, weeksBefore(currentWeek, RATE_WEEKS), (week) =>
    weekReadWhole(week, readAt),
  );
}

/** A run of weeks by its days: the first week's Monday to the last week's Sunday. */
export function weekSpan(from: string, to: string): string {
  const sunday = new Date(dayMs(to) + 6 * DAY_MS).toISOString().slice(0, 10);
  // An en dash (U+2013), as a range takes.
  return `${formatPeriod("day", from)}–${formatPeriod("day", sunday)}`;
}

/**
 * Kazakhstan clinics by month for the chart: active clients, and clinics
 * using the product that are not active clients. The workbook counts the two
 * apart, so they pile into one bar. A month one of them has no figure for
 * carries a null, which the chart draws as a missing segment, never a zero.
 */
export function clinicRows(active: readonly Point[], using: readonly Point[]): MonthRow[] {
  const actives = new Map(active.map((p) => [p.periodStart, p.value]));
  const usings = new Map(using.map((p) => [p.periodStart, p.value]));
  return [...new Set([...actives.keys(), ...usings.keys()])].sort().map((periodStart) => ({
    periodStart,
    values: {
      active: actives.get(periodStart) ?? null,
      using: usings.get(periodStart) ?? null,
    },
  }));
}

/**
 * Weekly series side by side, one row per week any of them has, oldest first.
 * A week a series has no figure for carries a null, never a zero.
 */
export function weekRows(series: Record<string, readonly Point[]>): MonthRow[] {
  const maps = Object.entries(series).map(
    ([id, points]) => [id, new Map(points.map((p) => [p.periodStart, p.value]))] as const,
  );
  const weeks = [...new Set(maps.flatMap(([, map]) => [...map.keys()]))].sort();
  return weeks.map((periodStart) => ({
    periodStart,
    values: Object.fromEntries(maps.map(([id, map]) => [id, map.get(periodStart) ?? null])),
  }));
}
