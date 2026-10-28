import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import {
  NO_ACCOUNT_NUMBERS,
  isMonth,
  looksLikeAccountNumber,
  summarise,
  type CostLine,
} from "./lib/costs";
import { MARKET_CURRENCY, requireOfferedCurrency, startingCurrencyOf } from "./lib/customerShape";
import {
  MAX_COST_AMOUNT,
  MAX_COST_LINES,
  MAX_COST_NAME_LENGTH,
  MAX_COST_NOTE_LENGTH,
  MAX_COST_PAID_BY_LENGTH,
} from "./lib/limits";
import { cleanRemote } from "./lib/mirrorRules";
import { NOT_ALLOWED, memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { may } from "./lib/roles";
import {
  companyValidator,
  costBucketValidator,
  costCadenceValidator,
  costCategoryValidator,
  payrollCurrencyValidator,
} from "./schema";

// Costs: what each company pays for besides pay (cloud, subscriptions, rent
// and the rest), so the OS can show the planned monthly burn. Every function
// here is gated by the `costs` area, which is the owner's alone: no teammate
// holds it, whatever their row says (`effectiveAreas`). The two helpers other
// files call (`costLinesFor`, `costSummaryFor`) ask for it themselves too.
// convex/payrollReaders.test.ts lists every function here: a new one is
// reviewed by the owner.
//
// Every function is also one company's. One that takes a `company` refuses a
// caller who is not on it; one that takes an id reads the row and refuses a
// caller who is not on the row's company before anything else is read or
// changed. Both in the gate's own words (`requireCompany`).
//
// Nothing here writes a name, a note or an amount anywhere but the `costs`
// table, logs one, or puts one in a thrown message: every refusal is in fixed
// words. No bank detail and no card number is kept: text that looks like one
// is refused. Payroll is not read here, for any reason: what pay adds to the
// burn is worked out in the browser, from payroll's own functions, for a
// viewer who holds that page too.

const costsQuery = memberQuery("costs");
const costsMutation = memberMutation("costs");

const GONE = "That line no longer exists.";
const FULL = `That is every line a company can have (${MAX_COST_LINES} at most). Archive one first.`;
const NOT_A_MONTH = "That is not a month.";

// ── Cleaning what was typed ─────────────────────────────────────────────────

/**
 * One line of typed text: invisible and controlling characters removed
 * (`cleanRemote`), refused, not cut, when too long, and refused when it looks
 * like a card or an account number. Blank comes back as "".
 */
function cleanLine(text: string, max: number, what: string): string {
  const tooLong = `That ${what} is too long (${max} characters at most).`;
  // Nobody types this much; do not run the cleaner over a runaway paste.
  if (text.length > max * 8) throw new ConvexError(tooLong);
  const flat = cleanRemote(text, Number.POSITIVE_INFINITY);
  if (flat.length > max) throw new ConvexError(tooLong);
  if (looksLikeAccountNumber(flat)) throw new ConvexError(NO_ACCOUNT_NUMBERS);
  return flat;
}

function cleanName(name: string): string {
  const clean = cleanLine(name, MAX_COST_NAME_LENGTH, "name");
  if (clean === "") throw new ConvexError("A cost needs a name.");
  return clean;
}

const cleanPaidBy = (text: string) =>
  cleanLine(text, MAX_COST_PAID_BY_LENGTH, "“paid by”") || undefined;
const cleanNote = (text: string) => cleanLine(text, MAX_COST_NOTE_LENGTH, "note") || undefined;

/** A whole number of minor units, above zero, within the limit. */
function cleanAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConvexError("The amount must be a whole amount above zero.");
  }
  if (value > MAX_COST_AMOUNT) throw new ConvexError("The amount is too large.");
  return value;
}

function checkMonth(value: string, what: "start" | "end"): string {
  if (!isMonth(value)) throw new ConvexError(`The ${what} is not a month.`);
  return value;
}

/** A line's months as they are stored: a one-off keeps no end; an end is never before the start. */
function cleanMonths(cadence: Doc<"costs">["cadence"], startsOn: string, endsOn: string | undefined) {
  checkMonth(startsOn, "start");
  if (endsOn !== undefined) checkMonth(endsOn, "end");
  if (cadence === "once") return { startsOn, endsOn: undefined };
  if (endsOn !== undefined && endsOn < startsOn) throw new ConvexError("The end is before the start.");
  return { startsOn, endsOn };
}

/** `undefined` keeps what is stored, `null` clears it, anything else replaces it. */
function replaced<Value, Stored>(
  given: Value | null | undefined,
  stored: Stored | undefined,
  clean: (value: Value) => Stored | undefined,
): Stored | undefined {
  return given === undefined ? stored : given === null ? undefined : clean(given);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Refuse a caller without Costs, in the words of a missing permission. The
 * gate does it for this file's own functions; the helpers below are also
 * called from elsewhere (the budget, the owner's agent), and ask again.
 */
function requireCosts(member: Member) {
  if (!may(member, "costs")) throw new ConvexError(NOT_ALLOWED);
}

const rowsOf = (ctx: QueryCtx, company: CompanyId) =>
  ctx.db
    .query("costs")
    .withIndex("by_company", (q) => q.eq("company", company))
    .collect();

function present(row: Doc<"costs">) {
  return {
    id: row._id,
    name: row.name,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    cadence: row.cadence,
    startsOn: row.startsOn,
    endsOn: row.endsOn ?? null,
    variable: row.variable,
    /** What the owner chose it counts as; null is its category's default (`bucketOf`). */
    bucket: row.bucket ?? null,
    paidBy: row.paidBy ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  } satisfies CostLine & Record<string, unknown>;
}

/**
 * A company's cost lines, ended and archived included, by name. What
 * `costs.list` returns and what the owner's agent reads (which then drops the
 * note and "paid by"): one function, so the two cannot drift.
 */
export async function costLinesFor(ctx: QueryCtx, member: Member, company: CompanyId) {
  requireCosts(member);
  requireCompany(member, company);
  return (await rowsOf(ctx, company))
    .map(present)
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

/** The latest stored USD/KZT rate, or null where none is on record. Never a guess. */
async function latestFx(ctx: QueryCtx) {
  const row = await ctx.db
    .query("metricSnapshots")
    .withIndex("by_key_and_scope_and_period_and_periodStart", (q) =>
      q.eq("key", "fx_usd_kzt").eq("scope", "company").eq("period", "month"),
    )
    .order("desc")
    .first();
  return row === null ? null : { rate: row.value, periodStart: row.periodStart };
}

/**
 * What a company's lines come to in a month and the eleven after it
 * (`summarise`), with the exchange rate the total across currencies was made
 * with. The month is the caller's to say: a query never reads the clock.
 */
export async function costSummaryFor(
  ctx: QueryCtx,
  member: Member,
  company: CompanyId,
  month: string,
) {
  requireCosts(member);
  requireCompany(member, company);
  if (!isMonth(month)) throw new ConvexError(NOT_A_MONTH);
  const fx = await latestFx(ctx);
  const summary = summarise({
    lines: (await rowsOf(ctx, company)).map(present),
    month,
    companyCurrency: MARKET_CURRENCY[company],
    fxUsdKzt: fx?.rate ?? null,
  });
  return { company, ...summary, fx };
}

export const list = costsQuery({
  args: { company: companyValidator },
  handler: (ctx, args) => costLinesFor(ctx, ctx.member, args.company),
});

export const summary = costsQuery({
  args: { company: companyValidator, month: v.string() },
  handler: (ctx, args) => costSummaryFor(ctx, ctx.member, args.company, args.month),
});

// ── Writing ─────────────────────────────────────────────────────────────────

async function requireRoom(ctx: QueryCtx, company: CompanyId) {
  const active = (await rowsOf(ctx, company)).filter((row) => row.archivedAt === undefined);
  if (active.length >= MAX_COST_LINES) throw new ConvexError(FULL);
}

export const add = costsMutation({
  args: {
    company: companyValidator,
    name: v.string(),
    category: costCategoryValidator,
    /** Minor units (cents, tiyn), per cadence. */
    amount: v.number(),
    /** The company's own when left out. */
    currency: v.optional(payrollCurrencyValidator),
    cadence: costCadenceValidator,
    startsOn: v.string(),
    endsOn: v.optional(v.string()),
    variable: v.optional(v.boolean()),
    /** What it counts as in unit economics. Left out: its category's default. */
    bucket: v.optional(costBucketValidator),
    paidBy: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    requireOfferedCurrency(args.currency);
    const name = cleanName(args.name);
    const amount = cleanAmount(args.amount);
    const months = cleanMonths(args.cadence, args.startsOn, args.endsOn);
    const paidBy = cleanPaidBy(args.paidBy ?? "");
    const note = cleanNote(args.note ?? "");
    await requireRoom(ctx, args.company);
    const now = Date.now();
    return await ctx.db.insert("costs", {
      company: args.company,
      name,
      category: args.category,
      amount,
      currency: args.currency ?? startingCurrencyOf(args.company),
      cadence: args.cadence,
      ...months,
      variable: args.variable ?? false,
      ...(args.bucket !== undefined ? { bucket: args.bucket } : null),
      paidBy,
      note,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Edit a line. Leaving a field out keeps it; null clears the end, "paid by",
 * the note, or what it counts as (back to its category's default).
 */
export const update = costsMutation({
  args: {
    id: v.id("costs"),
    name: v.optional(v.string()),
    category: v.optional(costCategoryValidator),
    amount: v.optional(v.number()),
    currency: v.optional(payrollCurrencyValidator),
    cadence: v.optional(costCadenceValidator),
    startsOn: v.optional(v.string()),
    endsOn: v.optional(v.union(v.string(), v.null())),
    variable: v.optional(v.boolean()),
    bucket: v.optional(v.union(costBucketValidator, v.null())),
    paidBy: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError(GONE);
    requireCompany(ctx.member, current.company);
    requireOfferedCurrency(args.currency);
    const cadence = args.cadence ?? current.cadence;
    const months = cleanMonths(
      cadence,
      args.startsOn ?? current.startsOn,
      replaced(args.endsOn, current.endsOn, (month) => month),
    );
    await ctx.db.patch(args.id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : null),
      ...(args.category !== undefined ? { category: args.category } : null),
      ...(args.amount !== undefined ? { amount: cleanAmount(args.amount) } : null),
      ...(args.currency !== undefined ? { currency: args.currency } : null),
      cadence,
      ...months,
      ...(args.variable !== undefined ? { variable: args.variable } : null),
      bucket: replaced(args.bucket, current.bucket, (bucket) => bucket),
      paidBy: replaced(args.paidBy, current.paidBy, cleanPaidBy),
      note: replaced(args.note, current.note, cleanNote),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Put a line out of every figure, and under "Ended". */
export const archive = costsMutation({
  args: { id: v.id("costs") },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError(GONE);
    requireCompany(ctx.member, current.company);
    if (current.archivedAt !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch(args.id, { archivedAt: now, updatedAt: now });
    return null;
  },
});

/** Bring an archived line back, while the company has room for it. */
export const restore = costsMutation({
  args: { id: v.id("costs") },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) throw new ConvexError(GONE);
    requireCompany(ctx.member, current.company);
    if (current.archivedAt === undefined) return null;
    await requireRoom(ctx, current.company);
    await ctx.db.patch(args.id, { archivedAt: undefined, updatedAt: Date.now() });
    return null;
  },
});

/** Delete a line for good: only one that is archived. One already gone does nothing. */
export const remove = costsMutation({
  args: { id: v.id("costs") },
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.id);
    if (current === null) return null;
    requireCompany(ctx.member, current.company);
    if (current.archivedAt === undefined) {
      throw new ConvexError("Archive the line first: only an archived line is deleted.");
    }
    await ctx.db.delete(args.id);
    return null;
  },
});
