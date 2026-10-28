// A deal that reaches Won is a customer. Called from the one place every deal
// is written through (`dealOps` in pipelineOps.ts: the Sales page's drag and
// editor, `deal_update`, a deal made at Won, approving a proposal, the
// Kazakhstan CRM's push), so no path can win a deal and skip it.
//
// The client register stays the record of truth. A clinic it already carries
// (same name key and market) is linked to the deal, never doubled; otherwise a
// row of the `deals` source is made, which the register's next push of the
// same clinic supersedes (convex/customers.ts, `applyRegister`). A deal that
// leaves Won archives only the row it made, never a register row.
//
// Like convex/customers.ts, nothing here puts a name in a thrown error or a
// log line: the functions return what they did, in fixed words.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MARKET_CURRENCY, REGISTER_SOURCE, SALES_SOURCE, nameKeyOf } from "./customerShape";

/** The stage that makes a customer. */
export const WON = "won";

/** Rows read per lookup: one clinic has one or two, so this only bounds a read gone wrong. */
const LOOKUP = 20;

/** "YYYY-MM-DD" in UTC: the day a deal was won, as the register writes a contract date. */
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

const linkedTo = (ctx: MutationCtx, dealId: Id<"deals">) =>
  ctx.db
    .query("customers")
    .withIndex("by_dealId", (q) => q.eq("dealId", dealId))
    .take(LOOKUP);

export type WonOutcome = "created" | "linked" | "unchanged";

/**
 * Put a won deal on Customers. `now` is when it was won here; a deal that
 * carries its own close date (the CRM's) is contracted on that day instead.
 *
 * - A clinic already on the list under the same name key and market (the
 *   register's, first; or one another deal made) is the customer: it gets the
 *   link if it has none, and a row this deal made earlier is archived.
 * - Otherwise this deal's own row is made, or brought back and refreshed:
 *   status active (the register's word for a clinic that is a customer now),
 *   the market's currency, the deal's amount as the monthly fee (a deal's
 *   amount is its expected monthly fee: schema.ts, docs/ingest.md), absent
 *   when the deal has none.
 *
 * Idempotent: winning the same deal again changes nothing.
 */
export async function customerFromWonDeal(ctx: MutationCtx, deal: Doc<"deals">, now: number): Promise<WonOutcome> {
  const nameKey = nameKeyOf(deal.name);
  const linked = await linkedTo(ctx, deal._id);
  const own = linked.find((row) => row.source === SALES_SOURCE);
  const sameName = await ctx.db
    .query("customers")
    .withIndex("by_nameKey_and_market", (q) => q.eq("nameKey", nameKey).eq("market", deal.market))
    .take(LOOKUP);
  const onList = (row: Doc<"customers">) => row.archivedAt === undefined && row._id !== own?._id;
  const other =
    linked.find((row) => row.source !== SALES_SOURCE && onList(row)) ??
    sameName.find((row) => row.source === REGISTER_SOURCE && onList(row)) ??
    sameName.find(onList);

  if (other !== undefined) {
    let changed = false;
    if (other.dealId === undefined) {
      await ctx.db.patch(other._id, { dealId: deal._id });
      changed = true;
    }
    if (own !== undefined && own.archivedAt === undefined) {
      await ctx.db.patch(own._id, { archivedAt: now });
      changed = true;
    }
    return changed ? "linked" : "unchanged";
  }

  const fields = {
    name: deal.name,
    nameKey,
    market: deal.market,
    status: "active" as const,
    currency: MARKET_CURRENCY[deal.market],
    monthlyFee: deal.amount,
    contractDate: dayOf(deal.closedAt ?? now),
  };
  if (own === undefined) {
    await ctx.db.insert("customers", { source: SALES_SOURCE, dealId: deal._id, ...fields, syncedAt: now });
    return "created";
  }
  const same =
    own.archivedAt === undefined &&
    (Object.keys(fields) as (keyof typeof fields)[]).every((field) => own[field] === fields[field]);
  if (same) return "unchanged";
  await ctx.db.patch(own._id, { ...fields, syncedAt: now, archivedAt: undefined });
  return "created";
}

/**
 * A deal that left Won: the row it made goes off the list (archived, with its
 * note, and back if the deal is won again). A register row linked to it is
 * the register's and is left as it is.
 */
export async function customerLeavesWon(ctx: MutationCtx, dealId: Id<"deals">, now: number): Promise<void> {
  for (const row of await linkedTo(ctx, dealId)) {
    if (row.source === SALES_SOURCE && row.archivedAt === undefined) {
      await ctx.db.patch(row._id, { archivedAt: now });
    }
  }
}

/** A deal that is deleted: the row it made is archived and no link to it is left. */
export async function customerOfDeletedDeal(ctx: MutationCtx, dealId: Id<"deals">, now: number): Promise<void> {
  for (const row of await linkedTo(ctx, dealId)) {
    const off = row.source === SALES_SOURCE && row.archivedAt === undefined;
    await ctx.db.patch(row._id, { dealId: undefined, ...(off ? { archivedAt: now } : null) });
  }
}

/**
 * Follow one write of a deal: `before` is the row as it was, `stage` the
 * stage the write set (undefined when it set none). Moving to Won (or a push
 * that rewrites a won deal) puts it on Customers; moving off Won takes the
 * row it made away.
 */
export async function followDealStage(
  ctx: MutationCtx,
  before: Doc<"deals">,
  stage: string | undefined,
  now: number,
): Promise<void> {
  if (stage === undefined) return;
  if (stage === WON) {
    const after = await ctx.db.get(before._id);
    if (after !== null && after.archivedAt === undefined) await customerFromWonDeal(ctx, after, now);
  } else if (before.stage === WON) {
    await customerLeavesWon(ctx, before._id, now);
  }
}

/** Won deals read per market by the one-off migration: more than either board holds. */
export const WON_READ = 2_000;

/**
 * Apply the rule to the deals already at Won (`migrations:customersFromWonDeals`,
 * and the local seed). Counts only.
 */
export async function customersFromWonDeals(ctx: MutationCtx, now: number) {
  const counts = { won: 0, created: 0, linked: 0, unchanged: 0 };
  for (const market of ["us", "kz"] as const) {
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", market).eq("stage", WON))
      .take(WON_READ);
    for (const deal of deals) {
      if (deal.archivedAt !== undefined) continue;
      counts.won += 1;
      counts[await customerFromWonDeal(ctx, deal, now)] += 1;
    }
  }
  return counts;
}
