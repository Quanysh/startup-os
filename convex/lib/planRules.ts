// What a plan push must satisfy beyond its shape. Used by the endpoint, and by
// the push script before it shows or sends anything. A plan is refused unless
// it is whole: every scenario, the same years for each, every figure for each
// year. A push replaces the plan, so one cut short would leave a year the
// model dropped standing beside a year it just sent, and the Finance page
// would compare figures from two different versions of the model. Every
// message is a path and fixed words, never a value.

import {
  MAX_PLAN_YEARS,
  PLAN_KEY_DEFS,
  PLAN_KEYS,
  PLAN_SCENARIOS,
  type PlanRow,
} from "./planShape";

export const PLAN_INCOMPLETE =
  "The plan is incomplete: every scenario needs every figure for every year.";
export const PLAN_TOO_LONG = "The plan covers more years than the OS keeps.";
/** A plan with a column of bad values should not answer with a page of them. */
export const MAX_PLAN_ISSUES = 20;

export type PlanIssue = { path: string; message: string };

const idOf = (row: PlanRow) => `${row.scenario}|${row.year}|${row.key}`;

export function planProblems(rows: readonly PlanRow[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  const years = new Set<number>();
  let repeated = false;
  rows.forEach((row, index) => {
    const { min, max } = PLAN_KEY_DEFS[row.key];
    // NaN is neither below nor above a limit, so it needs the finite check.
    if (!Number.isFinite(row.value) || row.value < min || row.value > max) {
      issues.push({
        path: `plan.rows.${index}.value`,
        message: "is outside what this figure can be",
      });
    }
    const id = idOf(row);
    if (seen.has(id)) {
      repeated = true;
      issues.push({ path: `plan.rows.${index}`, message: "repeats an earlier row" });
    } else {
      seen.add(id);
    }
    years.add(row.year);
  });

  if (years.size > MAX_PLAN_YEARS) issues.push({ path: "plan.rows", message: PLAN_TOO_LONG });

  // With a repeated row the count of rows says nothing about what is there,
  // and the repeat is already named; say the one thing at a time.
  if (!repeated && !isWhole(seen, years)) {
    issues.push({ path: "plan.rows", message: PLAN_INCOMPLETE });
  }
  return issues.slice(0, MAX_PLAN_ISSUES);
}

/**
 * Whether every scenario holds every figure for every year any scenario
 * names. No years at all is not a plan: every scenario is missing.
 */
function isWhole(seen: ReadonlySet<string>, years: ReadonlySet<number>): boolean {
  if (years.size === 0) return false;
  for (const scenario of PLAN_SCENARIOS) {
    for (const year of years) {
      for (const key of PLAN_KEYS) {
        if (!seen.has(`${scenario}|${year}|${key}`)) return false;
      }
    }
  }
  return true;
}
