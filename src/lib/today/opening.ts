// The opening line of Today: one or two sentences built from real figures,
// each clause a link to where it is acted on. Pure: the clock, the runway and
// the calendar are handed in, already worked out by the functions their own
// pages use (`cashPath` and `runOutLabel` for the runway, the calendar's
// own events for the day).
//
// A clause appears only when its figure is known and the viewer may see it.
// A missing runway is left out, never said as a zero; a count still loading
// leaves its clause out rather than saying "nothing".

import { isShortRunway, runOutLabel, type RunOutDay } from "@/lib/finance/runway-path";
import { addLocalDays, localDayStart } from "@/lib/work/days";

/** Where the clauses lead: the finance page, and the page's own two sections. */
export const NEEDS_ANCHOR = "needs-you";
export const DAY_ANCHOR = "your-day";

/** How the rest of the viewer's day stands, from their calendar. */
export type DayAhead =
  /** Nothing has started yet today: the first timed meeting. */
  | { kind: "first"; time: string }
  /** One has started: the next one still to come. */
  | { kind: "next"; time: string }
  /** Every one of today's is behind them. */
  | { kind: "done" }
  /** No timed meeting today at all. */
  | { kind: "none" };

export type OpeningInput = {
  /** The runway the viewer may see, or null where there is none to say. `subject`: "Group cash", "Cash". */
  runway: { subject: string; runOut: RunOutDay } | null;
  /** How many things need the viewer; null while that is still being read. */
  needs: number | null;
  /** Their day, for a viewer whose calendar is read; null otherwise. */
  day: DayAhead | null;
  /** "YYYY-MM-DD": what "this year" is for the run-out's date. */
  today: string;
};

/** One piece of the line: plain words, or a clause that leads somewhere. */
export type Segment = { text: string; href?: string };

function runwayWords(subject: string, runOut: RunOutDay, today: string): string {
  if (runOut.kind === "beyond") return `${subject} lasts beyond 24 months`;
  // The Finance page's own words: a day within two months, a month after.
  return isShortRunway(runOut)
    ? `${subject} runs out around ${runOutLabel(runOut, today)}`
    : `${subject} runs out in ${runOutLabel(runOut, today)}`;
}

function needsWords(count: number): string {
  if (count === 0) return "Nothing needs you";
  return count === 1 ? "1 thing needs you" : `${count} things need you`;
}

function dayWords(day: DayAhead): string {
  switch (day.kind) {
    case "first":
      return `your first meeting is at ${day.time}`;
    case "next":
      return `your next meeting is at ${day.time}`;
    case "done":
      return "no more meetings today";
    case "none":
      return "no meetings today";
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The line, as segments: the runway as a sentence of its own, then what needs
 * the viewer and their day as a second, joined by a semicolon. Empty when
 * nothing is known yet.
 */
export function openingLine(input: OpeningInput): Segment[] {
  const sentences: Segment[][] = [];
  if (input.runway !== null) {
    sentences.push([{ text: runwayWords(input.runway.subject, input.runway.runOut, input.today), href: "/finance" }]);
  }
  const second: Segment[] = [];
  if (input.needs !== null) second.push({ text: needsWords(input.needs), href: `#${NEEDS_ANCHOR}` });
  if (input.day !== null) second.push({ text: dayWords(input.day), href: `#${DAY_ANCHOR}` });
  if (second.length > 0) sentences.push(second);

  const out: Segment[] = [];
  sentences.forEach((clauses, s) => {
    if (s > 0) out.push({ text: " " });
    clauses.forEach((clause, c) => {
      if (c > 0) out.push({ text: "; " });
      out.push(c === 0 ? { ...clause, text: capital(clause.text) } : clause);
    });
    out.push({ text: "." });
  });
  return out;
}

/** The line as plain words. */
export const openingText = (segments: readonly Segment[]) => segments.map((part) => part.text).join("");

type TimedEvent = { allDay: boolean; startsAt: number; endsAt: number };

/**
 * Where the viewer's day stands: the first of today's timed meetings while
 * none has started, the next one once one has, or that there are none (left
 * or at all). All-day events have no time to give and are left out.
 */
export function dayAhead(events: readonly TimedEvent[], now: number, time: (at: number) => string): DayAhead {
  const start = localDayStart(now);
  const end = addLocalDays(now, 1);
  const today = events
    .filter((event) => !event.allDay && event.startsAt >= start && event.startsAt < end)
    .sort((a, b) => a.startsAt - b.startsAt);
  if (today.length === 0) return { kind: "none" };
  const coming = today.find((event) => event.startsAt > now);
  if (coming === undefined) return { kind: "done" };
  return coming === today[0] ? { kind: "first", time: time(coming.startsAt) } : { kind: "next", time: time(coming.startsAt) };
}
