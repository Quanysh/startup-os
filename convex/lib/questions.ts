// What is left of the queued questions (the `questions` table). The owner's
// "Ask at the next run" was removed in the 2026-10 dedupe: the chat on
// /assistant is the one place to ask, and nothing writes a question or an
// answer any more (no public function, no agent tool). The table is kept, and
// the rows already on record age out with the daily sweep. Runs only inside
// Convex: never import it from the UI.

import type { MutationCtx } from "../_generated/server";
import { QUESTION_RETENTION_DAYS } from "./agents";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete questions asked longer ago than `QUESTION_RETENTION_DAYS`, answered
 * or not, a batch at a time. True when there may be more.
 */
export async function pruneQuestions(ctx: MutationCtx, now: number, batch: number) {
  const before = now - QUESTION_RETENTION_DAYS * DAY_MS;
  const old = await ctx.db
    .query("questions")
    .withIndex("by_askedAt", (q) => q.lt("askedAt", before))
    .take(batch);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length === batch;
}
