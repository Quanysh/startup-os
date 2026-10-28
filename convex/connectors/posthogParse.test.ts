import { describe, expect, test } from "vitest";
import { validateSnapshots } from "../lib/snapshotRules";
import { closedWeeks, msOfDay } from "../lib/weeks";
import { ConnectorError } from "./errors";
import {
  SEARCHES,
  SEVEN_DAYS,
  SIGNUPS,
  VISITS,
  W,
  activatedBy,
  reply,
} from "./posthog.fixtures";
import { ACTIVATED_IF, parseWeekly, queries, toSnapshots } from "./posthogParse";

// A Wednesday: the week in progress began on Monday, October 12.
const NOW = Date.UTC(2026, 9, 14, 6, 10);
const WEEKS = closedWeeks(NOW, 8);

/** What a refused answer threw. */
function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("queries", () => {
  const q = queries(WEEKS);
  const all = [q.visits, q.searches, q.signups];

  test("ask from the first week wanted and stop where the week in progress begins", () => {
    const from = msOfDay("2026-08-17") / 1000;
    const to = msOfDay("2026-10-12") / 1000;
    expect(q.visits).toContain(`timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${to})`);
    expect(q.searches).toContain(`timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${to})`);
    // Signups are placed by when the person signed up, not by any one event.
    expect(q.signups).toContain(`signed_up >= toDateTime(${from}) AND signed_up < toDateTime(${to})`);
  });

  test("cut weeks by arithmetic on the timestamp, not by a calendar function", () => {
    for (const query of all) {
      expect(query).toContain("intDiv(toUnixTimestamp(");
      expect(query).toContain(" - 345600, 604800) AS week");
      expect(query).not.toMatch(/toStartOfWeek|toMonday|toDate\(/);
    }
  });

  test("name only the events this codebase chose", () => {
    expect(q.visits).toContain("event = '$pageview'");
    expect(q.searches).toContain("event = 'insights_search'");
    expect(q.signups).toContain("event IN ('$identify', 'insights_search')");
  });

  test("a signup is a first sign-in", () => {
    expect(q.signups).toContain("minIf(timestamp, event = '$identify') AS signed_up");
    expect(q.signups).toContain("identified > 0");
  });

  test("activated means a search at or after signing up and before seven days after it", () => {
    expect(ACTIVATED_IF).toBe(
      "arrayExists(t -> t >= signed_up AND t < signed_up + toIntervalDay(7), searches)",
    );
    expect(q.signups).toContain(`countIf(${ACTIVATED_IF}) AS activated`);
    expect(q.signups).toContain("groupArrayIf(timestamp, event = 'insights_search') AS searches");
    // A guest's searches are merged into the person at sign-in, so "the first
    // search ever" would make nearly every signup an activated one.
    expect(q.signups).not.toMatch(/first_search|minIf\(timestamp, event = 'insights_search'\)/);
  });

  describe("the rule that predicate states", () => {
    const signedUp = Date.UTC(2026, 9, 6, 12) / 1000;
    const HOUR = 60 * 60;

    test("a person who searched only before signing up is not activated", () => {
      expect(activatedBy(signedUp, [signedUp - 3 * HOUR, signedUp - 1])).toBe(false);
    });

    test("a person who searched before and after signing up is activated", () => {
      expect(activatedBy(signedUp, [signedUp - 3 * HOUR, signedUp + HOUR])).toBe(true);
    });

    test("the moment of signing up counts; seven days later does not", () => {
      expect(activatedBy(signedUp, [signedUp])).toBe(true);
      expect(activatedBy(signedUp, [signedUp + SEVEN_DAYS - 1])).toBe(true);
      expect(activatedBy(signedUp, [signedUp + SEVEN_DAYS])).toBe(false);
    });

    test("a person who never searched is not activated", () => {
      expect(activatedBy(signedUp, [])).toBe(false);
    });
  });

  test("each carries its own row limit, above the fifty-seven weeks of a backfill", () => {
    for (const query of all) expect(query).toMatch(/LIMIT 1000$/);
  });

  test("with no week to ask for there is nothing to ask", () => {
    expect(refusal(() => queries([])).message).toBe("No week was asked for.");
  });
});

describe("parseWeekly", () => {
  test("reads each row by position: the week, then its counts", () => {
    expect([...parseWeekly(SEARCHES, "searches", 2, WEEKS)]).toEqual([
      ["2026-09-21", [300, 40]],
      ["2026-09-28", [410, 55]],
      ["2026-10-05", [380, 50]],
    ]);
  });

  test("whole numbers sent as strings are read too", () => {
    const sent = reply([[String(W("2026-10-05")), "90"]]);
    expect([...parseWeekly(sent, "visits", 1, WEEKS)]).toEqual([["2026-10-05", [90]]]);
  });

  test("an answer with no rows is an empty map, not an error", () => {
    expect(parseWeekly(reply([]), "visits", 1, WEEKS).size).toBe(0);
  });

  test("an error inside a 200 fails, and is not quoted", () => {
    const sent = { ...VISITS, error: "Unknown function near properties.$secret_plan" };
    const error = refusal(() => parseWeekly(sent, "visits", 1, WEEKS));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("PostHog reported an error for visits.");
  });

  test("an answer that was cut short is not a whole answer", () => {
    const error = refusal(() => parseWeekly({ ...VISITS, hasMore: true }, "visits", 1, WEEKS));
    expect(error.message).toBe("PostHog's visits result was cut short.");
  });

  test.each([
    ["text where a number belongs", [["$pageview_secret_property", 5]]],
    ["a fraction", [[W("2026-10-05"), 1.5]]],
    ["a negative", [[W("2026-10-05"), -1]]],
    ["a null", [[W("2026-10-05"), null]]],
    ["too few cells", [[W("2026-10-05")]]],
    ["too many cells", [[W("2026-10-05"), 1, 2]]],
  ])("a row with %s is refused, without quoting it", (_name, rows) => {
    const error = refusal(() => parseWeekly(reply(rows), "visits", 1, WEEKS));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("PostHog's visits result has a row that is not whole numbers.");
  });

  test("the week in progress, or any week not asked for, is refused", () => {
    const sent = reply([[W("2026-10-12"), 5]]);
    expect(refusal(() => parseWeekly(sent, "visits", 1, WEEKS)).message).toBe(
      "PostHog's visits result has a week that was not asked for.",
    );
  });

  test("a week listed twice is refused rather than added up or overwritten", () => {
    const sent = reply([
      [W("2026-10-05"), 5],
      [W("2026-10-05"), 7],
    ]);
    expect(refusal(() => parseWeekly(sent, "visits", 1, WEEKS)).message).toBe(
      "PostHog's visits result lists a week twice.",
    );
  });

  test("a response in another shape is refused, naming where", () => {
    expect(refusal(() => parseWeekly({ data: [] }, "visits", 1, WEEKS)).message).toBe(
      "PostHog's visits response is not in the expected shape (results).",
    );
  });
});

describe("toSnapshots", () => {
  const maps = () => ({
    weeks: WEEKS,
    visits: parseWeekly(VISITS, "visits", 1, WEEKS),
    searches: parseWeekly(SEARCHES, "searches", 2, WEEKS),
    signups: parseWeekly(SIGNUPS, "signups", 2, WEEKS),
  });
  const lines = (rows: ReturnType<typeof toSnapshots>) =>
    rows.map((r) => `${r.key} ${r.periodStart} ${r.value}`).sort();

  test("five figures a week, and a week PostHog sent no row for is a zero", () => {
    expect(lines(toSnapshots(maps()))).toEqual([
      "searches 2026-09-21 300",
      "searches 2026-09-28 410",
      "searches 2026-10-05 380",
      "signups 2026-09-21 10",
      "signups 2026-09-28 12",
      "signups 2026-10-05 0",
      "signups_activated 2026-09-21 4",
      "signups_activated 2026-09-28 6",
      "signups_activated 2026-10-05 0",
      "web_visitors 2026-09-21 120",
      "web_visitors 2026-09-28 150",
      "web_visitors 2026-10-05 90",
      "weekly_active_users 2026-09-21 40",
      "weekly_active_users 2026-09-28 55",
      "weekly_active_users 2026-10-05 50",
    ]);
  });

  test("weeks before the first sign of life are not written as zeros", () => {
    const written = new Set(toSnapshots(maps()).map((r) => r.periodStart));
    expect([...written].sort()).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  test("nothing from any question gives no rows, rather than eight weeks of zeros", () => {
    const none = new Map<string, number[]>();
    expect(toSnapshots({ weeks: WEEKS, visits: none, searches: none, signups: none })).toEqual([]);
  });

  test("more activated signups than signups cannot be true", () => {
    const signups = parseWeekly(reply([[W("2026-10-05"), 3, 4]]), "signups", 2, WEEKS);
    expect(refusal(() => toSnapshots({ ...maps(), signups })).message).toBe(
      "PostHog reports more activated signups than signups in a week.",
    );
  });

  test("more people searching than searches cannot be true", () => {
    const searches = parseWeekly(reply([[W("2026-10-05"), 3, 4]]), "searches", 2, WEEKS);
    expect(refusal(() => toSnapshots({ ...maps(), searches })).message).toBe(
      "PostHog reports more people searching than searches in a week.",
    );
  });

  test("every row is ours: fixed keys, one scope, and the registry accepts them", () => {
    const rows = toSnapshots(maps());
    expect(new Set(rows.map((r) => `${r.scope} ${r.period} ${String(r.currency)}`))).toEqual(
      new Set(["startup_insights week undefined"]),
    );
    expect(validateSnapshots("posthog", rows, undefined, { now: NOW })).toEqual([]);
  });
});
