// PostHog (Startup Insights' product analytics): weekly visitors, signups,
// activation and searches.
//
// Stores weekly counts, never events or people: the three queries aggregate
// inside PostHog, and what comes back is a few rows of whole numbers.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { syncWeeks } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { requestJson } from "./http";
import { parseWeekly, queries, toSnapshots, type Question } from "./posthogParse";
import { runConnector } from "./run";

// The key is sent to one of these two and to nothing else, whatever
// POSTHOG_HOST says.
const HOSTS: readonly string[] = ["https://us.posthog.com", "https://eu.posthog.com"];

/** The query endpoint, or a failure in our own words that echoes no variable's value. */
function endpoint(): string {
  const host = process.env.POSTHOG_HOST || HOSTS[0]!;
  if (!HOSTS.includes(host)) {
    throw new ConnectorError(`POSTHOG_HOST must be ${HOSTS.join(" or ")}.`);
  }
  const project = process.env.POSTHOG_PROJECT_ID ?? "";
  // It becomes part of the URL the key is sent to.
  if (!/^\d{1,12}$/.test(project)) {
    throw new ConnectorError("POSTHOG_PROJECT_ID must be the project's number.");
  }
  return `${host}/api/projects/${project}/query/`;
}

function ask(url: string, question: Question, query: string): Promise<unknown> {
  return requestJson({
    who: "PostHog",
    what: question,
    url,
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // `name` only labels the query in PostHog's own log.
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: `startup_os_${question}` }),
  });
}

export const sync = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) =>
    // `now` is the runner's clock: one per run, shared with the run record.
    runConnector(ctx, "posthog", async (now) => {
      // Weeks that have ended, and only those: the week in progress is never asked for.
      const weeks = syncWeeks(now, args.months);
      const url = endpoint();
      const hogql = queries(weeks);

      // One after another: a key may run only three queries at once. Any one
      // failing throws, so the run writes all three questions or nothing.
      const visits = parseWeekly(await ask(url, "visits", hogql.visits), "visits", 1, weeks);
      const searches = parseWeekly(await ask(url, "searches", hogql.searches), "searches", 2, weeks);
      const signups = parseWeekly(await ask(url, "signups", hogql.signups), "signups", 2, weeks);

      return toSnapshots({ weeks, visits, searches, signups });
    }),
});
