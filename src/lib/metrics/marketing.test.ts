import { describe, expect, test } from "vitest";
import { latestSearchWeek } from "./marketing";

const THIS_WEEK = "2026-10-12";
const p = (periodStart: string, value: number) => ({ periodStart, value });

describe("latestSearchWeek", () => {
  test("clicks over impressions for the newest finished week", () => {
    expect(
      latestSearchWeek(
        [p("2026-09-21", 63), p("2026-09-28", 105)],
        [p("2026-09-21", 1260), p("2026-09-28", 2100)],
        THIS_WEEK,
      ),
    ).toEqual({ week: "2026-09-28", clicks: 105, impressions: 2100, ctrPercent: 5 });
  });

  test("nothing without both figures for the same week, or with no impressions", () => {
    expect(latestSearchWeek([p("2026-09-21", 63)], [p("2026-09-28", 2100)], THIS_WEEK)).toBeNull();
    expect(latestSearchWeek([p("2026-09-28", 0)], [p("2026-09-28", 0)], THIS_WEEK)).toBeNull();
    expect(latestSearchWeek([], [], THIS_WEEK)).toBeNull();
  });

  test("more clicks than impressions is not a rate", () => {
    expect(latestSearchWeek([p("2026-09-28", 11)], [p("2026-09-28", 10)], THIS_WEEK)).toBeNull();
  });

  test("no click on real impressions is a true zero", () => {
    expect(latestSearchWeek([p("2026-09-28", 0)], [p("2026-09-28", 40)], THIS_WEEK)).toMatchObject({
      ctrPercent: 0,
    });
  });

  test("a row for the week in progress is never used", () => {
    expect(
      latestSearchWeek(
        [p("2026-09-28", 105), p("2026-10-12", 1)],
        [p("2026-09-28", 2100), p("2026-10-12", 2)],
        THIS_WEEK,
      )?.week,
    ).toBe("2026-09-28");
  });
});
