// The logic of `pnpm standup:open`: ask the OS what its task board and the
// shared Linear mirror already hold, and print it as JSON on stdout for the
// Claude session that is turning a standup into tasks (docs/setup.md,
// "Standup → tasks").
//
// What it prints is titles: company data, acceptable in a local terminal for
// that session to read, and nothing more than the endpoint sends (no note, no
// assignee, no id). It never prints the token, and of a reply it does not
// recognise it prints nothing. standup-open.ts is the thin wrapper.

import { z } from "zod";
import { ALL_COMPANY_IDS } from "../convex/lib/company";
import { ask, printRefusal, settings, type HttpDeps } from "./standupHttp";

export const USAGE = "Usage: pnpm standup:open";

const company = z.enum(ALL_COMPANY_IDS).nullable();
// Not strict: a field this script does not know is dropped, never passed on.
const listing = z.object({
  ok: z.literal(true),
  open: z.array(
    z.object({
      title: z.string(),
      company,
      column: z.enum(["backlog", "this_week", "doing"]),
    }),
  ),
  done: z.array(z.object({ title: z.string(), company })),
  linear: z.array(z.object({ title: z.string(), company })),
  truncated: z.boolean(),
});

/** Returns the process exit code. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: HttpDeps,
): Promise<number> {
  if (argv.length > 0) {
    deps.printError(USAGE);
    return 1;
  }
  const target = settings(env, deps);
  if (target === null) return 1;

  const answer = await ask(target.open, target.token, undefined, deps);
  if (answer === null) return 1;
  if (!answer.ok) {
    printRefusal(answer, deps);
    return 1;
  }
  const read = listing.safeParse(answer.body);
  if (!read.success) {
    deps.printError(String(answer.status));
    deps.printError("That is not the endpoint's list, so nothing is printed.");
    return 1;
  }
  const { open, done, linear, truncated } = read.data;
  // One document. JSON's own escaping keeps a title from writing to the terminal.
  deps.print(JSON.stringify({ open, done, linear, truncated }, null, 2));
  if (truncated) {
    deps.printError(
      "The list was cut short: the board or Linear holds more than was returned. Treat a task you cannot rule out as already there.",
    );
  }
  return 0;
}
