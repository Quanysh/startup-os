import { describe, expect, test } from "vitest";
import type { Point } from "./derive";
import {
  activationRate,
  activationSettled,
  clinicRows,
  visitorToSignup,
  weekReadWhole,
  weekSpan,
  weeksBefore,
} from "./product";

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const points = (...pairs: [string, number][]): Point[] =>
  pairs.map(([periodStart, value]) => ({ periodStart, value }));

// The week in progress began on Monday, October 12.
const CURRENT = "2026-10-12";
// PostHog's Monday-morning run, six hours into the new week.
const READ = at("2026-10-12") + 6 * 60 * 60 * 1000;

const SIGNUPS = points(
  ["2026-09-07", 10],
  ["2026-09-14", 8],
  ["2026-09-21", 10],
  ["2026-09-28", 12],
  ["2026-10-05", 9],
);
const ACTIVATED = points(
  ["2026-09-07", 4],
  ["2026-09-14", 2],
  ["2026-09-21", 4],
  ["2026-09-28", 6],
  ["2026-10-05", 1],
);
const VISITORS = points(
  ["2026-09-14", 200],
  ["2026-09-21", 250],
  ["2026-09-28", 300],
  ["2026-10-05", 250],
);

describe("weeksBefore", () => {
  test("the weeks that end where the given one starts, oldest first", () => {
    expect(weeksBefore(CURRENT, 4)).toEqual([
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
  });
});

describe("weekReadWhole", () => {
  test("a week is whole once a run finished at or after its end", () => {
    expect(weekReadWhole("2026-10-05", at("2026-10-12"))).toBe(true);
    expect(weekReadWhole("2026-10-05", at("2026-10-12") - 1)).toBe(false);
  });

  test("never, when no run has succeeded", () => {
    expect(weekReadWhole("2026-10-05", null)).toBe(false);
  });
});

describe("activationSettled", () => {
  test("a signup week has settled once a run finished seven days after it ended", () => {
    expect(activationSettled("2026-09-28", at("2026-10-12"))).toBe(true);
    expect(activationSettled("2026-09-28", at("2026-10-12") - 1)).toBe(false);
    // Last week's signups still have days left to activate.
    expect(activationSettled("2026-10-05", READ)).toBe(false);
  });

  test("never, when no run has succeeded", () => {
    expect(activationSettled("2026-09-28", null)).toBe(false);
  });
});

describe("activationRate", () => {
  test("activated over signups, added up across the four settled weeks", () => {
    expect(activationRate(SIGNUPS, ACTIVATED, CURRENT, READ)).toEqual({
      kind: "value",
      percent: 40,
      numerator: 16,
      denominator: 40,
      from: "2026-09-07",
      to: "2026-09-28",
      weeks: 4,
      expected: 4,
    });
  });

  test("last week's signups are left out however good the read: they have not had seven days", () => {
    const rate = activationRate(SIGNUPS, ACTIVATED, CURRENT, at("2026-10-18"));
    expect(rate).toMatchObject({ denominator: 40, to: "2026-09-28" });
  });

  test("a cohort PostHog last read before it settled is left out", () => {
    // The last good run was Sunday: the week of September 28 had six days.
    const rate = activationRate(SIGNUPS, ACTIVATED, CURRENT, at("2026-10-11"));
    expect(rate).toMatchObject({
      kind: "value",
      numerator: 10,
      denominator: 28,
      to: "2026-09-21",
      weeks: 3,
      expected: 4,
    });
  });

  test("with no successful run on record, no week counts", () => {
    expect(activationRate(SIGNUPS, ACTIVATED, CURRENT, null)).toEqual({
      kind: "none",
      reason: "no_complete_week",
    });
  });

  test("a week missing one of its two figures is skipped, not counted as zero", () => {
    const short = ACTIVATED.filter((p) => p.periodStart !== "2026-09-14");
    expect(activationRate(SIGNUPS, short, CURRENT, READ)).toMatchObject({
      numerator: 14,
      denominator: 32,
      weeks: 3,
    });
  });

  test("the week in progress never counts, whatever is stored for it", () => {
    const stray = (series: Point[]) => [...series, { periodStart: CURRENT, value: 1_000 }];
    expect(activationRate(stray(SIGNUPS), stray(ACTIVATED), CURRENT, at("2026-12-01"))).toMatchObject({
      numerator: 16,
      denominator: 40,
    });
  });

  test("weeks with nobody signing up have no rate, and say which weeks", () => {
    const none = SIGNUPS.map((p) => ({ ...p, value: 0 }));
    expect(activationRate(none, none, CURRENT, READ)).toEqual({
      kind: "empty",
      from: "2026-09-07",
      to: "2026-09-28",
    });
  });

  test("more activated than signed up is reported, not divided", () => {
    const more = ACTIVATED.map((p) => ({ ...p, value: 50 }));
    expect(activationRate(SIGNUPS, more, CURRENT, READ)).toMatchObject({
      kind: "impossible",
      numerator: 200,
      denominator: 40,
    });
  });

  test("nothing stored yet", () => {
    expect(activationRate([], [], CURRENT, READ)).toEqual({ kind: "none", reason: "no_data" });
  });
});

describe("visitorToSignup", () => {
  test("signups over visitors, added up across the four weeks before this one", () => {
    const rate = visitorToSignup(VISITORS, SIGNUPS, CURRENT, READ);
    expect(rate).toMatchObject({
      kind: "value",
      numerator: 39,
      denominator: 1_000,
      from: "2026-09-14",
      to: "2026-10-05",
      weeks: 4,
      expected: 4,
    });
    expect(rate.kind === "value" && rate.percent).toBeCloseTo(3.9, 10);
  });

  test("a week PostHog last read before it ended is left out", () => {
    expect(visitorToSignup(VISITORS, SIGNUPS, CURRENT, at("2026-10-11"))).toMatchObject({
      numerator: 30,
      denominator: 750,
      to: "2026-09-28",
      weeks: 3,
    });
  });

  test("with no successful run on record, no week counts", () => {
    expect(visitorToSignup(VISITORS, SIGNUPS, CURRENT, null)).toEqual({
      kind: "none",
      reason: "no_complete_week",
    });
  });

  test("no visitors at all has no rate", () => {
    const none = VISITORS.map((p) => ({ ...p, value: 0 }));
    const zero = SIGNUPS.map((p) => ({ ...p, value: 0 }));
    expect(visitorToSignup(none, zero, CURRENT, READ)).toEqual({
      kind: "empty",
      from: "2026-09-14",
      to: "2026-10-05",
    });
  });

  test("more signups than visitors means visits are being missed", () => {
    const few = VISITORS.map((p) => ({ ...p, value: 2 }));
    expect(visitorToSignup(few, SIGNUPS, CURRENT, READ)).toMatchObject({
      kind: "impossible",
      numerator: 39,
      denominator: 8,
    });
  });

  test("nothing stored yet", () => {
    expect(visitorToSignup([], [], CURRENT, READ)).toEqual({ kind: "none", reason: "no_data" });
  });
});

describe("weekSpan", () => {
  test("from the first week's Monday to the last week's Sunday", () => {
    expect(weekSpan("2026-09-07", "2026-09-28")).toBe("Sep 7–Oct 4");
  });

  test("one week is its seven days", () => {
    expect(weekSpan("2026-10-05", "2026-10-05")).toBe("Oct 5–Oct 11");
  });
});

describe("clinicRows", () => {
  test("each month's two counts, oldest first, null where there is no figure", () => {
    const active = points(["2026-09-01", 30], ["2026-10-01", 32]);
    const using = points(["2026-10-01", 5]);
    expect(clinicRows(active, using)).toEqual([
      { periodStart: "2026-09-01", values: { active: 30, using: null } },
      { periodStart: "2026-10-01", values: { active: 32, using: 5 } },
    ]);
  });

  test("nothing stored is no rows", () => {
    expect(clinicRows([], [])).toEqual([]);
  });
});
