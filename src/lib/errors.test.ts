import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { messageOf } from "./errors";

describe("messageOf", () => {
  test("shows the message a Convex function threw", () => {
    expect(messageOf(new ConvexError("A task needs a title."))).toBe("A task needs a title.");
  });

  test("shows the first issue from a rejected batch", () => {
    const error = new ConvexError({
      code: "invalid_snapshots",
      issues: [{ index: 0, field: "value", message: '"mrr" cannot be below 0.' }],
    });
    expect(messageOf(error)).toBe('"mrr" cannot be below 0.');
  });

  test("anything else gets the fallback, never a raw error", () => {
    expect(messageOf(new Error("socket hang up"))).toBe("That could not be saved. Try again.");
    expect(messageOf("boom", "Could not move the card.")).toBe("Could not move the card.");
  });
});
