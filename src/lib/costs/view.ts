// The costs table's view: which category is shown and how the rows are
// ordered. Worked out in the browser on the rows already there, and kept in
// the address (`readView` / `writeView`), never in component state.

import {
  COST_CATEGORIES,
  monthlyEquivalent,
  type CostCategory,
  type CostLine,
} from "@convex/lib/costs";
import type { Currency } from "@convex/lib/metricRegistry";

export type SortKey = "name" | "category" | "monthly";
const SORT_KEYS: readonly SortKey[] = ["name", "category", "monthly"];
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;
export type View = { category: CostCategory | null; sort: Sort };

type Row = CostLine & { name: string };

const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const byCategory = (a: Row, b: Row) =>
  COST_CATEGORIES.indexOf(a.category) - COST_CATEGORIES.indexOf(b.category);
const byMonthly = (a: Row, b: Row) => monthlyEquivalent(a) - monthlyEquivalent(b);

const COMPARE: Record<SortKey, (a: Row, b: Row) => number> = {
  name: byName,
  category: byCategory,
  monthly: byMonthly,
};

/**
 * The rows in order. Unsorted, by category then name. By monthly equivalent
 * the currencies stay apart, in the order they first appear: a tenge amount
 * is never ranked against a dollar one.
 */
export function sortLines<T extends Row>(rows: readonly T[], sort: Sort): T[] {
  if (sort === null) return [...rows].sort((a, b) => byCategory(a, b) || byName(a, b));
  const sign = sort.dir === "asc" ? 1 : -1;
  const compare = COMPARE[sort.key];
  if (sort.key !== "monthly") return [...rows].sort((a, b) => sign * compare(a, b) || byName(a, b));
  const order = [...new Set(rows.map((row) => row.currency))];
  return [...rows].sort(
    (a, b) =>
      order.indexOf(a.currency) - order.indexOf(b.currency) || sign * compare(a, b) || byName(a, b),
  );
}

export function filterLines<T extends Row>(rows: readonly T[], category: CostCategory | null): T[] {
  return category === null ? [...rows] : rows.filter((row) => row.category === category);
}

/** The rows' monthly equivalents, added per currency. One is never added to another. */
export function totalsOf(rows: readonly Row[]): { currency: Currency; monthly: number }[] {
  const sums = new Map<Currency, number>();
  for (const row of rows) sums.set(row.currency, (sums.get(row.currency) ?? 0) + monthlyEquivalent(row));
  return [...sums].map(([currency, monthly]) => ({ currency, monthly }));
}

/** What a click on a column's header asks for: ascending first, then the other way. */
export function nextSort(current: Sort, key: SortKey): Sort {
  return current?.key === key && current.dir === "asc" ? { key, dir: "desc" } : { key, dir: "asc" };
}

/** A header's `aria-sort`. */
export function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

export function readView(params: URLSearchParams): View {
  const category = params.get("category");
  const key = params.get("sort");
  return {
    category: COST_CATEGORIES.includes(category as CostCategory) ? (category as CostCategory) : null,
    sort: SORT_KEYS.includes(key as SortKey)
      ? { key: key as SortKey, dir: params.get("dir") === "desc" ? "desc" : "asc" }
      : null,
  };
}

export function writeView({ category, sort }: View): string {
  const params = new URLSearchParams();
  if (category !== null) params.set("category", category);
  if (sort !== null) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  return params.toString();
}

/** The month where the user is, as the costs functions take it: "YYYY-MM". */
export function costMonthOf(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
