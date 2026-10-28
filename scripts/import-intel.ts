// Load research onto the US deals: each deal's sales intelligence.
//
//   pnpm import:intel <file.json> --check     read and check it, send nothing
//   pnpm import:intel <file.json>             into the dev deployment
//   pnpm import:intel <file.json> --prod      into production
//
// Runs `npx convex run dealIntel:importIntel` (an internal mutation) with the
// deployment the Convex CLI picks from this folder, or production with
// --prod. A row replaces its deal's intelligence whole, so running it again
// with the same file changes nothing but the time it was written.
//
// Handles company and person names: it prints counts, row numbers and fixed
// sentences, never a row. The logic is in importIntel.ts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { run } from "./importIntel";

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
