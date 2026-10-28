import { describe, expect, test } from "vitest";
import { validateSnapshots } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { DAYS, day, week } from "./searchConsole.fixtures";
import {
  parseDays,
  parseToken,
  requestWindow,
  toSnapshots,
  weeklyTotals,
} from "./searchConsoleParse";

// 07:00 UTC, Monday 12 October 2026.
const NOW = Date.UTC(2026, 9, 12, 7);
const WINDOW = requestWindow(NOW, 6);
const totals = (rows: unknown[]) => weeklyTotals(parseDays({ rows }), WINDOW);
const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

describe("parseToken", () => {
  test("returns the access token", () => {
    expect(parseToken({ access_token: "abc", token_type: "Bearer", expires_in: 3600 })).toBe("abc");
  });

  test("an answer without one is refused, in words that quote nothing", () => {
    const error = message(() =>
      parseToken({ error: "invalid_grant", error_description: "secret detail" }),
    );
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as Error).message).toBe(
      "Google's sign-in response is not in the expected shape (access_token).",
    );
  });
});

describe("parseDays", () => {
  test("keeps the date and the three figures of each day, and nothing else", () => {
    expect(parseDays({ rows: [day("2026-09-07", 10, 200, 12)] })).toEqual([
      { date: "2026-09-07", clicks: 10, impressions: 200, position: 12 },
    ]);
  });

  test("an answer with no rows at all is no days", () => {
    expect(parseDays({ responseAggregationType: "byProperty" })).toEqual([]);
  });

  test("a response in another shape is refused, naming where", () => {
    expect(() =>
      parseDays({ rows: [{ keys: ["2026-09-07"], clicks: "3", impressions: 9, position: 4 }] }),
    ).toThrow(
      "Search Console's daily totals response is not in the expected shape (rows.0.clicks).",
    );
    expect(() => parseDays({ data: [] })).not.toThrow(); // `rows` is optional: Google omits it when empty.
    expect(() => parseDays(null)).toThrow(
      "Search Console's daily totals response is not in the expected shape ().",
    );
  });

  test("a key that is not a date is refused without being quoted: no query or page is ever kept", () => {
    for (const key of ["how to bill 27447", "https://startup.test/payer/initech", "2026-02-30"]) {
      const error = message(() =>
        parseDays({ rows: [{ keys: [key], clicks: 1, impressions: 2, position: 3 }] }),
      ) as Error;
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error.message).toBe(
        "Search Console's daily totals response is not in the expected shape (rows.0.keys.0).",
      );
      expect(error.message).not.toContain(key);
    }
  });

  test("a row grouped by more than the date is refused", () => {
    expect(() =>
      parseDays({
        rows: [{ keys: ["2026-09-07", "billing software"], clicks: 1, impressions: 2, position: 3 }],
      }),
    ).toThrow("Search Console's daily totals response is not in the expected shape (rows.0.keys).");
  });

  test("half a click is not a count", () => {
    expect(() =>
      parseDays({ rows: [{ keys: ["2026-09-07"], clicks: 1.5, impressions: 2, position: 3 }] }),
    ).toThrow("(rows.0.clicks)");
  });
});

describe("requestWindow", () => {
  test("six weeks ending with the one in progress, asked for up to today", () => {
    expect(WINDOW).toEqual({
      startDate: "2026-09-07",
      endDate: "2026-10-12",
      weekStarts: ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"],
    });
  });
});

describe("weeklyTotals", () => {
  test("adds up each week Google has finished", () => {
    expect(weeklyTotals(parseDays(DAYS), WINDOW)).toEqual([
      { periodStart: "2026-09-07", clicks: 70, impressions: 1400, position: 12 },
      { periodStart: "2026-09-14", clicks: 84, impressions: 1680, position: 11.5 },
      { periodStart: "2026-09-21", clicks: 63, impressions: 1260, position: 13 },
      { periodStart: "2026-09-28", clicks: 105, impressions: 2100, position: 10 },
    ]);
  });

  test("a week is complete only when Google's newest final day reaches its Sunday", () => {
    const weekOf = (days: number) =>
      totals(week("2026-10-05", 20, 400, 9, days)).map((w) => w.periodStart);
    // Through Friday, then Saturday: five or six days of a week is not the week.
    expect(weekOf(5)).toEqual([]);
    expect(weekOf(6)).toEqual([]);
    // Through Sunday 11 October: the week is whole.
    expect(weekOf(7)).toEqual(["2026-10-05"]);
  });

  test("a later day vouches for an earlier week, whose absent days then count as nothing", () => {
    // Only three days of the week of 28 September had impressions, and Google
    // has reported 5 October: the week is finished at three days' worth.
    const rows = [...week("2026-09-28", 15, 300, 10, 3), day("2026-10-05", 1, 10, 5)];
    expect(totals(rows)).toEqual([
      { periodStart: "2026-09-28", clicks: 45, impressions: 900, position: 10 },
    ]);
  });

  test("a finished week with no impressions at all is left unwritten, never stored as zero", () => {
    const rows = [...week("2026-09-07", 10, 200, 12), ...week("2026-09-28", 15, 300, 10)];
    expect(totals(rows).map((w) => w.periodStart)).toEqual(["2026-09-07", "2026-09-28"]);
    expect(totals([day("2026-09-14", 0, 0, 0), day("2026-09-28", 1, 10, 5)])).toEqual([]);
  });

  test("the week's position is weighted by impressions, not averaged over days", () => {
    // 900 impressions at position 2 and 100 at position 22: 4, not 12.
    const rows = [
      day("2026-09-07", 9, 900, 2),
      day("2026-09-08", 1, 100, 22),
      day("2026-09-14", 1, 1, 1),
    ];
    expect(totals(rows)[0]).toEqual({
      periodStart: "2026-09-07",
      clicks: 10,
      impressions: 1000,
      position: 4,
    });
  });

  test("a day outside the range asked for fails the read", () => {
    expect(() => totals([day("2026-08-30", 1, 10, 5)])).toThrow(
      "Search Console returned a day outside the range asked for.",
    );
    expect(() => totals([day("2026-10-13", 1, 10, 5)])).toThrow(
      "Search Console returned a day outside the range asked for.",
    );
  });

  test("the same day twice fails the read rather than being counted twice", () => {
    expect(() => totals([day("2026-09-07", 1, 10, 5), day("2026-09-07", 1, 10, 5)])).toThrow(
      "Search Console returned the same day twice.",
    );
  });

  test("no days is no weeks", () => {
    expect(totals([])).toEqual([]);
  });
});

describe("toSnapshots", () => {
  const rows = toSnapshots(weeklyTotals(parseDays(DAYS), WINDOW));

  test("three rows a week that the registry accepts from search_console", () => {
    expect(rows).toHaveLength(12);
    expect(validateSnapshots("search_console", rows, undefined, { now: NOW })).toEqual([]);
    expect(rows).toContainEqual({
      key: "search_position",
      scope: "company",
      period: "week",
      periodStart: "2026-09-14",
      value: 11.5,
    });
  });

  test("every string in a row is ours: a key, a scope, a period or a date", () => {
    // The registry's messages may quote a row's strings, and those messages
    // are stored. Nothing Google chose may be among them.
    const ours = new Set(["search_clicks", "search_impressions", "search_position", "company", "week"]);
    const noisy = {
      rows: DAYS.rows.map((row) => ({
        ...row,
        page: "https://startup.test/payer/initech",
        query: "initech billing",
      })),
    };
    const built = toSnapshots(weeklyTotals(parseDays(noisy), WINDOW));
    expect(built).toHaveLength(12);
    for (const row of built) {
      for (const value of Object.values(row)) {
        if (typeof value !== "string") continue;
        expect(ours.has(value) || /^\d{4}-\d{2}-\d{2}$/.test(value), value).toBe(true);
      }
    }
    expect(JSON.stringify(built)).not.toContain("initech");
  });
});
