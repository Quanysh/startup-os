// When a repeating obligation falls due next. Pure calendar arithmetic on
// "YYYY-MM-DD" strings, in UTC, so it is the same on the server and in a test.

import type { Recurrence } from "./obligationShape";

export type Repeating = Exclude<Recurrence, "none">;

const MONTHS: Record<Repeating, number> = { monthly: 1, quarterly: 3, annual: 12 };

/** `month` is 0-based. Day 0 of the next month is the last day of this one. */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const pad = (n: number) => String(n).padStart(2, "0");

/** The day of the month a date falls on: what a repeating date returns to. */
export function anchorDayOf(date: string): number {
  return Number(date.slice(8, 10));
}

/**
 * The next occurrence after `date`: one period later, on `anchorDay` (the day
 * of the month the obligation was first given), or on the month's last day
 * when it has no such day. With the anchor remembered, a date set for the 31st
 * goes Jan 31 → Feb 28 → Mar 31 instead of sliding to the 28th for good.
 */
export function advance(date: string, recurrence: Repeating, anchorDay?: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const index = year * 12 + (month - 1) + MONTHS[recurrence];
  const nextYear = Math.floor(index / 12);
  const nextMonth = index % 12;
  const nextDay = Math.min(anchorDay ?? day, daysIn(nextYear, nextMonth));
  return `${nextYear}-${pad(nextMonth + 1)}-${pad(nextDay)}`;
}

/**
 * Where a repeating obligation goes when it is finished: one period on from
 * the date that was due, or from `today` when it had none. Shared by the
 * mutation that does it and the button that asks first, so the date the owner
 * is shown is the date that is set.
 */
export function nextOccurrence(
  o: { due?: string | null; recurrence: Repeating; anchorDay?: number | null },
  today: string,
): { due: string; anchorDay: number } {
  const from = o.due ?? today;
  const anchorDay = o.anchorDay ?? anchorDayOf(from);
  return { due: advance(from, o.recurrence, anchorDay), anchorDay };
}

/**
 * Whether a confirmed date is still confirmed once it has rolled on.
 *
 * Only for yearly and quarterly items: those are dates fixed by a calendar
 * the owner has already confirmed (a franchise tax due every March 1, a
 * quarterly filing), so the next one is the same fact a period later. A
 * monthly date is more often a habit than a rule, and twelve unexamined
 * "confirmed" deadlines a year is how a wrong one gets trusted: it arrives
 * unconfirmed, and the owner confirms it in one click. An unconfirmed date,
 * or one worked out from no date at all, never becomes confirmed by rolling.
 */
export function rollKeepsConfirmation(recurrence: Repeating): boolean {
  return recurrence === "annual" || recurrence === "quarterly";
}
