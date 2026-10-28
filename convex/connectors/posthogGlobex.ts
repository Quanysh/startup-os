// PostHog (Globex's app, project app.globex.example.com): everything the
// Kazakhstan tabs on Product show. Read daily, and by "Refresh from PostHog".
//
// Read-only: twelve HogQL queries that aggregate inside PostHog
// (posthogGlobexQueries.ts). What comes back is numbers, ids, doctors' first
// and last names and clinics' names. A clinic's name is used once, to link
// it to its row in Customers, and is not stored; a doctor's name is stored
// on their clinic's roster (`customerDoctors`) and nowhere else. No email,
// phone or anything a doctor typed is asked for.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { appFigures, type AppFigures } from "../lib/kzAppFigures";
import { closedWeeks, syncWeeks } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { requestJson } from "./http";
import { askEverything } from "./posthogGlobexAsk";
import { FIELD_CHECKS, type Question } from "./posthogGlobexQueries";
import { runConnector } from "./run";

// The key is sent to one of these two and to nothing else, whatever
// POSTHOG_HOST says.
const HOSTS: readonly string[] = ["https://us.posthog.com", "https://eu.posthog.com"];
/** Weeks read before the first week written: four for a usual week, one for the week before. */
const LOOKBACK_WEEKS = 5;
/** The year of weeks a doctor's and a clinic's history holds, and the weeks before it. */
const HISTORY_WEEKS = 53 + LOOKBACK_WEEKS;
/** The weeks the heat map, pages, events and fields are kept for. */
const BREAKDOWN_WEEKS = 8;
/** Clinics and doctors written per call, so no one write grows too large. */
const CLINICS_A_CALL = 10;

function endpoint(): string {
  const host = process.env.POSTHOG_HOST || HOSTS[0]!;
  if (!HOSTS.includes(host)) {
    throw new ConnectorError(`POSTHOG_HOST must be ${HOSTS.join(" or ")}.`);
  }
  const project = process.env.POSTHOG_GLOBEX_PROJECT_ID ?? "";
  // It becomes part of the URL the key is sent to.
  if (!/^\d{1,12}$/.test(project)) {
    throw new ConnectorError("POSTHOG_GLOBEX_PROJECT_ID must be the project's number.");
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
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: `startup_os_globex_${question}` }),
  });
}

/** The first day of the month twelve months before the one `now` is in. */
function monthsFrom(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
}

export const sync = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let figures: AppFigures | null = null;
    let syncedAt = 0;
    let keptWeeks: string[] = [];
    return runConnector(
      ctx,
      "posthog_globex",
      async (now) => {
        syncedAt = now;
        // Finished weeks only: the week in progress is never asked for.
        const weeks = syncWeeks(now, args.months);
        const dataWeeks = closedWeeks(now, Math.max(HISTORY_WEEKS, weeks.length + LOOKBACK_WEEKS));
        const breakdownWeeks = closedWeeks(now, BREAKDOWN_WEEKS);
        keptWeeks = breakdownWeeks;
        const window = { weeks, dataWeeks, breakdownWeeks, monthsFrom: monthsFrom(now), now };
        const url = endpoint();

        const { rows } = await askEverything(window, (question, query) => ask(url, question, query));
        figures = appFigures({ weeks, dataWeeks, breakdownWeeks, fields: FIELD_CHECKS, rows });
        return figures.snapshots;
      },
      // After the numbers commit. Link each clinic to Customers first: what is
      // written for it hangs on the link. Each call overwrites its own rows.
      async () => {
        const f = figures!;
        await ctx.runMutation(internal.kzAppSync.linkClinics, {
          syncedAt,
          clinics: f.clinics.map((c) => ({
            org: c.org,
            name: c.name,
            weeks: c.weeks.length,
            actions: c.weeks.at(-1)?.actions ?? 0,
            doctors: c.weeks.at(-1)?.doctors ?? 0,
            lastActiveOn: c.weeks.at(-1)?.lastActiveOn,
          })),
        });
        for (let i = 0; i < f.clinics.length; i += CLINICS_A_CALL) {
          const part = f.clinics.slice(i, i + CLINICS_A_CALL);
          const orgs = new Set(part.map((c) => c.org));
          await ctx.runMutation(internal.kzAppSync.applyClinics, {
            syncedAt,
            clinics: part.map((c) => ({ org: c.org, weeks: c.weeks })),
            doctors: f.doctors.filter((d) => orgs.has(d.org)),
          });
        }
        for (const kind of ["hour", "page", "event", "field"] as const) {
          await ctx.runMutation(internal.kzAppSync.applyBreakdowns, {
            syncedAt,
            kind,
            // Every week kept is replaced whole, so a week with no row of a kind is emptied.
            weeks: keptWeeks,
            rows: f.breakdowns.filter((b) => b.kind === kind).map(({ weekStart, key, values }) => ({ weekStart, key, values })),
          });
        }
      },
    );
  },
});
