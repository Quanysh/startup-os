// Vercel's JSON turned into snapshot rows. Pure: no fetch, no clock, so it is
// tested against fixtures.
//
// A deployment carries a great deal (name, URL, branch, commit message,
// author). Four fields are read; zod drops the rest at the door.

import { z } from "zod";
import type { SnapshotInput } from "../lib/snapshotRules";
import { msOfDay, weekIndex, weekStartOfIndex } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { expectShape } from "./shape";

const WHO = "Vercel";

const deploymentsPage = z.object({
  deployments: z.array(
    z.object({
      uid: z.string(),
      created: z.number(),
      readyState: z.string(),
      target: z.string().nullish(),
    }),
  ),
  pagination: z.object({ next: z.number().nullable() }),
});
export type Deployment = z.infer<typeof deploymentsPage>["deployments"][number];

export function parseDeployments(raw: unknown) {
  return expectShape(deploymentsPage, raw, WHO, "deployments");
}

const weekOf = (at: number) => weekStartOfIndex(weekIndex(at));

export type WeekDeploys = { periodStart: string; ready: number; failed: number };

/**
 * Production deployments per week, by when each was created: how many became
 * ready and how many ended in an error. Anything else (cancelled, still
 * building, blocked, a state this code does not know) is in neither count,
 * and so is anything that is not a production deployment: the default is to
 * leave out, not to guess.
 *
 * Covers the weeks in `weeks` from the first week Vercel shows a production
 * deployment, counting ones from before the window: one of those shows the
 * project existed, so the window starts as zeros rather than as a gap. From
 * there on a quiet week is a zero; before it, nothing is written. With no
 * production deployment at or before the window's end, the result is empty.
 *
 * A deployment listed twice (overlapping pages) is counted once.
 */
export function weeklyDeploys(
  deployments: readonly Deployment[],
  weeks: readonly string[],
): WeekDeploys[] {
  const production = [...new Map(deployments.map((d) => [d.uid, d])).values()].filter(
    (d) => d.target === "production",
  );
  if (production.length === 0 || weeks.length === 0) return [];
  const first = production.map((d) => weekOf(d.created)).reduce((a, b) => (a < b ? a : b));

  const byWeek = new Map<string, WeekDeploys>(
    weeks
      .filter((week) => week >= first)
      .map((week) => [week, { periodStart: week, ready: 0, failed: 0 }]),
  );
  for (const d of production) {
    // Not in the map: before the window, or in the week in progress.
    const tally = byWeek.get(weekOf(d.created));
    if (!tally) continue;
    if (d.readyState === "READY") tally.ready += 1;
    else if (d.readyState === "ERROR") tally.failed += 1;
  }
  return [...byWeek.values()];
}

const visitsPage = z.object({
  data: z.array(z.object({ timestamp: z.string(), pageviews: z.number() })),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The Monday after the week starting on `monday`: where the request for it ends. */
export const mondayAfter = (monday: string) => dayOf(msOfDay(monday) + 7 * DAY_MS);

/**
 * The page views of one week, from its daily rows.
 *
 * The week is asked for through the Monday after it, because whether `until`
 * includes the day it names is not documented and a Sunday `until` could
 * lose Sunday. A row dated that Monday is passed over. Any other row dated
 * outside the week means the answer is not the one asked for.
 *
 * All seven days, Monday to Sunday, must be there: a week short of a day is
 * refused, never added up as if the day had no views. Null when no day of
 * the week is listed at all: that is no figure, not zero views.
 */
export function parsePageviews(raw: unknown, week: string): number | null {
  const after = mondayAfter(week);
  const seen = new Set<string>();
  let total = 0;
  for (const day of expectShape(visitsPage, raw, WHO, "page views").data) {
    const at = Date.parse(day.timestamp);
    if (!Number.isNaN(at) && dayOf(at) === after) continue;
    if (Number.isNaN(at) || weekOf(at) !== week) {
      throw new ConnectorError("Vercel's page views response has a day outside the week asked for.");
    }
    if (seen.has(dayOf(at))) {
      throw new ConnectorError("Vercel's page views response lists a day twice.");
    }
    seen.add(dayOf(at));
    if (!Number.isSafeInteger(day.pageviews) || day.pageviews < 0) {
      throw new ConnectorError(
        "Vercel's page views response has a count that is not a whole number.",
      );
    }
    total += day.pageviews;
  }
  if (seen.size === 0) return null;
  if (seen.size !== 7) {
    throw new ConnectorError("Vercel's page views response does not cover the whole week.");
  }
  return total;
}

export function toSnapshots(input: {
  deploys: readonly WeekDeploys[];
  /** Page views by week, only for the weeks a figure was read for. */
  pageviews: ReadonlyMap<string, number>;
}): SnapshotInput[] {
  // Every field but the number and the date is a literal written here.
  const row = (key: string, week: string, value: number): SnapshotInput => ({
    key,
    scope: "startup_insights",
    period: "week",
    periodStart: week,
    value,
  });
  return [
    ...input.deploys.map((w) => row("deploys", w.periodStart, w.ready)),
    ...input.deploys.map((w) => row("deploys_failed", w.periodStart, w.failed)),
    ...[...input.pageviews].map(([week, views]) => row("site_pageviews", week, views)),
  ];
}
