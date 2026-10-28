import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { expectShape } from "./shape";

const page = z.object({ items: z.array(z.object({ id: z.string(), count: z.number() })) });

/** What a refused parse threw. */
function refusal(raw: unknown, schema: z.ZodType = page): Error {
  try {
    expectShape(schema, raw, "Initech", "widgets");
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("expectShape", () => {
  test("returns what parsed", () => {
    expect(expectShape(page, { items: [{ id: "a", count: 1 }] }, "Initech", "widgets")).toEqual({
      items: [{ id: "a", count: 1 }],
    });
  });

  test("a response in another shape is refused in our words, naming where", () => {
    const error = refusal({ items: [{ id: "a", count: "many" }] });
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(
      "Initech's widgets response is not in the expected shape (items.0.count).",
    );
  });

  test("nothing the service sent is in the message", () => {
    expect(refusal({ items: "Initech Holdings LLC" }).message).not.toContain("Holdings");
  });

  test("a place named by the service's own key is not quoted", () => {
    // A record's keys are chosen by whoever sent it.
    const byName = z.record(z.string(), z.number());
    const error = refusal({ "drop table; select secret": "x" }, byName);
    expect(error.message).toBe("Initech's widgets response is not in the expected shape (?).");
  });
});
