// What a cell of the register export means. A CSV carries text only, so a
// number and a date have to be read out of text, and a wrong reading here
// would be a wrong fee or a wrong payment date on screen. Both readers
// therefore accept only spellings with one possible meaning and refuse the
// rest: the caller reports a refused cell by column and row, never by value.

import { isCanonicalPeriodStart } from "../convex/lib/periods";

// Digits, optionally grouped in threes by a space (plain, no-break or narrow
// no-break, as Excel writes them), with at most two decimals after "." or ",".
// Not accepted, because each has two readings: "200,000" and "1.234" (a
// thousands mark or a decimal mark?), and "200,000.50".
const NUMBER = /^-?(?:\d+|\d{1,3}(?:[   ]\d{3})+)(?:[.,]\d{1,2})?$/;

/** The number a cell's text spells, or null when it is not one unambiguously. */
export function numberOfText(text: string): number | null {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return null;
  const value = Number(trimmed.replace(/[   ]/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * The calendar date a cell's text spells, as "YYYY-MM-DD", or null. Accepted:
 * "2026-10-01" and "01.10.2026". Not accepted: "10/01/2026" (January or
 * October?), a spreadsheet's day number, and a date that does not exist.
 */
export function dayOfText(text: string): string | null {
  const trimmed = text.trim();
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  const iso = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : trimmed;
  return isCanonicalPeriodStart("day", iso) ? iso : null;
}
