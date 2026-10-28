import { describe, expect, test } from "vitest";
import { clinicLine, clinicPeriodLine, clinicModules, periodRows, moduleWeek, recentModules, usageSummary, usesModule, type UsageWeek } from "./kz-clinics";

const week = (weekStart: string, checks: number, modules: Record<string, number> = {}): UsageWeek => ({
  weekStart,
  checks,
  actions: checks * 2,
  doctors: 2,
  failures: 0,
  modules,
});
const usualThen = (last: number) => [
  week("2026-09-07", 40),
  week("2026-09-14", 40),
  week("2026-09-21", 40),
  week("2026-09-28", 40),
  week("2026-10-05", last),
];

describe("usageSummary", () => {
  test("no weeks is no summary, never zero", () => {
    expect(usageSummary([])).toBeNull();
  });

  test.each([
    [0, "quiet", "No checks last week (usually 40)"],
    [20, "below", "20 checks, below its usual 40"],
    [38, "usual", "38 checks, about its usual 40"],
    [70, "above", "70 checks, above its usual 40"],
  ] as const)("a last week of %i reads %s", (last, level, words) => {
    expect(usageSummary(usualThen(last))).toMatchObject({ level, words, usual: 40, weekStart: "2026-10-05" });
  });

  test("weeks gone quiet are counted, against the usual week before them", () => {
    const weeks = [...usualThen(40).slice(0, 4), week("2026-10-05", 0), week("2026-10-12", 0)];
    expect(usageSummary(weeks)).toMatchObject({ level: "quiet", words: "No checks for 2 weeks (usually 40)" });
    expect(usageSummary([week("2026-10-05", 0), week("2026-10-12", 0)])?.words).toBe("No checks for 2 weeks");
  });

  test("a first week has nothing to be usual against", () => {
    expect(usageSummary([week("2026-10-05", 1)])).toMatchObject({ level: "new", words: "1 check last week", usual: null });
  });
});

describe("modules", () => {
  test("the recent weeks' modules, busiest first, and one not used left out", () => {
    const weeks = [week("2026-09-28", 5, { search: 3, intake: 1 }), week("2026-10-05", 5, { intake: 4, journal: 0 })];
    expect(recentModules(weeks).map((m) => [m.id, m.actions])).toEqual([
      ["intake", 5],
      ["search", 3],
    ]);
    expect(usesModule(weeks, "search")).toBe(true);
    expect(usesModule(weeks, "journal")).toBe(false);
  });
});

describe("a clinic's modules", () => {
  test("each with last week against the week before, busiest first, and its share", () => {
    const weeks = [
      week("2026-09-28", 5, { search: 10, intake: 30 }),
      week("2026-10-05", 5, { search: 20, intake: 20, journal: 0 }),
    ];
    expect(clinicModules(weeks)).toEqual([
      { id: "intake", label: "Intake", actions: { periodStart: "2026-10-05", value: 20, previous: 30 }, share: 0.5 },
      { id: "search", label: "Quick search", actions: { periodStart: "2026-10-05", value: 20, previous: 10 }, share: 0.5 },
    ]);
  });

  test("a week before that is not the week just before is not compared", () => {
    const weeks = [week("2026-09-21", 5, { search: 10 }), week("2026-10-05", 5, { search: 20 })];
    expect(moduleWeek(weeks, "search")).toEqual({ periodStart: "2026-10-05", value: 20, previous: null });
    expect(moduleWeek([], "search")).toBeNull();
  });
});

describe("clinicLine: a clinic as the Clinics tab reads it", () => {
  const w = (weekStart: string, actions: number, extra: Partial<UsageWeek> = {}): UsageWeek => ({
    weekStart,
    checks: 0,
    actions,
    doctors: actions > 0 ? 2 : 0,
    failures: 0,
    modules: {},
    plan: "paid",
    ...extra,
  });
  const STARTS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
  const line = (actions: number[], extra: Partial<UsageWeek> = {}) =>
    clinicLine(actions.map((a, i) => w(STARTS[i]!, a, extra)));

  test.each([
    [[20, 20, 20, 20, 0], "quiet"],
    [[20, 20, 20, 20, 13], "fell"],
    [[20, 20, 20, 20, 20], "usual"],
    [[20, 20, 20, 20, 27], "grew"],
    [[0, 0, 0, 0, 5], "new"],
    [[0, 0, 0, 0, 0], "idle"],
  ] as const)("%o is %s", (actions, status) => {
    expect(line([...actions]).status).toBe(status);
  });

  test("the norm is the four weeks before last week", () => {
    expect(line([10, 20, 30, 40, 99]).norm).toBe(25);
  });

  test("regular: paying, and working in 3 of the last 5 weeks", () => {
    expect(line([0, 0, 5, 5, 5]).regular).toBe(true);
    expect(line([0, 0, 0, 5, 5]).regular).toBe(false);
    expect(line([5, 5, 5, 5, 5], { plan: "trial" }).regular).toBe(false);
  });

  test("what changed: doctors first, then the biggest module moves", () => {
    const weeks = [
      w("2026-09-28", 20, { doctors: 1, modules: { visits: 10, search: 3 } }),
      w("2026-10-05", 0, { doctors: 0, modules: { visits: 0, search: 2 } }),
    ];
    const result = clinicLine(weeks);
    expect(result.changes).toEqual(["doctors 1 → 0", "Visits 10 → 0", "Quick search 3 → 2"]);
    expect(result.modules.map((m) => [m.id, m.now, m.previous])).toEqual([
      ["search", 2, 3],
      ["visits", 0, 10],
    ]);
  });
});

describe("a clinic over a period", () => {
  const w = (weekStart: string, actions: number): UsageWeek => ({
    weekStart,
    checks: actions,
    actions,
    doctors: actions > 0 ? 2 : 0,
    failures: 0,
    modules: { search: actions },
    plan: "paid",
    activeDays: actions > 0 ? 3 : 0,
  });
  const starts = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 17 + 7 * i)).toISOString().slice(0, 10));

  test("whole periods only, oldest first: counts add up, doctors are the weekly average", () => {
    const rows = periodRows(starts.map((s, i) => w(s, i + 1)), 4);
    expect(rows.map((r) => [r.weekStart, r.actions, r.doctors, r.activeDays, r.weeks])).toEqual([
      ["2026-08-17", 10, 2, 12, 4],
      ["2026-09-14", 26, 2, 12, 4],
    ]);
  });

  test("the rules read periods as weeks: last 4 weeks against the 4 before", () => {
    const line = clinicPeriodLine(starts.map((s, i) => w(s, i < 4 ? 10 : 2)), 4);
    expect([line.actions?.previous, line.actions?.value, line.norm, line.status]).toEqual([40, 8, 40, "fell"]);
  });
});
