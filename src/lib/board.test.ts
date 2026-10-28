import { describe, expect, test } from "vitest";
import { dropTarget, keyboardMove, moveOnBoard, settleDrop } from "./board";

const card = (id: string) => ({ id });
const ids = (board: Record<string, { id: string }[]>) =>
  Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.map((c) => c.id)]));

const board = {
  backlog: [card("a"), card("b"), card("c")],
  doing: [card("x"), card("y")],
  done: [card("z")],
};

describe("moveOnBoard", () => {
  test("moves a card to a position in another column", () => {
    expect(ids(moveOnBoard(board, "a", "doing", 1))).toEqual({
      backlog: ["b", "c"],
      doing: ["x", "a", "y"],
      done: ["z"],
    });
  });

  test("reorders within a column", () => {
    expect(ids(moveOnBoard(board, "c", "backlog", 0)).backlog).toEqual(["c", "a", "b"]);
  });

  test("an index past the end puts the card last", () => {
    expect(ids(moveOnBoard(board, "a", "doing", 99)).doing).toEqual(["x", "y", "a"]);
  });

  test("returns the same board when the card is not on it", () => {
    expect(moveOnBoard(board, "nope", "doing", 0)).toBe(board);
  });

  test("returns the same board when the column does not exist", () => {
    expect(moveOnBoard(board, "a", "archive", 0)).toBe(board);
  });

  test("does not modify the board it was given", () => {
    moveOnBoard(board, "a", "doing", 0);
    expect(ids(board).backlog).toEqual(["a", "b", "c"]);
  });

  test("applies a change to the moved card", () => {
    const next = moveOnBoard(board, "a", "done", 0, (c) => ({ ...c, id: c.id, moved: true }));
    expect(next.done[0]).toEqual({ id: "a", moved: true });
  });
});

describe("keyboardMove", () => {
  const order = ["backlog", "doing", "done"];
  const columns = { backlog: ["a", "b", "c"], doing: ["x"], done: [] as string[] };

  test("up and down move one place within the column", () => {
    expect(keyboardMove(order, columns, "b", "ArrowUp")).toEqual({ column: "backlog", index: 0 });
    expect(keyboardMove(order, columns, "b", "ArrowDown")).toEqual({ column: "backlog", index: 2 });
  });

  test("nothing happens at the top or the bottom", () => {
    expect(keyboardMove(order, columns, "a", "ArrowUp")).toBeNull();
    expect(keyboardMove(order, columns, "c", "ArrowDown")).toBeNull();
  });

  test("right moves to the next column, keeping the row where it can", () => {
    expect(keyboardMove(order, columns, "a", "ArrowRight")).toEqual({ column: "doing", index: 0 });
    // Row 2 does not exist in a one-card column, so the card goes last.
    expect(keyboardMove(order, columns, "c", "ArrowRight")).toEqual({ column: "doing", index: 1 });
  });

  test("left moves to the previous column", () => {
    expect(keyboardMove(order, columns, "x", "ArrowLeft")).toEqual({ column: "backlog", index: 0 });
  });

  test("nothing happens past the first or last column", () => {
    expect(keyboardMove(order, columns, "a", "ArrowLeft")).toBeNull();
    expect(keyboardMove(order, { ...columns, done: ["z"] }, "z", "ArrowRight")).toBeNull();
  });

  test("other keys and unknown cards do nothing", () => {
    expect(keyboardMove(order, columns, "a", "Enter")).toBeNull();
    expect(keyboardMove(order, columns, "nope", "ArrowDown")).toBeNull();
  });
});

describe("keyboardMove with a column that is not hand-ordered", () => {
  // "Done" sorts itself by finish time, so position within it means nothing.
  const order = ["doing", "done"];
  const columns = { doing: ["a", "b"], done: ["x", "y"] };
  const unordered = new Set(["done"]);

  test("up and down do nothing inside it", () => {
    expect(keyboardMove(order, columns, "x", "ArrowDown", unordered)).toBeNull();
    expect(keyboardMove(order, columns, "y", "ArrowUp", unordered)).toBeNull();
  });

  test("a card moved into it goes to the top, whatever row it came from", () => {
    expect(keyboardMove(order, columns, "b", "ArrowRight", unordered)).toEqual({
      column: "done",
      index: 0,
    });
  });

  test("a card can still be moved out of it", () => {
    expect(keyboardMove(order, columns, "y", "ArrowLeft", unordered)).toEqual({
      column: "doing",
      index: 1,
    });
  });
});

describe("settleDrop", () => {
  const settled = { backlog: ["a", "b", "c"], doing: ["x"], done: ["z"] };
  const unordered = new Set(["done"]);

  test("a drop that changes nothing is not a move", () => {
    expect(settleDrop(settled, "b", { column: "backlog", index: 1 }, unordered)).toBeNull();
  });

  test("a new position in the same column is a move", () => {
    expect(settleDrop(settled, "b", { column: "backlog", index: 0 }, unordered)).toEqual({
      column: "backlog",
      index: 0,
    });
  });

  test("a drop within a column that is not hand-ordered is not a move", () => {
    // Otherwise the card would jump on screen and snap back when the server
    // keeps its own order.
    expect(settleDrop(settled, "z", { column: "done", index: 0 }, unordered)).toBeNull();
  });

  test("a drop into such a column always lands first", () => {
    expect(settleDrop(settled, "a", { column: "done", index: 1 }, unordered)).toEqual({
      column: "done",
      index: 0,
    });
  });

  test("a card that is not on the board is not a move", () => {
    expect(settleDrop(settled, "nope", { column: "doing", index: 0 }, unordered)).toBeNull();
  });
});

describe("dropTarget", () => {
  const columns = { backlog: ["a", "b", "c"], doing: ["x", "y"], done: [] as string[] };

  test("dropping on a card takes that card's place in its column", () => {
    expect(dropTarget(columns, "a", "y")).toEqual({ column: "doing", index: 1 });
  });

  test("dropping on a column itself puts the card at its end", () => {
    expect(dropTarget(columns, "a", "doing")).toEqual({ column: "doing", index: 2 });
    expect(dropTarget(columns, "a", "done")).toEqual({ column: "done", index: 0 });
  });

  test("dropping on a later card in the same column lands at that card's position", () => {
    expect(dropTarget(columns, "a", "c")).toEqual({ column: "backlog", index: 2 });
  });

  test("dropping on its own column's empty space puts it last", () => {
    expect(dropTarget(columns, "a", "backlog")).toEqual({ column: "backlog", index: 2 });
  });

  test("null when the drop is on nothing known", () => {
    expect(dropTarget(columns, "a", "elsewhere")).toBeNull();
  });
});
