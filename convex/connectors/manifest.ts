// The sources that are wired up today. Adding a source means adding an entry
// here; the registry's SOURCE_IDS merely names where numbers may come from.

import type { Cadence } from "../lib/cadence";
import { COMPANIES } from "../lib/company";
import { KZ_APP_HOST } from "../lib/features";
import { REGISTER_STALE_DAYS } from "../lib/limits";
import type { SourceId } from "../lib/metricRegistry";

export type SourceDef = {
  id: SourceId;
  label: string;
  /** One word, for the footer of a scorecard tile. */
  short: string;
  /**
   * How the source reads inside a sentence, with its own article where it
   * takes one: "Arrives with Mercury.", "Arrives with the CFO workbook."
   */
  named: string;
  /**
   * manual — typed into the OS.
   * ingest — pushed to POST /ingest/v1 with this source's bearer token.
   * api    — pulled by a scheduled connector.
   */
  kind: "manual" | "ingest" | "api";
  description: string;
  /** Convex env vars this source needs. Missing ones mean "not configured". */
  requiredEnv: readonly string[];
  /**
   * `false` when every run already reads all the source keeps, so there is
   * no longer history to ask for and no "Backfill" button. Pulled sources
   * only; absent means a backfill is offered.
   */
  backfill?: false;
  /**
   * True for the one source that may send a `customers` array (the client
   * register). Every other source's `customers` is refused, so a token that
   * writes numbers can never write names.
   */
  customers?: true;
  /**
   * True for the one source that may send a `plan` (the financial model).
   * Its token writes the plan and nothing else.
   */
  plan?: true;
  /**
   * True for the one source that sends tasks for the board (the daily
   * standup). They travel on routes of their own (convex/standup.ts), never
   * in the ingest envelope, and the source owns no metric.
   */
  tasks?: true;
  /**
   * True for the one source that sends Vertical Startup's agents' usage, provider
   * health and applied config (`agentUsage`, `providers`,
   * `agentConfigApplied`). Its token writes those and nothing else.
   */
  agents?: true;
  /**
   * True for the one source that sends Globex's support inbox
   * (`intercom`): `records` of conversations with the workspace's
   * `appIdCode`, checked by convex/lib/supportRecords.ts and written by
   * `support.applyPush`. Its token writes those and nothing else.
   */
  support?: true;
  /**
   * True for a pulled source that a connector run may feed instead
   * (docs/ingest.md, "Feeding the OS from Claude connectors"). It is pushed
   * only while its own API variables are not all set: see `feedOf`.
   */
  pushable?: true;
  /**
   * The source whose token carries this one's pushes, for a source that has
   * no token of its own: the people a source puts in the Contacts book
   * (`visible_contacts` and the rest, convex/lib/contactPush.ts).
   * Its own `INGEST_TOKEN_<ID>` is never read, so it authenticates nothing;
   * it is fed whenever its carrier's token is set. It has its own run
   * and status, so a refused contacts push never marks the carrier's board.
   */
  carriedBy?: SourceId;
  /**
   * How often it is expected to arrive (convex/lib/cadence.ts): the page
   * headers and Settings › Sources judge "late" by this and nothing else.
   * A pulled source keeps the time `convex/crons.ts` runs it at; a pushable
   * one fed by the morning connector run arrives about then too.
   */
  cadence: Cadence;
  /**
   * The four work tools only: how a teammate's own records are expected to
   * arrive, pushed by their own daily run (`SUGGESTED_RUN`). A teammate's
   * Today is judged by this, the owner's by `cadence`.
   */
  personal?: Cadence;
};

export function ingestTokenEnv(id: SourceId): string {
  return `INGEST_TOKEN_${id.toUpperCase()}`;
}

/** Shorter than this is a placeholder or a typo, not a secret. */
export const MIN_INGEST_TOKEN_LENGTH = 32;

/** A source's ingest token, or undefined when unset or too short to trust. */
export function ingestToken(id: SourceId): string | undefined {
  const token = process.env[ingestTokenEnv(id)];
  return token && token.length >= MIN_INGEST_TOKEN_LENGTH ? token : undefined;
}

/** The morning connector run (docs/setup.md): about 11:00 in Almaty. */
const MORNING: Cadence = { kind: "daily", hourUtc: 6, minuteUtc: 0 };
/** Pushed by a scheduled run once a day: the default for a pushed source. */
const DAILY_PUSH: Cadence = { kind: "pushed", everyDays: 1 };

/**
 * The sources that put people in the Contacts book, each on another source's
 * token (`carriedBy`, convex/lib/contactPush.ts): pushed daily, upserted only
 * (a person the source drops stays in the book).
 */
function contactSources(
  defs: readonly (Pick<SourceDef, "id" | "label" | "short" | "named" | "description"> & { carriedBy: SourceId })[],
): SourceDef[] {
  return defs.map((def) => ({
    ...def,
    description: `${def.description} Upserted only: a person the source drops stays in the book (docs/ingest.md, "Contacts").`,
    kind: "ingest",
    requiredEnv: [ingestTokenEnv(def.carriedBy)],
    cadence: DAILY_PUSH,
  }));
}

export const SOURCES: readonly SourceDef[] = [
  {
    id: "manual",
    label: "Manual entry",
    short: "Manual",
    named: "manual entry",
    kind: "manual",
    description: "Numbers typed into the OS: anything without a system of record.",
    requiredEnv: [],
    cadence: { kind: "typed" },
  },
  {
    id: "cfo_workbook",
    label: "CFO workbook",
    short: "Workbook",
    named: "the CFO workbook",
    kind: "ingest",
    description:
      "Summary figures from the CFO's retention workbook, pushed by scripts/push-retention.ts.",
    requiredEnv: [ingestTokenEnv("cfo_workbook")],
    cadence: { kind: "pushed", everyDays: 31 },
  },
  {
    id: "client_register",
    label: "Client register",
    short: "Register",
    named: "the client register",
    kind: "ingest",
    description:
      "One row per clinic from a CSV export of the CFO workbook's client register, pushed by scripts/push-customers.ts. The only source that carries client names.",
    requiredEnv: [ingestTokenEnv("client_register")],
    customers: true,
    cadence: { kind: "pushed", everyDays: REGISTER_STALE_DAYS },
  },
  {
    id: "financial_model",
    label: "Financial model",
    short: "Model",
    named: "the financial model",
    kind: "ingest",
    description:
      "The plan from the financial model (three scenarios, by year), pushed by a connector run that reads the model's MCP server. It carries the plan and no metric.",
    requiredEnv: [ingestTokenEnv("financial_model")],
    plan: true,
    cadence: { kind: "pushed", everyDays: 31 },
  },
  {
    id: "mercury",
    label: "Mercury",
    short: "Mercury",
    named: "Mercury",
    kind: "api",
    description:
      "US cash, money in and out by month<!-- feature:subsidiaryFunding -->, and what was sent to the subsidiary<!-- /feature -->, read daily with a Read Only API token.",
    requiredEnv: ["MERCURY_API_TOKEN"],
    pushable: true,
    cadence: MORNING,
  },
  {
    id: "posthog",
    label: "PostHog",
    short: "PostHog",
    named: "PostHog",
    kind: "api",
    description:
      "Startup Insights by week: visitors, signups, activation and searches, read daily with a personal API key (Query Read).",
    requiredEnv: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"],
    pushable: true,
    cadence: { kind: "daily", hourUtc: 6, minuteUtc: 10 },
  },
  {
    id: "posthog_globex",
    label: `PostHog (${COMPANIES.kz.name})`,
    short: "PostHog",
    named: "PostHog",
    kind: "api",
    description:
      `${COMPANIES.kz.name}'s app by week: checks, doctors, clinics, modules, failures, speed, AI cost and tracking health, read daily from the ${KZ_APP_HOST} project with the same personal API key (Query Read). Doctors' first and last names and each clinic's link to Customers come with it; never an email, a phone or what was typed.`,
    requiredEnv: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_GLOBEX_PROJECT_ID"],
    cadence: { kind: "daily", hourUtc: 6, minuteUtc: 30 },
  },
  {
    id: "vercel",
    label: "Vercel",
    short: "Vercel",
    named: "Vercel",
    kind: "api",
    description:
      "Startup Insights' production deployments by week, and page views when Web Analytics is switched on, read daily with a team token.",
    requiredEnv: ["VERCEL_API_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    cadence: { kind: "daily", hourUtc: 6, minuteUtc: 20 },
  },
  {
    id: "vertical_startup",
    label: "Vertical Startup",
    short: "Vertical",
    named: "Vertical Startup",
    kind: "api",
    description:
      "Vertical Startup's own weekly counts (active people, active practices, work items handled), read daily from its health endpoint. Counts only.",
    requiredEnv: ["VERTICAL_HEALTH_URL", "VERTICAL_HEALTH_SECRET"],
    backfill: false,
    cadence: { kind: "daily", hourUtc: 6, minuteUtc: 30 },
  },
  {
    id: "visible",
    label: "Visible",
    short: "Visible",
    named: "Visible",
    kind: "ingest",
    description:
      "The fundraising pipeline in Visible.vc, pushed by a Claude routine (docs/ingest.md).",
    requiredEnv: [ingestTokenEnv("visible")],
    cadence: DAILY_PUSH,
  },
  {
    id: "kz_crm",
    label: "Kazakhstan CRM",
    short: "CRM",
    named: "the Kazakhstan CRM",
    kind: "ingest",
    description:
      "Kazakhstan sales deals from the CRM, pushed by a Claude routine (docs/ingest.md).",
    requiredEnv: [ingestTokenEnv("kz_crm")],
    cadence: DAILY_PUSH,
  },
  {
    id: "search_console",
    label: "Search Console",
    short: "Google",
    named: "Search Console",
    kind: "api",
    description:
      "Search clicks, impressions and average position by week, read daily as a service account. Google's figures arrive two to three days late, so the newest week is the last one Google has finished.",
    requiredEnv: ["GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY", "GSC_SITE_URL"],
    cadence: { kind: "daily", hourUtc: 12, minuteUtc: 0 },
  },
  {
    id: "apollo",
    label: "Apollo",
    short: "Apollo",
    named: "Apollo",
    kind: "api",
    description:
      "Outbound emails delivered, opened and replied to, to date across every sequence, read daily. A connector run also brings contacts, accounts, tasks and calls as counts, the list of sequences and the contacts and accounts at each stage. No person's name or address is stored.",
    requiredEnv: ["APOLLO_API_KEY"],
    pushable: true,
    backfill: false,
    cadence: { kind: "daily", hourUtc: 6, minuteUtc: 20 },
  },
  // Work tools (Phase 8): mirrored records, not metrics. Read through runMirror.
  {
    id: "gmail",
    label: "Gmail",
    short: "Gmail",
    named: "Gmail",
    kind: "api",
    description:
      "Inbox threads waiting on a reply: sender, subject and time. Never a message body.",
    requiredEnv: ["GOOGLE_WORK_CLIENT_ID", "GOOGLE_WORK_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"],
    pushable: true,
    backfill: false,
    cadence: { kind: "every", minutes: 15 },
    personal: DAILY_PUSH,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    short: "Calendar",
    named: "Google Calendar",
    kind: "api",
    description: "Meetings on the primary calendar, from yesterday to nine days ahead.",
    requiredEnv: ["GOOGLE_WORK_CLIENT_ID", "GOOGLE_WORK_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"],
    pushable: true,
    backfill: false,
    cadence: { kind: "every", minutes: 15 },
    personal: DAILY_PUSH,
  },
  {
    id: "linear",
    label: "Linear",
    short: "Linear",
    named: "Linear",
    kind: "api",
    description: "Open issues and the last two weeks' finished ones, read-only, for the board.",
    requiredEnv: ["LINEAR_API_KEY"],
    pushable: true,
    backfill: false,
    cadence: { kind: "every", minutes: 15 },
    personal: DAILY_PUSH,
  },
  {
    id: "fireflies",
    label: "Fireflies",
    short: "Fireflies",
    named: "Fireflies",
    kind: "api",
    description: "Recent meetings' summaries and action items. Never a transcript.",
    requiredEnv: ["FIREFLIES_API_KEY"],
    pushable: true,
    backfill: false,
    cadence: { kind: "every", minutes: 60 },
    personal: DAILY_PUSH,
  },
  // Not a system of record: what the team said it would do at the daily
  // standup, read from Fireflies by a Claude session and sent as tasks.
  {
    id: "standup",
    label: "Standup tasks",
    short: "Standup",
    named: "the standup",
    kind: "ingest",
    description:
      "Tasks the team took on at the daily standup, added to the task board's Backlog by a Claude session that reads the meeting's summary in Fireflies (docs/setup.md). Titles only: never a transcript.",
    requiredEnv: [ingestTokenEnv("standup")],
    tasks: true,
    cadence: DAILY_PUSH,
  },
  // Serves both companies: which repository is whose is decided by the
  // script that gathers them (scripts/githubRepos.ts), not here.
  {
    id: "github",
    label: "GitHub",
    short: "GitHub",
    named: "GitHub",
    kind: "ingest",
    description:
      "Pull requests merged and opened by week, open and waiting ones, and whether each repository's main branch builds, gathered once a day by scripts/gather-github.ts through the GitHub CLI; and, for the Engineering page, each open or lately closed pull request with its title, its author and who is asked to review. Metadata only: never code, a diff, a description, a comment or a commit message.",
    requiredEnv: [ingestTokenEnv("github")],
    cadence: DAILY_PUSH,
  },
  // Not split by company: a product's agents (the `agents` area, /agents).
  {
    id: "vertical_agents",
    label: "Vertical Startup agents",
    short: "Agents",
    named: "Vertical Startup's agents",
    kind: "ingest",
    description:
      "Daily totals for each of Vertical Startup's AI agents by prompt version, provider and model (calls, failures, tokens, cost and latency), each provider's health, and the config version Vertical Startup applied, pushed by Vertical Startup's daily cron. Ids and numbers only: never a patient, a prompt or an answer.",
    requiredEnv: [ingestTokenEnv("vertical_agents")],
    agents: true,
    cadence: DAILY_PUSH,
  },
  // Globex's Intercom inbox: conversations, not numbers (convex/support.ts),
  // pushed once a day by a task on the owner's Mac that reads Intercom through
  // Claude's connector. Startup OS never calls Intercom and holds no Intercom key.
  {
    id: "intercom",
    label: "Intercom",
    short: "Intercom",
    named: "Intercom",
    kind: "ingest",
    description:
      `${COMPANIES.kz.name}'s support inbox: every open chat and every chat updated in the last 90 days, pushed once a day by the Intercom task on the owner's Mac (docs/setup.md, "Intercom"). Ids, times, states, Fin's outcome, the assignee, where a chat began as a class and a page area, help-article titles: never a tag, a message, a subject or anything about the customer.`,
    requiredEnv: [ingestTokenEnv("intercom")],
    support: true,
    cadence: DAILY_PUSH,
  },
  ...contactSources([
    {
      id: "visible_contacts",
      label: "Contacts from Visible",
      short: "Visible",
      named: "Visible",
      carriedBy: "visible",
      description:
        "The people at each investor in Visible.vc (name, email addresses, title), put in the Contacts book on Startup and linked to their investor by the daily Visible run. Never a phone number.",
    },
    {
      id: "apollo_contacts",
      label: "Contacts from Apollo",
      short: "Apollo",
      named: "Apollo",
      carriedBy: "apollo",
      description:
        "The owner's saved Apollo contacts (name, email addresses, title, organisation, LinkedIn), put in the Contacts book on Startup by the daily Apollo run, read without spending a credit. Never a phone number.",
    },
    {
      id: "gmail_contacts",
      label: "Contacts from Gmail",
      short: "Gmail",
      named: "Gmail",
      carriedBy: "gmail",
      description:
        "People the owner exchanged mail with at least twice in twelve months: name, email addresses, the last exchange and how many. Never a subject, a snippet or a message. No-reply senders and the team's own addresses are left out.",
    },
    {
      id: "google_calendar_contacts",
      label: "Contacts from Google Calendar",
      short: "Calendar",
      named: "Google Calendar",
      carriedBy: "google_calendar",
      description:
        "People outside the companies at the owner's meetings in twelve months: name, email addresses, the last meeting and how many. Never a title, a description or a link.",
    },
    {
      id: "fireflies_contacts",
      label: "Contacts from Fireflies",
      short: "Fireflies",
      named: "Fireflies",
      carriedBy: "fireflies",
      description:
        "People outside the companies at the owner's recorded meetings in twelve months: name, email addresses, the last meeting and how many. Never a transcript or a title.",
    },
    {
      id: "kz_crm_contacts",
      label: "Contacts from the Kazakhstan CRM",
      short: "CRM",
      named: "the Kazakhstan CRM",
      carriedBy: "kz_crm",
      description:
        "Each clinic's staff in the Kazakhstan CRM (name, role, email addresses, phone), put in the Contacts book on Globex and linked to the clinic's deal. Never a patient: a row that looks like one is dropped.",
    },
  ]),
];

export function missingEnv(source: SourceDef): string[] {
  if (source.carriedBy !== undefined) {
    return ingestToken(source.carriedBy) === undefined ? [ingestTokenEnv(source.carriedBy)] : [];
  }
  const tokenEnv = source.kind === "ingest" ? ingestTokenEnv(source.id) : null;
  return source.requiredEnv.filter((name) =>
    name === tokenEnv ? ingestToken(source.id) === undefined : !process.env[name],
  );
}

export type Feed = "manual" | "push" | "pull";

/**
 * How a source is fed right now, or null when nothing it needs is set.
 *
 * A pulled source stays pulled while its API variables are set. Without them,
 * a `pushable` one is fed by push once its ingest token is set. Never both:
 * the scheduled read and a connector run would overwrite each other, and
 * "when was this last read in full" would have two answers.
 */
export function feedOf(source: SourceDef): Feed | null {
  if (source.kind === "manual") return "manual";
  // Fed whenever its carrier's token is set: a contacts push is accepted on
  // that token even while the carrier itself is read with its API variables
  // (the OS's own read brings no contacts, so there is no second writer).
  if (source.carriedBy !== undefined) return ingestToken(source.carriedBy) === undefined ? null : "push";
  if (source.kind === "ingest") return ingestToken(source.id) === undefined ? null : "push";
  if (missingEnv(source).length === 0) return "pull";
  return source.pushable === true && ingestToken(source.id) !== undefined ? "push" : null;
}
