import { describe, expect, test } from "vitest";
import { columnsFor, masonryLayout } from "./masonry";

describe("masonry: each block to the shorter column, both ending flush", () => {
  test("a short block then two tall ones: the third goes under the short one, and the last of each column fills to the same bottom", () => {
    const { placements, height } = masonryLayout([100, 400, 300], 2, 24);
    expect(placements[0]).toMatchObject({ column: 0, top: 0 });
    expect(placements[1]).toMatchObject({ column: 1, top: 0 });
    expect(placements[2]).toMatchObject({ column: 0, top: 124 });
    expect(height).toBe(424);
    // Column 0 ends at 424 (124 + 300); column 1 at 400: its last block fills by 24.
    expect(placements[1]!.fill).toBe(424);
    expect(placements[2]!.fill).toBe(300);
    expect(placements[0]!.fill).toBeNull();
  });

  test("blocks that drew nothing take no place", () => {
    const { placements, height } = masonryLayout([0, 200, 0, 100], 2, 24);
    expect(placements[0]).toBeNull();
    expect(placements[2]).toBeNull();
    expect(placements[1]).toMatchObject({ column: 0, top: 0, fill: 200 });
    expect(placements[3]).toMatchObject({ column: 1, top: 0, fill: 200 });
    expect(height).toBe(200);
  });

  test("three columns of one block each all end flush", () => {
    const { placements } = masonryLayout([150, 220, 90], 3, 16);
    expect(placements.map((p) => [p!.column, p!.fill])).toEqual([
      [0, 220],
      [1, 220],
      [2, 220],
    ]);
  });

  test("one column: a plain stack, nothing filled", () => {
    const { placements, height } = masonryLayout([100, 50], 1, 24);
    expect(placements.map((p) => [p!.top, p!.fill])).toEqual([
      [0, null],
      [124, null],
    ]);
    expect(height).toBe(174);
  });
});

describe("how many columns a width holds", () => {
  test("as many as fit at the narrowest width, never more than asked, never fewer than one", () => {
    expect(columnsFor(940, { minColumnWidth: 440, maxColumns: 2, gap: 24 })).toBe(2);
    expect(columnsFor(800, { minColumnWidth: 440, maxColumns: 2, gap: 24 })).toBe(1);
    expect(columnsFor(1200, { minColumnWidth: 320, maxColumns: 3, gap: 16 })).toBe(3);
    expect(columnsFor(700, { minColumnWidth: 320, maxColumns: 3, gap: 16 })).toBe(2);
    expect(columnsFor(0, { minColumnWidth: 320, maxColumns: 3, gap: 16 })).toBe(1);
  });
});
