import { describe, expect, test } from "vitest";
import { ageLabel, freshness } from "./freshness";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 12, 12); // 12 Oct 2026

describe("freshness", () => {
  test("empty when there is no value", () => {
    expect(freshness(NOW, "month", null, 45)).toBe("empty");
  });

  test("a figure for the current month is fresh", () => {
    expect(freshness(NOW, "month", "2026-10-01", 45)).toBe("fresh");
  });

  test("last month's figure is still fresh while this month's is not yet due", () => {
    // September ended on 1 October; 11 days later October's number is not late.
    expect(freshness(NOW, "month", "2026-09-01", 45)).toBe("fresh");
  });

  test("stale once the next figure is overdue", () => {
    // July ended on 1 August, 72 days ago: August and September are missing.
    expect(freshness(NOW, "month", "2026-07-01", 45)).toBe("stale");
  });

  test("counts from the end of the period the figure describes, not from when it was typed", () => {
    // Typing July's number today does not make the metric current.
    expect(freshness(NOW, "month", "2026-07-01", 45)).toBe("stale");
  });

  test("a daily figure goes stale a few days after its day", () => {
    expect(freshness(NOW, "day", "2026-10-11", 3)).toBe("fresh");
    expect(freshness(NOW, "day", "2026-10-07", 3)).toBe("stale");
  });

  test("a weekly figure counts from the end of its week", () => {
    // The week of 28 Sep ended on 5 Oct, 7.5 days ago.
    expect(freshness(NOW, "week", "2026-09-28", 10)).toBe("fresh");
    expect(freshness(NOW, "week", "2026-09-28", 7)).toBe("stale");
  });
});

describe("ageLabel", () => {
  test("under a minute", () => {
    expect(ageLabel(NOW, NOW - 20_000)).toBe("just now");
  });

  test("minutes, hours, days", () => {
    expect(ageLabel(NOW, NOW - 5 * 60_000)).toBe("5m ago");
    expect(ageLabel(NOW, NOW - 3 * HOUR)).toBe("3h ago");
    expect(ageLabel(NOW, NOW - 2 * DAY)).toBe("2d ago");
  });

  test("months once it is old", () => {
    expect(ageLabel(NOW, NOW - 75 * DAY)).toBe("2mo ago");
  });

  test("a timestamp slightly in the future reads as just now", () => {
    expect(ageLabel(NOW, NOW + 5_000)).toBe("just now");
  });
});
