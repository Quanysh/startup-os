// Search Console's JSON turned into snapshot rows. Pure: no fetch, no clock.
//
// The only thing asked of Google is daily totals, so the only string in a
// response is a date. The schema accepts nothing else as a key: a response
// that carried a search term or a page URL fails by shape, unquoted. Rows are
// built from literals after the days are added into weeks.

import { z } from "zod";
import { nextPeriodStart, periodStart, previousPeriodStart } from "../lib/periods";
import type { SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { expectShape } from "./marketingShape";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, written YYYY-MM-DD. */
const date = z.string().refine((s) => {
  if (!ISO_DAY.test(s)) return false;
  const at = Date.parse(`${s}T00:00:00Z`);
  // `2026-02-30` parses and rolls over to March; the round trip catches it.
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === s;
}, "not a date");
const count = z.number().int().min(0);

const tokenAnswer = z.object({ access_token: z.string().min(1) });

const daysAnswer = z.object({
  // Google leaves `rows` out when there is nothing to report.
  rows: z
    .array(
      z.object({
        // Exactly one key, and it is a date: we group by date and nothing else.
        keys: z.tuple([date]),
        clicks: count,
        impressions: count,
        position: z.number().min(0),
      }),
    )
    .optional(),
});

export function parseToken(raw: unknown): string {
  return expectShape(tokenAnswer, raw, "Google's sign-in").access_token;
}

export type DayTotals = { date: string; clicks: number; impressions: number; position: number };

export function parseDays(raw: unknown): DayTotals[] {
  const rows = expectShape(daysAnswer, raw, "Search Console's daily totals").rows ?? [];
  return rows.map((row) => ({
    date: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position,
  }));
}

export type RequestWindow = { startDate: string; endDate: string; weekStarts: string[] };

/**
 * What to ask for: `weeks` weeks ending with the one in progress, up to today.
 * Google's dates are Pacific time and `now` is read in UTC, so "today" can be
 * a day Google has not begun; it simply has nothing for it yet.
 */
export function requestWindow(now: number, weeks: number): RequestWindow {
  const weekStarts = [periodStart("week", now)];
  while (weekStarts.length < weeks) weekStarts.unshift(previousPeriodStart("week", weekStarts[0]!));
  return { startDate: weekStarts[0]!, endDate: periodStart("day", now), weekStarts };
}

export type WeekTotals = {
  periodStart: string;
  clicks: number;
  impressions: number;
  position: number;
};

/**
 * Each finished week's clicks, impressions and average position.
 *
 * Google publishes final figures two to three days late. A week (Monday to
 * Sunday, in Google's dates) is finished when the newest day Google returned
 * is its Sunday or later; until then it is not written at all, because five
 * days of a week is not the week. Inside a finished week a day Google left
 * out had nothing to report.
 *
 * A finished week with no impressions on any day is left out too: for a site
 * that is found every week, "nothing" is far more often a short read than the
 * truth, and writing it would replace a good number with zero.
 *
 * Position is the mean over impressions, so days are weighted by theirs.
 */
export function weeklyTotals(days: readonly DayTotals[], window: RequestWindow): WeekTotals[] {
  const seen = new Set<string>();
  for (const day of days) {
    if (day.date < window.startDate || day.date > window.endDate) {
      throw new ConnectorError("Search Console returned a day outside the range asked for.");
    }
    if (seen.has(day.date)) throw new ConnectorError("Search Console returned the same day twice.");
    seen.add(day.date);
  }
  if (days.length === 0) return [];
  const finalThrough = days.map((day) => day.date).reduce((a, b) => (a > b ? a : b));

  return window.weekStarts.flatMap((weekStart) => {
    const nextWeek = nextPeriodStart("week", weekStart);
    const sunday = previousPeriodStart("day", nextWeek);
    if (sunday > finalThrough) return [];
    const own = days.filter((day) => day.date >= weekStart && day.date < nextWeek);
    const impressions = own.reduce((sum, day) => sum + day.impressions, 0);
    if (impressions === 0) return [];
    const weighted = own.reduce((sum, day) => sum + day.position * day.impressions, 0);
    return [
      {
        periodStart: weekStart,
        clicks: own.reduce((sum, day) => sum + day.clicks, 0),
        impressions,
        position: Math.round((weighted / impressions) * 100) / 100,
      },
    ];
  });
}

export function toSnapshots(weeks: readonly WeekTotals[]): SnapshotInput[] {
  const row = (key: string, week: WeekTotals, value: number): SnapshotInput => ({
    key,
    scope: "company",
    period: "week",
    periodStart: week.periodStart,
    value,
  });
  return [
    ...weeks.map((week) => row("search_clicks", week, week.clicks)),
    ...weeks.map((week) => row("search_impressions", week, week.impressions)),
    ...weeks.map((week) => row("search_position", week, week.position)),
  ];
}
