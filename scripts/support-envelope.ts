// Map the daily Intercom task's raw results to an envelope for the `intercom`
// source (docs/setup.md, "Intercom (Globex): support inbox").
//
//   pnpm -s support:envelope <raw.json> [--out file] [--app id_code]
//
// Prints counts and the envelope's path, never a conversation. The file is
// written readable by its owner alone. Then `pnpm push:envelope <file>` checks
// it and `--send` pushes it. The logic is in supportEnvelope.ts; this wrapper
// supplies the real file system and clock.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { run } from "./supportEnvelope";

run(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text, mode) => {
    writeFileSync(path, text, { mode });
    // A file that was already there keeps its old mode otherwise.
    chmodSync(path, mode);
  },
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  now: () => new Date(),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // Fixed text: nothing that failed here is safe to quote.
    console.error("The mapping failed.");
    process.exitCode = 1;
  });
