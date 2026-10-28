import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { duplicateWarning, nearCardsSentence } from "./duplicates";

describe("a near-duplicate warning", () => {
  test("is read off the server's coded warning, and nothing else", () => {
    const matches = [{ id: "t1", title: "Send the deck" }];
    expect(duplicateWarning(new ConvexError({ words: "x", refusal: { code: "possible_duplicate", matches } }))).toEqual(matches);
    expect(duplicateWarning(new ConvexError("That title is too long."))).toBeNull();
    expect(duplicateWarning(new ConvexError({ words: "x", refusal: { code: "not_permitted" } }))).toBeNull();
    expect(duplicateWarning(new Error("offline"))).toBeNull();
  });

  test("says the open cards' titles", () => {
    expect(nearCardsSentence([{ id: "a", title: "Send the deck" }])).toBe("Possible duplicate of “Send the deck”.");
    expect(nearCardsSentence([{ id: "a", title: "One" }, { id: "b", title: "Two" }])).toBe("Possible duplicate of “One” or “Two”.");
  });
});
