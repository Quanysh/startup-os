// What /customers shows: which clinics, under which filters, and how a value
// that is not on record reads. Pure, so every sentence is tested without a
// page. The register's push day and `now` are arguments, never read from a clock.

import { MARKETS, type CustomerRow, type Market } from "@convex/lib/customerShape";
import { dayLabel, formatValue } from "@/lib/format";
import { baaMissing, health, type Health, type HealthLevel, type RegisterDay } from "./health";

/** Health levels in the order the page lists them: what needs acting on first. */
export const HEALTH_ORDER: readonly HealthLevel[] = [
  "at_risk",
  "watch",
  "unknown",
  "good",
  "not_assessed",
];

export type CustomerFilters = {
  /** Only clinics at this level. null is every level. */
  health: HealthLevel | null;
  /** Only US clinics with no BAA date on record. */
  baaMissing: boolean;
  market: Market | null;
  /** Clinics no longer in the register are hidden unless asked for. */
  archived: boolean;
};

export const NO_FILTERS: CustomerFilters = {
  health: null,
  baaMissing: false,
  market: null,
  archived: false,
};

type Params = { get(name: string): string | null };

/** The filters a URL asks for. Anything it does not recognise is ignored. */
export function filtersFromParams(params: Params): CustomerFilters {
  const level = params.get("health");
  const market = params.get("market");
  return {
    health: (HEALTH_ORDER as readonly string[]).includes(level ?? "") ? (level as HealthLevel) : null,
    baaMissing: params.get("baa") === "missing",
    market: (MARKETS as readonly string[]).includes(market ?? "") ? (market as Market) : null,
    archived: params.get("archived") === "1",
  };
}

/** The same filters as a query string ("" when there are none). */
export function filtersToQuery(filters: CustomerFilters): string {
  const params = new URLSearchParams();
  if (filters.health !== null) params.set("health", filters.health);
  if (filters.baaMissing) params.set("baa", "missing");
  if (filters.market !== null) params.set("market", filters.market);
  if (filters.archived) params.set("archived", "1");
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function hasFilters(filters: CustomerFilters): boolean {
  return filters.health !== null || filters.baaMissing || filters.market !== null;
}

export type Assessed = { clinic: CustomerRow; health: Health };

/**
 * Each clinic with its health as of the register's last push, in the order
 * the query gave them (by name).
 */
export function assess(customers: readonly CustomerRow[], register: RegisterDay | null): Assessed[] {
  return customers.map((clinic) => ({ clinic, health: health(clinic, register) }));
}

export function applyFilters(rows: readonly Assessed[], filters: CustomerFilters): Assessed[] {
  return rows.filter(
    ({ clinic, health: verdict }) =>
      (filters.archived || !clinic.archived) &&
      (filters.health === null || verdict.level === filters.health) &&
      (!filters.baaMissing || baaMissing(clinic)) &&
      (filters.market === null || clinic.market === filters.market),
  );
}

/** How many clinics still in the register sit at each level. */
export function healthCounts(rows: readonly Assessed[]): Record<HealthLevel, number> {
  const counts: Record<HealthLevel, number> = {
    at_risk: 0,
    watch: 0,
    unknown: 0,
    good: 0,
    not_assessed: 0,
  };
  for (const { clinic, health: verdict } of rows) {
    if (!clinic.archived) counts[verdict.level] += 1;
  }
  return counts;
}

// ── How a value reads. A value that is not on record says so: never 0, never
// a dash that could be taken for "none". ────────────────────────────────────

export const NOT_ON_RECORD = "Not on record";

export function dateText(day: string | null, now: number): string {
  return day === null ? NOT_ON_RECORD : dayLabel(day, now);
}

export function feeText(clinic: CustomerRow): string {
  return clinic.monthlyFee === null
    ? NOT_ON_RECORD
    : formatValue(clinic.monthlyFee, "currency", clinic.currency);
}

export function owedText(clinic: CustomerRow): string {
  if (clinic.amountOwed === null) return NOT_ON_RECORD;
  // A zero the register states is a fact, and reads as one.
  if (clinic.amountOwed === 0) return "Nothing owed";
  return formatValue(clinic.amountOwed, "currency", clinic.currency);
}

/** No usage date is "Unknown": it does not mean the clinic is not using the product. */
export function usageText(clinic: CustomerRow, now: number): string {
  return clinic.lastUsageDate === null ? "Unknown" : dayLabel(clinic.lastUsageDate, now);
}

/**
 * A blank cell proves only that the register holds no date, so a US clinic
 * without one reads "No date on record", never "No BAA". HIPAA is US law: a
 * Kazakhstan clinic's is "Not applicable".
 */
export function baaText(clinic: CustomerRow, now: number): string {
  if (clinic.market !== "us") return "Not applicable";
  return clinic.baaDate === null ? "No date on record" : dayLabel(clinic.baaDate, now);
}

export function nextTouchText(clinic: CustomerRow, now: number): string {
  return clinic.nextTouch === null ? "Not set" : dayLabel(clinic.nextTouch, now);
}
