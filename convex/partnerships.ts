import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { placeAt } from "./lib/ordering";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import {
  PARTNER_GONE,
  PARTNER_ON_BOARD,
  checkStage,
  cleanPartnerEdit,
  normalPartnerName,
  settleValue,
  type PartnerEdit,
} from "./lib/partnerFields";
import {
  MAX_PARTNERS_PER_COMPANY,
  PARTNER_STAGES,
  type PartnerCard,
  type PartnerStage,
} from "./lib/partnerStages";
import {
  marketValidator,
  partnerTypeValidator,
  partnerValueKindValidator,
} from "./schema";

const linkValidator = v.object({ label: v.string(), url: v.string() });

/** A partner as the board sends it, and as the owner's agent reads it. */
const present = (partner: Doc<"partners">): PartnerCard => ({
  id: partner._id,
  company: partner.company,
  name: partner.name,
  type: partner.type,
  stage: partner.stage,
  owner: partner.owner ?? null,
  contact: partner.contact ?? null,
  contactRole: partner.contactRole ?? null,
  value: partner.value ?? null,
  valueKind: partner.valueKind ?? null,
  notes: partner.notes ?? null,
  nextStep: partner.nextStep ?? null,
  nextStepOn: partner.nextStepOn ?? null,
  lastActivityAt: partner.lastActivityAt ?? null,
  links: partner.links ?? [],
  editedBy: partner.editedBy ?? null,
});

/** The cards of one company, in stage and stored order. */
async function cardsOf(ctx: QueryCtx, company: CompanyId): Promise<Doc<"partners">[]> {
  return await ctx.db
    .query("partners")
    .withIndex("by_company_and_stage_and_order", (q) => q.eq("company", company))
    .collect();
}

/**
 * One company's partnerships board: every stage with its cards in their
 * stored order. Timestamps only: whether a partner has gone quiet needs "now",
 * which a query must not read.
 *
 * What the query returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function, so the two cannot drift.
 */
export async function partnerBoardFor(ctx: QueryCtx, member: Member, company: CompanyId) {
  requireCompany(member, company);
  const columns = Object.fromEntries(PARTNER_STAGES.map((stage) => [stage, [] as PartnerCard[]])) as Record<
    PartnerStage,
    PartnerCard[]
  >;
  for (const partner of await ctx.db
    .query("partners")
    .withIndex("by_company_and_stage_and_order", (q) => q.eq("company", company))
    .collect()) {
    columns[partner.stage].push(present(partner));
  }
  return columns;
}

/** Every partner of the companies the caller is on, flat: for the Today line and the agent's overview. */
export async function partnersFor(ctx: QueryCtx, member: Member): Promise<PartnerCard[]> {
  const cards: PartnerCard[] = [];
  for (const company of member.companies) {
    cards.push(...(await cardsOf(ctx, company)).map(present));
  }
  return cards;
}

/** The partner, if it is still there and of a company the caller is on. */
async function theirs(ctx: QueryCtx, member: Member, id: Id<"partners">): Promise<Doc<"partners">> {
  const partner = await ctx.db.get(id);
  if (partner === null) throw new ConvexError(PARTNER_GONE);
  requireCompany(member, partner.company);
  return partner;
}

/** The client a change came through, as stored: the owner's Claude by its name, nothing for the app. */
const editor = (by: string | null | undefined) => (by ? by.slice(0, 60) : undefined);

/** Write `order` 0, 1, 2, … down a sequence, touching only the rows that change. */
async function renumber(ctx: MutationCtx, rows: readonly Doc<"partners">[]) {
  for (const [index, row] of rows.entries()) {
    if (row.order !== index) await ctx.db.patch(row._id, { order: index });
  }
}

const column = async (ctx: QueryCtx, company: CompanyId, stage: PartnerStage) =>
  await ctx.db
    .query("partners")
    .withIndex("by_company_and_stage_and_order", (q) => q.eq("company", company).eq("stage", stage))
    .collect();

/**
 * Put a partner at a position in a stage, closing the gap it leaves behind.
 * A change of stage counts as activity; a reorder does not.
 */
async function place(
  ctx: MutationCtx,
  partner: Doc<"partners">,
  stage: PartnerStage,
  index: number,
  now: number,
  by: string | null | undefined,
) {
  if (partner.stage !== stage) {
    await ctx.db.patch(partner._id, { stage, lastActivityAt: now, editedBy: editor(by) });
    await renumber(ctx, await column(ctx, partner.company, partner.stage));
  } else if (by !== undefined || partner.editedBy !== undefined) {
    await ctx.db.patch(partner._id, { editedBy: editor(by) });
  }
  const rows = await column(ctx, partner.company, stage);
  const byId = new Map(rows.map((row) => [row._id, row]));
  const sequence = placeAt(
    rows.map((row) => row._id),
    partner._id,
    index,
  );
  await renumber(
    ctx,
    sequence.map((id) => byId.get(id)!),
  );
}

async function refuseDuplicate(
  ctx: QueryCtx,
  company: CompanyId,
  name: string,
  except: Id<"partners"> | null,
) {
  const taken = (await cardsOf(ctx, company)).some(
    (other) => other._id !== except && normalPartnerName(other.name) === normalPartnerName(name),
  );
  if (taken) throw new ConvexError(PARTNER_ON_BOARD);
}

export type NewPartner = PartnerEdit & { company: CompanyId; name: string; type: NonNullable<PartnerEdit["type"]> };

/** Add a partner at the bottom of its stage (identified unless said). Returns its id. */
export async function createPartner(
  ctx: MutationCtx,
  member: Member,
  input: NewPartner,
  now: number,
  by: string | null = null,
): Promise<Id<"partners">> {
  requireCompany(member, input.company);
  const { company, ...edit } = input;
  const patch = cleanPartnerEdit(edit);
  const value = settleValue({}, edit);
  const stage = patch.stage ?? "identified";
  const existing = await cardsOf(ctx, company);
  if (existing.length >= MAX_PARTNERS_PER_COMPANY) {
    throw new ConvexError(`A company has ${MAX_PARTNERS_PER_COMPANY} partners at most.`);
  }
  await refuseDuplicate(ctx, company, patch.name!, null);
  const { value: _v, valueKind: _k, ...rest } = patch;
  return await ctx.db.insert("partners", {
    ...rest,
    company,
    name: patch.name!,
    type: patch.type!,
    stage,
    order: (await column(ctx, company, stage)).length,
    ...(value === null ? null : value),
    lastActivityAt: now,
    editedBy: editor(by),
  });
}

/**
 * Edit a partner. A change of stage moves the card to the top of the new
 * stage in the same transaction. A new stage, next step, date or note counts
 * as activity; the owner, contact, value, type and links do not.
 */
export async function updatePartner(
  ctx: MutationCtx,
  member: Member,
  { id, ...edit }: { id: Id<"partners"> } & PartnerEdit,
  now: number,
  by: string | null = null,
): Promise<null> {
  const partner = await theirs(ctx, member, id);
  const { stage, ...patch } = cleanPartnerEdit(edit);
  const value = settleValue(partner, edit);
  if (patch.name !== undefined) await refuseDuplicate(ctx, partner.company, patch.name, id);
  const { value: _v, valueKind: _k, ...rest } = patch;
  const touched =
    (edit.nextStep !== undefined && patch.nextStep !== partner.nextStep) ||
    (edit.nextStepOn !== undefined && patch.nextStepOn !== partner.nextStepOn) ||
    (edit.notes !== undefined && patch.notes !== partner.notes);
  await ctx.db.patch(id, {
    ...rest,
    ...(value === null ? null : value),
    ...(touched ? { lastActivityAt: now } : null),
    editedBy: editor(by),
  });
  if (stage !== undefined && stage !== partner.stage) {
    await place(ctx, { ...partner, editedBy: editor(by) }, stage, 0, now, by);
  }
  return null;
}

/** Put a partner at a position in a stage (the bottom when no index is given). */
export async function movePartner(
  ctx: MutationCtx,
  member: Member,
  args: { id: Id<"partners">; stage: string; index?: number },
  now: number,
  by: string | null = null,
): Promise<null> {
  const partner = await theirs(ctx, member, args.id);
  const stage = checkStage(args.stage);
  await place(ctx, partner, stage, args.index ?? Number.MAX_SAFE_INTEGER, now, by);
  return null;
}

/**
 * Create a partner, or change the one of that company with the same name (any
 * capitals), or the one `id` names. What the owner's agent calls.
 */
export async function upsertPartner(
  ctx: MutationCtx,
  member: Member,
  input: PartnerEdit & { id?: Id<"partners">; company?: CompanyId },
  now: number,
  by: string | null,
): Promise<{ id: Id<"partners">; created: boolean }> {
  const { id, company, ...edit } = input;
  if (id !== undefined) {
    await updatePartner(ctx, member, { id, ...edit }, now, by);
    return { id, created: false };
  }
  if (company === undefined || edit.name === undefined) {
    throw new ConvexError("A new partner needs a company and a name.");
  }
  requireCompany(member, company);
  const same = (await cardsOf(ctx, company)).find(
    (other) => normalPartnerName(other.name) === normalPartnerName(edit.name!),
  );
  if (same !== undefined) {
    await updatePartner(ctx, member, { id: same._id, ...edit }, now, by);
    return { id: same._id, created: false };
  }
  if (edit.type === undefined) throw new ConvexError("A new partner needs a type.");
  const created = await createPartner(
    ctx,
    member,
    { ...edit, company, name: edit.name, type: edit.type },
    now,
    by,
  );
  return { id: created, created: true };
}

export const board = memberQuery("partnerships")({
  args: { company: marketValidator },
  handler: (ctx, args) => partnerBoardFor(ctx, ctx.member, args.company),
});

const nullable = <T extends Parameters<typeof v.union>[0]>(validator: T) =>
  v.optional(v.union(validator, v.null()));

export const create = memberMutation("partnerships")({
  args: {
    company: marketValidator,
    name: v.string(),
    type: partnerTypeValidator,
    stage: v.optional(v.string()),
    owner: v.optional(v.string()),
    contact: v.optional(v.string()),
    contactRole: v.optional(v.string()),
    value: v.optional(v.number()),
    valueKind: v.optional(partnerValueKindValidator),
    notes: v.optional(v.string()),
    nextStep: v.optional(v.string()),
    nextStepOn: v.optional(v.string()),
    links: v.optional(v.array(linkValidator)),
  },
  handler: async (ctx, args) => await createPartner(ctx, ctx.member, args as NewPartner, Date.now()),
});

/** Put a partner at a position in a stage. */
export const move = memberMutation("partnerships")({
  args: { id: v.id("partners"), stage: v.string(), index: v.number() },
  handler: (ctx, args) => movePartner(ctx, ctx.member, args, Date.now()),
});

export const update = memberMutation("partnerships")({
  args: {
    id: v.id("partners"),
    name: v.optional(v.string()),
    type: v.optional(partnerTypeValidator),
    stage: v.optional(v.string()),
    // For the rest, null clears the field and leaving it out keeps it.
    owner: nullable(v.string()),
    contact: nullable(v.string()),
    contactRole: nullable(v.string()),
    value: nullable(v.number()),
    valueKind: nullable(partnerValueKindValidator),
    notes: nullable(v.string()),
    nextStep: nullable(v.string()),
    nextStepOn: nullable(v.string()),
    links: nullable(v.array(linkValidator)),
  },
  handler: (ctx, args) => updatePartner(ctx, ctx.member, args as never, Date.now()),
});

export const remove = memberMutation("partnerships")({
  args: { id: v.id("partners") },
  handler: async (ctx, args) => {
    const partner = await ctx.db.get(args.id);
    if (partner === null) return null;
    requireCompany(ctx.member, partner.company);
    await ctx.db.delete(args.id);
    await renumber(ctx, await column(ctx, partner.company, partner.stage));
    return null;
  },
});
