// The logic of `pnpm push:customers`, with everything it touches passed in so
// it is tested without a file system or a network. push-customers.ts is the
// thin wrapper that supplies the real ones.
//
// THIS SCRIPT HANDLES CLIENT NAMES. It prints counts, column headings, sheet
// row numbers and fixed sentences. It never prints a cell, a clinic or the
// envelope, in any mode, and it has no flag that would.

import { resolve } from "node:path";
import { customerRowProblems } from "../convex/lib/customerRules";
import {
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LABELS,
  MARKETS,
  MARKET_LABELS,
} from "../convex/lib/customerShape";
import { type CustomersEnvelope, parseIngestEnvelope } from "../convex/lib/ingestSchema";
import {
  type MappingSummary,
  REGISTER,
  type RegisterConfig,
  customersToEnvelope,
} from "./customersToEnvelope";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";
import { postEnvelope } from "./postEnvelope";
import { SheetError, type Sheet } from "./registerSheet";

export const USAGE =
  "Usage: pnpm push:customers <register.csv> [--header-row <n>] [--send [--allow-shrink] [--stop-at-blank]]";

const TOKEN_ENV = "INGEST_TOKEN_CLIENT_REGISTER";

export type PushDeps = {
  readFile: (path: string) => Uint8Array;
  readSheet: (data: Uint8Array, headerRow: number) => Sheet;
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
  now: () => Date;
  /** The column mapping. Tests pass their own; the wrapper leaves it out. */
  config?: RegisterConfig;
};

const ON_RECORD = [
  ["monthlyFee", "monthly fee"],
  ["lastPaymentDate", "last payment"],
  ["amountOwed", "amount owed"],
  ["lastUsageDate", "last use"],
  ["contractDate", "contract date"],
  ["baaDate", "BAA date"],
] as const;

/** What the push holds, in counts and headings only. */
function summaryLines(envelope: CustomersEnvelope, summary: MappingSummary): string[] {
  const rows = envelope.customers;
  const count = (test: (row: (typeof rows)[number]) => boolean) => rows.filter(test).length;
  const lines = [
    `${summary.clinics} ${summary.clinics === 1 ? "clinic" : "clinics"} read.`,
    `By market: ${MARKETS.map((m) => `${MARKET_LABELS[m]} ${count((r) => r.market === m)}`).join(", ")}.`,
    `By status: ${CUSTOMER_STATUSES.map((s) => `${CUSTOMER_STATUS_LABELS[s]} ${count((r) => r.status === s)}`).join(", ")}.`,
    `On record: ${ON_RECORD.map(([field, label]) => `${label} ${count((r) => r[field] !== undefined)}`).join(", ")}.`,
    `Columns read: ${summary.columnsRead.join(", ")}.`,
  ];
  if (summary.columnsNotRead.length > 0) {
    lines.push(`Columns not read: ${summary.columnsNotRead.join(", ")}.`);
  }
  if (summary.rowsNotRead > 0) lines.push(notRead(summary.rowsNotRead));
  return lines;
}

const notRead = (rows: number) =>
  rows === 1
    ? "1 row below the first blank row was not read."
    : `${rows} rows below the first blank row were not read.`;

/** Returns the process exit code. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: PushDeps,
): Promise<number> {
  const { print, printError } = deps;
  const config = deps.config ?? REGISTER;

  const paths: string[] = [];
  let send = false;
  let allowShrink = false;
  let stopAtBlank = false;
  let headerRow = config.headerRow;
  let usage = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--send") send = true;
    else if (arg === "--allow-shrink") allowShrink = true;
    else if (arg === "--stop-at-blank") stopAtBlank = true;
    else if (arg === "--header-row") headerRow = Number(argv[++i]);
    else if (arg.startsWith("-")) usage = true;
    else paths.push(arg);
  }
  // Sending is the explicit act: a misspelled flag ends in the usage line,
  // never in a push. --allow-shrink and --stop-at-blank mean nothing without --send.
  if (
    usage ||
    paths.length !== 1 ||
    !Number.isInteger(headerRow) ||
    headerRow < 1 ||
    ((allowShrink || stopAtBlank) && !send)
  ) {
    printError(USAGE);
    return 1;
  }

  let url = "";
  let token = "";
  if (send) {
    // Only this script's own token: the workbook's token must not carry names.
    if (!env.STARTUP_OS_INGEST_URL || !env[TOKEN_ENV]) {
      printError(`Set STARTUP_OS_INGEST_URL and ${TOKEN_ENV} in .env.push or the environment.`);
      return 1;
    }
    url = env.STARTUP_OS_INGEST_URL;
    token = env[TOKEN_ENV];
    const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token, TOKEN_ENV);
    if (problem !== null) {
      printError(problem);
      return 1;
    }
  }

  const path = resolve(paths[0]!);
  let data: Uint8Array;
  try {
    data = deps.readFile(path);
  } catch {
    // The path is what the caller typed. The system's own message is not printed.
    printError(`Could not read ${path}.`);
    return 1;
  }

  let sheet: Sheet;
  try {
    sheet = deps.readSheet(data, headerRow);
  } catch (error) {
    // A SheetError's words were written by the reader. Anything else may quote the file.
    printError(error instanceof SheetError ? error.message : "The export could not be read.");
    return 1;
  }

  const now = deps.now();
  const mapped = customersToEnvelope(sheet, now, config);
  if (!mapped.ok) {
    for (const problem of mapped.problems) printError(problem);
    return 1;
  }
  const envelope: CustomersEnvelope = allowShrink
    ? { ...mapped.envelope, allowShrink: true }
    : mapped.envelope;

  // The endpoint's own rules, applied here first: what is shown as ready to
  // send is what the endpoint will accept. Paths and fixed words only.
  const parsed = parseIngestEnvelope(JSON.parse(JSON.stringify(envelope)));
  const issues = parsed.ok
    ? customerRowProblems(envelope.customers, now.getTime())
    : parsed.issues;
  if (issues.length > 0) {
    for (const issue of issues) printError(`${issue.path}: ${issue.message}`);
    return 1;
  }

  // A push is the whole list: clinics it does not carry are archived. Rows
  // left unread under a blank row would be archived with them, so sending
  // needs the caller to say the list really does end there.
  const { rowsNotRead } = mapped.summary;
  if (send && rowsNotRead > 0 && !stopAtBlank) {
    printError(
      `${notRead(rowsNotRead)} Remove the blank row or pass --stop-at-blank to send only the rows above it.`,
    );
    return 1;
  }

  for (const line of summaryLines(envelope, mapped.summary)) print(line);
  if (!send) {
    printError("Nothing was sent. Add --send to push it.");
    return 0;
  }
  return postEnvelope(url, token, envelope, deps);
}
