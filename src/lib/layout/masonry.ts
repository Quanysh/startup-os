// A masonry layout for a few panels of different heights: each panel goes
// under the column that ends highest (left first on a tie), and the last
// panel of every column is stretched so all columns end at the same line, so
// neither a short panel beside a tall one nor the end of the section leaves a
// hole. Pure: heights in, positions out (src/components/masonry.tsx measures
// and places).

export type Placement = {
  column: number;
  top: number;
  /** The panel's height when it is stretched to end flush; null when it keeps its own. */
  fill: number | null;
};

/**
 * Where each panel goes. A height of 0 is a panel that drew nothing: it takes
 * no place (null). `height` is the whole layout's.
 */
export function masonryLayout(
  heights: readonly number[],
  columns: number,
  gap: number,
): { placements: (Placement | null)[]; height: number } {
  const count = Math.max(1, columns);
  const bottoms = Array.from({ length: count }, () => 0);
  const used = Array.from({ length: count }, () => false);
  const last: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  const placements: (Placement | null)[] = heights.map((height, index) => {
    if (height <= 0) return null;
    const column = bottoms.indexOf(Math.min(...bottoms));
    const top = used[column] ? bottoms[column]! + gap : 0;
    bottoms[column] = top + height;
    used[column] = true;
    last[column] = index;
    return { column, top, fill: null };
  });
  const height = Math.max(0, ...bottoms);
  // In one column there is nothing to end flush with.
  if (count > 1) {
    for (const index of last) {
      const placement = index === undefined ? null : placements[index];
      if (placement) placement.fill = height - placement.top;
    }
  }
  return { placements, height };
}

/** How many columns a width holds: as many as fit at `minColumnWidth`, at most `maxColumns`, at least one. */
export function columnsFor(
  width: number,
  { minColumnWidth, maxColumns, gap }: { minColumnWidth: number; maxColumns: number; gap: number },
): number {
  return Math.min(maxColumns, Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))));
}
