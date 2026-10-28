import { describe, expect, test } from "vitest";
import { parseIngestEnvelope } from "../convex/lib/ingestSchema";
import { REGISTER, customersToEnvelope, type RegisterConfig } from "./customersToEnvelope";
import { readSheet, type Cell, type Sheet } from "./registerSheet";

// The tests' own config, so confirming the real headings does not touch them.
const CONFIG: RegisterConfig = {
  headerRow: 1,
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
  markets: { us: "us", kz: "kz", kazakhstan: "kz" },
  statuses: { active: "active", paused: "paused", churned: "churned" },
};

const HEADERS = [
  "Clinic",
  "Market",
  "Status",
  "Monthly fee",
  "Last payment",
  "Owed",
  "Contract date",
  "BAA date",
  "Director",
  "Patients",
];

// A made-up register, as a CSV export gives it: every cell is text. Names and
// people contain "SECRET"; the patient counts are numbers that appear nowhere
// else, so their absence can be asserted.
const ROWS: Cell[][] = [
  ["SECRET CLINIC ALPHA", "KZ", "Active", "200 000", "01.10.2026", "0", "2025-03-01", null, "SECRET PERSON ONE", "4321"],
  ["SECRET CLINIC BETA", "US", "Active", null, null, null, null, "03.03.2026", "SECRET PERSON TWO", "8765"],
  ["SECRET CLINIC GAMMA", " Kazakhstan ", " churned ", "150000", "2026-06-15", "450000,00", null, null, null, null],
];
const sheet = (rows: Cell[][] = ROWS, headers = HEADERS): Sheet => ({ headers, rows, firstDataRow: 2 });
const NOW = new Date("2026-10-12T09:30:00Z");

const mapped = (s: Sheet = sheet(), config = CONFIG) => {
  const result = customersToEnvelope(s, NOW, config);
  if (!result.ok) throw new Error(`expected a mapping, got: ${result.problems.join(" | ")}`);
  return result;
};
const problems = (s: Sheet, config = CONFIG) => {
  const result = customersToEnvelope(s, NOW, config);
  return result.ok ? [] : result.problems;
};
const withCell = (row: number, column: number, value: Cell) =>
  sheet(ROWS.map((cells, r) => (r === row ? cells.map((cell, c) => (c === column ? value : cell)) : cells)));

describe("customersToEnvelope", () => {
  test("maps each clinic, leaving out what the sheet leaves blank", () => {
    const { envelope } = mapped();
    expect(envelope).toEqual({
      version: 1,
      source: "client_register",
      batchId: "register-2026-10-12",
      observedAt: "2026-10-12T09:30:00.000Z",
      customers: [
        {
          name: "SECRET CLINIC ALPHA",
          market: "kz",
          status: "active",
          monthlyFee: 200_000,
          lastPaymentDate: "2026-10-01",
          amountOwed: 0,
          contractDate: "2025-03-01",
        },
        { name: "SECRET CLINIC BETA", market: "us", status: "active", baaDate: "2026-03-03" },
        {
          name: "SECRET CLINIC GAMMA",
          market: "kz",
          status: "churned",
          monthlyFee: 150_000,
          lastPaymentDate: "2026-06-15",
          amountOwed: 450_000,
        },
      ],
    });
  });

  test("a blank cell is left out, never sent as zero", () => {
    const beta = mapped().envelope.customers[1]!;
    expect("monthlyFee" in beta).toBe(false);
    expect("amountOwed" in beta).toBe(false);
    expect(JSON.stringify(beta)).not.toContain(":0");
  });

  test("a zero that is written is a zero", () => {
    expect(mapped().envelope.customers[0]?.amountOwed).toBe(0);
  });

  test("what it produces is what the endpoint accepts", () => {
    expect(parseIngestEnvelope(JSON.parse(JSON.stringify(mapped().envelope))).ok).toBe(true);
  });

  test("columns it was not told to read never reach the envelope", () => {
    const body = JSON.stringify(mapped().envelope);
    expect(body).not.toContain("SECRET PERSON");
    expect(body).not.toContain("4321");
    expect(body).not.toContain("8765");
    expect(body).not.toContain("Director");
    expect(body).not.toContain("Patients");
  });

  test("it reports which columns it read and which it did not", () => {
    expect(mapped().summary).toEqual({
      clinics: 3,
      rowsNotRead: 0,
      columnsRead: [
        "Clinic",
        "Market",
        "Status",
        "Monthly fee",
        "Last payment",
        "Owed",
        "Contract date",
        "BAA date",
      ],
      columnsNotRead: ["Director", "Patients"],
    });
  });

  test("headings match whatever their case and spacing", () => {
    const headers = HEADERS.map((h) => `  ${h.toUpperCase()} `);
    expect(mapped(sheet(ROWS, headers)).envelope.customers).toHaveLength(3);
  });

  test("an optional last-use column is read when the config names one", () => {
    const withUse = sheet(
      ROWS.map((cells, i) => [...cells, i === 0 ? "10.10.2026" : null]),
      [...HEADERS, "Last used"],
    );
    const config = { ...CONFIG, columns: { ...CONFIG.columns, lastUsageDate: "Last used" } };
    const { envelope } = mapped(withUse, config);
    expect(envelope.customers[0]?.lastUsageDate).toBe("2026-10-10");
    expect("lastUsageDate" in envelope.customers[1]!).toBe(false);
  });

  test("typed cells are read as they are, should a typed reader ever supply them", () => {
    const typed = withCell(0, 3, 200_000);
    const dated = sheet(
      typed.rows.map((cells, r) =>
        r === 0 ? cells.map((cell, c) => (c === 4 ? new Date(Date.UTC(2026, 9, 1)) : cell)) : cells,
      ),
    );
    expect(mapped(dated).envelope.customers[0]).toMatchObject({
      monthlyFee: 200_000,
      lastPaymentDate: "2026-10-01",
    });
  });

  test("reading stops at the first blank row, and says how much it left", () => {
    const blank = HEADERS.map(() => null);
    const total: Cell[] = ["Total", null, null, "350000", null, "450000", null, null, null, "13086"];
    const { envelope, summary } = mapped(sheet([...ROWS, blank, total]));
    expect(envelope.customers).toHaveLength(3);
    expect(summary.rowsNotRead).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain("13086");
  });

  test("trailing blank rows are not counted as unread", () => {
    const blank = HEADERS.map(() => null);
    expect(mapped(sheet([...ROWS, blank, blank])).summary.rowsNotRead).toBe(0);
  });

  test("a CSV export read from bytes maps end to end", () => {
    const csv = [
      "﻿Clinic;Market;Status;Monthly fee;Last payment;Owed;Contract date;BAA date;Director",
      '"SECRET CLINIC; ALPHA";KZ;Active;200 000;01.10.2026;0;;;SECRET PERSON ONE',
      "SECRET CLINIC BETA;US;Paused;;;;;03.03.2026;",
      "",
    ].join("\r\n");
    const { envelope, summary } = mapped(readSheet(new TextEncoder().encode(csv), 1));
    expect(envelope.customers).toEqual([
      {
        name: "SECRET CLINIC; ALPHA",
        market: "kz",
        status: "active",
        monthlyFee: 200_000,
        lastPaymentDate: "2026-10-01",
        amountOwed: 0,
      },
      { name: "SECRET CLINIC BETA", market: "us", status: "paused", baaDate: "2026-03-03" },
    ]);
    expect(summary.columnsNotRead).toEqual(["Director"]);
  });
});

describe("customersToEnvelope: refusals", () => {
  test("a missing column is named by the heading the config expects", () => {
    const headers = HEADERS.filter((h) => h !== "Owed" && h !== "BAA date");
    expect(problems(sheet(ROWS, headers))).toEqual([
      'The sheet has no "Owed" column.',
      'The sheet has no "BAA date" column.',
    ]);
  });

  test("a heading that appears twice is refused", () => {
    expect(problems(sheet(ROWS, [...HEADERS, "Market"]))).toEqual([
      'The sheet has 2 columns headed "Market".',
    ]);
  });

  test.each([
    ["an unknown market", 1, "SECRET REGION", 'Column "Market": not a market this script knows (1 row: 2).'],
    ["a blank market", 1, null, 'Column "Market": not a market this script knows (1 row: 2).'],
    ["an unknown status", 2, "SECRET STATUS", 'Column "Status": not a status this script knows (1 row: 2).'],
    ["a fee that is not a number", 3, "SECRET 200 000", 'Column "Monthly fee": not a number, or negative (1 row: 2).'],
    // A thousands mark or a decimal mark? Refused, not guessed at.
    ["a fee with two readings", 3, "200,000", 'Column "Monthly fee": not a number, or negative (1 row: 2).'],
    ["a fee with a currency sign", 3, "₸200000", 'Column "Monthly fee": not a number, or negative (1 row: 2).'],
    ["a negative balance", 5, "-5", 'Column "Owed": not a number, or negative (1 row: 2).'],
    ["a negative balance as a number", 5, -5, 'Column "Owed": not a number, or negative (1 row: 2).'],
    ["a date that is not one", 4, "SECRET soon", 'Column "Last payment": not a date (1 row: 2).'],
    ["a date that does not exist", 4, "31.02.2026", 'Column "Last payment": not a date (1 row: 2).'],
    // January or October? Refused, not guessed at.
    ["a date with two readings", 4, "10/01/2026", 'Column "Last payment": not a date (1 row: 2).'],
    ["a date left as a day number", 6, "45000", 'Column "Contract date": not a date (1 row: 2).'],
    ["a date left as a number", 6, 45_000, 'Column "Contract date": not a date (1 row: 2).'],
    ["a name that is a number", 0, 42, 'Column "Clinic": no clinic name (1 row: 2).'],
    ["a name too long", 0, "SECRET ".repeat(40), 'Column "Clinic": a name over 200 characters (1 row: 2).'],
  ])("%s is refused by column and row, never by value", (_label, column, value, message) => {
    const result = problems(withCell(0, column, value));
    expect(result).toEqual([message]);
    expect(result.join("\n")).not.toContain("SECRET");
  });

  test.each([
    ["a line feed", "SECRET CLINIC ALPHA\nSECRET CLINIC BETA,US,Active"],
    ["a carriage return", "SECRET CLINIC ALPHA\rSECRET CLINIC BETA"],
    ["CRLF", "SECRET CLINIC ALPHA\r\n"],
  ])("a name with %s in it is refused: a stray quote has swallowed the rows after it", (_label, name) => {
    // An unbalanced quote makes one cell of everything up to the next quote.
    // Sent as it is, the clinics inside that cell would be archived.
    const result = problems(withCell(1, 0, name));
    expect(result).toEqual(["Row 3: a name spans more than one line; check the file's quotes."]);
    expect(result.join("\n")).not.toContain("SECRET");
  });

  test("a CSV with a stray quote in a name is refused end to end", () => {
    const csv = [
      "Clinic,Market,Status,Monthly fee,Last payment,Owed,Contract date,BAA date",
      'SECRET CLINIC ALPHA,kz,active,1,,,,',
      '"SECRET CLINIC BETA,us,active,1,,,,',
      'SECRET CLINIC GAMMA,kz,active,1,,,,',
      'SECRET CLINIC "DELTA",kz,active,1,,,,',
    ].join("\n");
    const result = problems(readSheet(new TextEncoder().encode(csv), 1));
    expect(result).toEqual(["Row 3: a name spans more than one line; check the file's quotes."]);
  });

  test("a line break in a column that is not read is not this script's business", () => {
    const rows = ROWS.map((cells, r) => cells.map((cell, c) => (r === 0 && c === 8 ? "SECRET\nPERSON" : cell)));
    expect(mapped(sheet(rows)).summary.clinics).toBe(3);
  });

  test("the same problem on several rows is one line with their numbers", () => {
    const bad = sheet(ROWS.map((cells) => cells.map((cell, c) => (c === 1 ? "Mars" : cell))));
    expect(problems(bad)).toEqual([
      'Column "Market": not a market this script knows (3 rows: 2, 3, 4).',
    ]);
  });

  test("a row with data but no name is refused, not skipped", () => {
    expect(problems(withCell(1, 0, null))).toEqual(['Column "Clinic": no clinic name (1 row: 3).']);
  });

  test("a bad cell refuses the whole push: the clinic is not sent without it", () => {
    const result = customersToEnvelope(withCell(0, 3, "200,000"), NOW, CONFIG);
    expect(result.ok).toBe(false);
    expect("envelope" in result).toBe(false);
  });

  test("a sheet with no clinics is refused", () => {
    expect(problems(sheet([]))).toEqual(["The sheet holds no clinics below its header row."]);
  });

  test('a market written "constructor" finds no word', () => {
    expect(problems(withCell(0, 1, "constructor"))).toEqual([
      'Column "Market": not a market this script knows (1 row: 2).',
    ]);
  });
});

describe("the shipped column mapping", () => {
  test("is the assumed one: eight columns, and nothing about patients, staff or contacts", () => {
    // Nobody has seen the register's headings yet. This fails when the
    // mapping is confirmed and changed, which is the moment to re-read the
    // allow-list.
    expect(Object.keys(REGISTER.columns).sort()).toEqual([
      "amountOwed",
      "baaDate",
      "contractDate",
      "lastPaymentDate",
      "market",
      "monthlyFee",
      "name",
      "status",
    ]);
  });
});
