// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Gate } from "./lib/owner";
import { PAY_AND_COSTS } from "./lib/roles";

// Who reads pay and costs. The owner's decision: "Payroll is mine alone", and
// costs (the burn, and the run-rate incl. pay) with it. Every server file that
// reads one of their tables is named here, with every function it exports, and
// a new reader fails this test until the owner has reviewed it and added its
// line (.github/CODEOWNERS sends this file to the owner).
//
// What counts as a read, found in the source text of every deployed file under
// convex/ (not _generated, not a test, not a two-dot test kit):
// `.query("<table>")`, `normalizeId("<table>"` and `v.id("<table>")` (an
// argument that names one of their rows, which a handler then reads by id).
// A table name built at run time is not found: do not write one.

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** The tables that hold pay and costs (convex/schema.ts). */
const TABLES = ["payrollPeople", "payrollLines", "payrollRuns", "costs"] as const;

/**
 * The files allowed to read them, each with every function it exports. A
 * registered function must be gated by the owner alone or by its own area
 * (payroll's by `payroll`, costs' by `costs`); a plain helper is named in
 * HELPERS with why it is safe.
 */
const READERS: Record<string, { area: (typeof PAY_AND_COSTS)[number]; exports: readonly string[] }> = {
  "payroll.ts": {
    area: "payroll",
    exports: [
      "addUsualLines",
      "archivePerson",
      "createLine",
      "createPerson",
      "getRun",
      "listLines",
      "listPeople",
      "listRuns",
      "markPaid",
      "prepareRun",
      "removeLine",
      "removePerson",
      "removeRun",
      "reopenRun",
      "reorderLines",
      "setAdjustment",
      "updateLine",
      "updatePerson",
    ],
  },
  "costs.ts": {
    area: "costs",
    exports: [
      "add",
      "archive",
      "costLinesFor",
      "costSummaryFor",
      "list",
      "remove",
      "restore",
      "summary",
      "update",
    ],
  },
};

/**
 * Exports that are not registered functions, so carry no gate of their own.
 * Each refuses a caller without the area itself (convex/ownerOnlyAreas.test.ts
 * proves it), so a new caller cannot hand a teammate the lines by mistake.
 */
const HELPERS: Record<string, string> = {
  "costs.ts:costLinesFor":
    "the lines costs.list sends, also read by budget.ts (only when the caller holds Costs) and the owner's agent's `costs` tool",
  "costs.ts:costSummaryFor":
    "the run-rate costs.summary sends, also read by budget.ts (only when the caller holds Costs) and the `costs` tool",
};

/** Files that name the tables without reading them, each with why. */
const NOT_READERS: Record<string, string> = {
  "schema.ts": "defines the tables and the ids one row holds of another (`v.id`); runs nothing",
};

function deployedFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "_generated" && name !== "node_modules") found.push(...deployedFiles(path));
      continue;
    }
    // Two dots (`x.test.ts`, `mcp.kit.ts`, `test.setup.ts`) is never bundled by Convex.
    if (!name.endsWith(".ts") || name.split(".").length > 2) continue;
    found.push(path);
  }
  return found;
}

const READ = new RegExp(
  `(\\.query\\(\\s*"(${TABLES.join("|")})"\\s*\\)|normalizeId\\(\\s*"(${TABLES.join("|")})"|v\\.id\\(\\s*"(${TABLES.join("|")})"\\s*\\))`,
);

/** Every deployed file that reads a pay or costs table, relative to convex/. */
function readers(): string[] {
  return deployedFiles(ROOT)
    .filter((path) => READ.test(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .filter((file) => !(file in NOT_READERS))
    .sort();
}

describe("who reads the payroll and costs tables", () => {
  test("only the files the owner reviewed", () => {
    const unexpected = readers().filter((file) => !(file in READERS));
    expect(
      unexpected,
      `${unexpected.join(", ")} reads a payroll or costs table. Payroll and costs are the owner's ` +
        "alone: the owner must review this reader before it is added to READERS in " +
        "convex/payrollReaders.test.ts.",
    ).toEqual([]);
  });

  test("each file on the list does read one: the list is not stale", () => {
    expect(readers()).toEqual(Object.keys(READERS).sort());
  });

  test("the scan sees a read in each form it looks for", () => {
    for (const table of TABLES) {
      expect(READ.test(`ctx.db.query("${table}")`)).toBe(true);
      expect(READ.test(`ctx.db.query(\n  "${table}"\n)`)).toBe(true);
      expect(READ.test(`ctx.db.normalizeId("${table}", raw)`)).toBe(true);
      expect(READ.test(`args: { id: v.id("${table}") }`)).toBe(true);
    }
    expect(READ.test(`ctx.db.query("costsArchive")`)).toBe(false);
    expect(READ.test(`ctx.db.insert("costs", row)`)).toBe(false);
  });
});

describe("what each allowed file exports", () => {
  test.each(Object.entries(READERS))("%s exports exactly the reviewed functions", async (file, entry) => {
    const mod = (await import(`./${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    const exported = Object.keys(mod).sort();
    expect(
      exported,
      `${file} exports something the owner has not reviewed: add it to READERS in convex/payrollReaders.test.ts once they have.`,
    ).toEqual([...entry.exports].sort());
  });

  test.each(Object.entries(READERS))(
    "every function %s exports is the owner's alone, or its own area's",
    async (file, entry) => {
      const mod = (await import(`./${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
      for (const name of entry.exports) {
        const value = mod[name] as { gate?: Gate } | undefined;
        if (value?.gate === undefined) {
          expect([name, `${file}:${name}` in HELPERS]).toEqual([name, true]);
          continue;
        }
        const ok = value.gate === "owner" || (value.gate.areas.length === 1 && value.gate.areas[0] === entry.area);
        expect([name, value.gate, ok]).toEqual([name, value.gate, true]);
      }
    },
  );

  test("every helper named is still exported by its file", () => {
    for (const key of Object.keys(HELPERS)) {
      const [file, name] = key.split(":") as [string, string];
      expect(READERS[file]?.exports).toContain(name);
    }
  });
});
