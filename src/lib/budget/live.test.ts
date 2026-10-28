import { describe, expect, test } from "vitest";
import type { CostLine } from "@convex/lib/costs";
import type { CurrencyTotals, PayPerson } from "@convex/lib/payroll";
import { payrollByMonth, registerFigures } from "./live";

// Every name and amount here is made up.

const person = (extra: Partial<PayPerson>): PayPerson => ({
  id: "p1",
  name: "Example Person",
  kind: "employee",
  currency: "USD",
  monthlyGross: 5_000_00,
  order: 0,
  ...extra,
});
const totals = (cost: number): CurrencyTotals[] =>
  [{ currency: "USD", overall: { people: 1, cost, notComputed: 0 } }] as unknown as CurrencyTotals[];
const months = ["2026-09", "2026-10", "2026-11"];

describe("Payroll's figure for each month", () => {
  test("a paid month's frozen total; the others worked out from the people on the payroll that month", () => {
    const pay = payrollByMonth({
      months,
      holds: true,
      reads: {
        people: [person({}), person({ id: "p2", monthlyGross: 3_000_00, startDate: "2026-11-01" })],
        lines: [],
        runs: [{ month: "2026-09-01", status: "paid", totals: totals(4_800_00) }],
      },
      currency: "USD",
      fx: null,
    });
    expect(pay.get("2026-09")).toEqual({ kind: "known", amount: 4_800_00, basis: "paid" });
    expect(pay.get("2026-10")).toEqual({ kind: "known", amount: 5_000_00, basis: "live" });
    // The second person starts in November.
    expect(pay.get("2026-11")).toEqual({ kind: "known", amount: 8_000_00, basis: "live" });
  });

  test("without the Payroll page nothing is worked out: hidden, every month", () => {
    const pay = payrollByMonth({
      months,
      holds: false,
      reads: { people: undefined, lines: undefined, runs: undefined },
      currency: "USD",
      fx: null,
    });
    expect([...pay.values()]).toEqual([{ kind: "hidden" }, { kind: "hidden" }, { kind: "hidden" }]);
  });

  test("someone paid in the other currency with no rate on record: not known, never left out", () => {
    const pay = payrollByMonth({
      months: ["2026-10"],
      holds: true,
      reads: { people: [person({ currency: "KZT", monthlyGross: 1_000_000_00 })], lines: [], runs: [] },
      currency: "USD",
      fx: null,
    });
    expect(pay.get("2026-10")).toEqual({ kind: "unknown", reason: "no_rate" });
  });
});

describe("the registers' figure for a cell", () => {
  const line: CostLine = {
    category: "cloud",
    amount: 300_00,
    currency: "USD",
    cadence: "quarterly",
    startsOn: "2026-09",
    endsOn: null,
    variable: false,
    archivedAt: null,
  };
  const pay = new Map([["2026-10", { kind: "known" as const, amount: 5_000_00, basis: "live" as const }]]);

  test("Payroll's month, and each category's cash due in its month", () => {
    const live = registerFigures({ months, pay, costLines: [line], currency: "USD", fx: null });
    expect(live("payroll", "2026-10")).toEqual({ kind: "known", amount: 5_000_00 });
    expect(live("cloud", "2026-09")).toEqual({ kind: "known", amount: 300_00 });
    // Quarterly: nothing falls due in the month between.
    expect(live("cloud", "2026-10")).toEqual({ kind: "known", amount: 0 });
  });

  test("Costs is hidden for a viewer who does not hold it, and loading while it loads", () => {
    expect(registerFigures({ months, pay, costLines: null, currency: "USD", fx: null })("cloud", "2026-10")).toEqual({
      kind: "hidden",
    });
    expect(
      registerFigures({ months, pay, costLines: undefined, currency: "USD", fx: null })("cloud", "2026-10"),
    ).toEqual({ kind: "loading" });
  });
});
