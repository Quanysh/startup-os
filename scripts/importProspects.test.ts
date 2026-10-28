// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { USAGE, run, toImportRows, type ImportDeps } from "./importProspects";

// The made-up list and its sidecar. Every name in them holds "SECRET", so a
// printed line that does not is proved to hold no name.
const FIXTURES = resolve(__dirname, "fixtures");
const LIST = resolve(FIXTURES, "prospects.example.json");
const META = resolve(FIXTURES, "prospects.example.meta.json");
const read = (path: string) => readFileSync(path, "utf8");

type Files = Record<string, string>;
const DONE = { status: 0, stdout: '{\n  "added": 3,\n  "skipped": 0\n}\n', stderr: "" };

function setup(files: Files = { [LIST]: read(LIST), [META]: read(META) }, reply = DONE) {
  const printed: string[] = [];
  const convexRun = vi.fn((_args: string[]) => reply);
  const deps: ImportDeps = {
    readFile: (path) => (path in files ? files[path]! : null),
    convexRun,
    print: (line) => printed.push(line),
    printError: (line) => printed.push(`! ${line}`),
  };
  return { deps, printed, convexRun, sent: () => convexRun.mock.calls.map(([args]) => args) };
}

const rowsOf = (args: string[]) => JSON.parse(args[2]!).rows as Record<string, unknown>[];

describe("toImportRows", () => {
  test("maps the list and its sidecar to the mutation's rows", () => {
    const { rows, summary } = toImportRows(JSON.parse(read(LIST)), JSON.parse(read(META)));
    expect(rows).toEqual([
      {
        name: "SECRET Example Specialty Partners",
        contact: "SECRET Dr. Casey Placeholder",
        stage: "lead",
        nextStep: "Ask for twenty minutes with the billing lead",
        notes: "Made-up research: large group, athenahealth, prior-auth heavy.",
        priority: "high",
        sources: ["Made-up specialty market scan", "Sample payer mix note"],
        region: "TX",
        physicians: 59,
        locations: 29,
      },
      {
        name: "SECRET Sample Bone and Joint",
        stage: "qualified",
        notes: "Made-up: met at a sample conference.",
        priority: "medium",
        region: "OH",
        physicians: 12,
        locations: 3,
      },
      { name: "SECRET Placeholder Spine Center", stage: "lead", priority: "low" },
    ]);
    expect(summary).toMatchObject({ withMeta: 2, metaUnused: 1, sizesLeftOut: 0, sourcesCut: 0 });
  });

  test("takes a list under `prospects` too, and leaves out a size that is not a whole number", () => {
    const { rows, summary } = toImportRows(
      { prospects: [{ name: "SECRET A", stage: "lead" }] },
      { "SECRET A": { state: "TX", physicians: "about 60", locations: 2 } },
    );
    expect(rows).toEqual([{ name: "SECRET A", stage: "lead", region: "TX", locations: 2 }]);
    expect(summary.sizesLeftOut).toBe(1);
  });

  test("keeps the first twelve sources of a row that names more, and says how many rows", () => {
    const sources = Array.from({ length: 14 }, (_, i) => `Made-up scan ${i}`);
    const { rows, summary } = toImportRows([{ name: "SECRET A", stage: "lead", sources }], null);
    expect(rows[0]!.sources).toEqual(sources.slice(0, 12));
    expect(summary.sourcesCut).toBe(1);
  });

  test.each([
    [[{ name: 7, stage: "lead" }], "Row 1: the name is not text."],
    [[{ name: "SECRET A" }], "Row 1: the stage is not text."],
    [[{ name: "SECRET A", stage: "lead", sources: "one" }], "Row 1: the sources are not a list."],
    [[{ name: "SECRET A", stage: "lead", sources: [3] }], "Row 1: a source is neither text nor a title."],
    [[{ name: "SECRET A", stage: "lead", notes: ["x"] }], "Row 1: the notes are not text."],
    [["SECRET A"], "Row 1 is not a prospect."],
    [{ rows: [] }, "The file holds no list of prospects."],
  ])("refuses what it cannot read, by row: %j", (list, message) => {
    expect(() => toImportRows(list, null)).toThrow(message);
  });
});

describe("pnpm import:prospects", () => {
  test("--check prints counts, never a name, and sends nothing", () => {
    const { deps, printed, convexRun } = setup();
    expect(run([LIST, "--check"], deps)).toBe(0);
    expect(convexRun).not.toHaveBeenCalled();
    expect(printed.join("\n")).not.toMatch(/SECRET/);
    expect(printed).toEqual([
      "3 prospects read.",
      "Stages: lead 2, qualified 1.",
      "Priority: high 1, medium 1, low 1, none 0.",
      "Region and size from the sidecar: 2 of 3 rows. 1 sidecar entry matches no row.",
      "With sources: 1.",
      "Every row passes the board's checks.",
      "Checked only: nothing was sent.",
    ]);
  });

  test("sends the rows to deals:importProspects and prints the counts the server returned", () => {
    const { deps, printed, sent } = setup(undefined, {
      status: 0,
      // What the CLI prints besides the answer is never printed.
      stdout: 'SECRET noise\n{\n  "added": 2,\n  "skipped": 1\n}\n',
      stderr: "SECRET more noise",
    });
    expect(run([LIST], deps)).toBe(0);
    const [args] = sent();
    expect(args!.slice(0, 2)).toEqual(["run", "deals:importProspects"]);
    expect(args!.slice(3)).toEqual(["--codegen", "disable", "--typecheck", "disable"]);
    expect(JSON.parse(args![2]!).market).toBe("us");
    expect(rowsOf(args!)).toHaveLength(3);
    expect(printed.join("\n")).not.toMatch(/SECRET/);
    expect(printed.slice(-3)).toEqual([
      "Sending to the dev deployment (add --prod for production).",
      "Batch 1 of 1: 2 added, 1 skipped.",
      "Done: 2 added, 1 skipped (already a US deal, or twice in the list).",
    ]);
  });

  test("--prod sends to production, and only then", () => {
    const { deps, printed, sent } = setup();
    expect(run([LIST, "--prod"], deps)).toBe(0);
    expect(sent()[0]!.at(-1)).toBe("--prod");
    expect(printed).toContain("Sending to the production deployment.");
  });

  test("a row the board would refuse stops everything before anything is sent", () => {
    const list = JSON.parse(read(LIST));
    list[1].notes = "SECRET front desk 555-123-4567";
    const { deps, printed, convexRun } = setup({ [LIST]: JSON.stringify(list), [META]: read(META) });
    expect(run([LIST, "--prod"], deps)).toBe(1);
    expect(convexRun).not.toHaveBeenCalled();
    expect(printed).toContain(
      "! Row 2: Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.",
    );
    expect(printed.join("\n")).not.toMatch(/SECRET|555/);
  });

  test("with no sidecar it stops, unless told the list has none", () => {
    const { deps, printed, convexRun } = setup({ [LIST]: read(LIST) });
    expect(run([LIST], deps)).toBe(1);
    expect(printed).toContain(
      "! No sidecar beside the file (prospects.example.meta.json). Add it, or pass --no-meta to import without region and size.",
    );
    expect(convexRun).not.toHaveBeenCalled();
    const again = setup({ [LIST]: read(LIST) });
    expect(run([LIST, "--no-meta"], again.deps)).toBe(0);
    expect(rowsOf(again.sent()[0]!)[0]).not.toHaveProperty("region");
  });

  test("a long list goes in batches, and a refusal names the row by its place in the file", () => {
    const list = Array.from({ length: 300 }, (_, n) => ({ name: `SECRET Vertical ${n}`, stage: "lead" }));
    const { deps, printed, sent } = setup(
      { [LIST]: JSON.stringify(list), [META]: "{}" },
      {
        status: 1,
        stdout: "",
        stderr: "Error: Uncaught ConvexError: Row 10: A priority is high, medium or low.\n  SECRET Vertical 259",
      },
    );
    expect(run([LIST], deps)).toBe(1);
    // The first batch was refused, so the second was never sent.
    expect(sent()).toHaveLength(1);
    expect(rowsOf(sent()[0]!)).toHaveLength(250);
    expect(printed).toContain("! Batch 1 of 2 was refused: Row 10: A priority is high, medium or low.");
    expect(printed.join("\n")).not.toMatch(/SECRET/);

    const ok = setup({ [LIST]: JSON.stringify(list), [META]: "{}" });
    expect(run([LIST], ok.deps)).toBe(0);
    expect(ok.sent().map((args) => rowsOf(args).length)).toEqual([250, 50]);
  });

  test("a refusal in a later batch is counted from the start of the file", () => {
    const list = Array.from({ length: 300 }, (_, n) => ({ name: `SECRET Vertical ${n}`, stage: "lead" }));
    const { deps, printed, convexRun } = setup({ [LIST]: JSON.stringify(list), [META]: "{}" });
    convexRun
      .mockReturnValueOnce(DONE)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: 'ConvexError: "Row 7: A deal needs a company name."' });
    expect(run([LIST], deps)).toBe(1);
    expect(printed).toContain("! Batch 2 of 2 was refused: Row 257: A deal needs a company name.");
    expect(printed).toContain("! Batches before it are in; running the import again skips them.");
  });

  test("a failure that is not a row's prints none of the CLI's output", () => {
    const { deps, printed } = setup(undefined, {
      status: 1,
      stdout: "SECRET",
      stderr: "Could not reach SECRET deployment",
    });
    expect(run([LIST], deps)).toBe(1);
    expect(printed).toContain(
      "! Batch 1 of 1 did not run. The CLI's output is not shown, since it can quote a row: run `npx convex run deals:importProspects '{\"market\":\"us\",\"rows\":[]}'` to see what it says.",
    );
    expect(printed.join("\n")).not.toMatch(/SECRET/);
  });

  test.each([[[]], [["a.json", "b.json"]], [[LIST, "--send"]]])("%j is a usage error", (argv) => {
    const { deps, printed, convexRun } = setup();
    expect(run(argv, deps)).toBe(1);
    expect(printed).toEqual([`! ${USAGE}`]);
    expect(convexRun).not.toHaveBeenCalled();
  });

  test("a file that is missing or not JSON is said in fixed words", () => {
    const missing = setup({});
    expect(run([LIST], missing.deps)).toBe(1);
    expect(missing.printed).toEqual(["! Could not read the file."]);
    const broken = setup({ [LIST]: "{ SECRET", [META]: "{}" });
    expect(run([LIST], broken.deps)).toBe(1);
    expect(broken.printed).toEqual(["! The file is not JSON."]);
  });
});
