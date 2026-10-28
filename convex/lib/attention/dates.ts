/**
 * The calendar date where the user is, as "YYYY-MM-DD".
 *
 * Use this for anything a person thinks of as "today": a due date, the
 * default in a date field. `toISOString()` gives the UTC date instead, which
 * is already tomorrow by late afternoon in the Americas and still yesterday
 * in the early morning in Almaty.
 */
export function localIsoDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Whole days from one calendar date to another ("YYYY-MM-DD"), negative when
 * `to` is the earlier. Both are read as UTC midnights, so daylight saving
 * cannot make a day 23 hours long.
 */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}
