/**
 * A table as a CSV file that opens cleanly in Excel, Google Sheets and
 * Numbers. Pure: rows of strings in, the file's text out. What the rows hold
 * is decided elsewhere (`./table-export`, from the table on the screen).
 *
 * - RFC 4180: a field with a comma, a quote or a line break is quoted, and a
 *   quote inside it doubled. Lines end in CRLF.
 * - A UTF-8 byte-order mark first, or Excel reads Cyrillic and ₸ as Latin-1.
 * - Formula injection: a field a spreadsheet would run as a formula (one that
 *   begins with `=`, `+`, `@`, a tab or a carriage return, or a `-` not
 *   followed by a digit, `$` or `₸`) is prefixed with `'`. A shown figure
 *   such as `$1,075.00` or `-$5,582` is left as it is.
 * - The app writes a negative with the minus sign (U+2212). Before a figure it
 *   becomes a hyphen, so a spreadsheet reads the number; nothing else changes.
 */

const BOM = "﻿";
const CRLF = "\r\n";
const MINUS = "−";

/** Begins with a character a spreadsheet takes as the start of a formula. */
const FORMULA = /^(?:[=+@\t\r]|-(?![0-9$₸]))/;
/** The app's minus sign at the start of a figure. */
const MINUS_FIGURE = new RegExp(`^${MINUS}(?=[0-9$₸])`);
const NEEDS_QUOTES = /[",\r\n]/;

/** One field, ready for the file: signed, guarded, then quoted. */
export function csvCell(value: string): string {
  const signed = value.replace(MINUS_FIGURE, "-");
  const guarded = FORMULA.test(signed) ? `'${signed}` : signed;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** The whole file: the mark, then one CRLF-ended line per row. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return BOM + rows.map((row) => row.map(csvCell).join(",") + CRLF).join("");
}

const SLUG_MAX = 60;

/**
 * A name fit for a file: lower case, letters and digits of any alphabet,
 * everything else run together into one hyphen. Accents come off Latin
 * letters only (a Cyrillic й or ё is a letter of its own).
 */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX);
  const lastBreak = cut.lastIndexOf("-");
  return (lastBreak > SLUG_MAX / 2 ? cut.slice(0, lastBreak) : cut).replace(/-+$/, "");
}

/** `all-costs-2026-10-15.csv`: the table's name and the browser's date today. */
export function csvFileName(name: string, today: Date): string {
  const day = [
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  return `${slugOf(name) || "table"}-${day}.csv`;
}
