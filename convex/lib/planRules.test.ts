import { describe, expect, test } from "vitest";
import { MAX_PLAN_ISSUES, PLAN_INCOMPLETE, PLAN_TOO_LONG, planProblems } from "./planRules";
import { PLAN_KEYS, PLAN_SCENARIOS, type PlanKey, type PlanRow, type PlanScenario } from "./planShape";

const OUTSIDE = "is outside what this figure can be";

/** Every scenario, for every year, with every figure. */
function whole(years: readonly number[] = [2026, 2027]): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const scenario of PLAN_SCENARIOS) {
    for (const year of years) {
      for (const key of PLAN_KEYS) rows.push({ scenario, year, key, value: 1 });
    }
  }
  return rows;
}

/** Where one figure sits in the array. A test that names a row not there is wrong. */
function indexOf(rows: readonly PlanRow[], scenario: PlanScenario, year: number, key: PlanKey) {
  const index = rows.findIndex((r) => r.scenario === scenario && r.year === year && r.key === key);
  if (index < 0) throw new Error("no such row in the fixture");
  return index;
}

/** Gives one figure a value and returns where it sits. */
function setValue(
  rows: PlanRow[],
  [scenario, year, key]: [PlanScenario, number, PlanKey],
  value: number,
): number {
  const index = indexOf(rows, scenario, year, key);
  rows[index] = { scenario, year, key, value };
  return index;
}

describe("planProblems", () => {
  test("a whole plan has none", () => {
    expect(planProblems(whole())).toEqual([]);
  });

  test("the sentences are the ones the endpoint will say", () => {
    expect(PLAN_INCOMPLETE).toBe(
      "The plan is incomplete: every scenario needs every figure for every year.",
    );
    expect(PLAN_TOO_LONG).toBe("The plan covers more years than the OS keeps.");
  });

  test("a value below what the figure can be is named by row", () => {
    const rows = whole();
    const i = setValue(rows, ["base", 2027, "arr"], -1);
    expect(planProblems(rows)).toEqual([{ path: `plan.rows.${i}.value`, message: OUTSIDE }]);
  });

  test("a value above what the figure can be is named by row", () => {
    const rows = whole();
    const i = setValue(rows, ["bull", 2026, "headcount"], 100_001);
    expect(planProblems(rows)).toEqual([{ path: `plan.rows.${i}.value`, message: OUTSIDE }]);
  });

  test("the limits themselves are allowed", () => {
    const rows = whole();
    setValue(rows, ["bear", 2026, "net_burn"], -1e11);
    setValue(rows, ["bear", 2026, "headcount"], 1e5);
    expect(planProblems(rows)).toEqual([]);
  });

  test("a negative where the figure can be negative is fine", () => {
    const rows = whole();
    setValue(rows, ["base", 2026, "cash_end"], -2_500_000);
    expect(planProblems(rows)).toEqual([]);
  });

  test("Infinity and NaN are refused the same way", () => {
    const rows = whole();
    const a = setValue(rows, ["bear", 2026, "revenue"], Infinity);
    const b = setValue(rows, ["bull", 2027, "cash_end"], NaN);
    expect(planProblems(rows)).toEqual([
      { path: `plan.rows.${a}.value`, message: OUTSIDE },
      { path: `plan.rows.${b}.value`, message: OUTSIDE },
    ]);
  });

  test("the same scenario, year and figure twice is named by the second row", () => {
    const rows = whole();
    rows.push({ scenario: "base", year: 2026, key: "revenue", value: 2 });
    expect(planProblems(rows)).toEqual([
      { path: `plan.rows.${rows.length - 1}`, message: "repeats an earlier row" },
    ]);
  });

  test("a repeated row is named, and completeness is not guessed at beside it", () => {
    const rows = whole().filter((row) => !(row.scenario === "bull" && row.key === "arr"));
    rows.push({ scenario: "bear", year: 2026, key: "arr", value: 2 });
    expect(planProblems(rows)).toEqual([
      { path: `plan.rows.${rows.length - 1}`, message: "repeats an earlier row" },
    ]);
  });

  test("one figure missing for one scenario and year is an incomplete plan", () => {
    const rows = whole();
    rows.splice(indexOf(rows, "bull", 2027, "headcount"), 1);
    expect(planProblems(rows)).toEqual([{ path: "plan.rows", message: PLAN_INCOMPLETE }]);
  });

  test("a scenario missing entirely is an incomplete plan", () => {
    const rows = whole().filter((row) => row.scenario !== "bear");
    expect(planProblems(rows)).toEqual([{ path: "plan.rows", message: PLAN_INCOMPLETE }]);
  });

  test("scenarios that cover different years are an incomplete plan", () => {
    const rows = [
      ...whole([2026, 2027]).filter((row) => row.scenario !== "bull"),
      ...whole([2026, 2027, 2028]).filter((row) => row.scenario === "bull"),
    ];
    expect(planProblems(rows)).toEqual([{ path: "plan.rows", message: PLAN_INCOMPLETE }]);
  });

  test("no rows at all is an incomplete plan, not a clean one", () => {
    expect(planProblems([])).toEqual([{ path: "plan.rows", message: PLAN_INCOMPLETE }]);
  });

  test("more years than the OS keeps is said once, in its own words", () => {
    const years = Array.from({ length: 13 }, (_, n) => 2026 + n);
    expect(planProblems(whole(years))).toEqual([{ path: "plan.rows", message: PLAN_TOO_LONG }]);
  });

  test("twelve years is the most", () => {
    const years = Array.from({ length: 12 }, (_, n) => 2026 + n);
    expect(planProblems(whole(years))).toEqual([]);
  });

  test("a plan with many bad values reports at most twenty", () => {
    const rows = whole().map((row) => ({ ...row, value: Infinity }));
    expect(rows.length).toBeGreaterThan(20);
    expect(MAX_PLAN_ISSUES).toBe(20);
    const issues = planProblems(rows);
    expect(issues).toHaveLength(20);
    // The first twenty, in row order: the cap cuts the tail, not the head.
    expect(issues[0]).toEqual({ path: "plan.rows.0.value", message: OUTSIDE });
    expect(issues[19]).toEqual({ path: "plan.rows.19.value", message: OUTSIDE });
  });
});
