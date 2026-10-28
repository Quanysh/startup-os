// Load a prospect list onto the US sales board.
//
//   pnpm import:prospects <file.json> --check     read and check it, send nothing
//   pnpm import:prospects <file.json>             into the dev deployment
//   pnpm import:prospects <file.json> --prod      into production
//   pnpm import:prospects <file.json> --no-meta   without the <file>.meta.json sidecar
//
// Runs `npx convex run deals:importProspects` (an internal mutation) with the
// deployment the Convex CLI picks from this folder, or production with
// --prod. Run again, it skips every name already on the US board.
//
// Handles company and person names: it prints counts, row numbers and fixed
// sentences, never a row. The logic is in importProspects.ts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { run } from "./importProspects";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

try {
  process.exitCode = run(process.argv.slice(2), {
    readFile: readText,
    convexRun: (args) => {
      // No shell: the rows travel as one argument, never through quoting.
      const result = spawnSync("npx", ["convex", ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
} catch {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The import failed.");
  process.exitCode = 1;
}
