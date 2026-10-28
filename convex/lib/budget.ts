// The budget: a figure per month and category, set against what was actually
// spent. Pure: the server (convex/budget.ts), the Finance plan page and the
// owner's agent (the `budget` tool) all read this one module.
//
// Each cell's figure comes from the registers unless someone typed one: the
// Payroll row is that month's payroll total cost (worked out in the browser,
// by payroll's own functions, for a viewer who holds Payroll), each Costs row
// that month's cash due from the cost register (`cashDueLive`). A typed cell
// (a row of `budgets`) overrides the register's figure and can be reset to it.
//
// Money is whole minor units of the company's own currency. A month is
// "YYYY-MM". Nothing here reads a clock: the month is always handed in.
//
// A missing number is not a zero: a register figure that is not known makes
// the month's total not known, a row the caller may not see is left out of
// the total and named, a month with no actual has no variance, and a figure
// that would need an exchange rate nobody recorded is not known.

import type { CompanyId } from "./company";
import { featureOn } from "./featureGates";
import { readWhole, type FinanceSummary } from "./finance";
import {
  CATEGORY_LABELS,
  COST_CATEGORIES,
  addMonths,
  cashDueOf,
  kztToUsd,
  type CostCategory,
  type CostLine,
} from "./costs";
import type { Currency } from "./metricRegistry";
import { convert } from "./runway";

/** The budget's rows: the Costs categories, then Payroll. */
export const BUDGET_CATEGORIES = [...COST_CATEGORIES, "payroll"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export const BUDGET_LABELS: Record<BudgetCategory, string> = {
  ...CATEGORY_LABELS,
  payroll: "Payroll",
};

/** How many months the grid shows. */
export const BUDGET_MONTHS = 12;

/** Where a row's figure comes from when nobody typed one. */
export type Register = "payroll" | "costs";
export const REGISTERS: readonly Register[] = ["payroll", "costs"];
export const registerOf = (category: BudgetCategory): Register =>
  category === "payroll" ? "payroll" : "costs";
/** The page a register is kept on, as the grid says it: "from Payroll", "Reset to Costs". */
export const REGISTER_LABELS: Record<Register, string> = { payroll: "Payroll", costs: "Costs" };

/**
 * What a register says a cell comes to, as far as the caller may know it.
 * - `hidden`: the caller does not hold that register's page. Nothing of the
 *   row is theirs, a typed figure included.
 * - `withheld`: the register's figure is never given here (pay, to the
 *   owner's agent), but a typed figure the caller was sent still stands.
 */
export type Live =
  | { kind: "known"; amount: number }
  | { kind: "unknown"; reason: "rates" | "circle" | "no_rate" }
  | { kind: "hidden" }
  | { kind: "withheld" }
  | { kind: "loading" };

/** A cell as the budget counts it. */
export type Effective =
  /** Typed in; `live` is the register's figure it replaced, to go back to. */
  | { kind: "override"; amount: number; live: Live }
  /** The register's figure: nothing was typed. */
  | { kind: "live"; amount: number }
  | { kind: "unknown"; reason: "rates" | "circle" | "no_rate" }
  | { kind: "hidden" }
  | { kind: "loading" };

/**
 * One cell: what was typed, else what the register says. A row the caller
 * may not see is hidden whatever was typed in it; the server does not send
 * such a typed figure either.
 */
export function effectiveCell(override: number | null | undefined, live: Live): Effective {
  if (live.kind === "hidden") return { kind: "hidden" };
  if (override !== null && override !== undefined) return { kind: "override", amount: override, live };
  switch (live.kind) {
    case "known":
      return { kind: "live", amount: live.amount };
    case "withheld":
      return { kind: "hidden" };
    default:
      return live;
  }
}

/** The figure a cell counts as, or null where it has none to count. */
export function amountOf(cell: Effective): number | null {
  return cell.kind === "override" || cell.kind === "live" ? cell.amount : null;
}

/**
 * What the cost register has fall due in `month`, per Costs category, in the
 * company's currency: the cash the bank will show (a yearly bill whole in its
 * month, a one-off in its own), not the run-rate. A category with no line is
 * a known zero. A line in the other currency is converted at the stored rate;
 * with none on record its category is not known, the others still are.
 */
export function cashDueLive(
  lines: readonly CostLine[],
  month: string,
  currency: Currency,
  fxUsdKzt: number | null,
): Record<CostCategory, Live> {
  const out = Object.fromEntries(COST_CATEGORIES.map((c) => [c, { kind: "known", amount: 0 }])) as Record<
    CostCategory,
    Live
  >;
  for (const line of lines) {
    const due = cashDueOf(line, month);
    if (due === 0) continue;
    const held = out[line.category];
    if (held.kind !== "known") continue;
    const amount = convert(due, line.currency, currency, fxUsdKzt);
    out[line.category] =
      amount === null ? { kind: "unknown", reason: "no_rate" } : { kind: "known", amount: held.amount + amount };
  }
  return out;
}

/** A cell of the budget, as the caller sees it. */
export type BudgetCell = { month: string; category: BudgetCategory; cell: Effective };

/**
 * Every month and category of a budget: the typed cells (`budgets` rows, as
 * the server sent them) over what `live` says each register comes to.
 */
export function effectiveBudget(
  months: readonly string[],
  typed: readonly { month: string; category: BudgetCategory; amount: number }[],
  live: (category: BudgetCategory, month: string) => Live,
): BudgetCell[] {
  const held = new Map(typed.map((cell) => [`${cell.category}:${cell.month}`, cell.amount]));
  return months.flatMap((month) =>
    BUDGET_CATEGORIES.map((category) => ({
      month,
      category,
      cell: effectiveCell(held.get(`${category}:${month}`), live(category, month)),
    })),
  );
}

export type BudgetTotal =
  /** `excludes`: the registers whose rows the caller may not see, left out of `amount`. */
  | { kind: "known"; amount: number; excludes: Register[] }
  | { kind: "unknown"; excludes: Register[] }
  /** Every row is hidden from the caller: there is nothing to add. */
  | { kind: "hidden"; excludes: Register[] }
  | { kind: "loading" };

/**
 * What cells add to: a row the caller may not see is left out and named, a
 * part that is not known makes the whole not known (never the rest as if it
 * were all of it).
 */
export function budgetTotal(cells: readonly BudgetCell[]): BudgetTotal {
  if (cells.some((c) => c.cell.kind === "loading")) return { kind: "loading" };
  const excludes = REGISTERS.filter((register) =>
    cells.some((c) => c.cell.kind === "hidden" && registerOf(c.category) === register),
  );
  const visible = cells.filter((c) => c.cell.kind !== "hidden");
  if (visible.length === 0) return { kind: "hidden", excludes };
  let amount = 0;
  for (const { cell } of visible) {
    const counted = amountOf(cell);
    if (counted === null) return { kind: "unknown", excludes };
    amount += counted;
  }
  return { kind: "known", amount, excludes };
}

/** The largest amount a cell holds: a trillion minor units. */
export const MAX_BUDGET_AMOUNT = 1_000_000_000_000;

/** The months of the grid, from `first`. */
export const budgetMonths = (first: string) =>
  Array.from({ length: BUDGET_MONTHS }, (_, i) => addMonths(first, i));

/** The month a period's first day ("2026-10-01") is in. */
export const monthOfPeriod = (periodStart: string) => periodStart.slice(0, 7);

export type Variance =
  | {
      kind: "over" | "under" | "on";
      /** Actual less plan: above zero is over plan. */
      diff: number;
      /** `diff` as a share of the plan; null for a plan of zero. */
      share: number | null;
    }
  /** `left_out`: the budget leaves out a row the caller may not see, so it is not set against everything spent. */
  | { kind: "unknown"; reason: "no_plan" | "no_actual" | "left_out" };

export function variance(plan: number | null, actual: number | null): Variance {
  if (plan === null) return { kind: "unknown", reason: "no_plan" };
  if (actual === null) return { kind: "unknown", reason: "no_actual" };
  const diff = actual - plan;
  return {
    kind: diff > 0 ? "over" : diff < 0 ? "under" : "on",
    diff,
    share: plan === 0 ? null : diff / plan,
  };
}

/**
 * A Mercury flow by month (`cash_out`, `cash_to_subsidiary`: US dollars as
 * stored) in cents, for the months before `currentMonth` that Mercury read
 * whole. The month in progress, and a month last read before it ended, hold
 * part of a month and are not actuals. Money out whole is the bank's figure
 * (Where the money goes); the budget's actual is Startup's own (`startupActuals`).
 */
export function mercuryActuals(
  cashOut: readonly { periodStart: string; value: number }[],
  currentMonth: string,
  readAt: number | null,
): Map<string, number> {
  const actuals = new Map<string, number>();
  for (const point of cashOut) {
    const month = monthOfPeriod(point.periodStart);
    if (month >= currentMonth || !readWhole(point.periodStart, readAt)) continue;
    actuals.set(month, Math.round(point.value * 100));
  }
  return actuals;
}

/**
 * Startup's actual spending by month, in cents: its own, Mercury's money out
 * less what it sent Globex (`cash_to_subsidiary`), for the months before
 * `currentMonth` that Mercury read whole. The funding is Globex's money:
 * set against Startup's budget it read as Startup overspending, and Globex's
 * spending of it is in Globex's own actual. A month with money out and no
 * figure of what was sent (read before that was counted) is not an actual:
 * never the whole money out, as if nothing had been sent.
 */
export function startupActuals(
  cashOut: readonly { periodStart: string; value: number }[],
  sent: readonly { periodStart: string; value: number }[],
  currentMonth: string,
  readAt: number | null,
): Map<string, number> {
  const out = mercuryActuals(cashOut, currentMonth, readAt);
  // No subsidiary funded from Mercury (convex/lib/features.ts): money out is Startup's own.
  if (!featureOn("subsidiaryFunding")) return out;
  const went = mercuryActuals(sent, currentMonth, readAt);
  const actuals = new Map<string, number>();
  for (const [month, amount] of out) {
    const funding = went.get(month);
    if (funding !== undefined) actuals.set(month, amount - funding);
  }
  return actuals;
}

export type MonthRow = {
  month: string;
  /** The budget's total; null where it is not known. */
  plan: number | null;
  actual: number | null;
  /** The registers the plan leaves out: the caller may not see them. */
  excludes: Register[];
  variance: Variance;
};

/**
 * Per month: the budget's total, the actual where known, and the variance.
 * A total that leaves a register out is not set against everything spent:
 * pay or costs missing from it would read as being under budget.
 */
export function planVsActual(
  months: readonly string[],
  cells: readonly BudgetCell[],
  actuals: ReadonlyMap<string, number>,
): MonthRow[] {
  return months.map((month) => {
    const total = budgetTotal(cells.filter((cell) => cell.month === month));
    const plan = total.kind === "known" ? total.amount : null;
    const excludes = total.kind === "loading" ? [] : total.excludes;
    const actual = actuals.get(month) ?? null;
    return {
      month,
      plan,
      actual,
      excludes,
      variance: excludes.length > 0 ? { kind: "unknown", reason: "left_out" } : variance(plan, actual),
    };
  });
}

export type CategoryRow = {
  category: CostCategory;
  plan: number | null;
  /** The cost register's run-rate: what is planned to be paid, not what was spent. */
  runRate: number | null;
  variance: Variance;
};

/**
 * A month's budget per Costs category against the cost register's run-rate
 * (`runRateByCategory`): a run-rate above the budget is over it. Categories
 * with a budget above zero or a run-rate entry. Payroll is not a Costs
 * category, and a hidden row has nothing to compare.
 */
export function categoryVsRunRate(
  month: string,
  cells: readonly BudgetCell[],
  runRate: Partial<Record<CostCategory, number | null>>,
): CategoryRow[] {
  return COST_CATEGORIES.flatMap((category) => {
    const held = cells.find((cell) => cell.month === month && cell.category === category)?.cell;
    if (held === undefined || held.kind === "hidden") return [];
    const plan = amountOf(held);
    const rate = runRate[category];
    if (rate === undefined && (plan === null || plan === 0)) return [];
    return [{ category, plan, runRate: rate ?? null, variance: variance(plan, rate ?? null) }];
  });
}

/**
 * Where a company's projection starts: its cash now and its average net
 * burn, from the Finance page's own summary, in the company's currency's
 * minor units. Startup's are the page's dollars. Globex's cash is its tenge
 * balance, and its burn the page's dollar figure back in tenge at the rate
 * the page used. Partial cash, or no figure, is null: not known.
 */
export function runwayInputs(
  summary: Pick<FinanceSummary, "cash" | "average">,
  company: CompanyId,
): { currency: Currency; cash: number | null; netBurn: number | null } {
  const { cash, average } = summary;
  const whole = cash !== null && cash.missing.length === 0 ? cash : null;
  if (company === "us") {
    return {
      currency: "USD",
      cash: whole === null ? null : Math.round(whole.usd * 100),
      netBurn: average === null ? null : Math.round(average.value * 100),
    };
  }
  const part = whole?.parts.find((p) => p.scope === "kz");
  const rate = whole?.rate ?? null;
  return {
    currency: "KZT",
    cash: part === undefined ? null : Math.round(part.native * 100),
    netBurn: average === null || rate === null ? null : Math.round(average.value * rate * 100),
  };
}

/**
 * The cost register's run-rate per category in `currency`, from a cost
 * summary's per-currency figures. A category with a part in the other
 * currency and no rate on record is null: not known, never the part alone.
 */
export function runRateByCategory(
  currencies: readonly {
    currency: Currency;
    byCategory: readonly { category: CostCategory; runRate: number }[];
  }[],
  currency: Currency,
  fxUsdKzt: number | null,
): Partial<Record<CostCategory, number | null>> {
  const rate = fxUsdKzt !== null && Number.isFinite(fxUsdKzt) && fxUsdKzt > 0 ? fxUsdKzt : null;
  const out: Partial<Record<CostCategory, number | null>> = {};
  for (const set of currencies) {
    for (const row of set.byCategory) {
      if (row.runRate === 0) continue;
      const held = out[row.category];
      let amount: number | null = row.runRate;
      if (set.currency !== currency) {
        amount =
          rate === null
            ? null
            : set.currency === "USD"
              ? Math.round(row.runRate * rate)
              : kztToUsd(row.runRate, rate);
      }
      out[row.category] = held === null || amount === null ? null : (held ?? 0) + amount;
    }
  }
  return out;
}
