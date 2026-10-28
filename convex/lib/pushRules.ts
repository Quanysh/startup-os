// Rules for numbers a connector run pushes for a source the OS can also pull
// (docs/ingest.md, "Feeding the OS from Claude connectors"). The registry
// decides who owns a metric and what a believable value is; these are the
// rules the pulled connector's own parser enforces and a push would otherwise
// skip. Pure, so the push script applies them before sending.
// GitHub is pushed only (`pnpm gather:github`), and its week rules are here too.
//
// Every message is fixed words: nothing a sender wrote is quoted.

import { periodStart } from "./periods";
import type { SnapshotInput, SnapshotIssue } from "./snapshotRules";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_NOT_ENDED = "This week has not ended. Only finished weeks are stored.";

/**
 * Apollo's metrics that are one week's own count rather than a total to date.
 * Every other Apollo metric is a level filed under the week in progress.
 */
export const APOLLO_FINISHED_WEEK_KEYS: readonly string[] = [
  "apollo_contacts_added",
  "apollo_calls",
];

/**
 * GitHub's metrics that are one week's own count (pull requests merged and
 * opened). Its others are levels filed under the week in progress.
 */
export const GITHUB_FINISHED_WEEK_KEYS: readonly string[] = ["prs_merged", "prs_opened"];

export function pushedSnapshotProblems(
  source: string,
  rows: readonly SnapshotInput[],
  now: number,
): SnapshotIssue[] {
  const thisWeek = periodStart("week", now);
  const issues: SnapshotIssue[] = [];
  rows.forEach((row, index) => {
    if (row.period !== "week") return;
    // Product weeks are stored once they have ended (posthogParse refuses the
    // week in progress too): a part-week would read as a bad week.
    if (source === "posthog" && row.periodStart >= thisWeek) {
      issues.push({ index, field: "periodStart", message: WEEK_NOT_ENDED });
    }
    if (source === "github") {
      // A week's own count is stored for finished weeks only, as a product
      // week is: the script sends the last thirteen, and never a part-week.
      if (GITHUB_FINISHED_WEEK_KEYS.includes(row.key)) {
        if (row.periodStart >= thisWeek) {
          issues.push({ index, field: "periodStart", message: WEEK_NOT_ENDED });
        }
        return;
      }
      // The rest are levels (open, waiting, failing, tracked): what was true
      // when it was read, filed under that week. Under another they would
      // rewrite its history. The same day of grace as Apollo's.
      if (row.periodStart !== thisWeek && row.periodStart !== periodStart("week", now - DAY_MS)) {
        issues.push({
          index,
          field: "periodStart",
          message: "A level belongs to the week it is read in.",
        });
      }
      return;
    }
    if (source !== "apollo") return;
    // A week's own count (contacts added, calls) is stored once the week has
    // ended, as a product week is, and may be sent for any finished week: the
    // report it is read from covers several. The week in progress is refused
    // rather than stored and corrected daily, so no chart shows a part-week.
    if (APOLLO_FINISHED_WEEK_KEYS.includes(row.key)) {
      if (row.periodStart >= thisWeek) {
        issues.push({ index, field: "periodStart", message: WEEK_NOT_ENDED });
      }
      return;
    }
    // Apollo's other figures are totals to date, filed under the week being
    // read (apolloParse). Filed under another week they would rewrite its
    // history. A day of grace covers a read made just before Monday and sent
    // after it.
    if (row.periodStart !== thisWeek && row.periodStart !== periodStart("week", now - DAY_MS)) {
      issues.push({
        index,
        field: "periodStart",
        message: "Totals to date belong to the week they are read in.",
      });
    }
  });
  return issues;
}
