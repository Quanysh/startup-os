// Check the client register export against the columns the push expects.
//
//   pnpm register:headers <register.csv>
//   pnpm register:headers <register.csv> --header-row <n>
//
// The file is a CSV export of the register sheet ("CSV UTF-8" in Excel), kept
// outside this repository. For each heading in the mapping
// (`REGISTER` in customersToEnvelope.ts) it says whether the header row holds
// it, in which column, and the kind of value under it. It prints no cell of
// the file, headings included, so a wrong --header-row cannot print a clinic.

import { readFileSync } from "node:fs";
import { run } from "./registerHeaders";
import { readSheet } from "./registerSheet";

try {
  process.exitCode = run(process.argv.slice(2), {
    readFile: (path) => readFileSync(path),
    readSheet,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
} catch {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The header report failed.");
  process.exitCode = 1;
}
