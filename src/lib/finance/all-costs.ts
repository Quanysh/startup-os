// All costs: every recurring cost of a company this month in one place, and
// the group's in US dollars. Pure, read by the Finance page alone. Nothing
// here reads a clock: the month is handed in.
//
// It works nothing out that Payroll or the cost register does not already:
//   Payroll       this month's total cost (gross pay plus what the company
//                 pays on top): a paid month's frozen total, else payroll's own
//                 `summarise`, as the Payroll page and the budget show it
//                 (`payrollByMonth`), and the same split by kind.
//   a category    the cost register's run-rate this month (`summarise`, then
//                 `runRateByCategory`): recurring lines spread evenly, a
//                 yearly bill a twelfth; a one-off is never in it.
//   cash due      Payroll plus what the register has fall due this month
//                 (`cashDueLive`): a yearly bill whole in its month, one-offs.
// What is added here is sums, the group's dollars and shares.
//
// A missing number is not a zero. A register the viewer does not hold is
// hidden and left out of every total, which says so; a figure that is not
// known (a rate not set, another currency with no exchange rate) makes every
// total and share it is part of not known, never the rest as if it were all.

import {
  REGISTERS,
  cashDueLive,
  runRateByCategory,
  type Live,
  type Register,
} from "@convex/lib/budget";
import type { CompanyId } from "@convex/lib/company";
import {
  CATEGORY_LABELS,
  COST_CATEGORIES,
  firstDayOf,
  kztToUsd,
  runRateOf,
  summarise as costSummary,
  type CostCadence,
  type CostCategory,
  type CostLine,
} from "@convex/lib/costs";
import { MARKET_CURRENCY } from "@convex/lib/customerShape";
import type { Currency } from "@convex/lib/metricRegistry";
import {
  PAYROLL_KINDS,
  isWhole,
  summarise as paySummary,
  type CurrencySummary,
  type PayrollKind,
} from "@convex/lib/payroll";
import { convert } from "@convex/lib/runway";
import { liveOfPay, payrollByMonth, type PayrollReads } from "@/lib/budget/live";

type Unknown = Extract<Live, { kind: "unknown" }>["reason"];
const known = (amount: number): Live => ({ kind: "known", amount });
const unknown = (reason: Unknown): Live => ({ kind: "unknown", reason });
const usable = (fx: number | null): fx is number => fx !== null && Number.isFinite(fx) && fx > 0;

// ── One company ─────────────────────────────────────────────────────────────

/**
 * Each kind's part of this month's payroll total cost, in the company's
 * currency: from the month's frozen totals when it was marked paid, else from
 * payroll's own `summarise` over today's people and rates. Hidden without the
 * Payroll page (nothing was asked for), loading until every read is in.
 */
export function payrollByKind(input: {
  /** "YYYY-MM" */
  month: string;
  holds: boolean;
  reads: PayrollReads;
  currency: Currency;
  fx: number | null;
}): Record<PayrollKind, Live> {
  const { month, holds, reads, currency, fx } = input;
  const each = (figure: (kind: PayrollKind) => Live) =>
    Object.fromEntries(PAYROLL_KINDS.map((kind) => [kind, figure(kind)])) as Record<PayrollKind, Live>;
  if (!holds) return each(() => ({ kind: "hidden" }));
  const { people, lines, runs } = reads;
  if (people === undefined || lines === undefined || runs === undefined) return each(() => ({ kind: "loading" }));

  /** Amounts in several currencies as one in the company's, or not known for want of a rate. */
  const inCurrency = (parts: { currency: Currency; amount: number }[]): Live => {
    let sum = 0;
    for (const part of parts) {
      const amount = convert(part.amount, part.currency, currency, fx);
      if (amount === null) return unknown("no_rate");
      sum += amount;
    }
    return known(sum);
  };

  const paid = runs.find((run) => run.status === "paid" && run.month.slice(0, 7) === month);
  if (paid !== undefined) {
    return each((kind) => {
      const sets = paid.totals.map((set) => ({ currency: set.currency, totals: set.byKind[kind] }));
      if (sets.some((set) => set.totals.notComputed > 0)) return unknown("rates");
      return inCurrency(
        sets
          .filter((set) => set.totals.people > 0 || set.totals.cost > 0)
          .map((set) => ({ currency: set.currency, amount: set.totals.cost })),
      );
    });
  }
  let summary: CurrencySummary[];
  try {
    summary = paySummary({ people, lines, month: firstDayOf(month), companyCurrency: currency });
  } catch {
    // Lines that subtract each other in a circle: payroll's own word for it.
    return each(() => unknown("circle"));
  }
  return each((kind) => {
    const sets = summary.map((set) => ({ currency: set.currency, totals: set.byKind[kind] }));
    if (sets.some((set) => !isWhole(set.totals.cost, set.totals))) return unknown("rates");
    return inCurrency(
      sets.filter((set) => set.totals.people > 0).map((set) => ({ currency: set.currency, amount: set.totals.cost.sum })),
    );
  });
}

/** A cost line as `costs.list` returns it, as far as this needs. */
export type CostLineRow = CostLine & { id: string; name: string };

/** A line in a category's run-rate: its monthly equivalent in its own currency. */
export type LineRow = {
  id: string;
  name: string;
  company: CompanyId;
  category: CostCategory;
  cadence: CostCadence;
  currency: Currency;
  monthly: number;
  /** An estimate ("≈"). */
  variable: boolean;
};

/** What one company's registers come to this month, as far as the viewer may know them. */
export type CompanyCosts = {
  company: CompanyId;
  currency: Currency;
  payroll: { total: Live; byKind: Record<PayrollKind, Live> };
  register:
    | { kind: "hidden" }
    | { kind: "loading" }
    | {
        kind: "known";
        /** The categories with a run-rate this month, in the company's currency. */
        runRate: Partial<Record<CostCategory, Live>>;
        /** What the register has fall due this month, every category. */
        cashDue: Live;
        lines: Omit<LineRow, "company">[];
      };
};

/** A company's costs once every read is in: what `allCosts` merges. */
export type LoadedCosts = CompanyCosts & { register: Exclude<CompanyCosts["register"], { kind: "loading" }> };

/** Whether nothing of a company's costs is still on its way. */
export const isLoaded = (c: CompanyCosts): c is LoadedCosts =>
  c.payroll.total.kind !== "loading" && c.register.kind !== "loading";

/**
 * One company's Payroll and cost register this month, in its own currency.
 * `costLines` is what `costs.list` returned (undefined while it loads); the
 * payroll reads are `listPeople` / `listLines` / `listRuns`'. Neither is read
 * for a viewer who does not hold its page.
 */
export function companyCosts(input: {
  company: CompanyId;
  /** "YYYY-MM" */
  month: string;
  fx: number | null;
  holdsPayroll: boolean;
  holdsCosts: boolean;
  payroll: PayrollReads;
  costLines: readonly CostLineRow[] | undefined;
}): CompanyCosts {
  const { company, month, fx, holdsPayroll, holdsCosts, costLines } = input;
  const currency = MARKET_CURRENCY[company];
  const pay = { months: [month], holds: holdsPayroll, reads: input.payroll, currency, fx };
  const payroll = {
    total: liveOfPay(payrollByMonth(pay).get(month)!),
    byKind: payrollByKind({ month, holds: holdsPayroll, reads: input.payroll, currency, fx }),
  };
  if (!holdsCosts) return { company, currency, payroll, register: { kind: "hidden" } };
  if (costLines === undefined) return { company, currency, payroll, register: { kind: "loading" } };

  const summary = costSummary({ lines: costLines, month, companyCurrency: currency, fxUsdKzt: fx });
  const runRate: Partial<Record<CostCategory, Live>> = {};
  for (const [category, amount] of Object.entries(runRateByCategory(summary.currencies, currency, fx))) {
    runRate[category as CostCategory] = amount === null || amount === undefined ? unknown("no_rate") : known(amount);
  }
  const cashDue = addLive(Object.values(cashDueLive(costLines, month, currency, fx)));
  const lines = costLines
    .filter((line) => runRateOf(line, month) > 0)
    .map((line) => ({
      id: line.id,
      name: line.name,
      category: line.category,
      cadence: line.cadence,
      currency: line.currency,
      monthly: runRateOf(line, month),
      variable: line.variable,
    }));
  return { company, currency, payroll, register: { kind: "known", runRate, cashDue, lines } };
}

// ── Adding ──────────────────────────────────────────────────────────────────

/**
 * What figures add up to (never none: a register's categories, a lens's rows
 * from Payroll down): a hidden one is left out (the caller names it), a
 * loading one makes the sum loading, one not known makes it not known. With
 * every figure hidden there is nothing to add: hidden.
 */
function addLive(figures: readonly Live[]): Live {
  const shown = figures.filter((figure) => figure.kind !== "hidden");
  if (shown.length === 0) return { kind: "hidden" };
  if (shown.some((figure) => figure.kind === "loading")) return { kind: "loading" };
  const gap = shown.find((figure) => figure.kind === "unknown");
  if (gap !== undefined) return gap;
  return known(shown.reduce((sum, figure) => sum + (figure as { amount: number }).amount, 0));
}

/** Globex's tenge in dollar cents at the rate; nothing needs no rate. Null where it cannot be said. */
function kzInUsd(figure: Live | undefined, fx: number | null): number | null {
  if (figure?.kind !== "known") return null;
  if (figure.amount === 0) return 0;
  return usable(fx) ? kztToUsd(figure.amount, fx) : null;
}

/**
 * The group's figure in dollars: Startup's plus Globex's at the rate. Short
 * of both known, and of a rate where tenge needs one, it is not a sum.
 */
function groupOf(us: Live, kz: Live, fx: number | null): Live {
  for (const kind of ["hidden", "loading"] as const) {
    if (us.kind === kind || kz.kind === kind) return { kind };
  }
  if (us.kind === "unknown") return us;
  if (kz.kind === "unknown") return kz;
  const converted = kzInUsd(kz, fx);
  if (converted === null) return unknown("no_rate");
  return known((us as { amount: number }).amount + converted);
}

const times = (figure: Live, by: number): Live => (figure.kind === "known" ? known(figure.amount * by) : figure);

// ── The lens ────────────────────────────────────────────────────────────────

export type Lens = "group" | CompanyId;

/** Payroll, a Costs category, or the whole register for a viewer who does not hold it. */
export type RowKey = "payroll" | CostCategory | "costs";

export const ROW_LABELS: Record<RowKey, string> = { payroll: "Payroll", costs: "Registered costs", ...CATEGORY_LABELS };

/** A figure in each of the lens's columns. */
export type Figures = {
  /** Each company's own, in its own currency. */
  own: Partial<Record<CompanyId, Live>>;
  /** Globex's in dollar cents at the stored rate; null where there is no rate or no figure. */
  kzUsd: number | null;
  /** The lens's: the group's in dollars, or the one company's own. */
  main: Live;
};

export type KindRow = Figures & { kind: PayrollKind };

/** A line as the lens reads it: in the lens's currency (the group's dollars), and its share. */
export type LensLine = LineRow & {
  /** Its monthly equivalent in the lens's currency; null with no rate to get there. */
  main: number | null;
  /** Of the lens's monthly total; null where either is not known. */
  share: number | null;
};

export type Row = Figures & {
  key: RowKey;
  /** Of the lens's monthly total; null where either is not known. */
  share: number | null;
  /** Payroll's employees and contractors; null on every other row, and when Payroll is hidden. */
  kinds: KindRow[] | null;
  /** A category's lines in its run-rate, the largest first; empty for Payroll. */
  lines: LensLine[];
};

/** Why a figure is not known, said once: whose, which register (or the rate), and the reason. */
export type Gap = { company: CompanyId | null; what: Register | "fx"; reason: Unknown };

/** The fixed order of the composition chart, and its one fold. */
export const CHART_SLOTS = ["payroll", "services", "office", "cloud", "software", "rest"] as const;
export type Slot = (typeof CHART_SLOTS)[number];
/** The categories folded into the chart's last slot, "Other costs". */
export const FOLDED: readonly CostCategory[] = ["marketing", "travel", "taxes_fees", "other"];
const slotOf = (key: RowKey): Slot => (FOLDED.includes(key as CostCategory) ? "rest" : (key as Slot));

export type Segment = { slot: Slot; value: number; share: number; parts: RowKey[] };
export type Chart =
  | { kind: "drawn"; segments: Segment[]; total: number }
  /** `not_known`: a part is not known; `too_few`: one piece; `nothing`: nothing to compose. */
  | { kind: "not_drawn"; reason: "not_known" | "too_few" | "nothing" };

export type AllCosts = {
  lens: Lens;
  /** The companies in the lens, Startup first. */
  companies: CompanyId[];
  /** The lens's own currency: dollars for the group. */
  currency: Currency;
  fx: number | null;
  /** The registers the viewer does not hold: left out of every total. */
  excludes: Register[];
  /** Payroll, then each category with a run-rate, in the register's order. */
  rows: Row[];
  /** Payroll's total cost plus the register's run-rate: the table's total. */
  monthly: Figures;
  /** Monthly costs × 12. */
  yearly: Figures;
  /** Payroll plus what the register has fall due this month. */
  cashDue: Figures;
  /** The group's only: each company's part of monthly costs, in dollars, and its share. */
  split: { company: CompanyId; usd: number; share: number }[] | null;
  chart: Chart;
  gaps: Gap[];
};

/**
 * Every recurring cost of the companies in the lens, merged by category. The
 * group (both companies) is in dollars, Globex's tenge at `fx`; a company
 * lens is in the company's own currency, with Globex's dollars alongside
 * where a rate is on record.
 */
export function allCosts(input: { lens: Lens; companies: readonly LoadedCosts[]; fx: number | null }): AllCosts {
  const { lens, fx } = input;
  const group = lens === "group";
  const companies = input.companies.filter((c) => group || c.company === lens);
  const ids = companies.map((c) => c.company);

  /** One row's figures from each company's own. */
  const figuresOf = (own: Partial<Record<CompanyId, Live>>): Figures => ({
    own,
    kzUsd: ids.includes("kz") ? kzInUsd(own.kz, fx) : null,
    main: group ? groupOf(own.us!, own.kz!, fx) : own[lens as CompanyId]!,
  });
  const ownOf = (figure: (c: LoadedCosts) => Live) =>
    Object.fromEntries(companies.map((c) => [c.company, figure(c)])) as Partial<Record<CompanyId, Live>>;

  const registers = companies.flatMap((c) => (c.register.kind === "known" ? [{ company: c.company, ...c.register }] : []));
  const registerOf = (company: CompanyId) => registers.find((r) => r.company === company)!;
  const holdsCosts = registers.length === companies.length;
  const payrollHidden = companies.every((c) => c.payroll.total.kind === "hidden");
  const excludes = REGISTERS.filter((r) => (r === "payroll" ? payrollHidden : !holdsCosts));

  const categories = holdsCosts
    ? COST_CATEGORIES.filter((category) => registers.some((r) => r.runRate[category] !== undefined))
    : [];
  const lensCurrency: Currency = group ? "USD" : MARKET_CURRENCY[lens as CompanyId];
  const rowsUnshared: (Omit<Row, "share" | "lines"> & { lines: LineRow[] })[] = [
    {
      key: "payroll",
      ...figuresOf(ownOf((c) => c.payroll.total)),
      kinds: payrollHidden
        ? null
        : PAYROLL_KINDS.map((kind) => ({ kind, ...figuresOf(ownOf((c) => c.payroll.byKind[kind])) })),
      lines: [],
    },
    ...(holdsCosts
      ? categories.map((category) => ({
          key: category as RowKey,
          ...figuresOf(ownOf((c) => registerOf(c.company).runRate[category] ?? known(0))),
          kinds: null,
          lines: registers.flatMap((r) =>
            r.lines.filter((line) => line.category === category).map((line) => ({ ...line, company: r.company })),
          ),
        }))
      : [{ key: "costs" as RowKey, ...figuresOf(ownOf(() => ({ kind: "hidden" }))), kinds: null, lines: [] }]),
  ];
  /** A column's total over the rows. */
  const sumOf = (figure: (row: Figures) => Live) => addLive(rowsUnshared.map(figure));
  /** Globex's dollars over the rows it has a figure in; none where one is missing. */
  const kzUsdSum = (rows: readonly Figures[]): number | null => {
    const shown = rows.filter((row) => row.own.kz?.kind !== "hidden");
    if (shown.length === 0 || shown.some((row) => row.kzUsd === null)) return null;
    return shown.reduce((sum, row) => sum + row.kzUsd!, 0);
  };
  const monthly: Figures = {
    own: Object.fromEntries(ids.map((id) => [id, sumOf((row) => row.own[id]!)])),
    kzUsd: kzUsdSum(rowsUnshared),
    main: sumOf((row) => row.main),
  };
  const yearly: Figures = {
    own: Object.fromEntries(ids.map((id) => [id, times(monthly.own[id]!, 12)])),
    kzUsd: monthly.kzUsd === null ? null : monthly.kzUsd * 12,
    main: times(monthly.main, 12),
  };
  const cashDue = figuresOf(
    ownOf((c) => addLive([c.payroll.total, c.register.kind === "known" ? c.register.cashDue : c.register])),
  );

  const total = monthly.main.kind === "known" && monthly.main.amount > 0 ? monthly.main.amount : null;
  const shareOf = (amount: number | null) => (total !== null && amount !== null ? amount / total : null);
  const rows: Row[] = rowsUnshared.map((row) => ({
    ...row,
    share: shareOf(row.main.kind === "known" ? row.main.amount : null),
    lines: row.lines
      .map((line) => {
        const main = convert(line.monthly, line.currency, lensCurrency, fx);
        return { ...line, main, share: shareOf(main) };
      })
      .sort((a, b) => (a.main === null ? 1 : 0) - (b.main === null ? 1 : 0) || (b.main ?? 0) - (a.main ?? 0) || a.name.localeCompare(b.name)),
  }));

  const split =
    group && total !== null && monthly.own.us?.kind === "known" && monthly.kzUsd !== null
      ? [
          { company: "us" as const, usd: monthly.own.us.amount, share: monthly.own.us.amount / total },
          { company: "kz" as const, usd: monthly.kzUsd, share: monthly.kzUsd / total },
        ]
      : null;

  return {
    lens,
    companies: ids,
    currency: lensCurrency,
    fx,
    excludes,
    rows,
    monthly,
    yearly,
    cashDue,
    split,
    chart: chartOf(rows, monthly.main),
    gaps: gapsOf(companies, rows, group, fx),
  };
}

/** The composition: each slot's sum, in the fixed order, once every part shown is known. */
function chartOf(rows: readonly Row[], total: Live): Chart {
  const shown = rows.filter((row) => row.main.kind !== "hidden");
  if (shown.length === 0) return { kind: "not_drawn", reason: "nothing" };
  // A total is known only when every figure shown is.
  if (total.kind !== "known") return { kind: "not_drawn", reason: "not_known" };
  if (total.amount === 0) return { kind: "not_drawn", reason: "nothing" };
  const segments = CHART_SLOTS.flatMap((slot): Segment[] => {
    const members = shown.filter((row) => slotOf(row.key) === slot && (row.main as { amount: number }).amount > 0);
    const value = members.reduce((sum, row) => sum + (row.main as { amount: number }).amount, 0);
    return value > 0 ? [{ slot, value, share: value / total.amount, parts: members.map((row) => row.key) }] : [];
  });
  if (segments.length < 2) return { kind: "not_drawn", reason: "too_few" };
  return { kind: "drawn", segments, total: total.amount };
}

/** Each reason a figure in view is not known, once: Payroll's, the register's, the group's rate. */
function gapsOf(companies: readonly LoadedCosts[], rows: readonly Row[], group: boolean, fx: number | null): Gap[] {
  const gaps: Gap[] = [];
  for (const c of companies) {
    if (c.payroll.total.kind === "unknown") gaps.push({ company: c.company, what: "payroll", reason: c.payroll.total.reason });
    if (c.register.kind !== "known") continue;
    const gap = [...Object.values(c.register.runRate), c.register.cashDue].find((figure) => figure.kind === "unknown");
    if (gap?.kind === "unknown") gaps.push({ company: c.company, what: "costs", reason: gap.reason });
  }
  // The group needs a rate only where tenge is to be added.
  if (group && !usable(fx) && rows.some((row) => row.own.kz?.kind === "known" && row.own.kz.amount !== 0)) {
    gaps.push({ company: null, what: "fx", reason: "no_rate" });
  }
  return gaps;
}

// ── Sorting, kept in the address ────────────────────────────────────────────

export type SortKey = "category" | CompanyId | "group" | "share";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

const SORT_PARAM = "costs-sort";
const DIR_PARAM = "costs-dir";

/** The lens's own figure's column: the group's, or the one company's. */
const mainKey = (lens: Lens): SortKey => lens;
const keysOf = (lens: Lens): SortKey[] =>
  lens === "group" ? ["category", "us", "kz", "group", "share"] : ["category", lens, "share"];

/** The lens's figure, the largest first, unless the address says otherwise. */
export function readSort(params: URLSearchParams, lens: Lens): Sort {
  const key = params.get(SORT_PARAM) as SortKey | null;
  if (key === null || !keysOf(lens).includes(key)) return { key: mainKey(lens), dir: "desc" };
  return { key, dir: params.get(DIR_PARAM) === "asc" ? "asc" : "desc" };
}

/** The address with this sort in it, and everything else that was there kept. The default writes nothing. */
export function writeSort(params: URLSearchParams, sort: Sort, lens: Lens): string {
  const next = new URLSearchParams(params);
  next.delete(SORT_PARAM);
  next.delete(DIR_PARAM);
  if (sort.key !== mainKey(lens) || sort.dir !== "desc") {
    next.set(SORT_PARAM, sort.key);
    next.set(DIR_PARAM, sort.dir);
  }
  return next.toString();
}

/** What a click on a column asks for: a figure the largest first, a name from A; then the other way. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "category" ? "asc" : "desc" };
}

const ORDER: readonly RowKey[] = ["payroll", ...COST_CATEGORIES, "costs"];

/**
 * The rows in order. A figure that is not known (or not shown) is last either
 * way round; equal figures keep the register's order. By share is by the
 * lens's own figure.
 */
export function sortRows<T extends Row>(rows: readonly T[], sort: Sort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const fixed = (a: T, b: T) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key);
  if (sort.key === "category") {
    return [...rows].sort((a, b) => sign * ROW_LABELS[a.key].localeCompare(ROW_LABELS[b.key]) || fixed(a, b));
  }
  const key = sort.key;
  const figure = (row: T): Live =>
    key === "group" || key === "share" ? row.main : (row.own[key] ?? { kind: "hidden" });
  return [...rows].sort((a, b) => {
    const x = figure(a);
    const y = figure(b);
    if (x.kind !== "known" || y.kind !== "known") {
      return (x.kind === "known" ? 0 : 1) - (y.kind === "known" ? 0 : 1) || fixed(a, b);
    }
    return sign * (x.amount - y.amount) || fixed(a, b);
  });
}
