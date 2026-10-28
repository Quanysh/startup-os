import { describe, expect, test } from "vitest";
import { ariaSort, nextSort, rowsInStages, sortRows } from "./table-sort";

type Row = { name: string; n: number | null };
const rows: Row[] = [
  { name: "b", n: 2 },
  { name: "A", n: null },
  { name: "c", n: 1 },
];
const value = (row: Row, key: "name" | "n") => (key === "name" ? row.name : row.n);

describe("sortRows", () => {
  test("no sort keeps the order given", () => {
    expect(sortRows(rows, null, value).map((r) => r.name)).toEqual(["b", "A", "c"]);
  });
  test("text ignores capitals; a blank sorts last whichever way", () => {
    expect(sortRows(rows, { key: "name", dir: "asc" }, value).map((r) => r.name)).toEqual(["A", "b", "c"]);
    expect(sortRows(rows, { key: "n", dir: "asc" }, value).map((r) => r.name)).toEqual(["c", "b", "A"]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, value).map((r) => r.name)).toEqual(["b", "c", "A"]);
  });
});

describe("nextSort and ariaSort", () => {
  test("ascending first, then the other way; another column starts ascending", () => {
    expect(nextSort(null, "n")).toEqual({ key: "n", dir: "asc" });
    expect(nextSort({ key: "n", dir: "asc" }, "n")).toEqual({ key: "n", dir: "desc" });
    expect(nextSort({ key: "n", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(ariaSort({ key: "n", dir: "desc" }, "n")).toBe("descending");
    expect(ariaSort({ key: "n", dir: "desc" }, "name")).toBe("none");
  });
});

describe("rowsInStages", () => {
  test("the stages in the order given, then nothing else", () => {
    const board = { b: [2], a: [1], z: [9] };
    expect(rowsInStages(board, ["a", "b", "missing"])).toEqual([1, 2]);
  });
});
