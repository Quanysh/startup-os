// Apollo (US outbound): emails delivered, opened and replied to, to date.
//
// Apollo counts per sequence, for all time; it has nothing by week. So this
// stores the totals as read, one bucket per week, and a week's own figure is
// worked out at read time from two weeks' totals.
//
// Stores totals only: no sequence name, no contact, no step.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { SnapshotInput } from "../lib/snapshotRules";
import { parseSequences, toSnapshots, totalsOf, type SequenceTotals } from "./apolloParse";
import { ConnectorError } from "./errors";
import { requestJson } from "./marketingRequest";
import { runConnector } from "./run";

const API = "https://api.apollo.io/api/v1";
const PER_PAGE = 100;
const MAX_PAGES = 20;

/** This week's totals as snapshot rows. `now` is the runner's clock. */
export async function readApollo(now: number): Promise<SnapshotInput[]> {
  const all: SequenceTotals[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { sequences, totalPages, totalEntries } = parseSequences(
      await requestJson({
        service: "Apollo",
        what: "sequences",
        // Only paging goes in the URL: no name to search by, and the key is a header.
        url: `${API}/emailer_campaigns/search?page=${page}&per_page=${PER_PAGE}`,
        method: "POST",
        headers: {
          "x-api-key": process.env.APOLLO_API_KEY ?? "",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        body: "{}",
      }),
    );
    all.push(...sequences);
    if (sequences.length > 0 && page < totalPages) continue;
    // Done, or cut short. A list shorter than Apollo's own count would lower
    // every total, so it is a failed read, not a smaller number.
    if (all.length < totalEntries) {
      throw new ConnectorError(
        "Apollo listed fewer sequences than it counted; the totals would be short.",
      );
    }
    // No sequence at all: the runner records an empty result.
    return all.length === 0 ? [] : toSnapshots(totalsOf(all), now);
  }
  throw new ConnectorError(`Apollo has more than ${MAX_PAGES * PER_PAGE} sequences.`);
}

export const sync = internalAction({
  // `months` is accepted because every sync takes it; Apollo has no history to
  // reach back into, so a backfill is an ordinary run.
  args: { months: v.optional(v.number()) },
  handler: async (ctx) => runConnector(ctx, "apollo", (now) => readApollo(now)),
});
