// "When was this page's data last updated?", answered against a ticking clock
// (`useNow()`), never inside a query: a query's result is cached until what it
// read changes, so a source would stay "on time" for ever.
//
// A reading is one source a page draws on, as `freshness.forPage` sends it
// (or, on a typed-in page, the newest change among the rows the page reads).
// Its cadence is the manifest's (convex/lib/cadence.ts): the header and
// Settings › Sources judge "late" by the same interval.

import { expectedMs, type Cadence, type FailureKey } from "@convex/lib/cadence";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type Reading = {
  id: string;
  label: string;
  cadence: Cadence;
  /** The last good read (or, typed in, the last change); null for none. */
  lastOkAt: number | null;
  lastRunAt: number | null;
  /** Set when the last run failed: a key, never what the run stored. */
  failureKey: FailureKey | null;
};

/**
 * - fresh: read within its cadence (exactly at it included).
 * - late: past its cadence, within twice it.
 * - stale: past twice its cadence.
 * - failed: the last run failed, whenever the last good one was.
 * - never: nothing read (or typed) yet.
 * - typed: typed in; never late, so no colour.
 */
export type FreshnessState = "fresh" | "late" | "stale" | "failed" | "never" | "typed";
export type FreshnessTone = "good" | "watch" | "weak" | "neutral";

export const STATE_TONE: Record<FreshnessState, FreshnessTone> = {
  fresh: "good",
  late: "watch",
  stale: "weak",
  failed: "weak",
  never: "neutral",
  typed: "neutral",
};

/** The state's own word, for the popover's row. */
export const STATE_WORDS: Record<FreshnessState, string> = {
  fresh: "On time",
  late: "Late",
  stale: "Out of date",
  failed: "Failed",
  never: "Not read yet",
  typed: "Typed in",
};

/** The same, inside a sentence ("1 late, 2 out of date"). */
const STATE_NOTE: Partial<Record<FreshnessState, string>> = {
  late: "late",
  stale: "out of date",
  failed: "failed",
};

export function classify(
  reading: Pick<Reading, "cadence" | "lastOkAt" | "failureKey">,
  now: number,
): FreshnessState {
  const limit = expectedMs(reading.cadence);
  if (limit === null) return reading.lastOkAt === null ? "never" : "typed";
  if (reading.failureKey !== null) return "failed";
  if (reading.lastOkAt === null) return "never";
  const age = now - reading.lastOkAt;
  if (age <= limit) return "fresh";
  if (age <= 2 * limit) return "late";
  return "stale";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago", "2 months ago". */
export function agoWords(now: number, at: number): string {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${plural(Math.floor(age / MINUTE), "minute")} ago`;
  if (age < DAY) return `${plural(Math.floor(age / HOUR), "hour")} ago`;
  if (age < 60 * DAY) return `${plural(Math.floor(age / DAY), "day")} ago`;
  return `${plural(Math.floor(age / (30 * DAY)), "month")} ago`;
}

/**
 * When a source pushed once a day last arrived, by the viewer's day (or the
 * time zone given): "this morning", "this afternoon", "this evening",
 * "yesterday", "3 days ago". Its hours say little: it changes once a day.
 */
export function dayWords(now: number, at: number, timeZone?: string): string {
  const day = (t: number) =>
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(t);
  const days = Math.round((Date.parse(day(now)) - Date.parse(day(at))) / DAY);
  if (days <= 0) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(at));
    return hour < 12 ? "this morning" : hour < 18 ? "this afternoon" : "this evening";
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** A source pushed once a day: its age is said by the day. */
const isDailyPush = (cadence: Cadence) => cadence.kind === "pushed" && cadence.everyDays === 1;

/**
 * A moment in the viewer's time zone (or the one given), 24-hour: "Oct 14,
 * 11:02", with the year when it is not this one.
 */
export function atWords(at: number, now: number, timeZone?: string): string {
  const year = (t: number) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(t);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(year(at) === year(now) ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
}

const RANK: Record<FreshnessTone, number> = { good: 0, neutral: 1, watch: 2, weak: 3 };

export type Headline = {
  /** What the header says: "Updated 2 hours ago", "Oldest source updated 3 days ago". */
  text: string;
  /** How many are not on time, in words beside it ("late", "1 failed, 1 out of date"); null when none. */
  note: string | null;
  /** The dot: the worst of the page's sources. */
  tone: FreshnessTone;
  /** The whole of it, for the button's `aria-label`. */
  sentence: string;
};

const SHOW = "Show where this page's figures come from.";

/**
 * The header's line for a page's readings, or null for a page with none.
 *
 * One source: when it was updated, and its state in a word unless on time.
 * Several: the oldest of them in the words, the worst in the dot, and how
 * many are not on time. Typed-in figures beside read sources are listed in
 * the popover and leave the line to the read ones; a page that is only typed
 * in says so and when it last changed, with no colour.
 */
export function headline(readings: readonly Reading[], now: number): Headline | null {
  if (readings.length === 0) return null;
  const read = readings.filter((r) => expectedMs(r.cadence) !== null);

  if (read.length === 0) {
    const newest = lastChange(readings.flatMap((r) => (r.lastOkAt === null ? [] : [{ changedAt: r.lastOkAt }])));
    const text =
      newest === null ? "Nothing typed in yet" : `Typed in · last change ${agoWords(now, newest)}`;
    return { text, note: null, tone: "neutral", sentence: `${text}. ${SHOW}` };
  }

  const states = read.map((r) => classify(r, now));
  const tone = states
    .map((state) => STATE_TONE[state])
    .reduce((worst, t) => (RANK[t] > RANK[worst] ? t : worst));

  let text: string;
  let note: string | null;
  if (read.length === 1) {
    const [only] = read as [Reading];
    text =
      only.lastOkAt === null
        ? "Not read yet"
        : `Updated ${isDailyPush(only.cadence) ? dayWords(now, only.lastOkAt) : agoWords(now, only.lastOkAt)}`;
    note = STATE_NOTE[states[0]!] ?? null;
  } else {
    const never = read.filter((r) => r.lastOkAt === null).length;
    const oldest = Math.min(...read.flatMap((r) => (r.lastOkAt === null ? [] : [r.lastOkAt])));
    text =
      never > 0
        ? `${plural(never, "source")} not read yet`
        : `Oldest source updated ${agoWords(now, oldest)}`;
    const counts = (["failed", "stale", "late"] as const)
      .map((state) => [state, states.filter((s) => s === state).length] as const)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${n} ${STATE_NOTE[state]}`);
    note = counts.length > 0 ? counts.join(", ") : null;
  }
  const said = note ?? (tone === "good" ? "on time" : null);
  return { text, note, tone, sentence: `${text}${said === null ? "" : `, ${said}`}. ${SHOW}` };
}

/**
 * When a board's own deals last changed: the newest activity among the cards
 * made here (made, moved, a next step or a note written). A mirrored card's
 * activity is its source's to say, so it plays no part. null with none.
 */
export function boardLastChange(
  board: Record<string, readonly { mirrored: boolean; lastActivityAt: number | null }[]>,
): number | null {
  return lastChange(
    Object.values(board).flatMap((cards) =>
      cards.flatMap((card) =>
        card.mirrored || card.lastActivityAt === null ? [] : [{ changedAt: card.lastActivityAt }],
      ),
    ),
  );
}

/** The newest change among rows the page already reads; null with none. */
export function lastChange(rows: readonly { changedAt: number }[]): number | null {
  return rows.reduce<number | null>(
    (newest, row) => (newest === null || row.changedAt > newest ? row.changedAt : newest),
    null,
  );
}
