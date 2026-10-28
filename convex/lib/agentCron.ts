// A declarative agent's schedule (Agents Protocol v1.3, docs/agents-protocol.md):
// five fields, in UTC, of numbers only:
//
//   minute (0–59)  hour (0–23)  day of the month (1–31)  month (1–12)  day of the week (0–7, 0 and 7 Sunday)
//
// Each field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a
// list of those joined by commas. Where both days are set (neither starts
// with `*`), a day either one names runs it, as cron always has. No names
// (`MON`, `JAN`), no `@daily`, no seconds and no time zone: the project's
// runner (`runScheduled(now)`) reads the same five fields in UTC.
//
// Pure: the page shows the next runs from the same functions the server
// checks a publish with.

/** The longest schedule taken, in characters. */
export const MAX_CRON_LENGTH = 100;
/** How far ahead a schedule is looked for: a leap day comes round within it. */
const HORIZON_DAYS = 8 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 7 },
] as const;

export const CRON_WORDS = {
  fields: "A schedule is five fields in UTC: minute, hour, day of the month, month and day of the week.",
  field: (name: string) => `The ${name} field is not *, a number in range, a range, a step or a list of those.`,
  tooLong: `A schedule is at most ${MAX_CRON_LENGTH} characters.`,
  never: "That schedule never runs.",
} as const;

export type Cron = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 to 6, Sunday 0 (a 7 is read as 0). */
  weekdays: ReadonlySet<number>;
  /** Whether the day of the month, and the day of the week, were set (not `*…`). */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
};

const NUMBER = /^(0|[1-9][0-9]?)$/;

/** One field's values, or null where it breaks the form or its range. */
function fieldValues(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (range === undefined || range === "" || extra !== undefined) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!NUMBER.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1 || step > max - min + 1) return null;
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else {
      const [a, b, more] = range.split("-");
      if (a === undefined || more !== undefined || !NUMBER.test(a)) return null;
      from = Number(a);
      if (b === undefined) {
        // A step needs a range: "5/10" is not taken.
        if (stepText !== undefined) return null;
        to = from;
      } else {
        if (!NUMBER.test(b)) return null;
        to = Number(b);
      }
      if (from < min || to > max || from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

type Parsed = { ok: true; cron: Cron } | { ok: false; problem: string };

function parse(text: string): Parsed {
  if (text.length > MAX_CRON_LENGTH) return { ok: false, problem: CRON_WORDS.tooLong };
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") return { ok: false, problem: CRON_WORDS.fields };
  const sets: Set<number>[] = [];
  for (const [i, field] of FIELDS.entries()) {
    const values = fieldValues(parts[i]!, field.min, field.max);
    if (values === null) return { ok: false, problem: CRON_WORDS.field(field.name) };
    sets.push(values);
  }
  const weekdays = new Set([...sets[4]!].map((day) => day % 7));
  return {
    ok: true,
    cron: {
      minutes: sets[0]!,
      hours: sets[1]!,
      days: sets[2]!,
      months: sets[3]!,
      weekdays,
      dayRestricted: !parts[2]!.startsWith("*"),
      weekdayRestricted: !parts[4]!.startsWith("*"),
    },
  };
}

/** A schedule's values, or null where it is not one. */
export function parseCron(text: string): Cron | null {
  const parsed = parse(text);
  return parsed.ok ? parsed.cron : null;
}

/** Whether a schedule runs on a UTC day. */
function runsOn(cron: Cron, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const byDay = cron.days.has(day.getUTCDate());
  const byWeekday = cron.weekdays.has(day.getUTCDay());
  if (cron.dayRestricted && cron.weekdayRestricted) return byDay || byWeekday;
  if (cron.dayRestricted) return byDay;
  if (cron.weekdayRestricted) return byWeekday;
  return true;
}

function runsOf(cron: Cron, after: number, count: number): number[] {
  const out: number[] = [];
  // The first whole minute strictly after `after`.
  const first = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const startDay = Math.floor(first / DAY_MS) * DAY_MS;
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  for (let d = 0; d < HORIZON_DAYS && out.length < count; d += 1) {
    const dayStart = startDay + d * DAY_MS;
    if (!runsOn(cron, new Date(dayStart))) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const time = dayStart + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
        if (time < first) continue;
        out.push(time);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** The next `count` times a schedule runs, strictly after `after` (ms, UTC); none for a bad schedule. */
export function nextRuns(text: string, after: number, count: number): number[] {
  const cron = parseCron(text);
  return cron === null ? [] : runsOf(cron, after, count);
}

/** A fixed moment the "never runs" check looks ahead from, so the answer does not move with the clock. */
const NEVER_FROM = Date.UTC(2024, 0, 1);

/** Why a schedule cannot be one, in fixed words, or null. */
export function cronProblem(text: string): string | null {
  const parsed = parse(text);
  if (!parsed.ok) return parsed.problem;
  if (runsOf(parsed.cron, NEVER_FROM, 1).length === 0) return CRON_WORDS.never;
  return null;
}

/**
 * The shortest time between two runs of a schedule, in minutes, by its
 * minutes and hours alone (a run late one day and early the next counts as
 * close): what a schedule can cost at most. Null for a bad schedule.
 */
export function minGapMinutes(text: string): number | null {
  const cron = parseCron(text);
  if (cron === null) return null;
  const times: number[] = [];
  for (const hour of [...cron.hours].sort((a, b) => a - b)) {
    for (const minute of [...cron.minutes].sort((a, b) => a - b)) times.push(hour * 60 + minute);
  }
  if (times.length === 0) return null;
  let gap = times[0]! + 24 * 60 - times[times.length - 1]!;
  for (let i = 1; i < times.length; i += 1) gap = Math.min(gap, times[i]! - times[i - 1]!);
  return gap;
}
