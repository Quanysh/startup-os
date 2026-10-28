// The logic of `pnpm register:headers`: whether the register export has the
// columns the push expects, where, and what kind of value sits under each.
//
// IT NEVER PRINTS A CELL OF THE FILE. Not a value, and not a heading either:
// a "header row" chosen one row out is a clinic's row, and a report that
// echoed headings would print that clinic. So the only headings in its output
// are the ones the mapping expects (`REGISTER` in customersToEnvelope.ts),
// which were typed here, each with "found in column D" or "not found".
// Everything else in the chosen row is a count. To learn the register's real
// column names, the owner reads them off the sheet and they are typed into
// the mapping; this report then confirms they match.
//
// A CSV holds text only, so a kind is read off the text: "number" and "date"
// mean a spelling the push script will accept (registerCells.ts). A fee column
// that reports "text" is one the push would refuse.

import { REGISTER, type RegisterConfig, expectedHeadings, sameHeading } from "./customersToEnvelope";
import { dayOfText, numberOfText } from "./registerCells";
import { SheetError, type Cell, type Sheet } from "./registerSheet";

export const USAGE = "Usage: pnpm register:headers <register.csv> [--header-row <n>]";

const KINDS = ["text", "number", "date", "empty"] as const;
type Kind = (typeof KINDS)[number];

function kindOf(cell: Cell): Kind {
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return "empty";
  if (cell instanceof Date) return "date";
  if (typeof cell === "number") return "number";
  if (typeof cell !== "string") return "text";
  if (dayOfText(cell) !== null) return "date";
  if (numberOfText(cell) !== null) return "number";
  return "text";
}

/** A, B, … Z, AA, AB, … as the spreadsheet names its columns. */
function letter(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** The kinds of value in one column, as counts: "number ×2, empty ×1". */
function kindsBelow(sheet: Sheet, column: number): string {
  const counts = new Map<Kind, number>();
  for (const row of sheet.rows) {
    const kind = kindOf(row[column] ?? null);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return KINDS.filter((kind) => counts.has(kind))
    .map((kind) => `${kind} ×${counts.get(kind)}`)
    .join(", ");
}

/**
 * The report, or null when the row holds a number or a date and so cannot be
 * the header row. Every heading in it comes from `expected`, never the sheet.
 */
export function headerReport(
  sheet: Sheet,
  headerRow: number,
  expected: readonly string[],
): string[] | null {
  if (sheet.headers.some((cell) => numberOfText(cell) !== null || dayOfText(cell) !== null)) {
    return null;
  }
  const claimed = new Set<number>();
  const lines = expected.map((heading) => {
    const found = sheet.headers.flatMap((cell, column) =>
      sameHeading(cell, heading) ? [column] : [],
    );
    for (const column of found) claimed.add(column);
    if (found.length === 0) return `"${heading}": not found.`;
    if (found.length > 1) {
      return `"${heading}": found ${found.length} times (columns ${found.map(letter).join(", ")}).`;
    }
    const column = found[0]!;
    const below = sheet.rows.length === 0 ? "" : ` Below it: ${kindsBelow(sheet, column)}.`;
    return `"${heading}": found in column ${letter(column)}.${below}`;
  });
  const others = sheet.headers.filter((cell, column) => cell !== "" && !claimed.has(column)).length;
  const below = sheet.rows.length;
  return [
    `Row ${headerRow} read as the header row, with ${below} ${below === 1 ? "row" : "rows"} below it.`,
    ...lines,
    `${others} other non-empty ${others === 1 ? "cell" : "cells"} in row ${headerRow}.`,
  ];
}

export type HeaderDeps = {
  readFile: (path: string) => Uint8Array;
  readSheet: (data: Uint8Array, headerRow: number) => Sheet;
  print: (line: string) => void;
  printError: (line: string) => void;
  /** The column mapping. Tests pass their own; the wrapper leaves it out. */
  config?: RegisterConfig;
};

/** Returns the process exit code. */
export function run(argv: string[], deps: HeaderDeps): number {
  const { print, printError } = deps;
  const config = deps.config ?? REGISTER;
  const paths: string[] = [];
  let headerRow = config.headerRow;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--header-row") headerRow = Number(argv[++i]);
    else if (arg.startsWith("-")) {
      printError(USAGE);
      return 1;
    } else paths.push(arg);
  }
  if (paths.length !== 1 || !Number.isInteger(headerRow) || headerRow < 1) {
    printError(USAGE);
    return 1;
  }

  const path = paths[0]!;
  let data: Uint8Array;
  try {
    data = deps.readFile(path);
  } catch {
    // The path is what the caller typed. The system's own message is not printed.
    printError(`Could not read ${path}.`);
    return 1;
  }

  try {
    const sheet = deps.readSheet(data, headerRow);
    const report = headerReport(sheet, headerRow, expectedHeadings(config));
    if (report === null) {
      printError(`Row ${headerRow} holds a number or a date, so it is not the header row.`);
      return 1;
    }
    for (const line of report) print(line);
    return 0;
  } catch (error) {
    // A SheetError's words were written by the reader. Anything else may quote the file.
    printError(error instanceof SheetError ? error.message : "The export could not be read.");
    return 1;
  }
}
