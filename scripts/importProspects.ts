// The logic of `pnpm import:prospects`, with everything it touches passed in
// so it is tested without a file system or a deployment. import-prospects.ts
// is the thin wrapper that supplies the real ones.
//
// THIS SCRIPT HANDLES COMPANY AND PERSON NAMES. It prints counts, row numbers
// and fixed sentences. It never prints a row, a name or what the Convex CLI
// said (which can quote a row), in any mode, and it has no flag that would.
//
// It reads a prospect list (a JSON array of `{ name, contact, stage, nextStep,
// notes, priority, sources }`, or `{ prospects: [...] }`) and a sidecar beside
// it, `<file>.meta.json`, keyed by name: `{ state, physicians, locations }`.
// Every row is checked as the board would check it (`cleanProspectRows`)
// before anything is sent, then sent to `deals:importProspects` in batches.

import { basename } from "node:path";
import { normalDealName } from "../convex/lib/dealDetails";
import { MAX_DEAL_SOURCES, MAX_IMPORT_ROWS } from "../convex/lib/limits";
import { cleanProspectRows, type ProspectRow } from "../convex/lib/pipelineFields";

export const USAGE = "Usage: pnpm import:prospects <file.json> [--prod] [--check] [--no-meta]";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Summary = {
  /** Rows given a region or a size from the sidecar. */
  withMeta: number;
  /** Sidecar entries that match no row. */
  metaUnused: number;
  /** Sizes in the sidecar that are not a whole number, left out. */
  sizesLeftOut: number;
  /** Rows that named more sources than a deal keeps. */
  sourcesCut: number;
};

function text(row: Record<string, unknown>, field: string, said: string, n: number) {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ImportProblem(`Row ${n}: ${said}`);
  return value.trim() === "" ? undefined : value;
}

/** A whole number, or a string that is one; anything else is left out. */
function wholeNumber(value: unknown): number | undefined | "unread" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value : "unread";
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return "unread";
}

function sourcesOf(row: Record<string, unknown>, n: number, summary: Summary) {
  const value = row.sources;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ImportProblem(`Row ${n}: the sources are not a list.`);
  const titles = value.map((source) => {
    if (typeof source === "string") return source;
    if (isRecord(source) && typeof source.title === "string") return source.title;
    throw new ImportProblem(`Row ${n}: a source is neither text nor a title.`);
  });
  if (titles.length > MAX_DEAL_SOURCES) summary.sourcesCut++;
  const kept = titles.slice(0, MAX_DEAL_SOURCES);
  return kept.length === 0 ? undefined : kept;
}

/**
 * The list and its sidecar as the rows `deals:importProspects` takes. Stage
 * and priority are lower-cased; blank text is left out; the sidecar's
 * `state` is the region. What cannot be read is refused by row number.
 */
export function toImportRows(
  list: unknown,
  meta: unknown,
): { rows: ProspectRow[]; summary: Summary } {
  const items = Array.isArray(list)
    ? list
    : isRecord(list) && Array.isArray(list.prospects)
      ? list.prospects
      : null;
  if (items === null) throw new ImportProblem("The file holds no list of prospects.");
  const entries = new Map<string, Record<string, unknown>>();
  if (isRecord(meta)) {
    for (const [name, entry] of Object.entries(meta)) {
      if (isRecord(entry)) entries.set(normalDealName(name), entry);
    }
  }
  const used = new Set<string>();
  const summary: Summary = { withMeta: 0, metaUnused: 0, sizesLeftOut: 0, sourcesCut: 0 };

  const rows = items.map((item: unknown, index): ProspectRow => {
    const n = index + 1;
    if (!isRecord(item)) throw new ImportProblem(`Row ${n} is not a prospect.`);
    const name = text(item, "name", "the name is not text.", n);
    if (typeof item.name !== "string") throw new ImportProblem(`Row ${n}: the name is not text.`);
    const stage = text(item, "stage", "the stage is not text.", n);
    if (stage === undefined) throw new ImportProblem(`Row ${n}: the stage is not text.`);
    const priority = text(item, "priority", "the priority is not text.", n);
    const row: ProspectRow = {
      name: name ?? item.name,
      contact: text(item, "contact", "the contact is not text.", n),
      stage: stage.trim().toLowerCase(),
      nextStep: text(item, "nextStep", "the next step is not text.", n),
      notes: text(item, "notes", "the notes are not text.", n),
      priority: priority?.trim().toLowerCase(),
      sources: sourcesOf(item, n, summary),
    };

    const key = normalDealName(row.name);
    const entry = entries.get(key);
    if (entry !== undefined) {
      used.add(key);
      const region = text(entry, "state", "the sidecar's state is not text.", n);
      const sizes = { physicians: wholeNumber(entry.physicians), locations: wholeNumber(entry.locations) };
      if (region !== undefined) row.region = region;
      for (const field of ["physicians", "locations"] as const) {
        const value = sizes[field];
        if (value === "unread") summary.sizesLeftOut++;
        else if (value !== undefined) row[field] = value;
      }
      if (row.region !== undefined || row.physicians !== undefined || row.locations !== undefined) {
        summary.withMeta++;
      }
    }
    // Only the fields that are there, so the JSON sent is what the row holds.
    return Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    ) as ProspectRow;
  });
  summary.metaUnused = [...entries.keys()].filter((key) => !used.has(key)).length;
  return { rows, summary };
}

/** Rows in calls of at most MAX_IMPORT_ROWS rows and MAX_BATCH_BYTES of JSON. */
export function batchesOf(rows: readonly ProspectRow[]): ProspectRow[][] {
  const batches: ProspectRow[][] = [];
  let current: ProspectRow[] = [];
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

/** Where the sidecar may be: `x.meta.json` for `x.json`, or `x.json.meta.json`. */
export const sidecarsOf = (path: string) => [
  path.replace(/\.json$/i, "") + ".meta.json",
  `${path}.meta.json`,
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summaryLines(rows: readonly ProspectRow[], summary: Summary, meta: boolean): string[] {
  const count = (test: (row: ProspectRow) => boolean) => rows.filter(test).length;
  const lines = [
    `${plural(rows.length, "prospect", "prospects")} read.`,
    `Stages: lead ${count((r) => r.stage === "lead")}, qualified ${count((r) => r.stage === "qualified")}.`,
    `Priority: high ${count((r) => r.priority === "high")}, medium ${count((r) => r.priority === "medium")}, low ${count((r) => r.priority === "low")}, none ${count((r) => r.priority === undefined)}.`,
  ];
  if (meta) {
    lines.push(
      `Region and size from the sidecar: ${summary.withMeta} of ${rows.length} rows.` +
        (summary.metaUnused > 0
          ? ` ${plural(summary.metaUnused, "sidecar entry matches", "sidecar entries match")} no row.`
          : ""),
    );
  }
  if (summary.sizesLeftOut > 0) {
    lines.push(`${plural(summary.sizesLeftOut, "size was", "sizes were")} not a whole number and left out.`);
  }
  if (summary.sourcesCut > 0) {
    lines.push(
      `${plural(summary.sourcesCut, "row names", "rows name")} more than ${MAX_DEAL_SOURCES} sources: the first ${MAX_DEAL_SOURCES} are kept.`,
    );
  }
  lines.push(`With sources: ${count((r) => (r.sources?.length ?? 0) > 0)}.`);
  return lines;
}

const counted = (stdout: string, field: string) => {
  const found = new RegExp(`"?${field}"?\\s*:\\s*(\\d+)`).exec(stdout);
  return found === null ? null : Number(found[1]);
};

/** Returns the process exit code. */
export function run(argv: readonly string[], deps: ImportDeps): number {
  const { print, printError } = deps;
  const paths: string[] = [];
  let prod = false;
  let check = false;
  let noMeta = false;
  let usage = false;
  for (const arg of argv) {
    if (arg === "--prod") prod = true;
    else if (arg === "--check") check = true;
    else if (arg === "--no-meta") noMeta = true;
    else if (arg.startsWith("-")) usage = true;
    else paths.push(arg);
  }
  if (usage || paths.length !== 1) {
    printError(USAGE);
    return 1;
  }
  const path = paths[0]!;

  let rows: ProspectRow[];
  try {
    const raw = deps.readFile(path);
    if (raw === null) throw new ImportProblem("Could not read the file.");
    const list = parseJson(raw, "The file is not JSON.");
    let meta: unknown = null;
    if (!noMeta) {
      const found = sidecarsOf(path)
        .map((candidate) => deps.readFile(candidate))
        .find((content) => content !== null);
      if (found === undefined || found === null) {
        throw new ImportProblem(
          `No sidecar beside the file (${basename(sidecarsOf(path)[0]!)}). Add it, or pass --no-meta to import without region and size.`,
        );
      }
      meta = parseJson(found, "The sidecar is not JSON.");
    }
    const mapped = toImportRows(list, meta);
    rows = mapped.rows;
    for (const line of summaryLines(rows, mapped.summary, !noMeta)) print(line);
    // The board's own checks, here first, so a refusal sends nothing at all.
    cleanProspectRows(rows);
  } catch (failure) {
    printError(fixedWords(failure));
    return 1;
  }
  print("Every row passes the board's checks.");
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
  let added = 0;
  let skipped = 0;
  let offset = 0;
  for (const [index, batch] of batches.entries()) {
    const label = `Batch ${index + 1} of ${batches.length}`;
    const result = deps.convexRun([
      "run",
      "deals:importProspects",
      JSON.stringify({ market: "us", rows: batch }),
      "--codegen",
      "disable",
      "--typecheck",
      "disable",
      ...(prod ? ["--prod"] : []),
    ]);
    const done = { added: counted(result.stdout, "added"), skipped: counted(result.stdout, "skipped") };
    if (result.status !== 0 || done.added === null || done.skipped === null) {
      // The server's refusals name a row by its place in the batch, in fixed
      // words; anything else the CLI says may quote a row, so none of it is shown.
      const refusal = /Row (\d+): ([^"\n]*)/.exec(`${result.stderr}\n${result.stdout}`);
      if (refusal !== null) {
        printError(`${label} was refused: Row ${offset + Number(refusal[1])}: ${refusal[2]!.trim()}`);
      } else {
        printError(
          `${label} did not run. The CLI's output is not shown, since it can quote a row: run \`npx convex run deals:importProspects '{"market":"us","rows":[]}'\` to see what it says.`,
        );
      }
      if (index > 0) printError("Batches before it are in; running the import again skips them.");
      return 1;
    }
    print(`${label}: ${done.added} added, ${done.skipped} skipped.`);
    added += done.added;
    skipped += done.skipped;
    offset += batch.length;
  }
  print(`Done: ${added} added, ${skipped} skipped (already a US deal, or twice in the list).`);
  return 0;
}

function parseJson(raw: string, problem: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ImportProblem(problem);
  }
}

/**
 * What a failure says, if it is one of ours. A cleaning refusal is "Row n:"
 * and a fixed sentence (`cleanProspectRows`); anything else is not quoted.
 */
function fixedWords(failure: unknown): string {
  if (failure instanceof ImportProblem) return failure.message;
  const data = (failure as { data?: unknown } | null)?.data;
  if (typeof data === "string" && /^Row \d+: /.test(data)) return data;
  return "The list could not be read.";
}
