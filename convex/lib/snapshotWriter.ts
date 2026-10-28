import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { validateSnapshots, type SnapshotInput } from "./snapshotRules";

export type WriteCounts = { inserted: number; updated: number; unchanged: number };

/**
 * Write a batch of snapshots from one source: insert new buckets, overwrite
 * changed ones, and leave identical ones untouched (no write means no reactive
 * query re-runs for a sync that found nothing new).
 *
 * The batch is validated against the registry first and rejected whole on any
 * problem. Runs inside the caller's mutation, so a throw writes nothing.
 * Nothing is ever deleted here.
 */
export async function upsertSnapshots(
  ctx: MutationCtx,
  source: string,
  rows: readonly SnapshotInput[],
  syncedAt: number,
): Promise<WriteCounts> {
  const issues = validateSnapshots(source, rows, undefined, { now: syncedAt });
  if (issues.length > 0) {
    throw new ConvexError({ code: "invalid_snapshots" as const, issues });
  }

  const counts: WriteCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (const row of rows) {
    const existing = await ctx.db
      .query("metricSnapshots")
      .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
        q
          .eq("key", row.key)
          .eq("scope", row.scope)
          .eq("period", row.period)
          .eq("periodStart", row.periodStart),
      )
      .unique();

    if (existing === null) {
      await ctx.db.insert("metricSnapshots", { ...row, source, syncedAt });
      counts.inserted++;
    } else if (
      existing.value === row.value &&
      existing.currency === row.currency &&
      existing.source === source
    ) {
      counts.unchanged++;
    } else {
      await ctx.db.patch(existing._id, {
        value: row.value,
        currency: row.currency,
        source,
        syncedAt,
      });
      counts.updated++;
    }
  }
  return counts;
}
