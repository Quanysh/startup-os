// The plan the financial model sends: three scenarios, a handful of figures
// per year. Pure, so the ingest endpoint, the push script and the UI all read
// the same list. The plan is not a metric: it has no registry entry, no
// snapshot and no benchmark.

export const PLAN_SCENARIOS = ["bear", "base", "bull"] as const;
export type PlanScenario = (typeof PLAN_SCENARIOS)[number];

export const PLAN_SCENARIO_LABELS: Record<PlanScenario, string> = {
  bear: "Bear",
  base: "Base",
  bull: "Bull",
};

/** In the order the Finance page lists them. */
export const PLAN_KEYS = [
  "arr",
  "revenue",
  "net_burn",
  "cash_end",
  "headcount",
  "paying_customers",
  "capital_raised",
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export type PlanKeyDef = {
  label: string;
  unit: "currency" | "count";
  /** Limits for a value that could be true. Outside them a push is refused. */
  min: number;
  max: number;
};

const MONEY = 1e11;

export const PLAN_KEY_DEFS: Record<PlanKey, PlanKeyDef> = {
  arr: { label: "ARR at year-end", unit: "currency", min: 0, max: MONEY },
  revenue: { label: "Revenue for the year", unit: "currency", min: 0, max: MONEY },
  // Negative once the plan generates cash.
  net_burn: { label: "Net burn for the year", unit: "currency", min: -MONEY, max: MONEY },
  // Negative is a funding gap, which the plan must be able to say.
  cash_end: { label: "Cash at year-end", unit: "currency", min: -MONEY, max: MONEY },
  headcount: { label: "People", unit: "count", min: 0, max: 1e5 },
  paying_customers: { label: "Paying customers at year-end", unit: "count", min: 0, max: 1e6 },
  capital_raised: { label: "Capital raised in the year", unit: "currency", min: 0, max: MONEY },
};

export const PLAN_FIRST_YEAR = 2020;
export const PLAN_LAST_YEAR = 2045;
export const MAX_PLAN_YEARS = 12;
/** The model's own version: a hash, so it is safe to print and to store. */
export const PLAN_VERSION_PATTERN = /^[0-9a-f]{6,40}$/;

export type PlanRow = { scenario: PlanScenario; year: number; key: PlanKey; value: number };

export function isPlanScenario(value: unknown): value is PlanScenario {
  return PLAN_SCENARIOS.includes(value as PlanScenario);
}

export function isPlanKey(value: unknown): value is PlanKey {
  return PLAN_KEYS.includes(value as PlanKey);
}
