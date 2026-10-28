import { describe, expect, test } from "vitest";
import { periodStart } from "./periods";
import {
  DEFAULT_SYNC_WEEKS,
  FIRST_MONDAY_MS,
  FIRST_MONDAY_SECONDS,
  WEEK_MS,
  WEEK_SECONDS,
  closedWeeks,
  msOfDay,
  syncWeeks,
  weekIndex,
  weekStartOfIndex,
} from "./weeks";

const DAY = 24 * 60 * 60 * 1000;
// A Wednesday.
const NOW = Date.UTC(2026, 9, 14, 6, 10);

describe("weekIndex", () => {
  test("week 0 starts on the first Monday after the epoch", () => {
    expect(weekIndex(Date.UTC(1970, 0, 5))).toBe(0);
    expect(weekIndex(Date.UTC(1970, 0, 5) - 1)).toBe(-1);
    expect(weekIndex(Date.UTC(1970, 0, 12))).toBe(1);
  });

  test("a Monday's first millisecond belongs to its own week", () => {
    const monday = Date.UTC(2026, 9, 12);
    expect(weekStartOfIndex(weekIndex(monday))).toBe("2026-10-12");
    expect(weekStartOfIndex(weekIndex(monday - 1))).toBe("2026-10-05");
  });

  test("agrees with periodStart('week') on every day of three weeks", () => {
    for (let day = 0; day < 21; day++) {
      const at = Date.UTC(2026, 8, 28) + day * DAY + 13 * 60 * 60 * 1000;
      expect(weekStartOfIndex(weekIndex(at)), String(day)).toBe(periodStart("week", at));
    }
  });

  test("the constants PostHog's query uses are the same week in seconds", () => {
    expect(FIRST_MONDAY_SECONDS * 1000).toBe(FIRST_MONDAY_MS);
    expect(WEEK_SECONDS * 1000).toBe(WEEK_MS);
  });
});

describe("msOfDay", () => {
  test("midnight UTC of the day", () => {
    expect(msOfDay("2026-10-05")).toBe(Date.UTC(2026, 9, 5));
  });
});

describe("closedWeeks", () => {
  test("the weeks that have ended, oldest first, never the one in progress", () => {
    expect(closedWeeks(NOW, 3)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  test("at Monday 00:00 the week that just ended is closed, and the new one is not listed", () => {
    expect(closedWeeks(Date.UTC(2026, 9, 12), 1)).toEqual(["2026-10-05"]);
    expect(closedWeeks(Date.UTC(2026, 9, 12) - 1, 1)).toEqual(["2026-09-28"]);
  });
});

describe("syncWeeks", () => {
  test("a plain run reads the last eight closed weeks", () => {
    const weeks = syncWeeks(NOW, undefined);
    expect(weeks).toHaveLength(DEFAULT_SYNC_WEEKS);
    expect(weeks[0]).toBe("2026-08-17");
    expect(weeks.at(-1)).toBe("2026-10-05");
  });

  test("a thirteen-month backfill is fifty-seven weeks", () => {
    const weeks = syncWeeks(NOW, 13);
    expect(weeks).toHaveLength(57);
    expect(weeks[0]).toBe("2025-09-08");
    expect(weeks.at(-1)).toBe("2026-10-05");
  });

  test("a silly number of months is made safe", () => {
    expect(syncWeeks(NOW, 500)).toHaveLength(57);
    expect(syncWeeks(NOW, Number.NaN)).toHaveLength(57);
    expect(syncWeeks(NOW, 0.4)).toHaveLength(5);
  });
});
