// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RegisterConfig } from "./customersToEnvelope";
import { run, USAGE } from "./registerHeaders";
import { SheetError, readSheet } from "./registerSheet";

const CONFIG: RegisterConfig = {
  headerRow: 2,
  columns: {
    name: "Clinic",
    market: "Market",
    status: "Status",
    monthlyFee: "Monthly fee",
    lastPaymentDate: "Last payment",
    amountOwed: "Owed",
    contractDate: "Contract date",
    baaDate: "BAA date",
  },
  markets: { us: "us", kz: "kz" },
  statuses: { active: "active", paused: "paused", churned: "churned" },
};

// A made-up export: a title row, the headings, then clinics. Everything that
// is not an expected heading contains "SECRET" or is listed in PRIVATE, so one
// assertion proves the report holds none of it.
const TITLE = ["SECRET REGISTER TITLE"];
const HEADINGS = [
  " clinic ",
  "MARKET",
  "Status",
  "Monthly fee",
  "Last payment",
  "Owed",
  "SECRET HEADING",
  "Director SECRET",
];
const ALPHA = ["SECRET CLINIC ALPHA", "kz", "active", "200 000", "01.10.2026", "0", "SECRET x", "SECRET PERSON"];
const BETA = ["SECRET CLINIC BETA", "us", "paused", "", "10/01/2026", "", "", ""];
const GAMMA = ["SECRET CLINIC GAMMA", "kz", "churned", "150000", "2026-06-15", "450000", "", ""];
const csv = (rows: string[][]) => new TextEncoder().encode(rows.map((r) => r.join(",")).join("\n"));
const FILE = csv([TITLE, HEADINGS, ALPHA, BETA, GAMMA]);

function setup(options: { data?: Uint8Array; fail?: boolean; readSheet?: typeof readSheet } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    printed: () => [...out, ...err].join("\n"),
    deps: {
      readFile: () => {
        if (options.fail) throw new Error("ENOENT SECRET path detail");
        return options.data ?? FILE;
      },
      readSheet: options.readSheet ?? readSheet,
      print: (line: string) => void out.push(line),
      printError: (line: string) => void err.push(line),
      config: CONFIG,
    },
  };
}

/** No cell of the file may be printed unless it is an expected heading. */
function expectNothingOf(printed: string, rows: string[][]) {
  expect(printed).not.toContain("SECRET");
  const expected = new Set(Object.values(CONFIG.columns).map((h) => h.toLowerCase()));
  for (const cell of rows.flat()) {
    const text = cell.trim();
    if (text === "" || expected.has(text.toLowerCase())) continue;
    // A bare "0" or "kz" would match a count or a word of ours by accident:
    // the cells that matter are the ones long enough to be somebody's.
    if (text.length < 4) continue;
    expect(printed, text).not.toContain(text);
  }
}

describe("run: the header report", () => {
  test("says which expected headings the row holds, where, and the kind of value under each", () => {
    const h = setup();
    expect(run(["/fake/register.csv"], h.deps)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out).toEqual([
      "Row 2 read as the header row, with 3 rows below it.",
      '"Clinic": found in column A. Below it: text ×3.',
      '"Market": found in column B. Below it: text ×3.',
      '"Status": found in column C. Below it: text ×3.',
      '"Monthly fee": found in column D. Below it: number ×2, empty ×1.',
      // 10/01/2026 has two readings, so it is text: the push would refuse it.
      '"Last payment": found in column E. Below it: text ×1, date ×2.',
      '"Owed": found in column F. Below it: number ×2, empty ×1.',
      '"Contract date": not found.',
      '"BAA date": not found.',
      "2 other non-empty cells in row 2.",
    ]);
  });

  test("the header row comes from the mapping unless given", () => {
    const h = setup({ data: csv([HEADINGS, ALPHA]) });
    expect(run(["/fake/register.csv", "--header-row", "1"], h.deps)).toBe(0);
    expect(h.out[0]).toBe("Row 1 read as the header row, with 1 row below it.");
    expect(h.out[1]).toBe('"Clinic": found in column A. Below it: text ×1.');
  });

  test("a heading it did not expect is counted, never printed", () => {
    const h = setup();
    run(["/fake/register.csv"], h.deps);
    expect(h.printed()).not.toContain("SECRET HEADING");
    expect(h.printed()).not.toContain("Director");
    expectNothingOf(h.printed(), [TITLE, HEADINGS, ALPHA, BETA, GAMMA]);
  });

  test("a heading that appears twice is reported by its columns, with no kind", () => {
    const h = setup({ data: csv([TITLE, ["Clinic", "Owed", "owed"], ["SECRET CLINIC ALPHA", "1", "2"]]) });
    expect(run(["/fake/register.csv"], h.deps)).toBe(0);
    expect(h.out).toContain('"Owed": found 2 times (columns B, C).');
  });
});

describe("run: pointed at the wrong row, it prints no cell of it", () => {
  test("off by one, on a clinic's row: refused, and nothing of the row is printed", () => {
    const h = setup();
    expect(run(["/fake/register.csv", "--header-row", "3"], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual(["Row 3 holds a number or a date, so it is not the header row."]);
    for (const cell of ALPHA) expect(h.printed(), cell).not.toContain(cell);
  });

  test("a clinic's row with no number and no date in it is still not printed", () => {
    const wordsOnly = ["SECRET CLINIC DELTA", "SECRET TOWN", "SECRET PERSON", "SECRET NOTE"];
    const h = setup({ data: csv([TITLE, HEADINGS, wordsOnly, ALPHA]) });
    expect(run(["/fake/register.csv", "--header-row", "3"], h.deps)).toBe(0);
    expect(h.out[0]).toBe("Row 3 read as the header row, with 1 row below it.");
    expect(h.out.slice(1, -1).every((line) => line.endsWith(": not found."))).toBe(true);
    expect(h.out.at(-1)).toBe("4 other non-empty cells in row 3.");
    for (const cell of [...wordsOnly, ...ALPHA]) expect(h.printed(), cell).not.toContain(cell);
  });

  test("a title row above the headings is not printed", () => {
    const h = setup();
    expect(run(["/fake/register.csv", "--header-row", "1"], h.deps)).toBe(0);
    expect(h.out.at(-1)).toBe("1 other non-empty cell in row 1.");
    expect(h.printed()).not.toContain("TITLE");
    expectNothingOf(h.printed(), [TITLE, HEADINGS, ALPHA, BETA, GAMMA]);
  });

  test("a row holding a date is refused too", () => {
    const h = setup({ data: csv([["Clinic", "01.10.2026"], ["SECRET CLINIC ALPHA", "x"]]) });
    expect(run(["/fake/register.csv", "--header-row", "1"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Row 1 holds a number or a date, so it is not the header row."]);
  });
});

describe("run: refusals", () => {
  test.each([
    [[]],
    [["a.csv", "b.csv"]],
    [["a.csv", "--header-row"]],
    [["a.csv", "--header-row", "0"]],
    [["a.csv", "--header-row", "two"]],
    [["a.csv", "--header-row", "1.5"]],
    [["a.csv", "--rows"]],
    [["a.csv", "--sheet", "Register"]],
  ])("%j is refused with the usage line", (argv) => {
    const h = setup();
    expect(run(argv, h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    expect(h.out).toEqual([]);
  });

  test("a file that cannot be read is reported without the system's own message", () => {
    const h = setup({ fail: true });
    expect(run(["/fake/register.csv"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Could not read /fake/register.csv."]);
  });

  test("the reader's own refusal is printed; any other error is reduced to fixed words", () => {
    const refused = setup();
    expect(run(["/fake/register.csv", "--header-row", "9"], refused.deps)).toBe(1);
    expect(refused.err).toEqual(["Row 9 holds no text, so it is not the header row."]);

    const known = setup({
      readSheet: () => {
        throw new SheetError("The file is not a CSV export.");
      },
    });
    expect(run(["/fake/register.csv"], known.deps)).toBe(1);
    expect(known.err).toEqual(["The file is not a CSV export."]);

    const odd = setup({
      readSheet: () => {
        throw new Error("SECRET CLINIC ALPHA in a parser message");
      },
    });
    expect(run(["/fake/register.csv"], odd.deps)).toBe(1);
    expect(odd.err).toEqual(["The export could not be read."]);
  });
});
