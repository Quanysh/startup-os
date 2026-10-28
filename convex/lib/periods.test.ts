import { describe, expect, test } from "vitest";
import {
  isCanonicalPeriodStart,
  nextPeriodStart,
  periodStart,
  previousPeriodStart,
} from "./periods";

describe("periodStart", () => {
  test("day bucket is the UTC calendar date", () => {
    expect(periodStart("day", new Date("2026-10-12T23:59:59Z"))).toBe("2026-10-12");
  });

  test("day bucket ignores the local timezone of the instant", () => {
    // 01:30 in Almaty (UTC+5) on the 13th is still the 12th in UTC.
    expect(periodStart("day", new Date("2026-10-13T01:30:00+05:00"))).toBe("2026-10-12");
  });

  test("week bucket is the Monday of that week", () => {
    // 2026-10-12 is a Monday.
    expect(periodStart("week", new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
    expect(periodStart("week", new Date("2026-10-14T12:00:00Z"))).toBe("2026-10-12");
  });

  test("Sunday belongs to the week that started the previous Monday", () => {
    expect(periodStart("week", new Date("2026-10-18T23:00:00Z"))).toBe("2026-10-12");
  });

  test("week bucket crosses a month boundary", () => {
    // Thursday 2026-10-01 belongs to the week starting Monday 2026-09-28.
    expect(periodStart("week", new Date("2026-10-01T08:00:00Z"))).toBe("2026-09-28");
  });

  test("month bucket is the first of the month", () => {
    expect(periodStart("month", new Date("2026-10-31T23:59:59Z"))).toBe("2026-10-01");
  });

  test("accepts an epoch-millisecond number", () => {
    expect(periodStart("month", Date.UTC(2026, 0, 15))).toBe("2026-01-01");
  });
});

describe("isCanonicalPeriodStart", () => {
  test("any real date is a canonical day", () => {
    expect(isCanonicalPeriodStart("day", "2026-10-13")).toBe(true);
  });

  test("a week must start on a Monday", () => {
    expect(isCanonicalPeriodStart("week", "2026-10-12")).toBe(true);
    expect(isCanonicalPeriodStart("week", "2026-10-13")).toBe(false);
  });

  test("a month must start on the 1st", () => {
    expect(isCanonicalPeriodStart("month", "2026-10-01")).toBe(true);
    expect(isCanonicalPeriodStart("month", "2026-10-02")).toBe(false);
  });

  test("rejects dates that do not exist", () => {
    expect(isCanonicalPeriodStart("day", "2026-02-30")).toBe(false);
    expect(isCanonicalPeriodStart("day", "2026-13-01")).toBe(false);
  });

  test("rejects anything that is not YYYY-MM-DD", () => {
    expect(isCanonicalPeriodStart("day", "2026-10-13T00:00:00Z")).toBe(false);
    expect(isCanonicalPeriodStart("day", "13/10/2026")).toBe(false);
    expect(isCanonicalPeriodStart("day", "")).toBe(false);
  });
});

describe("previousPeriodStart", () => {
  test("steps back one day", () => {
    expect(previousPeriodStart("day", "2026-03-01")).toBe("2026-02-28");
  });

  test("steps back one week", () => {
    expect(previousPeriodStart("week", "2026-10-12")).toBe("2026-10-05");
  });

  test("steps back one month across a year boundary", () => {
    expect(previousPeriodStart("month", "2026-01-01")).toBe("2025-12-01");
  });
});

describe("nextPeriodStart", () => {
  test("steps forward one day across a month end", () => {
    expect(nextPeriodStart("day", "2026-02-28")).toBe("2026-03-01");
  });

  test("steps forward one week", () => {
    expect(nextPeriodStart("week", "2026-10-12")).toBe("2026-10-19");
  });

  test("steps forward one month across a year end", () => {
    expect(nextPeriodStart("month", "2026-12-01")).toBe("2027-01-01");
  });
});
