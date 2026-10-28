import { describe, expect, test } from "vitest";
import { daysBetween, localIsoDate } from "./dates";

describe("localIsoDate", () => {
  test("gives the calendar date where the user is, not the UTC date", () => {
    // Built from local parts, so this holds in any timezone: 23:30 on the
    // 12th is the 12th locally even where UTC has already rolled to the 13th.
    expect(localIsoDate(new Date(2026, 9, 12, 23, 30).getTime())).toBe("2026-10-12");
    expect(localIsoDate(new Date(2026, 9, 12, 0, 30).getTime())).toBe("2026-10-12");
  });

  test("pads single-digit months and days", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12).getTime())).toBe("2026-01-05");
  });
});

describe("daysBetween", () => {
  test("whole days from one date to another", () => {
    expect(daysBetween("2026-10-01", "2026-10-12")).toBe(11);
    expect(daysBetween("2026-10-12", "2026-10-12")).toBe(0);
  });

  test("negative when the second date is earlier", () => {
    expect(daysBetween("2026-10-12", "2026-10-01")).toBe(-11);
  });

  test("across a month end, a year end and a leap day", () => {
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
});
