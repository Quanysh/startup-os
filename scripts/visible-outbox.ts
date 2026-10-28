// Read what the OS has queued for Visible (docs/setup.md, "Visible").
//
//   pnpm -s visible:outbox                 the pending items, as JSON on stdout
//   pnpm -s visible:outbox <out.json>      the same, written to a file; counts on stdout
//
// For the daily run's session, which writes each item to Visible and acks it
// with `pnpm -s visible:ack`. The items hold investor names, stages, amounts
// and note text: company data, for the session's own file. Never the token.
//
// Reads STARTUP_OS_INGEST_URL (the deployment's *.convex.site address: the app's
// own domain does not pass these routes through) and INGEST_TOKEN_VISIBLE from
// the environment, or from an untracked .env.push file next to package.json.
// The logic is in visibleOutbox.ts.

import { existsSync, writeFileSync } from "node:fs";
import { runOutbox } from "./visibleOutbox";

async function main(): Promise<void> {
  if (typeof process.loadEnvFile !== "function") {
    console.error("This script needs a Node version with process.loadEnvFile (20.12+, or 21.7+).");
    process.exitCode = 1;
    return;
  }
  // A missing file is fine: the variables may come from the environment.
  if (existsSync(".env.push")) {
    try {
      process.loadEnvFile(".env.push");
    } catch {
      console.error("Could not read .env.push.");
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = await runOutbox(process.argv.slice(2), process.env, {
    fetch,
    writeFile: (path, text) => writeFileSync(path, text, { encoding: "utf8", mode: 0o600 }),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The read failed.");
  process.exitCode = 1;
});
