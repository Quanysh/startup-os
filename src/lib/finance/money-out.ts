// Where the money goes: a month's actual money out set against what the OS's
// own registers say was spent, and the part neither register holds. Pure,
// and read by the Finance page alone. Nothing here reads a clock.
//
// Money is whole minor units (cents, tiyn) of the company's own currency.
//
//   money out  Startup: Mercury's `cash_out` for a month it read whole.
//              Globex: the actual spend typed on the Budget tab.
//   payroll    a paid month's frozen total cost, else what the Payroll page
//              works out for the month (payroll's own `summarise`).
//   costs      what the cost register had fall due that month (cash due,
//              the figure the bank shows), by category.
//   sent       Startup only: what it sent its subsidiary Globex
//              (`cash_to_subsidiary`), inside its money out.
//   not in the registers  money out, less payroll, less costs, less sent.
//
// The group: Startup's money out less what it sent Globex, plus Globex's.
// What Startup sends is Globex's money, and what Globex spends of it is in
// Globex's money out already: adding both would count it twice.
//
// A missing number is not a zero. A register the viewer does not hold is
// never subtracted around ("hidden"); a figure that is not known (a rate not
// set, another currency with no exchange rate, what Startup sent in a month read
// before it was counted) makes the remainder not known; and registers holding
// more than went out are said as that, never drawn as a negative slice.

import type { CostCategory, CostSummary } from "@convex/lib/costs";
import { featureOn } from "@convex/lib/featureGates";
import type { Currency } from "@convex/lib/metricRegistry";
import type { CurrencyTotals } from "@convex/lib/payroll";
import { convert } from "@convex/lib/runway";
import type { Pay } from "@/lib/costs/planned";

export type PayrollShare =
  | { kind: "known"; amount: number; basis: "paid" | "live" }
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "unknown"; reason: "rates" | "circle" | "no_rate" };

/** Amounts in several currencies as one in `currency`, or null where a rate is needed and missing. */
function inCurrency(
  parts: readonly { currency: Currency; amount: number }[],
  currency: Currency,
  fx: number | null,
): number | null {
  let sum = 0;
  for (const part of parts) {
    const amount = convert(part.amount, part.currency, currency, fx);
    if (amount === null) return null;
    sum += amount;
  }
  return sum;
}

/**
 * What pay cost the company in a month. `paid` is the month's totals when it
 * was marked paid (frozen), else null; `live` is payroll's own summary of the
 * month as the Payroll page shows it, or "no_access" for a viewer who does
 * not hold Payroll (nothing of pay was asked for).
 */
export function payrollShare(input: {
  paid: readonly CurrencyTotals[] | null;
  live: Pay;
  currency: Currency;
  fx: number | null;
}): PayrollShare {
  const { paid, live, currency, fx } = input;
  if (live.kind === "no_access") return { kind: "hidden" };
  if (paid !== null) {
    if (paid.some((set) => set.overall.notComputed > 0)) return { kind: "unknown", reason: "rates" };
    const amount = inCurrency(
      paid.filter((set) => set.overall.people > 0 || set.overall.cost > 0).map((set) => ({ currency: set.currency, amount: set.overall.cost })),
      currency,
      fx,
    );
    return amount === null ? { kind: "unknown", reason: "no_rate" } : { kind: "known", amount, basis: "paid" };
  }
  if (live.kind === "loading") return { kind: "loading" };
  if (live.kind === "unknown") return { kind: "unknown", reason: live.reason };
  const amount = inCurrency(
    live.parts.map((part) => ({ currency: part.currency, amount: part.cost })),
    currency,
    fx,
  );
  return amount === null ? { kind: "unknown", reason: "no_rate" } : { kind: "known", amount, basis: "live" };
}

export type CategoryAmount = { category: CostCategory; amount: number };

export type CostsShare =
  | { kind: "known"; amount: number; byCategory: CategoryAmount[] }
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "unknown"; reason: "no_rate" };

/**
 * What the cost register had fall due in the summary's month (cash due, not
 * the run-rate: money out is what the bank shows), by category, the largest
 * first. "hidden" for a viewer who does not hold Costs (no query was sent).
 */
export function costsShare(
  summary: CostSummary | "hidden" | "loading",
  currency: Currency,
  fx: number | null,
): CostsShare {
  if (summary === "hidden" || summary === "loading") return { kind: summary };
  const byCategory = new Map<CostCategory, number>();
  for (const set of summary.currencies) {
    for (const row of set.byCategory) {
      if (row.cashDue === 0) continue;
      const amount = convert(row.cashDue, set.currency, currency, fx);
      if (amount === null) return { kind: "unknown", reason: "no_rate" };
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + amount);
    }
  }
  const rows = [...byCategory].map(([category, amount]) => ({ category, amount }));
  // Stable: equal amounts keep the register's own order.
  rows.sort((a, b) => b.amount - a.amount);
  return { kind: "known", amount: rows.reduce((sum, row) => sum + row.amount, 0), byCategory: rows };
}

export type SentShare =
  /** What Startup sent Globex in the month, minor units; inside its money out. */
  | { kind: "known"; amount: number }
  /**
   * Not known: `no_actual` while the month's money out is not; `not_counted`
   * where money out is on record and this is not (Mercury read the month
   * before payments to the subsidiary were counted on their own).
   */
  | { kind: "unknown"; reason: "no_actual" | "not_counted" };

/**
 * What Startup sent Globex in a month whose money out is `actual`, from
 * `cash_to_subsidiary` (`sent`, null where the month has none on record).
 * Money out without it is not a month of nothing sent.
 */
export function sentShare(actual: number | null, sent: number | null): SentShare {
  if (actual === null) return { kind: "unknown", reason: "no_actual" };
  if (sent === null) return { kind: "unknown", reason: "not_counted" };
  return { kind: "known", amount: sent };
}

export type Remainder =
  /** In neither register; `share` of money out, null when nothing went out. */
  | { kind: "known"; amount: number; share: number | null }
  /** The registers hold this much more than went out. */
  | { kind: "over"; amount: number }
  | {
      kind: "unknown";
      reason:
        | "payroll_hidden"
        | "costs_hidden"
        | "loading"
        | "no_actual"
        | "payroll_unknown"
        | "costs_unknown"
        | "sent_unknown";
    };

/**
 * Money out less pay, less the cost register's cash due, and for Startup less
 * what it sent Globex (`sent`; null where none applies). A register the
 * viewer does not hold is said first: nothing is worked out around it.
 */
export function remainderOf(
  actual: number | null,
  payroll: PayrollShare,
  costs: CostsShare,
  sent: SentShare | null = null,
): Remainder {
  const unknown = (reason: Extract<Remainder, { kind: "unknown" }>["reason"]): Remainder => ({
    kind: "unknown",
    reason,
  });
  if (payroll.kind === "hidden") return unknown("payroll_hidden");
  if (costs.kind === "hidden") return unknown("costs_hidden");
  if (payroll.kind === "loading" || costs.kind === "loading") return unknown("loading");
  if (actual === null || !Number.isFinite(actual)) return unknown("no_actual");
  if (payroll.kind === "unknown") return unknown("payroll_unknown");
  if (costs.kind === "unknown") return unknown("costs_unknown");
  if (sent !== null && sent.kind === "unknown") return unknown("sent_unknown");
  const amount = actual - payroll.amount - costs.amount - (sent?.amount ?? 0);
  if (amount < 0) return { kind: "over", amount: -amount };
  return { kind: "known", amount, share: actual > 0 ? amount / actual : null };
}

export type MoneyOutRow = {
  /** "YYYY-MM" */
  month: string;
  /** Money out, minor units of the section's currency; null where none is on record. */
  actual: number | null;
  /** Startup's money in before financing, cents; null for Globex, the group, and where it is not whole. */
  moneyIn: number | null;
  payroll: PayrollShare;
  costs: CostsShare;
  /**
   * Startup's rows: what it sent Globex, inside its money out. Null for
   * Globex's rows and the group's, which have no such part (the group
   * takes it out of Startup's money out).
   */
  sent: SentShare | null;
  remainder: Remainder;
  /**
   * The group's rows only: each company's own money out in its own currency
   * (Startup's less what it sent Globex; null where it is not known), what
   * Startup sent (null where not known), and why the group's is not known.
   */
  group?: { us: number | null; sent: number | null; kz: number | null; missing: GroupMissing[] };
};

/**
 * What a group month lacks: Startup's money out (`us`), what Startup sent Globex
 * AI that month (`sent`), Globex's spend (`kz`), or a rate (`fx`).
 */
export type GroupMissing = "us" | "sent" | "kz" | "fx";

export type MoneyOut = {
  currency: Currency;
  /** USD/KZT, for dollars beside Globex's tenge; null where none is on record. */
  fx: number | null;
  rows: MoneyOutRow[];
  holdsPayroll: boolean;
  holdsCosts: boolean;
};

const usableRate = (fx: number | null): fx is number => fx !== null && Number.isFinite(fx) && fx > 0;

/** Globex's tenge in dollar cents at the stored rate; zero needs no rate. Null with none on record. */
const kzInUsd = (minor: number, fx: number | null) =>
  minor === 0 ? 0 : usableRate(fx) ? convert(minor, "KZT", "USD", fx) : null;

/** Startup's pay share plus Globex's, in dollars. Anything short of both known is not a sum. */
function groupPay(us: PayrollShare, kz: PayrollShare, fx: number | null): PayrollShare {
  for (const kind of ["hidden", "loading"] as const) {
    if (us.kind === kind || kz.kind === kind) return { kind };
  }
  if (us.kind === "unknown") return us;
  if (kz.kind === "unknown") return kz;
  if (us.kind !== "known" || kz.kind !== "known") return { kind: "loading" };
  const converted = kzInUsd(kz.amount, fx);
  if (converted === null) return { kind: "unknown", reason: "no_rate" };
  return {
    kind: "known",
    amount: us.amount + converted,
    basis: us.basis === "paid" && kz.basis === "paid" ? "paid" : "live",
  };
}

/** Startup's register share plus Globex's, category by category, in dollars. */
function groupCosts(us: CostsShare, kz: CostsShare, fx: number | null): CostsShare {
  for (const kind of ["hidden", "loading"] as const) {
    if (us.kind === kind || kz.kind === kind) return { kind };
  }
  if (us.kind === "unknown") return us;
  if (kz.kind === "unknown") return kz;
  if (us.kind !== "known" || kz.kind !== "known") return { kind: "loading" };
  const byCategory = new Map(us.byCategory.map((row) => [row.category, row.amount]));
  for (const row of kz.byCategory) {
    const converted = kzInUsd(row.amount, fx);
    if (converted === null) return { kind: "unknown", reason: "no_rate" };
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + converted);
  }
  const rows = [...byCategory].map(([category, amount]) => ({ category, amount }));
  rows.sort((a, b) => b.amount - a.amount);
  return { kind: "known", amount: rows.reduce((sum, row) => sum + row.amount, 0), byCategory: rows };
}

/**
 * Where the group's money goes, in dollars: each month, Startup's money out
 * less what it sent Globex, and its register shares, plus Globex's
 * converted at the stored rate. What Startup sent is Globex's money, and
 * Globex's money out already holds what it spent of it. A month is a group
 * figure only where both companies have one, what Startup sent is known, and
 * tenge can be converted; otherwise its money out is not known and the row
 * says which is missing. A register hidden from the viewer is hidden for the
 * group too. Money in is Startup's alone (Globex's is not on record), so the
 * group has no money-in line.
 */
export function groupMoneyOut(us: MoneyOut, kz: MoneyOut, fx: number | null): MoneyOut {
  const kzOf = new Map(kz.rows.map((row) => [row.month, row]));
  const rows = us.rows.flatMap((own): MoneyOutRow[] => {
    const other = kzOf.get(own.month);
    if (other === undefined) return [];
    const missing: GroupMissing[] = [];
    // A Startup row with no such part is not one with nothing sent, unless no
    // subsidiary is funded from Mercury at all (convex/lib/features.ts).
    const sent = !featureOn("subsidiaryFunding") ? 0 : own.sent?.kind === "known" ? own.sent.amount : null;
    if (own.actual === null) missing.push("us");
    else if (sent === null) missing.push("sent");
    if (other.actual === null) missing.push("kz");
    else if (kzInUsd(other.actual, fx) === null) missing.push("fx");
    const usOwn = own.actual === null || sent === null ? null : own.actual - sent;
    const actual = missing.length > 0 ? null : usOwn! + kzInUsd(other.actual!, fx)!;
    const payroll = groupPay(own.payroll, other.payroll, fx);
    const costs = groupCosts(own.costs, other.costs, fx);
    return [
      {
        month: own.month,
        actual,
        moneyIn: null,
        payroll,
        costs,
        sent: null,
        remainder: remainderOf(actual, payroll, costs),
        group: { us: usOwn, sent, kz: other.actual, missing },
      },
    ];
  });
  return { currency: "USD", fx, rows, holdsPayroll: us.holdsPayroll, holdsCosts: us.holdsCosts };
}

/** A month needs this many months of money out on record to be drawn as a chart. */
export const MIN_CHART_MONTHS = 3;

/**
 * What the section draws: the months with money out on record, as a chart,
 * from three of them; with fewer, the latest such month alone; with none,
 * nothing.
 */
export function shownMonths<Row extends { actual: number | null }>(
  rows: readonly Row[],
): { kind: "chart"; months: Row[] } | { kind: "one"; month: Row } | { kind: "none" } {
  const known = rows.filter((row) => row.actual !== null);
  if (known.length >= MIN_CHART_MONTHS) return { kind: "chart", months: known };
  const latest = known.at(-1);
  return latest === undefined ? { kind: "none" } : { kind: "one", month: latest };
}
