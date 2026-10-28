// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { NO_LINKS_OR_CONTACTS } from "../convex/lib/dealIntel";
import { USAGE, run, toIntelRows, type ImportDeps } from "./importIntel";

// `pnpm import:intel`: research loaded onto the US deals. Every name in the
// made-up file holds "SECRET", so a printed line that does not is proved to
// hold no name.
const LIST = resolve(__dirname, "fixtures", "intel.example.json");
const read = (path: string) => readFileSync(path, "utf8");

const DONE = {
  status: 0,
  stdout: '{\n  "matched": 2,\n  "unmatched": 1,\n  "unmatchedRows": [3],\n  "updated": 1\n}\n',
  stderr: "",
};

function setup(files: Record<string, string> = { [LIST]: read(LIST) }, reply = DONE) {
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

describe("toIntelRows", () => {
  test("maps the file to the mutation's rows: known fields only, `name` taken for `dealName`", () => {
    const { rows, summary } = toIntelRows(JSON.parse(read(LIST)));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      dealName: "SECRET Example Specialty Partners",
      ehr: "athenahealth",
      fit: { score: 82, reasons: ["Large group", "Outsourced billing"] },
      sources: [{ title: "Made-up market scan", url: "https://claude.ai/artifact/made-up-0001" }],
    });
    expect(rows[1]).toEqual({
      dealName: "SECRET Sample Bone and Joint",
      ehr: "Made-up EHR",
      billingModel: "In-house",
      fit: { score: 55, reasons: [] },
    });
    expect(rows[2]).toEqual({ dealName: "SECRET Placeholder Spine Center" });
    expect(summary).toEqual({ unknownFields: 1 });
  });

  test("takes the list under `intel` or `deals` too", () => {
    expect(toIntelRows({ intel: [{ dealName: "SECRET A" }] }).rows).toEqual([{ dealName: "SECRET A" }]);
    expect(toIntelRows({ deals: [{ dealName: "SECRET A" }] }).rows).toEqual([{ dealName: "SECRET A" }]);
  });

  test.each([
    [[{ dealName: 7 }], "Row 1: the deal's name is not text."],
    [[{}], "Row 1: the deal's name is not text."],
    [[{ dealName: "SECRET A", summary: ["x"] }], "Row 1: summary is not text."],
    [[{ dealName: "SECRET A", specialties: "Spine" }], "Row 1: specialties is not a list of text."],
    [[{ dealName: "SECRET A", competitors: [{ note: "x" }] }], "Row 1: a competitor is not { name, note }."],
    [[{ dealName: "SECRET A", signals: [{ kind: "news" }] }], "Row 1: a signal is not { date, kind, text, source }."],
    [[{ dealName: "SECRET A", people: [{ name: "x" }] }], "Row 1: a person is not { name, role, note }."],
    [[{ dealName: "SECRET A", fit: 80 }], "Row 1: fit is not { score, reasons }."],
    [[{ dealName: "SECRET A", sources: ["x"] }], "Row 1: a source is not { title, url }."],
    [["SECRET A"], "Row 1 is not a deal's intelligence."],
    [{ rows: [] }, "The file holds no list of deals' intelligence."],
  ])("refuses what it cannot read, by row: %j", (list, message) => {
    expect(() => toIntelRows(list)).toThrow(message);
  });
});

describe("pnpm import:intel", () => {
  test("--check prints counts, never a name, and sends nothing", () => {
    const { deps, printed, convexRun } = setup();
    expect(run([LIST, "--check"], deps)).toBe(0);
    expect(convexRun).not.toHaveBeenCalled();
    expect(printed.join("\n")).not.toMatch(/SECRET/);
    expect(printed).toEqual([
      "3 deals' intelligence read.",
      "With a fit score: 2. With signals: 1. With people: 1. With sources: 1.",
      "1 row holds fields the import does not know: they are left out.",
      "Every row passes the checks.",
      "Checked only: nothing was sent.",
    ]);
  });

  test("sends the rows to dealIntel:importIntel and prints the counts and unmatched rows it returned", () => {
    const { deps, printed, sent } = setup(undefined, {
      status: 0,
      stdout: `SECRET noise\n${DONE.stdout}`,
      stderr: "SECRET more noise",
    });
    expect(run([LIST], deps)).toBe(0);
    const [args] = sent();
    expect(args!.slice(0, 2)).toEqual(["run", "dealIntel:importIntel"]);
    expect(args!.slice(3)).toEqual(["--codegen", "disable", "--typecheck", "disable"]);
    expect(rowsOf(args!)).toHaveLength(3);
    expect(rowsOf(args!)[1]).not.toHaveProperty("confidence");
    expect(printed.join("\n")).not.toMatch(/SECRET/);
    expect(printed.slice(-4)).toEqual([
      "Sending to the dev deployment (add --prod for production).",
      "Batch 1 of 1: 2 matched (1 replaced), 1 unmatched.",
      "Done: 2 matched (1 already had intelligence, replaced), 1 unmatched.",
      "Rows that match no US deal made here: 3.",
    ]);
  });

  test("--prod sends to production, and only then", () => {
    const { deps, printed, sent } = setup();
    expect(run([LIST, "--prod"], deps)).toBe(0);
    expect(sent()[0]!.at(-1)).toBe("--prod");
    expect(printed).toContain("Sending to the production deployment.");
  });

  test("a row the server would refuse stops everything before anything is sent", () => {
    const list = JSON.parse(read(LIST));
    list[1].summary = "SECRET front desk 555-123-4567";
    const { deps, printed, convexRun } = setup({ [LIST]: JSON.stringify(list) });
    expect(run([LIST, "--prod"], deps)).toBe(1);
    expect(convexRun).not.toHaveBeenCalled();
    expect(printed).toContain(`! Row 2: ${NO_LINKS_OR_CONTACTS}`);
    expect(printed.join("\n")).not.toMatch(/SECRET|555/);
  });

  test("a long list goes in batches; refusals and unmatched rows are counted from the start of the file", () => {
    const list = Array.from({ length: 300 }, (_, n) => ({ dealName: `SECRET Vertical ${n}`, ehr: "Made-up EHR" }));
    const { deps, printed, sent, convexRun } = setup({ [LIST]: JSON.stringify(list) });
    convexRun
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"matched":249,"unmatched":1,"unmatchedRows":[4],"updated":0}',
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"matched":48,"unmatched":2,"unmatchedRows":[1,50],"updated":3}',
        stderr: "",
      });
    expect(run([LIST], deps)).toBe(0);
    expect(sent().map((args) => rowsOf(args).length)).toEqual([250, 50]);
    expect(printed.slice(-2)).toEqual([
      "Done: 297 matched (3 already had intelligence, replaced), 3 unmatched.",
      "Rows that match no US deal made here: 4, 251, 300.",
    ]);

    const refused = setup({ [LIST]: JSON.stringify(list) });
    refused.convexRun
      .mockReturnValueOnce(DONE)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: 'ConvexError: "Row 7: A source needs a title."\n SECRET' });
    expect(run([LIST], refused.deps)).toBe(1);
    expect(refused.printed).toContain("! Batch 2 of 2 was refused: Row 257: A source needs a title.");
    expect(refused.printed).toContain("! Batches before it are in; running the import again replaces them with the same.");
    expect(refused.printed.join("\n")).not.toMatch(/SECRET/);
  });

  test("a failure that is not a row's prints none of the CLI's output", () => {
    const { deps, printed } = setup(undefined, { status: 1, stdout: "SECRET", stderr: "SECRET deployment" });
    expect(run([LIST], deps)).toBe(1);
    expect(printed).toContain(
      "! Batch 1 of 1 did not run. The CLI's output is not shown, since it can quote a row: run `npx convex run dealIntel:importIntel '{\"rows\":[]}'` to see what it says.",
    );
    expect(printed.join("\n")).not.toMatch(/SECRET/);
  });

  test("many unmatched rows are listed up to fifty, then counted", () => {
    const rows = Array.from({ length: 60 }, (_, n) => n + 1);
    const { deps, printed } = setup(undefined, {
      status: 0,
      stdout: JSON.stringify({ matched: 0, unmatched: 60, unmatchedRows: rows, updated: 0 }),
      stderr: "",
    });
    expect(run([LIST], deps)).toBe(0);
    expect(printed.at(-1)).toBe(
      `Rows that match no US deal made here: ${rows.slice(0, 50).join(", ")}, and 10 more.`,
    );
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
    const broken = setup({ [LIST]: "{ SECRET" });
    expect(run([LIST], broken.deps)).toBe(1);
    expect(broken.printed).toEqual(["! The file is not JSON."]);
  });
});
