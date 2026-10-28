// The financial model's plan against what happened: Finance's "Plan against
// reality". Pure, and read by the Finance page alone; nothing here reads a
// clock (the year and the figures are handed in).
//
// The plan (`convex/plan.ts`, `planFigures`) holds, per scenario and year,
// ARR at year-end, revenue, net burn and capital raised for the year, and
// cash at year-end, in whole US dollars: Startup's US business. It is yearly;
// what happened is monthly. So:
//   MRR     the plan's line runs straight from last year-end's ARR to this
//           year-end's, a twelfth of each (December's MRR is year-end ARR ÷
//           12). With no row for last year there is no line, and MRR is set
//           against where the plan ends the year instead: never a guessed start.
//   burn    a twelfth of the year's planned net burn, against today's average.
//   cash    December's month-end cash in the runway projection at today's
//           burn (`convex/lib/runway.ts`), against the plan's year-end cash.
// Each comparison is with the base scenario; the chart shows bear to bull.
//
// A missing number is not a zero: no MRR this year, no burn, no projection,
// or no plan for the year is said in words and compared with nothing.

import { PLAN_SCENARIO_LABELS, type PlanKey, type PlanRow, type PlanScenario } from "@convex/lib/planShape";
import type { Projection } from "@convex/lib/runway";
import { formatPeriod, formatUsd } from "@/lib/format";

/** The scenario every sentence is set against. */
export const COMPARED: PlanScenario = "base";
const NAME = PLAN_SCENARIO_LABELS[COMPARED].toLowerCase();

type Point = { periodStart: string; value: number };

/** The years the plan covers, oldest first. */
export function planYears(rows: readonly PlanRow[]): number[] {
  return [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b);
}

/** One stored figure, or null where the plan has none. */
export function planValue(
  rows: readonly PlanRow[],
  scenario: PlanScenario,
  year: number,
  key: PlanKey,
): number | null {
  return rows.find((row) => row.scenario === scenario && row.year === year && row.key === key)?.value ?? null;
}

/**
 * The plan's MRR for each month of `year`, January first: a straight line
 * from the end of last year (its ARR ÷ 12) to the end of this one. Null
 * without both year-ends.
 */
export function mrrPath(rows: readonly PlanRow[], scenario: PlanScenario, year: number): number[] | null {
  const before = planValue(rows, scenario, year - 1, "arr");
  const after = planValue(rows, scenario, year, "arr");
  if (before === null || after === null) return null;
  const from = before / 12;
  const to = after / 12;
  return Array.from({ length: 12 }, (_, i) => (i === 11 ? to : from + ((to - from) * (i + 1)) / 12));
}

const monthIndex = (periodStart: string) => Number(periodStart.slice(5, 7)) - 1;
const inYear = (points: readonly Point[], year: number) =>
  points.filter((point) => point.periodStart.startsWith(`${year}-`));

export type MrrReading =
  | { kind: "path"; month: string; actual: number; planned: number; ratio: number }
  | { kind: "year_end"; month: string; actual: number; planned: number }
  | { kind: "none"; reason: "no_mrr" | "no_year" };

/** This year's latest MRR (dollars) against the base plan. */
export function readMrr(rows: readonly PlanRow[], year: number, mrr: readonly Point[]): MrrReading {
  const yearEnd = planValue(rows, COMPARED, year, "arr");
  if (yearEnd === null) return { kind: "none", reason: "no_year" };
  const latest = [...inYear(mrr, year)].sort((a, b) => a.periodStart.localeCompare(b.periodStart)).at(-1);
  if (latest === undefined) return { kind: "none", reason: "no_mrr" };
  const path = mrrPath(rows, COMPARED, year);
  if (path === null) {
    return { kind: "year_end", month: latest.periodStart, actual: latest.value, planned: yearEnd / 12 };
  }
  const planned = path[monthIndex(latest.periodStart)]!;
  return {
    kind: "path",
    month: latest.periodStart,
    actual: latest.value,
    planned,
    ratio: planned === 0 ? 0 : latest.value / planned - 1,
  };
}

export type BurnReading =
  | { kind: "compared"; actual: number; planned: number; ratio: number }
  | { kind: "not_burning"; actual: number; planned: number }
  | { kind: "plan_surplus"; actual: number; planned: number }
  | { kind: "none"; reason: "no_burn" | "no_year" };

/** Today's average monthly net burn (dollars) against a twelfth of the base plan's year. */
export function readBurn(rows: readonly PlanRow[], year: number, averageBurn: number | null): BurnReading {
  const yearly = planValue(rows, COMPARED, year, "net_burn");
  if (yearly === null) return { kind: "none", reason: "no_year" };
  if (averageBurn === null || !Number.isFinite(averageBurn)) return { kind: "none", reason: "no_burn" };
  const planned = yearly / 12;
  if (planned <= 0) return { kind: "plan_surplus", actual: averageBurn, planned };
  if (averageBurn <= 0) return { kind: "not_burning", actual: averageBurn, planned };
  return { kind: "compared", actual: averageBurn, planned, ratio: averageBurn / planned - 1 };
}

export type CashReading =
  | { kind: "compared"; projected: number; planned: number; raised: number }
  | { kind: "none"; reason: "no_projection" | "no_year" };

/**
 * December's month-end cash in the runway projection at today's burn (US
 * dollar cents, as the projection holds Startup's money), against the base
 * plan's year-end cash, with what the plan raises that year.
 */
export function readCash(rows: readonly PlanRow[], year: number, projection: Projection): CashReading {
  const planned = planValue(rows, COMPARED, year, "cash_end");
  if (planned === null) return { kind: "none", reason: "no_year" };
  if (projection.kind !== "projected" || projection.currency !== "USD") {
    return { kind: "none", reason: "no_projection" };
  }
  const december = projection.months.find((m) => m.month === `${year}-12`);
  if (december === undefined) return { kind: "none", reason: "no_projection" };
  return {
    kind: "compared",
    projected: december.cash / 100,
    planned,
    raised: planValue(rows, COMPARED, year, "capital_raised") ?? 0,
  };
}

/** A share in whole percent, unsigned: "12%". */
const percent = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)}%`;
/** Within half a percent reads as level. */
const level = (ratio: number) => Math.round(Math.abs(ratio) * 100) === 0;
const monthName = (periodStart: string) => formatPeriod("month", periodStart, "short");

export function mrrSentence(reading: MrrReading, year: number): string {
  switch (reading.kind) {
    case "none":
      return reading.reason === "no_year"
        ? `The plan has no figures for ${year}.`
        : `No MRR figure for ${year} yet, so there is nothing to set against the plan.`;
    case "path": {
      const month = monthName(reading.month);
      if (level(reading.ratio)) {
        return `MRR for ${month} is in line with the ${NAME} plan's ${formatUsd(reading.planned)}.`;
      }
      return `MRR for ${month} is ${percent(reading.ratio)} ${reading.ratio < 0 ? "under" : "over"} the ${NAME} plan's ${formatUsd(reading.planned)}.`;
    }
    case "year_end": {
      const start = `The ${NAME} plan ends ${year} at ${formatUsd(reading.planned)} MRR; ${monthName(reading.month)}'s is`;
      if (reading.actual >= reading.planned) return `${start} already above it.`;
      return `${start} ${percent(reading.actual / reading.planned - 1)} below that.`;
    }
  }
}

export function burnSentence(reading: BurnReading, year: number): string {
  switch (reading.kind) {
    case "none":
      return reading.reason === "no_year"
        ? `The plan has no net burn for ${year}.`
        : "Net burn is not known yet, so it is not set against the plan.";
    case "plan_surplus":
      return `The ${NAME} plan has no net burn in ${year}: it brings in ${formatUsd(-reading.planned)} a month more than it spends.`;
    case "not_burning":
      return `Money in is above money out, where the ${NAME} plan burns ${formatUsd(reading.planned)} a month in ${year}.`;
    case "compared": {
      const planned = `the ${NAME} plan's ${formatUsd(reading.planned)} a month for ${year}`;
      if (level(reading.ratio)) return `Net burn is in line with ${planned}.`;
      return `Net burn is ${percent(reading.ratio)} ${reading.ratio < 0 ? "below" : "above"} ${planned}.`;
    }
  }
}

export function cashSentence(reading: CashReading, year: number): string {
  if (reading.kind === "none") {
    return reading.reason === "no_year"
      ? `The plan has no year-end cash for ${year}.`
      : "Year-end cash at today's burn is not known yet, so it is not set against the plan.";
  }
  if (reading.projected < 0) {
    return `At today's net burn, cash runs out before the end of ${year}; the ${NAME} plan ends the year with ${formatUsd(reading.planned)}.`;
  }
  const raised = reading.raised > 0 ? `, which raises ${formatUsd(reading.raised)} that year` : "";
  return `At today's net burn, cash at the end of ${year} would be ${formatUsd(reading.projected)}, against ${formatUsd(reading.planned)} in the ${NAME} plan${raised}.`;
}

export type PlanChart = {
  /** The twelve months of the year, January first, as "YYYY-MM-01". */
  months: string[];
  /** This year's MRR by month, null where there is no figure. */
  actual: (number | null)[];
  /** The base plan's line, or null without last year's figures. */
  base: number[] | null;
  /** The bear-to-bull range by month, or null without last year's figures. */
  band: { low: number; high: number }[] | null;
  /** Each scenario's December MRR (year-end ARR ÷ 12); null where the plan has none. */
  yearEnd: Record<PlanScenario, number> | null;
  /** Three months of MRR this year or more: anything less is not a chart. */
  drawable: boolean;
};

/** Minimum months of actual MRR this year before the line is drawn. */
export const MIN_PLAN_CHART_MONTHS = 3;

export function planChart(rows: readonly PlanRow[], year: number, mrr: readonly Point[]): PlanChart {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  const byMonth = new Map(inYear(mrr, year).map((point) => [point.periodStart, point.value]));
  const actual = months.map((month) => byMonth.get(month) ?? null);
  const bear = mrrPath(rows, "bear", year);
  const base = mrrPath(rows, "base", year);
  const bull = mrrPath(rows, "bull", year);
  const ends = (["bear", "base", "bull"] as const).map((s) => planValue(rows, s, year, "arr"));
  return {
    months,
    actual,
    base,
    band:
      bear !== null && bull !== null
        ? bear.map((low, i) => ({ low: Math.min(low, bull[i]!), high: Math.max(low, bull[i]!) }))
        : null,
    yearEnd: ends.every((v) => v !== null)
      ? { bear: ends[0]! / 12, base: ends[1]! / 12, bull: ends[2]! / 12 }
      : null,
    drawable: actual.filter((value) => value !== null).length >= MIN_PLAN_CHART_MONTHS,
  };
}
