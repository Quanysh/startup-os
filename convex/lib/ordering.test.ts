import { describe, expect, test } from "vitest";
import { placeAt } from "./ordering";

describe("placeAt", () => {
  test("inserts a new id at the given position", () => {
    expect(placeAt(["a", "b", "c"], "x", 1)).toEqual(["a", "x", "b", "c"]);
  });

  test("moves an id that is already in the list", () => {
    expect(placeAt(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  test("leaves the order alone when the id is already at that position", () => {
    expect(placeAt(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
  });

  test("an index past the end means last", () => {
    expect(placeAt(["a", "b"], "x", 99)).toEqual(["a", "b", "x"]);
  });

  test("a negative index means first", () => {
    expect(placeAt(["a", "b"], "x", -3)).toEqual(["x", "a", "b"]);
  });

  test("works on an empty list", () => {
    expect(placeAt([], "x", 0)).toEqual(["x"]);
  });

  test("does not modify the list it was given", () => {
    const original = ["a", "b"];
    placeAt(original, "x", 0);
    expect(original).toEqual(["a", "b"]);
  });
});
