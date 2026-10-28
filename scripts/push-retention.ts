// Push the CFO workbook's summary figures to the OS.
//
//   pnpm push:retention [path/to/retention.json]           print the envelope
//   pnpm push:retention [path/to/retention.json] --send    post it
//
// Reads STARTUP_OS_INGEST_URL and INGEST_TOKEN_CFO_WORKBOOK from the
// environment, or from an untracked .env.push file next to package.json, when
// sending. The logic is in pushRetention.ts; this wrapper supplies the real
// file system, network and clock.

import { existsSync, readFileSync } from "node:fs";
import { run } from "./pushRetention";

async function main(): Promise<void> {
  // Said here rather than with an `engines` range in package.json, which on
  // Vercel can change the Node version the app itself is built with.
  if (typeof process.loadEnvFile !== "function") {
    console.error("This script needs a Node version with process.loadEnvFile (20.12+, or 21.7+).");
    process.exitCode = 1;
    return;
  }

  // A missing file is fine: the variables may come from the environment. One
  // that is there but cannot be read is reported, never skipped. A variable
  // already set in the environment wins over the file's.
  if (existsSync(".env.push")) {
    try {
      process.loadEnvFile(".env.push");
    } catch {
      console.error("Could not read .env.push.");
      process.exitCode = 1;
      return;
    }
  }

  // exitCode, not process.exit(): exiting can cut off output still being
  // written to a pipe.
  process.exitCode = await run(process.argv.slice(2), process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
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
