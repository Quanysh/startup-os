// @vitest-environment node
import { describe, expect, test } from "vitest";
import { SheetError, detectDelimiter, parseCsv, readSheet, sheetSize } from "./registerSheet";

// Made-up exports, built in memory: no file is involved. Every clinic name
// contains "SECRET".
const bytes = (text: string) => new TextEncoder().encode(text);
const BOM = "﻿";

const REGISTER = [
  "Clinic,Monthly fee,Last payment,Paid?",
  "SECRET CLINIC ALPHA,200000,2026-10-01,yes",
  "SECRET CLINIC BETA,,,",
  "",
].join("\r\n");

describe("parseCsv", () => {
  test("plain fields, with LF, CRLF or CR line ends", () => {
    const expected = [
      ["a", "b"],
      ["c", "d"],
    ];
    expect(parseCsv("a,b\nc,d\n")).toEqual(expected);
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual(expected);
    expect(parseCsv("a,b\rc,d\r")).toEqual(expected);
  });

  test("a last line without a line break is still a record", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("a quoted field keeps its commas, line breaks and doubled quotes", () => {
    expect(parseCsv('"SECRET CLINIC, LLP","line one\r\nline two","the ""best"" one"\n')).toEqual([
      ["SECRET CLINIC, LLP", "line one\r\nline two", 'the "best" one'],
    ]);
  });

  test("empty fields, quoted or not, are empty strings", () => {
    expect(parseCsv('a,,"",d\n')).toEqual([["a", "", "", "d"]]);
    expect(parseCsv(",\n")).toEqual([["", ""]]);
  });

  test("a blank line is a record with one empty field", () => {
    expect(parseCsv("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
  });

  test("a quote inside an unquoted field is kept as written", () => {
    expect(parseCsv('5" pipe,x\n')).toEqual([['5" pipe', "x"]]);
  });

  test("another delimiter can be named", () => {
    expect(parseCsv('a;"b;c";1,5\n', ";")).toEqual([["a", "b;c", "1,5"]]);
  });

  test("an empty file has no records", () => {
    expect(parseCsv("")).toEqual([]);
  });

  test("a file that ends inside quotes is refused without quoting it", () => {
    expect(() => parseCsv('a,"SECRET CLINIC ALPHA\n')).toThrow(
      new SheetError("The file ends inside a quoted field, so it is not a complete CSV."),
    );
  });
});

describe("detectDelimiter", () => {
  test("the separator seen most often outside quotes", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a;b;c\n1,5;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
  });

  test("separators inside quotes do not count", () => {
    expect(detectDelimiter('"a;b;c;d",x,y\n')).toBe(",");
  });

  test("a single column reads with a comma", () => {
    expect(detectDelimiter("Clinic\nSECRET CLINIC ALPHA\n")).toBe(",");
  });
});

describe("readSheet", () => {
  test("headers as text; an empty cell is null, never 0 and never an empty string", () => {
    const sheet = readSheet(bytes(REGISTER), 1);
    expect(sheet.headers).toEqual(["Clinic", "Monthly fee", "Last payment", "Paid?"]);
    expect(sheet.firstDataRow).toBe(2);
    expect(sheet.rows).toEqual([
      ["SECRET CLINIC ALPHA", "200000", "2026-10-01", "yes"],
      ["SECRET CLINIC BETA", null, null, null],
    ]);
  });

  test("a byte-order mark is not part of the first heading", () => {
    expect(readSheet(bytes(BOM + REGISTER), 1).headers[0]).toBe("Clinic");
  });

  test("a semicolon export (a comma-decimal locale) reads the same", () => {
    const sheet = readSheet(bytes("Clinic;Monthly fee\r\nSECRET CLINIC ALPHA;200000,50\r\n"), 1);
    expect(sheet.headers).toEqual(["Clinic", "Monthly fee"]);
    expect(sheet.rows).toEqual([["SECRET CLINIC ALPHA", "200000,50"]]);
  });

  test("a header row lower down is honoured", () => {
    const sheet = readSheet(bytes("Client register,\nClinic,Market\nSECRET CLINIC ALPHA,KZ\n"), 2);
    expect(sheet.headers).toEqual(["Clinic", "Market"]);
    expect(sheet.firstDataRow).toBe(3);
    expect(sheet.rows).toEqual([["SECRET CLINIC ALPHA", "KZ"]]);
  });

  test("short rows are padded to the sheet's width; headings are trimmed", () => {
    const sheet = readSheet(bytes(" Clinic , Market ,Status\nSECRET CLINIC ALPHA\n"), 1);
    expect(sheet.headers).toEqual(["Clinic", "Market", "Status"]);
    expect(sheet.rows).toEqual([["SECRET CLINIC ALPHA", null, null]]);
  });

  test("trailing blank lines are not rows", () => {
    expect(readSheet(bytes("Clinic\nSECRET CLINIC ALPHA\n\n,\n\n"), 1).rows).toHaveLength(1);
  });

  test("a header row with no text in it is refused", () => {
    expect(() => readSheet(bytes(REGISTER), 9)).toThrow(
      new SheetError("Row 9 holds no text, so it is not the header row."),
    );
    expect(() => readSheet(bytes("Clinic\n\nSECRET CLINIC ALPHA\n"), 2)).toThrow(
      new SheetError("Row 2 holds no text, so it is not the header row."),
    );
  });

  test("a file that is not UTF-8 text (a workbook, say) is refused without quoting it", () => {
    // The first bytes of a zip, which is what an .xlsx is.
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0x81]);
    expect(() => readSheet(zip, 1)).toThrow(
      new SheetError(
        'The file is not UTF-8 text. Export the register sheet as "CSV UTF-8" and pass that file.',
      ),
    );
  });

  test("text with NUL bytes in it is refused", () => {
    expect(() => readSheet(bytes("Clinic\u0000,SECRET\n"), 1)).toThrow(
      new SheetError(
        'The file is not a CSV export. Export the register sheet as "CSV UTF-8" and pass that file.',
      ),
    );
  });
});

describe("sheetSize", () => {
  test("rows and columns, and nothing else", () => {
    const size = sheetSize(bytes(BOM + REGISTER));
    expect(size).toEqual({ rows: 3, columns: 4 });
    expect(JSON.stringify(size)).not.toContain("SECRET");
  });
});
