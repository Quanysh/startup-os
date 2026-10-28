// Canonical UTC period buckets. Every metric snapshot is keyed by the start
// date of its bucket ("YYYY-MM-DD"), so re-running a sync for the same period
// overwrites one row instead of appending another.

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Start of the bucket containing `at`: the day itself, its Monday, or the 1st. */
export function periodStart(period: Period, at: Date | number): string {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (period === "month") return isoDate(new Date(Date.UTC(y, m, 1)));
  if (period === "week") {
    // getUTCDay(): Sunday = 0. Shift so Monday = 0 … Sunday = 6.
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return isoDate(new Date(Date.UTC(y, m, day - sinceMonday)));
  }
  return isoDate(new Date(Date.UTC(y, m, day)));
}

/** True when `value` is a real date and is the first day of a `period` bucket. */
export function isCanonicalPeriodStart(period: Period, value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // `new Date("2026-02-30")` rolls over to March; the round-trip catches it.
  if (isoDate(parsed) !== value) return false;
  return periodStart(period, parsed) === value;
}

/** The bucket immediately before `start` (which must itself be canonical). */
export function previousPeriodStart(period: Period, start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (period === "month") {
    return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
  }
  return isoDate(new Date(d.getTime() - (period === "week" ? 7 : 1) * DAY_MS));
}

/** The bucket immediately after `start`: the moment `start`'s period ends. */
export function nextPeriodStart(period: Period, start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (period === "month") {
    return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  }
  return isoDate(new Date(d.getTime() + (period === "week" ? 7 : 1) * DAY_MS));
}
