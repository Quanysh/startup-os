import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { removeIntelOf } from "./dealIntel";
import { requireGoalLink } from "./goals";
import { DEAL_DETAIL_FIELDS, normalDealName, type DealDetails } from "./lib/dealDetails";
import { MAX_IMPORT_ROWS } from "./lib/limits";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import {
  cardOnBoard,
  createCard,
  editCard,
  isMirrored,
  moveCard,
  newestClosedFirst,
  presentCard,
  refuseMirrored,
  type CardEdit,
  type CardWords,
} from "./lib/pipelineCards";
import {
  cleanDealDetails,
  cleanProspectRows,
  type DealDetailsEdit,
} from "./lib/pipelineFields";
import { dealOps } from "./lib/pipelineOps";
import { NATIVE_DEAL_MARKETS, NATIVE_SOURCE } from "./lib/pipelineRules";
import {
  CLOSED_STAGES,
  DEAL_STAGES,
  UNMAPPED,
  isStage,
  type DealStage,
} from "./lib/pipelineStages";
import { bottomOf } from "./lib/pipelineWriter";
import { customerOfDeletedDeal } from "./lib/wonCustomers";
import { dealPriorityValidator, marketValidator } from "./schema";

const WORDS: CardWords = { noun: "deal", nameNeeds: "A deal needs a company name" };
const NOT_MADE_HERE = "Kazakhstan deals come from the Kazakhstan CRM and cannot be added here.";

/**
 * Whether a deal has details: one made here, in a market where deals are made
 * here. A mirrored deal has none, and nor does anything on Kazakhstan's board:
 * its cards carry no such field at all, exactly as before deals had details.
 */
const takesDetails = (deal: Doc<"deals">) =>
  !isMirrored(deal) && NATIVE_DEAL_MARKETS.includes(deal.market);

const NO_DETAILS_HERE = "Only a US deal made here has a priority, region, size and sources.";

/** A native deal's details as the board sends them. */
const detailsOf = (deal: Doc<"deals">): DealDetails => ({
  priority: deal.priority ?? null,
  region: deal.region ?? null,
  physicians: deal.physicians ?? null,
  locations: deal.locations ?? null,
  sources: deal.sources ?? [],
});

/** A deal as a board sends it. */
export type DealCard = ReturnType<typeof presentCard> & {
  id: Id<"deals">;
  market: Doc<"deals">["market"];
} & Partial<DealDetails>;

const present = (deal: Doc<"deals">): DealCard => ({
  ...presentCard(deal),
  id: deal._id,
  market: deal.market,
  ...(takesDetails(deal) ? detailsOf(deal) : {}),
});
type Card = DealCard;

/** The deal, unless it is of a market the caller is not on: that is refused. */
function theirs(member: Member, deal: Doc<"deals"> | null): Doc<"deals"> | null {
  if (deal !== null) requireCompany(member, deal.market);
  return deal;
}

/**
 * One market's sales board: every stage with its cards, plus "unmapped" for
 * mirrored deals whose stage name the OS does not know. Returns timestamps
 * and never judges staleness: that needs "now", which a query must not read.
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function dealBoardFor(ctx: QueryCtx, member: Member, market: Doc<"deals">["market"]) {
  {
    const args = { market };
    requireCompany(member, args.market);
    const columns = Object.fromEntries(
      [...DEAL_STAGES, UNMAPPED].map((stage) => [stage, [] as Card[]]),
    ) as Record<DealStage | typeof UNMAPPED, Card[]>;
    // The index yields each stage's cards in their stored order.
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", args.market))
      .collect();
    for (const deal of deals) {
      if (deal.archivedAt !== undefined) continue;
      const stage = isStage("deals", deal.stage) ? (deal.stage as DealStage) : UNMAPPED;
      columns[stage].push(present(deal));
    }
    for (const stage of CLOSED_STAGES.deals) columns[stage as DealStage].sort(newestClosedFirst);
    return columns;
  }
}

export const board = memberQuery("sales")({
  args: { market: marketValidator },
  handler: (ctx, args) => dealBoardFor(ctx, ctx.member, args.market),
});

/**
 * How many deals were created at or after `since`, per market, split into
 * native (made here) and mirrored (pushed by the system that owns them).
 * Counts only: no name leaves the table. Archived rows are left out, as they
 * are from every other number. `since` is the caller's (a week's start, say):
 * a query never reads the clock.
 *
 * "Created" is when the OS first stored the row. For a mirrored deal that is
 * the push that first listed it, not the day the CRM made it, so the first
 * push of an existing pipeline counts every deal in it.
 */
export const createdSince = memberQuery("sales")({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const counts = {
      us: { native: 0, mirrored: 0 },
      kz: { native: 0, mirrored: 0 },
    };
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.since))
      .collect();
    for (const deal of deals) {
      if (deal.archivedAt !== undefined) continue;
      // A market the caller is not on stays at nothing counted: the shape is
      // fixed, and how many deals the other company made is not theirs.
      if (!ctx.member.companies.includes(deal.market)) continue;
      counts[deal.market][isMirrored(deal) ? "mirrored" : "native"] += 1;
    }
    return counts;
  },
});

/** A deal to make here: a card's fields, and a US deal's details. */
export type NewDeal = {
  market: Doc<"deals">["market"];
  name: string;
  stage?: string;
  contact?: string;
  amount?: number;
  nextStep?: string;
  notes?: string;
} & DealDetailsEdit;

/**
 * Make a deal here: what `deals.create` runs, and approving a `deal_create`
 * proposal with it (convex/lib/proposals.ts), so the two cannot drift. A
 * card at the bottom of its stage (lead unless given), the board's own
 * cleaning, and a US deal's details cleaned by `cleanDealDetails`.
 *
 * `anyMarket` is the approved proposal's alone: the owner decided (2026-10-19)
 * that a bot may propose a Kazakhstan deal, made here (`source` "manual", so
 * not mirrored) and never synced back to the Kazakhstan CRM. The page itself
 * still makes none. `createdBy` names the proposer.
 */
export async function createDeal(
  ctx: MutationCtx,
  member: Member,
  { market, priority, region, physicians, locations, sources, ...card }: NewDeal,
  options: { now: number; anyMarket?: boolean; createdBy?: string },
): Promise<Id<"deals">> {
  requireCompany(member, market);
  if (options.anyMarket !== true && !NATIVE_DEAL_MARKETS.includes(market)) throw new ConvexError(NOT_MADE_HERE);
  const details: DealDetailsEdit = { priority, region, physicians, locations, sources };
  const withDetails = DEAL_DETAIL_FIELDS.some((field) => details[field] !== undefined);
  if (withDetails && !NATIVE_DEAL_MARKETS.includes(market)) throw new ConvexError(NO_DETAILS_HERE);
  // Cleaned before anything is written; a throw below writes nothing anyway.
  const patch = withDetails ? cleanDealDetails(details) : {};
  const id = await createCard(dealOps(ctx, options.now), market, card, DEAL_STAGES[0], WORDS, options.now);
  if (withDetails || options.createdBy !== undefined) {
    await ctx.db.patch(id, { ...patch, ...(options.createdBy === undefined ? null : { createdBy: options.createdBy }) });
  }
  return id;
}

export const create = memberMutation("sales")({
  args: {
    market: marketValidator,
    name: v.string(),
    stage: v.optional(v.string()),
    contact: v.optional(v.string()),
    amount: v.optional(v.number()),
    nextStep: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: (ctx, args) => createDeal(ctx, ctx.member, args, { now: Date.now() }),
});

/** Put a deal at a position in a stage. */
export const move = memberMutation("sales")({
  args: { id: v.id("deals"), stage: v.string(), index: v.number() },
  handler: async (ctx, args) => {
    const deal = theirs(ctx.member, await ctx.db.get(args.id));
    await moveCard(dealOps(ctx), deal, args.stage, args.index, WORDS, Date.now());
    return null;
  },
});

/**
 * Edit a deal: what `deals.update` runs, and the owner's agent with it. A
 * deal of a market the person is not on is refused; a mirrored deal takes a
 * next step and notes and nothing else (`editCard`), so none of the details
 * either. Details are not activity: changing one leaves `lastActivityAt`.
 */
export async function updateDeal(
  ctx: MutationCtx,
  member: Member,
  { id, ...edit }: { id: Id<"deals"> } & CardEdit & DealDetailsEdit,
): Promise<null> {
  const deal = theirs(member, await ctx.db.get(id));
  const { priority, region, physicians, locations, sources, ...card } = edit;
  const details: DealDetailsEdit = { priority, region, physicians, locations, sources };
  const withDetails = DEAL_DETAIL_FIELDS.some((field) => details[field] !== undefined);
  if (withDetails) {
    const row = cardOnBoard(deal, WORDS);
    refuseMirrored(row, WORDS);
    if (!takesDetails(row)) throw new ConvexError(NO_DETAILS_HERE);
  }
  // Cleaned before anything is written; a throw below writes nothing anyway.
  const patch = withDetails ? cleanDealDetails(details) : {};
  await editCard(dealOps(ctx), deal, card, WORDS, Date.now());
  if (withDetails) await ctx.db.patch(id, patch);
  return null;
}

/**
 * Edit a deal. Changing `stage` here moves the card to the top of the new
 * stage in the same transaction, so the editor never half-saves.
 */
export const update = memberMutation("sales")({
  args: {
    id: v.id("deals"),
    name: v.optional(v.string()),
    stage: v.optional(v.string()),
    // For the rest, null clears the field and leaving it out keeps it.
    contact: v.optional(v.union(v.string(), v.null())),
    amount: v.optional(v.union(v.number(), v.null())),
    nextStep: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    // A deal's details: a deal made here only.
    priority: v.optional(v.union(dealPriorityValidator, v.null())),
    region: v.optional(v.union(v.string(), v.null())),
    physicians: v.optional(v.union(v.number(), v.null())),
    locations: v.optional(v.union(v.number(), v.null())),
    sources: v.optional(v.union(v.array(v.string()), v.null())),
  },
  handler: (ctx, args) => updateDeal(ctx, ctx.member, args),
});

/**
 * Take a deal made here off the board without deleting it: it keeps its
 * notes and details, leaves every number (as an archived row always has), and
 * is listed by `archived` until it is restored. A mirrored deal is archived
 * by its source's own push, never here.
 */
export const archive = memberMutation("sales")({
  args: { id: v.id("deals") },
  handler: async (ctx, args) => {
    const deal = cardOnBoard(theirs(ctx.member, await ctx.db.get(args.id)), WORDS);
    refuseMirrored(deal, WORDS);
    await ctx.db.patch(deal._id, { archivedAt: Date.now() });
    return null;
  },
});

/** Put an archived deal made here back on the board, at the bottom of its stage. */
export const restore = memberMutation("sales")({
  args: { id: v.id("deals") },
  handler: async (ctx, args) => {
    const deal = theirs(ctx.member, await ctx.db.get(args.id));
    if (deal === null) throw new ConvexError("That deal no longer exists.");
    refuseMirrored(deal, WORDS);
    if (deal.archivedAt === undefined) throw new ConvexError("That deal is not archived.");
    const order = await bottomOf(dealOps(ctx), deal.market, deal.stage);
    await ctx.db.patch(deal._id, { archivedAt: undefined, order });
    return null;
  },
});

/**
 * One market's archived deals made here, the most recently archived first.
 * A push's archived rows are not in it: their source took them off, and only
 * their source can put them back.
 */
export const archived = memberQuery("sales")({
  args: { market: marketValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.market);
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", args.market))
      .collect();
    return deals
      .filter((deal) => deal.archivedAt !== undefined && !isMirrored(deal))
      .sort((a, b) => b.archivedAt! - a.archivedAt!)
      .map((deal) => ({ ...present(deal), archivedAt: deal.archivedAt! }));
  },
});

export const remove = memberMutation("sales")({
  args: { id: v.id("deals") },
  handler: async (ctx, args) => {
    const deal = theirs(ctx.member, await ctx.db.get(args.id));
    if (!deal) return null;
    refuseMirrored(deal, WORDS);
    await ctx.db.delete(args.id);
    // Its sales intelligence goes with it (convex/dealIntel.ts), and so does
    // the customer it made, if it was won: archived, the link dropped.
    await removeIntelOf(ctx, args.id);
    await customerOfDeletedDeal(ctx, args.id, Date.now());
    return null;
  },
});

// ── Importing a prospect list ───────────────────────────────────────────────

/**
 * A prospect list onto the US board: run by `pnpm import:prospects` (never by
 * the browser), and kept as a tool for the next list.
 *
 * Every row is cleaned by `cleanProspectRows` (pipelineFields.ts), which the
 * script also runs before it sends anything: the board's own cleaning and
 * caps, a lead or qualified stage, and no email address or phone number in
 * the name, contact, next step or notes. A refusal is a fixed sentence that
 * names the row by its place in the list, counted from 1, and never by what
 * it holds; one refusal writes nothing at all.
 *
 * A row whose name is already a US deal's (whatever its capitals and spaces,
 * archived ones included, so a deal taken off is not brought back), or comes
 * twice in the list, is skipped and counted. The rest become deals made here,
 * as `deals.create` makes them (source "manual", their own id as their key,
 * activity now), at the end of their stage in list order. Returns counts only.
 */
export const importProspects = internalMutation({
  args: {
    market: marketValidator,
    rows: v.array(
      v.object({
        name: v.string(),
        contact: v.optional(v.string()),
        stage: v.string(),
        nextStep: v.optional(v.string()),
        notes: v.optional(v.string()),
        priority: v.optional(v.string()),
        region: v.optional(v.string()),
        physicians: v.optional(v.number()),
        locations: v.optional(v.number()),
        sources: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, { market, rows }) => {
    if (!NATIVE_DEAL_MARKETS.includes(market)) throw new ConvexError(NOT_MADE_HERE);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError(`At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
    }

    // Clean every row before writing any.
    const cleaned = cleanProspectRows(rows);

    const taken = new Set(
      (
        await ctx.db
          .query("deals")
          .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", market))
          .collect()
      ).map((deal) => normalDealName(deal.name)),
    );
    const ops = dealOps(ctx);
    const next: Record<string, number> = {};
    const now = Date.now();
    let added = 0;
    let skipped = 0;
    for (const row of cleaned) {
      const key = normalDealName(row.name);
      if (taken.has(key)) {
        skipped++;
        continue;
      }
      taken.add(key);
      const order = next[row.stage] ?? (await bottomOf(ops, market, row.stage));
      next[row.stage] = order + 1;
      const id = await ctx.db.insert("deals", {
        ...row,
        market,
        source: NATIVE_SOURCE,
        externalId: "",
        lastActivityAt: now,
        order,
      });
      // A native row is its own record of truth, so its key is its own id.
      await ctx.db.patch(id, { externalId: id });
      added++;
    }
    return { added, skipped };
  },
});

/**
 * Link a deal to the goal it serves (`goalId`), or unlink it (null): one of
 * its market's goals or both companies' (`requireGoalLink`). A mirrored deal
 * may be linked too: the link is the OS's own and no push touches it.
 */
export const setGoal = memberMutation("sales")({
  args: { id: v.id("deals"), goalId: v.union(v.id("goals"), v.null()) },
  handler: async (ctx, args) => {
    const deal = theirs(ctx.member, await ctx.db.get(args.id));
    if (deal === null) throw new ConvexError("That deal no longer exists.");
    if (args.goalId !== null) await requireGoalLink(ctx, args.goalId, deal.market);
    await ctx.db.patch(args.id, { goalId: args.goalId ?? undefined });
    return null;
  },
});
