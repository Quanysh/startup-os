// Reads a CSV export of the client register sheet into plain values. The
// owner exports the sheet from the CFO's workbook ("CSV UTF-8") first: this
// project reads no .xlsx, so it needs no spreadsheet package.
//
// The only file that touches the export's bytes, so the header report and the
// mapping are tested against a `Sheet` without a file. Every error thrown here
// is a `SheetError` whose words were written here: none quotes the file.

/**
 * A CSV cell is text, or null when empty. The wider union is what the mapping
 * and the header report accept, so they stay correct if a typed reader (a
 * number is a number, a date is a date) ever replaces this one.
 */
export type Cell = string | number | boolean | Date | null;

export type Sheet = {
  /** Trimmed text of each header cell; "" where the cell is empty. */
  headers: string[];
  /** Every row below the header row, one entry per column of the sheet. */
  rows: Cell[][];
  /** The sheet's own row number of `rows[0]`, for messages. */
  firstDataRow: number;
};

/** An error whose message was written here, and so is safe to print. */
export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

const DELIMITERS = [",", ";", "\t"] as const;
type Delimiter = (typeof DELIMITERS)[number];

/** The export as text. Excel's "CSV UTF-8" starts with a byte-order mark. */
function decode(data: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Never the decoder's own message, and never a byte of the file.
    throw new SheetError(
      'The file is not UTF-8 text. Export the register sheet as "CSV UTF-8" and pass that file.',
    );
  }
  if (text.includes("\u0000")) {
    throw new SheetError(
      'The file is not a CSV export. Export the register sheet as "CSV UTF-8" and pass that file.',
    );
  }
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/**
 * Which character separates fields: the candidate seen most often outside
 * quotes. Excel writes ";" where the comma is the decimal mark (a Russian
 * locale, say). A file with none of them is one column, read with ",".
 */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  let best: Delimiter = ",";
  for (const candidate of DELIMITERS) {
    if (counts.get(candidate)! > counts.get(best)!) best = candidate;
  }
  return best;
}

/**
 * RFC 4180, as spreadsheets write it: a field may be wrapped in double
 * quotes, and inside them a delimiter, a line break and a doubled quote ("")
 * are part of the field. Lines end in LF, CRLF or CR. Returns every record,
 * blank lines included (as a record with one empty field).
 */
export function parseCsv(text: string, delimiter: string = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  // Whether the current field began with a quote: text after its closing
  // quote is kept as written rather than reopening the quotes.
  let wasQuoted = false;
  const endField = () => {
    record.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"' && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (char === delimiter) endField();
    else if (char === "\n") endRecord();
    else if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRecord();
    } else field += char;
  }
  if (quoted) {
    throw new SheetError("The file ends inside a quoted field, so it is not a complete CSV.");
  }
  // The last line usually ends with a line break; one that does not is still a record.
  if (field !== "" || wasQuoted || record.length > 0) endRecord();
  return records;
}

/** Every record, padded to the widest, with trailing blank lines dropped. */
function grid(data: Uint8Array): { records: string[][]; width: number } {
  const text = decode(data);
  const records = parseCsv(text, detectDelimiter(text));
  while (records.length > 0 && records.at(-1)!.every((cell) => cell.trim() === "")) records.pop();
  const width = records.reduce((widest, record) => Math.max(widest, record.length), 0);
  return { records, width };
}

/** How big the export is. No cell is returned. */
export function sheetSize(data: Uint8Array): { rows: number; columns: number } {
  const { records, width } = grid(data);
  return { rows: records.length, columns: width };
}

/** `headerRow` is the 1-based row that holds the column headings. */
export function readSheet(data: Uint8Array, headerRow: number): Sheet {
  const { records, width } = grid(data);
  const padded = (record: string[]): string[] =>
    Array.from({ length: width }, (_, column) => record[column] ?? "");

  const header = records[headerRow - 1];
  const headers = header === undefined ? [] : padded(header).map((cell) => cell.trim());
  if (headers.every((heading) => heading === "")) {
    throw new SheetError(`Row ${headerRow} holds no text, so it is not the header row.`);
  }
  const rows: Cell[][] = records
    .slice(headerRow)
    // An empty cell is null: never 0, never "".
    .map((record) => padded(record).map((cell) => (cell.trim() === "" ? null : cell)));
  return { headers, rows, firstDataRow: headerRow + 1 };
}

/**
 * Whether a cell's text runs over more than one line. In a quoted CSV field
 * that is legal, but in a name it means a stray quote: the "name" has
 * swallowed the rows after it, up to the next quote in the file.
 */
export function spansLines(cell: Cell): boolean {
  return typeof cell === "string" && /[\r\n]/.test(cell);
}
