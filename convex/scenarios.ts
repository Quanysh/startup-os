import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { MAX_BUDGET_AMOUNT } from "./lib/budget";
import type { CompanyId } from "./lib/company";
import { requireOfferedCurrency } from "./lib/customerShape";
import { isMonth } from "./lib/costs";
import { cleanRemote } from "./lib/mirrorRules";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { isOneOff, type Change } from "./lib/runway";
import { companyValidator, scenarioChangeValidator } from "./schema";

// Runway scenarios (the Finance plan page): a name and dated changes, at
// most ten a company. Gated by `finance` and one company's throughout. A
// hire's cost is a figure: typed, or worked out in the browser at the payroll
// rates for a viewer who holds Payroll (convex/lib/hireCost.ts). Nothing here
// reads a payroll table. Names and labels are typed text: cleaned, bounded,
// and in no log or thrown error.

const financeQuery = memberQuery("finance");
const financeMutation = memberMutation("finance");

export const MAX_SCENARIOS = 10;
export const MAX_CHANGES = 20;
export const MAX_SCENARIO_NAME = 60;
export const MAX_CHANGE_LABEL = 80;

export const SCENARIOS_FULL = `That is every scenario a company can have (${MAX_SCENARIOS}). Delete one first.`;
export const TOO_MANY_CHANGES = `A scenario holds ${MAX_CHANGES} changes at most.`;
export const SCENARIO_GONE = "That scenario no longer exists.";
export const NEEDS_A_NAME = "A scenario needs a name.";
export const BAD_CHANGE =
  "A change needs a month to start, an end no earlier than its start, and a whole amount (only a cost or revenue may be negative).";

function cleanText(text: string, max: number, what: string): string {
  const tooLong = `That ${what} is too long (${max} characters at most).`;
  if (text.length > max * 8) throw new ConvexError(tooLong);
  const flat = cleanRemote(text, Number.POSITIVE_INFINITY);
  if (flat.length > max) throw new ConvexError(tooLong);
  return flat;
}

type StoredChange = typeof scenarioChangeValidator.type;

function cleanChange(change: StoredChange): StoredChange {
  requireOfferedCurrency(change.currency);
  const oneOff = isOneOff(change.kind);
  const endMonth = oneOff ? undefined : change.endMonth;
  const signed = change.kind === "cost" || change.kind === "revenue";
  const ok =
    isMonth(change.startMonth) &&
    (endMonth === undefined || (isMonth(endMonth) && endMonth >= change.startMonth)) &&
    Number.isInteger(change.amount) &&
    Math.abs(change.amount) <= MAX_BUDGET_AMOUNT &&
    (signed || change.amount >= 0) &&
    (change.fromPayroll === undefined ||
      (change.kind === "hire" &&
        Number.isInteger(change.fromPayroll.salary) &&
        change.fromPayroll.salary > 0 &&
        change.fromPayroll.salary <= MAX_BUDGET_AMOUNT));
  if (!ok) throw new ConvexError(BAD_CHANGE);
  return {
    kind: change.kind,
    label: cleanText(change.label, MAX_CHANGE_LABEL, "label"),
    startMonth: change.startMonth,
    ...(endMonth === undefined ? {} : { endMonth }),
    amount: change.amount,
    currency: change.currency,
    ...(change.fromPayroll === undefined ? {} : { fromPayroll: change.fromPayroll }),
  };
}

export type Scenario = {
  id: Id<"scenarios">;
  name: string;
  changes: (Change & { fromPayroll: StoredChange["fromPayroll"] | null })[];
  updatedAt: number;
};

/** A company's scenarios, oldest first. What `scenarios.list` and the agent read. */
export async function scenariosFor(ctx: QueryCtx, member: Member, company: CompanyId): Promise<Scenario[]> {
  requireCompany(member, company);
  const rows = await ctx.db
    .query("scenarios")
    .withIndex("by_company", (q) => q.eq("company", company))
    .take(MAX_SCENARIOS * 2);
  return rows
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row) => ({
      id: row._id,
      name: row.name,
      changes: row.changes.map((change) => ({
        kind: change.kind,
        label: change.label,
        startMonth: change.startMonth,
        endMonth: change.endMonth ?? null,
        amount: change.amount,
        currency: change.currency,
        fromPayroll: change.fromPayroll ?? null,
      })),
      updatedAt: row.updatedAt,
    }));
}

export const list = financeQuery({
  args: { company: companyValidator },
  handler: (ctx, args) => scenariosFor(ctx, ctx.member, args.company),
});

/** Add a scenario, or replace one's name and changes (by `id`). Returns its id. */
export const save = financeMutation({
  args: {
    company: companyValidator,
    id: v.optional(v.id("scenarios")),
    name: v.string(),
    changes: v.array(scenarioChangeValidator),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const name = cleanText(args.name, MAX_SCENARIO_NAME, "name");
    if (name === "") throw new ConvexError(NEEDS_A_NAME);
    if (args.changes.length > MAX_CHANGES) throw new ConvexError(TOO_MANY_CHANGES);
    const changes = args.changes.map(cleanChange);
    const now = Date.now();
    if (args.id !== undefined) {
      const row = await ctx.db.get(args.id);
      if (row === null) throw new ConvexError(SCENARIO_GONE);
      requireCompany(ctx.member, row.company);
      // A scenario stays with its company.
      if (row.company !== args.company) throw new ConvexError(SCENARIO_GONE);
      await ctx.db.patch(args.id, { name, changes, updatedAt: now });
      return args.id;
    }
    const held = await ctx.db
      .query("scenarios")
      .withIndex("by_company", (q) => q.eq("company", args.company))
      .take(MAX_SCENARIOS);
    if (held.length >= MAX_SCENARIOS) throw new ConvexError(SCENARIOS_FULL);
    return await ctx.db.insert("scenarios", {
      company: args.company,
      name,
      changes,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const remove = financeMutation({
  args: { id: v.id("scenarios") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return;
    requireCompany(ctx.member, row.company);
    await ctx.db.delete(args.id);
  },
});
