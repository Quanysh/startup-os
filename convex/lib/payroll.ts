// Payroll arithmetic. Pure, and shared: the server freezes a month with these
// functions and the page shows what they return, so the two cannot disagree.
//
// Nothing here knows a statutory rate, threshold or rule. A line is a name, a
// payer and a rate the owner typed; this file multiplies and adds. Money is a
// whole number of the currency's minor unit (cents, tiyn) and a rate a whole
// number of basis points, so every sum is exact.

import { CURRENCIES, type Currency } from "./metricRegistry";
import { nextPeriodStart } from "./periods";

export const PAYROLL_KINDS = ["employee", "contractor"] as const;
export type PayrollKind = (typeof PAYROLL_KINDS)[number];
export const KIND_LABELS: Record<PayrollKind, string> = {
  employee: "Employee",
  contractor: "Contractor",
};
export const KIND_PLURALS: Record<PayrollKind, string> = {
  employee: "Employees",
  contractor: "Contractors",
};

/** Who a line's amount comes from: the person's pay, or the company on top of it. */
export const PAYERS = ["employee", "company"] as const;
export type Payer = (typeof PAYERS)[number];
export const PAYER_LABELS: Record<Payer, string> = {
  employee: "Withheld from pay",
  company: "Paid by the company",
};

/** One hundred percent, in basis points. */
export const BP = 10_000;

// ── Where a person's time goes, for unit economics ──────────────────────────

/**
 * A person's share of time serving customers (`cogsPercent`, counted in the
 * cost of serving them) and on sales and marketing (`salesPercent`, counted
 * in what a customer costs to win): whole percents, absent meaning 0. The
 * owner's estimate, typed on the person; what is left is running the
 * company. Read only by the Payroll page and the unit economics the Finance
 * page works out in the browser for a Payroll holder.
 */
export const TIME_SHARE_RANGE = "A share of time is a whole percent from 0 to 100.";
export const TIME_SHARES_OVER =
  "Time serving customers and time on sales and marketing add up to more than 100%.";

/** What is wrong with two shares of time, in fixed words, or null when nothing is. */
export function timeSharesProblem(cogsPercent: number, salesPercent: number): string | null {
  const whole = (share: number) => Number.isInteger(share) && share >= 0 && share <= 100;
  if (!whole(cogsPercent) || !whole(salesPercent)) return TIME_SHARE_RANGE;
  if (cogsPercent + salesPercent > 100) return TIME_SHARES_OVER;
  return null;
}

/** A tax or contribution line as the arithmetic needs it. */
export type PayLine = {
  id: string;
  name: string;
  paidBy: Payer;
  /** Null until the owner has typed a rate: such a line is not computed. */
  rateBp: number | null;
  /** Lines whose amounts come off this line's base. */
  lessLineIds: readonly string[];
  /** A fixed monthly amount off the base, in the company's currency. */
  allowance: number;
  /** The most the base can be, in the company's currency. */
  baseCap: number | null;
};

/** A line as it is stored and listed: `PayLine` plus where it sits. */
export type PayrollLineRow = PayLine & {
  appliesTo: PayrollKind;
  order: number;
  active: boolean;
};

/**
 * Why a line has no amount: its rate was never typed, or it has an allowance
 * or a cap (amounts in the company's currency) and the person is paid in
 * another one; or the person was entered as net and their gross could not be
 * worked out, so nothing can be taken on it. Either way it is missing, not zero.
 */
export type Skipped = "rate_not_set" | "other_currency" | "gross_unknown";

/**
 * One line of one person's month, as it is frozen. A field that does not
 * apply is absent (never null), so a row can be stored as it is.
 */
export type LineResult = {
  name: string;
  paidBy: Payer;
  rateBp?: number;
  base?: number;
  amount?: number;
  skipped?: Skipped;
};

export type PersonResult = {
  lines: LineResult[];
  withheld: number;
  companyPaid: number;
  net: number;
  cost: number;
  /** Lines with no amount. Above zero, net and cost are incomplete. */
  notComputed: number;
};

/**
 * `base × rate`, rounded half up to a whole minor unit. Split so that the
 * product never passes what a double holds exactly, whatever the base.
 */
export function rateAmount(base: number, rateBp: number): number {
  const whole = Math.floor(base / BP);
  const rest = base % BP;
  return whole * rateBp + Math.floor((rest * rateBp + BP / 2) / BP);
}

/**
 * The lines of a loop of subtractions (a line less a line less the first),
 * or null where there is none. A name that is no line is ignored.
 */
export function findCycle(
  lines: readonly { id: string; lessLineIds: readonly string[] }[],
): string[] | null {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const done = new Set<string>();
  const path: string[] = [];
  const walk = (id: string): string[] | null => {
    const at = path.indexOf(id);
    if (at !== -1) return path.slice(at);
    const line = byId.get(id);
    if (line === undefined || done.has(id)) return null;
    path.push(id);
    for (const next of line.lessLineIds) {
      const found = walk(next);
      if (found !== null) return found;
    }
    path.pop();
    done.add(id);
    return null;
  };
  for (const line of lines) {
    const found = walk(line.id);
    if (found !== null) return found;
  }
  return null;
}

export const CYCLE_MESSAGE = "Those lines subtract each other in a circle.";

export class PayrollCycleError extends Error {
  constructor() {
    super(CYCLE_MESSAGE);
    this.name = "PayrollCycleError";
  }
}

/**
 * One person's month. `lines` are the lines that apply to their kind and are
 * switched on, in order.
 *
 * Each line: base = gross, less the amounts of the lines it names, less its
 * allowance, never below zero, then held to its cap; amount = base × rate,
 * rounded half up. Net = gross + adjustment − what is withheld; cost = gross
 * + adjustment + what the company pays. The adjustment is added after the
 * lines and is in no line's base.
 */
export function computePerson(input: {
  gross: number;
  adjustment: number;
  /** Whether the person is paid in the company's currency. */
  sameCurrency: boolean;
  lines: readonly PayLine[];
}): PersonResult {
  const { gross, adjustment, sameCurrency, lines } = input;
  if (findCycle(lines) !== null) throw new PayrollCycleError();

  const byId = new Map(lines.map((line) => [line.id, line]));
  const results = new Map<string, LineResult>();
  const resultOf = (line: PayLine): LineResult => {
    const known = results.get(line.id);
    if (known !== undefined) return known;
    let result: LineResult;
    if (!sameCurrency && (line.allowance > 0 || line.baseCap !== null)) {
      result = {
        name: line.name,
        paidBy: line.paidBy,
        ...(line.rateBp === null ? null : { rateBp: line.rateBp }),
        skipped: "other_currency",
      };
    } else {
      let less = 0;
      for (const id of line.lessLineIds) {
        const other = byId.get(id);
        // A line with no amount takes nothing off: it is missing, and the
        // person's figures say so.
        if (other !== undefined) less += resultOf(other).amount ?? 0;
      }
      const floored = Math.max(0, gross - less - line.allowance);
      const base = line.baseCap === null ? floored : Math.min(floored, line.baseCap);
      result =
        line.rateBp === null
          ? { name: line.name, paidBy: line.paidBy, base, skipped: "rate_not_set" }
          : {
              name: line.name,
              paidBy: line.paidBy,
              rateBp: line.rateBp,
              base,
              amount: rateAmount(base, line.rateBp),
            };
    }
    results.set(line.id, result);
    return result;
  };

  const computed = lines.map(resultOf);
  const { withheld, companyPaid, notComputed } = lineSums(computed);
  return {
    lines: computed,
    withheld,
    companyPaid,
    net: gross + adjustment - withheld,
    cost: gross + adjustment + companyPaid,
    notComputed,
  };
}

function lineSums(lines: readonly LineResult[]) {
  let withheld = 0;
  let companyPaid = 0;
  let rateNotSet = 0;
  let otherCurrency = 0;
  let grossUnknown = 0;
  for (const line of lines) {
    if (line.skipped === "rate_not_set") rateNotSet += 1;
    else if (line.skipped === "other_currency") otherCurrency += 1;
    else if (line.skipped === "gross_unknown") grossUnknown += 1;
    else if (line.paidBy === "employee") withheld += line.amount ?? 0;
    else companyPaid += line.amount ?? 0;
  }
  return {
    withheld,
    companyPaid,
    rateNotSet,
    otherCurrency,
    grossUnknown,
    notComputed: rateNotSet + otherCurrency + grossUnknown,
  };
}

// ── From a net to its gross ─────────────────────────────────────────────────

/** Whether a line can have no amount for this person, whatever their gross. */
function skipOf(line: PayLine, sameCurrency: boolean): "rate_not_set" | "other_currency" | null {
  if (!sameCurrency && (line.allowance > 0 || line.baseCap !== null)) return "other_currency";
  return line.rateBp === null ? "rate_not_set" : null;
}

/**
 * Why a net-based person's gross is not known: a withheld line has no rate, a
 * withheld line is not computed in their currency, or what is withheld takes
 * the whole of every extra unit of pay, so no gross gives that net.
 */
export type GrossMissing = "rate_not_set" | "other_currency" | "no_gross";

export type GrossUp =
  | {
      known: true;
      gross: number;
      /** The net that gross gives. */
      net: number;
      /** That net less the one asked for. See `grossForNet`: always zero. */
      over: number;
    }
  | { known: false; reason: GrossMissing; /** The lines in the way. */ count: number };

/** Past this a gross is not searched for: a hundred times the largest salary. */
const GROSS_SEARCH_LIMIT = 10_000_000_000_000;

/**
 * The gross whose net is `net`: the smallest gross that, with the same lines
 * and the same rules as `computePerson` (bases, less-lines, allowance, cap,
 * each line rounded half up), leaves at least `net` after what is withheld.
 * `lines` are the person's kind's lines that are switched on. Company-paid
 * lines take no part: they are worked out on the gross found.
 *
 * A unit more gross raises each withheld amount by a unit at most and never
 * lowers one, so it is never more than a unit more net. The net therefore
 * cannot step over the target: wherever some gross reaches it, the smallest
 * that does lands on it exactly, and `over` is zero. It is reported all the
 * same, so that a rule added later which broke this could not hide.
 *
 * Refused, never guessed: a withheld line with no rate or not computed in the
 * person's currency (the gross would be understated), and rates under which
 * no gross within reach gives the net (withheld rates reaching 100%).
 */
export function grossForNet(input: {
  net: number;
  sameCurrency: boolean;
  lines: readonly PayLine[];
}): GrossUp {
  const { net, sameCurrency, lines } = input;
  const withheld = lines.filter((line) => line.paidBy === "employee");
  for (const reason of ["rate_not_set", "other_currency"] as const) {
    const count = withheld.filter((line) => skipOf(line, sameCurrency) === reason).length;
    if (count > 0) return { known: false, reason, count };
  }

  const netOf = (gross: number) =>
    computePerson({ gross, adjustment: 0, sameCurrency, lines }).net;
  const found = (gross: number, got: number): GrossUp => ({
    known: true,
    gross,
    net: got,
    over: got - net,
  });

  // Nothing withheld at this level: the gross is the net.
  let low = net;
  const atNet = netOf(low);
  if (atNet >= net) return found(low, atNet);

  // A gross that is enough, by doubling; then the smallest, by halving. The
  // search keeps "low is too little, high is enough" and ends with the two
  // side by side, whatever shape the rates give the net.
  let high = low;
  let got = atNet;
  while (got < net) {
    high = high * 2 + 1;
    if (high > GROSS_SEARCH_LIMIT) return { known: false, reason: "no_gross", count: 0 };
    got = netOf(high);
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const there = netOf(middle);
    if (there >= net) {
      high = middle;
      got = there;
    } else {
      low = middle;
    }
  }
  return found(high, got);
}

// ── A month's rows ──────────────────────────────────────────────────────────

/** One person in a saved month: a frozen copy, never re-read from the person. */
export type PayRow<PersonId = string> = {
  personId: PersonId;
  name: string;
  title?: string;
  kind: PayrollKind;
  currency: Currency;
  /**
   * Present for someone entered as net: the gross was worked out from
   * `targetNet`. Absent, the person was entered as gross.
   */
  basis?: "net";
  /** The monthly net that was entered, before any adjustment. */
  targetNet?: number;
  /**
   * The month's gross: the one entered, or the one worked out from the net.
   * Absent only where it could not be worked out, and `grossMissing` says why.
   */
  gross?: number;
  grossMissing?: GrossMissing;
  /** A one-off bonus (above zero) or deduction (below) for this month. */
  adjustment?: number;
  adjustmentNote?: string;
  lines: LineResult[];
  net: number;
  /** Absent with the gross: a cost cannot be said without one. */
  cost?: number;
};

/** What a row's saved lines come to. */
export function rowSums(row: Pick<PayRow, "lines">) {
  return lineSums(row.lines);
}

/** A person as the month's arithmetic needs them. */
export type PayPerson<PersonId = string> = {
  id: PersonId;
  name: string;
  title?: string | null;
  kind: PayrollKind;
  currency: Currency;
  /** How the pay was entered. Absent means gross: everyone from before there was a choice. */
  payBasis?: "net" | "gross" | null;
  /** The figure for a gross-based person. */
  monthlyGross?: number | null;
  /** The figure for a net-based person: what they receive after everything withheld. */
  monthlyNet?: number | null;
  order: number;
  startDate?: string | null;
  endDate?: string | null;
  archivedAt?: number | null;
};

/**
 * Whether a month's payroll holds someone: started on or before its last day,
 * not ended before its first, and not archived. `month` is its first day.
 */
export function activeIn(
  person: { startDate?: string | null; endDate?: string | null; archivedAt?: number | null },
  month: string,
): boolean {
  if (person.archivedAt != null) return false;
  if (person.startDate != null && person.startDate >= nextPeriodStart("month", month)) return false;
  return person.endDate == null || person.endDate >= month;
}

/** A kind's lines that are switched on, in the owner's order. */
export function linesFor<Line extends PayrollLineRow>(
  lines: readonly Line[],
  kind: PayrollKind,
): Line[] {
  return lines
    .filter((line) => line.appliesTo === kind && line.active)
    .sort((a, b) => a.order - b.order);
}

/**
 * A month worked out from the people and lines as they are now. An adjustment
 * is kept for the person it was given to, if they are still in the month.
 */
export function draftRows<PersonId>(input: {
  people: readonly PayPerson<PersonId>[];
  lines: readonly PayrollLineRow[];
  month: string;
  companyCurrency: Currency;
  adjustments?: ReadonlyMap<PersonId, { amount: number; note?: string }>;
}): PayRow<PersonId>[] {
  const { people, lines, month, companyCurrency, adjustments } = input;
  return people
    .filter((person) => activeIn(person, month))
    .sort((a, b) => a.order - b.order)
    .map((person) => {
      const kept = adjustments?.get(person.id);
      const adjustment = kept?.amount ?? 0;
      const sameCurrency = person.currency === companyCurrency;
      const mine = linesFor(lines, person.kind);
      const who = {
        personId: person.id,
        name: person.name,
        ...(person.title ? { title: person.title } : null),
        kind: person.kind,
        currency: person.currency,
      };
      const adjusted = {
        ...(adjustment !== 0 ? { adjustment } : null),
        ...(adjustment !== 0 && kept?.note ? { adjustmentNote: kept.note } : null),
      };

      let gross = person.monthlyGross ?? 0;
      let entered: Pick<PayRow, "basis" | "targetNet"> = {};
      if (person.payBasis === "net") {
        const targetNet = person.monthlyNet ?? 0;
        entered = { basis: "net", targetNet };
        const up = grossForNet({ net: targetNet, sameCurrency, lines: mine });
        if (!up.known) {
          // No gross, so no base for any line and no cost. The net is still
          // the one entered: that is what the person is paid.
          return {
            ...who,
            ...entered,
            grossMissing: up.reason,
            ...adjusted,
            lines: mine.map((line) => ({
              name: line.name,
              paidBy: line.paidBy,
              ...(line.rateBp === null ? null : { rateBp: line.rateBp }),
              skipped: skipOf(line, sameCurrency) ?? "gross_unknown",
            })),
            net: targetNet + adjustment,
          };
        }
        gross = up.gross;
      }
      const result = computePerson({ gross, adjustment, sameCurrency, lines: mine });
      return {
        ...who,
        ...entered,
        gross,
        ...adjusted,
        lines: result.lines,
        net: result.net,
        cost: result.cost,
      };
    });
}

/**
 * A saved row with another adjustment. Net and cost are re-worked from the
 * row's own saved lines, never from today's rates. Zero clears it.
 */
export function withAdjustment<PersonId>(
  row: PayRow<PersonId>,
  amount: number,
  note: string,
): PayRow<PersonId> {
  const { adjustment: _was, adjustmentNote: _note, ...rest } = row;
  const { withheld, companyPaid } = lineSums(row.lines);
  const adjusted = {
    ...rest,
    ...(amount !== 0 ? { adjustment: amount } : null),
    ...(amount !== 0 && note !== "" ? { adjustmentNote: note } : null),
  };
  // With no gross there is no cost; the net is the one entered, adjusted.
  if (row.gross === undefined) return { ...adjusted, net: (row.targetNet ?? 0) + amount };
  return {
    ...adjusted,
    net: row.gross + amount - withheld,
    cost: row.gross + amount + companyPaid,
  };
}

/**
 * A row as the page reads it: what its lines come to worked out, nothing
 * absent. The server sends a saved month's rows this way, and the page puts a
 * month worked out live in the same shape, so one table shows either.
 */
export function readRow<PersonId>(row: PayRow<PersonId>) {
  return {
    personId: row.personId,
    name: row.name,
    title: row.title ?? null,
    kind: row.kind,
    currency: row.currency,
    basis: row.basis ?? ("gross" as const),
    targetNet: row.targetNet ?? null,
    gross: row.gross ?? null,
    grossMissing: row.grossMissing ?? null,
    adjustment: row.adjustment ?? 0,
    adjustmentNote: row.adjustmentNote ?? null,
    lines: row.lines.map((line) => ({
      name: line.name,
      paidBy: line.paidBy,
      rateBp: line.rateBp ?? null,
      base: line.base ?? null,
      amount: line.amount ?? null,
      skipped: line.skipped ?? null,
    })),
    ...rowSums(row),
    net: row.net,
    cost: row.cost ?? null,
  };
}

type OrNull<T> = { [K in keyof T]: T[K] | null };
/** A row as it is stored (absent fields) or as it is read (nulls in their place). */
export type AnyRow = Omit<OrNull<PayRow<unknown>>, "lines" | "adjustment" | "basis"> & {
  adjustment?: number | null;
  basis?: "net" | "gross" | null;
  lines: readonly OrNull<LineResult>[];
};

function normal(row: AnyRow) {
  return [
    String(row.personId),
    row.name,
    row.title ?? null,
    row.kind,
    row.currency,
    row.basis ?? "gross",
    row.targetNet ?? null,
    row.gross ?? null,
    row.grossMissing ?? null,
    row.adjustment ?? 0,
    row.adjustmentNote ?? null,
    row.lines.map((line) => [
      line.name,
      line.paidBy,
      line.rateBp ?? null,
      line.base ?? null,
      line.amount ?? null,
      line.skipped ?? null,
    ]),
    row.net,
    row.cost ?? null,
  ];
}

/** Whether two sets of rows say the same thing, person for person. */
export function sameRows(a: readonly AnyRow[], b: readonly AnyRow[]): boolean {
  return JSON.stringify(a.map(normal)) === JSON.stringify(b.map(normal));
}

// ── Totals ──────────────────────────────────────────────────────────────────

export type Totals = {
  people: number;
  gross: number;
  adjustment: number;
  withheld: number;
  /** Net to pay. */
  net: number;
  companyPaid: number;
  /** Total cost to the company. */
  cost: number;
  /** Lines with no amount among these people: above zero, the sums are incomplete. */
  notComputed: number;
};

export type CurrencyTotals = {
  currency: Currency;
  byKind: Record<PayrollKind, Totals>;
  overall: Totals;
};

const nothing = (): Totals => ({
  people: 0,
  gross: 0,
  adjustment: 0,
  withheld: 0,
  net: 0,
  companyPaid: 0,
  cost: 0,
  notComputed: 0,
});

/**
 * A month's totals, one set per currency and never across them: the
 * company's own currency first (there even with nobody paid in it), then any
 * other that someone is paid in.
 */
export function totalsOf(
  rows: readonly PayRow<unknown>[],
  companyCurrency: Currency,
): CurrencyTotals[] {
  const sets = new Map<Currency, CurrencyTotals>();
  const setOf = (currency: Currency) => {
    if (!sets.has(currency)) {
      sets.set(currency, {
        currency,
        byKind: { employee: nothing(), contractor: nothing() },
        overall: nothing(),
      });
    }
    return sets.get(currency)!;
  };
  setOf(companyCurrency);
  for (const row of rows) {
    const set = setOf(row.currency);
    const sums = lineSums(row.lines);
    for (const totals of [set.byKind[row.kind], set.overall]) {
      totals.people += 1;
      // A gross that is not known adds nothing, and the lines left
      // uncomputed for it mark the sums incomplete.
      totals.gross += row.gross ?? 0;
      totals.adjustment += row.adjustment ?? 0;
      totals.withheld += sums.withheld;
      totals.net += row.net;
      totals.companyPaid += sums.companyPaid;
      totals.cost += row.cost ?? 0;
      totals.notComputed += sums.notComputed;
    }
  }
  const rank = (currency: Currency) =>
    currency === companyCurrency ? -1 : CURRENCIES.indexOf(currency);
  return [...sets.values()].sort((a, b) => rank(a.currency) - rank(b.currency));
}

// ── What payroll comes to, live ─────────────────────────────────────────────

/**
 * One figure summed over some people: the sum for the people it is known for,
 * and how many those are. Short of everyone, the sum is a part and never the
 * total: a missing number is not a zero.
 */
export type Figure = { sum: number; known: number };

export type SummaryTotals = {
  people: number;
  /** Net to pay. */
  net: Figure;
  gross: Figure;
  withheld: Figure;
  companyPaid: Figure;
  /** Total cost to the company: gross plus what it pays on top. */
  cost: Figure;
};

/** Whether a figure is known for every one of these people. */
export function isWhole(figure: Figure, totals: SummaryTotals): boolean {
  return figure.known === totals.people;
}

/** What stands between a summary and its whole figures. */
export type SummaryGaps = {
  /** Withheld lines with no rate that apply to someone in view. */
  withheldRates: number;
  /** People entered as net whose gross cannot be worked out for those. */
  grossBlocked: number;
  /** People entered as gross whose withheld amounts and net cannot be, for those. */
  withheldBlocked: number;
  /** Company-paid lines with no rate that apply to someone in view. */
  companyRates: number;
  /** The people those apply to. */
  companyBlocked: number;
  /** People with a line that is not computed in their currency. */
  otherCurrency: number;
  /** People entered as net for whom what is withheld leaves no gross. */
  noGross: number;
  /** People with a line taken on pay less a line that has no amount. */
  dependent: number;
};

export type CurrencySummary = {
  currency: Currency;
  byKind: Record<PayrollKind, SummaryTotals>;
  overall: SummaryTotals;
  gaps: SummaryGaps;
};

const noFigures = (): SummaryTotals => ({
  people: 0,
  net: { sum: 0, known: 0 },
  gross: { sum: 0, known: 0 },
  withheld: { sum: 0, known: 0 },
  companyPaid: { sum: 0, known: 0 },
  cost: { sum: 0, known: 0 },
});

/**
 * What a month's payroll comes to with the people and lines as they are now:
 * `draftRows` (the rows marking the month paid would freeze, with the
 * adjustments given, if any) added up per currency, each figure only over the people it is
 * known for. Nothing is saved and nothing is guessed.
 *
 * Known, for one person: the net when they were entered as net (it is what
 * was typed) or when every withheld line has an amount; the gross when it was
 * entered or could be worked out; what is withheld and what the company pays
 * when the gross is known and each of those lines has an amount; the cost
 * when the gross and what the company pays both are. A line taken on pay less
 * a line with no amount counts as having none: the arithmetic takes nothing
 * off for the missing line, so its amount is not the real one.
 *
 * Throws `PayrollCycleError` where a month would.
 */
export function summarise<PersonId>(input: {
  people: readonly PayPerson<PersonId>[];
  lines: readonly PayrollLineRow[];
  month: string;
  companyCurrency: Currency;
  /** The month's bonuses and deductions, by person: in net and cost, never in a base. */
  adjustments?: ReadonlyMap<PersonId, { amount: number; note?: string }>;
}): CurrencySummary[] {
  const { lines, companyCurrency } = input;
  const sets = new Map<Currency, CurrencySummary>();
  // The distinct lines with no rate, per currency: one line, many people.
  const unset = new Map<Currency, Record<Payer, Set<string>>>();
  const setOf = (currency: Currency) => {
    if (!sets.has(currency)) {
      sets.set(currency, {
        currency,
        byKind: { employee: noFigures(), contractor: noFigures() },
        overall: noFigures(),
        gaps: {
          withheldRates: 0,
          grossBlocked: 0,
          withheldBlocked: 0,
          companyRates: 0,
          companyBlocked: 0,
          otherCurrency: 0,
          noGross: 0,
          dependent: 0,
        },
      });
      unset.set(currency, { employee: new Set(), company: new Set() });
    }
    return sets.get(currency)!;
  };
  setOf(companyCurrency);

  for (const row of draftRows(input)) {
    const set = setOf(row.currency);
    const { gaps } = set;
    // The row's lines are its kind's lines, one for one and in the same order.
    const mine = linesFor(lines, row.kind);
    const skippedAt = (index: number) => row.lines[index]?.skipped;

    const noRate = { employee: false, company: false };
    let otherCurrency = false;
    mine.forEach((line, index) => {
      if (skippedAt(index) === "rate_not_set") {
        noRate[line.paidBy] = true;
        unset.get(row.currency)![line.paidBy].add(line.id);
      } else if (skippedAt(index) === "other_currency") otherCurrency = true;
    });
    if (otherCurrency) gaps.otherCurrency += 1;
    if (noRate.company) gaps.companyBlocked += 1;
    if (row.grossMissing === "rate_not_set") gaps.grossBlocked += 1;
    else if (row.grossMissing === "no_gross") gaps.noGross += 1;
    else if (row.basis !== "net" && noRate.employee) gaps.withheldBlocked += 1;

    let known = { net: row.basis === "net", gross: false, withheld: false, companyPaid: false };
    if (row.gross !== undefined) {
      // A line has no amount to rely on when it was skipped, or when a line
      // it subtracts has none.
      const at = new Map(mine.map((line, index) => [line.id, index]));
      const byId = new Map(mine.map((line) => [line.id, line]));
      const unsure = new Map<string, boolean>();
      const isUnsure = (line: PayrollLineRow): boolean => {
        const was = unsure.get(line.id);
        if (was !== undefined) return was;
        const answer =
          skippedAt(at.get(line.id)!) !== undefined ||
          line.lessLineIds.some((id) => {
            const other = byId.get(id);
            return other !== undefined && isUnsure(other);
          });
        unsure.set(line.id, answer);
        return answer;
      };
      const sure = (payer: Payer) =>
        mine.every((line) => line.paidBy !== payer || !isUnsure(line));
      if (mine.some((line, index) => skippedAt(index) === undefined && isUnsure(line))) {
        gaps.dependent += 1;
      }
      const withheld = sure("employee");
      // A gross worked out from a net is only as good as what was withheld.
      const gross = row.basis === "net" ? withheld : true;
      known = {
        net: row.basis === "net" || withheld,
        gross,
        withheld: gross && withheld,
        companyPaid: gross && sure("company"),
      };
    }

    const sums = lineSums(row.lines);
    for (const totals of [set.byKind[row.kind], set.overall]) {
      totals.people += 1;
      const add = (figure: Figure, isKnown: boolean, amount: number) => {
        if (!isKnown) return;
        figure.sum += amount;
        figure.known += 1;
      };
      add(totals.net, known.net, row.net);
      add(totals.gross, known.gross, row.gross ?? 0);
      add(totals.withheld, known.withheld, sums.withheld);
      add(totals.companyPaid, known.companyPaid, sums.companyPaid);
      add(totals.cost, known.gross && known.companyPaid, row.cost ?? 0);
    }
  }

  for (const [currency, set] of sets) {
    set.gaps.withheldRates = unset.get(currency)!.employee.size;
    set.gaps.companyRates = unset.get(currency)!.company.size;
  }
  const rank = (currency: Currency) =>
    currency === companyCurrency ? -1 : CURRENCIES.indexOf(currency);
  return [...sets.values()].sort((a, b) => rank(a.currency) - rank(b.currency));
}
