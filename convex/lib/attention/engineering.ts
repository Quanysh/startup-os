// What engineering puts on the "Needs attention" list. Nothing here is
// stored, and nothing here reads a clock: a function that depends on "now"
// takes it as an argument.
//
// Counts per company (the registry's "us" and "kz" scopes), never per
// person. The rest of what the Engineering page works out stays with the page
// (src/lib/metrics/engineering.ts); these are here because the owner's agent
// reads the same list (convex/lib/mcpTools.ts).

import { COMPANIES, isCompanyId, type CompanyId } from "../company";
import { getMetric } from "../metricRegistry";
import type { Point } from "./metricDerive";
import { stuckCount, type PullRow } from "./pullFlow";
import { metricFreshness, type AttentionItem, type Tile } from "./scorecard";

/** The newest bucket of a series, whatever order it arrived in; null for an empty one. */
export const newestPoint = (points: readonly Point[]): Point | null =>
  [...points].sort((a, b) => a.periodStart.localeCompare(b.periodStart)).at(-1) ?? null;

export type Level = {
  value: number;
  /** The week it was last read in. */
  periodStart: string;
  /** Read in a week that ended longer ago than the metric allows: not known to be true today. */
  stale: boolean;
};

/**
 * One of GitHub's levels (open, failing, tracked) as last read: the newest
 * week's figure. Null where nothing was ever read, which is not a zero.
 */
export function levelOf(
  tiles: readonly Tile[],
  key: string,
  scope: string,
  now: number,
): Level | null {
  const metric = getMetric(key);
  const newest = newestPoint(
    tiles.find((tile) => tile.key === key && tile.scope === scope)?.series ?? [],
  );
  if (metric === undefined || newest === null) return null;
  return {
    value: newest.value,
    periodStart: newest.periodStart,
    stale: metricFreshness(now, metric, scope, newest.periodStart) === "stale",
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Where every "stuck" count leads: the Engineering page's list, stuck ones only. */
export const STUCK_HREF = "/engineering?stuck=1";
/** The words every summary uses for the count: "N pull requests stuck". */
export const stuckWords = (n: number) => `${n} pull ${plural(n, "request", "requests")} stuck`;

/** The pull requests in view: the companies the page shows, and the list `workTools.pullRequests` sent. */
export type PullsInView = {
  companies: readonly CompanyId[];
  readAt: number | null;
  rows: readonly PullRow[];
};

/**
 * What engineering puts on the "Needs attention" list: a failing main branch
 * from the tiles the scorecard sent (the company in view's), and stuck pull
 * requests counted from the pull request list by the Engineering page's five
 * rules (`stuckCount`), the one count every summary gives. The stored
 * `prs_stuck` figure raises nothing. `pulls` is null for a viewer who was not
 * sent the list (no engineering area): no stuck line, which is not "none
 * stuck". Two lines at most per company.
 *
 * State table, for each company (first matching row wins):
 *   failing: never read, last read too long ago, or zero → no line
 *   failing, N above 0     → "N repositories have a failing main branch"  (risk)
 *   stuck: list not sent, never read, or zero            → no line
 *   stuck, N above 0       → "N pull requests stuck" → /engineering?stuck=1 (stale)
 *
 * Counts only: no repository, pull request or person is named here.
 */
export function engineeringAttention(
  tiles: readonly Tile[],
  pulls: PullsInView | null,
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const scopes = [
    ...new Set([...tiles.map((tile) => tile.scope), ...(pulls?.companies ?? [])]),
  ].filter(isCompanyId);
  for (const scope of scopes) {
    const name = COMPANIES[scope].name;
    const level = levelOf(tiles, "repos_failing", scope, now);
    const failing = level === null || level.stale ? 0 : level.value;
    if (failing > 0) {
      items.push({
        id: `engineering:failing:${scope}`,
        // Broken now, for everyone who pulls it: above what is merely waiting.
        severity: "risk",
        title: `${failing} ${plural(failing, "repository has", "repositories have")} a failing main branch`,
        detail: `${name}: the latest build on the default branch failed.`,
        href: "/engineering",
      });
    }
    const stuck =
      pulls !== null && pulls.companies.includes(scope) ? stuckCount(pulls, scope, now) : null;
    if (stuck !== null && stuck > 0) {
      items.push({
        id: `engineering:stuck:${scope}`,
        // Like a deal gone quiet: work that is waiting on someone.
        severity: "stale",
        title: stuckWords(stuck),
        detail: `${name}: held up by one of the Engineering page's five rules.`,
        href: STUCK_HREF,
      });
    }
  }
  // The caller sorts these among everything else (`sortAttention`).
  return items;
}
