// Push the client register (one row per clinic) to the OS.
//
//   pnpm push:customers <register.csv>           summarise what would be sent
//   pnpm push:customers <register.csv> --send    post it
//
// With --send, rows left unread under a blank row refuse the push unless
// --stop-at-blank says the list ends there.
//
// The file is a CSV export of the register sheet of the CFO's workbook ("CSV
// UTF-8" in Excel), kept outside this repository.
//
// Handles client names: it prints counts and column headings, never a row.
// Reads STARTUP_OS_INGEST_URL and INGEST_TOKEN_CLIENT_REGISTER from the
// environment, or from an untracked .env.push file next to package.json, when
// sending. The logic is in pushCustomers.ts.

import { existsSync, readFileSync } from "node:fs";
import { run } from "./pushCustomers";
import { readSheet } from "./registerSheet";

async function main(): Promise<void> {
  if (typeof process.loadEnvFile !== "function") {
    console.error("This script needs a Node version with process.loadEnvFile (20.12+, or 21.7+).");
    process.exitCode = 1;
    return;
  }
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
    readFile: (path) => readFileSync(path),
    readSheet,
    fetch,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    now: () => new Date(),
  });
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The push failed.");
  process.exitCode = 1;
});
