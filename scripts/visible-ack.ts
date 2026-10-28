// Tell the OS what the daily run did with each outbox item
// (docs/setup.md, "Visible").
//
//   pnpm -s visible:ack <file.json>          check it and say what it holds
//   pnpm -s visible:ack <file.json> --send   post it
//
// The file is `{"results": [{"id", "revision", "ok", "visibleId"?, "errorCode"?}]}`,
// checked with the endpoint's own rules before anything is shown or sent. It
// holds ids and codes; this prints counts and codes, never the token.
//
// Reads STARTUP_OS_INGEST_URL (the deployment's *.convex.site address) and
// INGEST_TOKEN_VISIBLE from the environment, or from an untracked .env.push
// file next to package.json, when sending. The logic is in visibleOutbox.ts.

import { existsSync, readFileSync } from "node:fs";
import { runAck } from "./visibleOutbox";

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
  process.exitCode = await runAck(process.argv.slice(2), process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
    fetch,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The ack failed.");
  process.exitCode = 1;
});
