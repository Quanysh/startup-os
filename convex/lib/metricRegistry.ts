// The metric registry: every number the OS stores is declared here. It lives
// under convex/ because Convex bundles only this directory and the ingest
// endpoint and connectors must validate against it; the UI imports it through
// the `@convex/*` alias. Benchmarks are UI-only and live in src/lib/metrics.

import { COMPANIES } from "./company";
import type { Period } from "./periods";
import type { Area } from "./roles";
import { COMPANY_IDENTITY } from "./identity";
import { KZ_DETAIL_FIGURES } from "./kzProductDetail";

export const SCOPES = [
  "company",
  "us",
  "kz",
  "startup_insights",
  "vertical_startup",
  "kz_product",
] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  company: "Company",
  us: "US",
  kz: "Kazakhstan",
  startup_insights: "Startup Insights",
  vertical_startup: "Vertical Startup",
  kz_product: "Kazakhstan product",
};

// Every place a number can come from. Whether a source is wired up yet is the
// connector manifest's business, not this list's.
export const SOURCE_IDS = [
  "manual",
  "mercury",
  "cfo_workbook",
  // Carries clinics, not numbers: it owns no metric, so its token can write none.
  "client_register",
  // Carries the plan, not numbers: it owns no metric either.
  "financial_model",
  "posthog",
  "posthog_globex",
  "vercel",
  "vertical_startup",
  "apollo",
  "search_console",
  "visible",
  "kz_crm",
  // Work tools (Phase 8). They mirror records and own no metric.
  "gmail",
  "google_calendar",
  "linear",
  "fireflies",
  // The daily standup's tasks (convex/standup.ts). Cards, not numbers: it owns no metric.
  "standup",
  // Engineering signals, gathered by a local script through the GitHub CLI
  // (scripts/githubGather.ts). Counts, dates and build results: never code.
  "github",
  // Vertical Startup's AI agents: daily usage, provider health and the config
  // applied (convex/agentControl.ts). Ids and numbers: it owns no metric.
  "vertical_agents",
  // Globex's Intercom inbox (convex/support.ts): conversations as ids,
  // times and states, never a message or a customer. It owns no metric.
  "intercom",
  // People pushed into the Contacts book on another source's token
  // (convex/lib/contactPush.ts). Each has no token of its own (`carriedBy`)
  // and owns no metric: its run and status say how the last push went.
  "visible_contacts",
  "apollo_contacts",
  "gmail_contacts",
  "google_calendar_contacts",
  "fireflies_contacts",
  "kz_crm_contacts",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SECTIONS = [
  "finance",
  "product",
  "sales",
  "fundraising",
  "marketing",
  "gtm",
] as const;
export type Section = (typeof SECTIONS)[number];

export const UNITS = ["currency", "count", "percent", "ratio", "months"] as const;
export type Unit = (typeof UNITS)[number];

/** The currencies the OS knows. A company's own is in its identity (convex/lib/identity.ts). */
export const CURRENCIES = ["USD", "KZT"] as const;
export type Currency = (typeof CURRENCIES)[number];

// The currency money is stored in for each market scope: each company's own,
// from its identity (main: Startup in dollars, Globex in tenge). Amounts stay
// in the company's currency and are converted with the stored USD/KZT rate at
// read time, so the rate is applied exactly once and a correction to it flows
// through.
export const SCOPE_CURRENCY: Partial<Record<Scope, Currency>> = {
  company: "USD",
  us: COMPANY_IDENTITY.us.currency,
  kz: COMPANY_IDENTITY.kz.currency,
};

export type MetricDef = {
  key: string;
  label: string;
  section: Section;
  /**
   * The currency a money metric is stored in where it is not its scope's
   * (`SCOPE_CURRENCY`): Globex's AI token cost is billed in US dollars,
   * and its product scope has no market currency. Read through `currencyOf`.
   */
  currency?: Currency;
  /**
   * Areas beside the section's whose holders are sent the figure too. GitHub's
   * figures are Product's and are also on the Engineering page, which is an
   * area of its own: someone with either is sent them, and someone with
   * `engineering` alone is sent nothing else of Product.
   */
  alsoFor?: readonly Area[];
  unit: Unit;
  /** The bucket size this metric is stored at. */
  grain: Period;
  /** Which direction is good; drives the colour of a change. */
  better: "up" | "down";
  /**
   * The one source allowed to write each scope. A scope missing here is not
   * valid for the metric. Writes from any other source are rejected, so a
   * manual entry and a sync can never overwrite each other.
   */
  sources: Partial<Record<Scope, SourceId>>;
  /**
   * Days after a bucket ends before the metric is flagged for having nothing
   * newer. 45 on a monthly metric means October's figure is due by mid
   * November.
   */
  staleAfterDays: number;
  /**
   * A different limit for one scope, when the same metric arrives at different
   * rhythms: US cash is synced daily, Kazakhstan cash is typed in monthly.
   */
  staleAfterDaysByScope?: Partial<Record<Scope, number>>;
  /**
   * Plausibility limits, checked on every write. They exist to stop a typo or
   * a broken sync from becoming the number on the scorecard: a negative
   * revenue, half a clinic, an exchange rate missing a digit.
   */
  min?: number;
  max?: number;
  integer?: boolean;
  /** Position on the home scorecard; absent means not shown there. */
  home?: number;
  /**
   * Not a tile, but a scorecard number is computed from it, so it is checked
   * for being missing or stale like one.
   */
  watch?: boolean;
  /**
   * An event rather than a level: a bucket with no row means none happened.
   * The only kind of metric where a missing number IS a zero, so it is never
   * reported as missing or stale. It cannot be a tile or watched.
   */
  sparse?: boolean;
};

/** GitHub's figures are shown on the Engineering page too. */
const ENGINEERING: readonly Area[] = ["engineering"];

export const METRICS: readonly MetricDef[] = [
  {
    // Kazakhstan: what was actually received in the month, as the CFO's
    // workbook and startup-model headline it. The contracted figure is stored
    // beside it as mrr_contracted.
    key: "mrr",
    label: "MRR",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { us: "manual", kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    home: 1,
  },
  {
    // The sum of active clients' monthly fees in the client register. Higher
    // or lower than receipts depending on who actually paid.
    key: "mrr_contracted",
    label: "Contracted monthly fees",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
  },
  {
    // US: every open Mercury account plus Treasury, read daily.
    // Kazakhstan: the bank balance, typed in at month end.
    key: "cash",
    label: "Cash",
    section: "finance",
    unit: "currency",
    grain: "day",
    better: "up",
    sources: { us: "mercury", kz: "manual" },
    staleAfterDays: 35,
    staleAfterDaysByScope: { us: 3 },
    min: 0,
    home: 2,
  },
  {
    // Money received in the month, including any financing. Transfers between
    // Startup's own accounts are left out by the connector.
    key: "cash_in",
    label: "Cash in",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { us: "mercury" },
    staleAfterDays: 35,
    min: 0,
  },
  {
    key: "cash_out",
    label: "Cash out",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "down",
    sources: { us: "mercury" },
    staleAfterDays: 35,
    min: 0,
  },
  {
    // Of cash_out, what Startup sent its subsidiary Globex (Globex LLP)
    // in the month: Mercury's posted payments to it, matched on its name by
    // `isSubsidiaryCounterparty`. Inside cash_out, which stays the bank's
    // total, so Startup's own net burn includes it; the group takes it back
    // out, because Globex's spending of it is in Globex's figures. Not
    // sparse: a month with cash_out and no row here was read before this was
    // counted, and is not known.
    key: "cash_to_subsidiary",
    label: `Sent to ${COMPANIES.kz.name}`,
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "down",
    sources: { us: "mercury" },
    staleAfterDays: 35,
    min: 0,
  },
  {
    // Investor money received in the month. It is inside cash_in (US) and
    // inside the balance (Kazakhstan); net burn takes it back out.
    // Outside money only: a transfer between Startup's own entities is never
    // typed here. Startup's funding of Globex (cash_to_subsidiary) is taken
    // out of Globex's own burn as financing already, from Mercury's
    // figure (withSubsidiaryFunding); typed here too it would count twice.
    key: "financing_in",
    label: "Financing received",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { us: "manual", kz: "manual" },
    staleAfterDays: 45,
    min: 0,
    sparse: true,
  },
  {
    key: "paying_clinics",
    label: "Paying clinics",
    section: "finance",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { us: "manual", kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    integer: true,
    home: 3,
  },
  {
    // "Active clients" in the workbook's summary: contracted and not churned,
    // whether or not they paid this month.
    key: "clinics_active",
    label: "Active clients",
    section: "finance",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    integer: true,
  },
  {
    // The "Using the product" row of the CFO workbook's summary. The workbook
    // counts these separately from active and churned clients (clients ever
    // contracted = active + using + churned), so this is not a subset of the
    // paying clinics.
    key: "clinics_using",
    label: "Using the product, not active",
    section: "product",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { kz_product: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    integer: true,
  },
  {
    key: "receivables",
    label: "Owed by clients",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "down",
    sources: { kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
  },
  {
    // Globex's app: what its calls to language models cost in the month,
    // in US dollars, from the app's own cost events in PostHog (each call's
    // `estimated_cost_usd`, input and output). The cost of serving customers:
    // unit economics counts it in COGS (src/lib/finance/unit-economics.ts),
    // converted to tenge at the stored rate. The month in progress is sent
    // month to date and overwritten daily; only a finished month is read as
    // a month's cost. docs/setup.md has the query.
    key: "ai_token_cost",
    label: "AI token cost",
    section: "finance",
    unit: "currency",
    currency: "USD",
    grain: "month",
    better: "down",
    sources: { kz_product: "posthog_globex" },
    staleAfterDays: 45,
    min: 0,
    // About $64 a month in 2026; a dollar figure sent as cents would be 100 times it.
    max: 1_000_000,
  },
  {
    // The organisations (clinics) Globex's app spent AI tokens on that
    // month: distinct `organization_id` among the cost events. A count only:
    // no id is read out of PostHog or stored.
    key: "ai_token_clinics",
    label: "Clinics using AI",
    section: "finance",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { kz_product: "posthog_globex" },
    staleAfterDays: 45,
    min: 0,
    integer: true,
  },
  {
    // The workbook's "average monthly client churn", as a percentage.
    key: "logo_churn_monthly",
    label: "Average monthly client churn",
    section: "finance",
    unit: "percent",
    grain: "month",
    better: "down",
    sources: { kz: "cfo_workbook" },
    staleAfterDays: 45,
    min: 0,
    max: 100,
  },
  {
    // KZT per 1 USD. Kazakhstan money is stored in KZT and converted at read.
    // It is the rate the CFO's workbook uses, so the OS and startup-model
    // convert the same tenge into the same dollars.
    key: "fx_usd_kzt",
    label: "USD/KZT rate",
    section: "finance",
    unit: "ratio",
    grain: "month",
    better: "down",
    sources: { company: "cfo_workbook" },
    staleAfterDays: 45,
    // The rate has been between roughly 380 and 550 since 2020. These limits
    // are wide enough for any real move and tight enough to catch 44 or 4400.
    min: 100,
    max: 2_000,
    watch: true,
  },
  // ── Product health ──────────────────────────────────────────────────────
  // Weekly counts, Monday to Monday in UTC. Only weeks that have ended are
  // ever stored, so the newest bucket is always a whole week. Nine days
  // without a newer one means two daily syncs in a row brought nothing.
  {
    // Startup Insights: people who ran at least one search, guests included.
    // Vertical Startup: signed-in people who did at least one core action.
    // Globex's app: signed-in people with any activity on app.globex.example.com,
    // the team's own and test accounts left out.
    key: "weekly_active_users",
    label: "Weekly active users",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "posthog", vertical_startup: "vertical_startup", kz_product: "posthog_globex" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // `insights_search` events: the product's one job, on both chat routes.
    key: "searches",
    label: "Searches",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "posthog" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // People with at least one page view in the week, as PostHog counts them.
    key: "web_visitors",
    label: "Visitors",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "posthog" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // People whose first sign-in fell in the week.
    key: "signups",
    label: "Signups",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "posthog" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Of the week's signups, those who searched after signing up and no
    // later than seven days after it (a search from before does not count). Keyed by the signup week, so it keeps rising for a
    // week after that week ends: the activation rate waits for it to settle.
    key: "signups_activated",
    label: "Activated signups",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "posthog" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Vercel Web Analytics, production only. Read only when the owner has
    // switched it on (VERCEL_WEB_ANALYTICS), so it may never arrive.
    key: "site_pageviews",
    label: "Page views",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "vercel" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Production deployments created in the week that became ready.
    key: "deploys",
    label: "Production deploys",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { startup_insights: "vercel" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Production deployments created in the week that ended in an error.
    // A cancelled build is not a failed one and is in neither count.
    key: "deploys_failed",
    label: "Failed production deploys",
    section: "product",
    unit: "count",
    grain: "week",
    better: "down",
    sources: { startup_insights: "vercel" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Globex's app: organisations in which someone finished at least one
    // check that week. Stricter than "any activity", which counts a look-in.
    key: "clinics_checking",
    label: "Clinics that ran a check",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { kz_product: "posthog_globex" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Globex's app: checks finished, every kind together (intake,
    // records, journal, orders, globex, lookup). The product's output.
    key: "checks_completed",
    label: "Checks completed",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { kz_product: "posthog_globex" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    key: "practices_active",
    label: "Active practices",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { vertical_startup: "vertical_startup" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Work items a person acted on. Vertical Startup's own list defines which.
    key: "core_actions",
    label: "Work items handled",
    section: "product",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { vertical_startup: "vertical_startup" },
    staleAfterDays: 9,
    min: 0,
    integer: true,
  },
  {
    // Practices onboarded and not archived, read daily: a level, like cash.
    key: "practices",
    label: "Practices",
    section: "product",
    unit: "count",
    grain: "day",
    better: "up",
    sources: { vertical_startup: "vertical_startup" },
    staleAfterDays: 3,
    min: 0,
    integer: true,
  },

  // ── Engineering (GitHub) ─────────────────────────────────────────────────
  // Per company (Startup "us", Globex "kz"), summed over the repositories
  // tracked for it (scripts/githubRepos.ts). Counted from pull requests'
  // states and dates and the default branch's build result: no code, no
  // title and no person is read into a number, and none is per person. Pull
  // requests opened by bots are in no count. None is a home tile or watched:
  // the attention list hears of them through `engineeringAttention`. Their
  // section is Product (the dashboard's one line), and they are also sent to
  // whoever has the `engineering` area, whose page shows them (`alsoFor`).
  {
    // Merged in the week (Monday to Monday, UTC), by the time of the merge.
    // A week's own count, stored once the week has ended (`pushRules.ts`).
    key: "prs_merged",
    label: "Pull requests merged",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 10,
    min: 0,
    max: 10_000,
    integer: true,
  },
  {
    // Opened in the week, by the time they were created, whatever became of them.
    key: "prs_opened",
    label: "Pull requests opened",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 10,
    min: 0,
    max: 10_000,
    integer: true,
  },
  {
    // The four below are levels: the figure as last read, filed under the
    // week in progress and overwritten daily, like Apollo's levels.
    // Open now, drafts included.
    key: "prs_open",
    label: "Open pull requests",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "down",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 4,
    min: 0,
    max: 100_000,
    integer: true,
  },
  {
    // Open, not a draft, and more than three days since it was opened or
    // last reviewed, whichever is later.
    key: "prs_stuck",
    label: "Pull requests waiting more than 3 days",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "down",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 4,
    min: 0,
    max: 100_000,
    integer: true,
  },
  {
    // Tracked repositories whose default branch's latest commit has a failed
    // or errored build.
    key: "repos_failing",
    label: "Repositories with a failing main branch",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "down",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 4,
    min: 0,
    max: 300,
    integer: true,
  },
  {
    // Repositories pushed to in the last 90 days: what the counts above cover.
    key: "repos_tracked",
    label: "Repositories tracked",
    section: "product",
    alsoFor: ENGINEERING,
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "github", kz: "github" },
    staleAfterDays: 4,
    min: 0,
    max: 300,
    integer: true,
  },

  // ── Marketing ────────────────────────────────────────────────────────────
  // Site visitors and signups are PostHog's and are declared with the
  // product-health metrics (`web_visitors`, `signups`); the marketing page
  // reads them from there, through the product page's visitor-to-signup tile.
  {
    // Search Console, Monday to Sunday in Google's (Pacific) dates. Google's
    // figures arrive two to three days late, and only a week Google has
    // finished is written.
    key: "search_clicks",
    label: "Search clicks",
    section: "marketing",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { company: "search_console" },
    // On a Monday or Tuesday the newest finished week ended eight or nine days
    // ago. Twelve days means a whole week has been missed.
    staleAfterDays: 12,
    min: 0,
    integer: true,
  },
  {
    key: "search_impressions",
    label: "Search impressions",
    section: "marketing",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { company: "search_console" },
    staleAfterDays: 12,
    min: 0,
    integer: true,
  },
  {
    // The average position of the site's topmost result, weighted by
    // impressions. 1 is the top of the page, so lower is better.
    key: "search_position",
    label: "Average search position",
    section: "marketing",
    unit: "ratio",
    grain: "week",
    better: "down",
    sources: { company: "search_console" },
    staleAfterDays: 12,
    min: 1,
    max: 1000,
  },
  {
    // Typed in weekly: LinkedIn's API is not open to a company this size.
    key: "linkedin_followers",
    label: "LinkedIn followers",
    section: "marketing",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { company: "manual" },
    staleAfterDays: 10,
    min: 0,
    integer: true,
  },

  // ── Go to market ─────────────────────────────────────────────────────────
  {
    // Apollo's totals to date across every sequence, as last read in the week.
    // A week's own figure is the difference between two weeks' totals, worked
    // out at read time.
    key: "outbound_delivered",
    label: "Outbound emails delivered, to date",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    // Read daily into the week in progress, so a bucket should always be current.
    staleAfterDays: 4,
    min: 0,
    integer: true,
  },
  {
    key: "outbound_opened",
    label: "Outbound emails opened, to date",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    integer: true,
  },
  {
    key: "outbound_replied",
    label: "Outbound replies, to date",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    integer: true,
  },
  {
    // Apollo's prospect and task levels: like the outbound totals above, each
    // is the figure as last read in the week, filed under the week in progress
    // and overwritten daily. None is a home tile.
    key: "apollo_contacts",
    label: "Contacts in Apollo",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    max: 10_000_000,
    integer: true,
  },
  {
    key: "apollo_accounts",
    label: "Accounts in Apollo",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    max: 10_000_000,
    integer: true,
  },
  {
    // Tasks scheduled and not yet done or skipped. Fewer waiting is better.
    key: "apollo_tasks_open",
    label: "Open Apollo tasks",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "down",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    max: 1_000_000,
    integer: true,
  },
  {
    // The open tasks whose due date has passed.
    key: "apollo_tasks_overdue",
    label: "Overdue Apollo tasks",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "down",
    sources: { us: "apollo" },
    staleAfterDays: 4,
    min: 0,
    max: 1_000_000,
    integer: true,
  },
  {
    // A week's own count (Monday to Sunday, as Apollo's report labels it),
    // stored once the week has ended: a part-week would read as a quiet one
    // (`pushRules.ts`). Not sparse: Apollo reports every week, so a week with
    // no row is unknown, not zero. The newest finished week ended up to seven
    // days ago; ten days means one was missed.
    key: "apollo_contacts_added",
    label: "Contacts added to Apollo",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 10,
    min: 0,
    max: 1_000_000,
    integer: true,
  },
  {
    key: "apollo_calls",
    label: "Calls logged in Apollo",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { us: "apollo" },
    staleAfterDays: 10,
    min: 0,
    max: 100_000,
    integer: true,
  },
  {
    // Typed in weekly. Not sparse: a week nobody filled in is unknown, not zero.
    key: "meetings_booked",
    label: "Meetings booked",
    section: "gtm",
    unit: "count",
    grain: "week",
    better: "up",
    sources: { company: "manual" },
    staleAfterDays: 10,
    min: 0,
    integer: true,
  },
  // Globex's app in detail (convex/lib/kzProductDetail.ts): weekly counts
  // by module, failure cause, doctor group, trial outcome and clinic change,
  // one key each because a snapshot carries no dimension.
  ...KZ_DETAIL_FIGURES.map(
    (f): MetricDef =>
      f.unit === "percent"
        ? {
            key: f.key,
            label: f.label,
            section: "product",
            unit: "percent",
            grain: "week",
            better: f.better,
            sources: { kz_product: "posthog_globex" },
            staleAfterDays: 9,
            min: 0,
            max: 100,
          }
        : f.unit === "currency"
        ? {
            key: f.key,
            label: f.label,
            // Money: what the app's AI calls cost is Finance's figure, sent
            // only to its holders (`maySeeMetric`), as `ai_token_cost` is.
            section: "finance",
            unit: "currency",
            // Billed in dollars, as `ai_token_cost` is.
            currency: "USD",
            grain: "week",
            better: f.better,
            sources: { kz_product: "posthog_globex" },
            staleAfterDays: 9,
            min: 0,
            max: 100_000,
          }
        : {
            key: f.key,
            label: f.label,
            section: f.finance ? "finance" : "product",
            unit: "count",
            grain: "week",
            better: f.better,
            sources: { kz_product: "posthog_globex" },
            staleAfterDays: 9,
            min: 0,
            max: 1_000_000,
            integer: !f.fraction,
          },
  ),
];

export function getMetric(
  key: string,
  registry: readonly MetricDef[] = METRICS,
): MetricDef | undefined {
  return registry.find((m) => m.key === key);
}

/** The currency a money metric's figures in a scope are stored in: its own, else its scope's. */
export function currencyOf(metric: MetricDef, scope: string): Currency | undefined {
  if (metric.unit !== "currency") return undefined;
  return metric.currency ?? SCOPE_CURRENCY[scope as Scope];
}

export function metricScopes(metric: MetricDef): Scope[] {
  return SCOPES.filter((scope) => metric.sources[scope] !== undefined);
}

/** Days after a bucket ends before this metric, in this scope, counts as stale. */
export function staleAfter(metric: MetricDef, scope: string): number {
  return metric.staleAfterDaysByScope?.[scope as Scope] ?? metric.staleAfterDays;
}
