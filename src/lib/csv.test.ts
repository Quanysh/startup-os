import { describe, expect, it } from "vitest";
import { csvCell, csvFileName, slugOf, toCsv } from "./csv";

const BOM = "﻿";

describe("toCsv", () => {
  it("starts with a byte-order mark and ends every line with CRLF", () => {
    expect(toCsv([["Name", "Pay"], ["Dana Lee", "$5,000.00"]])).toBe(
      `${BOM}Name,Pay\r\nDana Lee,"$5,000.00"\r\n`,
    );
  });

  it("writes an empty table as the mark alone", () => {
    expect(toCsv([])).toBe(BOM);
  });

  it("keeps Cyrillic and the tenge sign as they are", () => {
    expect(toCsv([["Дана Ли", "₸250000"]])).toBe(`${BOM}Дана Ли,₸250000\r\n`);
  });

  it("keeps an empty cell as an empty field", () => {
    expect(toCsv([["a", "", "c"]])).toBe(`${BOM}a,,c\r\n`);
  });
});

describe("csvCell: RFC 4180 quoting", () => {
  it("leaves a plain value bare", () => {
    expect(csvCell("Dana Lee")).toBe("Dana Lee");
  });

  it("quotes a value with a comma", () => {
    expect(csvCell("$1,075.00")).toBe('"$1,075.00"');
  });

  it("quotes a value with a quote and doubles the quote", () => {
    expect(csvCell('The "big" one')).toBe('"The ""big"" one"');
  });

  it("quotes a value with a line break, LF or CR", () => {
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });
});

describe("csvCell: formula injection", () => {
  it.each([
    ["=SUM(A1:A9)", "'=SUM(A1:A9)"],
    ["+12%", "'+12%"],
    ["@cmd", "'@cmd"],
    ["-cmd", "'-cmd"],
    ["-", "'-"],
    ["- 5", "'- 5"],
  ])("prefixes %j with an apostrophe", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it("prefixes a leading tab or carriage return (and quotes the CR)", () => {
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
  });

  it("guards before it quotes", () => {
    expect(csvCell("=1,2")).toBe("\"'=1,2\"");
  });

  it.each([
    ["$1,075.00", '"$1,075.00"'],
    ["-$5,582", '"-$5,582"'],
    ["-₸250,000", '"-₸250,000"'],
    ["-12", "-12"],
    ["-0.5%", "-0.5%"],
    ["₸250,000 ≈ $500.00", '"₸250,000 ≈ $500.00"'],
    ["Dana-Lee", "Dana-Lee"],
    ["a=b", "a=b"],
  ])("leaves %j as it is shown", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it("writes the app's minus sign (U+2212) before a figure as a hyphen, so a spreadsheet reads a number", () => {
    expect(csvCell("−$5,582.00")).toBe('"-$5,582.00"');
    expect(csvCell("−₸1,000")).toBe('"-₸1,000"');
    expect(csvCell("−8.2%")).toBe("-8.2%");
  });

  it("leaves a minus sign that does not start a figure alone", () => {
    expect(csvCell("−x")).toBe("−x");
    expect(csvCell("a −$5")).toBe("a −$5");
  });
});

describe("slugOf and csvFileName", () => {
  const today = new Date(2026, 9, 15, 23, 59); // local time, late in the day

  it("names the file after the table and today's local date", () => {
    expect(csvFileName("All costs", today)).toBe("all-costs-2026-10-15.csv");
  });

  it("runs punctuation and spaces together into one hyphen", () => {
    expect(slugOf("October 2026, paid in USD")).toBe("october-2026-paid-in-usd");
    expect(slugOf("  Budget against the cost register's run-rate, Oct  ")).toBe(
      "budget-against-the-cost-register-s-run-rate-oct",
    );
  });

  it("keeps letters of any alphabet", () => {
    expect(slugOf("Зарплата: Дана")).toBe("зарплата-дана");
  });

  it("drops accents from Latin letters, and leaves a Cyrillic letter whole", () => {
    expect(slugOf("Café crème")).toBe("cafe-creme");
    expect(slugOf("Алексей Ёлкин")).toBe("алексей-ёлкин");
  });

  it("says 'table' when nothing is left of the name", () => {
    expect(csvFileName("", today)).toBe("table-2026-10-15.csv");
    expect(csvFileName("—", today)).toBe("table-2026-10-15.csv");
  });

  it("keeps a long name short", () => {
    const slug = slugOf("The budget in USD, by month and category, for each company and the group together");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("pads the month and the day", () => {
    expect(csvFileName("Tasks", new Date(2027, 0, 5))).toBe("tasks-2027-01-05.csv");
  });
});
