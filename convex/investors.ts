import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { dealNameKey } from "./lib/dealDetails";
import {
  MAX_BULK_INVESTORS,
  SYNC_FIELDS,
  SYNC_WORDS,
  enqueueChange,
  enqueueSync,
  retryFailed,
  syncRowsOf,
  syncSummaries,
  syncSummaryOf,
  type SyncSummary,
} from "./lib/investorSync";
import { MAX_NAME_LENGTH } from "./lib/limits";
import { memberMutation, memberQuery } from "./lib/owner";
import {
  cardAbilities,
  cardOnBoard,
  createCard,
  editCard,
  isMirrored,
  moveCard,
  newestClosedFirst,
  presentCard,
  refuseMirrored,
  writesBack,
  type CardEdit,
  type CardWords,
  type NewCard,
} from "./lib/pipelineCards";
import { cleanOptional } from "./lib/pipelineFields";
import { investorOps } from "./lib/pipelineOps";
import {
  CLOSED_STAGES,
  INVESTOR_STAGES,
  UNMAPPED,
  isStage,
  type InvestorStage,
} from "./lib/pipelineStages";
import { bottomOf } from "./lib/pipelineWriter";

const WORDS: CardWords = { noun: "investor", nameNeeds: "An investor needs a name" };

const present = (investor: Doc<"investors">, sync: SyncSummary | null) => ({
  ...presentCard(investor),
  ...cardAbilities("investors", investor),
  id: investor._id,
  // Who added it through `investor_create`, and where the introduction came
  // from. Null on a card made on the page or mirrored from Visible.
  createdBy: investor.createdBy ?? null,
  referralSource: investor.referralSource ?? null,
  // Visible write-back (convex/lib/investorSync.ts): the change that matters
  // most on its way to Visible (failed, else pending, else sent), or null; and
  // whether a pull in the last seven days found a change sent from here
  // changed again in Visible. Timestamps and codes, never Visible's words.
  sync,
  changedInVisible: investor.changedInVisibleAt !== undefined,
});
type Card = ReturnType<typeof present>;

/** Who made a change, as a sync row records it: the member's user id. */
const byMember = (member: { user: { _id: Id<"users"> } }) => member.user._id as string;

/**
 * The fundraising board: every stage with its cards, plus "unmapped" for
 * mirrored investors whose stage name the OS does not know. Returns
 * timestamps and never judges staleness. Startup's alone: whoever calls this
 * has already been held to the "us" company.
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function investorBoardFor(ctx: QueryCtx) {
  {
    const columns = Object.fromEntries(
      [...INVESTOR_STAGES, UNMAPPED].map((stage) => [stage, [] as Card[]]),
    ) as Record<InvestorStage | typeof UNMAPPED, Card[]>;
    const syncs = await syncSummaries(ctx);
    // The index yields each stage's cards in their stored order.
    const investors = await ctx.db.query("investors").withIndex("by_stage_and_order").collect();
    for (const investor of investors) {
      if (investor.archivedAt !== undefined) continue;
      const stage = isStage("investors", investor.stage)
        ? (investor.stage as InvestorStage)
        : UNMAPPED;
      columns[stage].push(present(investor, syncs.get(investor._id) ?? null));
    }
    for (const stage of CLOSED_STAGES.investors) {
      columns[stage as InvestorStage].sort(newestClosedFirst);
    }
    return columns;
  }
}

export const board = memberQuery("fundraising", "us")({
  args: {},
  handler: (ctx) => investorBoardFor(ctx),
});

/**
 * One investor for its own page: the card, its sync state, and whether it is
 * archived (and so whether `restore` would take it). Null when it is gone.
 */
export const get = memberQuery("fundraising", "us")({
  // A string, not v.id: the page passes whatever its address holds, and an id
  // that is malformed or of another table is "not found" (null), never a throw.
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("investors", args.id);
    const investor = id === null ? null : await ctx.db.get(id);
    if (investor === null) return null;
    return {
      ...present(investor, await syncSummaryOf(ctx, investor._id)),
      archived: investor.archivedAt !== undefined,
      archivedAt: investor.archivedAt ?? null,
      restorable: investor.archivedAt !== undefined && restorable(investor),
    };
  },
});

/**
 * What was sent to Visible for one investor, newest first: when each change
 * was queued, sent and confirmed, its status, attempts and error code, and
 * which fields it carried. Never the values, never a note's text.
 */
export const syncHistory = memberQuery("fundraising", "us")({
  args: { id: v.id("investors") },
  handler: async (ctx, args) =>
    (await syncRowsOf(ctx, args.id)).map((row) => ({
      id: row._id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.errorCode ?? null,
      queuedAt: row.queuedAt,
      sentAt: row.sentAt ?? null,
      confirmedAt: row.confirmedAt ?? null,
      fields: SYNC_FIELDS.filter((field) => row.fields[field] !== undefined),
      note: row.note !== undefined,
    })),
});

/** Send a failed change again with the next daily run. */
export const retrySync = memberMutation("fundraising", "us")({
  args: { id: v.id("investors") },
  handler: async (ctx, args) => {
    if (!(await retryFailed(ctx, args.id, Date.now()))) throw new ConvexError(SYNC_WORDS.nothingFailed);
    return null;
  },
});

/**
 * An investor's name as two firms are the same one: the deal-name key
 * (capitals, spacing, punctuation and a trailing legal form do not count).
 * Fundraising is one company, so the key is the whole board.
 */
export const investorNameKey = (name: string) => dealNameKey(name);

/**
 * The investor this name already is, if any: a card still on the board wins
 * over an archived one, and the most recently active among those. Names are
 * compared by `investorNameKey`, so an index cannot answer it.
 */
export async function investorNamed(ctx: QueryCtx, name: string): Promise<Doc<"investors"> | null> {
  const key = investorNameKey(name);
  if (key === "") return null;
  const matches = (await ctx.db.query("investors").collect()).filter((row) => investorNameKey(row.name) === key);
  const live = matches.filter((row) => row.archivedAt === undefined);
  const pool = live.length > 0 ? live : matches;
  return pool.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || (a._id < b._id ? -1 : 1))[0] ?? null;
}

/** A card the page adds, plus where an introduction came from (`investor_create`). */
export type NewInvestor = NewCard & { referralSource?: string };

/**
 * Add an investor: what `investors.create` runs, and `investor_create` with
 * it. A card at the bottom of its stage (target unless given), the board's
 * own cleaning. `createdBy` names the bot or agent, when one added it; `by`
 * who made the change, for the queue. The new card is queued whole for
 * Visible.
 */
export async function createInvestor(
  ctx: MutationCtx,
  { referralSource, ...card }: NewInvestor,
  options: { now: number; createdBy?: string; by: string },
): Promise<Id<"investors">> {
  const id = await createCard(investorOps(ctx), null, card, INVESTOR_STAGES[0], WORDS, options.now);
  const source =
    referralSource === undefined ? undefined : cleanOptional(referralSource, MAX_NAME_LENGTH, "Where the investor was found");
  if (options.createdBy !== undefined || source !== undefined) {
    await ctx.db.patch(id, {
      ...(options.createdBy === undefined ? null : { createdBy: options.createdBy }),
      ...(source === undefined ? null : { referralSource: source }),
    });
  }
  const made = (await ctx.db.get(id))!;
  const note =
    made.nextStep === undefined && made.notes === undefined
      ? undefined
      : {
          ...(made.nextStep === undefined ? null : { nextStep: made.nextStep }),
          ...(made.notes === undefined ? null : { notes: made.notes }),
        };
  await enqueueSync(ctx, made, { fields: {}, note }, { by: options.by, now: options.now });
  return id;
}

/**
 * Add an investor unless the firm is already here: the same normalized name
 * returns that investor's id and writes nothing. What `investor_create` runs.
 */
export async function addInvestor(
  ctx: MutationCtx,
  card: NewInvestor,
  options: { now: number; createdBy?: string; by: string },
): Promise<{ id: Id<"investors">; created: boolean }> {
  const existing = await investorNamed(ctx, card.name);
  if (existing !== null) return { id: existing._id, created: false };
  return { id: await createInvestor(ctx, card, options), created: true };
}

/** Add an investor by hand. It is queued for Visible as a new investor. */
export const create = memberMutation("fundraising", "us")({
  args: {
    name: v.string(),
    stage: v.optional(v.string()),
    contact: v.optional(v.string()),
    amount: v.optional(v.number()),
    nextStep: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: (ctx, card) => createInvestor(ctx, card, { now: Date.now(), by: byMember(ctx.member) }),
});

/** Put an investor at a position in a stage: one of Visible's or one made here. */
async function moveInvestor(ctx: MutationCtx, id: Id<"investors">, stage: string, index: number, by: string) {
  const now = Date.now();
  const before = await ctx.db.get(id);
  await moveCard(investorOps(ctx), before, stage, index, WORDS, now);
  await enqueueChange(ctx, before!, (await ctx.db.get(id))!, { by, now });
}

/** Put an investor at a position in a stage. A change of stage is queued for Visible. */
export const move = memberMutation("fundraising", "us")({
  args: { id: v.id("investors"), stage: v.string(), index: v.number() },
  handler: async (ctx, args) => {
    await moveInvestor(ctx, args.id, args.stage, args.index, byMember(ctx.member));
    return null;
  },
});

/** An edit of an investor: for contact, amount, next step and notes, null clears and leaving out keeps. */
export type InvestorEdit = { id: Id<"investors"> } & CardEdit;

/**
 * Edit an investor. A change of stage moves the card in the same
 * transaction. A Visible investor takes its name, amount, stage, next step
 * and notes (its contact is Visible's), and what changed is queued for
 * Visible; so is any change to an investor made here. What the page's editor
 * runs and what the owner's agent runs (`investor_update`,
 * convex/lib/mcpTools.ts): one function, so the two cannot drift. Startup's
 * alone: whoever calls this has already been held to the "us" company.
 * `by` is who made the change (a member's user id, a bot's or agent's label).
 */
export async function updateInvestor(ctx: MutationCtx, { id, ...edit }: InvestorEdit, by: string): Promise<null> {
  const now = Date.now();
  const before = await ctx.db.get(id);
  await editCard(investorOps(ctx), before, edit, WORDS, now);
  await enqueueChange(ctx, before!, (await ctx.db.get(id))!, { by, now });
  return null;
}

/** Edit an investor. A change of stage moves the card in the same transaction. */
export const update = memberMutation("fundraising", "us")({
  args: {
    id: v.id("investors"),
    name: v.optional(v.string()),
    stage: v.optional(v.string()),
    // For these four, null clears the field and leaving it out keeps it.
    contact: v.optional(v.union(v.string(), v.null())),
    amount: v.optional(v.union(v.number(), v.null())),
    nextStep: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: (ctx, args) => updateInvestor(ctx, args, byMember(ctx.member)),
});

export const remove = memberMutation("fundraising", "us")({
  args: { id: v.id("investors") },
  handler: async (ctx, args) => {
    const investor = await ctx.db.get(args.id);
    if (!investor) return null;
    refuseMirrored(investor, WORDS);
    await ctx.db.delete(args.id);
    return null;
  },
});

// ── Archive ──────────────────────────────────────────────────────────────

/**
 * Whether the owner can put an archived investor back: one made here, or one
 * of Visible's the owner archived. One Visible's own pull archived comes back
 * only when Visible lists it again.
 */
const restorable = (investor: Doc<"investors">) => !isMirrored(investor) || investor.archivedBy === "owner";

/** Archive one investor here: the bulk bar and `archive` both run this. */
async function archiveInvestor(ctx: MutationCtx, id: Id<"investors">, now: number) {
  const investor = cardOnBoard(await ctx.db.get(id), WORDS);
  if (isMirrored(investor) && !writesBack("investors", investor)) refuseMirrored(investor, WORDS);
  await ctx.db.patch(investor._id, { archivedAt: now, archivedBy: "owner" });
}

/**
 * Take an investor off the board without deleting it: it keeps its notes,
 * leaves every number and is listed by `archived` until it is restored. Local
 * only: nothing is sent to Visible, and a Visible pull leaves it archived.
 */
export const archive = memberMutation("fundraising", "us")({
  args: { id: v.id("investors") },
  handler: async (ctx, args) => {
    await archiveInvestor(ctx, args.id, Date.now());
    return null;
  },
});

/** Put an investor the owner archived back on the board, at the bottom of its stage. */
export const restore = memberMutation("fundraising", "us")({
  args: { id: v.id("investors") },
  handler: async (ctx, args) => {
    const investor = await ctx.db.get(args.id);
    if (investor === null) throw new ConvexError(SYNC_WORDS.gone);
    if (investor.archivedAt === undefined) throw new ConvexError(SYNC_WORDS.notArchived);
    if (!restorable(investor)) throw new ConvexError(SYNC_WORDS.archivedBySource);
    const order = await bottomOf(investorOps(ctx), null, investor.stage);
    await ctx.db.patch(investor._id, { archivedAt: undefined, archivedBy: undefined, order });
    return null;
  },
});

/**
 * The investors the owner archived, the most recently archived first. One
 * Visible's own pull archived is not in it: only Visible can put it back.
 */
export const archived = memberQuery("fundraising", "us")({
  args: {},
  handler: async (ctx) => {
    const investors = await ctx.db.query("investors").withIndex("by_stage_and_order").collect();
    return investors
      .filter((investor) => investor.archivedAt !== undefined && restorable(investor))
      .sort((a, b) => b.archivedAt! - a.archivedAt!)
      .map((investor) => ({ ...present(investor, null), archivedAt: investor.archivedAt! }));
  },
});

// ── Bulk ─────────────────────────────────────────────────────────────────

/**
 * One action on up to 100 investors: move them to the bottom of a stage,
 * archive them, or set their next step (blank clears it). Each is done on its
 * own: one refused (a Kazakhstan-style lock, an investor gone) does not stop
 * the rest, and its result carries the refusal's words. Each change is queued
 * for Visible as the single edit would be.
 */
export const bulk = memberMutation("fundraising", "us")({
  args: {
    ids: v.array(v.id("investors")),
    action: v.union(
      v.object({ kind: v.literal("move"), stage: v.string() }),
      v.object({ kind: v.literal("archive") }),
      v.object({ kind: v.literal("nextStep"), text: v.string() }),
    ),
  },
  handler: async (ctx, { ids, action }) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new ConvexError(SYNC_WORDS.noneChosen);
    if (unique.length > MAX_BULK_INVESTORS) throw new ConvexError(SYNC_WORDS.tooMany);
    const by = byMember(ctx.member);
    const now = Date.now();
    const results: ({ id: Id<"investors">; ok: true } | { id: Id<"investors">; ok: false; error: string })[] = [];
    for (const id of unique) {
      try {
        if (action.kind === "move") {
          const investor = await ctx.db.get(id);
          // Already there: nothing to move, and nothing to send.
          if (investor === null || investor.archivedAt !== undefined || investor.stage !== action.stage) {
            await moveInvestor(ctx, id, action.stage, Number.MAX_SAFE_INTEGER, by);
          }
        } else if (action.kind === "archive") {
          await archiveInvestor(ctx, id, now);
        } else {
          await updateInvestor(ctx, { id, nextStep: action.text.trim() === "" ? null : action.text }, by);
        }
        results.push({ id, ok: true });
      } catch (error) {
        // Every refusal is checked before anything of that investor is written.
        if (!(error instanceof ConvexError)) throw error;
        results.push({ id, ok: false, error: typeof error.data === "string" ? error.data : SYNC_WORDS.failed });
      }
    }
    return { results };
  },
});
