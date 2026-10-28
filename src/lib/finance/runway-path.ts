// Runway and what changes it, on the Finance page: where cash goes from
// today, day by day, and the day it runs out. Pure; nothing reads a clock
// (today is handed in as "YYYY-MM-DD").
//
// It is the runway figure drawn: cash ÷ net burn months from today, the
// burn spread over each month's days (October's burn over October's 31), so
// "runs out around 8 Nov" is the hero's 0.8 months put on the calendar. The
// line stops where cash reaches zero (the crossing interpolated within its
// day) and nothing is drawn below it: a projection of cash below zero is not
// a figure anyone can use. The window is chosen from the run-out, so a drop
// of weeks is drawn in weeks and a long runway over 24 months, as before.
//
// Changes are the Budget and runway tab's own (`convex/lib/runway.ts`): a
// monthly change from its first month, spread over that month's days the way
// the burn is; a one-off on the first of its month (today, if that is this
// month). A missing figure is not a zero: no cash, no burn or a change in
// the other currency with no rate gives no path at all.

import { appliesIn, convert, isOneOff, monthlyDelta, PROJECTION_MONTHS, type Change } from "@convex/lib/runway";
import { runwayInputs } from "@convex/lib/budget";
import type { CompanyId } from "@convex/lib/company";
import type { FinanceSummary } from "@convex/lib/finance";
import type { Currency } from "@convex/lib/metricRegistry";
import type { GroupFigures } from "./group";

/** Under this many months of runway the panel leads with the sentence, and the chart is in weeks. */
export const SHORT_RUNWAY_MONTHS = 2;
/** The average month, for turning days into months of runway. */
const DAYS_PER_MONTH = 365.25 / 12;

export type RunwayWindow = { unit: "week"; weeks: number } | { unit: "month"; months: number };

/**
 * How much time the chart spans, from the days until cash runs out (null
 * when it does not within 24 months): weeks under two months, at least four
 * and one past the run-out; else the first 6 or 12 months where the run-out
 * sits well inside them; else 24.
 */
export function chooseWindow(runOutDays: number | null): RunwayWindow {
  if (runOutDays === null) return { unit: "month", months: PROJECTION_MONTHS };
  const months = runOutDays / DAYS_PER_MONTH;
  if (months < SHORT_RUNWAY_MONTHS) return { unit: "week", weeks: Math.max(4, Math.ceil(runOutDays / 7) + 1) };
  if (months <= 6 * 0.8) return { unit: "month", months: 6 };
  if (months <= 12 * 0.8) return { unit: "month", months: 12 };
  return { unit: "month", months: PROJECTION_MONTHS };
}

const DAY_MS = 86_400_000;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => toDate(toTime(date) + days * DAY_MS);
const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY_MS);
const daysInMonth = (month: string) => {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
};
/** The same day of the month `by` months on, held to the month's last day. */
function addMonthsToDate(date: string, by: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(year, month - 1 + by, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return toDate(first.getTime());
}

export type RunOutDay = { kind: "date"; date: string; days: number } | { kind: "beyond" };

export type PathPoint = { day: number; date: string; cash: number; kind: "today" | "tick" | "run_out" };

export type CashPath =
  | { kind: "unknown"; reason: "no_cash" | "no_burn" | "no_rate" }
  | {
      kind: "projected";
      currency: Currency;
      /** The day cash first falls below zero (interpolated `days` from today), or "beyond" 24 months. */
      runOut: RunOutDay;
      window: RunwayWindow;
      /** Days from today to the window's end. */
      span: number;
      /** What is drawn: today, each tick before the run-out, and the run-out at zero. Never below zero. */
      points: PathPoint[];
      /** The axis: today and each week, or each first of the month, to the window's end. */
      ticks: { day: number; date: string }[];
    };

/**
 * Cash from today: `cash` now, less the net burn (positive is burning)
 * spread over each month's days, plus what each change does. Minor units.
 */
export function cashPath(input: {
  today: string;
  currency: Currency;
  cash: number | null;
  netBurn: number | null;
  changes: readonly Change[];
  fxUsdKzt: number | null;
}): CashPath {
  const { today, currency, cash, netBurn, changes, fxUsdKzt } = input;
  if (cash === null || !Number.isFinite(cash)) return { kind: "unknown", reason: "no_cash" };
  if (netBurn === null || !Number.isFinite(netBurn)) return { kind: "unknown", reason: "no_burn" };
  const own: Change[] = [];
  for (const change of changes) {
    const amount = convert(change.amount, change.currency, currency, fxUsdKzt);
    if (amount === null) return { kind: "unknown", reason: "no_rate" };
    own.push({ ...change, amount, currency });
  }

  const thisMonth = today.slice(0, 7);
  const horizon = daysBetween(today, addMonthsToDate(today, PROJECTION_MONTHS));
  // balance[i]: cash at the start of day i, after that day's one-offs.
  const balance: number[] = [];
  let running = cash;
  let runOut: RunOutDay = cash < 0 ? { kind: "date", date: today, days: 0 } : { kind: "beyond" };
  for (let i = 0; i <= horizon; i += 1) {
    const date = addDays(today, i);
    const month = date.slice(0, 7);
    const firstOfMonth = i === 0 || date.endsWith("-01");
    if (firstOfMonth) {
      for (const change of own) {
        if (!isOneOff(change.kind)) continue;
        // A one-off this month happens today; one before this month never does.
        if (i === 0 ? change.startMonth === thisMonth : change.startMonth === month) running += monthlyDelta(change, change.startMonth);
      }
    }
    balance.push(running);
    if (runOut.kind === "beyond" && i > 0 && running < 0) {
      const dayStart = balance[i - 1]!;
      // The day it went below: the crossing within that day.
      const fraction = dayStart > 0 ? dayStart / (dayStart - running) : 0;
      runOut = { kind: "date", date: addDays(today, i - 1), days: i - 1 + fraction };
    }
    const monthly = own.reduce(
      (sum, change) => (isOneOff(change.kind) || !appliesIn(change, month) ? sum : sum + monthlyDelta(change, month)),
      -netBurn,
    );
    running += monthly / daysInMonth(month);
  }

  const window = chooseWindow(runOut.kind === "date" ? runOut.days : null);
  const span = window.unit === "week" ? window.weeks * 7 : daysBetween(today, addMonthsToDate(today, window.months));
  const ticks: { day: number; date: string }[] = [{ day: 0, date: today }];
  if (window.unit === "week") {
    for (let day = 7; day <= span; day += 7) ticks.push({ day, date: addDays(today, day) });
  } else {
    for (let day = 1; day <= span; day += 1) {
      const date = addDays(today, day);
      if (date.endsWith("-01")) ticks.push({ day, date });
    }
  }

  const cashOn = (day: number) => Math.round(balance[Math.min(day, balance.length - 1)]!);
  const points: PathPoint[] = [{ day: 0, date: today, cash: Math.max(cashOn(0), 0), kind: "today" }];
  if (runOut.kind === "date" && runOut.days === 0) return { kind: "projected", currency, runOut, window, span, points, ticks };
  for (const tick of ticks.slice(1)) {
    if (runOut.kind === "date" && tick.day >= runOut.days) break;
    points.push({ day: tick.day, date: tick.date, cash: cashOn(tick.day), kind: "tick" });
  }
  if (runOut.kind === "date") points.push({ day: runOut.days, date: runOut.date, cash: 0, kind: "run_out" });
  return { kind: "projected", currency, runOut, window, span, points, ticks };
}

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** "8 Nov" (this year), "3 Jan 2027", and past two months the month alone: "Jun 2028". */
export function runOutLabel(runOut: Extract<RunOutDay, { kind: "date" }>, today: string): string {
  const time = toTime(runOut.date);
  if (runOut.days / DAYS_PER_MONTH >= SHORT_RUNWAY_MONTHS) return monthYear.format(time);
  return runOut.date.slice(0, 4) === today.slice(0, 4) ? dayMonth.format(time) : dayMonthYear.format(time);
}

/** Whether cash runs out within the short runway, when the panel leads with the sentence. */
export const isShortRunway = (runOut: RunOutDay) =>
  runOut.kind === "date" && runOut.days / DAYS_PER_MONTH < SHORT_RUNWAY_MONTHS;

/**
 * One company's cash from today at its own net burn (and the changes given):
 * the Runway panel's line on Finance, and the run-out Today's opening line
 * says. Its own currency; a change in the other currency needs the summary's rate.
 */
export function companyCashPath(
  summary: Pick<FinanceSummary, "cash" | "average">,
  company: CompanyId,
  today: string,
  changes: readonly Change[] = [],
): CashPath {
  const start = runwayInputs(summary, company);
  return cashPath({
    today,
    currency: start.currency,
    cash: start.cash,
    netBurn: start.netBurn,
    changes,
    fxUsdKzt: summary.cash?.rate ?? null,
  });
}

/**
 * The group's cash in dollars from today at the group's net burn (Startup's own
 * spending plus Globex's own burn, what Startup sends Globex counted
 * once): Finance's group runway, and the run-out Today says for a viewer on
 * both companies.
 */
export function groupCashPath(group: Pick<GroupFigures, "cash" | "netBurn">, today: string): CashPath {
  const cash = group.cash.kind === "known" ? Math.round(group.cash.usd * 100) : null;
  const netBurn = group.netBurn.kind === "known" ? Math.round(group.netBurn.usd * 100) : null;
  return cashPath({ today, currency: "USD", cash, netBurn, changes: [], fxUsdKzt: null });
}
