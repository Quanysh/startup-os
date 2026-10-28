// Days as the owner sees them: in the browser's own time zone. Pure; every
// function takes the instant it works from, and none reads a clock.

import type { RecordOf } from "@convex/lib/mirrorRules";
import { localIsoDate } from "@/lib/dates";

export type CalendarEvent = RecordOf<"event">;

/** How many days the week view shows: today and the seven after it. */
export const WEEK_DAYS = 8;

/** Local midnight at or before `at`. */
export function localDayStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Local midnight `days` calendar days after the day `at` falls in. By the
 * calendar, not by adding 24 hours: a day is 23 or 25 hours long twice a year.
 */
export function addLocalDays(at: number, days: number): number {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime();
}

/**
 * The span the week view asks for. It changes once a day (at local midnight),
 * so the subscription it feeds stays the same from one tick to the next.
 */
export function weekSpan(now: number): { from: number; to: number } {
  return { from: localDayStart(now), to: addLocalDays(now, WEEK_DAYS) };
}

/** The starts of the days the week view shows, today first. */
export function weekDays(now: number): number[] {
  return Array.from({ length: WEEK_DAYS }, (_, n) => addLocalDays(now, n));
}

/**
 * The events on one local day, all-day ones first, then by start time. An
 * all-day event belongs to the calendar's own dates (its end is exclusive),
 * whatever the time zone; a timed one to every day it overlaps.
 */
export function eventsOn(events: readonly CalendarEvent[], dayStart: number): CalendarEvent[] {
  const day = localIsoDate(dayStart);
  const nextDay = addLocalDays(dayStart, 1);
  const on = events.filter((event) => {
    if (event.allDay) {
      return (
        event.startDate !== undefined &&
        event.endDate !== undefined &&
        event.startDate <= day &&
        day < event.endDate
      );
    }
    // A meeting with no length still happens on the day it starts.
    return event.startsAt < nextDay && (event.endsAt > dayStart || event.startsAt >= dayStart);
  });
  return on.sort(
    (a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt || a.endsAt - b.endsAt,
  );
}

/** A time of day in the browser's own zone and style: "3:00 PM", "15:00". */
export function timeLabel(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
}

/** "Today", "Tomorrow", then the weekday and date: "Wednesday, Oct 14". */
export function dayHeading(dayStart: number, now: number): string {
  if (dayStart === localDayStart(now)) return "Today";
  if (dayStart === addLocalDays(now, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(dayStart);
}
