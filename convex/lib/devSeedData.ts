// The made-up data set a local backend is filled with (`pnpm dev:seed`,
// convex/devSeed.ts). EVERYTHING HERE IS INVENTED: no person, clinic, firm,
// figure, rate or address is real, and nothing here was copied from one. Names
// say so ("Example", "Sample", "Placeholder", "Demo", "Mock"), addresses are on
// reserved `.test` domains, and the payroll lines are named as made up because
// no rate of any tax law belongs in this repository.
//
// Pure: every builder takes `now` and returns rows, so a test can check them
// against the registry and the mirror's own rules without a backend, and the
// same `now` always gives the same rows.

import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import { SOURCES } from "../connectors/manifest";
import { addMonths, type CostBucket, type CostCadence, type CostCategory } from "./costs";
import { COMPANIES } from "./company";
import { nameKeyOf } from "./customerShape";
import type { StoredIntel } from "./dealIntel";
import {
  LOCAL_DOMAIN,
  localEmail,
  type LocalCompanyChoice,
  type LocalRole,
} from "./devLocal";
import {
  KZ_DETAIL_FIGURES,
  KZ_ERROR_KINDS,
  KZ_FAILURE_CAUSES,
  KZ_MODULES,
  errorKindKey,
  failureKey,
  moduleKey,
  doctorWeekOf,
  trialOutcomeOf,
  type KzModuleId,
} from "./kzProductDetail";
import { METRICS, currencyOf, type MetricDef, type Scope } from "./metricRegistry";
import type { MirrorRecord, MirrorSource } from "./mirrorRules";
import { nextPeriodStart, periodStart, previousPeriodStart } from "./periods";
import { PLAN_KEYS, PLAN_SCENARIOS, type PlanKey, type PlanScenario } from "./planShape";
import { APOLLO_FINISHED_WEEK_KEYS, GITHUB_FINISHED_WEEK_KEYS } from "./pushRules";
import { quarterOf } from "./quarter";
import { SUGGESTED_ROLES } from "./roleRules";
import { areasOf, isGrantableArea, isMemberRole, type GrantableArea, type MemberRole } from "./roles";
import type { SharedRecord } from "./sharedRecords";
import type { SnapshotInput } from "./snapshotRules";
import type { FinOutcome, SupportOrigin, SupportRow } from "./support";
import { closedWeeks } from "./weeks";

type Row<Table extends "deals" | "investors" | "customers" | "obligations"> = WithoutSystemFields<
  Doc<Table>
>;
type CompanyId = "us" | "kz";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const daysAgo = (now: number, days: number) => day(now - days * DAY_MS);
/** Midnight UTC of the day `now` falls on. */
const midnight = (now: number) => Date.parse(`${day(now)}T00:00:00Z`);

// ── People ──────────────────────────────────────────────────────────────────

export type SeedPerson = {
  role: LocalRole;
  companies: LocalCompanyChoice;
  name: string;
  /**
   * Also given the Today page. The first of them (`TODAY_TEAMMATE`) has mail,
   * calendar, notes and issues of their own; the others have connected
   * nothing, and see what needs them above how to connect.
   */
  today?: boolean;
  /** Their GitHub username: an author of the seed's made-up pull requests. */
  github?: string;
};

/** The local roles that stand for a role the owner named, as the seed makes each. */
export type SeedRoleKey = Exclude<LocalRole, "owner" | MemberRole>;
const suggested = (name: string) => SUGGESTED_ROLES.find((role) => role.name === name)!;
/** Two roles with different focuses: marketing, and customers. */
export const SEED_ROLES: Record<SeedRoleKey, (typeof SUGGESTED_ROLES)[number]> = {
  marketing: suggested("Marketing"),
  success: suggested("Customer success"),
};
export const isSeedRole = (role: LocalRole): role is SeedRoleKey =>
  Object.hasOwn(SEED_ROLES, role);

/** The pages a made-up teammate starts with: their role's usual ones. */
export function seedAreasOf(role: LocalRole): GrantableArea[] {
  if (isSeedRole(role)) return [...SEED_ROLES[role].areas];
  return isMemberRole(role) ? areasOf(role).filter(isGrantableArea) : [];
}

/**
 * The owner, and two teammates of each role, the two named ones included.
 * `pnpm dev:signin` signs in as one of these.
 */
export const SEED_PEOPLE: readonly SeedPerson[] = [
  { role: "owner", companies: "both", name: "Owner Example" },
  { role: "cofounder", companies: "both", name: "Ada Example", today: true },
  { role: "cofounder", companies: "kz", name: "Dana Sample" },
  { role: "sales", companies: "both", name: "Sam Placeholder", today: true },
  { role: "sales", companies: "us", name: "Riley Mockwell" },
  { role: "engineer", companies: "both", name: "Max Fixture", today: true, github: "example-ben" },
  { role: "engineer", companies: "kz", name: "Timur Testov", github: "example-dana" },
  { role: "marketing", companies: "both", name: "Mina Example", today: true },
  { role: "marketing", companies: "us", name: "Noor Sample" },
  { role: "success", companies: "both", name: "Cora Placeholder", today: true },
  { role: "success", companies: "kz", name: "Aru Mockwell" },
];

export const emailOf = (person: Pick<SeedPerson, "role" | "companies">) =>
  localEmail(person.role, person.companies);

export const companiesOf = (choice: LocalCompanyChoice): CompanyId[] =>
  choice === "both" ? ["us", "kz"] : [choice];

/** The name a made-up local person goes by: the seeded one, or one built from the role. */
export function localName(role: LocalRole, companies: LocalCompanyChoice): string {
  const seeded = SEED_PEOPLE.find((p) => p.role === role && p.companies === companies);
  if (seeded) return seeded.name;
  return `${role[0]!.toUpperCase()}${role.slice(1)} Example (${companies})`;
}

/** The teammate who has a Today page of their own. */
export const TODAY_TEAMMATE = SEED_PEOPLE.find((person) => person.today)!;

/**
 * A teammate's row in `members`, as `team.add` would write it: their role's
 * usual pages. `role` is what the row stores: a built-in word, or the id of
 * the seeded role a named local role stands for.
 */
export function seedMember<Stored>(person: SeedPerson, role: Stored) {
  const areas = seedAreasOf(person.role);
  return {
    email: emailOf(person),
    role,
    companies: companiesOf(person.companies),
    areas: [...areas, ...(person.today && !areas.includes("today") ? (["today"] as const) : [])],
    ...(person.github === undefined ? null : { github: person.github }),
  };
}

// ── Metric snapshots ────────────────────────────────────────────────────────

/** A steady pseudo-random number in [-1, 1] for a name and a position. */
function noise(seed: string, index: number): number {
  let hash = 2166136261;
  for (const char of `${seed}#${index}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

type Shape = {
  /** The newest bucket's value, give or take `wobble`. */
  base: number;
  /** Growth per bucket, as a fraction: older buckets are smaller by it. */
  step?: number;
  /** How far a bucket strays from the line, as a fraction. */
  wobble?: number;
  /** A total to date: each bucket adds `base` (give or take) to the one before. */
  cumulative?: boolean;
  /** A share of another metric of the same scope, bucket by bucket. */
  shareOf?: [key: string, share: number];
  /**
   * How far a bucket swings from the one before, as a fraction, from a hash
   * mixed well enough that neighbouring weeks differ (`noise` moves little
   * from one bucket to the next). Globex's figures in detail use it, so
   * their week-on-week changes show.
   */
  swing?: number;
};

/** A pseudo-random number in [-1, 1] whose neighbours are unrelated: `noise`, finished with murmur3's mix. */
function swingNoise(seed: string, index: number): number {
  let h = Math.round(((noise(seed, index) + 1) / 2) * 0xffffffff) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// What each figure looks like. Keyed by "key:scope", then by key. A metric
// with no line here (one added to the registry later) still gets a plain
// series from `fallback`, so a new tile is never empty locally.
const SHAPES: Record<string, Shape> = {
  "mrr:us": { base: 46_500, step: 0.035, wobble: 0.01 },
  "mrr:kz": { base: 6_400_000, step: 0.03, wobble: 0.015 },
  mrr_contracted: { base: 6_900_000, step: 0.03, wobble: 0.01 },
  "cash:us": { base: 1_840_000, step: -0.0015, wobble: 0.001 },
  "cash:kz": { base: 41_000_000, step: -0.02, wobble: 0.01 },
  cash_in: { base: 51_000, step: 0.035, wobble: 0.06 },
  cash_out: { base: 128_000, step: 0.01, wobble: 0.05 },
  // Startup's funding of Globex: a part of its money out, never more.
  cash_to_subsidiary: { base: 0, shareOf: ["cash_out", 0.35] },
  "paying_clinics:us": { base: 38, step: 0.03 },
  "paying_clinics:kz": { base: 26, step: 0.025 },
  clinics_active: { base: 29, step: 0.02 },
  clinics_using: { base: 22, step: 0.025 },
  receivables: { base: 1_350_000, wobble: 0.2 },
  logo_churn_monthly: { base: 2.4, wobble: 0.5 },
  // Globex's AI token cost, dollars a month, and the clinics it was spent on.
  ai_token_cost: { base: 64, step: 0.08, wobble: 0.1 },
  ai_token_clinics: { base: 53, step: 0.04 },
  fx_usd_kzt: { base: 500, wobble: 0.01 },

  "weekly_active_users:startup_insights": { base: 640, step: 0.02, wobble: 0.05 },
  "weekly_active_users:vertical_startup": { base: 86, step: 0.015, wobble: 0.06 },
  "weekly_active_users:kz_product": { base: 142, step: 0.01, wobble: 0.05 },
  searches: { base: 5_200, step: 0.02, wobble: 0.07 },
  web_visitors: { base: 3_100, step: 0.015, wobble: 0.08 },
  signups: { base: 124, step: 0.015, wobble: 0.12 },
  signups_activated: { base: 0, shareOf: ["signups", 0.46] },
  site_pageviews: { base: 9_800, step: 0.015, wobble: 0.08 },
  deploys: { base: 14, wobble: 0.3 },
  deploys_failed: { base: 0, shareOf: ["deploys", 0.08] },
  clinics_checking: { base: 19, step: 0.01, wobble: 0.08 },
  checks_completed: { base: 930, step: 0.015, wobble: 0.08 },
  practices_active: { base: 12, step: 0.01, wobble: 0.1 },
  core_actions: { base: 410, step: 0.02, wobble: 0.1 },
  practices: { base: 14, step: 0.001 },

  search_impressions: { base: 18_500, step: 0.02, wobble: 0.07 },
  search_clicks: { base: 0, shareOf: ["search_impressions", 0.023] },
  search_position: { base: 14.2, step: -0.004, wobble: 0.04 },
  linkedin_followers: { base: 1_260, step: 0.008 },
  meetings_booked: { base: 6, wobble: 0.4 },

  outbound_delivered: { base: 180, wobble: 0.2, cumulative: true },
  outbound_opened: { base: 0, shareOf: ["outbound_delivered", 0.42] },
  outbound_replied: { base: 0, shareOf: ["outbound_delivered", 0.045] },
  apollo_contacts: { base: 4_200, step: 0.012 },
  apollo_accounts: { base: 610, step: 0.01 },
  apollo_tasks_open: { base: 37, wobble: 0.25 },
  apollo_tasks_overdue: { base: 0, shareOf: ["apollo_tasks_open", 0.2] },
  apollo_contacts_added: { base: 55, wobble: 0.3 },
  apollo_calls: { base: 24, wobble: 0.3 },
};

// Globex's app in detail: each part a share of its whole, so a module never
// has more doctors than the app had and the causes add up to the failures.
const KZ_MODULE_SHARES: Record<
  KzModuleId,
  [actions: number, doctors: number, failures: number, clinics: number, p95: number, aiCost: number]
> = {
  intake: [0.3, 0.3, 0.3, 0.8, 60, 7],
  records: [0.1, 0.1, 0.1, 0.5, 70, 3],
  visits: [0.05, 0.1, 0.15, 0.4, 40, 1],
  search: [0.2, 0.2, 0.1, 0.8, 110, 10],
  inquiries: [0.05, 0.05, 0.1, 0.3, 40, 0.2],
  forms: [0.2, 0.2, 0.1, 0.1, 50, 3],
  capture: [0.05, 0.05, 0.1, 0.1, 280, 2],
  journal: [0.01, 0.02, 0.03, 0.1, 50, 0.2],
  lookup: [0.005, 0.01, 0, 0.05, 10, 0.05],
  orders: [0.005, 0.01, 0, 0.05, 15, 0.05],
};
const KZ_CAUSE_SHARES = [0.25, 0.05, 0.1, 0.1, 0.05, 0.05, 0.05, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05];
const KZ_DETAIL_SHAPES: Record<string, Shape> = {
  doctors_working: { base: 0, shareOf: ["weekly_active_users", 0.72] },
  checks_started: { base: 1_000, step: 0.015, wobble: 0.06 },
  actions: { base: 1_600, step: 0.015, wobble: 0.08 },
  failures_total: { base: 0, shareOf: ["actions", 0.045] },
  checks_trial: { base: 0, shareOf: ["checks_started", 0.32] },
  checks_paid: { base: 0, shareOf: ["checks_started", 0.68] },
  clinics_trial: { base: 0, shareOf: ["clinics_checking", 0.35] },
  clinics_paid: { base: 0, shareOf: ["clinics_checking", 0.65] },
  ai_cost_total: { base: 25, step: 0.03, wobble: 0.1 },
  // The app as a whole (made up): its model, interface, sign-ins and uploads.
  ai_calls: { base: 3_400, step: 0.015, wobble: 0.08 },
  ai_calls_off_model: { base: 0 },
  inp_p75: { base: 240, step: 0.03, wobble: 0.15 },
  inp_poor_share: { base: 16, step: 0.02, wobble: 0.15 },
  lcp_p75: { base: 2_600, wobble: 0.06 },
  rage_clicks: { base: 300, wobble: 0.2 },
  rage_session_share: { base: 10, wobble: 0.05 },
  exceptions_web: { base: 30, wobble: 0.3 },
  exceptions_server: { base: 25, step: 0.04, wobble: 0.3 },
  stale_session_retries: { base: 125, wobble: 0.12 },
  auth_redirects: { base: 6, step: 0.1, wobble: 0.4 },
  uploads: { base: 80, wobble: 0.2 },
  uploads_failed: { base: 0, shareOf: ["uploads", 0.3] },
  failure_hours_busy: { base: 6, step: 0.06, wobble: 0.3 },
  failure_worst_hour: { base: 12, step: 0.05, wobble: 0.3 },
  trial_ended_per_doctor: { base: 7, wobble: 0.1 },
  new_doctors: { base: 9, wobble: 0.3 },
  new_doctors_started: { base: 0, shareOf: ["new_doctors", 0.6] },
  doctors_never_started_recent: { base: 0, shareOf: ["doctors_never_started", 0.3] },
  // Must be zero: an error message holding a model's answer is a leak.
  error_record_text: { base: 0 },
  ...Object.fromEntries(
    KZ_MODULES.flatMap((m) => {
      const [actions, doctors, failures, clinics, p95, aiCost] = KZ_MODULE_SHARES[m.id];
      return [
        [moduleKey("actions", m.id), { base: 0, shareOf: ["actions", actions] }],
        [moduleKey("doctors", m.id), { base: 0, shareOf: ["doctors_working", doctors] }],
        [moduleKey("clinics", m.id), { base: 0, shareOf: ["clinics_checking", clinics] }],
        [moduleKey("failures", m.id), { base: 0, shareOf: ["failures_total", failures] }],
        [moduleKey("p95", m.id), { base: p95, step: 0.04, wobble: 0.15 }],
        [moduleKey("ai_cost", m.id), { base: aiCost, step: 0.05, wobble: 0.2 }],
        // Speed & AI: the median about 45% of the slowest answers, a slow share
        // that rises with them, and a few requests sent twice.
        [moduleKey("p50", m.id), { base: Math.max(3, Math.round(p95 * 0.45)), step: 0.03, wobble: 0.1 }],
        [moduleKey("slow_share", m.id), { base: p95 > 90 ? 18 : p95 > 50 ? 6 : 1.5, step: 0.08, wobble: 0.3 }],
        [moduleKey("hedged_share", m.id), { base: p95 > 50 ? 8 : 2, step: 0.1, wobble: 0.3 }],
        [moduleKey("cost_per_result", m.id), { base: Math.max(0.002, Math.round((aiCost / 300) * 1000) / 1000), step: 0.05, wobble: 0.2 }],
        [moduleKey("tokens_p95", m.id), { base: Math.round(8_000 + p95 * 400), step: 0.06, wobble: 0.2 }],
      ];
    }),
  ),
  ...Object.fromEntries(
    KZ_FAILURE_CAUSES.map((c, i) => [failureKey(c.id), { base: 0, shareOf: ["failures_total", KZ_CAUSE_SHARES[i]] }]),
  ),
  ...Object.fromEntries(
    KZ_ERROR_KINDS.map((k, i) => [errorKindKey(k.id), { base: 0, shareOf: ["failures_total", [0.32, 0.12, 0.14, 0.05, 0.17, 0.1, 0.1][i]] }]),
  ),
  doctors_daily: { base: 0, shareOf: ["doctors_working", 0.3] },
  doctors_new: { base: 7, step: -0.05, wobble: 0.4 },
  doctors_more: { base: 9, step: -0.04, wobble: 0.3 },
  doctors_less: { base: 10, step: 0.06, wobble: 0.3 },
  doctors_stopped: { base: 9, step: 0.07, wobble: 0.35 },
  doctors_never_started: { base: 20, wobble: 0.1 },
  trials_ended: { base: 7, step: 0.06, wobble: 0.4 },
  // Paid, kept working and left add up to no more than the trials ended: the
  // rest never used the app. No swing on them, so they cannot overshoot.
  trials_converted: { base: 0, shareOf: ["trials_ended", 0.32], swing: 0 },
  trials_continuing: { base: 0, shareOf: ["trials_ended", 0.3], swing: 0 },
  trials_lost: { base: 0, shareOf: ["trials_ended", 0.24], swing: 0 },
  clinics_silent: { base: 2, step: 0.12, wobble: 0.5 },
  clinics_declining: { base: 3, step: 0.1, wobble: 0.4 },
  clinics_new: { base: 1, wobble: 0.6 },
};
// Every one of them swings week to week, so the chips have something to say.
for (const [key, shape] of Object.entries(KZ_DETAIL_SHAPES)) {
  if (key !== "error_record_text") shape.swing ??= key.startsWith("module_") ? 0.25 : 0.15;
}
Object.assign(SHAPES, KZ_DETAIL_SHAPES);

function fallback(metric: MetricDef): Shape {
  const base = { currency: 10_000, count: 20, percent: 12, ratio: 3, months: 12 }[metric.unit];
  return { base, wobble: 0.2 };
}

const shapeOf = (metric: MetricDef, scope: string): Shape =>
  SHAPES[`${metric.key}:${scope}`] ?? SHAPES[metric.key] ?? fallback(metric);

/** A value the registry would accept: rounded for its unit and held to its limits. */
function fit(metric: MetricDef, value: number): number {
  const rounded =
    // A week's dollars (Globex's AI cost by module, and a result's) are small: kept to a tenth of a cent.
    metric.unit === "currency" && metric.grain === "week"
      ? Math.round(value * 1000) / 1000
      : metric.integer || metric.unit === "currency" || metric.unit === "count"
        ? Math.round(value)
        : Math.round(value * 10) / 10;
  return Math.min(Math.max(rounded, metric.min ?? 0), metric.max ?? Number.MAX_SAFE_INTEGER);
}

function seriesOf(metric: MetricDef, scope: string, length: number): number[] {
  const shape = shapeOf(metric, scope);
  if (shape.shareOf) {
    const [key, share] = shape.shareOf;
    const other = METRICS.find((m) => m.key === key);
    const whole = other ? seriesOf(other, scope, length) : Array<number>(length).fill(0);
    const swung = (value: number, index: number) =>
      value * share * (1 + (shape.swing ?? 0) * swingNoise(`${metric.key}:${scope}`, index));
    // Never more than the whole it is a share of.
    return whole.map((value, index) => Math.min(fit(metric, swung(value, index)), value));
  }
  const seed = `${metric.key}:${scope}`;
  const at = (index: number) =>
    shape.base *
    (1 + (shape.step ?? 0)) ** (index - (length - 1)) *
    (1 + (shape.wobble ?? 0) * noise(seed, index)) *
    (1 + (shape.swing ?? 0) * swingNoise(seed, index));
  if (!shape.cumulative) return Array.from({ length }, (_, index) => fit(metric, at(index)));
  let total = 0;
  return Array.from({ length }, (_, index) => (total += Math.max(fit(metric, at(index)), 0)));
}

export const SEED_MONTHS = 13;
export const SEED_WEEKS = 26;
export const SEED_DETAIL_WEEKS = 13;
const KZ_DETAIL_KEYS = new Set(KZ_DETAIL_FIGURES.map((f) => f.key));
// The figures only a chip or a small tile reads (a module's clinics, answer
// time and AI cost, a failure's cause): a month is enough, and keeps the seed
// quick with sixty-odd of them.
export const SEED_SHORT_WEEKS = 4;
const KZ_SHORT_KEYS = /^(module_(clinics|p95|ai_cost|hedged_share|cost_per_result|tokens_p95)_|failures_(?!total$))/;
export const SEED_DAYS = 60;

/** The `count` months that have ended by `now`, oldest first, as bucket starts. */
export function closedMonths(now: number, count: number): string[] {
  const months: string[] = [];
  let month = periodStart("month", now);
  for (let i = 0; i < count; i += 1) months.unshift((month = previousPeriodStart("month", month)));
  return months;
}

/** The buckets a metric is seeded for, oldest first. */
function bucketsOf(metric: MetricDef, scope: string, now: number): string[] {
  const source = metric.sources[scope as Scope];
  if (metric.grain === "month") return closedMonths(now, SEED_MONTHS);
  if (metric.grain === "week") {
    // Globex's figures in detail: the thirteen weeks the page shows, so the
    // seed stays quick with forty-odd of them.
    if (KZ_SHORT_KEYS.test(metric.key)) return closedWeeks(now, SEED_SHORT_WEEKS);
    if (KZ_DETAIL_KEYS.has(metric.key)) return closedWeeks(now, SEED_DETAIL_WEEKS);
    const weeks = closedWeeks(now, SEED_WEEKS);
    // GitHub's levels (open, waiting, failing, tracked) are read now and filed
    // under the week in progress alone; its counts are of finished weeks.
    if (source === "github" && !GITHUB_FINISHED_WEEK_KEYS.includes(metric.key)) {
      return [periodStart("week", now)];
    }
    // Apollo's totals and levels are filed under the week in progress too.
    return source === "apollo" && !APOLLO_FINISHED_WEEK_KEYS.includes(metric.key)
      ? [...weeks, periodStart("week", now)]
      : weeks;
  }
  // A balance typed in by hand once a month is dated the month's last day,
  // which is what closes that month (`monthCloses` in src/lib/metrics/finance.ts).
  if (source === "manual") {
    return closedMonths(now, SEED_MONTHS).map((month) =>
      day(Date.parse(`${nextPeriodStart("month", month)}T00:00:00Z`) - DAY_MS),
    );
  }
  return Array.from({ length: SEED_DAYS }, (_, i) => daysAgo(now, SEED_DAYS - 1 - i));
}

/**
 * Every figure of every metric in the registry, by the source that owns it:
 * thirteen finished months, twenty-six finished weeks, sixty days. A sparse
 * metric (an event) gets one row, months ago, on its first scope alone.
 */
export function seedSnapshots(now: number): { source: string; rows: SnapshotInput[] }[] {
  const bySource = new Map<string, SnapshotInput[]>();
  for (const metric of METRICS) {
    const scopes = Object.keys(metric.sources) as Scope[];
    for (const scope of scopes) {
      const source = metric.sources[scope]!;
      const currency = currencyOf(metric, scope);
      const rows = bySource.get(source) ?? [];
      bySource.set(source, rows);
      const push = (start: string, value: number) =>
        rows.push({
          key: metric.key,
          scope,
          period: metric.grain,
          periodStart: start,
          value,
          ...(currency === undefined ? null : { currency }),
        });
      if (metric.sparse) {
        // One made-up round, in the first market only.
        if (scope === scopes[0]) {
          const months = closedMonths(now, SEED_MONTHS);
          push(months[months.length - 8]!, fit(metric, 1_500_000));
        }
        continue;
      }
      const buckets = bucketsOf(metric, scope, now);
      const trials = TRIAL_KEYS[metric.key];
      if (trials !== undefined && scope === "kz_product") {
        // Counted from the made-up doctors, so a week's bar and its doctors agree.
        const counts = trialWeeks(now);
        buckets.forEach((start) => push(start, counts.get(`${trials}:${start}`) ?? 0));
        continue;
      }
      const values = seriesOf(metric, scope, buckets.length);
      buckets.forEach((start, index) => push(start, values[index]!));
    }
  }
  return [...bySource].map(([source, rows]) => ({ source, rows }));
}

/** The trial figures, each the count of one outcome (or every trial: "ended"). */
const TRIAL_KEYS: Record<string, string> = {
  trials_ended: "ended",
  trials_converted: "paid",
  trials_continuing: "kept",
  trials_lost: "left",
};

/** The made-up doctors' trials by the week they ended and by outcome: "paid:2026-10-12" → 2. */
function trialWeeks(now: number): Map<string, number> {
  const clinics = seedCustomers(now)
    .filter((c) => c.archivedAt === undefined && c.status === "active")
    .map((c, index) => ({ id: index, name: c.name }));
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const d of seedCustomerDoctors(now, clinics, seedCustomerUsage(now, clinics))) {
    if (d.trialEndedOn === undefined || d.trialOutcome === undefined) continue;
    const week = periodStart("week", Date.parse(`${d.trialEndedOn}T12:00:00Z`));
    add(`ended:${week}`);
    add(`${d.trialOutcome}:${week}`);
  }
  return counts;
}

/** How each source in the manifest last ran: all well but two, so both states show. */
export function seedSourceStatus(now: number): WithoutSystemFields<Doc<"sourceStatus">>[] {
  return SOURCES.map((source) => {
    if (source.id === "visible") {
      return { source: source.id, state: "not_configured" as const, lastRunAt: now - HOUR_MS };
    }
    if (source.id === "vercel") {
      // A run that failed after an earlier good one: its figures stay, and the page says so.
      return {
        source: source.id,
        state: "error" as const,
        message: "The request failed with status 503.",
        lastRunAt: now - HOUR_MS,
        lastOkAt: now - 26 * HOUR_MS,
      };
    }
    // The client register was pushed two days ago; everything else just ran.
    const at = source.id === "client_register" ? now - 2 * DAY_MS : now - 10 * 60 * 1000;
    return { source: source.id, state: "ok" as const, lastRunAt: at, lastOkAt: at };
  });
}

export function seedSyncRuns(now: number): WithoutSystemFields<Doc<"syncRuns">>[] {
  const run = (
    source: string,
    minutesAgo: number,
    counts: [inserted: number, updated: number, unchanged: number],
    extra: Partial<WithoutSystemFields<Doc<"syncRuns">>> = {},
  ) => ({
    source,
    startedAt: now - minutesAgo * 60_000 - 4_000,
    finishedAt: now - minutesAgo * 60_000,
    status: "ok" as const,
    inserted: counts[0],
    updated: counts[1],
    unchanged: counts[2],
    ...extra,
  });
  return [
    run("mercury", 10, [1, 2, 14]),
    run("posthog", 12, [0, 3, 53]),
    run("posthog_globex", 14, [0, 40, 1100]),
    run("apollo", 15, [0, 8, 0]),
    run("search_console", 20, [0, 0, 24]),
    run("cfo_workbook", 3 * 24 * 60, [9, 0, 108], { batchId: "seed-workbook" }),
    run("client_register", 2 * 24 * 60, [14, 0, 0], { batchId: "seed-register" }),
    run("vercel", 60, [0, 0, 0], {
      status: "error" as const,
      message: "The request failed with status 503.",
    }),
  ];
}

// ── Pipelines ───────────────────────────────────────────────────────────────

type Card = {
  name: string;
  contact?: string;
  stage: string;
  sourceStage?: string;
  amount?: number;
  /** Days since anything happened on it. */
  quiet?: number;
  /** Days since it was won, lost, committed or passed. */
  closed?: number;
  nextStep?: string;
  notes?: string;
};

/** A US deal's details (convex/lib/dealDetails.ts), and whether it was archived (days ago). */
type UsCard = Card & {
  details?: {
    priority?: "high" | "medium" | "low";
    region?: string;
    physicians?: number;
    locations?: number;
    sources?: string[];
  };
  archived?: number;
};

const pipelineRows =<T extends { stage: string }>(cards: readonly T[]) => {
  const next = new Map<string, number>();
  return cards.map((card) => {
    const order = next.get(card.stage) ?? 0;
    next.set(card.stage, order + 1);
    return { card, order };
  });
};

const cardFields = (now: number, card: Card, order: number) => ({
  name: card.name,
  ...(card.contact ? { contact: card.contact } : null),
  stage: card.stage,
  ...(card.sourceStage ? { sourceStage: card.sourceStage } : null),
  ...(card.amount === undefined ? null : { amount: card.amount }),
  lastActivityAt: now - (card.quiet ?? card.closed ?? 2) * DAY_MS,
  ...(card.closed === undefined ? null : { closedAt: now - card.closed * DAY_MS }),
  order,
  ...(card.nextStep ? { nextStep: card.nextStep } : null),
  ...(card.notes ? { notes: card.notes } : null),
});

// Startup's deals are made on the board ("manual"). Monthly fee, in dollars.
// Some carry the details a prospect list brings (priority, region, size, the
// research behind them), as `pnpm import:prospects` would leave them, and one
// was archived, so the table and its Archived group are not empty locally.
const US_DEALS: UsCard[] = [
  {
    name: "Maple Street Clinic",
    contact: "Pat Example",
    stage: "lead",
    amount: 900,
    quiet: 1,
    details: { priority: "medium", region: "TX", physicians: 8, locations: 2 },
  },
  { name: "Harbor View Dental (example)", contact: "Jo Sample", stage: "lead", quiet: 6 },
  { name: "Placeholder Pediatrics", stage: "lead", amount: 600, quiet: 24 },
  {
    name: "Sample Bone and Joint (example)",
    contact: "Dr. Robin Sample",
    stage: "lead",
    quiet: 4,
    nextStep: "Ask for twenty minutes with the billing lead",
    notes:
      "Made-up research: a large specialty group on a sample EHR, heavy on prior authorizations. A made-up note long enough to be cut short in the table.",
    details: {
      priority: "high",
      region: "OH",
      physicians: 59,
      locations: 29,
      sources: ["Made-up specialty market scan", "Sample payer mix note"],
    },
  },
  {
    name: "Placeholder Spine Center",
    stage: "lead",
    quiet: 4,
    details: { priority: "low", region: "AZ", physicians: 6, locations: 1, sources: ["Made-up specialty market scan"] },
  },
  {
    name: "Example Specialty Group",
    contact: "Dr. Casey Placeholder",
    stage: "qualified",
    amount: 2_400,
    quiet: 3,
    nextStep: "Send the pilot outline",
    details: { priority: "high", region: "TX", physicians: 21, locations: 7 },
  },
  { name: "Sample Family Practice", stage: "qualified", amount: 1_100, quiet: 12 },
  {
    name: "Mock Sports Medicine (archived example)",
    stage: "lead",
    quiet: 30,
    notes: "Made-up: not a fit, archived rather than deleted.",
    details: { priority: "low", region: "NV", physicians: 3, locations: 1 },
    archived: 10,
  },
  {
    name: "Mockingbird Lane Clinic",
    contact: "Morgan Mock",
    stage: "demo",
    amount: 1_800,
    quiet: 2,
    nextStep: "Demo on Thursday",
    notes: "Asked about the denial queue. A made-up note on a made-up clinic.",
  },
  { name: "Fictional Physio Group", stage: "proposal", amount: 3_200, quiet: 5 },
  { name: "Demo Derm Associates", stage: "proposal", amount: 1_500, quiet: 31 },
  { name: "Sample Street Procedure Center", stage: "won", amount: 2_900, closed: 9 },
  { name: "Example Eye Care", stage: "won", amount: 1_200, closed: 40 },
  { name: "Placeholder Urgent Care", stage: "lost", amount: 2_000, closed: 18 },
];

// Globex's come from its CRM ("kz_crm"), stage names as that system writes
// them. Monthly fee, in tenge. One stage name the OS does not know, to show
// the "Unsorted" column.
const KZ_DEALS: Card[] = [
  { name: "Demo Clinic Almaty", stage: "lead", sourceStage: "Новый лид", amount: 180_000, quiet: 2 },
  { name: "Sample Dental Astana", stage: "lead", sourceStage: "Дозвон", quiet: 9 },
  {
    name: "Example Medical Shymkent",
    contact: "Aigerim Example",
    stage: "qualified",
    sourceStage: "Квалификация",
    amount: 320_000,
    quiet: 4,
  },
  { name: "Placeholder Stom Karaganda", stage: "demo", sourceStage: "Демо период", amount: 250_000, quiet: 1 },
  { name: "Mock Health Aktobe", stage: "proposal", sourceStage: "Договор", amount: 410_000, quiet: 7 },
  { name: "Test Smile Pavlodar", stage: "won", sourceStage: "Сделка выиграна", amount: 290_000, closed: 12 },
  { name: "Sample Vision Atyrau", stage: "lost", sourceStage: "Сделка проиграна", amount: 150_000, closed: 25 },
  { name: "Example Lab Kostanay", stage: "unmapped", sourceStage: "На паузе", amount: 200_000, quiet: 15 },
];

/** Deals for both boards. A native row's `externalId` is its own id: the seed sets it after the insert. */
export function seedDeals(now: number): (Row<"deals"> & { native: boolean })[] {
  const us = pipelineRows(US_DEALS).map(({ card, order }) => ({
    source: "manual",
    externalId: "",
    market: "us" as const,
    native: true,
    ...cardFields(now, card, order),
    ...card.details,
    ...(card.archived === undefined ? null : { archivedAt: now - card.archived * DAY_MS }),
  }));
  const kz = pipelineRows(KZ_DEALS).map(({ card, order }, index) => ({
    source: "kz_crm",
    externalId: `seed-deal-${index + 1}`,
    market: "kz" as const,
    native: false,
    ...cardFields(now, card, order),
  }));
  return [...us, ...kz];
}

/**
 * Made-up sales intelligence for a few US deals on the board (convex/dealIntel.ts),
 * by the deal's name: one researched in full, two in part, and one with a
 * summary alone, so the deal page and the table's columns are not empty
 * locally. The only link a source may hold is a claude.ai artifact's, so the
 * seed's are that address with an id that reads as made up ("made-up-…").
 */
export const SEED_DEAL_INTEL: { deal: string; intel: Omit<StoredIntel, "updatedAt"> }[] = [
  {
    deal: "Sample Bone and Joint (example)",
    intel: {
      summary:
        "Made-up research: a physician-owned specialty group of 59 physicians across 29 sites, on a sample EHR, with prior authorizations as its heaviest back-office load.\n\nIts billing went to an outside vendor two years ago, and denials on imaging have grown since.",
      ownership: "Physician-owned (made-up)",
      ehr: "Sample EHR",
      pm: "Sample PM",
      billingModel: "outsourced",
      rcmVendor: "Placeholder RCM Partners",
      specialties: ["Spine", "Sports medicine", "Joint replacement", "Hand"],
      ancillaries: ["MRI", "Physical therapy", "Ambulatory procedure"],
      workersComp: "Made-up: about a fifth of visits are workers' comp, mostly spine.",
      competitors: [
        { name: "Placeholder RCM Partners", note: "The incumbent billing vendor; contract said to end next year." },
        { name: "Mock Prior Auth Tool", note: "Trialled last spring for imaging, dropped." },
      ],
      signals: [
        { date: "2026-09-02", kind: "hiring", text: "Made-up: hiring a revenue cycle director.", source: "Sample job board" },
        { date: "2026-07", kind: "growth", text: "Made-up: opened a second ambulatory procedure site.", source: "Sample local paper" },
        { date: "2026-05-14", kind: "technology", text: "Made-up: moved imaging scheduling to a sample portal.", source: "Sample press note" },
        { date: "2026-02", kind: "leadership", text: "Made-up: a new practice administrator started.", source: "Sample profile page" },
        { kind: "meeting", text: "Made-up: met their billing lead at a sample conference.", source: "Our own notes" },
      ],
      people: [
        { name: "Dr. Robin Sample", role: "Managing partner", note: "Made-up: signs off on vendors." },
        { name: "Pat Example", role: "Practice administrator", note: "Made-up: new this year." },
        { name: "Jo Placeholder", role: "Billing lead" },
      ],
      painPoints: [
        "Prior authorizations for MRI take days.",
        "Imaging denials have grown since billing went outside.",
        "Workers' comp claims are tracked by hand.",
      ],
      talkingPoints: [
        "Prior authorization status in one place, for imaging first.",
        "Denials read back by reason, the week they arrive.",
      ],
      risks: ["Bound to the incumbent vendor until its contract ends.", "A new administrator may reset priorities."],
      angle: "Made-up: lead with imaging prior authorizations, the work the new administrator is said to want off the front desk.",
      nextBestAction: "Ask for twenty minutes with the billing lead and the administrator",
      fit: {
        score: 84,
        reasons: ["Large group, many sites", "Prior authorization heavy", "Billing outsourced and unhappy"],
      },
      sources: [
        { title: "Made-up specialty market scan", url: "https://claude.ai/artifact/made-up-0001" },
        { title: "Sample payer mix note", url: "https://claude.ai/artifact/made-up-0002" },
      ],
      researchedAt: "2026-10-01",
    },
  },
  {
    deal: "Example Specialty Group",
    intel: {
      summary: "Made-up research: a 21-physician group in seven sites with its own billing office.",
      ownership: "Private equity backed (made-up)",
      ehr: "Placeholder EHR",
      billingModel: "in-house",
      specialties: ["Spine", "Pain management"],
      competitors: [{ name: "Mock Billing Suite" }],
      signals: [
        { date: "2026-08", kind: "acquisition", text: "Made-up: bought a two-site pain practice.", source: "Sample press note" },
      ],
      people: [{ name: "Dr. Casey Placeholder", role: "Chief medical officer" }],
      painPoints: ["Folding the bought practice into one billing office."],
      angle: "Made-up: help the in-house team absorb the acquisition without new hires.",
      nextBestAction: "Send the pilot outline with the acquisition in mind",
      fit: { score: 68, reasons: ["Growing by acquisition"] },
      sources: [{ title: "Made-up acquisition note", url: "https://claude.ai/artifact/made-up-0003" }],
      researchedAt: "2026-09-20",
    },
  },
  {
    deal: "Placeholder Spine Center",
    intel: {
      ehr: "Sample EHR",
      billingModel: "hybrid",
      fit: { score: 41, reasons: ["Small, one site"] },
      risks: ["Too small for a pilot to pay back."],
      researchedAt: "2026-09-12",
    },
  },
  {
    deal: "Maple Street Clinic",
    intel: { summary: "Made-up research: a two-site clinic; nothing else found yet." },
  },
];

// Cheque under discussion, in dollars.
const INVESTORS: Card[] = [
  { name: "Example Ventures", contact: "Alex Example", stage: "target", amount: 500_000, quiet: 3 },
  { name: "Placeholder Capital", stage: "target", quiet: 20 },
  { name: "Sample Seed Fund", contact: "Robin Sample", stage: "contacted", amount: 250_000, quiet: 5 },
  {
    name: "Fictional Angels",
    stage: "meeting",
    amount: 100_000,
    quiet: 2,
    nextStep: "Second call next week",
  },
  { name: "Mock Growth Partners", contact: "Jamie Mock", stage: "diligence", amount: 1_000_000, quiet: 4 },
  { name: "Demo Family Office", stage: "committed", amount: 300_000, closed: 30 },
  { name: "Test Street Capital", stage: "passed", closed: 45, notes: "Too early for them. Made up." },
];

export function seedInvestors(now: number): (Row<"investors"> & { native: boolean })[] {
  return pipelineRows(INVESTORS).map(({ card, order }) => ({
    source: "manual",
    externalId: "",
    native: true,
    ...cardFields(now, card, order),
  }));
}

// ── Customers ───────────────────────────────────────────────────────────────

type Clinic = {
  name: string;
  market: CompanyId;
  status?: Row<"customers">["status"];
  fee?: number;
  /** Days before the register's push. Absent: not on record. */
  paid?: number;
  /** Months of fees owed. */
  owed?: number;
  used?: number;
  nextTouch?: number;
  note?: string;
  archived?: boolean;
  /**
   * Days before now the contract was signed: unit economics counts the ones
   * in the last three complete months as new. Null: no contract date on
   * record. Absent: long ago, spread out by the clinic's place in the list.
   */
  contracted?: number | null;
};

// A spread of health: paid and in use; late; owing; quiet; nothing on record;
// paused; churned; archived. A few signed in the last three complete months
// (35 to 80 days ago, which is always among them), and one with no date.
const CLINICS: Clinic[] = [
  { name: "Maple Street Clinic", market: "us", fee: 900, paid: 8, owed: 0, used: 1 },
  { name: "Example Specialty Group", market: "us", fee: 2_400, paid: 20, owed: 0, used: 3, contracted: 50 },
  { name: "Sample Street Procedure Center", market: "us", fee: 2_900, paid: 52, owed: 1.5, used: 6, nextTouch: 3, note: "Invoice resent. A made-up note." },
  { name: "Example Eye Care", market: "us", fee: 1_200, paid: 85, owed: 2.5, used: 34 },
  { name: "Harbor View Dental (example)", market: "us", fee: 700, paid: 12, owed: 0, used: 19 },
  { name: "Placeholder Pediatrics", market: "us", fee: 600, contracted: null },
  { name: "Mockingbird Lane Clinic", market: "us", status: "paused", fee: 1_800, paid: 70 },
  { name: "Fictional Physio Group", market: "us", status: "churned", fee: 1_000, paid: 140 },
  { name: "Demo Clinic Almaty", market: "kz", fee: 180_000, paid: 5, owed: 0, used: 2, contracted: 35 },
  { name: "Sample Dental Astana", market: "kz", fee: 240_000, paid: 15, owed: 0, used: 1, contracted: 60 },
  { name: "Example Medical Shymkent", market: "kz", fee: 320_000, paid: 48, owed: 1.2, used: 16 },
  { name: "Test Smile Pavlodar", market: "kz", fee: 290_000, paid: 9, used: 45, nextTouch: -2, contracted: 80 },
  { name: "Example Eye Centre City A", market: "kz", fee: 400_000, paid: 6, owed: 0, used: 1 },
  { name: "Example Eye Centre City B", market: "kz", fee: 300_000, paid: 9, owed: 0, used: 1 },
  { name: "Sample Oncology Centre", market: "kz", fee: 300_000, paid: 12, owed: 0, used: 1 },
  { name: "Sample District Hospital", market: "kz", fee: 200_000, paid: 20, owed: 0, used: 2 },
  { name: "Example City Polyclinic", market: "kz", fee: 250_000, paid: 7, owed: 0, used: 1 },
  { name: "Placeholder Med Group", market: "kz", fee: 300_000, paid: 14, owed: 0, used: 1 },
  { name: "Mock Chest Clinic City C", market: "kz", fee: 200_000, paid: 25, owed: 0, used: 1 },
  { name: "Placeholder Polyclinic City A", market: "kz", fee: 150_000, paid: 18, owed: 0, used: 2, contracted: 40 },
  { name: "Demo Medical Centre", market: "kz", fee: 150_000, paid: 33, owed: 0.5, used: 3 },
  { name: "Test Visits Clinic", market: "kz", fee: 100_000, paid: 40, owed: 1, used: 12 },
  { name: "Sample Regional Clinic City C", market: "kz", fee: 200_000, paid: 30, owed: 0, used: 9 },
  { name: "Example Clinic City B", market: "kz", fee: 100_000, paid: 2, owed: 0, used: 1, contracted: 10 },
  { name: "Mock Health Aktobe", market: "kz", status: "paused", fee: 410_000, paid: 90 },
  { name: "Placeholder Stom Karaganda", market: "kz", fee: 250_000, paid: 30, owed: 0, used: 4, archived: true },
];

/** The client register as it would stand two days after a push. */
export function seedCustomers(now: number): Row<"customers">[] {
  const pushed = now - 2 * DAY_MS;
  return CLINICS.map((clinic, index) => ({
    source: "client_register",
    nameKey: nameKeyOf(clinic.name),
    name: clinic.name,
    market: clinic.market,
    status: clinic.status ?? "active",
    currency: clinic.market === "us" ? "USD" : "KZT",
    ...(clinic.fee === undefined ? null : { monthlyFee: clinic.fee }),
    ...(clinic.paid === undefined ? null : { lastPaymentDate: daysAgo(pushed, clinic.paid) }),
    ...(clinic.owed === undefined || clinic.fee === undefined
      ? null
      : { amountOwed: Math.round(clinic.owed * clinic.fee) }),
    ...(clinic.used === undefined ? null : { lastUsageDate: daysAgo(pushed, clinic.used) }),
    ...(clinic.contracted === null ? null : { contractDate: daysAgo(now, clinic.contracted ?? 200 + index * 37) }),
    ...(clinic.market === "us" && index % 3 !== 2 ? { baaDate: daysAgo(now, 195 + index * 37) } : null),
    ...(clinic.nextTouch === undefined ? null : { nextTouch: daysAgo(now, -clinic.nextTouch) }),
    ...(clinic.note ? { note: clinic.note } : null),
    syncedAt: pushed,
    ...(clinic.archived ? { archivedAt: pushed } : null),
  }));
}

// ── Clinics' use of Globex's app ────────────────────────────────────────

// Each Kazakhstan clinic's usual week and how its last weeks went, so the
// Customers page has a steady clinic, a growing one, one fading and one gone
// quiet. A clinic not listed (paused, archived, a US one) has no usage.
type UsageShape = {
  /** Its usual week's actions. */
  actions: number;
  /** Growth per week, as a fraction (older weeks are smaller by it). */
  trend: number;
  /** Last week against its usual, as a factor: 0.4 is a fall, 1.6 a jump. */
  last?: number;
  /** Weeks with nothing at the end. */
  quietWeeks?: number;
  /** Weeks with nothing at the start: a clinic new to the app. */
  newWeeks?: number;
  /** Its doctors in the app, and whether it pays or is on a trial. */
  doctorsTotal: number;
  plan: "paid" | "trial";
  mix: Partial<Record<KzModuleId, number>>;
};
// Shapes that fill each group of Product › Kazakhstan › Clinics: gone quiet,
// below its usual week, as usual, above it, and new. Every name, count and
// mix is invented and round.
const USAGE_SHAPES: Record<string, UsageShape> = {
  "Demo Clinic Almaty": { actions: 140, trend: 0, doctorsTotal: 10, plan: "paid", mix: { intake: 0.5, records: 0.3, search: 0.2 } },
  "Sample Dental Astana": { actions: 70, trend: 0.05, doctorsTotal: 5, plan: "paid", mix: { visits: 0.6, search: 0.3, journal: 0.1 } },
  "Example Medical Shymkent": { actions: 200, trend: -0.05, quietWeeks: 2, doctorsTotal: 5, plan: "paid", mix: { intake: 0.4, records: 0.3, inquiries: 0.2, forms: 0.1 } },
  "Test Smile Pavlodar": { actions: 50, trend: 0, quietWeeks: 6, doctorsTotal: 2, plan: "paid", mix: { visits: 0.7, capture: 0.3 } },
  "Example Eye Centre City A": { actions: 400, trend: 0, last: 1.1, doctorsTotal: 20, plan: "paid", mix: { forms: 0.8, capture: 0.1, search: 0.1 } },
  "Example Eye Centre City B": { actions: 100, trend: 0, last: 1.5, doctorsTotal: 10, plan: "paid", mix: { forms: 0.7, capture: 0.2, search: 0.1 } },
  "Sample Oncology Centre": { actions: 100, trend: 0, last: 1.5, doctorsTotal: 2, plan: "paid", mix: { intake: 0.8, records: 0.2 } },
  "Sample District Hospital": { actions: 60, trend: 0.05, last: 1.3, doctorsTotal: 5, plan: "paid", mix: { records: 0.5, search: 0.4, intake: 0.1 } },
  "Example City Polyclinic": { actions: 100, trend: 0, last: 1, doctorsTotal: 5, plan: "paid", mix: { search: 0.5, visits: 0.2, inquiries: 0.2, lookup: 0.1 } },
  "Placeholder Med Group": { actions: 150, trend: 0, last: 1.1, doctorsTotal: 5, plan: "paid", mix: { intake: 0.9, search: 0.1 } },
  "Mock Chest Clinic City C": { actions: 120, trend: 0, last: 0.9, doctorsTotal: 2, plan: "paid", mix: { search: 0.6, intake: 0.2, records: 0.1, journal: 0.1 } },
  "Placeholder Polyclinic City A": { actions: 20, trend: 0, last: 1.1, doctorsTotal: 2, plan: "paid", mix: { visits: 0.6, records: 0.4 } },
  "Demo Medical Centre": { actions: 30, trend: 0, last: 0.5, doctorsTotal: 1, plan: "paid", mix: { search: 0.8, inquiries: 0.2 } },
  "Test Visits Clinic": { actions: 10, trend: 0, quietWeeks: 1, doctorsTotal: 2, plan: "paid", mix: { visits: 1 } },
  "Sample Regional Clinic City C": { actions: 20, trend: 0, quietWeeks: 1, doctorsTotal: 2, plan: "trial", mix: { records: 0.6, search: 0.4 } },
  "Example Clinic City B": { actions: 10, trend: 0, newWeeks: 12, doctorsTotal: 1, plan: "trial", mix: { inquiries: 0.5, visits: 0.3, search: 0.2 } },
};

/** Thirteen finished weeks per clinic that uses the app, by the clinic's row id. */
export function seedCustomerUsage<Id>(
  now: number,
  clinics: readonly { id: Id; name: string }[],
): {
  customerId: Id;
  weekStart: string;
  checks: number;
  actions: number;
  doctors: number;
  doctorsTotal: number;
  activeDays: number;
  lastActiveOn?: string;
  plan: "paid" | "trial";
  failures: number;
  modules: Record<string, number>;
  syncedAt: number;
}[] {
  const weeks = closedWeeks(now, 13);
  return clinics.flatMap(({ id, name }) => {
    const shape = USAGE_SHAPES[name];
    if (shape === undefined) return [];
    let lastActiveOn: string | undefined;
    return weeks.map((weekStart, index) => {
      const fromEnd = weeks.length - 1 - index;
      const quiet = fromEnd < (shape.quietWeeks ?? 0) || index < (shape.newWeeks ?? 0);
      const level =
        shape.actions *
        (1 + shape.trend) ** -fromEnd *
        (1 + 0.15 * swingNoise(name, index)) *
        (fromEnd === 0 ? (shape.last ?? 1) : 1);
      const actions = quiet ? 0 : Math.max(1, Math.round(level));
      const activeDays = actions === 0 ? 0 : Math.min(7, Math.max(1, Math.round(actions / 25) + (index % 2)));
      if (actions > 0) lastActiveOn = day(Date.parse(`${weekStart}T00:00:00Z`) + (activeDays - 1) * DAY_MS);
      return {
        customerId: id,
        weekStart,
        checks: Math.round(actions * 0.6),
        actions,
        doctors: actions === 0 ? 0 : Math.min(shape.doctorsTotal, Math.max(1, Math.round(actions / 14))),
        doctorsTotal: shape.doctorsTotal,
        activeDays,
        ...(lastActiveOn === undefined ? null : { lastActiveOn }),
        plan: shape.plan,
        failures: Math.round(actions * 0.04),
        modules: Object.fromEntries(
          Object.entries(shape.mix).map(([module, share]) => [module, Math.round(actions * (share ?? 0))]),
        ),
        syncedAt: now,
      };
    });
  });
}

// Each clinic's made-up doctors, worked out from the clinic's own weeks (the
// rows `seedCustomerUsage` made), so the Doctors tab, a module's users and a
// clinic's card agree with its figures. Names read as invented.
const FIRST_NAMES = [
  "Aigerim", "Dauren", "Madina", "Yerlan", "Saule", "Nurlan", "Asel", "Arman", "Gulnara", "Timur",
  "Zhanna", "Bolat", "Dana", "Kairat", "Laura", "Marat", "Aliya", "Ruslan", "Aizhan", "Daniyar",
];
const SURNAMES = ["Example", "Sample", "Placeholder", "Mock", "Demo", "Test"];
const EVENTS: Partial<Record<KzModuleId, string>> = {
  intake: "intake_check_completed",
  records: "records_check_completed",
  visits: "globexai_check_completed",
  search: "ask_question_answered",
  inquiries: "inquiry_generated",
  forms: "form_entry_created",
  capture: "capture_completed",
  journal: "journal_check_completed",
  lookup: "lookup_check_completed",
  orders: "orders_check_completed",
};
type UsageRow = ReturnType<typeof seedCustomerUsage<unknown>>[number];

export function seedCustomerDoctors<Id>(
  now: number,
  clinics: readonly { id: Id; name: string }[],
  usage: readonly { customerId: Id; weekStart: string; actions: number; lastActiveOn?: string }[],
) {
  let person = 0;
  return clinics.flatMap(({ id, name }) => {
    const shape = USAGE_SHAPES[name];
    const weeks = usage.filter((u) => u.customerId === id) as unknown as UsageRow[];
    if (shape === undefined || weeks.length < 6) return [];
    const [last, before] = [weeks.at(-1)!, weeks.at(-2)!];
    const norm = weeks.slice(-6, -2).reduce((sum, w) => sum + w.actions, 0) / 4;
    const mix = (Object.entries(shape.mix) as [KzModuleId, number][]).sort((x, y) => y[1] - x[1]);
    const n = shape.doctorsTotal;
    const total = (n * (n + 1)) / 2;
    return Array.from({ length: n }, (_, i) => {
      person += 1;
      const share = (n - i) / total;
      // A clinic new to the app has only new doctors; one that grew has one.
      const firstWeek = (shape.newWeeks ?? 0) > 0 || (shape.last !== undefined && shape.last >= 1.3 && i === n - 1 && n > 1);
      // Some doctors move against their clinic: one in six works half as much, one in six twice.
      const own = person % 6 === 1 ? 0.4 : person % 6 === 4 ? 2.4 : 1;
      const actions = Math.round(last.actions * share * own);
      const previous = firstWeek ? 0 : Math.round(before.actions * share);
      const usual = firstWeek ? 0 : Math.round(norm * share * 10) / 10;
      const days = actions === 0 ? 0 : Math.min(7, Math.ceil(actions / 8));
      const daysBefore = previous === 0 ? 0 : Math.min(7, Math.ceil(previous / 8));
      const main = mix[i % mix.length]![0];
      const split = (total: number) =>
        Object.fromEntries(
          mix.map(([module, part]) => [module, Math.round(total * (module === main ? 0.7 : (part * 0.3) / Math.max(0.01, 1 - (shape.mix[main] ?? 0))))]),
        );
      // Every third doctor of a trial clinic, and one in five elsewhere, came off a trial in the last six weeks.
      // Every doctor of a trial clinic but one in three, and half the rest,
      // came off a trial in the thirteen weeks the page shows.
      const lastActiveOn = actions > 0 ? last.lastActiveOn : previous > 0 ? before.lastActiveOn : undefined;
      // A doctor who did nothing last week is one whose trial ended without
      // paying: the day after their last action (left), or a while ago if
      // they never began. Others' trials end anywhere in the thirteen weeks.
      const idle = actions === 0;
      const hadTrial = idle || (shape.plan === "trial" ? i % 3 !== 2 : person % 2 === 0);
      const trialEndedOn = !hadTrial
        ? undefined
        : idle
          ? lastActiveOn !== undefined
            ? day(Date.parse(`${lastActiveOn}T00:00:00Z`) + DAY_MS)
            : daysAgo(now, 9 + (person % 20))
          : daysAgo(now, 3 + ((person * 11) % 86));
      const beforeEnd = !hadTrial ? 0 : idle && lastActiveOn === undefined ? 0 : Math.round(previous * 1.5 + (i % 4) + 1);
      // Actions since the trial ended count only if they came after it.
      const afterEnd = hadTrial && lastActiveOn !== undefined && trialEndedOn !== undefined && lastActiveOn > trialEndedOn ? actions : 0;
      const failed = person % 7 === 3;
      return {
        customerId: id,
        doctorId: `made-up-${nameKeyOf(name)}-${i}`,
        name: `${FIRST_NAMES[person % FIRST_NAMES.length]} ${SURNAMES[(person * 7) % SURNAMES.length]}`,
        weekStart: last.weekStart,
        week: doctorWeekOf({ actions, usual, days, firstWeek, lastWeek: previous }),
        ...(firstWeek ? null : { weekBefore: doctorWeekOf({ actions: previous, usual, days: daysBefore, firstWeek: false }) }),
        actions,
        ...(firstWeek ? null : { previous }),
        ...(firstWeek ? null : { usual }),
        activeDays: days,
        ...(lastActiveOn ? { lastActiveOn } : null),
        lastEvent: hadTrial && actions === 0 ? "trial_ended" : failed ? `${main === "visits" ? "globexai" : main === "search" ? "ask" : main}_check_failed` : (EVENTS[main] ?? "document_uploaded"),
        mainModule: main,
        plan: shape.plan,
        ...(trialEndedOn
          ? {
              trialEndedOn,
              trialOutcome: trialOutcomeOf({
                // Half the trials at a paying clinic paid; the rest kept on, left or never began.
                paid: !idle && shape.plan === "paid" && person % 4 === 0,
                lastActiveOn: lastActiveOn ?? null,
                endedOn: trialEndedOn,
                before: beforeEnd,
                after: afterEnd,
              }),
              actionsBeforeTrialEnd: beforeEnd,
              actionsAfterTrialEnd: afterEnd,
            }
          : null),
        modules: split(actions),
        modulesPrevious: split(previous),
        // Their thirteen weeks: their share of the clinic's, last week and the
        // week before as above, and nothing before a new doctor's first week.
        history: weeks.slice(-13).map((w, index, all) => {
          const fromEnd = all.length - 1 - index;
          const value = fromEnd === 0 ? actions : fromEnd === 1 ? previous : firstWeek ? 0 : Math.round(w.actions * share);
          return { weekStart: w.weekStart, actions: value, days: value === 0 ? 0 : Math.min(7, Math.ceil(value / 8)), modules: split(value) };
        }),
        syncedAt: now,
      };
    });
  });
}

// ── Globex's app in breakdowns (made up) ─────────────────────────────────

const SEED_PAGES = [
  ["/dashboard/forms/entries", 1_300, 50, 160],
  ["/dashboard/forms/entries/:id", 900, 35, 40],
  ["/dashboard/forms/entries/new", 300, 16, 110],
  ["/dashboard/intake", 60, 2, 12],
  ["/dashboard/records", 90, 4, 8],
  ["/dashboard/ask", 120, 6, 15],
  ["/extension", 80, 3, 14],
] as const;
// Events the app sends, a usual week's count and doctors; three go silent so
// tracking health has something to show (one stops two weeks ago, one five).
const SEED_EVENTS: [event: string, count: number, users: number, silentWeeks?: number][] = [
  ["intake_check_initiated", 400, 50],
  ["intake_check_completed", 380, 48],
  ["intake_check_failed", 30, 12],
  ["intake_check_cost", 380, 48],
  ["records_check_initiated", 160, 33],
  ["records_check_completed", 152, 32],
  ["records_check_cost", 150, 32],
  ["ask_search_submitted", 360, 50],
  ["ask_search_completed", 340, 50],
  ["ask_search_cost", 345, 50],
  ["globexai_check_initiated", 60, 24],
  ["globexai_check_completed", 60, 24],
  ["visits_enrichment_cost", 7, 6, 4],
  ["document_uploaded", 62, 24],
  ["document_upload_failed", 21, 12],
  ["inquiry_chat_submitted", 50, 20],
  ["inquiry_generated", 17, 15],
  ["inquiry_generation_failed", 9, 4],
  ["form_entry_created", 540, 27],
  ["capture_completed", 21, 7],
  ["trial_ended", 84, 12],
  ["subscription_started", 4, 4],
  ["survey sent", 5, 5, 5],
  ["journal_check_failed", 2, 1, 2],
];
const SEED_FIELDS: [field: string, emptyShare: number][] = [
  ["intake_check_completed · check_id", 1],
  ["records_check_completed · check_id", 1],
  ["intake_check_cost · subscription_type", 1],
  ["intake_check_failed · time_to_result_ms", 1],
  ["ask_search_submitted · conversation_id", 0.48],
  ["intake_check_completed · time_to_result_ms", 0.01],
];

/** Breakdowns of the last eight finished weeks: hours, pages, events and fields. */
export function seedBreakdowns(now: number) {
  const weeks = closedWeeks(now, 8);
  const rows: { kind: "hour" | "page" | "event" | "field"; weekStart: string; key: string; values: Record<string, number>; syncedAt: number }[] = [];
  weeks.forEach((weekStart, index) => {
    const fromEnd = weeks.length - 1 - index;
    // Working hours busy, nights quiet; a spike on the newest week's Wednesday
    // late morning. Four weeks of hours: enough for the heat map, and the seed stays quick.
    for (let day = 1; day <= (fromEnd < 4 ? 7 : 0); day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const working = day <= 5 && hour >= 9 && hour <= 18;
        const actions = Math.max(0, Math.round((working ? 30 : day <= 5 && hour >= 7 && hour <= 21 ? 8 : 1) * (1 + 0.3 * swingNoise(`h${day}-${hour}`, index))));
        const spike = fromEnd === 0 && day === 3 && (hour === 11 || hour === 12) ? 15 : 0;
        const failures = Math.max(0, Math.round(actions * 0.04 * (1 + swingNoise(`f${day}-${hour}`, index)))) + spike;
        rows.push({ kind: "hour", weekStart, key: `${day}-${hour}`, values: { failures, actions }, syncedAt: now });
      }
    }
    for (const [page, inp, poor, rage] of SEED_PAGES) {
      const lift = 1 + 0.15 * swingNoise(page, index);
      rows.push({ kind: "page", weekStart, key: page, values: { inp_p75: Math.round(inp * lift), inp_poor: poor, rage: Math.round(rage / 4 * lift) }, syncedAt: now });
    }
    for (const [event, count, users, silent] of SEED_EVENTS) {
      if (silent !== undefined && fromEnd < silent) continue;
      const lift = 1 + 0.12 * swingNoise(event, index);
      rows.push({ kind: "event", weekStart, key: event, values: { count: Math.round(count * lift), users: Math.max(1, Math.round(users * lift)) }, syncedAt: now });
    }
    for (const [field, share] of SEED_FIELDS) {
      const total = 300;
      rows.push({ kind: "field", weekStart, key: field, values: { total, missing: Math.round(total * share) }, syncedAt: now });
    }
  });
  return rows;
}

// ── Compliance ──────────────────────────────────────────────────────────────

/** Dates and evidence only: nothing here says the company meets anything. */
export function seedObligations(now: number): Row<"obligations">[] {
  const due = (days: number) => daysAgo(now, -days);
  const anchor = (date: string) => Number(date.slice(8, 10));
  const item = (
    category: Row<"obligations">["category"],
    title: string,
    extra: Partial<Row<"obligations">> = {},
  ): Row<"obligations"> => ({
    category,
    title,
    dueConfirmed: false,
    recurrence: "none",
    status: "open",
    ...extra,
    ...(extra.due ? { anchorDay: anchor(extra.due) } : null),
  });
  return [
    item("hipaa", "Example: yearly risk assessment", {
      due: due(21),
      dueConfirmed: true,
      recurrence: "annual",
      status: "in_progress",
    }),
    item("hipaa", "Example: staff training record", { due: due(-6), dueConfirmed: true }),
    item("hipaa", "Example: review the agreement template", { due: due(60) }),
    item("soc2", "Example: quarterly access review", {
      due: due(40),
      dueConfirmed: true,
      recurrence: "quarterly",
      lastDoneAt: now - 50 * DAY_MS,
      lastDoneFor: due(-50),
      lastEvidenceUrl: "https://example.com/evidence/access-review",
    }),
    item("soc2", "Example: vendor list check", {
      status: "done",
      evidenceUrl: "https://example.com/evidence/vendors",
      lastDoneAt: now - 12 * DAY_MS,
    }),
    item("kz_data", "Example: confirm where the data is hosted", { due: due(14), dueConfirmed: true }),
    item("kz_data", "Example: yearly notice", { recurrence: "annual", note: "Date not confirmed yet." }),
    item("corporate_tax", "Example: monthly filing", {
      due: due(9),
      dueConfirmed: true,
      recurrence: "monthly",
    }),
    item("corporate_tax", "Example: annual report", { due: due(120), recurrence: "annual" }),
    item("contracts", "Example: renew the hosting contract", { due: due(75), dueConfirmed: true }),
    item("contracts", "Example: old tool, no longer used", { status: "not_applicable" }),
  ];
}

// ── The operating routine ───────────────────────────────────────────────────

export function seedGoals(now: number): WithoutSystemFields<Doc<"goals">>[] {
  const quarter = quarterOf(now);
  const goals: [string, Doc<"goals">["status"]][] = [
    ["Example: ten new paying clinics", "on_track"],
    ["Example: ship the denial queue to every pilot", "at_risk"],
    ["Example: close the made-up seed round", "off_track"],
    [`Example: first three ${COMPANIES.kz.name} renewals`, "done"],
  ];
  // The seed round is a cash goal: its proposals are pinned in Cash and runway on /approvals.
  return goals.map(([title, status], order) => ({ quarter, title, status, order, ...(order === 2 ? { cash: true } : null) }));
}

export type SeedTask = {
  title: string;
  column: Doc<"tasks">["column"];
  kind?: Doc<"tasks">["kind"];
  notes?: string;
  company?: CompanyId;
  /** Who it is given to, among SEED_PEOPLE. */
  assignee?: Pick<SeedPerson, "role" | "companies">;
  /** Days from today. */
  due?: number;
  /** Index into `seedGoals`. */
  goal?: number;
  /** Days since it was finished. */
  done?: number;
  from?: "standup" | "suggestion";
  /** Who suggested it. */
  by?: Pick<SeedPerson, "role" | "companies">;
  /** Who its notes mention, as `@Name`. */
  mentions?: readonly Pick<SeedPerson, "role" | "companies">[];
};

const ADA = { role: "cofounder", companies: "both" } as const;
const SAM = { role: "sales", companies: "both" } as const;
const MAX = { role: "engineer", companies: "both" } as const;
const TIMUR = { role: "engineer", companies: "kz" } as const;
const DANA = { role: "cofounder", companies: "kz" } as const;
const RILEY = { role: "sales", companies: "us" } as const;
const OWNER_PERSON = { role: "owner", companies: "both" } as const;

/** The day and id of the made-up standup two of the cards came from. */
export const seedStandup = (now: number) => ({
  meetingDate: daysAgo(now, 1),
  meetingId: "seed-standup-1",
});

/** The second company's seeded task, named again by the notifications about it. */
const KZ_RENEWALS_TASK = `Example: renewals checklist for ${COMPANIES.kz.name}`;

export const SEED_TASKS: readonly SeedTask[] = [
  { title: "Example: write the pilot outline", column: "backlog", company: "us", assignee: SAM, due: 5, goal: 0 },
  { title: "Example: fix the slow search page", column: "backlog", kind: "issue", company: "us", assignee: MAX },
  { title: "Example: translate the onboarding guide", column: "backlog", company: "kz", assignee: TIMUR },
  { title: "Example: tidy the shared drive", column: "backlog" },
  {
    title: "Example: follow up with the Shymkent demo",
    column: "backlog",
    company: "kz",
    from: "standup",
    notes: "From the standup. A made-up action item.",
  },
  {
    title: "Example: check the export button on Customers",
    column: "backlog",
    kind: "issue",
    assignee: MAX,
    from: "standup",
  },
  {
    title: "The Finance page should say which month is still open",
    column: "backlog",
    from: "suggestion",
    by: SAM,
    notes: "It took me a while to see why October looked low.\n\nPage: /finance",
  },
  { title: "Example: prepare the investor update", column: "this_week", company: "us", assignee: OWNER_PERSON, due: 2, goal: 2 },
  { title: "Example: call three quiet clinics", column: "this_week", assignee: SAM, due: -1 },
  {
    title: KZ_RENEWALS_TASK,
    column: "this_week",
    company: "kz",
    assignee: ADA,
    goal: 3,
    notes: "@Sam Placeholder has the made-up list of contacts.",
    mentions: [SAM],
  },
  { title: "Example: denial queue for pilot two", column: "doing", company: "us", assignee: MAX, due: 4, goal: 1 },
  { title: "Example: sign-in fails on an old phone", column: "doing", kind: "issue", assignee: TIMUR },
  {
    title: "Example: weekly review notes",
    column: "doing",
    assignee: ADA,
    notes: "@Owner Example can you check the wins list before Friday?",
    mentions: [OWNER_PERSON],
  },
  { title: "Example: send the pilot contract", column: "done", company: "us", assignee: SAM, done: 1 },
  { title: "Example: fix the chart colours", column: "done", kind: "issue", assignee: MAX, done: 3 },
  { title: "Example: set up the shared calendar", column: "done", done: 6 },
];

/**
 * What the made-up people have been told about the board, so the bell has
 * something in it for each of them: every kind once, some read, some not.
 * `task` is a title in SEED_TASKS.
 */
export type SeedNotification = {
  to: Pick<SeedPerson, "role" | "companies">;
  kind: Doc<"notifications">["kind"];
  by: Pick<SeedPerson, "role" | "companies"> | "standup";
  task: string;
  hoursAgo: number;
  read?: boolean;
  column?: Doc<"tasks">["column"];
  /** For "reassigned": who has it now. */
  now?: Pick<SeedPerson, "role" | "companies">;
  /** For "due": days from today; null for a date that was cleared. */
  due?: number | null;
};

export const SEED_NOTIFICATIONS: readonly SeedNotification[] = [
  // The owner.
  { to: OWNER_PERSON, kind: "mentioned", by: ADA, task: "Example: weekly review notes", hoursAgo: 0.4 },
  { to: OWNER_PERSON, kind: "finished", by: SAM, task: "Example: send the pilot contract", hoursAgo: 26 },
  { to: OWNER_PERSON, kind: "moved", by: ADA, task: "Example: prepare the investor update", hoursAgo: 50, column: "this_week", read: true },
  { to: OWNER_PERSON, kind: "due", by: ADA, task: "Example: prepare the investor update", hoursAgo: 51, due: 2, read: true },
  // Sam, on both companies.
  { to: SAM, kind: "assigned", by: OWNER_PERSON, task: "Example: write the pilot outline", hoursAgo: 2 },
  { to: SAM, kind: "mentioned", by: ADA, task: KZ_RENEWALS_TASK, hoursAgo: 3 },
  { to: SAM, kind: "due", by: OWNER_PERSON, task: "Example: call three quiet clinics", hoursAgo: 20, due: -1 },
  { to: SAM, kind: "assigned", by: OWNER_PERSON, task: "Example: call three quiet clinics", hoursAgo: 72, read: true },
  // Ada.
  { to: ADA, kind: "assigned", by: OWNER_PERSON, task: KZ_RENEWALS_TASK, hoursAgo: 5 },
  { to: ADA, kind: "moved", by: OWNER_PERSON, task: "Example: weekly review notes", hoursAgo: 30, column: "doing", read: true },
  // Max: one from the standup, which no person sent.
  { to: MAX, kind: "assigned", by: "standup", task: "Example: check the export button on Customers", hoursAgo: 22 },
  { to: MAX, kind: "due", by: OWNER_PERSON, task: "Example: denial queue for pilot two", hoursAgo: 28, due: 4 },
  { to: MAX, kind: "moved", by: SAM, task: "Example: fix the chart colours", hoursAgo: 70, column: "done", read: true },
  // The people on one company.
  { to: TIMUR, kind: "assigned", by: OWNER_PERSON, task: "Example: translate the onboarding guide", hoursAgo: 6 },
  { to: TIMUR, kind: "moved", by: DANA, task: "Example: sign-in fails on an old phone", hoursAgo: 27, column: "doing" },
  { to: DANA, kind: "unassigned", by: OWNER_PERSON, task: "Example: follow up with the Shymkent demo", hoursAgo: 25 },
  { to: RILEY, kind: "reassigned", by: OWNER_PERSON, task: "Example: fix the slow search page", hoursAgo: 48, now: MAX },
];

/**
 * What the made-up owner's Claude is said to have called, for the Assistant
 * page's "Recent calls". A row is all there is of a call: a tool's name, its
 * kind, when and how it ended. No token is seeded: one is made on the page.
 */
export const SEED_AGENT_CALLS: readonly {
  tool: string;
  kind: "read" | "act";
  minutesAgo: number;
  outcome: "ok" | "refused" | "invalid" | "error";
  durationMs: number;
}[] = [
  { tool: "overview", kind: "read", minutesAgo: 42, outcome: "ok", durationMs: 310 },
  { tool: "tasks", kind: "read", minutesAgo: 41, outcome: "ok", durationMs: 120 },
  { tool: "task_create", kind: "act", minutesAgo: 40, outcome: "ok", durationMs: 95 },
  { tool: "deals", kind: "read", minutesAgo: 39, outcome: "ok", durationMs: 140 },
  { tool: "deal_update", kind: "act", minutesAgo: 38, outcome: "refused", durationMs: 60 },
  { tool: "metrics", kind: "read", minutesAgo: 37, outcome: "invalid", durationMs: 8 },
];

/**
 * Made-up days of the suggested bots' calls (`botCallDays`, Bot Loop v3 J):
 * the Bots tab's last seven days once the tab has added the suggested bots.
 * Growth is busy and reports its cost, Research was last seen ten days ago
 * (idle), and the rest have none. Counts only.
 */
export const SEED_BOT_CALL_DAYS: readonly {
  bot: string;
  daysAgo: number;
  calls: number;
  errors: number;
  invalid: number;
  refused: number;
  typicalMs: number;
  costUsd: number | null;
}[] = [
  { bot: "growth", daysAgo: 0, calls: 42, errors: 1, invalid: 2, refused: 3, typicalMs: 180, costUsd: 0.84 },
  { bot: "growth", daysAgo: 1, calls: 57, errors: 0, invalid: 1, refused: 0, typicalMs: 210, costUsd: 1.1 },
  { bot: "growth", daysAgo: 3, calls: 30, errors: 0, invalid: 0, refused: 1, typicalMs: 160, costUsd: null },
  { bot: "globex_ai_sales", daysAgo: 2, calls: 12, errors: 0, invalid: 0, refused: 2, typicalMs: 420, costUsd: null },
  { bot: "research", daysAgo: 10, calls: 8, errors: 0, invalid: 0, refused: 0, typicalMs: 900, costUsd: null },
];

/**
 * A made-up brief a company, as the agents would write one: every figure and
 * finding is invented, and one line shows a figure that was never read.
 */
export const SEED_BRIEFS: Record<
  "us" | "kz",
  readonly { text: string; page?: string; agent: "chief_of_staff" | "engineering" | "sales" | "finance" }[]
> = {
  us: [
    { agent: "engineering", text: "Made-up: two pull requests have waited more than three days for a review.", page: "/engineering" },
    { agent: "sales", text: "Made-up: three deals have had no activity for two weeks, and two of them have no next step.", page: "/sales" },
    { agent: "finance", text: "Made-up: cash for this month is not read yet, so runway is not restated.", page: "/finance" },
    { agent: "finance", text: "Made-up: one obligation with a confirmed date comes due within two weeks.", page: "/compliance" },
    { agent: "chief_of_staff", text: "Made-up: four proposals are waiting for you below." },
  ],
  kz: [
    { agent: "sales", text: "Made-up: the Kazakhstan CRM shows two deals quiet for three weeks.", page: "/sales" },
    { agent: "finance", text: "Made-up: two sample clinics owe for more than a month.", page: "/customers" },
    { agent: "engineering", text: "Made-up: the main branch of one sample repository is failing.", page: "/engineering" },
  ],
};

/**
 * A made-up conversation for the Assistant page's chat: one question, a
 * finished answer with the steps it took, and one proposal made in it. No
 * runner is seeded: the page says the Mac has never checked in.
 */
export const SEED_CHAT = {
  question: "Made-up question: what should I chase on the sample pipeline this week?",
  answer:
    "Made-up answer: two sample deals have had no activity for two weeks, and one of them has no next step. The amount of the second is not read yet. They are on /sales.\n\nI have put a card below for you to approve: a task to chase the first.",
  steps: ["overview", "deals", "tasks", "propose"],
  proposal: {
    reason: "Made-up reason: you asked for a task to chase the quietest sample deal.",
    dedupeKey: "chief_of_staff:task_create:chase-sample-deal",
    title: "Made-up task: chase the quietest sample deal",
  },
} as const;

export const SEED_TARGETS: readonly { key: string; scope: string; target: number }[] = [
  { key: "mrr", scope: "us", target: 50_000 },
  { key: "paying_clinics", scope: "kz", target: 30 },
  { key: "searches", scope: "startup_insights", target: 6_000 },
  { key: "weekly_active_users", scope: "startup_insights", target: 700 },
];

/**
 * A made-up plan: three scenarios, five years, every figure the page lists.
 * It starts last year, so Finance can draw this year's line from last
 * year-end's ARR to this one's.
 */
export function seedPlan(now: number): WithoutSystemFields<Doc<"planFigures">>[] {
  const first = new Date(now).getUTCFullYear() - 1;
  const pace: Record<PlanScenario, number> = { bear: 1.3, base: 1.6, bull: 2.1 };
  const start: Record<PlanKey, number> = {
    arr: 420_000,
    revenue: 480_000,
    net_burn: 1_300_000,
    cash_end: 1_500_000,
    headcount: 9,
    paying_customers: 64,
    capital_raised: 0,
  };
  const rows: WithoutSystemFields<Doc<"planFigures">>[] = [];
  for (const scenario of PLAN_SCENARIOS) {
    for (let index = 0; index < 5; index += 1) {
      const growth = pace[scenario] ** index;
      const value: Record<PlanKey, number> = {
        arr: start.arr * growth,
        revenue: start.revenue * growth,
        // Burn shrinks as revenue grows, and turns negative when the plan pays for itself.
        net_burn: start.net_burn - start.revenue * (growth - 1) * 0.6,
        cash_end: start.cash_end + (index === 1 ? 4_000_000 : 0) - index * 400_000,
        headcount: start.headcount + index * (scenario === "bull" ? 7 : 4),
        paying_customers: start.paying_customers * growth,
        capital_raised: index === 1 ? 4_000_000 : 0,
      };
      for (const key of PLAN_KEYS) {
        rows.push({
          scenario,
          year: first + index,
          key,
          value: Math.round(value[key]),
          modelVersion: "5eed5eed",
          syncedAt: now - DAY_MS,
        });
      }
    }
  }
  return rows;
}

// ── Payroll ─────────────────────────────────────────────────────────────────

// Amounts in minor units (cents, tiyn); rates in basis points. The lines are
// invented and named so: no rate, allowance or cap of any law is written here.
export type SeedPayLine = {
  key: string;
  company: CompanyId;
  appliesTo: "employee" | "contractor";
  name: string;
  paidBy: "employee" | "company";
  rateBp: number;
  /** Keys of the lines whose amounts come off this one's base. */
  less?: string[];
};

export const SEED_PAY_LINES: readonly SeedPayLine[] = [
  { key: "us-a", company: "us", appliesTo: "employee", name: "Made-up withholding A", paidBy: "employee", rateBp: 1_200 },
  { key: "us-b", company: "us", appliesTo: "employee", name: "Made-up employer levy B", paidBy: "company", rateBp: 650 },
  { key: "kz-a", company: "kz", appliesTo: "employee", name: "Made-up fund share A", paidBy: "employee", rateBp: 1_000 },
  { key: "kz-b", company: "kz", appliesTo: "employee", name: "Made-up withholding B", paidBy: "employee", rateBp: 1_000, less: ["kz-a"] },
  { key: "kz-c", company: "kz", appliesTo: "employee", name: "Made-up employer levy C", paidBy: "company", rateBp: 500 },
  { key: "kz-d", company: "kz", appliesTo: "contractor", name: "Made-up contractor levy D", paidBy: "company", rateBp: 300 },
];

export type SeedPayPerson = {
  company: CompanyId;
  name: string;
  title: string;
  kind: "employee" | "contractor";
  currency: "USD" | "KZT";
  gross?: number;
  net?: number;
  /** Whole percents of their time serving customers and on sales and marketing (unit economics). */
  cogsPercent?: number;
  salesPercent?: number;
};

export const SEED_PAY_PEOPLE: readonly SeedPayPerson[] = [
  { company: "us", name: "Ada Example", title: "Co-founder", kind: "employee", currency: "USD", gross: 9_000_00 },
  { company: "us", name: "Max Fixture", title: "Engineer", kind: "employee", currency: "USD", gross: 8_000_00, cogsPercent: 20 },
  { company: "us", name: "Riley Mockwell", title: "Sales", kind: "employee", currency: "USD", net: 5_500_00, salesPercent: 90 },
  { company: "us", name: "Jo Sample", title: "Designer", kind: "contractor", currency: "USD", gross: 3_000_00 },
  { company: "kz", name: "Dana Sample", title: "Co-founder", kind: "employee", currency: "KZT", gross: 900_000_00, salesPercent: 40 },
  { company: "kz", name: "Timur Testov", title: "Engineer", kind: "employee", currency: "KZT", gross: 750_000_00 },
  { company: "kz", name: "Aigerim Example", title: "Support", kind: "employee", currency: "KZT", net: 500_000_00, cogsPercent: 80 },
  { company: "kz", name: "Contractor Placeholder", title: "Accountant", kind: "contractor", currency: "KZT", gross: 300_000_00 },
];

/** The month the seed prepares for each company: the one in progress, which the page opens on. */
export const seedPayMonth = (now: number) => periodStart("month", now);

// ── Costs: what each company pays for besides pay ───────────────────────────

export type SeedCost = {
  company: CompanyId;
  name: string;
  category: CostCategory;
  /** Minor units, per cadence. */
  amount: number;
  cadence: CostCadence;
  /** Months from the month in progress: 0 is this month, -6 half a year ago, 1 next month. */
  startsIn: number;
  endsIn?: number;
  variable?: boolean;
  /** What it counts as in unit economics, where chosen by hand; else its category's default. */
  bucket?: CostBucket;
  paidBy?: string;
  note?: string;
};

const US_CARD = "Example company card";
const KZ_BANK = "Sample bank transfer";

export const SEED_COSTS: readonly SeedCost[] = [
  { company: "us", name: "Example Cloud hosting", category: "cloud", amount: 1_840_00, cadence: "monthly", startsIn: -14, variable: true, paidBy: US_CARD, note: "Made-up estimate: usage moves with traffic." },
  { company: "us", name: "Sample Database", category: "cloud", amount: 420_00, cadence: "monthly", startsIn: -9, variable: true, paidBy: US_CARD },
  { company: "us", name: "Example Code hosting", category: "software", amount: 84_00, cadence: "monthly", startsIn: -20, paidBy: US_CARD },
  { company: "us", name: "Sample Team chat", category: "software", amount: 105_00, cadence: "monthly", startsIn: -20, paidBy: US_CARD },
  { company: "us", name: "Example Design tool", category: "software", amount: 540_00, cadence: "yearly", startsIn: -4, paidBy: US_CARD, note: "Made-up: billed once a year." },
  { company: "us", name: "Sample AI subscription", category: "software", amount: 600_00, cadence: "monthly", startsIn: -6, bucket: "cogs", paidBy: US_CARD, note: "Made-up: the model behind the product, so it serves customers." },
  { company: "us", name: "Example Coworking desks", category: "office", amount: 1_200_00, cadence: "monthly", startsIn: -11, paidBy: "Sample bank transfer" },
  { company: "us", name: "Placeholder Accounting firm", category: "services", amount: 2_400_00, cadence: "quarterly", startsIn: -6, paidBy: "Sample bank transfer" },
  { company: "us", name: "Example Legal review", category: "services", amount: 3_500_00, cadence: "once", startsIn: 1, note: "Made-up one-off, next month." },
  { company: "us", name: "Sample Ads", category: "marketing", amount: 900_00, cadence: "monthly", startsIn: -3, paidBy: US_CARD },
  { company: "us", name: "Example State filing fee", category: "taxes_fees", amount: 300_00, cadence: "yearly", startsIn: -7 },
  { company: "us", name: "Sample Conference travel", category: "travel", amount: 650_00, cadence: "monthly", startsIn: -5, endsIn: -2, note: "Made-up: ended." },

  { company: "kz", name: "Example Cloud hosting", category: "cloud", amount: 380_000_00, cadence: "monthly", startsIn: -14, variable: true, paidBy: KZ_BANK, note: "Made-up estimate: usage moves with traffic." },
  { company: "kz", name: "Sample SMS gateway", category: "cloud", amount: 95_000_00, cadence: "monthly", startsIn: -8, variable: true, paidBy: KZ_BANK },
  { company: "kz", name: "Example Office rent", category: "office", amount: 650_000_00, cadence: "monthly", startsIn: -18, paidBy: KZ_BANK },
  { company: "kz", name: "Sample Internet", category: "office", amount: 28_000_00, cadence: "monthly", startsIn: -18, paidBy: KZ_BANK },
  { company: "kz", name: "Example CRM", category: "software", amount: 74_000_00, cadence: "monthly", startsIn: -10, bucket: "sales_marketing", paidBy: "Example company card", note: "Made-up: the sales team's tool." },
  { company: "kz", name: "Sample Accounting software", category: "software", amount: 180_000_00, cadence: "yearly", startsIn: -3, paidBy: KZ_BANK, note: "Made-up: billed once a year." },
  { company: "kz", name: "Placeholder Bookkeeper", category: "services", amount: 450_000_00, cadence: "quarterly", startsIn: -6, paidBy: KZ_BANK },
  { company: "kz", name: "Example Notary and legal", category: "services", amount: 320_000_00, cadence: "once", startsIn: 1, note: "Made-up one-off, next month." },
  { company: "kz", name: "Sample Clinic events", category: "marketing", amount: 210_000_00, cadence: "monthly", startsIn: -4, paidBy: KZ_BANK },
  // What an agency was paid, a one-off a month as it left the bank: one large month among small ones.
  { company: "kz", name: "Example Marketing agency", category: "marketing", amount: 250_000_00, cadence: "once", startsIn: -3, paidBy: KZ_BANK },
  { company: "kz", name: "Example Marketing agency", category: "marketing", amount: 2_100_000_00, cadence: "once", startsIn: -2, paidBy: KZ_BANK, note: "Made-up: a campaign month." },
  { company: "kz", name: "Example Marketing agency", category: "marketing", amount: 190_000_00, cadence: "once", startsIn: -1, paidBy: KZ_BANK },
  { company: "kz", name: "Example Bank fees", category: "taxes_fees", amount: 18_000_00, cadence: "monthly", startsIn: -18 },
  { company: "kz", name: "Sample Courier", category: "other", amount: 22_000_00, cadence: "monthly", startsIn: -6 },
  { company: "kz", name: "Example Regional travel", category: "travel", amount: 140_000_00, cadence: "monthly", startsIn: -7, endsIn: -1, note: "Made-up: ended." },
];

/** A month so many months from the one in progress, "YYYY-MM", as a cost line holds it. */
export const seedCostMonth = (now: number, monthsFromNow: number) =>
  addMonths(periodStart("month", now).slice(0, 7), monthsFromNow);

// ── Budget and runway (made up) ─────────────────────────────────────────────

/** A made-up monthly plan per category, in minor units, for each company. Payroll is a made-up round figure. */
const SEED_PLAN_PER_MONTH: Record<"us" | "kz", Partial<Record<CostCategory | "payroll", number>>> = {
  us: { cloud: 2_300_00, software: 900_00, office: 1_200_00, services: 800_00, marketing: 1_000_00, payroll: 24_000_00 },
  kz: { cloud: 480_000_00, software: 90_000_00, office: 680_000_00, services: 150_000_00, marketing: 200_000_00, taxes_fees: 18_000_00, payroll: 4_500_000_00 },
};

/** Budget cells from six months ago to eleven months ahead; each month a little more than the one before. */
export function seedBudgets(now: number) {
  const rows: { company: "us" | "kz"; month: string; category: CostCategory | "payroll"; amount: number }[] = [];
  for (const company of ["us", "kz"] as const) {
    for (let i = -6; i <= 11; i += 1) {
      for (const [category, base] of Object.entries(SEED_PLAN_PER_MONTH[company])) {
        rows.push({
          company,
          month: seedCostMonth(now, i),
          category: category as CostCategory | "payroll",
          amount: Math.round((base * (100 + Math.max(i, 0))) / 100),
        });
      }
    }
  }
  return rows;
}

/** Globex's typed-in actual spending for the six finished months: some over plan, some under. */
export function seedBudgetActuals(now: number) {
  const plan = Object.values(SEED_PLAN_PER_MONTH.kz).reduce((sum, value) => sum + value, 0);
  const swing = [104, 97, 112, 99, 93, 108];
  return swing.map((percent, i) => ({
    company: "kz" as const,
    month: seedCostMonth(now, i - 6),
    amount: Math.round((plan * percent) / 100),
  }));
}

/** Two made-up scenarios per company. Months are from the month in progress. */
export const SEED_SCENARIOS: readonly {
  company: "us" | "kz";
  name: string;
  changes: { kind: "hire" | "cost" | "revenue" | "cash_in" | "cash_out"; label: string; startsIn: number; endsIn?: number; amount: number }[];
}[] = [
  {
    company: "us",
    name: "Example: hire two engineers",
    changes: [
      { kind: "hire", label: "Sample engineer one", startsIn: 2, amount: 13_000_00 },
      { kind: "hire", label: "Sample engineer two", startsIn: 4, amount: 13_000_00 },
    ],
  },
  {
    company: "us",
    name: "Example: seed round and growth",
    changes: [
      { kind: "cash_in", label: "Made-up seed round", startsIn: 3, amount: 1_500_000_00 },
      { kind: "revenue", label: "Sample new clinics", startsIn: 2, amount: 4_000_00 },
      { kind: "cost", label: "Sample larger cloud bill", startsIn: 2, amount: 1_500_00 },
    ],
  },
  {
    company: "kz",
    name: "Example: a second sales hire",
    changes: [{ kind: "hire", label: "Sample sales manager", startsIn: 1, amount: 900_000_00 }],
  },
  {
    company: "kz",
    name: "Example: cut office costs",
    changes: [
      { kind: "cost", label: "Sample smaller office", startsIn: 2, amount: -250_000_00 },
      { kind: "cash_out", label: "Sample move", startsIn: 2, amount: 400_000_00 },
    ],
  },
];

// ── Mirrored records ────────────────────────────────────────────────────────

const address = (name: string, domain: string) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`;
const person = (name: string, domain: string) => ({ name, address: address(name, domain) });

/** Whose records: the deployment owner's (shared mirror), or the teammate with Today. */
export type SeedHolder = "owner" | "teammate";

/**
 * Mail, calendar, meeting notes and Linear issues for one holder. The owner's
 * Linear rows are the shared board; a teammate's are their own.
 */
export function seedMirror(
  now: number,
  holder: SeedHolder,
): { source: MirrorSource; rows: MirrorRecord[] }[] {
  const mine = holder === "owner" ? "Owner Example" : TODAY_TEAMMATE.name;
  const tag = holder === "owner" ? "o" : "t";
  const today = midnight(now);

  const mail = (index: number, from: [string, string], subject: string, hoursAgo: number) => ({
    kind: "mail" as const,
    threadId: `seed-thread-${tag}${index}`,
    fromName: from[0],
    fromAddress: address(from[0], from[1]),
    subject,
    lastMessageAt: now - hoursAgo * HOUR_MS,
  });
  const event = (
    index: number,
    title: string,
    dayOffset: number,
    hour: number,
    minutes: number,
    people: [string, string][],
  ) => ({
    kind: "event" as const,
    eventId: `seed-event-${tag}${index}`,
    title,
    startsAt: today + dayOffset * DAY_MS + hour * HOUR_MS,
    endsAt: today + dayOffset * DAY_MS + hour * HOUR_MS + minutes * 60_000,
    allDay: false,
    attendees: people.map(([name, domain]) => person(name, domain)),
    attendeeCount: people.length + 1,
    hasMeetingLink: true,
  });
  const meeting = (index: number, title: string, daysBack: number, items: string[]) => ({
    kind: "meeting" as const,
    meetingId: `seed-meeting-${tag}${index}`,
    title,
    heldAt: today - daysBack * DAY_MS + 9 * HOUR_MS,
    durationMinutes: 25,
    participants: [person(mine, LOCAL_DOMAIN), person("Sam Placeholder", LOCAL_DOMAIN)],
    overview: "A made-up summary: what was agreed, in two sentences. Nothing here was said by anyone.",
    actionItems: items,
  });
  const issue = (
    index: number,
    team: [key: string, name: string],
    title: string,
    state: ["backlog" | "unstarted" | "started" | "completed", string],
    assigneeName: string,
    priority: number,
    daysBack: number,
  ) => ({
    kind: "issue" as const,
    issueId: `seed-issue-${tag}${index}`,
    identifier: `${team[0]}-${100 + index}`,
    title,
    url: `https://linear.app/example/issue/${team[0]}-${100 + index}`,
    stateType: state[0],
    stateName: state[1],
    teamKey: team[0],
    teamName: team[1],
    assigneeName,
    mine: assigneeName === mine,
    priority,
    updatedAt: now - daysBack * DAY_MS,
  });

  const STARTUP: [string, string] = ["RET", "Startup Platform"];
  const GLOBEX: [string, string] = ["DEF", "Globex"];
  const OPS: [string, string] = ["OPS", "Operations"];

  if (holder === "teammate") {
    return [
      {
        source: "gmail",
        rows: [
          mail(1, ["Pat Example", "maplestreet.test"], "Example: a question about the pilot", 5),
          mail(2, ["Jo Sample", "harborview.test"], "Example: can we move Thursday?", 28),
          mail(3, ["Robin Sample", "sampleseed.test"], "Example: intro, as promised", 51),
        ],
      },
      {
        source: "google_calendar",
        rows: [
          event(1, "Example: team standup", 0, 9, 15, [["Sam Placeholder", LOCAL_DOMAIN]]),
          event(2, "Example: renewals review", 0, 14, 45, [["Dana Sample", LOCAL_DOMAIN]]),
          event(3, "Example: pilot check-in", 1, 11, 30, [["Pat Example", "maplestreet.test"]]),
        ],
      },
      {
        source: "fireflies",
        rows: [meeting(1, "Example: renewals review", 2, ["Example: send the checklist"])],
      },
      {
        source: "linear",
        rows: [
          issue(1, GLOBEX, "Example: renewals checklist", ["started", "In Progress"], mine, 2, 1),
          issue(2, OPS, "Example: weekly review template", ["unstarted", "Todo"], mine, 3, 3),
          issue(3, STARTUP, "Example: pilot notes page", ["backlog", "Backlog"], mine, 4, 6),
        ],
      },
    ];
  }

  return [
    {
      source: "gmail",
      rows: [
        mail(1, ["Alex Example", "exampleventures.test"], "Example: following up on the deck", 3),
        mail(2, ["Jamie Mock", "mockgrowth.test"], "Example: two questions before diligence", 20),
        mail(3, ["Pat Example", "maplestreet.test"], "Example: invoice for October", 26),
        mail(4, ["Morgan Mock", "mockingbirdlane.test"], "Example: demo on Thursday", 44),
        mail(5, ["Casey Placeholder", "vendor.test"], "Example: your renewal quote", 70),
        mail(6, ["Robin Sample", "sampleseed.test"], "Example: quick call?", 96),
      ],
    },
    {
      source: "google_calendar",
      rows: [
        event(1, "Example: team standup", 0, 9, 15, [
          ["Ada Example", LOCAL_DOMAIN],
          ["Sam Placeholder", LOCAL_DOMAIN],
          ["Max Fixture", LOCAL_DOMAIN],
        ]),
        event(2, "Example: investor call", 0, 11, 30, [["Alex Example", "exampleventures.test"]]),
        event(3, "Example: pilot demo", 0, 15, 45, [["Morgan Mock", "mockingbirdlane.test"]]),
        event(4, "Example: one-to-one", 1, 10, 30, [["Ada Example", LOCAL_DOMAIN]]),
        event(5, "Example: pipeline review", 1, 16, 60, [["Sam Placeholder", LOCAL_DOMAIN]]),
        event(6, "Example: weekly review", 2, 9, 60, []),
      ],
    },
    {
      source: "fireflies",
      rows: [
        meeting(1, "Example: team standup", 1, [
          "Example: follow up with the Shymkent demo",
          "Example: check the export button on Customers",
        ]),
        meeting(2, "Example: pipeline review", 3, ["Example: call three quiet clinics"]),
        meeting(3, "Example: investor call", 6, ["Example: send the updated deck"]),
      ],
    },
    {
      source: "linear",
      rows: [
        issue(1, STARTUP, "Example: denial queue for pilot two", ["started", "In Progress"], "Max Fixture", 1, 0),
        issue(2, STARTUP, "Example: slow search page", ["started", "In Progress"], "Max Fixture", 2, 1),
        issue(3, STARTUP, "Example: export button on Customers", ["unstarted", "Todo"], mine, 2, 2),
        issue(4, STARTUP, "Example: tidy the sign-in page", ["backlog", "Backlog"], "", 4, 9),
        issue(5, GLOBEX, "Example: sign-in fails on an old phone", ["started", "In Progress"], "Timur Testov", 1, 1),
        issue(6, GLOBEX, "Example: onboarding guide in Kazakh", ["unstarted", "Todo"], "Timur Testov", 3, 4),
        issue(7, OPS, "Example: shared calendar", ["completed", "Done"], mine, 4, 6),
        issue(8, OPS, "Example: review the vendor list", ["unstarted", "Todo"], mine, 3, 5),
      ],
    },
  ];
}

/** Apollo's two shared lists: its sequences, and contacts and accounts by stage. */
export function seedShared(now: number): SharedRecord[] {
  const sequence = (
    index: number,
    name: string,
    active: boolean,
    delivered: number,
    usedDaysAgo: number | null,
  ): SharedRecord => ({
    kind: "sequence",
    sequenceId: `seed-sequence-${index}`,
    name,
    active,
    archived: false,
    steps: 3 + (index % 3),
    createdAt: daysAgo(now, 30 + index * 40),
    ...(usedDaysAgo === null ? null : { lastUsedAt: daysAgo(now, usedDaysAgo) }),
    delivered,
    opened: Math.round(delivered * 0.42),
    replied: Math.round(delivered * 0.045),
    bounced: Math.round(delivered * 0.02),
    unsubscribed: Math.round(delivered * 0.005),
    clicked: Math.round(delivered * 0.06),
  });
  const stage = (entity: "contact" | "account", name: string, count: number): SharedRecord => ({
    kind: "stage_count",
    entity,
    stage: name,
    count,
  });
  return [
    sequence(1, "Example: specialty practices, first touch", true, 1_840, 1),
    sequence(2, "Example: dental groups, follow-up", true, 960, 2),
    sequence(3, "Example: conference leads", false, 410, 35),
    sequence(4, "Example: new sequence, not used yet", false, 0, null),
    stage("contact", "Cold", 2_600),
    stage("contact", "Approaching", 940),
    stage("contact", "Replied", 310),
    stage("contact", "Interested", 120),
    stage("contact", "Not interested", 230),
    stage("account", "Cold", 380),
    stage("account", "Current client", 38),
    stage("account", "Active opportunity", 46),
  ];
}

/**
 * GitHub's two lists for the Engineering page: a few repositories and their
 * pull requests, for each company, with something in every stage of the flow
 * and something stuck for each reason. The organisation, the repositories,
 * the titles and the engineers are all invented.
 */
export function seedGithub(now: number): SharedRecord[] {
  const ORG = "example-seed-org";
  const HOUR_MS = 60 * 60 * 1000;
  const ago = (days: number) => now - Math.round(days * 24) * HOUR_MS;
  const repo = (
    name: string,
    company: "us" | "kz",
    counts: [merged: number, open: number, stuck: number],
    main: "passing" | "failing" | "pending" | "none",
    pushedDaysAgo: number,
  ): SharedRecord => ({
    kind: "repo",
    repoId: `${ORG}/${name}`,
    org: ORG,
    name,
    company,
    mergedLastWeek: counts[0],
    open: counts[1],
    stuck: counts[2],
    main,
    pushedAt: daysAgo(now, pushedDaysAgo),
  });
  type Person = { login: string; name: string };
  const people: Record<"us" | "kz", Person[]> = {
    us: [
      { login: "example-ada", name: "Ada Example" },
      { login: "example-ben", name: "Ben Sample" },
      { login: "example-cy", name: "Cy Placeholder" },
    ],
    kz: [
      { login: "example-dana", name: "Dana Example" },
      { login: "example-erik", name: "Erik Mockwell" },
    ],
  };
  let number = 100;
  const pull = (
    repoName: string,
    company: "us" | "kz",
    who: number,
    title: string,
    over: Partial<Extract<SharedRecord, { kind: "pull_request" }>>,
  ): SharedRecord => {
    number += 1;
    const author = people[company][who % people[company].length]!;
    const repoId = `${ORG}/${repoName}`;
    return {
      kind: "pull_request",
      repoId,
      number,
      company,
      title: `Example: ${title}`,
      url: `https://github.com/${repoId}/pull/${number}`,
      authorLogin: author.login,
      authorName: author.name,
      draft: false,
      state: "open",
      createdAt: ago(1),
      updatedAt: ago(0.2),
      reviewDecision: "review_required",
      reviewersRequested: 0,
      reviewers: [],
      checks: "passing",
      ...over,
    };
  };
  // The same shape of week for each company, in its own repositories.
  const weekOf = (company: "us" | "kz", app: string, api: string): SharedRecord[] => {
    const reviewer = people[company][1]!.login;
    return [
      pull(app, company, 0, "sketch of the new intake form", { draft: true, createdAt: ago(3), updatedAt: ago(1), checks: "none" }),
      pull(api, company, 1, "spike on the export job", { draft: true, createdAt: ago(21), updatedAt: ago(10), checks: "none" }),
      pull(app, company, 0, "show the reason beside a denied line", { createdAt: ago(1), reviewersRequested: 1, reviewers: [reviewer] }),
      pull(app, company, 2, "paginate the long list", { createdAt: ago(6), reviewersRequested: 2, reviewers: [reviewer] }),
      pull(api, company, 1, "retry a timed-out lookup once", { createdAt: ago(2), checks: "failing" }),
      pull(api, company, 0, "cache the code table", { createdAt: ago(9), updatedAt: ago(5), lastReviewAt: ago(5), reviewDecision: "changes_requested" }),
      pull(app, company, 2, "tidy the date picker", { createdAt: ago(4), updatedAt: ago(0.5), lastReviewAt: ago(1), reviewDecision: "changes_requested", checks: "pending" }),
      pull(app, company, 1, "rename the settings tabs", { createdAt: ago(7), updatedAt: ago(4), lastReviewAt: ago(4), reviewDecision: "approved" }),
      pull(api, company, 0, "log the request id", { createdAt: ago(2), updatedAt: ago(0.3), lastReviewAt: ago(0.3), reviewDecision: "approved" }),
      pull(app, company, 0, "fix the empty state", { state: "merged", createdAt: ago(5), updatedAt: ago(1), mergedAt: ago(1), closedAt: ago(1), reviewDecision: "approved" }),
      pull(api, company, 1, "bump the test runner", { state: "merged", createdAt: ago(8), updatedAt: ago(4), mergedAt: ago(4), closedAt: ago(4), reviewDecision: "approved" }),
      pull(api, company, 2, "speed up the nightly build", { state: "merged", createdAt: ago(12), updatedAt: ago(9), mergedAt: ago(9), closedAt: ago(9), reviewDecision: "approved" }),
      pull(app, company, 2, "an idea that was dropped", { state: "closed", createdAt: ago(10), updatedAt: ago(3), closedAt: ago(3), reviewDecision: "none" }),
    ];
  };
  return [
    repo("example-startup-app", "us", [2, 5, 2], "passing", 0),
    repo("example-startup-api", "us", [1, 4, 1], "failing", 1),
    repo("example-startup-docs", "us", [0, 0, 0], "none", 40),
    repo("example-globex-app", "kz", [2, 5, 2], "passing", 0),
    repo("example-globex-api", "kz", [1, 4, 1], "pending", 2),
    ...weekOf("us", "example-startup-app", "example-startup-api"),
    ...weekOf("kz", "example-globex-app", "example-globex-api"),
  ];
}

export const SEED_WORK_TOOL_SETTINGS = {
  off: [],
  investorDomains: ["exampleventures.test", "mockgrowth.test", "sampleseed.test"],
  customerDomains: ["maplestreet.test", "mockingbirdlane.test", "harborview.test"],
} satisfies WithoutSystemFields<Doc<"workToolSettings">>;

// ── Support (Globex's Intercom inbox) ─────────────────────────────────────

/** A made-up workspace id code: links go to Intercom's inbox page and find nothing. */
export const SEED_SUPPORT_APP = "made0up1";

/**
 * Made-up chats over the last eight weeks: mostly customers', some tests and
 * one from another product; Fin resolving, handing on, a customer unhappy
 * with it; two waiting on a person at the push (one past four hours, so
 * Today lists it); a test chat and an old chat left open. Teammates are
 * "Sample …"; articles are "Example: …". No message and no customer exists.
 */
export function seedSupport(now: number): SupportRow[] {
  const pushedAt = now - 10 * 60 * 1000;
  const rows: SupportRow[] = [];
  const add = (
    hoursAgo: number,
    over: Partial<SupportRow> & { origin?: SupportOrigin; finOutcome?: FinOutcome | null } = {},
  ) => {
    const createdAt = pushedAt - hoursAgo * HOUR_MS;
    const replied = over.humanRepliedAt !== undefined ? over.humanRepliedAt : createdAt + 40 * 60 * 1000;
    rows.push({
      intercomId: String(910_000 + rows.length),
      createdAt,
      updatedAt: createdAt + 2 * HOUR_MS,
      state: "closed",
      open: false,
      priority: false,
      waitingSince: null,
      origin: "customer",
      pageArea: "studies",
      finParticipated: true,
      finOutcome: "assumed_resolution",
      humanRepliedAt: replied,
      timeToHumanReply: replied === null ? null : Math.round((replied - createdAt) / 1000),
      lastCustomerReplyAt: createdAt + 10 * 60 * 1000,
      lastHumanReplyAt: replied,
      assigneeId: "41",
      assigneeName: "Sample Teammate",
      parts: 6,
      reopens: 0,
      rating: null,
      articles: ["Example: uploading a study"],
      ...over,
    });
  };
  const AREAS = ["studies", "studies/report", "billing", "settings/team", "dashboard"];
  const OUTCOMES: (FinOutcome | null)[] = ["assumed_resolution", "escalated", "confirmed_resolution", "negative_feedback", "assumed_resolution"];
  for (let i = 0; i < 26; i += 1) {
    const outcome = OUTCOMES[i % OUTCOMES.length]!;
    add(12 + i * 50, {
      pageArea: AREAS[i % AREAS.length]!,
      finOutcome: outcome,
      // Fin's own resolutions had no person reply.
      ...(outcome === "assumed_resolution" ? { humanRepliedAt: null } : {}),
      articles: i % 3 === 0 ? ["Example: uploading a study", "Example: reading a report"] : ["Example: billing questions"],
    });
  }
  // Tests from staging and Intercom's preview, and one chat from another product.
  for (let i = 0; i < 6; i += 1) add(30 + i * 160, { origin: "test", pageArea: null, assigneeId: null, assigneeName: null });
  add(200, { origin: "other", pageArea: null });
  add(400, { origin: "unknown", pageArea: null, finParticipated: false, finOutcome: null, articles: [] });
  // Waiting on a person at the push: one for six hours (Today lists it), one for two.
  add(7, {
    state: "open",
    open: true,
    finOutcome: "escalated",
    waitingSince: pushedAt - 6 * HOUR_MS,
    humanRepliedAt: null,
    lastCustomerReplyAt: pushedAt - 6 * HOUR_MS,
    assigneeId: null,
    assigneeName: null,
    pageArea: "studies/report",
  });
  add(3, {
    state: "open",
    open: true,
    finParticipated: false,
    finOutcome: null,
    waitingSince: pushedAt - 2 * HOUR_MS,
    humanRepliedAt: null,
    lastCustomerReplyAt: pushedAt - 2 * HOUR_MS,
    assigneeId: "42",
    assigneeName: null,
    articles: [],
    pageArea: "billing",
  });
  // Left open: a test chat, and a customer's from 40 days ago.
  add(50, { origin: "test", pageArea: null, state: "open", open: true });
  add(40 * 24, { state: "open", open: true, finOutcome: "assumed_resolution" });
  return rows;
}
