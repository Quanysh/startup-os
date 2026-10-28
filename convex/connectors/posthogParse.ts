// PostHog's query answers turned into snapshot rows. Pure: no fetch, no
// clock, so it is tested against fixtures.
//
// Everything PostHog sends here is a number. The queries are written so that
// each row is a week's number followed by counts, and a row is read by
// position: the column names and types in the answer are strings PostHog
// chose, and nothing it chose may reach a stored row or a logged message.

import { z } from "zod";
import type { SnapshotInput } from "../lib/snapshotRules";
import { FIRST_MONDAY_SECONDS, WEEK_SECONDS, msOfDay, weekStartOfIndex } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { expectShape } from "./shape";

const WHO = "PostHog";

/** The three questions asked, by the name the run log uses for each. */
export type Question = "visits" | "searches" | "signups";

/**
 * When a signup counts as activated: one of the person's searches fell at or
 * after the moment they signed up and before seven days after it.
 *
 * Not "their first search ever": a guest searches, meets the cap, then signs
 * up, and signing in merges the guest's history into the person. Counting a
 * search from before the signup would call nearly every signup activated.
 */
export const ACTIVATED_IF =
  "arrayExists(t -> t >= signed_up AND t < signed_up + toIntervalDay(7), searches)";

/**
 * The HogQL for each question, over the weeks given (oldest first, all of
 * them ended). Weeks are cut by arithmetic on the Unix timestamp: week 0
 * began on Monday 1970-01-05, so the result does not depend on the PostHog
 * project's timezone or on which day a calendar function starts a week.
 *
 * The only things interpolated are whole numbers computed here.
 */
export function queries(weeks: readonly string[]): Record<Question, string> {
  const first = weeks[0];
  const last = weeks.at(-1);
  if (first === undefined || last === undefined) throw new ConnectorError("No week was asked for.");
  const from = msOfDay(first) / 1000;
  const to = msOfDay(last) / 1000 + WEEK_SECONDS;
  const week = (column: string) =>
    `intDiv(toUnixTimestamp(${column}) - ${FIRST_MONDAY_SECONDS}, ${WEEK_SECONDS}) AS week`;
  const within = (column: string) =>
    `${column} >= toDateTime(${from}) AND ${column} < toDateTime(${to})`;
  const tail = "GROUP BY week ORDER BY week LIMIT 1000";

  return {
    visits: [
      `SELECT ${week("timestamp")}, count(DISTINCT person_id) AS visitors`,
      `FROM events WHERE event = '$pageview' AND ${within("timestamp")}`,
      tail,
    ].join(" "),
    searches: [
      `SELECT ${week("timestamp")}, count() AS searches, count(DISTINCT person_id) AS people`,
      `FROM events WHERE event = 'insights_search' AND ${within("timestamp")}`,
      tail,
    ].join(" "),
    // One row per person first: when they first signed in, and when each of
    // their searches was made. A person with no search has an empty list,
    // and nothing in an empty list passes the test.
    signups: [
      `SELECT ${week("signed_up")}, count() AS signups,`,
      `countIf(${ACTIVATED_IF}) AS activated`,
      "FROM (SELECT person_id,",
      "minIf(timestamp, event = '$identify') AS signed_up,",
      "countIf(event = '$identify') AS identified,",
      "groupArrayIf(timestamp, event = 'insights_search') AS searches",
      "FROM events WHERE event IN ('$identify', 'insights_search') GROUP BY person_id)",
      `WHERE identified > 0 AND ${within("signed_up")}`,
      tail,
    ].join(" "),
  };
}

const answer = z.object({
  results: z.array(z.array(z.unknown())),
  hasMore: z.boolean().nullish(),
  error: z.unknown().optional(),
});

/** A cell as a whole number of zero or more, or null when it is anything else. */
function wholeNumber(cell: unknown): number | null {
  if (typeof cell === "number") return Number.isSafeInteger(cell) && cell >= 0 ? cell : null;
  // A 64-bit count can arrive as a string of digits.
  if (typeof cell === "string" && /^\d{1,15}$/.test(cell)) return Number(cell);
  return null;
}

/**
 * One question's answer as counts by week. `counts` is how many numbers
 * follow the week in each row. Every refusal is in this file's own words and
 * names the question, never what came back.
 */
export function parseWeekly(
  raw: unknown,
  question: Question,
  counts: number,
  weeks: readonly string[],
): Map<string, number[]> {
  const body = expectShape(answer, raw, WHO, question);
  if (body.error !== undefined && body.error !== null) {
    throw new ConnectorError(`PostHog reported an error for ${question}.`);
  }
  // A result that stops early is part of an answer, and part is not written.
  if (body.hasMore === true) {
    throw new ConnectorError(`PostHog's ${question} result was cut short.`);
  }

  const asked = new Set(weeks);
  const byWeek = new Map<string, number[]>();
  for (const row of body.results) {
    const cells = row.map(wholeNumber);
    if (row.length !== counts + 1 || cells.some((cell) => cell === null)) {
      throw new ConnectorError(`PostHog's ${question} result has a row that is not whole numbers.`);
    }
    const [index, ...values] = cells as number[];
    const week = weekStartOfIndex(index!);
    // Only closed weeks are asked for, so this also keeps the week in
    // progress out of the store whatever PostHog sends.
    if (!asked.has(week)) {
      throw new ConnectorError(`PostHog's ${question} result has a week that was not asked for.`);
    }
    if (byWeek.has(week)) {
      throw new ConnectorError(`PostHog's ${question} result lists a week twice.`);
    }
    byWeek.set(week, values);
  }
  return byWeek;
}

/**
 * Snapshot rows for the weeks asked for, from the first week in which any
 * question shows anything. From there on a week with no row is a zero: all
 * three questions were answered in full, so silence about a week is PostHog
 * saying nothing happened. Before it, nothing is written, because "nothing"
 * there means the product or the tracking did not exist yet. With no row
 * from any question the result is empty, which the runner records as a
 * failed read.
 */
export function toSnapshots(input: {
  weeks: readonly string[];
  visits: ReadonlyMap<string, number[]>;
  searches: ReadonlyMap<string, number[]>;
  signups: ReadonlyMap<string, number[]>;
}): SnapshotInput[] {
  const first = input.weeks.find(
    (week) => input.visits.has(week) || input.searches.has(week) || input.signups.has(week),
  );
  if (first === undefined) return [];

  // Every field but the number and the date is a literal written here.
  const row = (key: string, week: string, value: number): SnapshotInput => ({
    key,
    scope: "startup_insights",
    period: "week",
    periodStart: week,
    value,
  });

  const rows: SnapshotInput[] = [];
  for (const week of input.weeks.filter((w) => w >= first)) {
    const [visitors = 0] = input.visits.get(week) ?? [];
    const [searches = 0, people = 0] = input.searches.get(week) ?? [];
    const [signups = 0, activated = 0] = input.signups.get(week) ?? [];
    if (activated > signups) {
      throw new ConnectorError("PostHog reports more activated signups than signups in a week.");
    }
    if (people > searches) {
      throw new ConnectorError("PostHog reports more people searching than searches in a week.");
    }
    rows.push(
      row("web_visitors", week, visitors),
      row("searches", week, searches),
      row("weekly_active_users", week, people),
      row("signups", week, signups),
      row("signups_activated", week, activated),
    );
  }
  return rows;
}
