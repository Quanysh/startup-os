import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import { MAX_SELECTED, bulkReport, runBulk } from "./bulk";

describe("runBulk", () => {
  test("runs one card at a time, in order, and goes on past a refusal", async () => {
    const seen: string[] = [];
    let running = 0;
    const act = vi.fn(async (id: string) => {
      running += 1;
      expect(running).toBe(1);
      seen.push(id);
      await Promise.resolve();
      running -= 1;
      if (id === "b") throw new ConvexError("That person cannot be given this task.");
      if (id === "c") throw new Error("socket closed: secret detail");
    });
    const outcomes = await runBulk(["a", "b", "c", "d"], act);
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(outcomes).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false, reason: "That person cannot be given this task." },
      // Only the server's own sentences are repeated; anything else is said plainly.
      { id: "c", ok: false, reason: "That change could not be saved." },
      { id: "d", ok: true },
    ]);
  });
});

describe("bulkReport", () => {
  const moved = (n: number) => `${n} moved`;
  test("all accepted", () => {
    expect(bulkReport([{ id: "a", ok: true }, { id: "b", ok: true }, { id: "c", ok: true }], moved)).toBe(
      "3 moved",
    );
  });
  test("some refused, with the server's sentence", () => {
    expect(
      bulkReport(
        [
          { id: "a", ok: true },
          { id: "b", ok: false, reason: "That person cannot be given this task." },
          { id: "c", ok: true },
        ],
        moved,
      ),
    ).toBe("2 moved, 1 refused: That person cannot be given this task.");
  });
  test("several different reasons are each said once", () => {
    expect(
      bulkReport(
        [
          { id: "a", ok: false, reason: "That task no longer exists." },
          { id: "b", ok: false, reason: "That person cannot be given this task." },
          { id: "c", ok: false, reason: "That task no longer exists." },
        ],
        moved,
      ),
    ).toBe("3 refused: That task no longer exists. That person cannot be given this task.");
  });
  test("there is a ceiling on a selection", () => {
    expect(MAX_SELECTED).toBe(50);
  });
});
