// Vertical Startup's /os/health answer turned into snapshot rows. Pure: no fetch,
// and the clock is handed in, so it is tested against fixtures.
//
// The answer is counts only, by contract. This file holds it to that: a
// version it knows, an answer made just now, weeks that have ended, whole
// numbers. Anything else fails in this file's own words.

import { z } from "zod";
import { isCanonicalPeriodStart, periodStart } from "../lib/periods";
import type { SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { expectShape } from "./shape";

const WHO = "Vertical Startup";
const HOUR_MS = 60 * 60 * 1000;

/** The most weeks the contract lets the endpoint send. */
export const MAX_WEEKS = 13;

const health = z.object({
  version: z.literal(1),
  generatedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a timestamp"),
  totals: z.object({ practices: z.number() }),
  weeks: z.array(
    z.object({
      weekStart: z.string(),
      activeUsers: z.number(),
      activePractices: z.number(),
      coreActions: z.number(),
    }),
  ),
});

const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
const refuse = (what: string): never => {
  throw new ConnectorError(`Vertical Startup's health response ${what}.`);
};

/**
 * Today's practice count and three figures per closed week. `now` is the
 * run's start time.
 *
 * A zero here is written as a zero: the endpoint computed it from its own
 * data, so a quiet week is Vertical Startup saying nothing happened. A week that
 * has not ended is refused, never stored: it would hold part of a week. With
 * no week at all the result is empty, which the runner records as a failed
 * read.
 */
export function toSnapshots(raw: unknown, now: number): SnapshotInput[] {
  const body = expectShape(health, raw, WHO, "health");

  // A cached or replayed answer describes another moment. The practice
  // count below is written against today, so it has to be today's.
  if (Math.abs(now - Date.parse(body.generatedAt)) > HOUR_MS) {
    refuse("was not made in the last hour");
  }
  if (body.weeks.length > MAX_WEEKS) refuse(`lists more than ${MAX_WEEKS} weeks`);
  if (!whole(body.totals.practices)) refuse("has a count that is not a whole number");
  if (body.weeks.length === 0) return [];

  // Every field but the number and the date is a literal written here.
  const row = (key: string, period: "day" | "week", start: string, value: number): SnapshotInput => ({
    key,
    scope: "vertical_startup",
    period,
    periodStart: start,
    value,
  });

  const inProgress = periodStart("week", now);
  const seen = new Set<string>();
  const rows: SnapshotInput[] = [row("practices", "day", periodStart("day", now), body.totals.practices)];
  for (const w of body.weeks) {
    // `weekStart` is the one string Vertical Startup sends that becomes part of a
    // row. Checked here, so the registry is never handed one it would quote.
    if (!isCanonicalPeriodStart("week", w.weekStart)) {
      refuse("has a week that does not start on a Monday");
    }
    if (w.weekStart >= inProgress) refuse("includes a week that has not ended");
    if (seen.has(w.weekStart)) refuse("lists a week twice");
    seen.add(w.weekStart);
    if (!whole(w.activeUsers) || !whole(w.activePractices) || !whole(w.coreActions)) {
      refuse("has a count that is not a whole number");
    }
    rows.push(
      row("weekly_active_users", "week", w.weekStart, w.activeUsers),
      row("practices_active", "week", w.weekStart, w.activePractices),
      row("core_actions", "week", w.weekStart, w.coreActions),
    );
  }
  return rows;
}
