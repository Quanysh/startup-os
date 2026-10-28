import { describe, expect, test } from "vitest";
import { validateSnapshots } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { HEALTH, week } from "./verticalHealth.fixtures";
import { MAX_WEEKS, toSnapshots } from "./verticalHealthParse";

// A Wednesday: the week in progress began on Monday, October 12.
const NOW = Date.UTC(2026, 9, 14, 6, 30);
const HOUR = 60 * 60 * 1000;

function refusal(raw: unknown): Error {
  try {
    toSnapshots(raw, NOW);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}
const withWeeks = (weeks: unknown[]) => ({ ...HEALTH, weeks });
const lines = (raw: unknown) =>
  toSnapshots(raw, NOW)
    .map((r) => `${r.key} ${r.period} ${r.periodStart} ${r.value}`)
    .sort();

describe("toSnapshots", () => {
  test("today's practices, and three figures for each closed week", () => {
    expect(lines(HEALTH)).toEqual([
      "core_actions week 2026-09-14 120",
      "core_actions week 2026-09-21 160",
      "core_actions week 2026-09-28 188",
      "core_actions week 2026-10-05 212",
      "practices day 2026-10-14 4",
      "practices_active week 2026-09-14 2",
      "practices_active week 2026-09-21 3",
      "practices_active week 2026-09-28 3",
      "practices_active week 2026-10-05 3",
      "weekly_active_users week 2026-09-14 9",
      "weekly_active_users week 2026-09-21 11",
      "weekly_active_users week 2026-09-28 12",
      "weekly_active_users week 2026-10-05 14",
    ]);
  });

  test("every row is ours: one scope, and the registry accepts them", () => {
    const rows = toSnapshots(HEALTH, NOW);
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(["vertical_startup"]));
    expect(validateSnapshots("vertical_startup", rows, undefined, { now: NOW })).toEqual([]);
  });

  test("a week Vertical Startup reports as quiet is a zero: it said so", () => {
    expect(lines(withWeeks([week("2026-10-05", 0, 0, 0)]))).toContain(
      "core_actions week 2026-10-05 0",
    );
  });

  test("no closed week gives no rows at all, not a lone practice count", () => {
    expect(toSnapshots(withWeeks([]), NOW)).toEqual([]);
  });

  test("a version this code does not know is refused", () => {
    const error = refusal({ ...HEALTH, version: 2 });
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(
      "Vertical Startup's health response is not in the expected shape (version).",
    );
  });

  test("a missing field is refused, naming where", () => {
    const { coreActions: _dropped, ...short } = week("2026-10-05", 1, 1, 1);
    expect(refusal(withWeeks([short])).message).toBe(
      "Vertical Startup's health response is not in the expected shape (weeks.0.coreActions).",
    );
  });

  test.each([
    ["two hours old", NOW - 2 * HOUR],
    ["two hours ahead", NOW + 2 * HOUR],
  ])("an answer %s is not this run's answer", (_name, at) => {
    const error = refusal({ ...HEALTH, generatedAt: new Date(at).toISOString() });
    expect(error.message).toBe("Vertical Startup's health response was not made in the last hour.");
  });

  test("an answer from within the hour is taken", () => {
    const recent = { ...HEALTH, generatedAt: new Date(NOW - HOUR + 1).toISOString() };
    expect(toSnapshots(recent, NOW)).toHaveLength(13);
  });

  test("more weeks than the contract allows is refused", () => {
    const many = Array.from({ length: MAX_WEEKS + 1 }, () => week("2026-10-05", 1, 1, 1));
    expect(refusal(withWeeks(many)).message).toBe(
      `Vertical Startup's health response lists more than ${MAX_WEEKS} weeks.`,
    );
  });

  test.each([
    ["a Tuesday", "2026-10-06"],
    ["a day that does not exist", "2026-02-30"],
    ["text", '<img src=x onerror="steal()"> Smith Specialty'],
  ])("a week named by %s is refused, without quoting it", (_name, weekStart) => {
    const error = refusal(withWeeks([week(weekStart, 1, 1, 1)]));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(
      "Vertical Startup's health response has a week that does not start on a Monday.",
    );
  });

  test.each([
    ["the week in progress", "2026-10-12"],
    ["a week still to come", "2026-10-19"],
  ])("%s is refused: a week that has not ended is not a week's figure", (_name, weekStart) => {
    expect(refusal(withWeeks([...HEALTH.weeks, week(weekStart, 1, 1, 1)])).message).toBe(
      "Vertical Startup's health response includes a week that has not ended.",
    );
  });

  test("a week listed twice is refused rather than overwritten", () => {
    expect(refusal(withWeeks([HEALTH.weeks[3], HEALTH.weeks[3]])).message).toBe(
      "Vertical Startup's health response lists a week twice.",
    );
  });

  test.each([
    ["half a person", withWeeks([week("2026-10-05", 1.5, 1, 1)])],
    ["a negative count", withWeeks([week("2026-10-05", 1, 1, -1)])],
    ["half a practice in the total", { ...HEALTH, totals: { practices: 2.5 } }],
  ])("%s is refused", (_name, raw) => {
    expect(refusal(raw).message).toBe(
      "Vertical Startup's health response has a count that is not a whole number.",
    );
  });
});
