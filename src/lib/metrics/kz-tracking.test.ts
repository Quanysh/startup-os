import { describe, expect, test } from "vitest";
import { costCoverage, eventHealth, trackingWarning } from "./kz-tracking";

const weeks = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const rows = (event: string, counts: (number | null)[]) =>
  counts.flatMap((count, i) => (count === null ? [] : [{ weekStart: weeks[i]!, key: event, values: { count, users: 3 } }]));

describe("tracking health", () => {
  test("silent, dropped, steady and rare; silent and dropped first", () => {
    const { rows: health } = eventHealth([
      ...rows("steady", [10, 10, 10, 10, 10, 10, 10, 11]),
      ...rows("silent", [8, 8, 8, 8, 8, 8, null, null]),
      ...rows("dropped", [20, 20, 20, 20, 20, 20, 20, 6]),
      ...rows("rare", [1, 0, 2, 1, 0, 1, 2, 1]),
      ...rows("silent a month", [7, 7, 7, 7, null, null, null, null]),
    ]);
    expect(health.map((h) => [h.event, h.state])).toEqual([
      ["silent", "silent"],
      ["silent a month", "silent"],
      ["dropped", "dropped"],
      ["steady", "ok"],
      ["rare", "rare"],
    ]);
    expect(health[0]!.lastSeen).toBe("2026-09-28");
    expect(health.find((h) => h.event === "dropped")!.usual).toBe(20);
  });

  test("AI cost recorded against results, last week", () => {
    const coverage = costCoverage([
      ...rows("intake_check_completed", [0, 0, 0, 0, 0, 0, 0, 100]),
      ...rows("intake_check_cost", [0, 0, 0, 0, 0, 0, 0, 98]),
      ...rows("globexai_check_completed", [0, 0, 0, 0, 0, 0, 0, 60]),
    ]);
    expect(coverage).toEqual([
      { label: "Intake", results: 100, costs: 98, share: 98 },
      { label: "Visits", results: 60, costs: 0, share: 0 },
    ]);
  });
});

describe("the overview's tracking warning", () => {
  test("nothing to say while every event is steady or rare", () => {
    const health = eventHealth([...rows("a", [10, 10, 10, 10, 10, 10, 10, 10]), ...rows("b", [1, 0, 2, 1, 0, 1, 0, 0])]);
    expect(trackingWarning(health.rows)).toBeNull();
  });

  test("counts silent and dropped events in one sentence", () => {
    const health = eventHealth([
      ...rows("gone", [10, 10, 10, 10, 10, 10, 0, 0]),
      ...rows("gone_too", [8, 8, 8, 8, 8, 8, 0, 0]),
      ...rows("halved", [20, 20, 20, 20, 20, 20, 20, 4]),
    ]);
    expect(trackingWarning(health.rows)).toBe(
      "2 app events went silent and 1 dropped by half or more: figures made of them may read low.",
    );
  });

  test("one of a kind is said in the singular", () => {
    expect(trackingWarning(eventHealth(rows("gone", [10, 10, 10, 10, 10, 10, 0, 0])).rows)).toBe(
      "1 app event went silent: figures made of it may read low.",
    );
    expect(trackingWarning(eventHealth(rows("halved", [20, 20, 20, 20, 20, 20, 20, 4])).rows)).toBe(
      "1 app event dropped by half or more: figures made of it may read low.",
    );
  });
});
