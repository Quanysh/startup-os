// The logic of `pnpm push:retention`, with everything it touches passed in so
// it is tested without a file system or a network. push-retention.ts is the
// thin wrapper that supplies the real ones.

import { resolve } from "node:path";
import { z } from "zod";
import { validateSnapshots } from "../convex/lib/snapshotRules";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";
import { retentionToEnvelope } from "./retentionToEnvelope";

export const USAGE = "Usage: pnpm push:retention [path/to/retention.json] [--send]";
const DEFAULT_PATH = "../startup-model/tools/retention.json";

export type PushDeps = {
  readFile: (path: string) => string;
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
  now: () => Date;
};

/** A plain error code such as ENOTFOUND, or null: never free text. */
function plainCode(error: unknown): string | null {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

function isConfirmation(text: string): boolean {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

const MAX_ISSUES = 20;
const MAX_FIELD_LENGTH = 200;

/** A reply's text made safe for a terminal: no control characters, and not long. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, MAX_FIELD_LENGTH);
}

/**
 * What to print of the endpoint's reply: the status and, from a JSON body,
 * only the fields the endpoint is known to send (`ok`, the three counts,
 * `error`, and each issue's `path` and `message`). Never the body itself:
 * whatever answered in the endpoint's place (a proxy, another deployment) can
 * put anything in it, terminal escape sequences included.
 */
function describeReply(status: number, text: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [String(status), "The endpoint did not answer with JSON."];
  }
  const reply = body as Record<string, unknown>;

  const fields: string[] = [];
  if (typeof reply.ok === "boolean") fields.push(`ok: ${reply.ok}`);
  for (const count of ["inserted", "updated", "unchanged"]) {
    const value = reply[count];
    if (typeof value === "number" && Number.isFinite(value)) fields.push(`${count}: ${value}`);
  }
  if (typeof reply.error === "string") fields.push(`error: ${plain(reply.error)}`);
  const lines = [[String(status), fields.join(", ")].filter(Boolean).join(" ")];

  const issues = Array.isArray(reply.issues) ? reply.issues : [];
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
    const parts = (Array.isArray(path) ? path : [path]).filter(
      (part) => typeof part === "string" || typeof part === "number",
    );
    if (parts.length === 0 && typeof message !== "string") continue;
    lines.push(`${plain(parts.join("."))}: ${typeof message === "string" ? plain(message) : ""}`);
  }
  if (issues.length > MAX_ISSUES) lines.push(`${issues.length - MAX_ISSUES} more issues not shown.`);
  return lines;
}

/** Returns the process exit code. Nothing here prints text taken from the export. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: PushDeps,
): Promise<number> {
  const { print, printError } = deps;

  // Sending is the explicit act: a lost, misspelled or swallowed flag must end
  // in a printout, never a push. --dry-run is the old spelling of the default.
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const send = flags.includes("--send");
  const known = flags.every((flag) => flag === "--send" || flag === "--dry-run");
  if (!known || paths.length > 1 || (send && flags.includes("--dry-run"))) {
    printError(USAGE);
    return 1;
  }

  let url = "";
  let token = "";
  if (send) {
    if (!env.STARTUP_OS_INGEST_URL || !env.INGEST_TOKEN_CFO_WORKBOOK) {
      printError(
        "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_CFO_WORKBOOK in .env.push or the environment.",
      );
      return 1;
    }
    url = env.STARTUP_OS_INGEST_URL;
    token = env.INGEST_TOKEN_CFO_WORKBOOK;
    const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token);
    if (problem !== null) {
      printError(problem);
      return 1;
    }
  }

  const path = resolve(paths[0] ?? DEFAULT_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(path));
  } catch (error) {
    // Never the parser's own message: it quotes the file, and the file holds
    // client names.
    printError(
      error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`,
    );
    return 1;
  }

  const now = deps.now();
  let envelope: ReturnType<typeof retentionToEnvelope>;
  try {
    envelope = retentionToEnvelope(raw, now);
  } catch (error) {
    // Field paths and fixed messages only, never a value from the export.
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) printError(`${issue.path.join(".")}: ${issue.message}`);
    } else {
      printError("The export could not be read as a workbook summary.");
    }
    return 1;
  }

  // Printing is a preview of what the endpoint will accept, so it applies the
  // endpoint's own rules before showing anything.
  const issues = validateSnapshots("cfo_workbook", envelope.snapshots, undefined, {
    now: now.getTime(),
  });
  if (issues.length > 0) {
    for (const issue of issues) printError(issue.message);
    return 1;
  }

  if (!send) {
    print(JSON.stringify(envelope, null, 2));
    // On stderr, so piping the envelope onward stays valid JSON.
    printError("Nothing was sent. Add --send to push it.");
    return 0;
  }

  print(`Sending to ${new URL(url).host}.`);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      // A redirect would carry the token to wherever it points.
      redirect: "manual",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    // Not the error's own message: a rejected header is quoted in it.
    printError(`The push could not reach the endpoint (${plainCode(error) ?? "unknown error"}).`);
    return 1;
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    printError("The endpoint redirected the request. Nothing was followed and nothing was sent on.");
    return 1;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    printError("The endpoint's reply could not be read.");
    return 1;
  }
  const lines = describeReply(response.status, text);
  // Only a JSON body saying ok counts: a sign-in page or an empty 204 does not.
  if (response.ok && isConfirmation(text)) {
    for (const line of lines) print(line);
    return 0;
  }
  for (const line of lines) printError(line);
  if (response.ok) printError("That is not an ingest confirmation, so the push is not confirmed.");
  return 1;
}
