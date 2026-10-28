// The logic of `pnpm visible:outbox` and `pnpm visible:ack`: the daily run's
// two calls for Visible write-back (docs/setup.md, "Visible";
// docs/ingest.md, "Visible write-back"). Everything they touch is passed in,
// so they are tested without a file system or a network. visible-outbox.ts
// and visible-ack.ts are the thin wrappers.
//
// The outbox holds investor names, stages, amounts and a note's text: company
// data, for the session's own file or a local terminal and nothing else. The
// ack holds ids and codes. Neither script prints the token, follows a
// redirect, or prints anything of a reply it does not recognise.

import { resolve } from "node:path";
import { z } from "zod";
import { parseAck } from "../convex/lib/investorSync";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";
import { ask, printRefusal, type HttpDeps } from "./standupHttp";

export const OUTBOX_USAGE = "Usage: pnpm -s visible:outbox [<out.json>]";
export const ACK_USAGE = "Usage: pnpm -s visible:ack <file.json> [--send]";
export const VISIBLE_TOKEN_ENV = "INGEST_TOKEN_VISIBLE";

/**
 * The two routes, on the host `STARTUP_OS_INGEST_URL` names, and the token; null
 * with the reason printed in fixed words when either is unfit. The app's own
 * domain passes both routes through (src/lib/os/pass-through-routes.ts), so
 * the address `push:envelope` uses works here too.
 */
export function settings(
  env: Record<string, string | undefined>,
  deps: Pick<HttpDeps, "printError">,
): { outbox: string; ack: string; token: string } | null {
  const url = env.STARTUP_OS_INGEST_URL;
  const token = env[VISIBLE_TOKEN_ENV];
  if (!url || !token) {
    deps.printError(`Set STARTUP_OS_INGEST_URL and ${VISIBLE_TOKEN_ENV} in .env.push or the environment.`);
    return null;
  }
  const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token, VISIBLE_TOKEN_ENV);
  if (problem !== null) {
    deps.printError(problem);
    return null;
  }
  const { origin } = new URL(url);
  return { outbox: `${origin}/ingest/v1/visible/outbox`, ack: `${origin}/ingest/v1/visible/outbox/ack`, token };
}

// Not strict: a field this script does not know is dropped, never passed on.
const item = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["create", "update"]),
  investor: z.object({ externalId: z.string().optional(), name: z.string() }),
  fields: z.object({
    stage: z.string().optional(),
    amount: z.number().nullable().optional(),
    name: z.string().optional(),
  }),
  osStage: z.string(),
  note: z.string().optional(),
});
const listing = z.object({ ok: z.literal(true), items: z.array(item), truncated: z.boolean() });

export type OutboxDeps = HttpDeps & { writeFile: (path: string, text: string) => void };

/** `pnpm visible:outbox`: the pending items, as JSON on stdout or into a file. Returns the exit code. */
export async function runOutbox(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: OutboxDeps,
): Promise<number> {
  if (argv.length > 1 || argv.some((arg) => arg.startsWith("-"))) {
    deps.printError(OUTBOX_USAGE);
    return 1;
  }
  const target = settings(env, deps);
  if (target === null) return 1;

  const answer = await ask(target.outbox, target.token, undefined, deps);
  if (answer === null) return 1;
  if (!answer.ok) {
    printRefusal(answer, deps);
    return 1;
  }
  const read = listing.safeParse(answer.body);
  if (!read.success) {
    deps.printError(String(answer.status));
    deps.printError("That is not the endpoint's outbox, so nothing is printed.");
    return 1;
  }
  const { items, truncated } = read.data;
  // One document. JSON's own escaping keeps a name or a note from writing to the terminal.
  const text = JSON.stringify({ items, truncated }, null, 2);
  if (argv.length === 1) {
    const path = resolve(argv[0]!);
    try {
      deps.writeFile(path, `${text}\n`);
    } catch {
      deps.printError(`Could not write ${path}.`);
      return 1;
    }
    const creates = items.filter((i) => i.kind === "create").length;
    deps.print(`Items: ${items.length} (create ${creates}, update ${items.length - creates})`);
    deps.print(`With a note: ${items.filter((i) => i.note !== undefined).length}`);
    deps.print(`Written to ${path}.`);
  } else {
    deps.print(text);
  }
  if (truncated) {
    deps.printError("The outbox was cut short at 100 items: the rest are listed by the next read.");
  }
  return 0;
}

export type AckDeps = HttpDeps & { readFile: (path: string) => string };

const ACK_COUNTS = ["sent", "confirmed", "failed", "stale", "unknown"] as const;
const MAX_ISSUES = 20;

/** `pnpm visible:ack`: check an ack file with the endpoint's rules; post it with --send. */
export async function runAck(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: AckDeps,
): Promise<number> {
  const { print, printError } = deps;
  // Sending is the explicit act: a lost or misspelled flag ends in a printout, never a post.
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const send = flags.includes("--send");
  const known = flags.every((flag) => flag === "--send" || flag === "--dry-run");
  if (!known || paths.length !== 1 || (send && flags.includes("--dry-run"))) {
    printError(ACK_USAGE);
    return 1;
  }

  const path = resolve(paths[0]!);
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(path));
  } catch (error) {
    // Never the parser's own message: it quotes the file.
    printError(error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`);
    return 1;
  }
  // The same rules the endpoint applies.
  const parsed = parseAck(raw);
  if (!parsed.ok) {
    for (const issue of parsed.issues.slice(0, MAX_ISSUES)) printError(`${issue.path}: ${issue.message}`);
    return 1;
  }
  const { results } = parsed;
  const target = send ? settings(env, deps) : null;
  if (send && target === null) return 1;

  const failed = results.filter((r) => !r.ok);
  const codes = new Map<string, number>();
  for (const r of failed) codes.set(r.errorCode!, (codes.get(r.errorCode!) ?? 0) + 1);
  print(`Results: ${results.length}`);
  print(`Written: ${results.length - failed.length} (with a Visible id: ${results.filter((r) => r.visibleId !== undefined).length})`);
  // Each code passed the ack's own snake_case check, so it is safe to print.
  print(`Failed: ${failed.length}${codes.size === 0 ? "" : ` (${[...codes].sort().map(([code, n]) => `${code} ${n}`).join(", ")})`}`);
  if (target === null) {
    printError("Nothing was sent. Add --send to post it.");
    return 0;
  }

  print(`Sending to ${new URL(target.ack).host}.`);
  const answer = await ask(target.ack, target.token, { results }, deps);
  if (answer === null) return 1;
  if (!answer.ok) {
    printRefusal(answer, deps);
    return 1;
  }
  const reply =
    typeof answer.body === "object" && answer.body !== null ? (answer.body as Record<string, unknown>) : {};
  if (reply.ok !== true || !ACK_COUNTS.every((key) => typeof reply[key] === "number")) {
    printError(String(answer.status));
    printError("That is not the endpoint's confirmation, so the ack is not confirmed.");
    return 1;
  }
  print(`${answer.status} ok: ${ACK_COUNTS.map((key) => `${key} ${reply[key] as number}`).join(", ")}`);
  return 0;
}
