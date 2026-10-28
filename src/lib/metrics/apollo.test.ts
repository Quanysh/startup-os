import { describe, expect, test } from "vitest";
import {
  IDLE_AFTER_DAYS,
  LIST_STALE_DAYS,
  MIN_WEEKS_FOR_CHART,
  idleDays,
  listAgeDays,
  newestPoint,
  rateOf,
  sequenceStatus,
  sequenceTotals,
  stageRows,
  weeklyCounts,
  type SequenceRow,
} from "./apollo";
import { MIN_DELIVERED_FOR_VERDICT } from "./gtm";

// Wednesday 14 October 2026: this week began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 9);
const DAY = 24 * 60 * 60 * 1000;

const seq = (over: Partial<SequenceRow> = {}): SequenceRow => ({
  sequenceId: "s1",
  name: "Made-up outreach",
  active: true,
  archived: false,
  steps: 7,
  createdAt: "2026-03-13",
  lastUsedAt: "2026-03-17",
  delivered: 24,
  opened: 1,
  replied: 0,
  bounced: 1,
  unsubscribed: 1,
  ...over,
});

describe("sequenceStatus: first matching row wins", () => {
  test.each([
    [{ archived: true, active: true }, "Archived", "neutral"],
    [{ archived: true, active: false }, "Archived", "neutral"],
    [{ archived: false, active: true }, "Active", "success"],
    [{ archived: false, active: false }, "Paused", "neutral"],
  ] as const)("%j is %s", (over, label, tone) => {
    expect(sequenceStatus(seq(over))).toEqual({ label, tone });
  });
});

describe("rateOf", () => {
  test("a rate is given from the page's minimum delivered", () => {
    expect(rateOf(5, MIN_DELIVERED_FOR_VERDICT)).toBe(5);
    expect(rateOf(30, 240)).toBe(12.5);
  });

  test("under it there is no rate: one reply would move it by points", () => {
    expect(rateOf(1, MIN_DELIVERED_FOR_VERDICT - 1)).toBeNull();
    expect(rateOf(1, 24)).toBeNull();
    expect(rateOf(0, 0)).toBeNull();
  });

  test("a count above delivered has no rate, never one over 100%", () => {
    expect(rateOf(300, 240)).toBeNull();
  });
});

describe("idleDays", () => {
  test(`an active sequence unused for ${IDLE_AFTER_DAYS} days or more is idle, by that many days`, () => {
    expect(idleDays(seq({ lastUsedAt: "2026-03-17" }), NOW)).toBe(211);
    expect(idleDays(seq({ lastUsedAt: "2026-09-14" }), NOW)).toBe(30);
  });

  test("one used more recently is not", () => {
    expect(idleDays(seq({ lastUsedAt: "2026-09-15" }), NOW)).toBeNull();
    expect(idleDays(seq({ lastUsedAt: "2026-10-14" }), NOW)).toBeNull();
  });

  test("a paused or archived sequence is never idle: nobody expects it to run", () => {
    expect(idleDays(seq({ active: false }), NOW)).toBeNull();
    expect(idleDays(seq({ archived: true }), NOW)).toBeNull();
  });

  test("one never used is counted from the day it was made", () => {
    expect(idleDays(seq({ lastUsedAt: undefined, createdAt: "2026-09-01" }), NOW)).toBe(43);
    expect(idleDays(seq({ lastUsedAt: undefined, createdAt: "2026-10-10" }), NOW)).toBeNull();
  });
});

describe("sequenceTotals", () => {
  test("adds the counters up", () => {
    expect(
      sequenceTotals([
        seq({ delivered: 100, opened: 40, replied: 5, bounced: 2 }),
        seq({ delivered: 50, opened: 10, replied: 1, bounced: 0 }),
      ]),
    ).toEqual({ delivered: 150, opened: 50, replied: 6, bounced: 2 });
  });
});

describe("stageRows", () => {
  const stages = [
    { entity: "contact" as const, stage: "Cold", count: 735 },
    { entity: "contact" as const, stage: "Approaching", count: 24 },
    { entity: "contact" as const, stage: "Do Not Contact", count: 1 },
    { entity: "account" as const, stage: "Cold", count: 546 },
  ];

  test("one entity's stages with each one's share of that entity's total", () => {
    const rows = stageRows(stages, "contact");
    expect(rows.map((row) => [row.stage, row.count])).toEqual([
      ["Cold", 735],
      ["Approaching", 24],
      ["Do Not Contact", 1],
    ]);
    expect(rows[0]!.share).toBeCloseTo(96.71, 2);
    expect(stageRows(stages, "account")).toEqual([{ stage: "Cold", count: 546, share: 100 }]);
  });

  test("no stages, or none with anyone in them: no share, never a division by zero", () => {
    expect(stageRows([], "contact")).toEqual([]);
    expect(stageRows([{ entity: "contact", stage: "Cold", count: 0 }], "contact")).toEqual([
      { stage: "Cold", count: 0, share: null },
    ]);
  });
});

describe("weeklyCounts", () => {
  const CURRENT = "2026-10-12";
  const points = (...list: [string, number][]) =>
    list.map(([periodStart, value]) => ({ periodStart, value }));

  test("nothing on record", () => {
    expect(weeklyCounts([], CURRENT)).toEqual({ weeks: [], lastWeek: null, newest: null, chart: false });
  });

  test(`a chart needs ${MIN_WEEKS_FOR_CHART} finished weeks: one or two are figures, not a chart`, () => {
    const one = weeklyCounts(points(["2026-10-05", 710]), CURRENT);
    expect(one.chart).toBe(false);
    expect(one.lastWeek).toEqual({ periodStart: "2026-10-05", value: 710 });
    const two = weeklyCounts(points(["2026-09-28", 0], ["2026-10-05", 710]), CURRENT);
    expect(two.chart).toBe(false);
    const three = weeklyCounts(points(["2026-09-21", 0], ["2026-09-28", 0], ["2026-10-05", 710]), CURRENT);
    expect(three.chart).toBe(true);
    expect(three.weeks.map((p) => p.periodStart)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  test("weeks of nothing but zeros are not charted: there would be no bar to see", () => {
    const zeros = weeklyCounts(points(["2026-09-21", 0], ["2026-09-28", 0], ["2026-10-05", 0]), CURRENT);
    expect(zeros.chart).toBe(false);
    expect(zeros.lastWeek).toEqual({ periodStart: "2026-10-05", value: 0 });
  });

  test("the week in progress is never one of them, whatever was stored", () => {
    const result = weeklyCounts(points(["2026-10-05", 710], ["2026-10-12", 10]), CURRENT);
    expect(result.weeks.map((p) => p.periodStart)).toEqual(["2026-10-05"]);
    expect(result.newest).toEqual({ periodStart: "2026-10-05", value: 710 });
  });

  test("with last week missing there is no figure for it: an older week is not passed off as last week", () => {
    const result = weeklyCounts(points(["2026-09-21", 3], ["2026-09-28", 5]), CURRENT);
    expect(result.lastWeek).toBeNull();
    expect(result.newest).toEqual({ periodStart: "2026-09-28", value: 5 });
  });

  test("order does not depend on how the points arrive", () => {
    const result = weeklyCounts(points(["2026-10-05", 3], ["2026-09-21", 1], ["2026-09-28", 2]), CURRENT);
    expect(result.weeks.map((p) => p.value)).toEqual([1, 2, 3]);
  });
});

describe("newestPoint", () => {
  test("the newest bucket, or null with none", () => {
    expect(newestPoint([])).toBeNull();
    expect(
      newestPoint([
        { periodStart: "2026-10-12", value: 760 },
        { periodStart: "2026-10-05", value: 750 },
      ]),
    ).toEqual({ periodStart: "2026-10-12", value: 760 });
  });
});

describe("listAgeDays", () => {
  test("a list read within the limit is current", () => {
    expect(listAgeDays(NOW - 2 * DAY, NOW)).toBeNull();
    expect(listAgeDays(NOW - LIST_STALE_DAYS * DAY, NOW)).toBeNull();
  });

  test("past it, the age in whole days", () => {
    expect(listAgeDays(NOW - LIST_STALE_DAYS * DAY - 1, NOW)).toBe(LIST_STALE_DAYS);
    expect(listAgeDays(NOW - 9.5 * DAY, NOW)).toBe(9);
  });
});
