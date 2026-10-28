// Vercel (where Startup Insights is deployed): production deployments by week,
// and page views when the owner has switched Web Analytics on.
//
// Stores weekly counts, never deployments: a deployment names a branch, a
// commit and its author, and the OS needs none of them.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { msOfDay, syncWeeks } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { requestJson } from "./http";
import { runConnector } from "./run";
import {
  mondayAfter,
  parseDeployments,
  parsePageviews,
  toSnapshots,
  weeklyDeploys,
  type Deployment,
} from "./vercelParse";

const API = "https://api.vercel.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * How long before the first week wanted to start listing. A deployment from
 * before the window shows the project existed then, so a quiet first week is
 * written as a zero instead of being left as a gap.
 */
const MARGIN_DAYS = 60;

// What Vercel's ids look like. They go into the query string of a request
// that carries the token, so nothing else is let through.
const VERCEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A Vercel id from the environment, or a failure that names the variable and not its value. */
function idFrom(name: "VERCEL_TEAM_ID" | "VERCEL_PROJECT_ID"): string {
  const value = process.env[name] ?? "";
  if (!VERCEL_ID.test(value)) throw new ConnectorError(`${name} is not a Vercel id.`);
  return value;
}

function get(path: string, query: Record<string, string>, what: string): Promise<unknown> {
  return requestJson({
    who: "Vercel",
    what,
    url: `${API}${path}?${new URLSearchParams(query)}`,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
      Accept: "application/json",
    },
  });
}

/** Every production deployment created since `since`, newest first, page by page. */
async function deploymentsSince(
  scope: { teamId: string; projectId: string },
  since: number,
): Promise<Deployment[]> {
  const all: Deployment[] = [];
  let until: number | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const { deployments, pagination } = parseDeployments(
      await get(
        "/v7/deployments",
        {
          ...scope,
          target: "production",
          limit: String(PAGE_SIZE),
          since: String(since),
          ...(until === null ? {} : { until: String(until) }),
        },
        "deployments",
      ),
    );
    all.push(...deployments);
    if (pagination.next === null || deployments.length === 0) return all;
    // The marker is a timestamp that goes down. One that does not would have
    // this loop read the same page until the cap.
    if (until !== null && pagination.next >= until) {
      throw new ConnectorError("Vercel's deployments paging did not move on.");
    }
    until = pagination.next;
  }
  // Stopping quietly here would understate the deploys of the oldest weeks.
  throw new ConnectorError(
    `The project has more than ${MAX_PAGES * PAGE_SIZE} production deployments in the window.`,
  );
}

export const sync = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) =>
    // `now` is the runner's clock: one per run, shared with the run record.
    runConnector(ctx, "vercel", async (now) => {
      // Weeks that have ended, and only those.
      const weeks = syncWeeks(now, args.months);
      const scope = { teamId: idFrom("VERCEL_TEAM_ID"), projectId: idFrom("VERCEL_PROJECT_ID") };

      const since = msOfDay(weeks[0]!) - MARGIN_DAYS * DAY_MS;
      const deploys = weeklyDeploys(await deploymentsSince(scope, since), weeks);
      // Not one production deployment came back, even from before the
      // window: a failed read, not silence. The runner records it as empty.
      if (deploys.length === 0) return [];

      // Page views only when the owner has said the plan includes the API.
      // Then a refusal fails the run: half a read is not written.
      const pageviews = new Map<string, number>();
      if (process.env.VERCEL_WEB_ANALYTICS === "on") {
        // One week per request, one after another: eight rows at most, so no
        // row limit can cut a week short. Asked through the Monday after the
        // week, in case `until` leaves out the day it names; the parser
        // passes over that Monday and refuses a week short of a day.
        for (const week of weeks) {
          const views = parsePageviews(
            await get(
              "/v1/query/web-analytics/visits/aggregate",
              { ...scope, by: "day", since: week, until: mondayAfter(week), limit: "100" },
              "page views",
            ),
            week,
          );
          // No day of a week listed is no figure: what is stored for it stays.
          if (views !== null) pageviews.set(week, views);
        }
      }

      return toSnapshots({ deploys, pageviews });
    }),
});
