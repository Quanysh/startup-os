import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { normalDealName } from "./lib/dealDetails";
import {
  INTEL_FIELDS,
  agentIntelOf,
  cleanIntelEdit,
  cleanIntelRows,
  intelSummaryOf,
  presentIntel,
  type IntelEdit,
  type IntelPatch,
} from "./lib/dealIntel";
import { MAX_IMPORT_ROWS } from "./lib/limits";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { cardOnBoard, isMirrored } from "./lib/pipelineCards";
import { NATIVE_DEAL_MARKETS } from "./lib/pipelineRules";

// A US deal's sales intelligence: what research found about the practice,
// kept beside the deal (one row a deal, `dealIntel`). Read on the deal's page
// (`get`) and in the US table's columns (`list`), changed there by whoever has
// Sales on Startup (`update`), and loaded from research by `pnpm import:intel`
// (`importIntel`). The agents' `deals` tool reads it through `intelOfUsDeals`,
// the function `list` calls (convex/lib/mcpTools.ts).
//
// Every function is Sales on Startup ("us"): someone on Globex alone is
// refused all of it, as a missing permission is. Only a native US deal has
// intelligence, never a Kazakhstan or mirrored deal and never an investor.
// Everything written goes through `cleanIntelEdit` (convex/lib/dealIntel.ts),
// whose refusals are fixed sentences that never quote a value.

const WORDS = { noun: "deal", nameNeeds: "A deal needs a company name" };
export const NO_INTEL_HERE = "Only a US deal made here has sales intelligence.";

/** Whether a deal may have intelligence: one made here, in a market where deals are made here. */
const takesIntel = (deal: Doc<"deals">) =>
  !isMirrored(deal) && NATIVE_DEAL_MARKETS.includes(deal.market);

// What an edit and an import row may give. Loose on purpose (a kind or a
// billing model is any text here): the cleaner refuses in fixed words, where
// a validator's own message would quote the value.
const text = v.optional(v.union(v.string(), v.null()));
const texts = v.optional(v.union(v.array(v.string()), v.null()));
const editFields = {
  summary: text,
  ownership: text,
  ehr: text,
  pm: text,
  billingModel: text,
  rcmVendor: text,
  specialties: texts,
  ancillaries: texts,
  workersComp: text,
  competitors: v.optional(v.union(v.array(v.object({ name: v.string(), note: text })), v.null())),
  signals: v.optional(
    v.union(
      v.array(v.object({ date: text, kind: v.string(), text: v.string(), source: v.string() })),
      v.null(),
    ),
  ),
  people: v.optional(
    v.union(v.array(v.object({ name: v.string(), role: v.string(), note: text })), v.null()),
  ),
  painPoints: texts,
  talkingPoints: texts,
  risks: texts,
  angle: text,
  nextBestAction: text,
  fit: v.optional(v.union(v.object({ score: v.number(), reasons: v.array(v.string()) }), v.null())),
  sources: v.optional(v.union(v.array(v.object({ title: v.string(), url: v.string() })), v.null())),
  researchedAt: text,
};

const intelRowOf = (ctx: QueryCtx, dealId: Id<"deals">) =>
  ctx.db
    .query("dealIntel")
    .withIndex("by_dealId", (q) => q.eq("dealId", dealId))
    .unique();

/** The fields of a patch that hold something: what a new or replaced row is made of. */
const filled = (patch: IntelPatch) =>
  Object.fromEntries(
    INTEL_FIELDS.filter((field) => patch[field] !== undefined).map((field) => [field, patch[field]]),
  ) as IntelPatch;

/**
 * Write a deal's intelligence. "merge" changes the fields the patch names
 * (undefined clears one); "replace" makes the row exactly the patch. A row
 * left with nothing in it is deleted, so "no intelligence" is one state.
 * Returns whether the deal had a row before.
 */
async function writeIntel(
  ctx: MutationCtx,
  dealId: Id<"deals">,
  patch: IntelPatch,
  now: number,
  mode: "merge" | "replace",
): Promise<boolean> {
  const existing = await intelRowOf(ctx, dealId);
  const before: IntelPatch = existing === null || mode === "replace" ? {} : existing;
  const after = filled({ ...pick(before), ...patch });
  if (Object.keys(after).length === 0) {
    if (existing !== null) await ctx.db.delete(existing._id);
  } else if (existing === null) {
    await ctx.db.insert("dealIntel", { dealId, ...after, updatedAt: now });
  } else {
    await ctx.db.replace(existing._id, { dealId, ...after, updatedAt: now });
  }
  return existing !== null;
}

const pick = (row: IntelPatch): IntelPatch =>
  Object.fromEntries(INTEL_FIELDS.map((field) => [field, row[field]])) as IntelPatch;

/**
 * Attach intelligence to a deal just made by approving a `deal_create`
 * proposal (convex/lib/proposals.ts): the same cleaning and write `update`
 * runs, for a US deal made here only. Returns nothing; a refusal is thrown
 * in `cleanIntelEdit`'s fixed words.
 */
export async function attachIntel(ctx: MutationCtx, dealId: Id<"deals">, edit: IntelEdit, now: number) {
  const deal = await ctx.db.get(dealId);
  if (deal === null || !takesIntel(deal)) throw new ConvexError(NO_INTEL_HERE);
  const cleaned = cleanIntelEdit(edit);
  if (!cleaned.ok) throw new ConvexError(cleaned.problem);
  if (Object.keys(cleaned.patch).length === 0) return;
  await writeIntel(ctx, dealId, cleaned.patch, now, "merge");
}

/** Deleting a deal deletes its intelligence (`deals.remove`). */
export async function removeIntelOf(ctx: MutationCtx, dealId: Id<"deals">) {
  const row = await intelRowOf(ctx, dealId);
  if (row !== null) await ctx.db.delete(row._id);
}

/**
 * The intelligence of the US deals on the board: what `list` sends the
 * table, and what the owner's agent reads (convex/lib/mcpTools.ts), from one
 * function so the two cannot drift. A row whose deal is gone, archived,
 * mirrored or Kazakhstan's is never sent.
 */
export async function intelOfUsDeals(ctx: QueryCtx, member: Member) {
  requireCompany(member, "us");
  const found: Doc<"dealIntel">[] = [];
  for (const row of await ctx.db.query("dealIntel").collect()) {
    const deal = await ctx.db.get(row.dealId);
    if (deal === null || deal.archivedAt !== undefined || !takesIntel(deal)) continue;
    found.push(row);
  }
  return found;
}

/** What the agents' `deals` tool attaches to each US deal that has intelligence, by its id. */
export async function agentIntelFor(ctx: QueryCtx, member: Member) {
  return new Map((await intelOfUsDeals(ctx, member)).map((row) => [row.dealId, agentIntelOf(row)]));
}

/**
 * One deal's intelligence, or null: for a deal that has none, and for an id
 * that is no US deal made here (a Kazakhstan deal, a mirrored one, one gone,
 * or not an id at all), alike, so the answer tells nothing of other rows.
 */
export const get = memberQuery("sales", "us")({
  args: { dealId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("deals", args.dealId);
    if (id === null) return null;
    const deal = await ctx.db.get(id);
    if (deal === null || !takesIntel(deal) || !ctx.member.companies.includes(deal.market)) {
      return null;
    }
    const row = await intelRowOf(ctx, id);
    return row === null ? null : presentIntel(row);
  },
});

/** What the US table's columns need, for each deal on the board that has intelligence. */
export const list = memberQuery("sales", "us")({
  args: {},
  handler: async (ctx) =>
    (await intelOfUsDeals(ctx, ctx.member)).map((row) => ({
      dealId: row.dealId,
      ...intelSummaryOf(row),
    })),
});

/**
 * Change a deal's intelligence: the fields given, cleaned (`cleanIntelEdit`);
 * leaving one out keeps it and null clears it. The owner and anyone with
 * Sales on Startup may change any field. A deal off the board, a mirrored or a
 * Kazakhstan one is refused. Not activity: the deal's last activity stays.
 */
export const update = memberMutation("sales", "us")({
  args: { dealId: v.id("deals"), ...editFields },
  handler: async (ctx, { dealId, ...edit }) => {
    const found = await ctx.db.get(dealId);
    if (found !== null) requireCompany(ctx.member, found.market);
    const deal = cardOnBoard(found, WORDS);
    if (!takesIntel(deal)) throw new ConvexError(NO_INTEL_HERE);
    const cleaned = cleanIntelEdit(edit);
    if (!cleaned.ok) throw new ConvexError(cleaned.problem);
    if (Object.keys(cleaned.patch).length === 0) return null;
    await writeIntel(ctx, dealId, cleaned.patch, Date.now(), "merge");
    return null;
  },
});

/**
 * Research loaded onto the US deals: run by `pnpm import:intel` (never by the
 * browser). Every row is cleaned first (`cleanIntelRows`, which the script
 * also runs before it sends anything); one refusal, "Row <n>:" and a fixed
 * sentence, writes nothing.
 *
 * A row is matched to the US deal made here of the same name, whatever its
 * capitals and spaces (one on the board before an archived one, the oldest
 * first), and replaces that deal's intelligence whole. A Kazakhstan or
 * mirrored deal is never matched. Returns counts, and the place in the list
 * (from 1) of each row that matched nothing: never a name.
 *
 * `matched` + `unmatched` is the number of rows; `updated` is how many of the
 * matched deals already had intelligence.
 */
export const importIntel = internalMutation({
  args: { rows: v.array(v.object({ dealName: v.string(), ...editFields })) },
  handler: async (ctx, { rows }) => {
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError(`At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
    }
    const cleaned = cleanIntelRows(rows);
    if (!cleaned.ok) throw new ConvexError(cleaned.problem);

    const deals = await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", "us"))
      .collect();
    const rank = (deal: Doc<"deals">) => (deal.archivedAt === undefined ? 0 : 1);
    const byName = new Map<string, Id<"deals">>();
    for (const deal of deals
      .filter(takesIntel)
      .sort((a, b) => rank(a) - rank(b) || a._creationTime - b._creationTime)) {
      const key = normalDealName(deal.name);
      if (!byName.has(key)) byName.set(key, deal._id);
    }

    const now = Date.now();
    let matched = 0;
    let updated = 0;
    const unmatchedRows: number[] = [];
    for (const [index, row] of cleaned.rows.entries()) {
      const dealId = byName.get(normalDealName(row.dealName));
      if (dealId === undefined) {
        unmatchedRows.push(index + 1);
        continue;
      }
      matched++;
      if (await writeIntel(ctx, dealId, row.patch, now, "replace")) updated++;
    }
    return { matched, unmatched: unmatchedRows.length, updated, unmatchedRows };
  },
});
