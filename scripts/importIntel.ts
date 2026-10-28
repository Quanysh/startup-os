// The logic of `pnpm import:intel`, with everything it touches passed in so
// it is tested without a file system or a deployment. import-intel.ts is the
// thin wrapper that supplies the real ones.
//
// THIS SCRIPT HANDLES COMPANY AND PERSON NAMES. It prints counts, row numbers
// and fixed sentences. It never prints a row, a name or what the Convex CLI
// said (which can quote a row), in any mode, and it has no flag that would.
//
// It reads a JSON array of deals' intelligence (or `{ intel: [...] }`, or
// `{ deals: [...] }`): each `{ dealName, summary, ownership, ehr, pm,
// billingModel, rcmVendor, specialties, ancillaries, workersComp,
// competitors, signals, people, painPoints, talkingPoints, risks, angle,
// nextBestAction, fit, sources, researchedAt }` (convex/lib/dealIntel.ts;
// `name` is taken for `dealName`). A field it does not know is left out and
// counted. Every row is checked as the server checks it (`cleanIntelRows`)
// before anything is sent, then sent to `dealIntel:importIntel` in batches.
// A row replaces its deal's intelligence whole.

import { INTEL_FIELDS, cleanIntelRows, type IntelField, type IntelRow } from "../convex/lib/dealIntel";
import { MAX_IMPORT_ROWS } from "../convex/lib/limits";

export const USAGE = "Usage: pnpm import:intel <file.json> [--check] [--prod]";

export type CliResult = { status: number; stdout: string; stderr: string };

export type ImportDeps = {
  /** The file's text, or null when it cannot be read. */
  readFile: (path: string) => string | null;
  /** `npx convex <args>`, run without a shell. */
  convexRun: (args: string[]) => CliResult;
  print: (line: string) => void;
  printError: (line: string) => void;
};

/** A refusal in fixed words: never a value from the file. */
export class ImportProblem extends Error {}

/** The most bytes of rows one call carries: well under what a command line holds. */
const MAX_BATCH_BYTES = 400_000;
/** Unmatched row numbers listed before the rest are only counted. */
const MAX_LISTED = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const absent = (value: unknown) => value === undefined || value === null;

const TEXTS = [
  "summary",
  "ownership",
  "ehr",
  "pm",
  "billingModel",
  "rcmVendor",
  "workersComp",
  "angle",
  "nextBestAction",
  "researchedAt",
] as const;
const TEXT_LISTS = ["specialties", "ancillaries", "painPoints", "talkingPoints", "risks"] as const;

/** A list of records of these text fields (those after `?` may be missing). */
function records(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  problem: string,
): Record<string, string>[] {
  if (!Array.isArray(value)) throw new ImportProblem(problem);
  return value.map((item) => {
    if (!isRecord(item)) throw new ImportProblem(problem);
    const out: Record<string, string> = {};
    for (const key of required) {
      if (!isText(item[key])) throw new ImportProblem(problem);
      out[key] = item[key];
    }
    for (const key of optional) {
      if (absent(item[key])) continue;
      if (!isText(item[key])) throw new ImportProblem(problem);
      out[key] = item[key];
    }
    return out;
  });
}

/** One field of a row as the mutation takes it; undefined when the row has none. */
function fieldOf(item: Record<string, unknown>, field: IntelField): unknown {
  const value = item[field];
  if (absent(value)) return undefined;
  if ((TEXTS as readonly string[]).includes(field)) {
    if (!isText(value)) throw new ImportProblem(`${field} is not text.`);
    return value;
  }
  if ((TEXT_LISTS as readonly string[]).includes(field)) {
    if (!Array.isArray(value) || !value.every(isText)) {
      throw new ImportProblem(`${field} is not a list of text.`);
    }
    return value;
  }
  switch (field) {
    case "competitors":
      return records(value, ["name"], ["note"], "a competitor is not { name, note }.");
    case "signals":
      return records(
        value,
        ["kind", "text", "source"],
        ["date"],
        "a signal is not { date, kind, text, source }.",
      );
    case "people":
      return records(value, ["name", "role"], ["note"], "a person is not { name, role, note }.");
    case "sources":
      return records(value, ["title", "url"], [], "a source is not { title, url }.");
    case "fit": {
      const reasons = isRecord(value) ? (value.reasons ?? []) : null;
      if (
        !isRecord(value) ||
        typeof value.score !== "number" ||
        !Array.isArray(reasons) ||
        !reasons.every(isText)
      ) {
        throw new ImportProblem("fit is not { score, reasons }.");
      }
      return { score: value.score, reasons };
    }
    default:
      throw new ImportProblem(`${field} could not be read.`);
  }
}

const KNOWN = new Set<string>(["dealName", "name", ...INTEL_FIELDS]);

/**
 * The file as the rows `dealIntel:importIntel` takes: the deal's name and the
 * fields the file gives, each of the type the mutation expects. What cannot
 * be read is refused by row number; a field the import does not know is left
 * out, and the rows that had one are counted.
 */
export function toIntelRows(list: unknown): { rows: IntelRow[]; summary: { unknownFields: number } } {
  const items = Array.isArray(list)
    ? list
    : isRecord(list) && Array.isArray(list.intel)
      ? list.intel
      : isRecord(list) && Array.isArray(list.deals)
        ? list.deals
        : null;
  if (items === null) throw new ImportProblem("The file holds no list of deals' intelligence.");
  let unknownFields = 0;
  const rows = items.map((item: unknown, index): IntelRow => {
    const n = index + 1;
    if (!isRecord(item)) throw new ImportProblem(`Row ${n} is not a deal's intelligence.`);
    const dealName = item.dealName ?? item.name;
    if (!isText(dealName)) throw new ImportProblem(`Row ${n}: the deal's name is not text.`);
    if (Object.keys(item).some((key) => !KNOWN.has(key))) unknownFields++;
    const row: Record<string, unknown> = { dealName };
    for (const field of INTEL_FIELDS) {
      try {
        const value = fieldOf(item, field);
        if (value !== undefined) row[field] = value;
      } catch (failure) {
        if (failure instanceof ImportProblem) throw new ImportProblem(`Row ${n}: ${failure.message}`);
        throw failure;
      }
    }
    return row as IntelRow;
  });
  return { rows, summary: { unknownFields } };
}

/** Rows in calls of at most MAX_IMPORT_ROWS rows and MAX_BATCH_BYTES of JSON. */
export function batchesOf(rows: readonly IntelRow[]): IntelRow[][] {
  const batches: IntelRow[][] = [];
  let current: IntelRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (current.length > 0 && (current.length >= MAX_IMPORT_ROWS || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summaryLines(rows: readonly IntelRow[], unknownFields: number): string[] {
  const count = (test: (row: IntelRow) => boolean) => rows.filter(test).length;
  const lines = [
    `${plural(rows.length, "deal's intelligence", "deals' intelligence")} read.`,
    `With a fit score: ${count((r) => r.fit != null)}. With signals: ${count((r) => (r.signals?.length ?? 0) > 0)}. With people: ${count((r) => (r.people?.length ?? 0) > 0)}. With sources: ${count((r) => (r.sources?.length ?? 0) > 0)}.`,
  ];
  if (unknownFields > 0) {
    lines.push(
      `${plural(unknownFields, "row holds", "rows hold")} fields the import does not know: they are left out.`,
    );
  }
  return lines;
}

const counted = (stdout: string, field: string) => {
  const found = new RegExp(`"?${field}"?\\s*:\\s*(\\d+)`).exec(stdout);
  return found === null ? null : Number(found[1]);
};

const rowNumbers = (stdout: string): number[] | null => {
  const found = /"?unmatchedRows"?\s*:\s*\[([\d,\s]*)\]/.exec(stdout);
  if (found === null) return null;
  return found[1]!
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(Number);
};

/** Returns the process exit code. */
export function run(argv: readonly string[], deps: ImportDeps): number {
  const { print, printError } = deps;
  const paths: string[] = [];
  let prod = false;
  let check = false;
  let usage = false;
  for (const arg of argv) {
    if (arg === "--prod") prod = true;
    else if (arg === "--check") check = true;
    else if (arg.startsWith("-")) usage = true;
    else paths.push(arg);
  }
  if (usage || paths.length !== 1) {
    printError(USAGE);
    return 1;
  }

  let rows: IntelRow[];
  try {
    const raw = deps.readFile(paths[0]!);
    if (raw === null) throw new ImportProblem("Could not read the file.");
    const mapped = toIntelRows(parseJson(raw));
    rows = mapped.rows;
    for (const line of summaryLines(rows, mapped.summary.unknownFields)) print(line);
    // The server's own checks, here first, so a refusal sends nothing at all.
    const cleaned = cleanIntelRows(rows);
    if (!cleaned.ok) throw new ImportProblem(cleaned.problem);
  } catch (failure) {
    printError(failure instanceof ImportProblem ? failure.message : "The file could not be read.");
    return 1;
  }
  print("Every row passes the checks.");
  if (check) {
    print("Checked only: nothing was sent.");
    return 0;
  }

  print(
    prod
      ? "Sending to the production deployment."
      : "Sending to the dev deployment (add --prod for production).",
  );
  const batches = batchesOf(rows);
  let matched = 0;
  let updated = 0;
  const unmatched: number[] = [];
  let offset = 0;
  for (const [index, batch] of batches.entries()) {
    const label = `Batch ${index + 1} of ${batches.length}`;
    const result = deps.convexRun([
      "run",
      "dealIntel:importIntel",
      JSON.stringify({ rows: batch }),
      "--codegen",
      "disable",
      "--typecheck",
      "disable",
      ...(prod ? ["--prod"] : []),
    ]);
    const done = {
      matched: counted(result.stdout, "matched"),
      updated: counted(result.stdout, "updated"),
      unmatchedRows: rowNumbers(result.stdout),
    };
    if (
      result.status !== 0 ||
      done.matched === null ||
      done.updated === null ||
      done.unmatchedRows === null
    ) {
      // The server's refusals name a row by its place in the batch, in fixed
      // words; anything else the CLI says may quote a row, so none of it is shown.
      const refusal = /Row (\d+): ([^"\n]*)/.exec(`${result.stderr}\n${result.stdout}`);
      if (refusal !== null) {
        printError(`${label} was refused: Row ${offset + Number(refusal[1])}: ${refusal[2]!.trim()}`);
      } else {
        printError(
          `${label} did not run. The CLI's output is not shown, since it can quote a row: run \`npx convex run dealIntel:importIntel '{"rows":[]}'\` to see what it says.`,
        );
      }
      if (index > 0) {
        printError("Batches before it are in; running the import again replaces them with the same.");
      }
      return 1;
    }
    print(
      `${label}: ${done.matched} matched (${done.updated} replaced), ${done.unmatchedRows.length} unmatched.`,
    );
    matched += done.matched;
    updated += done.updated;
    unmatched.push(...done.unmatchedRows.map((row) => offset + row));
    offset += batch.length;
  }
  print(
    `Done: ${matched} matched (${updated} already had intelligence, replaced), ${unmatched.length} unmatched.`,
  );
  if (unmatched.length > 0) {
    const listed = unmatched.slice(0, MAX_LISTED).join(", ");
    const more = unmatched.length > MAX_LISTED ? `, and ${unmatched.length - MAX_LISTED} more` : "";
    print(`Rows that match no US deal made here: ${listed}${more}.`);
  }
  return 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ImportProblem("The file is not JSON.");
  }
}
