// How often each source is expected to arrive, and the fixed words for a run
// that went wrong. Each source's cadence is declared once, on its entry in
// convex/connectors/manifest.ts; the page headers (src/lib/source-freshness.ts)
// and Settings › Sources both read it from there, so they cannot disagree.
//
// Pure, and read by the server and the browser alike. Nothing here reads a
// clock: whether a source is late is decided in the browser with `useNow()`.

import { SOURCES } from "../connectors/manifest";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * - every: pulled on an interval (`crons.interval`).
 * - daily: read once a day at a time of day, in UTC (`crons.daily`, or the
 *   morning connector run, which reads at about 11:00 in Almaty: 06:00 UTC).
 * - pushed: pushed to the OS when it changes, and expected that often.
 * - typed: typed into the OS by a person. No interval: nothing is late.
 */
export type Cadence =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; hourUtc: number; minuteUtc: number }
  | { kind: "pushed"; everyDays: number }
  | { kind: "typed" };

// A run takes a moment and a scheduled session starts when the machine is
// awake: a source is late only past its interval and this much.
const ALLOWANCE: Record<Exclude<Cadence["kind"], "typed">, number> = {
  every: 5 * MINUTE,
  daily: HOUR,
  pushed: 6 * HOUR,
};

/**
 * How long after its last good read a source is still on time, or null for
 * typed-in figures, which are never late. Past this it is late; past twice
 * this it is out of date (src/lib/source-freshness.ts).
 */
export function expectedMs(cadence: Cadence): number | null {
  switch (cadence.kind) {
    case "every":
      return cadence.minutes * MINUTE + ALLOWANCE.every;
    case "daily":
      return DAY + ALLOWANCE.daily;
    case "pushed":
      return cadence.everyDays * DAY + ALLOWANCE.pushed;
    case "typed":
      return null;
  }
}

/** A source's cadence, from the manifest; null for an id it does not hold. */
export function cadenceOf(source: string): Cadence | null {
  return SOURCES.find((s) => s.id === source)?.cadence ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time of day, 24-hour, in a time zone: the viewer's own when none is given. */
function clockIn(hourUtc: number, minuteUtc: number, timeZone?: string): string {
  const at = Date.UTC(2026, 0, 5, hourUtc, minuteUtc);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return `${pad(part("hour"))}:${pad(part("minute"))}`;
}

/**
 * The cadence as a sentence's start: "Read daily at about 11:00" (in the
 * viewer's time zone, or the one given), "Read every 15 minutes",
 * "Pushed, expected daily", "Typed in when it changes".
 */
export function cadenceWords(cadence: Cadence, timeZone?: string): string {
  switch (cadence.kind) {
    case "every":
      return cadence.minutes === 60
        ? "Read every hour"
        : `Read every ${cadence.minutes} minutes`;
    case "daily":
      return `Read daily at about ${clockIn(cadence.hourUtc, cadence.minuteUtc, timeZone)}`;
    case "pushed":
      if (cadence.everyDays === 1) return "Pushed, expected daily";
      if (cadence.everyDays >= 28 && cadence.everyDays <= 31) return "Pushed, expected monthly";
      return `Pushed, expected every ${cadence.everyDays} days`;
    case "typed":
      return "Typed in when it changes";
  }
}

/**
 * Why a source's last run is not a good one, as a key the page turns into a
 * fixed sentence. Only the run's state decides it: the message a run stored
 * is the run log's (it can name a variable) and never leaves Settings › Sources.
 */
export const FAILURE_SENTENCES = {
  failed: "The last read failed, so what is shown is from the last good read.",
  empty: "The last read returned nothing, so nothing was changed.",
} as const;
export type FailureKey = keyof typeof FAILURE_SENTENCES;

/** The failure key for a stored run state; null when the last run did not fail. */
export function failureKeyOf(state: string | null | undefined): FailureKey | null {
  if (state === "error") return "failed";
  if (state === "empty") return "empty";
  return null;
}
