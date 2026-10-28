import { describe, expect, test } from "vitest";
import {
  PayrollCycleError,
  TIME_SHARE_RANGE,
  TIME_SHARES_OVER,
  activeIn,
  computePerson,
  draftRows,
  findCycle,
  linesFor,
  rateAmount,
  rowSums,
  sameRows,
  timeSharesProblem,
  totalsOf,
  withAdjustment,
  type PayLine,
  type PayRow,
} from "./payroll";

// Every rate, salary and name here is made up. None is a statutory figure.

const line = (id: string, extra: Partial<PayLine> = {}): PayLine => ({
  id,
  name: id,
  paidBy: "employee",
  rateBp: 1000,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  ...extra,
});
const person = (gross: number, lines: PayLine[], adjustment = 0, sameCurrency = true) =>
  computePerson({ gross, adjustment, sameCurrency, lines });

describe("rateAmount: base × rate, rounded half up to a whole minor unit", () => {
  test.each([
    [12_345, 1250, 1543], // 1543.125
    [10, 500, 1], // 0.5 rounds up
    [30, 500, 2], // 1.5 rounds up
    [49, 100, 0], // 0.49
    [50, 100, 1], // 0.5
    [100_000, 0, 0],
    [100_000, 10_000, 100_000],
    [0, 1250, 0],
    [33_333, 3333, 11_110], // 11109.8889
  ])("%i at %i bp is %i", (base, rateBp, amount) => {
    expect(rateAmount(base, rateBp)).toBe(amount);
  });

  test("stays exact where base × rate is past what a double holds", () => {
    // 9,007,199,254,740,991 × 9999 / 10000, worked out with whole numbers.
    const base = Number.MAX_SAFE_INTEGER;
    const exact = (BigInt(base) * BigInt(9999) + BigInt(5000)) / BigInt(10000);
    expect(BigInt(rateAmount(base, 9999))).toBe(exact);
  });
});

describe("computePerson", () => {
  test("net is gross less what is withheld; cost is gross plus what the company pays", () => {
    const result = person(500_000_00, [
      line("pension", { rateBp: 1000 }),
      line("levy", { rateBp: 350, paidBy: "company" }),
    ]);
    expect(result.lines).toEqual([
      { name: "pension", paidBy: "employee", rateBp: 1000, base: 500_000_00, amount: 50_000_00 },
      { name: "levy", paidBy: "company", rateBp: 350, base: 500_000_00, amount: 17_500_00 },
    ]);
    expect(result).toMatchObject({
      withheld: 50_000_00,
      companyPaid: 17_500_00,
      net: 450_000_00,
      cost: 517_500_00,
      notComputed: 0,
    });
  });

  test("a line's base is gross less the amounts of the lines it names", () => {
    const result = person(400_000_00, [
      line("pension", { rateBp: 1000 }),
      line("medical", { rateBp: 200 }),
      line("income", { rateBp: 1000, lessLineIds: ["pension", "medical"] }),
    ]);
    // 400,000 − 40,000 − 8,000 = 352,000; a tenth of it is 35,200.
    expect(result.lines[2]).toMatchObject({ base: 352_000_00, amount: 35_200_00 });
    expect(result.net).toBe(400_000_00 - 40_000_00 - 8_000_00 - 35_200_00);
  });

  test("a line named before the one it subtracts is still worked out after it", () => {
    const result = person(100_000, [
      line("income", { rateBp: 1000, lessLineIds: ["pension"] }),
      line("pension", { rateBp: 1000 }),
    ]);
    expect(result.lines.map((l) => [l.name, l.base, l.amount])).toEqual([
      ["income", 90_000, 9_000],
      ["pension", 100_000, 10_000],
    ]);
  });

  test("the allowance comes off the base", () => {
    const result = person(300_000_00, [line("income", { rateBp: 1000, allowance: 50_000_00 })]);
    expect(result.lines[0]).toMatchObject({ base: 250_000_00, amount: 25_000_00 });
  });

  test("a base never goes below zero", () => {
    const result = person(40_000_00, [line("income", { rateBp: 1000, allowance: 50_000_00 })]);
    expect(result.lines[0]).toMatchObject({ base: 0, amount: 0 });
    expect(result.net).toBe(40_000_00);
  });

  test("a cap holds the base down, after the subtractions", () => {
    const result = person(900_000_00, [
      line("pension", { rateBp: 1000, baseCap: 500_000_00 }),
      line("income", { rateBp: 1000, lessLineIds: ["pension"], allowance: 10_000_00, baseCap: 700_000_00 }),
    ]);
    expect(result.lines[0]).toMatchObject({ base: 500_000_00, amount: 50_000_00 });
    // 900,000 − 50,000 − 10,000 = 840,000, capped at 700,000.
    expect(result.lines[1]).toMatchObject({ base: 700_000_00, amount: 70_000_00 });
  });

  test("a cap above the base changes nothing", () => {
    const result = person(100_000, [line("pension", { baseCap: 500_000 })]);
    expect(result.lines[0]).toMatchObject({ base: 100_000, amount: 10_000 });
  });

  test("a line with no rate contributes nothing and is counted as not computed", () => {
    const result = person(200_000, [
      line("pension", { rateBp: null }),
      line("levy", { rateBp: 500, paidBy: "company" }),
    ]);
    expect(result.lines[0]).toEqual({
      name: "pension",
      paidBy: "employee",
      base: 200_000,
      skipped: "rate_not_set",
    });
    expect(result).toMatchObject({ withheld: 0, net: 200_000, cost: 210_000, notComputed: 1 });
  });

  test("a rate of zero is a rate: computed, and nothing is missing", () => {
    const result = person(200_000, [line("pension", { rateBp: 0 })]);
    expect(result.lines[0]).toMatchObject({ rateBp: 0, amount: 0 });
    expect(result.lines[0]).not.toHaveProperty("skipped");
    expect(result.notComputed).toBe(0);
  });

  test("a line with no rate takes nothing off the base of a line that names it", () => {
    const result = person(100_000, [
      line("pension", { rateBp: null }),
      line("income", { rateBp: 1000, lessLineIds: ["pension"] }),
    ]);
    expect(result.lines[1]).toMatchObject({ base: 100_000, amount: 10_000 });
    expect(result.notComputed).toBe(1);
  });

  test("a line it names that is not among the lines (switched off, deleted) takes nothing off", () => {
    const result = person(100_000, [line("income", { lessLineIds: ["gone"] })]);
    expect(result.lines[0]).toMatchObject({ base: 100_000, amount: 10_000 });
  });

  test("a bonus is added after the lines: it raises net and cost and no base", () => {
    const result = person(100_000, [line("pension"), line("levy", { paidBy: "company" })], 25_000);
    expect(result.lines.map((l) => l.base)).toEqual([100_000, 100_000]);
    expect(result).toMatchObject({ net: 115_000, cost: 135_000 });
  });

  test("a deduction lowers net and cost", () => {
    const result = person(100_000, [line("pension")], -30_000);
    expect(result).toMatchObject({ net: 60_000, cost: 70_000 });
  });

  test("nobody with no lines: net and cost are the gross", () => {
    expect(person(123_456, [])).toEqual({
      lines: [],
      withheld: 0,
      companyPaid: 0,
      net: 123_456,
      cost: 123_456,
      notComputed: 0,
    });
  });

  test("an allowance or a cap is in the company's currency: not applied to someone paid in another", () => {
    const lines = [
      line("income", { allowance: 5_000 }),
      line("pension", { baseCap: 50_000 }),
      line("plain", { rateBp: 100 }),
    ];
    const result = person(100_000, lines, 0, false);
    expect(result.lines[0]).toEqual({
      name: "income",
      paidBy: "employee",
      rateBp: 1000,
      skipped: "other_currency",
    });
    expect(result.lines[1]).toMatchObject({ skipped: "other_currency" });
    // A plain percentage of gross needs no conversion.
    expect(result.lines[2]).toMatchObject({ base: 100_000, amount: 1_000 });
    expect(result).toMatchObject({ withheld: 1_000, notComputed: 2 });
  });

  test("lines that subtract each other in a circle are refused, not guessed at", () => {
    const circle = [line("a", { lessLineIds: ["b"] }), line("b", { lessLineIds: ["a"] })];
    expect(() => person(100_000, circle)).toThrow(PayrollCycleError);
    expect(() => person(100_000, circle)).toThrow("Those lines subtract each other in a circle.");
  });
});

describe("findCycle", () => {
  const edges = (pairs: Record<string, string[]>) =>
    Object.entries(pairs).map(([id, lessLineIds]) => ({ id, lessLineIds }));

  test("none in a chain or a diamond", () => {
    expect(findCycle(edges({ a: ["b"], b: ["c"], c: [] }))).toBeNull();
    expect(findCycle(edges({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }))).toBeNull();
  });

  test("a line that names itself", () => {
    expect(findCycle(edges({ a: ["a"] }))).toEqual(["a"]);
  });

  test("two lines, and a longer loop behind a line outside it", () => {
    expect(findCycle(edges({ a: ["b"], b: ["a"] }))?.sort()).toEqual(["a", "b"]);
    expect(findCycle(edges({ start: ["a"], a: ["b"], b: ["c"], c: ["a"] }))?.sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a name that is no line is not a loop", () => {
    expect(findCycle(edges({ a: ["gone"] }))).toBeNull();
  });
});

describe("activeIn: who a month's payroll holds", () => {
  const MONTH = "2026-09-01";
  test.each([
    [{}, true],
    [{ startDate: "2026-09-30" }, true], // started on its last day
    [{ startDate: "2026-10-01" }, false], // starts the month after
    [{ startDate: "2025-01-15" }, true],
    [{ endDate: "2026-09-01" }, true], // ended on its first day
    [{ endDate: "2026-08-31" }, false], // ended the day before it began
    [{ startDate: "2026-09-10", endDate: "2026-09-20" }, true],
    [{ archivedAt: 5 }, false],
  ])("%j → %s", (dates, expected) => {
    expect(activeIn(dates, MONTH)).toBe(expected);
  });

  test("February's last day", () => {
    expect(activeIn({ startDate: "2028-02-29" }, "2028-02-01")).toBe(true);
    expect(activeIn({ startDate: "2028-03-01" }, "2028-02-01")).toBe(false);
  });
});

describe("linesFor", () => {
  const stored = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    appliesTo: "employee" as const,
    paidBy: "employee" as const,
    rateBp: 1000 as number | null,
    lessLineIds: [],
    allowance: 0,
    baseCap: null,
    order: 0,
    active: true,
    ...extra,
  });

  test("a kind's lines that are switched on, in order", () => {
    const lines = [
      stored("third", { order: 3 }),
      stored("off", { order: 1, active: false }),
      stored("contractor", { order: 0, appliesTo: "contractor" }),
      stored("first", { order: 2 }),
    ];
    expect(linesFor(lines, "employee").map((l) => l.id)).toEqual(["first", "third"]);
    expect(linesFor(lines, "contractor").map((l) => l.id)).toEqual(["contractor"]);
  });
});

// ── Rows and totals ─────────────────────────────────────────────────────────

const row = (extra: Partial<PayRow> & { personId: string }): PayRow => ({
  name: `Person ${extra.personId}`,
  kind: "employee",
  currency: "KZT",
  gross: 100_000,
  lines: [
    { name: "pension", paidBy: "employee", rateBp: 1000, base: 100_000, amount: 10_000 },
    { name: "levy", paidBy: "company", rateBp: 500, base: 100_000, amount: 5_000 },
  ],
  net: 90_000,
  cost: 105_000,
  ...extra,
});

describe("rowSums", () => {
  test("what a saved row's lines come to", () => {
    expect(rowSums(row({ personId: "p1" }))).toEqual({
      withheld: 10_000,
      companyPaid: 5_000,
      rateNotSet: 0,
      otherCurrency: 0,
      grossUnknown: 0,
      notComputed: 0,
    });
  });

  test("lines left out are counted by why", () => {
    const sums = rowSums(
      row({
        personId: "p1",
        lines: [
          { name: "a", paidBy: "employee", base: 1, skipped: "rate_not_set" },
          { name: "b", paidBy: "company", base: 1, skipped: "rate_not_set" },
          { name: "c", paidBy: "company", rateBp: 1, skipped: "other_currency" },
        ],
      }),
    );
    expect(sums).toMatchObject({ withheld: 0, rateNotSet: 2, otherCurrency: 1, notComputed: 3 });
  });
});

describe("totalsOf", () => {
  test("by kind and overall, in one currency", () => {
    const totals = totalsOf(
      [
        row({ personId: "p1" }),
        row({ personId: "p2", adjustment: 20_000, net: 110_000, cost: 125_000 }),
        row({ personId: "p3", kind: "contractor", gross: 50_000, lines: [], net: 50_000, cost: 50_000 }),
      ],
      "KZT",
    );
    expect(totals).toEqual([
      {
        currency: "KZT",
        byKind: {
          employee: {
            people: 2,
            gross: 200_000,
            adjustment: 20_000,
            withheld: 20_000,
            net: 200_000,
            companyPaid: 10_000,
            cost: 230_000,
            notComputed: 0,
          },
          contractor: {
            people: 1,
            gross: 50_000,
            adjustment: 0,
            withheld: 0,
            net: 50_000,
            companyPaid: 0,
            cost: 50_000,
            notComputed: 0,
          },
        },
        overall: {
          people: 3,
          gross: 250_000,
          adjustment: 20_000,
          withheld: 20_000,
          net: 250_000,
          companyPaid: 10_000,
          cost: 280_000,
          notComputed: 0,
        },
      },
    ]);
  });

  test("two currencies are never added: each is totalled alone, the company's first", () => {
    const totals = totalsOf(
      [
        row({ personId: "p1", currency: "USD", gross: 700_000, lines: [], net: 700_000, cost: 700_000 }),
        row({ personId: "p2" }),
      ],
      "KZT",
    );
    expect(totals.map((t) => [t.currency, t.overall.people, t.overall.gross])).toEqual([
      ["KZT", 1, 100_000],
      ["USD", 1, 700_000],
    ]);
    // And the company's own currency is there even with nobody paid in it.
    expect(
      totalsOf([row({ personId: "p1", currency: "KZT" })], "USD").map((t) => [
        t.currency,
        t.overall.people,
      ]),
    ).toEqual([
      ["USD", 0],
      ["KZT", 1],
    ]);
  });

  test("lines not computed are carried into the totals, so they can be labelled incomplete", () => {
    const totals = totalsOf(
      [
        row({
          personId: "p1",
          lines: [{ name: "a", paidBy: "employee", base: 100_000, skipped: "rate_not_set" }],
          net: 100_000,
          cost: 100_000,
        }),
        row({ personId: "p2" }),
      ],
      "KZT",
    );
    expect(totals[0]!.overall.notComputed).toBe(1);
    expect(totals[0]!.byKind.contractor.notComputed).toBe(0);
  });

  test("no rows: the company's currency, all zeros", () => {
    expect(totalsOf([], "USD")[0]!.overall).toMatchObject({ people: 0, gross: 0, cost: 0 });
  });
});

describe("withAdjustment", () => {
  test("re-works net and cost from the row's own saved lines", () => {
    const next = withAdjustment(row({ personId: "p1" }), -15_000, "Advance repaid");
    expect(next).toMatchObject({
      adjustment: -15_000,
      adjustmentNote: "Advance repaid",
      net: 75_000,
      cost: 90_000,
    });
    expect(next.lines).toEqual(row({ personId: "p1" }).lines);
  });

  test("zero clears it, and the note with it", () => {
    const adjusted = withAdjustment(row({ personId: "p1" }), 5_000, "Bonus");
    const cleared = withAdjustment(adjusted, 0, "");
    expect(cleared).not.toHaveProperty("adjustment");
    expect(cleared).not.toHaveProperty("adjustmentNote");
    expect(cleared).toMatchObject({ net: 90_000, cost: 105_000 });
  });
});

describe("draftRows", () => {
  const people = [
    { id: "late", name: "Late Starter", kind: "employee" as const, currency: "KZT" as const, monthlyGross: 1, order: 0, startDate: "2026-10-01" },
    { id: "b", name: "Bea Example", title: "Engineer", kind: "employee" as const, currency: "KZT" as const, monthlyGross: 200_000, order: 2 },
    { id: "a", name: "Ada Example", kind: "contractor" as const, currency: "USD" as const, monthlyGross: 300_000, order: 1 },
  ];
  const lines = [
    { id: "pension", name: "Pension", appliesTo: "employee" as const, paidBy: "employee" as const, rateBp: 1000, lessLineIds: [], allowance: 0, baseCap: null, order: 0, active: true },
    { id: "fee", name: "Fee", appliesTo: "contractor" as const, paidBy: "company" as const, rateBp: 500, lessLineIds: [], allowance: 1_000, baseCap: null, order: 0, active: true },
  ];

  test("the people active in the month, in order, each with their kind's lines", () => {
    const rows = draftRows({ people, lines, month: "2026-09-01", companyCurrency: "KZT" });
    expect(rows).toEqual([
      {
        personId: "a",
        name: "Ada Example",
        kind: "contractor",
        currency: "USD",
        gross: 300_000,
        // The fee's allowance is in tenge; Ada is paid in dollars.
        lines: [{ name: "Fee", paidBy: "company", rateBp: 500, skipped: "other_currency" }],
        net: 300_000,
        cost: 300_000,
      },
      {
        personId: "b",
        name: "Bea Example",
        title: "Engineer",
        kind: "employee",
        currency: "KZT",
        gross: 200_000,
        lines: [{ name: "Pension", paidBy: "employee", rateBp: 1000, base: 200_000, amount: 20_000 }],
        net: 180_000,
        cost: 200_000,
      },
    ]);
  });

  test("an adjustment is kept for the person it was given to", () => {
    const rows = draftRows({
      people,
      lines,
      month: "2026-09-01",
      companyCurrency: "KZT",
      adjustments: new Map([
        ["b", { amount: 10_000, note: "Bonus" }],
        ["someone gone", { amount: 99, note: "x" }],
      ]),
    });
    expect(rows[1]).toMatchObject({ adjustment: 10_000, adjustmentNote: "Bonus", net: 190_000 });
    expect(rows[0]).not.toHaveProperty("adjustment");
  });
});

describe("sameRows", () => {
  test("the same numbers are the same whatever order the fields were written in", () => {
    const a = row({ personId: "p1", adjustment: 5 });
    const b = { ...row({ personId: "p1" }), adjustment: 5 };
    expect(sameRows([a], [b])).toBe(true);
  });

  test("a changed amount, a changed name or another person is a difference", () => {
    const a = [row({ personId: "p1" })];
    expect(sameRows(a, [row({ personId: "p1", net: 1 })])).toBe(false);
    expect(sameRows(a, [row({ personId: "p1", name: "Renamed" })])).toBe(false);
    expect(sameRows(a, [row({ personId: "p2" })])).toBe(false);
    expect(sameRows(a, [])).toBe(false);
  });
});

describe("timeSharesProblem: a person's time serving customers and on sales and marketing", () => {
  test.each([
    [0, 0],
    [100, 0],
    [0, 100],
    [40, 60],
    [25, 30],
  ])("%i%% and %i%% are fine", (cogs, sales) => {
    expect(timeSharesProblem(cogs, sales)).toBeNull();
  });

  test.each([
    [-1, 0],
    [0, 101],
    [12.5, 0],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
  ])("%s%% and %s%% are not whole percents from 0 to 100", (cogs, sales) => {
    expect(timeSharesProblem(cogs, sales)).toBe(TIME_SHARE_RANGE);
  });

  test("together more than 100% is refused, in its own words", () => {
    expect(timeSharesProblem(60, 41)).toBe(TIME_SHARES_OVER);
    expect(TIME_SHARE_RANGE).toBe("A share of time is a whole percent from 0 to 100.");
    expect(TIME_SHARES_OVER).toBe(
      "Time serving customers and time on sales and marketing add up to more than 100%.",
    );
  });
});
