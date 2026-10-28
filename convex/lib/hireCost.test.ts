import { describe, expect, test } from "vitest";
import { hireCost } from "./hireCost";
import type { PayrollLineRow } from "./payroll";

// Made-up lines and rates: no rate of any tax law is written here.

const line = (extra: Partial<PayrollLineRow> & Pick<PayrollLineRow, "id" | "paidBy">): PayrollLineRow => ({
  name: `Made-up ${extra.id}`,
  rateBp: 1_000,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  appliesTo: "employee",
  order: 0,
  active: true,
  ...extra,
});

const lines = [
  line({ id: "w", paidBy: "employee", rateBp: 1_000 }), // 10% withheld
  line({ id: "c", paidBy: "company", rateBp: 500, order: 1 }), // 5% on top
  line({ id: "off", paidBy: "company", rateBp: 9_000, active: false }),
  line({ id: "contract", paidBy: "company", rateBp: 9_000, appliesTo: "contractor" }),
];

describe("a hire's monthly total cost from the payroll rates", () => {
  test("from a gross: gross plus what the company pays", () => {
    expect(hireCost({ salary: 1_000_00, basis: "gross", sameCurrency: true, lines })).toEqual({
      known: true,
      gross: 1_000_00,
      cost: 1_050_00,
    });
  });

  test("from a net: the gross that leaves that net, then the company's lines on it", () => {
    // 900 net after 10% withheld is 1,000 gross; 5% on top is 1,050.
    expect(hireCost({ salary: 900_00, basis: "net", sameCurrency: true, lines })).toEqual({
      known: true,
      gross: 1_000_00,
      cost: 1_050_00,
    });
  });

  test("a company line with no rate: not known, never the cost without it", () => {
    const unset = [lines[0]!, line({ id: "c", paidBy: "company", rateBp: null })];
    expect(hireCost({ salary: 1_000_00, basis: "gross", sameCurrency: true, lines: unset })).toEqual({
      known: false,
      reason: "rate_not_set",
    });
  });

  test("a withheld line with no rate leaves a net's gross unknown", () => {
    const unset = [line({ id: "w", paidBy: "employee", rateBp: null })];
    expect(hireCost({ salary: 900_00, basis: "net", sameCurrency: true, lines: unset })).toEqual({
      known: false,
      reason: "rate_not_set",
    });
  });

  test("no lines: the gross is the cost", () => {
    expect(hireCost({ salary: 700_00, basis: "gross", sameCurrency: true, lines: [] })).toEqual({
      known: true,
      gross: 700_00,
      cost: 700_00,
    });
  });
});
