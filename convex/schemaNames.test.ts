import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Convex refuses the whole push when one index name breaks its rules, and
// only the deploy finds out: these are checked here instead.
const schema = readFileSync(join(__dirname, "schema.ts"), "utf8");
const indexNames = [...schema.matchAll(/\.index\(\s*"([^"]+)"/g)].map((m) => m[1]!);

describe("index names", () => {
  test("there are some to check", () => {
    expect(indexNames.length).toBeGreaterThan(10);
  });

  test("each is at most 64 characters, starts with a letter and holds only letters, digits and underscores", () => {
    const bad = indexNames.filter((name) => name.length > 64 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name));
    expect(bad).toEqual([]);
  });
});
