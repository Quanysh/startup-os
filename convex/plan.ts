import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { memberQuery } from "./lib/owner";
import { planProblems } from "./lib/planRules";
import { PLAN_KEYS, PLAN_SCENARIOS, isPlanKey, type PlanRow } from "./lib/planShape";
import { planScenarioValidator } from "./schema";
import { setSourceStatus } from "./snapshots";

// The plan: what the financial model expects of each year under each of its
// three scenarios (bear, base, bull), a handful of figures a year. This file
// and the `planFigures` table are the only places it is handled inside Convex.
//
// It is not a metric. A metric is something that happened, kept by bucket and
// held against a benchmark; the plan describes years that have not happened,
// so it has no registry entry, no snapshot and nothing to go stale. All that
// is said about its age is when it was pushed.
//
// A push is the whole plan and replaces what is stored: a row the push does
// not name is deleted, not archived. The model is the source of truth, and
// nothing the owner typed hangs on a plan row, so there is nothing to keep.
//
// The plan is Startup's US business. It is read through `get` alone, by the
// `finance` area of the `us` company: finance on Globex does not open it.

const planRow = v.object({
  scenario: planScenarioValidator,
  year: v.number(),
  key: v.string(),
  value: v.number(),
});

/** What makes two rows the same figure: one value per scenario, year and figure. */
const idOf = (row: { scenario: string; year: number; key: string }) =>
  `${row.scenario}|${row.year}|${row.key}`;

/**
 * Store one push of the plan: all of it. Rows, the run-log entry and the
 * source's status land in one transaction.
 *
 * A figure counts as updated only when its value changed. A new model version
 * with the same values changes no figure, but every row is stamped with the
 * version and the time of the push that last carried it. A stored row the
 * push does not name is removed, and counted as an update: the run log has
 * three columns.
 */
export const apply = internalMutation({
  args: {
    source: v.string(),
    batchId: v.optional(v.string()),
    observedAt: v.optional(v.string()),
    startedAt: v.number(),
    modelVersion: v.string(),
    rows: v.array(planRow),
  },
  handler: async (ctx, args) => {
    // The endpoint checks the rows first and names the ones it refuses; this
    // is the backstop, before anything is written. Fixed words: no row is quoted.
    if (!args.rows.every((row) => isPlanKey(row.key))) {
      throw new Error("A plan row has a figure the OS does not keep.");
    }
    // The endpoint's own rules again: each value within its figure's limits,
    // no row twice, every scenario with every figure for every year. A push
    // replaces the plan, so part of one must never be written. After the
    // check above, because these rules look a row's limits up by its figure.
    if (planProblems(args.rows as PlanRow[]).length > 0) throw new Error("The plan is not whole.");

    const now = Date.now();
    const existing = await ctx.db.query("planFigures").collect();
    const byId = new Map(existing.map((row) => [idOf(row), row]));
    const named = new Set<string>();
    const counts = { inserted: 0, updated: 0, unchanged: 0 };

    for (const row of args.rows) {
      const id = idOf(row);
      named.add(id);
      const current = byId.get(id);
      if (current === undefined) {
        await ctx.db.insert("planFigures", {
          scenario: row.scenario,
          year: row.year,
          key: row.key,
          value: row.value,
          modelVersion: args.modelVersion,
          syncedAt: now,
        });
        counts.inserted += 1;
        continue;
      }
      await ctx.db.patch(current._id, {
        value: row.value,
        modelVersion: args.modelVersion,
        syncedAt: now,
      });
      if (current.value === row.value) counts.unchanged += 1;
      else counts.updated += 1;
    }

    // What the model no longer has (a year it dropped) goes with this push.
    for (const gone of existing) {
      if (named.has(idOf(gone))) continue;
      await ctx.db.delete(gone._id);
      counts.updated += 1;
    }

    // Counts only.
    await ctx.db.insert("syncRuns", {
      source: args.source,
      batchId: args.batchId,
      observedAt: args.observedAt,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
    });
    await setSourceStatus(ctx, args.source, { state: "ok", at: now });
    return counts;
  },
});

/**
 * The stored plan, or null when none has been pushed: its rows by scenario
 * (bear, base, bull), then year, then figure in the order the Finance page
 * lists them, with the model version and the time of the latest push.
 *
 * How old that makes the plan is the page's to say: a query must not read
 * the clock.
 */
export const get = memberQuery("finance", "us")({
  args: {},
  handler: async (ctx) => {
    const stored = await ctx.db.query("planFigures").collect();
    if (stored.length === 0) return null;

    const newest = stored.reduce((latest, row) => (row.syncedAt > latest.syncedAt ? row : latest));
    const rows: PlanRow[] = [];
    for (const row of stored) {
      // A figure the OS has since stopped keeping stays out until the next
      // push removes it.
      if (!isPlanKey(row.key)) continue;
      rows.push({ scenario: row.scenario, year: row.year, key: row.key, value: row.value });
    }
    rows.sort(
      (a, b) =>
        PLAN_SCENARIOS.indexOf(a.scenario) - PLAN_SCENARIOS.indexOf(b.scenario) ||
        a.year - b.year ||
        PLAN_KEYS.indexOf(a.key) - PLAN_KEYS.indexOf(b.key),
    );
    return { modelVersion: newest.modelVersion, syncedAt: newest.syncedAt, rows };
  },
});
