import { describe, expect, test } from "vitest";
import { playsOf, winRateText } from "./outcomes";

describe("playsOf", () => {
  test("a win rate is worked of worked and failed; pending counts for nothing yet", () => {
    expect(
      playsOf([
        { play: "b", result: "pending" },
        { play: "a", result: "worked" },
        { play: "a", result: "failed" },
        { play: "a", result: "worked" },
      ]),
    ).toEqual([
      { play: "a", worked: 2, failed: 1, pending: 0, winRate: 2 / 3 },
      { play: "b", worked: 0, failed: 0, pending: 1, winRate: null },
    ]);
    expect(playsOf([])).toEqual([]);
  });

  test("as the page says it", () => {
    expect(winRateText(2 / 3)).toBe("67%");
    expect(winRateText(0)).toBe("0%");
    expect(winRateText(null)).toBe("–");
  });
});

test("the Bots tab's window is 30 days back, to the hour", async () => {
  const { playsSince } = await import("./outcomes");
  expect(playsSince(Date.UTC(2026, 9, 19, 10, 37))).toBe(Date.UTC(2026, 8, 19, 10));
});
