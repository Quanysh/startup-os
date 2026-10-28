import { describe, expect, test } from "vitest";
import type { Change } from "@convex/lib/runway";
import { cashPath, chooseWindow, runOutLabel } from "./runway-path";

// Made-up figures, in minor units.
const base = { today: "2026-10-15", currency: "USD" as const, changes: [] as Change[], fxUsdKzt: null };
const projected = (input: Parameters<typeof cashPath>[0]) => {
  const path = cashPath(input);
  if (path.kind !== "projected") throw new Error(`expected a projection, got ${path.reason}`);
  return path;
};

describe("chooseWindow", () => {
  test("never runs out (or not within 24 months): 24 months, as before", () => {
    expect(chooseWindow(null)).toEqual({ unit: "month", months: 24 });
  });
  test("runs out within two months: weeks, at least four, one past the run-out", () => {
    expect(chooseWindow(10)).toEqual({ unit: "week", weeks: 4 });
    expect(chooseWindow(40)).toEqual({ unit: "week", weeks: 7 });
  });
  test("a few months: the first 6, then 12, so the drop fills the chart", () => {
    expect(chooseWindow(90)).toEqual({ unit: "month", months: 6 });
    expect(chooseWindow(200)).toEqual({ unit: "month", months: 12 });
    expect(chooseWindow(400)).toEqual({ unit: "month", months: 24 });
  });
});

describe("cashPath", () => {
  test("missing figures stay not known, never zero", () => {
    expect(cashPath({ ...base, cash: null, netBurn: 100 })).toEqual({ kind: "unknown", reason: "no_cash" });
    expect(cashPath({ ...base, cash: 100, netBurn: null })).toEqual({ kind: "unknown", reason: "no_burn" });
    const kzt: Change = { kind: "cost", label: "x", startMonth: "2026-11", endMonth: null, amount: 1, currency: "KZT" };
    expect(cashPath({ ...base, cash: 100, netBurn: 100, changes: [kzt] })).toEqual({ kind: "unknown", reason: "no_rate" });
  });

  test("runs out within weeks: the date cash/burn months from today, the line stopping at zero", () => {
    // 21,000 at 26,800 a month: 0.78 months. 17 days of October burn 14,697;
    // the 6,303 left lasts 7.06 of November's days: it crosses on 8 Nov.
    // Four weeks hold it; one more so the run-out is not on the edge.
    const path = projected({ ...base, cash: 21_000_00, netBurn: 26_800_00 });
    expect(path.runOut).toMatchObject({ kind: "date", date: "2026-11-08" });
    expect(path.window).toEqual({ unit: "week", weeks: 5 });
    expect(path.span).toBe(35);
    expect(path.points[0]).toEqual({ day: 0, date: "2026-10-15", cash: 21_000_00, kind: "today" });
    const last = path.points.at(-1)!;
    expect(last.kind).toBe("run_out");
    expect(last.cash).toBe(0);
    expect(last.day).toBeGreaterThan(24);
    expect(last.day).toBeLessThan(24.1);
    // Weekly points before it, nothing below zero, nothing after it.
    expect(path.points.map((p) => p.day).slice(0, 4)).toEqual([0, 7, 14, 21]);
    expect(path.points.every((p) => p.cash >= 0)).toBe(true);
    expect(path.ticks.map((t) => t.day)).toEqual([0, 7, 14, 21, 28, 35]);
  });

  test("a few months: monthly ticks on the first of each month over 6 months", () => {
    const path = projected({ ...base, cash: 89_500_00, netBurn: 30_000_00 });
    // 16,452 of October's burn, then 30,000 in each of November and December:
    // 13,048 lasts 13.5 of January's days.
    expect(path.runOut).toMatchObject({ kind: "date", date: "2027-01-14" });
    expect(path.window).toEqual({ unit: "month", months: 6 });
    expect(path.ticks.map((t) => t.date)).toEqual([
      "2026-10-15",
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
    ]);
    expect(path.points.map((p) => p.kind)).toEqual(["today", "tick", "tick", "tick", "run_out"]);
  });

  test("never runs out within 24 months: today's behaviour, every month drawn", () => {
    const path = projected({ ...base, cash: 1_000_000_00, netBurn: 20_000_00 });
    expect(path.runOut).toEqual({ kind: "beyond" });
    expect(path.window).toEqual({ unit: "month", months: 24 });
    expect(path.points.at(-1)!.kind).toBe("tick");
    expect(path.points).toHaveLength(25);
  });

  test("not burning: cash rises, nothing runs out", () => {
    const path = projected({ ...base, cash: 5_000_00, netBurn: -1_000_00 });
    expect(path.runOut).toEqual({ kind: "beyond" });
    expect(path.points.at(-1)!.cash).toBeGreaterThan(5_000_00);
  });

  test("no cash at all and burning: it has run out today", () => {
    const path = projected({ ...base, cash: 0, netBurn: 10_000_00 });
    expect(path.runOut).toMatchObject({ kind: "date", date: "2026-10-15" });
    expect(path.points).toEqual([
      { day: 0, date: "2026-10-15", cash: 0, kind: "today" },
    ]);
  });

  test("a scenario that adds cash moves the run-out date, to its own zero crossing", () => {
    const cashIn: Change = { kind: "cash_in", label: "Made-up round", startMonth: "2026-11", endMonth: null, amount: 30_000_00, currency: "USD" };
    const path = projected({ ...base, cash: 21_000_00, netBurn: 26_800_00, changes: [cashIn] });
    // 6,303 left on 1 Nov, plus 30,000: 36,303 lasts 1.35 months more, into mid-December.
    expect(path.runOut).toMatchObject({ kind: "date", date: "2026-12-11" });
    expect(path.window).toEqual({ unit: "week", weeks: 10 });
    expect(path.points.at(-1)!.cash).toBe(0);
  });

  test("a monthly change counts from its month, and a change in tenge converts at the rate", () => {
    const hire: Change = { kind: "hire", label: "Made-up hire", startMonth: "2026-11", endMonth: null, amount: 10_000_00 * 500, currency: "KZT" };
    const without = projected({ ...base, cash: 400_000_00, netBurn: 20_000_00 });
    const withHire = projected({ ...base, cash: 400_000_00, netBurn: 20_000_00, changes: [hire], fxUsdKzt: 500 });
    expect(without.runOut).toMatchObject({ kind: "date", date: "2028-06-14" });
    expect(withHire.runOut).toMatchObject({ kind: "date", date: "2027-11-30" });
  });
});

describe("runOutLabel", () => {
  test("a date within two months, a month after that, never a day it cannot know", () => {
    expect(runOutLabel({ kind: "date", date: "2026-11-08", days: 24.2 }, "2026-10-15")).toBe("8 Nov");
    expect(runOutLabel({ kind: "date", date: "2027-01-03", days: 50 }, "2026-12-01")).toBe("3 Jan 2027");
    expect(runOutLabel({ kind: "date", date: "2028-06-14", days: 608 }, "2026-10-15")).toBe("Jun 2028");
  });
});
