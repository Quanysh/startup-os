import { ConvexError, v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { costLinesFor, costSummaryFor } from "./costs";
import {
  BUDGET_CATEGORIES,
  BUDGET_MONTHS,
  MAX_BUDGET_AMOUNT,
  cashDueLive,
  categoryVsRunRate,
  effectiveBudget,
  startupActuals,
  planVsActual,
  registerOf,
  runRateByCategory,
  runwayInputs,
  type BudgetCategory,
  type Live,
} from "./lib/budget";
import { COMPANIES, type CompanyId } from "./lib/company";
import { addMonths, firstDayOf, isMonth } from "./lib/costs";
import { MARKET_CURRENCY } from "./lib/customerShape";
import { SENT_TO_SUBSIDIARY, financeSummary } from "./lib/finance";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { may } from "./lib/roles";
import { project, type Change } from "./lib/runway";
import { scorecardFor, seriesFor } from "./metrics";
import { scenariosFor } from "./scenarios";
import { budgetCategoryValidator, companyValidator } from "./schema";

// The budget (the Finance plan page): a typed amount per company, month and
// category, and Globex's actual spending typed in by month. Gated by
// `finance`, and one company's throughout: every function calls
// `requireCompany` before it reads or writes anything.
//
// A cell nobody typed is the register's figure (convex/lib/budget.ts): the
// page works it out in the browser from Payroll's and Costs' own queries, for
// a viewer who holds those pages; a stored row here is an override of it.
//
// Each register's row is for whoever also holds its page: the Payroll row's
// typed cells are not sent to anyone without Payroll, nor the Costs rows'
// to anyone without Costs, and neither can write them. Nothing here reads a
// payroll table. Every refusal is fixed words.

const financeQuery = memberQuery("finance");
const financeMutation = memberMutation("finance");

export const NOT_A_MONTH = "That is not a month.";
export const NOT_AN_AMOUNT = "An amount is a whole number of cents or tiyn, zero or more.";
export const PAY_NEEDS_PAYROLL = "The Payroll row is for whoever holds the Payroll page.";
export const COSTS_NEED_COSTS = "The Costs rows are for whoever holds the Costs page.";
export const ACTUAL_IS_MERCURYS = `${COMPANIES.us.name}'s actual spending comes from Mercury; it is not typed in.`;
export const TOO_MANY_CELLS = "That is more cells than one save takes.";
export const TOO_MANY_MONTHS = "That is more months than the budget shows at once.";

/** The most cells one save writes: every category of a year. */
export const MAX_CELLS_A_SAVE = BUDGET_CATEGORIES.length * 12;
/** The most months one read covers. */
export const MAX_VIEW_MONTHS = 36;

function requireMonth(month: string) {
  if (!isMonth(month)) throw new ConvexError(NOT_A_MONTH);
}

function requireAmount(amount: number) {
  if (!Number.isInteger(amount) || amount < 0 || amount > MAX_BUDGET_AMOUNT) {
    throw new ConvexError(NOT_AN_AMOUNT);
  }
}

export type BudgetView = {
  company: CompanyId;
  currency: "USD" | "KZT";
  months: string[];
  /** "hidden": the caller lacks Payroll, and the Payroll row was not sent. */
  payroll: "shown" | "hidden";
  /** "hidden": the caller lacks Costs, and the Costs rows were not sent. */
  costs: "shown" | "hidden";
  /** The typed cells (overrides of the registers' figures) the caller may see. */
  cells: { month: string; category: BudgetCategory; amount: number }[];
  /** Typed-in actual spending (Globex). Startup's comes from Mercury, on the page. */
  actuals: { month: string; amount: number }[];
};

/**
 * A company's budget for `count` months from `first`. What `budget.view`
 * returns and what the owner's agent reads: one function, so they agree.
 */
export async function budgetFor(
  ctx: QueryCtx,
  member: Member,
  company: CompanyId,
  first: string,
  count: number,
): Promise<BudgetView> {
  requireCompany(member, company);
  requireMonth(first);
  if (!Number.isInteger(count) || count < 1 || count > MAX_VIEW_MONTHS) {
    throw new ConvexError(TOO_MANY_MONTHS);
  }
  const last = addMonths(first, count - 1);
  const showPay = may(member, "payroll");
  const showCosts = may(member, "costs");
  const shown = (category: BudgetCategory) => (registerOf(category) === "payroll" ? showPay : showCosts);
  const rows = await ctx.db
    .query("budgets")
    .withIndex("by_company_and_month_and_category", (q) =>
      q.eq("company", company).gte("month", first).lte("month", last),
    )
    .collect();
  const actuals = await ctx.db
    .query("budgetActuals")
    .withIndex("by_company_and_month", (q) =>
      q.eq("company", company).gte("month", first).lte("month", last),
    )
    .collect();
  return {
    company,
    currency: MARKET_CURRENCY[company],
    months: Array.from({ length: count }, (_, i) => addMonths(first, i)),
    payroll: showPay ? "shown" : "hidden",
    costs: showCosts ? "shown" : "hidden",
    cells: rows
      .filter((row) => shown(row.category))
      .map((row) => ({ month: row.month, category: row.category, amount: row.amount })),
    actuals: actuals.map((row) => ({ month: row.month, amount: row.amount })),
  };
}

/** How many months before the month asked about the report covers; it covers twelve. */
export const REPORT_MONTHS_BEFORE = 6;

/**
 * What the owner's agent is told of a company's budget (the `budget` tool):
 * the effective budget against actual by month, the month's budget per
 * category against the cost register's run-rate, and each scenario's run-out
 * month. Built from the functions the page's own queries call (`budgetFor`,
 * `scenariosFor`, `scorecardFor`, `seriesFor`, `costLinesFor`,
 * `costSummaryFor`) and the pure modules the page runs (`effectiveBudget`,
 * `cashDueLive`), so the two agree. `currentMonth` is the clock's, handed in.
 *
 * The same rules as the page: a typed cell overrides the register's figure;
 * each Costs category's figure is the cost register's cash due, for a caller
 * who holds Costs. Pay is never given to a token, so the Payroll row's live
 * figure is withheld here: a typed Payroll cell still counts (never broken
 * out), and a month without one leaves Payroll out of its total, says so
 * (`excludes`) and is not set against the actual.
 */
export async function budgetReportFor(
  ctx: QueryCtx,
  member: Member,
  company: CompanyId,
  month: string,
  currentMonth: string,
) {
  requireCompany(member, company);
  requireMonth(month);
  requireMonth(currentMonth);
  const first = addMonths(month, -REPORT_MONTHS_BEFORE);
  const view = await budgetFor(ctx, member, company, first, BUDGET_MONTHS);
  const card = await scorecardFor(ctx, member);
  const kzCash = company === "kz" ? await seriesFor(ctx, member, "cash", "kz", 400) : [];
  const readAt = card.sources.mercury?.lastOkAt ?? null;
  const summary = financeSummary(card.tiles, kzCash, firstDayOf(currentMonth), readAt, [company]);
  const fx = card.tiles.find((tile) => tile.key === "fx_usd_kzt")?.latest?.value ?? null;

  // Startup's actual is its own spending: money out less what it sent Globex.
  const usSeries = (key: string) => card.tiles.find((tile) => tile.key === key && tile.scope === "us")?.series ?? [];
  const actuals =
    company === "us"
      ? startupActuals(usSeries("cash_out"), usSeries(SENT_TO_SUBSIDIARY), currentMonth, readAt)
      : new Map(view.actuals.map((row) => [row.month, row.amount]));

  const holdsCosts = may(member, "costs");
  const runRate = holdsCosts
    ? runRateByCategory(
        (await costSummaryFor(ctx, member, company, month)).currencies,
        view.currency,
        fx,
      )
    : null;
  const costLines = holdsCosts ? await costLinesFor(ctx, member, company) : [];
  const dueBy = new Map(view.months.map((m) => [m, cashDueLive(costLines, m, view.currency, fx)]));
  const live = (category: BudgetCategory, m: string): Live =>
    registerOf(category) === "payroll"
      ? view.payroll === "shown"
        ? { kind: "withheld" }
        : { kind: "hidden" }
      : holdsCosts
        ? dueBy.get(m)![category as Exclude<BudgetCategory, "payroll">]
        : { kind: "hidden" };
  const cells = effectiveBudget(view.months, view.cells, live);

  const start = runwayInputs(summary, company);
  const projectWith = (changes: Change[]) =>
    project({ startMonth: currentMonth, ...start, changes, fxUsdKzt: fx });
  const scenarios = (await scenariosFor(ctx, member, company)).map((scenario) => ({
    name: scenario.name,
    projection: projectWith(scenario.changes),
  }));

  return {
    company,
    currency: view.currency,
    month,
    payroll: view.payroll,
    costs: view.costs,
    actualSource: company === "us" ? ("mercury" as const) : ("typed" as const),
    months: planVsActual(view.months, cells, actuals),
    categories: runRate === null ? null : categoryVsRunRate(month, cells, runRate),
    start,
    baseline: projectWith([]),
    scenarios,
  };
}

export const view = financeQuery({
  args: { company: companyValidator, first: v.string(), count: v.number() },
  handler: (ctx, args) => budgetFor(ctx, ctx.member, args.company, args.first, args.count),
});

/**
 * Save cells: one or a row. An amount writes the cell (an override of the
 * register's figure), null clears it (back to the register's figure). The
 * Payroll row needs Payroll as well, and the Costs rows need Costs.
 */
export const setCells = financeMutation({
  args: {
    company: companyValidator,
    cells: v.array(
      v.object({
        month: v.string(),
        category: budgetCategoryValidator,
        amount: v.union(v.number(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    if (args.cells.length > MAX_CELLS_A_SAVE) throw new ConvexError(TOO_MANY_CELLS);
    for (const cell of args.cells) {
      requireMonth(cell.month);
      if (cell.amount !== null) requireAmount(cell.amount);
      if (cell.category === "payroll" && !may(ctx.member, "payroll")) {
        throw new ConvexError(PAY_NEEDS_PAYROLL);
      }
      if (cell.category !== "payroll" && !may(ctx.member, "costs")) {
        throw new ConvexError(COSTS_NEED_COSTS);
      }
    }
    const currency = MARKET_CURRENCY[args.company];
    for (const cell of args.cells) {
      const held = await ctx.db
        .query("budgets")
        .withIndex("by_company_and_month_and_category", (q) =>
          q.eq("company", args.company).eq("month", cell.month).eq("category", cell.category),
        )
        .unique();
      if (cell.amount === null) {
        if (held !== null) await ctx.db.delete(held._id);
      } else if (held !== null) {
        await ctx.db.patch(held._id, { amount: cell.amount, updatedAt: Date.now() });
      } else {
        await ctx.db.insert("budgets", {
          company: args.company,
          month: cell.month,
          category: cell.category,
          amount: cell.amount,
          currency,
          updatedAt: Date.now(),
        });
      }
    }
  },
});

/** Globex's actual spending in a month, or null to clear it. Startup's is Mercury's. */
export const setActual = financeMutation({
  args: { company: companyValidator, month: v.string(), amount: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    if (args.company === "us") throw new ConvexError(ACTUAL_IS_MERCURYS);
    requireMonth(args.month);
    if (args.amount !== null) requireAmount(args.amount);
    const held = await ctx.db
      .query("budgetActuals")
      .withIndex("by_company_and_month", (q) => q.eq("company", args.company).eq("month", args.month))
      .unique();
    if (args.amount === null) {
      if (held !== null) await ctx.db.delete(held._id);
    } else if (held !== null) {
      await ctx.db.patch(held._id, { amount: args.amount, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("budgetActuals", {
        company: args.company,
        month: args.month,
        amount: args.amount,
        currency: MARKET_CURRENCY[args.company],
        updatedAt: Date.now(),
      });
    }
  },
});
