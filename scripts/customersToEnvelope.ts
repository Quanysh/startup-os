// Turns a CSV export of the CFO workbook's client register sheet into an
// ingest envelope. Pure, so the mapping is tested without a file or a network.
//
// An allow-list: it reads the columns named in the config and no others. A
// column about a clinic's patients, staff or contacts is never read, so it
// cannot be sent. Every problem it reports is a column heading from the
// config, a count and sheet row numbers: never a cell's value.

import {
  type CustomerStatus,
  type Market,
  REGISTER_SOURCE,
} from "../convex/lib/customerShape";
import { type CustomersEnvelope, INGEST_VERSION } from "../convex/lib/ingestSchema";
import { MAX_CLINIC_NAME_LENGTH } from "../convex/lib/limits";
import { dayOfText, numberOfText } from "./registerCells";
import { spansLines, type Cell, type Sheet } from "./registerSheet";

export type RegisterConfig = {
  /** The row of the export that holds the column headings (1 is the first). */
  headerRow: number;
  /** Field → the column heading that holds it. Matched ignoring case and spacing. */
  columns: {
    name: string;
    market: string;
    status: string;
    monthlyFee: string;
    lastPaymentDate: string;
    amountOwed: string;
    contractDate: string;
    baaDate: string;
    /** Only if the register says when a clinic last used the product. */
    lastUsageDate?: string;
  };
  /** The words the register uses, lower case → what they mean. */
  markets: Record<string, Market>;
  statuses: Record<string, CustomerStatus>;
};

// ─────────────────────────────────────────────────────────────────────────────
// ASSUMED. Written before anyone had seen the register's headings: nobody has
// opened the register to write this. Before the first real push, ask the owner
// for the register's real column names, type them in below in place of these,
// then run `pnpm register:headers` on the export: it reports, for each heading
// below, whether the header row holds it, and prints nothing else from the
// file. Then delete this banner. Until
// then the script refuses the real export with `The sheet has no "…" column.`,
// which is the safe failure.
// ─────────────────────────────────────────────────────────────────────────────
export const REGISTER: RegisterConfig = {
  headerRow: 1,
  columns: {
    name: "Clinic",
    market: "Market",
    status: "Status",
    monthlyFee: "Monthly fee",
    lastPaymentDate: "Last payment",
    amountOwed: "Owed",
    contractDate: "Contract date",
    baaDate: "BAA date",
  },
  markets: { us: "us", usa: "us", kz: "kz", kazakhstan: "kz" },
  statuses: { active: "active", paused: "paused", churned: "churned" },
};

export type MappingSummary = {
  clinics: number;
  /** Non-blank rows below the first blank row: a totals row, a second table. */
  rowsNotRead: number;
  columnsRead: string[];
  columnsNotRead: string[];
};

export type Mapped =
  | { ok: true; envelope: CustomersEnvelope; summary: MappingSummary }
  | { ok: false; problems: string[] };

type Field = keyof RegisterConfig["columns"];
const FIELDS: readonly Field[] = [
  "name",
  "market",
  "status",
  "monthlyFee",
  "lastPaymentDate",
  "amountOwed",
  "contractDate",
  "baaDate",
  "lastUsageDate",
];
const DATE_FIELDS = ["lastPaymentDate", "contractDate", "baaDate", "lastUsageDate"] as const;
const MONEY_FIELDS = ["monthlyFee", "amountOwed"] as const;

/** Longer than this is not a column heading, and is not printed. */
const MAX_HEADING_LENGTH = 40;
const ROWS_LISTED = 10;

const BAD = Symbol("bad");
type Bad = typeof BAD;

const norm = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
/** Whether a cell of the header row is the heading the mapping expects. */
export const sameHeading = (cell: string, heading: string) => norm(cell) === norm(heading);

/** The headings the mapping expects, in the order the fields are read. */
export function expectedHeadings(config: RegisterConfig = REGISTER): string[] {
  return FIELDS.flatMap((field) => {
    const heading = config.columns[field];
    return heading === undefined ? [] : [heading];
  });
}

const isBlank = (cell: Cell) => cell === null || (typeof cell === "string" && cell.trim() === "");

/**
 * A calendar date: "YYYY-MM-DD" or "DD.MM.YYYY" text (a CSV cell), or a date
 * value. Anything with two readings is refused (registerCells.ts).
 */
function dayOf(cell: Cell): string | undefined | Bad {
  if (isBlank(cell)) return undefined;
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? BAD : cell.toISOString().slice(0, 10);
  }
  // A bare number is a date cell that lost its format; guessing its epoch is not safe.
  if (typeof cell !== "string") return BAD;
  return dayOfText(cell) ?? BAD;
}

/**
 * A non-negative amount: a number, or text that spells one unambiguously (a
 * CSV cell). "200,000" is refused, not guessed at. A blank is left out.
 */
function amountOf(cell: Cell): number | undefined | Bad {
  if (isBlank(cell)) return undefined;
  const value = typeof cell === "number" ? cell : typeof cell === "string" ? numberOfText(cell) : null;
  return value !== null && Number.isFinite(value) && value >= 0 ? value : BAD;
}

function word<T>(cell: Cell, words: Record<string, T>): T | Bad {
  if (typeof cell !== "string") return BAD;
  // Object.hasOwn: "constructor" in a cell must not find Object's own.
  const key = norm(cell);
  return Object.hasOwn(words, key) ? words[key]! : BAD;
}

export function customersToEnvelope(
  sheet: Sheet,
  observedAt: Date,
  config: RegisterConfig = REGISTER,
): Mapped {
  // Where each field's column is. Headings in messages are the config's.
  const at = new Map<Field, number>();
  const headingProblems: string[] = [];
  for (const field of FIELDS) {
    const heading = config.columns[field];
    if (heading === undefined) continue;
    const found = sheet.headers.flatMap((h, index) => (norm(h) === norm(heading) ? [index] : []));
    if (found.length === 0) headingProblems.push(`The sheet has no "${heading}" column.`);
    else if (found.length > 1) {
      headingProblems.push(`The sheet has ${found.length} columns headed "${heading}".`);
    } else at.set(field, found[0]!);
  }
  if (headingProblems.length > 0) return { ok: false, problems: headingProblems };

  // problem → the sheet rows it was found on.
  const flagged = new Map<string, number[]>();
  const flag = (field: Field, what: string, row: number) => {
    const problem = `Column "${config.columns[field]}": ${what}`;
    flagged.set(problem, [...(flagged.get(problem) ?? []), row]);
  };

  // A name over more than one line is a broken quote, and the rows it has
  // swallowed are clinics that would be archived as missing. Nothing below it
  // can be trusted, so it is refused before any row is mapped. The row is the
  // record's place in the export; the name is not printed.
  const nameColumn = at.get("name")!;
  const broken = sheet.rows.findIndex((cells) => spansLines(cells[nameColumn] ?? null));
  if (broken !== -1) {
    return {
      ok: false,
      problems: [
        `Row ${sheet.firstDataRow + broken}: a name spans more than one line; check the file's quotes.`,
      ],
    };
  }

  const customers: CustomersEnvelope["customers"] = [];
  let ended = false;
  let rowsNotRead = 0;
  sheet.rows.forEach((cells, index) => {
    const rowNumber = sheet.firstDataRow + index;
    const wholeRowBlank = cells.every(isBlank);
    // The list ends at its first blank row. What lies below (a totals row, a
    // second table) is counted, and not read.
    if (ended) {
      if (!wholeRowBlank) rowsNotRead += 1;
      return;
    }
    if (wholeRowBlank) {
      ended = true;
      return;
    }
    // Only the allow-listed columns are ever looked at.
    const cell = (field: Field): Cell => {
      const column = at.get(field);
      return column === undefined ? null : (cells[column] ?? null);
    };

    const rawName = cell("name");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name === "") {
      flag("name", "no clinic name", rowNumber);
      return;
    }
    if (name.length > MAX_CLINIC_NAME_LENGTH) {
      flag("name", `a name over ${MAX_CLINIC_NAME_LENGTH} characters`, rowNumber);
      return;
    }

    const market = word(cell("market"), config.markets);
    if (market === BAD) flag("market", "not a market this script knows", rowNumber);
    const status = word(cell("status"), config.statuses);
    if (status === BAD) flag("status", "not a status this script knows", rowNumber);

    const row: Record<string, string | number> = { name };
    for (const field of MONEY_FIELDS) {
      const value = amountOf(cell(field));
      if (value === BAD) flag(field, "not a number, or negative", rowNumber);
      else if (value !== undefined) row[field] = value;
    }
    for (const field of DATE_FIELDS) {
      const value = dayOf(cell(field));
      if (value === BAD) flag(field, "not a date", rowNumber);
      else if (value !== undefined) row[field] = value;
    }
    if (market !== BAD && status !== BAD) {
      customers.push({ ...row, name, market, status } as CustomersEnvelope["customers"][number]);
    }
  });

  // Any flag refuses the whole push: a clinic is never sent with a bad cell
  // quietly dropped.
  if (flagged.size > 0) {
    const problems = [...flagged].map(([problem, rows]) => {
      const listed = rows.slice(0, ROWS_LISTED).join(", ");
      const more = rows.length > ROWS_LISTED ? ", …" : "";
      return `${problem} (${rows.length} ${rows.length === 1 ? "row" : "rows"}: ${listed}${more}).`;
    });
    return { ok: false, problems };
  }
  if (customers.length === 0) {
    return { ok: false, problems: ["The sheet holds no clinics below its header row."] };
  }

  const read = new Set(at.values());
  const day = observedAt.toISOString().slice(0, 10);
  return {
    ok: true,
    envelope: {
      version: INGEST_VERSION,
      source: REGISTER_SOURCE,
      // Named after the day, so pushing twice in a day is one batch in the log.
      batchId: `register-${day}`,
      observedAt: observedAt.toISOString(),
      customers,
    },
    summary: {
      clinics: customers.length,
      rowsNotRead,
      columnsRead: FIELDS.flatMap((field) => {
        const heading = config.columns[field];
        return heading === undefined ? [] : [heading];
      }),
      columnsNotRead: sheet.headers.flatMap((heading, index) =>
        read.has(index) || heading === ""
          ? []
          : [heading.length > MAX_HEADING_LENGTH ? "(a long text cell)" : heading],
      ),
    },
  };
}
