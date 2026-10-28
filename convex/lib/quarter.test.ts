import { describe, expect, test } from "vitest";
import { isQuarter, quarterOf } from "./quarter";

describe("quarterOf", () => {
  test("names the calendar quarter of a date", () => {
    expect(quarterOf(new Date("2026-10-12T00:00:00Z"))).toBe("2026-Q4");
    expect(quarterOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-Q1");
    expect(quarterOf(new Date("2026-06-30T23:59:59Z"))).toBe("2026-Q2");
  });

  test("accepts epoch milliseconds", () => {
    expect(quarterOf(Date.UTC(2026, 6, 1))).toBe("2026-Q3");
  });
});

describe("isQuarter", () => {
  test("accepts YYYY-Qn for quarters one to four", () => {
    expect(isQuarter("2026-Q4")).toBe(true);
    expect(isQuarter("2027-Q1")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isQuarter("2026-Q5")).toBe(false);
    expect(isQuarter("2026-Q0")).toBe(false);
    expect(isQuarter("Q4 2026")).toBe(false);
    expect(isQuarter("2026-q4")).toBe(false);
    expect(isQuarter("")).toBe(false);
  });
});
