// Costs: what a company pays for besides pay (cloud, subscriptions, rent and
// the rest), and what those lines come to in a month. Pure: the server's
// summary (convex/costs.ts), the owner's agent and the page all read this one
// module, so a figure cannot be worked out two ways.
//
// Money is a whole number of the currency's minor unit (cents, tiyn). A month
// is "YYYY-MM". Nothing here reads a clock: the month is always handed in.
//
// Two figures a month, kept apart because they answer different questions:
//   run-rate  what the recurring lines cost a month, spread evenly (a yearly
//             bill is a twelfth every month). The burn to plan with.
//   cash due  what actually falls in that month (the yearly bill, whole, in
//             its anniversary month; a one-off in its own). The bank balance.
// Adding one to the other, or showing one under the other's name, would say
// something neither means.

import { CURRENCIES, type Currency } from "./metricRegistry";

export const COST_CATEGORIES = [
  "cloud",
  "software",
  "office",
  "services",
  "marketing",
  "travel",
  "taxes_fees",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CostCategory, string> = {
  cloud: "Cloud",
  software: "Software",
  office: "Office",
  services: "Services",
  marketing: "Marketing",
  travel: "Travel",
  taxes_fees: "Taxes and fees",
  other: "Other",
};

/** What each category is for, said in the form. */
export const CATEGORY_HINTS: Record<CostCategory, string> = {
  cloud: "hosting and usage",
  software: "subscriptions and tools",
  office: "rent, utilities, internet",
  services: "contractors, legal, accounting",
  marketing: "ads, events, content",
  travel: "flights, hotels",
  taxes_fees: "state fees, bank fees",
  other: "anything else",
};

// ── What a line counts as, for unit economics ───────────────────────────────

/**
 * What a cost line counts as when a company's unit economics are worked out
 * (src/lib/finance/unit-economics.ts): the cost of serving customers (COGS,
 * in the gross margin), sales and marketing (in CAC), or running the
 * company (in neither). The owner's choice per line; a line with none is its
 * category's default (`defaultBucket`), so the figures work from day one.
 */
export const COST_BUCKETS = ["cogs", "sales_marketing", "operating"] as const;
export type CostBucket = (typeof COST_BUCKETS)[number];

export const BUCKET_LABELS: Record<CostBucket, string> = {
  cogs: "Cost of serving customers",
  sales_marketing: "Sales and marketing",
  operating: "Running the company",
};

/** A line's bucket when none was chosen: cloud serves customers, marketing sells, the rest runs the company. */
export function defaultBucket(category: CostCategory): CostBucket {
  if (category === "cloud") return "cogs";
  if (category === "marketing") return "sales_marketing";
  return "operating";
}

/** What a line counts as: the bucket chosen for it, else its category's default. */
export function bucketOf(line: { category: CostCategory; bucket?: CostBucket | null }): CostBucket {
  return line.bucket ?? defaultBucket(line.category);
}

export const COST_CADENCES = ["monthly", "quarterly", "yearly", "once"] as const;
export type CostCadence = (typeof COST_CADENCES)[number];

export const CADENCE_LABELS: Record<CostCadence, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  once: "One-off",
};

/** What the arithmetic needs of a line. A stored row has more (a name, notes). */
export type CostLine = {
  category: CostCategory;
  /** Minor units, per cadence: a yearly line's amount is the year's. */
  amount: number;
  currency: Currency;
  cadence: CostCadence;
  /** "YYYY-MM": the first month it is paid for. A one-off's only month. */
  startsOn: string;
  /** "YYYY-MM", inclusive. Not read for a one-off. */
  endsOn: string | null;
  /** An estimate that changes month to month (cloud usage). */
  variable: boolean;
  archivedAt: number | null;
};

// ── Months ──────────────────────────────────────────────────────────────────

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

/** Months since year 0: what two months are compared and subtracted by. */
const indexOf = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

export function addMonths(month: string, by: number): string {
  const index = indexOf(month) + by;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, "0")}-${String(index - year * 12 + 1).padStart(2, "0")}`;
}

/** A month as the charts and `formatPeriod` name it: its first day. */
export const firstDayOf = (month: string) => `${month}-01`;

// ── One line, one month ─────────────────────────────────────────────────────

/** Whether a line is paid for in a month: started, not past its end, not archived. */
export function activeIn(line: CostLine, month: string): boolean {
  if (line.archivedAt !== null) return false;
  if (line.cadence === "once") return month === line.startsOn;
  return line.startsOn <= month && (line.endsOn === null || month <= line.endsOn);
}

/** Whether a line belongs under "Ended": archived, past its end, or a one-off already paid. */
export function hasEnded(line: CostLine, month: string): boolean {
  if (line.archivedAt !== null) return true;
  if (line.cadence === "once") return line.startsOn < month;
  return line.endsOn !== null && line.endsOn < month;
}

const PERIOD: Record<Exclude<CostCadence, "once">, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * What a recurring line costs a month, spread evenly: the amount, a third of
 * it, a twelfth of it. Rounded half up to a whole minor unit. A one-off is
 * not a monthly cost at all: zero.
 */
export function monthlyEquivalent(line: Pick<CostLine, "amount" | "cadence">): number {
  if (line.cadence === "once") return 0;
  return Math.round(line.amount / PERIOD[line.cadence]);
}

/** A line's part of a month's run-rate. */
export function runRateOf(line: CostLine, month: string): number {
  return activeIn(line, month) ? monthlyEquivalent(line) : 0;
}

/**
 * What a line takes out of the bank in a month: a monthly line its amount, a
 * quarterly one the whole amount every third month from its start, a yearly
 * one the whole amount in its anniversary month, a one-off all of it in its
 * own month.
 */
export function cashDueOf(line: CostLine, month: string): number {
  if (!activeIn(line, month)) return 0;
  if (line.cadence === "once") return line.amount;
  const since = indexOf(month) - indexOf(line.startsOn);
  return since % PERIOD[line.cadence] === 0 ? line.amount : 0;
}

// ── A month's summary ───────────────────────────────────────────────────────

/** How many months of cash due the summary holds: this one and the next eleven. */
export const CASH_MONTHS = 12;

export type CategoryFigures = { category: CostCategory; runRate: number; cashDue: number };

export type Figures = {
  /** The recurring lines active this month, spread evenly. */
  runRate: number;
  /** What falls in this month. */
  cashDue: number;
  /** Cash due over the three months after this one. */
  next3: number;
  /** The run-rate × 12: a simple multiple, not a forecast. */
  yearly: number;
  /** Categories with something this month, the largest run-rate first. */
  byCategory: CategoryFigures[];
  /** Cash due for each of `months`. */
  cashByMonth: number[];
};

export type CurrencyFigures = Figures & { currency: Currency };

/**
 * The figures across currencies. One currency in play: its own figures. Two,
 * with an exchange rate on record: one total in US dollars at that rate. Two
 * and no rate: not known. Never a guess and never a zero.
 */
export type Combined =
  | (Figures & { kind: "single"; currency: Currency })
  | (Figures & { kind: "converted"; currency: "USD"; rate: number })
  | { kind: "unknown" };

export type CostSummary = {
  month: string;
  /** This month and the next eleven. */
  months: string[];
  /** Lines active this month. */
  lines: number;
  /** Those of them that are estimates. */
  estimates: number;
  /** One per currency in play, the company's own first. */
  currencies: CurrencyFigures[];
  combined: Combined;
};

function figuresOf(lines: readonly CostLine[], months: readonly string[]): Figures {
  const month = months[0]!;
  const runRate = lines.reduce((sum, line) => sum + runRateOf(line, month), 0);
  const cashByMonth = months.map((m) => lines.reduce((sum, line) => sum + cashDueOf(line, m), 0));
  const byCategory = COST_CATEGORIES.map((category) => {
    const mine = lines.filter((line) => line.category === category);
    return {
      category,
      runRate: mine.reduce((sum, line) => sum + runRateOf(line, month), 0),
      cashDue: mine.reduce((sum, line) => sum + cashDueOf(line, month), 0),
    };
  }).filter((row) => row.runRate > 0 || row.cashDue > 0);
  return {
    runRate,
    cashDue: cashByMonth[0]!,
    next3: cashByMonth.slice(1, 4).reduce((sum, value) => sum + value, 0),
    yearly: runRate * 12,
    byCategory: sorted(byCategory),
    cashByMonth,
  };
}

// The sort is stable, so equal run-rates keep the list's own order.
const sorted = (rows: CategoryFigures[]) => [...rows].sort((a, b) => b.runRate - a.runRate);

/** Tenge minor units as US dollar minor units, at so many tenge to the dollar. */
export const kztToUsd = (minor: number, rate: number) => Math.round(minor / rate);

function inUsd(usd: Figures | undefined, kzt: Figures, rate: number, months: number): Figures {
  const add = (own: number | undefined, other: number) => (own ?? 0) + kztToUsd(other, rate);
  const runRate = add(usd?.runRate, kzt.runRate);
  const byCategory = COST_CATEGORIES.flatMap((category) => {
    const a = usd?.byCategory.find((row) => row.category === category);
    const b = kzt.byCategory.find((row) => row.category === category);
    if (a === undefined && b === undefined) return [];
    return [
      {
        category,
        runRate: add(a?.runRate, b?.runRate ?? 0),
        cashDue: add(a?.cashDue, b?.cashDue ?? 0),
      },
    ];
  });
  return {
    runRate,
    cashDue: add(usd?.cashDue, kzt.cashDue),
    next3: add(usd?.next3, kzt.next3),
    yearly: runRate * 12,
    byCategory: sorted(byCategory),
    cashByMonth: Array.from({ length: months }, (_, i) => add(usd?.cashByMonth[i], kzt.cashByMonth[i]!)),
  };
}

/**
 * What a company's cost lines come to in a month and over the eleven after
 * it. `fxUsdKzt` is the stored exchange rate (tenge to the dollar) or null
 * where none is on record; it is used only when both currencies are in play.
 */
export function summarise(input: {
  lines: readonly CostLine[];
  month: string;
  companyCurrency: Currency;
  fxUsdKzt: number | null;
}): CostSummary {
  const { lines, month, companyCurrency, fxUsdKzt } = input;
  const months = Array.from({ length: CASH_MONTHS }, (_, i) => addMonths(month, i));
  const active = lines.filter((line) => activeIn(line, month));

  const rank = (currency: Currency) =>
    currency === companyCurrency ? -1 : CURRENCIES.indexOf(currency);
  const every: CurrencyFigures[] = CURRENCIES.map((currency) => ({
    currency,
    ...figuresOf(lines.filter((line) => line.currency === currency), months),
  }));
  // In play: something this month or in the months ahead. With nothing at
  // all, the company's own currency stands, as a known nothing.
  const inPlay = every.filter(
    (set) => set.runRate > 0 || set.cashByMonth.some((value) => value > 0),
  );
  const currencies = (
    inPlay.length > 0 ? inPlay : every.filter((set) => set.currency === companyCurrency)
  ).sort((a, b) => rank(a.currency) - rank(b.currency));

  let combined: Combined;
  if (currencies.length === 1) {
    combined = { kind: "single", ...currencies[0]! };
  } else if (fxUsdKzt !== null && Number.isFinite(fxUsdKzt) && fxUsdKzt > 0) {
    const of = (currency: Currency) => currencies.find((set) => set.currency === currency);
    combined = {
      kind: "converted",
      currency: "USD",
      rate: fxUsdKzt,
      ...inUsd(of("USD"), of("KZT")!, fxUsdKzt, CASH_MONTHS),
    };
  } else {
    combined = { kind: "unknown" };
  }

  return {
    month,
    months,
    lines: active.length,
    estimates: active.filter((line) => line.variable).length,
    currencies,
    combined,
  };
}

// ── What must not be typed ──────────────────────────────────────────────────

/** Said when a name, a note or "paid by" looks like a card or an account number. */
export const NO_ACCOUNT_NUMBERS =
  "Leave card and account numbers out: say which card or account in words.";

/**
 * Whether text holds what looks like a card or bank account number: nine
 * digits in a row, twelve or more in groups joined by spaces or hyphens, or
 * the shape of an IBAN. A date ("2026-10-13") is not one. A blunt check on
 * purpose: this page is a list of costs and holds no payment details.
 */
export function looksLikeAccountNumber(text: string): boolean {
  const plain = text.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " date ");
  if (/\d{9,}/.test(plain)) return true;
  if (/\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}\b/.test(plain)) return true;
  for (const [groups] of plain.matchAll(/\d+(?:[ -]\d+)+/g)) {
    if (groups.replace(/\D/g, "").length >= 12) return true;
  }
  return false;
}
