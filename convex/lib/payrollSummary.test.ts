import { describe, expect, test } from "vitest";
import {
  PayrollCycleError,
  draftRows,
  summarise,
  totalsOf,
  type PayPerson,
  type CurrencySummary,
  type PayrollLineRow,
  type SummaryTotals,
} from "./payroll";

// Every rate, salary and name here is made up. None is a statutory figure.

const OCT = "2026-10-01";

const person = (id: string, extra: Partial<PayPerson> = {}): PayPerson => ({
  id,
  name: id,
  kind: "employee",
  currency: "KZT",
  payBasis: "net",
  monthlyNet: 450_000_00,
  order: 0,
  ...extra,
});
const byGross = (id: string, extra: Partial<PayPerson> = {}) =>
  person(id, { payBasis: "gross", monthlyNet: null, monthlyGross: 500_000_00, ...extra });
const line = (id: string, extra: Partial<PayrollLineRow> = {}): PayrollLineRow => ({
  id,
  name: id,
  appliesTo: "employee",
  paidBy: "employee",
  rateBp: 1000,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  order: 0,
  active: true,
  ...extra,
});

const PENSION = line("pension");
const LEVY = line("levy", { paidBy: "company", rateBp: 350, order: 1 });
const PENSION_UNSET = line("pension", { rateBp: null });
const LEVY_UNSET = line("levy", { paidBy: "company", rateBp: null, order: 1 });

/** The summary, the company's currency first; a test that reads a second set expects one. */
const sum = (
  people: PayPerson[],
  lines: PayrollLineRow[],
  month = OCT,
): [CurrencySummary, CurrencySummary, ...CurrencySummary[]] => {
  const sets = summarise({ people, lines, month, companyCurrency: "KZT" });
  return sets as [CurrencySummary, CurrencySummary, ...CurrencySummary[]];
};
/** A figure known for everyone. */
const all = (totals: SummaryTotals, figure: "net" | "gross" | "withheld" | "companyPaid" | "cost") =>
  totals[figure].known === totals.people ? totals[figure].sum : "incomplete";
const NO_GAPS = {
  withheldRates: 0,
  grossBlocked: 0,
  withheldBlocked: 0,
  companyRates: 0,
  companyBlocked: 0,
  otherCurrency: 0,
  noGross: 0,
  dependent: 0,
};

describe("summarise: what payroll comes to, at today's pay and rates", () => {
  test("nobody: the company's currency is there, with nothing in it and nothing missing", () => {
    const sets = sum([], [PENSION, LEVY]);
    expect(sets).toHaveLength(1);
    const [set] = sets;
    expect(set.currency).toBe("KZT");
    expect(set.overall).toEqual({
      people: 0,
      net: { sum: 0, known: 0 },
      gross: { sum: 0, known: 0 },
      withheld: { sum: 0, known: 0 },
      companyPaid: { sum: 0, known: 0 },
      cost: { sum: 0, known: 0 },
    });
    expect(set.gaps).toEqual(NO_GAPS);
  });

  test("every rate set: each figure is known for everyone, net- and gross-based alike", () => {
    const people = [
      person("a"),
      byGross("b", { order: 1 }),
      byGross("c", { kind: "contractor", monthlyGross: 200_000_00, order: 2 }),
    ];
    const [set] = sum(people, [PENSION, LEVY]);
    // a: a net of 450,000 at 10% withheld is a gross of 500,000. b the same,
    // entered as gross. c is a contractor, and no line applies to contractors.
    expect(set.overall).toEqual({
      people: 3,
      net: { sum: 450_000_00 + 450_000_00 + 200_000_00, known: 3 },
      gross: { sum: 500_000_00 + 500_000_00 + 200_000_00, known: 3 },
      withheld: { sum: 50_000_00 + 50_000_00, known: 3 },
      companyPaid: { sum: 17_500_00 + 17_500_00, known: 3 },
      cost: { sum: 517_500_00 + 517_500_00 + 200_000_00, known: 3 },
    });
    expect(set.byKind.employee.people).toBe(2);
    expect(all(set.byKind.employee, "cost")).toBe(1_035_000_00);
    expect(set.byKind.contractor).toEqual({
      people: 1,
      net: { sum: 200_000_00, known: 1 },
      gross: { sum: 200_000_00, known: 1 },
      withheld: { sum: 0, known: 1 },
      companyPaid: { sum: 0, known: 1 },
      cost: { sum: 200_000_00, known: 1 },
    });
    expect(set.gaps).toEqual(NO_GAPS);
  });

  test("it is the month's own arithmetic: the same totals a prepared month would freeze", () => {
    const people = [
      person("a", { monthlyNet: 333_333_33 }),
      byGross("b", { monthlyGross: 777_777_77, order: 1 }),
      byGross("c", { kind: "contractor", order: 2 }),
    ];
    const lines = [
      PENSION,
      line("tax", { rateBp: 1234, lessLineIds: ["pension"], allowance: 10_000_00, order: 1 }),
      line("levy", { paidBy: "company", rateBp: 350, baseCap: 600_000_00, order: 2 }),
      line("c-tax", { appliesTo: "contractor", rateBp: 500 }),
    ];
    const [set] = sum(people, lines);
    const frozen = totalsOf(
      draftRows({ people, lines, month: OCT, companyCurrency: "KZT" }),
      "KZT",
    )[0]!;
    for (const [mine, theirs] of [
      [set.overall, frozen.overall],
      [set.byKind.employee, frozen.byKind.employee],
      [set.byKind.contractor, frozen.byKind.contractor],
    ] as const) {
      expect(theirs.notComputed).toBe(0);
      expect(mine.people).toBe(theirs.people);
      expect(all(mine, "net")).toBe(theirs.net);
      expect(all(mine, "gross")).toBe(theirs.gross);
      expect(all(mine, "withheld")).toBe(theirs.withheld);
      expect(all(mine, "companyPaid")).toBe(theirs.companyPaid);
      expect(all(mine, "cost")).toBe(theirs.cost);
    }
  });

  test("entered as net with no rate set: the net is what was typed, and nothing else is known", () => {
    const people = [person("a"), person("b", { monthlyNet: 300_000_00, order: 1 })];
    const [set] = sum(people, [PENSION_UNSET, line("tax", { rateBp: null, order: 1 }), LEVY_UNSET]);
    expect(set.overall).toEqual({
      people: 2,
      net: { sum: 750_000_00, known: 2 },
      gross: { sum: 0, known: 0 },
      withheld: { sum: 0, known: 0 },
      companyPaid: { sum: 0, known: 0 },
      cost: { sum: 0, known: 0 },
    });
    expect(set.gaps).toEqual({
      ...NO_GAPS,
      withheldRates: 2,
      grossBlocked: 2,
      companyRates: 1,
      companyBlocked: 2,
    });
  });

  test("entered as gross with a withheld rate not set: gross is known, withheld and net are not", () => {
    const [set] = sum([byGross("a")], [PENSION_UNSET, LEVY]);
    expect(set.overall).toEqual({
      people: 1,
      net: { sum: 0, known: 0 },
      gross: { sum: 500_000_00, known: 1 },
      withheld: { sum: 0, known: 0 },
      companyPaid: { sum: 17_500_00, known: 1 },
      cost: { sum: 517_500_00, known: 1 },
    });
    expect(set.gaps).toEqual({ ...NO_GAPS, withheldRates: 1, withheldBlocked: 1 });
  });

  test("net- and gross-based together, a withheld rate not set: each keeps what it knows", () => {
    const people = [person("a"), byGross("b", { order: 1 }), byGross("c", { order: 2 })];
    const [set] = sum(people, [PENSION_UNSET, LEVY]);
    expect(set.overall).toEqual({
      people: 3,
      // Only the net that was typed. The two entered as gross have none yet.
      net: { sum: 450_000_00, known: 1 },
      gross: { sum: 1_000_000_00, known: 2 },
      withheld: { sum: 0, known: 0 },
      companyPaid: { sum: 35_000_00, known: 2 },
      cost: { sum: 1_035_000_00, known: 2 },
    });
    expect(set.gaps).toEqual({
      ...NO_GAPS,
      withheldRates: 1,
      grossBlocked: 1,
      withheldBlocked: 2,
    });
  });

  test("only a company-paid rate not set: net, gross and withheld are known, the cost is not", () => {
    const people = [person("a"), byGross("b", { order: 1 })];
    const [set] = sum(people, [PENSION, LEVY_UNSET]);
    expect(set.overall).toEqual({
      people: 2,
      net: { sum: 900_000_00, known: 2 },
      gross: { sum: 1_000_000_00, known: 2 },
      withheld: { sum: 100_000_00, known: 2 },
      companyPaid: { sum: 0, known: 0 },
      cost: { sum: 0, known: 0 },
    });
    expect(set.gaps).toEqual({ ...NO_GAPS, companyRates: 1, companyBlocked: 2 });
  });

  test("an unset rate counts only where it applies to someone in view", () => {
    // The contractor line has no rate, and there is no contractor.
    const [set] = sum([person("a")], [PENSION, LEVY, line("c-tax", { appliesTo: "contractor", rateBp: null })]);
    expect(all(set.overall, "cost")).toBe(517_500_00);
    expect(set.gaps).toEqual(NO_GAPS);
    // A line that is switched off is no line.
    const [off] = sum([person("a")], [PENSION, LEVY, line("tax", { rateBp: null, active: false, order: 2 })]);
    expect(all(off.overall, "cost")).toBe(517_500_00);
  });

  test("a kind with every rate set is whole even when the other kind is not", () => {
    const people = [person("a"), person("c", { kind: "contractor", monthlyNet: 190_000_00, order: 1 })];
    const lines = [PENSION_UNSET, line("c-tax", { appliesTo: "contractor", rateBp: 500 })];
    const [set] = sum(people, lines);
    // 200,000 less 5% is 190,000.
    expect(all(set.byKind.contractor, "gross")).toBe(200_000_00);
    expect(all(set.byKind.contractor, "cost")).toBe(200_000_00);
    expect(all(set.byKind.employee, "gross")).toBe("incomplete");
    expect(set.overall.gross).toEqual({ sum: 200_000_00, known: 1 });
    expect(set.overall.net).toEqual({ sum: 640_000_00, known: 2 });
    expect(set.gaps).toEqual({ ...NO_GAPS, withheldRates: 1, grossBlocked: 1 });
  });

  test("someone paid in another currency is totalled apart, never added in", () => {
    const people = [person("a"), byGross("u", { currency: "USD", monthlyGross: 4_000_00, order: 1 })];
    const [kzt, usd, ...others] = sum(people, [PENSION, LEVY]);
    expect(others).toEqual([]);
    expect(kzt.currency).toBe("KZT");
    expect(kzt.overall.people).toBe(1);
    expect(all(kzt.overall, "cost")).toBe(517_500_00);
    expect(usd.currency).toBe("USD");
    expect(usd.overall).toEqual({
      people: 1,
      net: { sum: 3_600_00, known: 1 },
      gross: { sum: 4_000_00, known: 1 },
      withheld: { sum: 400_00, known: 1 },
      companyPaid: { sum: 140_00, known: 1 },
      cost: { sum: 4_140_00, known: 1 },
    });
  });

  test("another currency and a line with a cap: not computed there, so not known there", () => {
    const people = [person("a"), byGross("u", { currency: "USD", monthlyGross: 4_000_00, order: 1 })];
    const capped = line("levy", { paidBy: "company", rateBp: 350, baseCap: 400_000_00, order: 1 });
    const [kzt, usd] = sum(people, [PENSION, capped]);
    expect(all(kzt.overall, "cost")).toBe(500_000_00 + 14_000_00);
    expect(kzt.gaps).toEqual(NO_GAPS);
    expect(usd.overall.net).toEqual({ sum: 3_600_00, known: 1 });
    expect(usd.overall.companyPaid).toEqual({ sum: 0, known: 0 });
    expect(usd.overall.cost).toEqual({ sum: 0, known: 0 });
    expect(usd.gaps).toEqual({ ...NO_GAPS, otherCurrency: 1 });
  });

  test("people outside the month and archived people are not in it", () => {
    const people = [
      person("in"),
      person("starts-later", { startDate: "2026-11-01", order: 1 }),
      person("ended", { endDate: "2026-09-30", order: 2 }),
      person("archived", { archivedAt: 1, order: 3 }),
      person("starts-last-day", { startDate: "2026-10-31", order: 4 }),
      person("ends-first-day", { endDate: "2026-10-01", order: 5 }),
    ];
    const [set] = sum(people, [PENSION, LEVY]);
    expect(set.overall.people).toBe(3);
    expect(all(set.overall, "net")).toBe(3 * 450_000_00);
    // Another month, other people.
    const [nov] = sum(people, [PENSION, LEVY], "2026-11-01");
    expect(nov.overall.people).toBe(3);
  });

  test("withheld rates that leave no gross: said, and not a zero", () => {
    const [set] = sum([person("a")], [line("all", { rateBp: 10_000 })]);
    expect(set.overall.gross).toEqual({ sum: 0, known: 0 });
    expect(set.overall.net).toEqual({ sum: 450_000_00, known: 1 });
    expect(set.gaps).toEqual({ ...NO_GAPS, noGross: 1 });
  });

  test("a line taken on pay less a line with no amount is not known either", () => {
    // The levy is on gross less the pension, and the pension has no rate: the
    // arithmetic takes nothing off, so the levy it gives is not the levy.
    const levy = line("levy", { paidBy: "company", rateBp: 350, lessLineIds: ["pension"], order: 1 });
    const [set] = sum([byGross("a")], [PENSION_UNSET, levy]);
    expect(set.overall.gross).toEqual({ sum: 500_000_00, known: 1 });
    expect(set.overall.companyPaid).toEqual({ sum: 0, known: 0 });
    expect(set.overall.cost).toEqual({ sum: 0, known: 0 });
    expect(set.gaps).toEqual({ ...NO_GAPS, withheldRates: 1, withheldBlocked: 1, dependent: 1 });

    // And a net's gross, where a withheld line is less a company line with no rate.
    const tax = line("tax", { rateBp: 1000, lessLineIds: ["levy"], order: 1 });
    const [other] = sum([person("a")], [line("levy", { paidBy: "company", rateBp: null }), tax]);
    expect(other.overall.net).toEqual({ sum: 450_000_00, known: 1 });
    expect(other.overall.gross).toEqual({ sum: 0, known: 0 });
    expect(other.overall.cost).toEqual({ sum: 0, known: 0 });
    expect(other.gaps).toEqual({ ...NO_GAPS, companyRates: 1, companyBlocked: 1, dependent: 1 });
  });

  test("lines that subtract each other in a circle are refused, as a month is", () => {
    const a = line("a", { lessLineIds: ["b"] });
    const b = line("b", { lessLineIds: ["a"], order: 1 });
    expect(() => sum([byGross("p")], [a, b])).toThrow(PayrollCycleError);
  });
});

describe("summarise with the month's adjustments", () => {
  test("a bonus or deduction is in net and cost, never in a base", () => {
    const people = [byGross("a"), byGross("b", { kind: "contractor", order: 1 })];
    const [set] = summarise({
      people,
      lines: [PENSION, LEVY],
      month: OCT,
      companyCurrency: "KZT",
      adjustments: new Map([
        ["a", { amount: 10_000_00 }],
        ["b", { amount: -1_000_00 }],
      ]),
    });
    // a: 500,000 − 50,000 + 10,000; b has no contractor lines: 500,000 − 1,000.
    expect(all(set!.overall, "net")).toBe(460_000_00 + 499_000_00);
    expect(all(set!.overall, "withheld")).toBe(50_000_00);
    expect(all(set!.byKind.employee, "cost")).toBe(500_000_00 + 17_500_00 + 10_000_00);
    expect(all(set!.byKind.contractor, "cost")).toBe(499_000_00);
  });
});
