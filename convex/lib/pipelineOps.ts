// The two pipeline tables, as the operations the shared writer works through,
// and the one function that applies a push to them.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  checkPipelineRows,
  pipelineOwner,
  type Market,
  type PipelineRowInput,
} from "./pipelineRules";
import { VISIBLE_SOURCE, reconcilePull } from "./investorSync";
import { WON, customerFromWonDeal, followDealStage } from "./wonCustomers";
import {
  applyPipelineRows,
  type PipelineCounts,
  type PipelineOps,
} from "./pipelineWriter";

const onBoard = <Row extends { archivedAt?: number }>(rows: Row[]) =>
  rows.filter((row) => row.archivedAt === undefined);

/**
 * The deals table's operations. Every write of a deal goes through `insert`
 * or `patch` here, so this is where a deal reaching Won is put on Customers
 * (and one leaving Won taken off): `followDealStage`, convex/lib/wonCustomers.ts.
 * `now` is the write's time; a caller that has one passes it.
 */
export function dealOps(ctx: MutationCtx, now: number = Date.now()): PipelineOps<Doc<"deals">, Market> {
  return {
    pipeline: "deals",
    boardOf: (deal) => deal.market,
    column: async (market, stage) =>
      onBoard(
        await ctx.db
          .query("deals")
          .withIndex("by_market_and_stage_and_order", (q) =>
            q.eq("market", market).eq("stage", stage),
          )
          .collect(),
      ),
    find: (source, externalId) =>
      ctx.db
        .query("deals")
        .withIndex("by_source_and_externalId", (q) =>
          q.eq("source", source).eq("externalId", externalId),
        )
        .unique(),
    ofSource: (source) =>
      ctx.db
        .query("deals")
        .withIndex("by_source_and_externalId", (q) => q.eq("source", source))
        .collect(),
    insert: async (market, row) => {
      const id = await ctx.db.insert("deals", { ...row, market });
      const deal = (await ctx.db.get(id))!;
      if (deal.stage === WON) await customerFromWonDeal(ctx, deal, now);
      return deal;
    },
    patch: async (deal, patch) => {
      await ctx.db.patch(deal._id, patch);
      await followDealStage(ctx, deal, patch.stage, now);
    },
  };
}

export function investorOps(ctx: MutationCtx): PipelineOps<Doc<"investors">, null> {
  return {
    pipeline: "investors",
    boardOf: () => null,
    column: async (_board, stage) =>
      onBoard(
        await ctx.db
          .query("investors")
          .withIndex("by_stage_and_order", (q) => q.eq("stage", stage))
          .collect(),
      ),
    find: (source, externalId) =>
      ctx.db
        .query("investors")
        .withIndex("by_source_and_externalId", (q) =>
          q.eq("source", source).eq("externalId", externalId),
        )
        .unique(),
    ofSource: (source) =>
      ctx.db
        .query("investors")
        .withIndex("by_source_and_externalId", (q) => q.eq("source", source))
        .collect(),
    insert: async (_board, row) => {
      const id = await ctx.db.insert("investors", row);
      return (await ctx.db.get(id))!;
    },
    patch: async (investor, patch) => {
      await ctx.db.patch(investor._id, patch);
    },
    // The owner archived it here: a Visible pull keeps it off the board.
    keepsArchived: (investor) => investor.archivedBy === "owner",
  };
}

export type PipelinePush = {
  mode: "upsert" | "replace";
  deals?: readonly PipelineRowInput[];
  investors?: readonly PipelineRowInput[];
};

const NONE: PipelineCounts = { inserted: 0, updated: 0, unchanged: 0, archived: 0 };

/**
 * Apply the pipeline part of a push, inside the caller's mutation. The rows
 * are checked again here, so a caller that skipped the endpoint's checks
 * still cannot write a row that breaks them; a throw writes nothing.
 */
export async function applyPipelinePush(
  ctx: MutationCtx,
  source: string,
  push: PipelinePush,
  now: number,
): Promise<PipelineCounts> {
  const total = { ...NONE };
  const add = (counts: PipelineCounts) => {
    for (const key of Object.keys(total) as (keyof PipelineCounts)[]) total[key] += counts[key];
  };

  if (push.deals !== undefined) {
    const checked = checkPipelineRows("deals", source, push.deals, now);
    if (checked.issues.length > 0) {
      throw new ConvexError({ code: "invalid_rows" as const, issues: checked.issues });
    }
    const market = pipelineOwner("deals", source)!.market!;
    add(await applyPipelineRows(dealOps(ctx, now), source, market, checked.rows, push.mode, now));
  }
  if (push.investors !== undefined) {
    const checked = checkPipelineRows("investors", source, push.investors, now);
    if (checked.issues.length > 0) {
      throw new ConvexError({ code: "invalid_rows" as const, issues: checked.issues });
    }
    // A change made here and not yet confirmed in Visible keeps the OS's
    // value; one Visible holds differently after it was sent gives way to it
    // (convex/lib/investorSync.ts).
    const rows =
      source === VISIBLE_SOURCE ? (await reconcilePull(ctx, checked.rows, now)).rows : checked.rows;
    add(await applyPipelineRows(investorOps(ctx), source, null, rows, push.mode, now));
  }
  return total;
}
