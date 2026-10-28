import { describe, expect, test } from "vitest";
import { waitLabel, weekLine, weekSince } from "./week";

describe("a proposer's week, in words", () => {
  test("approval rate, expiries, median wait and the top reasons", () => {
    expect(
      weekLine({
        decided: 5,
        approved: 1,
        rejected: 3,
        expired: 1,
        withdrawn: 0,
        approvalRate: 0.25,
        medianDecisionMs: 2 * 3_600_000,
        topRejectReasons: [
          { code: "wrong_data", count: 2 },
          { code: "typed", count: 1 },
        ],
      }),
    ).toBe("This week: 5 decided · 25% approved · 1 expired · 2 h median to decide · top reasons: Wrong data (2), Typed reason (1).");
    expect(weekLine(undefined)).toBe("This week: nothing decided.");
  });

  test("what the proposer withdrew itself is said apart, and counts in no rate", () => {
    const base = { approved: 0, rejected: 0, expired: 0, approvalRate: null, medianDecisionMs: null, topRejectReasons: [] };
    expect(weekLine({ ...base, decided: 0, withdrawn: 2 })).toBe("This week: nothing decided · 2 withdrawn by the proposer.");
    expect(weekLine({ ...base, decided: 1, approved: 1, approvalRate: 1, withdrawn: 1 })).toBe(
      "This week: 1 decided · 100% approved · 1 withdrawn by the proposer.",
    );
  });

  test("waits and the week's start", () => {
    expect(waitLabel(90_000)).toBe("2 min");
    expect(waitLabel(5 * 3_600_000)).toBe("5 h");
    expect(waitLabel(3 * 86_400_000)).toBe("3 days");
    expect(weekSince(Date.UTC(2026, 9, 19, 10, 37))).toBe(Date.UTC(2026, 9, 12, 10));
  });
});
