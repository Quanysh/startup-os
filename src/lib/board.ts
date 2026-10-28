// Pure board arithmetic, shared by the drag-and-drop component and by the
// optimistic updates that keep a card where it was dropped while the server
// confirms.

/**
 * Where a card dropped on `overId` should land. `overId` is either another
 * card (take its place) or a column (go to its end). Returns null when the
 * drop is on nothing the board knows.
 */
export function dropTarget(
  columns: Readonly<Record<string, readonly string[]>>,
  activeId: string,
  overId: string,
): { column: string; index: number } | null {
  const column = columns[overId];
  if (column !== undefined) {
    return { column: overId, index: column.filter((id) => id !== activeId).length };
  }
  for (const [name, ids] of Object.entries(columns)) {
    const index = ids.indexOf(overId);
    if (index !== -1) return { column: name, index };
  }
  return null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Where an arrow key sends a card: up or down one place in its column, or
 * left or right into the neighbouring column at the same row (last, if that
 * column is shorter). Returns null when the key would move it nowhere.
 *
 * `unordered` names columns that sort themselves (the task board's "Done",
 * by finish time). Up and down do nothing there, and a card entering one
 * goes to the top.
 */
export function keyboardMove(
  columnOrder: readonly string[],
  columns: Readonly<Record<string, readonly string[]>>,
  id: string,
  key: string,
  unordered: ReadonlySet<string> = NONE,
): { column: string; index: number } | null {
  const at = columnOrder.findIndex((column) => columns[column]?.includes(id));
  if (at === -1) return null;
  const column = columnOrder[at]!;
  const ids = columns[column]!;
  const index = ids.indexOf(id);

  if (key === "ArrowUp" || key === "ArrowDown") {
    if (unordered.has(column)) return null;
    const next = index + (key === "ArrowUp" ? -1 : 1);
    return next >= 0 && next < ids.length ? { column, index: next } : null;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const neighbour = columnOrder[at + (key === "ArrowLeft" ? -1 : 1)];
  if (neighbour === undefined) return null;
  if (unordered.has(neighbour)) return { column: neighbour, index: 0 };
  return { column: neighbour, index: Math.min(index, columns[neighbour]?.length ?? 0) };
}

/**
 * Turn where a card was dropped into the move to report, or null when
 * nothing should happen: the card is back where it started, or it was
 * dropped within a column that keeps its own order.
 */
export function settleDrop(
  settled: Readonly<Record<string, readonly string[]>>,
  id: string,
  target: { column: string; index: number },
  unordered: ReadonlySet<string> = NONE,
): { column: string; index: number } | null {
  const from = Object.keys(settled).find((column) => settled[column]!.includes(id));
  if (from === undefined) return null;
  if (unordered.has(target.column)) {
    return from === target.column ? null : { column: target.column, index: 0 };
  }
  const unchanged = from === target.column && settled[from]!.indexOf(id) === target.index;
  return unchanged ? null : target;
}

/**
 * A copy of the board with one card moved to `index` in `column`. Returns the
 * board unchanged (same reference) when the card or the column is not on it.
 * `change` can adjust the moved card, e.g. to stamp its new column.
 */
export function moveOnBoard<T extends { id: string }, B extends Record<string, T[]>>(
  board: B,
  id: string,
  column: string,
  index: number,
  change: (card: T) => T = (card) => card,
): B {
  if (!(column in board)) return board;
  let moved: T | undefined;
  const next: Record<string, T[]> = {};
  for (const [name, cards] of Object.entries(board)) {
    moved ??= cards.find((card) => card.id === id);
    next[name] = cards.filter((card) => card.id !== id);
  }
  if (moved === undefined) return board;

  const target = next[column]!;
  const at = Math.min(Math.max(index, 0), target.length);
  next[column] = [...target.slice(0, at), change(moved), ...target.slice(at)];
  return next as B;
}
