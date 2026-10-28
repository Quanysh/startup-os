import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { expectShape } from "./marketingShape";

const schema = z.object({ rows: z.array(z.object({ count: z.number() })) });

describe("expectShape", () => {
  test("returns what parsed, without fields the schema does not name", () => {
    const parsed = expectShape(
      schema,
      { rows: [{ count: 2, name: "Initech outreach" }] },
      "Apollo's sequences",
    );
    expect(parsed).toEqual({ rows: [{ count: 2 }] });
  });

  test("a different shape is refused, naming where and whose", () => {
    expect(() => expectShape(schema, { rows: [{ count: "2" }] }, "Apollo's sequences")).toThrow(
      "Apollo's sequences response is not in the expected shape (rows.0.count).",
    );
    expect(() => expectShape(schema, null, "Apollo's sequences")).toThrow(
      "Apollo's sequences response is not in the expected shape ().",
    );
  });

  test("the refusal is a ConnectorError and quotes nothing that was sent", () => {
    let thrown: unknown;
    try {
      expectShape(
        schema,
        { rows: [{ count: "how to bill 27447" }] },
        "Search Console's daily totals",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as Error).message).not.toContain("27447");
  });

  test("a step in the path that is not a plain field name or a position is not quoted", () => {
    // A record's key is chosen by the source; a schema of fixed keys never
    // produces one, and this holds even if one is used by mistake.
    const loose = z.record(z.string(), z.number());
    expect(() => expectShape(loose, { "jane@example.test": "x" }, "Apollo's sequences")).toThrow(
      "Apollo's sequences response is not in the expected shape (?).",
    );
  });
});
