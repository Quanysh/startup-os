// Apollo's sequence search turned into snapshot rows. Pure: no fetch, no clock.
//
// A sequence comes back whole: its name, its owner, its steps. The schema
// below names three counters and one flag, and zod drops every field a schema
// does not name, so nothing else leaves this file. Rows are built from
// literals after the counters are added up.

import { z } from "zod";
import { periodStart } from "../lib/periods";
import type { SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { expectShape } from "./marketingShape";

const count = z.number().int().min(0);

const searchPage = z.object({
  pagination: z.object({ total_entries: count, total_pages: count }),
  emailer_campaigns: z.array(
    z.object({
      // Strict on purpose: a counter that is null or absent fails the read. An
      // unknown count must not be added up as zero.
      unique_delivered: count,
      unique_opened: count,
      unique_replied: count,
      loaded_stats: z.boolean().optional(),
    }),
  ),
});

export type SequenceTotals = { delivered: number; opened: number; replied: number };

export function parseSequences(raw: unknown): {
  totalPages: number;
  totalEntries: number;
  sequences: SequenceTotals[];
} {
  const parsed = expectShape(searchPage, raw, "Apollo's sequences");
  if (parsed.emailer_campaigns.some((sequence) => sequence.loaded_stats === false)) {
    // Its counters would read as zeros and lower every total.
    throw new ConnectorError("Apollo sent a sequence without its statistics.");
  }
  return {
    totalPages: parsed.pagination.total_pages,
    totalEntries: parsed.pagination.total_entries,
    sequences: parsed.emailer_campaigns.map((sequence) => ({
      delivered: sequence.unique_delivered,
      opened: sequence.unique_opened,
      replied: sequence.unique_replied,
    })),
  };
}

/** Every sequence's counters added up. Archived sequences count: their emails were sent. */
export function totalsOf(sequences: readonly SequenceTotals[]): SequenceTotals {
  return sequences.reduce(
    (sum, s) => ({
      delivered: sum.delivered + s.delivered,
      opened: sum.opened + s.opened,
      replied: sum.replied + s.replied,
    }),
    { delivered: 0, opened: 0, replied: 0 },
  );
}

/**
 * The totals to date, filed under the week being read. Each daily run
 * overwrites that week's bucket, so once the week is over the bucket holds
 * the totals as last read in it.
 */
export function toSnapshots(totals: SequenceTotals, now: number): SnapshotInput[] {
  const row = (key: string, value: number): SnapshotInput => ({
    key,
    scope: "us",
    period: "week",
    periodStart: periodStart("week", now),
    value,
  });
  return [
    row("outbound_delivered", totals.delivered),
    row("outbound_opened", totals.opened),
    row("outbound_replied", totals.replied),
  ];
}
