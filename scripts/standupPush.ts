// The logic of `pnpm standup:push`: check a file of standup tasks with the
// endpoint's own rules, say what it holds in counts, and post it only with
// --send. Everything it touches is passed in, so it is tested without a file
// system or a network. standup-push.ts is the thin wrapper.
//
// The file holds what people said in a meeting (titles, a line of context,
// addresses). So nothing here prints a row: the summary is the meeting's
// date and counts, and an issue is a path and fixed words.

import { resolve } from "node:path";
import { COMPANIES } from "../convex/lib/company";
import { parseStandupPush, type StandupIssue } from "../convex/lib/standup";
import { ask, printRefusal, settings, type HttpDeps } from "./standupHttp";

export const USAGE = "Usage: pnpm standup:push <file.json> [--send]";

export type PushDeps = HttpDeps & {
  readFile: (path: string) => string;
  now: () => Date;
};

const MAX_ISSUES = 20;
const COUNTS = ["added", "known", "duplicate", "nearDuplicate", "unassigned"] as const;

/** Returns the process exit code. Nothing here prints a task. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: PushDeps,
): Promise<number> {
  const { print, printError } = deps;

  // Sending is the explicit act: a lost, misspelled or swallowed flag must end
  // in a printout, never a push. --dry-run is the long way to say the default.
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const send = flags.includes("--send");
  const known = flags.every((flag) => flag === "--send" || flag === "--dry-run");
  if (!known || paths.length !== 1 || (send && flags.includes("--dry-run"))) {
    printError(USAGE);
    return 1;
  }

  const path = resolve(paths[0]!);
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(path));
  } catch (error) {
    // Never the parser's own message: it quotes the file.
    printError(
      error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`,
    );
    return 1;
  }

  // The same pure schema the endpoint parses with.
  const parsed = parseStandupPush(raw, { now: deps.now().getTime() });
  if (!parsed.ok) {
    const issues: readonly StandupIssue[] = parsed.issues;
    for (const issue of issues.slice(0, MAX_ISSUES)) printError(`${issue.path}: ${issue.message}`);
    if (issues.length > MAX_ISSUES) printError(`${issues.length - MAX_ISSUES} more issues not shown.`);
    return 1;
  }
  const { meetingDate, tasks } = parsed.push;

  const target = send ? settings(env, deps) : null;
  if (send && target === null) return 1;

  const of = (company: string | null) => tasks.filter((task) => task.company === company).length;
  print("Kind: standup tasks");
  // The date passed the schema's own check, so it is safe to print.
  print(`Meeting date: ${meetingDate}`);
  print(`Tasks: ${tasks.length}`);
  print(`${COMPANIES.us.name}: ${of("us")}, ${COMPANIES.kz.name}: ${of("kz")}, shared: ${of(null)}`);
  print(`With an assignee: ${tasks.filter((task) => task.assignee !== undefined).length}`);
  print(`With a due date: ${tasks.filter((task) => task.due !== undefined).length}`);
  if (target === null) {
    // On stderr, as the other push scripts say it.
    printError("Nothing was sent. Add --send to push it.");
    return 0;
  }

  print(`Sending to ${new URL(target.tasks).host}.`);
  // The file as it was read: the endpoint applies the same rules to it.
  const answer = await ask(target.tasks, target.token, raw, deps);
  if (answer === null) return 1;
  if (!answer.ok) {
    printRefusal(answer, deps);
    return 1;
  }
  const reply =
    typeof answer.body === "object" && answer.body !== null
      ? (answer.body as Record<string, unknown>)
      : {};
  if (reply.ok !== true || !COUNTS.every((key) => typeof reply[key] === "number")) {
    printError(String(answer.status));
    printError("That is not the endpoint's confirmation, so the push is not confirmed.");
    return 1;
  }
  print(`${answer.status} ok: ${COUNTS.map((key) => `${key} ${reply[key] as number}`).join(", ")}`);
  return 0;
}
