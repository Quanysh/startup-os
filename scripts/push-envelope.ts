// Push one ready-made envelope file to the OS (docs/ingest.md, "Feeding the OS
// from Claude connectors").
//
//   pnpm push:envelope <file.json>           check it and say what it holds
//   pnpm push:envelope <file.json> --send    post it
//
// The file is checked with the endpoint's own rules before anything is shown
// or sent. It may hold names and message subjects, so this prints the source,
// the kind, counts and metric keys, never a row. For the financial model's
// plan it prints the model's version, a count, and the scenarios, years and
// figures covered, never a value.
//
// Reads STARTUP_OS_INGEST_URL and the envelope's own source's token
// (INGEST_TOKEN_<SOURCE>) from the environment, or from an untracked
// .env.push file next to package.json, when sending. The logic is in
// pushEnvelope.ts; this wrapper supplies the real file system, network and clock.

import { existsSync, readFileSync } from "node:fs";
import { run } from "./pushEnvelope";

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
