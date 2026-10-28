// What a hire would cost a month at the company's own payroll rates: the
// gross (typed, or worked out from a net by `grossForNet`) plus the lines the
// company pays on it (`computePerson`). Pure, and payroll's own arithmetic:
// the Finance plan page runs it in the browser, from payroll's own
// `listLines`, for a viewer who holds Payroll. Nothing on the server calls it,
// so no function outside convex/payroll.ts reads a payroll table.

import { PayrollCycleError, computePerson, grossForNet, linesFor, type PayrollLineRow } from "./payroll";

export type HireCost =
  | { known: true; gross: number; cost: number }
  | { known: false; reason: "rate_not_set" | "other_currency" | "no_gross" | "circle" };

export function hireCost(input: {
  /** Minor units a month, in the currency the person would be paid in. */
  salary: number;
  basis: "net" | "gross";
  /** Whether that currency is the company's own. */
  sameCurrency: boolean;
  /** The company's payroll lines, as `payroll.listLines` returns them. */
  lines: readonly PayrollLineRow[];
}): HireCost {
  const { salary, basis, sameCurrency } = input;
  const lines = linesFor(input.lines, "employee");
  try {
    let gross = salary;
    if (basis === "net") {
      const up = grossForNet({ net: salary, sameCurrency, lines });
      if (!up.known) return { known: false, reason: up.reason };
      gross = up.gross;
    }
    const person = computePerson({ gross, adjustment: 0, sameCurrency, lines });
    const skipped = person.lines.find((line) => line.skipped !== undefined)?.skipped;
    if (skipped !== undefined) {
      return { known: false, reason: skipped === "gross_unknown" ? "no_gross" : skipped };
    }
    return { known: true, gross, cost: person.cost };
  } catch (error) {
    if (error instanceof PayrollCycleError) return { known: false, reason: "circle" };
    throw error;
  }
}
