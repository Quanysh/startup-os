import { describe, expect, test } from "vitest";
import {
  computePerson,
  draftRows,
  grossForNet,
  rowSums,
  sameRows,
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
const up = (net: number, lines: PayLine[], sameCurrency = true) =>
  grossForNet({ net, sameCurrency, lines });
/** The net the ordinary arithmetic gives for a gross: what a gross-up must agree with. */
const netOf = (gross: number, lines: PayLine[]) =>
  computePerson({ gross, adjustment: 0, sameCurrency: true, lines }).net;

describe("grossForNet: the gross whose net is the one entered", () => {
  test("no employee-paid line: the gross is the net", () => {
    expect(up(410_000_00, [])).toEqual({ known: true, gross: 410_000_00, net: 410_000_00, over: 0 });
    expect(up(410_000_00, [line("levy", { paidBy: "company", rateBp: 350 })])).toEqual({
      known: true,
      gross: 410_000_00,
      net: 410_000_00,
      over: 0,
    });
  });

  test("one line: 10% withheld from 500,000 leaves 450,000", () => {
    expect(up(450_000_00, [line("pension")])).toEqual({
      known: true,
      gross: 500_000_00,
      net: 450_000_00,
      over: 0,
    });
  });

  test("a line less another line", () => {
    const lines = [
      line("pension", { rateBp: 1000 }),
      line("medical", { rateBp: 200 }),
      line("income", { rateBp: 1000, lessLineIds: ["pension", "medical"] }),
    ];
    // 400,000 − 40,000 − 8,000 − 35,200 = 316,800.
    expect(up(316_800_00, lines)).toMatchObject({ known: true, gross: 400_000_00, over: 0 });
  });

  test("an allowance, on both sides of where it stops covering the base", () => {
    const lines = [line("income", { rateBp: 1000, allowance: 50_000_00 })];
    // 300,000 − 10% of 250,000.
    expect(up(275_000_00, lines)).toMatchObject({ known: true, gross: 300_000_00 });
    // Under the allowance nothing is withheld, so the gross is the net.
    expect(up(40_000_00, lines)).toMatchObject({ known: true, gross: 40_000_00 });
  });

  test("a cap that binds: past it, each extra unit of gross is a unit of net", () => {
    const lines = [line("pension", { rateBp: 1000, baseCap: 500_000_00 })];
    // 900,000 − 10% of 500,000.
    expect(up(850_000_00, lines)).toMatchObject({ known: true, gross: 900_000_00 });
  });

  test("a cap that does not bind changes nothing", () => {
    const lines = [line("pension", { rateBp: 1000, baseCap: 5_000_000_00 })];
    expect(up(450_000_00, lines)).toMatchObject({ known: true, gross: 500_000_00 });
  });

  test("the worked example: pension, income less pension with an allowance, and a company levy", () => {
    const lines = [
      line("pension", { rateBp: 1000 }),
      line("income", { rateBp: 1000, lessLineIds: ["pension"], allowance: 50_000_00 }),
      line("levy", { paidBy: "company", rateBp: 350 }),
    ];
    expect(up(410_000_00, lines)).toEqual({
      known: true,
      gross: 500_000_00,
      net: 410_000_00,
      over: 0,
    });
  });

  test("where rounding makes several grosses give one net, the smallest is taken", () => {
    const half = [line("half", { rateBp: 5000 })];
    // Gross 2 → 1 withheld → net 1; gross 3 → 2 withheld (1.5 rounds up) → net 1.
    expect([netOf(2, half), netOf(3, half)]).toEqual([1, 1]);
    expect(up(1, half)).toEqual({ known: true, gross: 2, net: 1, over: 0 });
    const third = [line("third", { rateBp: 3333 })];
    const found = up(100_00, third);
    expect(found).toMatchObject({ known: true, over: 0 });
    if (!found.known) throw new Error("unreachable");
    expect(netOf(found.gross, third)).toBe(100_00);
    expect(netOf(found.gross - 1, third)).toBeLessThan(100_00);
  });

  test("a net of nothing is a gross of nothing", () => {
    expect(up(0, [line("pension")])).toEqual({ known: true, gross: 0, net: 0, over: 0 });
  });

  test("always agrees with the ordinary arithmetic, exactly, and is the smallest such gross", () => {
    // Each line rounds, but a unit more gross is never more than a unit more
    // net, so the net cannot step over the target: an exact gross exists
    // whenever any gross reaches it. Checked across awkward rates and nets.
    const sets: PayLine[][] = [
      [line("a", { rateBp: 1 })],
      [line("a", { rateBp: 3333 }), line("b", { rateBp: 1234 })],
      [line("a", { rateBp: 987 }), line("b", { rateBp: 4567, lessLineIds: ["a"], allowance: 777 })],
      [
        line("a", { rateBp: 2500, baseCap: 3_333 }),
        line("b", { rateBp: 1999, lessLineIds: ["a"] }),
        line("c", { rateBp: 613, lessLineIds: ["a", "b"], allowance: 1_001, baseCap: 77_777 }),
      ],
      [line("a", { rateBp: 9000 }), line("c", { paidBy: "company", rateBp: 9999 })],
    ];
    for (const lines of sets) {
      for (const net of [1, 2, 3, 7, 99, 100, 101, 999, 4_321, 65_537, 1_000_003, 410_000_00]) {
        const found = up(net, lines);
        expect(found).toMatchObject({ known: true, net, over: 0 });
        if (!found.known) throw new Error("unreachable");
        expect(netOf(found.gross, lines)).toBe(net);
        if (found.gross > 0) expect(netOf(found.gross - 1, lines)).toBeLessThan(net);
      }
    }
  });

  test("withheld rates that reach 100% leave no gross: refused, not searched for ever", () => {
    expect(up(100_00, [line("all", { rateBp: 10_000 })])).toEqual({
      known: false,
      reason: "no_gross",
      count: 0,
    });
    expect(up(100_00, [line("a", { rateBp: 6000 }), line("b", { rateBp: 6000 })])).toEqual({
      known: false,
      reason: "no_gross",
      count: 0,
    });
  });

  test("but a cap under such rates still leaves one", () => {
    const lines = [line("all", { rateBp: 10_000, baseCap: 1_000 })];
    expect(up(5_000, lines)).toMatchObject({ known: true, gross: 6_000 });
  });

  test("an employee-paid line with no rate: the gross is not known, and not guessed", () => {
    const lines = [
      line("pension", { rateBp: null }),
      line("income", { rateBp: 1000 }),
      line("medical", { rateBp: null }),
    ];
    expect(up(450_000_00, lines)).toEqual({ known: false, reason: "rate_not_set", count: 2 });
  });

  test("a company-paid line with no rate does not stand in the way of the gross", () => {
    const lines = [line("pension"), line("levy", { paidBy: "company", rateBp: null })];
    expect(up(450_000_00, lines)).toMatchObject({ known: true, gross: 500_000_00 });
  });

  test("someone paid in another currency: an employee line with an allowance or cap makes it unknowable", () => {
    const lines = [line("pension"), line("income", { allowance: 5_000 }), line("capped", { baseCap: 9 })];
    expect(up(450_000_00, lines, false)).toEqual({
      known: false,
      reason: "other_currency",
      count: 2,
    });
    // A plain percentage needs no conversion.
    expect(up(450_000_00, [line("pension")], false)).toMatchObject({ known: true, gross: 500_000_00 });
    // And a missing rate is said first: it is the one the owner can set.
    expect(up(1, [line("x", { rateBp: null }), line("y", { allowance: 1 })], false)).toMatchObject({
      reason: "rate_not_set",
      count: 1,
    });
  });
});

// ── A month with someone entered as net ─────────────────────────────────────

const LINES = [
  { id: "pension", name: "Pension", appliesTo: "employee" as const, paidBy: "employee" as const, rateBp: 1000 as number | null, lessLineIds: [] as string[], allowance: 0, baseCap: null, order: 0, active: true },
  { id: "levy", name: "Levy", appliesTo: "employee" as const, paidBy: "company" as const, rateBp: 350 as number | null, lessLineIds: [] as string[], allowance: 0, baseCap: null, order: 1, active: true },
];
const NET_PERSON = {
  id: "n",
  name: "Nia Example",
  kind: "employee" as const,
  currency: "KZT" as "KZT" | "USD",
  payBasis: "net" as const,
  monthlyNet: 450_000_00,
  order: 0,
};
const month = (people: Parameters<typeof draftRows>[0]["people"], lines = LINES, adjustments?: Map<unknown, { amount: number; note?: string }>) =>
  draftRows({ people, lines, month: "2026-09-01", companyCurrency: "KZT", adjustments });

describe("draftRows: someone entered as net", () => {
  test("the row holds the gross worked out, the net asked for, and that it was net-based", () => {
    expect(month([NET_PERSON])).toEqual([
      {
        personId: "n",
        name: "Nia Example",
        kind: "employee",
        currency: "KZT",
        basis: "net",
        targetNet: 450_000_00,
        gross: 500_000_00,
        lines: [
          { name: "Pension", paidBy: "employee", rateBp: 1000, base: 500_000_00, amount: 50_000_00 },
          { name: "Levy", paidBy: "company", rateBp: 350, base: 500_000_00, amount: 17_500_00 },
        ],
        net: 450_000_00,
        cost: 517_500_00,
      },
    ]);
  });

  test("someone entered as gross is as before: no basis on the row", () => {
    const rows = month([{ ...NET_PERSON, payBasis: undefined, monthlyNet: undefined, monthlyGross: 500_000_00 }]);
    expect(rows[0]).not.toHaveProperty("basis");
    expect(rows[0]).not.toHaveProperty("targetNet");
    expect(rows[0]).toMatchObject({ gross: 500_000_00, net: 450_000_00 });
  });

  test("an adjustment is added to the net asked for and to the cost, and moves no gross", () => {
    const rows = month([NET_PERSON], LINES, new Map([["n", { amount: 20_000_00, note: "Bonus" }]]));
    expect(rows[0]).toMatchObject({
      gross: 500_000_00,
      adjustment: 20_000_00,
      net: 470_000_00,
      cost: 537_500_00,
    });
  });

  test("a withheld rate not set: no gross, no cost, every line without an amount, and the net still the one entered", () => {
    const lines = [{ ...LINES[0]!, rateBp: null }, LINES[1]!];
    const rows = month([NET_PERSON], lines);
    expect(rows).toEqual([
      {
        personId: "n",
        name: "Nia Example",
        kind: "employee",
        currency: "KZT",
        basis: "net",
        targetNet: 450_000_00,
        grossMissing: "rate_not_set",
        lines: [
          { name: "Pension", paidBy: "employee", skipped: "rate_not_set" },
          { name: "Levy", paidBy: "company", rateBp: 350, skipped: "gross_unknown" },
        ],
        net: 450_000_00,
      },
    ]);
    expect(rowSums(rows[0]!)).toMatchObject({
      rateNotSet: 1,
      grossUnknown: 1,
      notComputed: 2,
      withheld: 0,
      companyPaid: 0,
    });
  });

  test("a company-paid rate not set: the gross is known and the cost is incomplete, as for anyone", () => {
    const rows = month([NET_PERSON], [LINES[0]!, { ...LINES[1]!, rateBp: null }]);
    expect(rows[0]).toMatchObject({ gross: 500_000_00, net: 450_000_00, cost: 500_000_00 });
    expect(rows[0]).not.toHaveProperty("grossMissing");
    expect(rowSums(rows[0]!).notComputed).toBe(1);
  });

  test("paid in another currency with a capped line: unknowable, not a guess", () => {
    const rows = month([{ ...NET_PERSON, currency: "USD" }], [{ ...LINES[0]!, baseCap: 1 as never }, LINES[1]!]);
    expect(rows[0]).toMatchObject({
      grossMissing: "other_currency",
      lines: [
        { name: "Pension", skipped: "other_currency" },
        { name: "Levy", skipped: "gross_unknown" },
      ],
      net: 450_000_00,
    });
    expect(rows[0]).not.toHaveProperty("gross");
    expect(rows[0]).not.toHaveProperty("cost");
  });

  test("rates that leave no gross", () => {
    const rows = month([NET_PERSON], [{ ...LINES[0]!, rateBp: 10_000 }]);
    expect(rows[0]).toMatchObject({
      grossMissing: "no_gross",
      lines: [{ name: "Pension", rateBp: 10_000, skipped: "gross_unknown" }],
    });
  });
});

describe("totals, adjustments and comparison with a gross that is not known", () => {
  const unknown: PayRow = {
    personId: "n",
    name: "Nia Example",
    kind: "employee",
    currency: "KZT",
    basis: "net",
    targetNet: 450_000_00,
    grossMissing: "rate_not_set",
    lines: [{ name: "Pension", paidBy: "employee", skipped: "rate_not_set" }],
    net: 450_000_00,
  };
  const known: PayRow = {
    personId: "g",
    name: "Gus Example",
    kind: "employee",
    currency: "KZT",
    gross: 100_000,
    lines: [],
    net: 100_000,
    cost: 100_000,
  };

  test("the totals count the person, add what is known and stay labelled incomplete", () => {
    const [set] = totalsOf([unknown, known], "KZT");
    expect(set!.overall).toEqual({
      people: 2,
      gross: 100_000,
      adjustment: 0,
      withheld: 0,
      net: 450_000_00 + 100_000,
      companyPaid: 0,
      cost: 100_000,
      notComputed: 1,
    });
  });

  test("an adjustment on such a row moves the net and leaves the cost unknown", () => {
    const next = withAdjustment(unknown, -50_000_00, "Advance");
    expect(next).toMatchObject({ adjustment: -50_000_00, net: 400_000_00, grossMissing: "rate_not_set" });
    expect(next).not.toHaveProperty("cost");
    expect(next).not.toHaveProperty("gross");
  });

  test("an adjustment on a net-based row with a gross is added after the lines", () => {
    const [row] = month([NET_PERSON]);
    expect(withAdjustment(row!, 10_000_00, "")).toMatchObject({
      gross: 500_000_00,
      net: 460_000_00,
      cost: 527_500_00,
      targetNet: 450_000_00,
    });
  });

  test("the basis, the net asked for and a missing gross are part of what a row says", () => {
    const [row] = month([NET_PERSON]);
    const { basis: _basis, targetNet: _target, ...asGross } = row!;
    expect(sameRows([row!], [asGross])).toBe(false);
    expect(sameRows([row!], [{ ...row!, targetNet: 1 }])).toBe(false);
    expect(sameRows([unknown], [{ ...unknown, grossMissing: "no_gross" }])).toBe(false);
    expect(sameRows([unknown], [{ ...unknown, gross: null, cost: null, title: null }])).toBe(true);
  });
});
