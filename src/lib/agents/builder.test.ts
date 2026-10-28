import { describe, expect, test } from "vitest";
import { budgetOf, durationWords, toolCallWords, utcWords, wholeOf } from "./builder";

describe("the builder's words", () => {
  test("a run's length", () => {
    expect(durationWords(850)).toBe("850 ms");
    expect(durationWords(4_200)).toBe("4.2 s");
    expect(durationWords(180_000)).toBe("3 min");
    expect(durationWords(7_500_000)).toBe("2 h 5 min");
    expect(durationWords(7_200_000)).toBe("2 h");
  });

  test("a tool call, with its approval", () => {
    expect(toolCallWords({ toolId: "claim.note", status: "skipped", approval: "pending" })).toBe(
      "claim.note: not run, waiting for approval",
    );
    expect(toolCallWords({ toolId: "policy.search", status: "ok" })).toBe("policy.search: ran");
  });

  test("a schedule's time, in UTC", () => {
    expect(utcWords(Date.parse("2026-10-19T06:00:00Z"))).toBe("Mon 19 Oct, 06:00 UTC");
  });

  test("numbers typed", () => {
    expect(wholeOf(" 12 ")).toBe(12);
    expect(wholeOf("1.5")).toBeNull();
    expect(budgetOf("")).toBeUndefined();
    expect(budgetOf("25.5")).toBe(25.5);
    expect(budgetOf("lots")).toBeNaN();
  });
});
