import { describe, expect, test } from "vitest";
import { dealsCreated, dealsCreatedSentence, dealsCreatedWindow, type DealCounts } from "./created";

const counts = (us: [number, number], kz: [number, number]): DealCounts => ({
  us: { native: us[0], mirrored: us[1] },
  kz: { native: kz[0], mirrored: kz[1] },
});

describe("dealsCreatedWindow", () => {
  test("the four weeks that have ended, Monday to Monday in UTC", () => {
    // Wednesday 14 October 2026: this week began on Monday the 12th.
    expect(dealsCreatedWindow(Date.UTC(2026, 9, 14, 9))).toEqual({
      from: Date.UTC(2026, 8, 14),
      to: Date.UTC(2026, 9, 12),
    });
  });

  test("it does not move within a week, so the queries it feeds keep their arguments", () => {
    const monday = dealsCreatedWindow(Date.UTC(2026, 9, 12, 0, 0, 0));
    const sunday = dealsCreatedWindow(Date.UTC(2026, 9, 18, 23, 59, 59));
    expect(sunday).toEqual(monday);
    expect(dealsCreatedWindow(Date.UTC(2026, 9, 19)).to).toBe(Date.UTC(2026, 9, 19));
  });
});

describe("dealsCreated", () => {
  test("what was created since the window opened, less the week in progress", () => {
    const sinceFrom = counts([5, 0], [0, 7]);
    const sinceTo = counts([2, 0], [0, 3]);
    expect(dealsCreated(sinceFrom, sinceTo)).toEqual({ total: 7, us: 3, kz: 4, kzMirrored: 4 });
  });

  test("native and mirrored deals both count toward a market", () => {
    expect(dealsCreated(counts([1, 2], [3, 4]), counts([0, 0], [0, 0]))).toEqual({
      total: 10,
      us: 3,
      kz: 7,
      kzMirrored: 4,
    });
  });

  test("two reads a moment apart never give a negative count", () => {
    // A deal archived between the two answers can leave the later count higher.
    expect(dealsCreated(counts([1, 0], [0, 0]), counts([2, 0], [0, 1]))).toEqual({
      total: 0,
      us: 0,
      kz: 0,
      kzMirrored: 0,
    });
  });
});

describe("dealsCreatedSentence", () => {
  test("the count, then each market", () => {
    expect(dealsCreatedSentence({ total: 7, us: 3, kz: 4, kzMirrored: 4 })).toBe(
      "7 deals created in the last four weeks: 3 US, 4 Kazakhstan.",
    );
  });

  test("one deal is singular", () => {
    expect(dealsCreatedSentence({ total: 1, us: 1, kz: 0, kzMirrored: 0 })).toBe(
      "1 deal created in the last four weeks: 1 US, 0 Kazakhstan.",
    );
  });

  test("none is said in words", () => {
    expect(dealsCreatedSentence({ total: 0, us: 0, kz: 0, kzMirrored: 0 })).toBe(
      "No deals created in the last four weeks.",
    );
  });
});
