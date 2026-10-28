// What a register push must satisfy beyond its shape. Used by the endpoint,
// and by the push script before it shows or sends anything. Every message is
// a path and fixed words: a clinic's name is never quoted.

import { nameKeyOf } from "./customerShape";
import type { CustomerIngestRow, IngestIssue } from "./ingestSchema";
import { SHRINK_MAX_FRACTION, SHRINK_SMALL_LIST, SHRINK_SMALL_LIST_MAX } from "./limits";

const DAY_MS = 24 * 60 * 60 * 1000;
// Things that have happened. A contract or a BAA can be dated ahead.
const PAST_ONLY = ["lastPaymentDate", "lastUsageDate"] as const;

/**
 * What the owner's two fields of a clinic are refused with, on the page
 * (customers.setOwnerFields) and through the agents' `customer_update`.
 * Fixed words: nothing typed is echoed back, and no clinic is named.
 */
export const CUSTOMER_WORDS = {
  gone: "That clinic is no longer in the list.",
  notADate: "The next touch is not a date.",
  /** The agents' only: a note holding an email address or a phone number. */
  contact: "Leave email addresses and phone numbers out of a clinic's note. Nothing was changed.",
} as const;

export function customerRowProblems(
  rows: readonly CustomerIngestRow[],
  now: number,
): IngestIssue[] {
  const issues: IngestIssue[] = [];
  // A day's slack: the sender's "today" can be ahead of UTC.
  const latest = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const firstRowOf = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = nameKeyOf(row.name);
    const first = firstRowOf.get(key);
    if (first === undefined) firstRowOf.set(key, index);
    else {
      issues.push({
        path: `customers.${index}.name`,
        message: `is the same clinic as row ${first}`,
      });
    }
    for (const field of PAST_ONLY) {
      const value = row[field];
      if (value !== undefined && value > latest) {
        issues.push({ path: `customers.${index}.${field}`, message: "is in the future" });
      }
    }
  });
  return issues;
}

/**
 * Whether a push that leaves out `leaving` of the `live` clinics archives too
 * much to be believed without `allowShrink`: more than a quarter of the list,
 * or more than two while there are fewer than eight.
 */
export function shrinksTooFar(live: number, leaving: number): boolean {
  if (live < SHRINK_SMALL_LIST) return leaving > SHRINK_SMALL_LIST_MAX;
  return leaving * SHRINK_MAX_FRACTION > live;
}
