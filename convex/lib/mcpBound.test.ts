import { describe, expect, test } from "vitest";
import { bound } from "./mcpBound";

const rows = (count: number, size = 1) =>
  Array.from({ length: count }, (_, n) => ({ n, pad: "x".repeat(size) }));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("bound", () => {
  test("an answer within its caps is returned whole, and says so", () => {
    const output = { readAt: 5, rows: rows(3) };
    expect(bound(output, { rows: 10, bytes: 10_000 })).toEqual({ ...output, truncated: false });
  });

  test("a list over the row cap loses its last rows", () => {
    const cut = bound({ rows: rows(10) }, { rows: 4, bytes: 10_000 });
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toEqual(rows(4));
  });

  test("the row cap is for all the lists together, spent in their order", () => {
    const cut = bound({ a: rows(3), b: rows(3), c: rows(3) }, { rows: 5, bytes: 10_000 });
    expect([(cut.a as unknown[]).length, (cut.b as unknown[]).length, (cut.c as unknown[]).length]).toEqual([
      3, 2, 0,
    ]);
    expect(cut.truncated).toBe(true);
  });

  test("a board's columns are lists too: an object whose every value is one", () => {
    const cut = bound({ us: { lead: rows(4), won: rows(4) }, note: "kept" }, { rows: 6, bytes: 10_000 });
    expect(cut).toEqual({ us: { lead: rows(4), won: rows(2) }, note: "kept", truncated: true });
  });

  test("an answer over the byte cap is cut, longest list first, until it fits", () => {
    const output = { short: rows(2, 100), long: rows(40, 100) };
    const cap = 2_000;
    const cut = bound(output, { rows: 1_000, bytes: cap });
    expect(cut.truncated).toBe(true);
    const { truncated: _flag, ...rest } = cut;
    expect(bytes(rest)).toBeLessThanOrEqual(cap);
    expect((cut.long as unknown[]).length).toBeLessThan(40);
    expect((cut.long as unknown[]).length).toBeGreaterThan(0);
    // What is kept is the start of the list, in order.
    expect(cut.long).toEqual(rows(40, 100).slice(0, (cut.long as unknown[]).length));
  });

  test("it ends even when nothing in a list is left to cut", () => {
    const cut = bound({ note: "n".repeat(500), rows: rows(3) }, { rows: 10, bytes: 100 });
    expect(cut.rows).toEqual([]);
    expect(cut.truncated).toBe(true);
  });

  test("what it is given is not changed", () => {
    const columns = { lead: rows(5) };
    const output = { us: columns, rows: rows(5) };
    bound(output, { rows: 2, bytes: 10_000 });
    expect(output.rows).toHaveLength(5);
    expect(columns.lead).toHaveLength(5);
  });
});
