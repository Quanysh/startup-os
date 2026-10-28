// What every pipeline table shares: sorting the rows a board already sent,
// in the browser, by a column a header names. The sales table
// (`table-view.ts`) and the investor table (`src/lib/fundraising/table-view.ts`)
// each say how their columns read a row; the order itself is worked out here.

import { daysSince } from "@/lib/pipeline/derive";

/** A pipeline shown as a table or as the board. */
export type PipelineLayout = "table" | "board";

/** null: the board's order (stage by stage, each column as arranged). */
export type Sort<K extends string> = { key: K; dir: "asc" | "desc" } | null;

/** What a column reads from a row; null sorts last whichever way. */
export type SortValue = string | number | readonly [number, number] | null;

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

function compare(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (typeof a === "string" && typeof b === "string") return byText(a, b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  const [a1, a2] = a as readonly [number, number];
  const [b1, b2] = b as readonly [number, number];
  return a1 - b1 || a2 - b2;
}

/** The rows in order. Unsorted is the order given; ties keep it too. */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: Sort<K>,
  valueOf: (row: T, key: K) => SortValue,
): T[] {
  if (sort === null) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      }
      return sign * compare(a.value, b.value) || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** What a click on a column's header asks for: ascending first, then the other way. */
export function nextSort<K extends string>(current: Sort<K>, key: K): Sort<K> {
  return current?.key === key && current.dir === "asc" ? { key, dir: "desc" } : { key, dir: "asc" };
}

/** A header's `aria-sort`. */
export function ariaSort<K extends string>(sort: Sort<K>, key: K): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** Every card of a board in the stages given, in that order. */
export function rowsInStages<T>(
  board: Readonly<Record<string, readonly T[]>>,
  stages: readonly string[],
): T[] {
  return stages.flatMap((stage) => board[stage] ?? []);
}

/** "Today", "Yesterday", "9 days ago". */
export function lastActivityLabel(at: number, now: number): string {
  const days = daysSince(now, at);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
