import { describe, expect, test } from "vitest";
import { advance, anchorDayOf } from "./recurrence";

describe("advance", () => {
  test.each([
    ["2027-03-01", "annual", undefined, "2028-03-01"],
    ["2026-12-15", "monthly", undefined, "2027-01-15"],
    ["2026-11-30", "quarterly", undefined, "2027-02-28"],
    ["2026-10-15", "quarterly", undefined, "2027-01-15"],
  ] as const)("%s, %s → %s", (date, recurrence, anchor, expected) => {
    expect(advance(date, recurrence, anchor)).toBe(expected);
  });

  test("a month-end date is clamped to the month's length", () => {
    expect(advance("2026-01-31", "monthly", 31)).toBe("2026-02-28");
  });

  test("and returns to its own day afterwards, because the anchor is remembered", () => {
    // Without the anchor, the 31st would drift to the 28th for good.
    expect(advance("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(advance("2026-03-31", "monthly", 31)).toBe("2026-04-30");
  });

  test("a leap day comes back in the next leap year", () => {
    expect(advance("2028-02-29", "annual", 29)).toBe("2029-02-28");
    expect(advance("2031-02-28", "annual", 29)).toBe("2032-02-29");
  });

  test("without an anchor, the date's own day is used", () => {
    expect(advance("2026-02-28", "monthly")).toBe("2026-03-28");
  });
});

describe("anchorDayOf", () => {
  test("the day of the month", () => {
    expect(anchorDayOf("2026-01-31")).toBe(31);
    expect(anchorDayOf("2027-03-01")).toBe(1);
  });
});
