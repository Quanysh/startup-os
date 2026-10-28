// Print what the OS's task board and the shared Linear mirror already hold,
// as JSON on stdout (docs/setup.md, "Standup → tasks").
//
//   pnpm -s standup:open
//
// For the Claude session that turns a standup into tasks, so it can tell what
// is missing. Titles, each with its company (and an open card's column):
// company data, for a local terminal. Never a note, an assignee or an id, and
// never the token.
//
// Reads STARTUP_OS_INGEST_URL (the route is on the same host) and
// INGEST_TOKEN_STANDUP from the environment, or from an untracked .env.push
// file next to package.json. The logic is in standupOpen.ts.

import { existsSync } from "node:fs";
import { run } from "./standupOpen";

async function main(): Promise<void> {
  if (typeof process.loadEnvFile !== "function") {
    console.error("This script needs a Node version with process.loadEnvFile (20.12+, or 21.7+).");
    process.exitCode = 1;
    return;
  }

  // A missing file is fine: the variables may come from the environment. One
  // that is there but cannot be read is reported, never skipped.
  if (existsSync(".env.push")) {
    try {
      process.loadEnvFile(".env.push");
    } catch {
      console.error("Could not read .env.push.");
      process.exitCode = 1;
      return;
    }
  }

  process.exitCode = await run(process.argv.slice(2), process.env, {
    fetch,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The read failed.");
  process.exitCode = 1;
});
