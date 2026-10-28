// What this deployment has that a fork may not: features of the company the
// OS was first built for, each behind one switch, and the ids of the outside
// accounts a deployment talks to. Beside convex/lib/identity.ts, the second
// file that makes the OS yours.
//
// **As the template ships, every switch is off** (one company, dollars only,
// none of the original company's own products) and every id is a placeholder
// or empty. Turn a switch on only once you have what it reads; put your own
// ids in as you connect each source. Then update the pinned values in
// convex/lib/deployment.test.ts.
//
// Pure constants, like identity.ts: imported by Convex functions, the Next.js
// app (as `@convex/lib/features`) and the scripts alike, so it reads no
// environment and imports nothing at run time. Committed, not environment
// variables: a deployment needs nothing set for them.
//
// What each switch takes away (its pages, sources, tools, areas and products)
// is in convex/lib/featureGates.ts, and the code asks `featureOn` there, never
// this object directly.

/** The switches, by name. */
export type FeatureId =
  | "secondCompany"
  | "subsidiaryFunding"
  | "kzProduct"
  | "supportInbox"
  | "verticalStartupAgents"
  | "startupInsights"
  | "verticalStartupProduct"
  | "kztCurrency";

export const FEATURES: Readonly<Record<FeatureId, boolean>> = {
  /**
   * The OS is run for two companies, "us" and its second, "kz" (their names,
   * currencies and the rest are in convex/lib/identity.ts). Off, it is run
   * for "us" alone (one-company mode): `companyIds()` in
   * convex/lib/company.ts is that one, so the owner, every teammate, the
   * gates, the agents' tools, the crons and the seed know nothing else; the
   * company switch, the group's figures and every page, tab, source and
   * word of the second company go, and a write for it is refused. The
   * switches below that are the second company's own (`subsidiaryFunding`,
   * `kzProduct`, `supportInbox`) are off with it, whatever they say.
   */
  secondCompany: false,
  /**
   * The second company is the first's subsidiary, funded from the first's
   * bank (Mercury): what the parent sends (`cash_to_subsidiary`) is the
   * subsidiary's financing, never its income (the intercompany rule in
   * Finance, the budget, the group's figures and Where the money goes). Off:
   * the bank's payments are not told apart, each company's burn is its own
   * bank's, and nothing on the finance pages or in the agents' docs speaks of
   * a subsidiary.
   */
  subsidiaryFunding: false,
  /**
   * The second company's own app on /product: its tab (a weekly report,
   * clinics, doctors, modules), each clinic's page under /product/kz, the
   * `kzProduct` queries and the PostHog read of the app (`posthog_globex`).
   */
  kzProduct: false,
  /** The second company's Intercom inbox: /support, the `support` area, its MCP tool and the `intercom` push. */
  supportInbox: false,
  /**
   * A product's agents' older way in (before Protocol v1): the
   * `vertical_agents` push, the signed config push to VERTICAL_STARTUP_URL and its
   * "send again", and that project listed before it connects. Projects on
   * Protocol v1 are not this.
   */
  verticalStartupAgents: false,
  /** A search product's /product tab and the two sources that read it (`posthog`, `vercel`). */
  startupInsights: false,
  /**
   * A product's /product tab read from its own health address
   * (`vertical_startup`, VERTICAL_HEALTH_URL). Not its agents
   * (`verticalStartupAgents`). With this and `startupInsights` off, /product says
   * no product is connected yet.
   */
  verticalStartupProduct: false,
  /**
   * Tenge as a currency people pick: cost lines, pay and budget scenarios in
   * KZT. Off, only dollars are offered and a write in tenge is refused. What
   * is stored in tenge already, and the conversion at the stored rate, stay.
   * Tenge is offered only while a company the OS is run for keeps its money
   * in it (its `currency` in convex/lib/identity.ts): never in one-company mode.
   */
  kztCurrency: false,
};

// ── This deployment's outside accounts ──────────────────────────────────────
// Placeholders: put your own in as you connect each one.

/**
 * How the bank names the subsidiary as a payment's counterparty, matched in
 * any capitals inside the name (`isSubsidiaryCounterparty` in
 * convex/lib/company.ts; with `subsidiaryFunding` only).
 */
export const SUBSIDIARY_COUNTERPARTY = "example subsidiary";

/** The repository bots' requests for a fix are filed in, as GitHub issues (convex/lib/devRequests.ts). */
export const DEV_REPO = "your-org/your-os";

/**
 * The GitHub organisations `pnpm gather:github` reads, each with the company
 * its repositories default to (scripts/githubRepos.ts), the name prefixes
 * that place a repository whatever its organisation, and the repositories
 * never counted. None until you add yours.
 */
export const GITHUB_ORGS: readonly { login: string; company: "us" | "kz" }[] = [];
export const GITHUB_NAME_RULES: readonly { company: "us" | "kz"; prefixes: readonly string[] }[] = [];
export const GITHUB_IGNORED: readonly string[] = [];

/**
 * The Linear workspace's teams, by the start of their name, and the company
 * each works for (convex/lib/company.ts). A team with any other name works
 * for both. None until you add yours.
 */
export const LINEAR_TEAM_PREFIXES: readonly { prefix: string; company: "us" | "kz" }[] = [];

/**
 * The second company's app in PostHog (convex/connectors/posthogGlobexQueries.ts)
 * and in its support chats (convex/lib/support.ts): the host its customers
 * use, its staging host, the team's own email domain and the cohort of the
 * team's test accounts, all left out of every figure but the first. With
 * `kzProduct` and `supportInbox` only.
 */
export const KZ_APP_HOST = "app.second-company.example.com";
export const KZ_STAGING_HOST = "staging.second-company.example.com";
export const TEAM_EMAIL_DOMAIN = "example.com";

/**
 * The second company's app in PostHog, as convex/connectors/posthogGlobexQueries.ts
 * reads it (with `kzProduct` only):
 * - `KZ_APP_UTC_OFFSET_HOURS`: the clock its users work by, in hours ahead of
 *   UTC, for the failures' hour heat map (every other figure is in UTC weeks);
 * - `KZ_TEST_HOST_WORDS`: words of the test and preview hosts left out of
 *   every figure, beside the staging host above;
 * - `KZ_FAILURE_WORDS`: the words in an error's message that name its cause,
 *   by the cause's id (`KZ_FAILURE_CAUSES` in convex/lib/kzProductDetail.ts),
 *   the first found in that order winning; read with `position()`, never kept;
 * - `KZ_EXPECTED_MODELS`: the model each cost event is expected from, so a
 *   call by any other is counted as off the list. None, nothing is.
 * No value may hold a quote or a backslash: each is put in a query as it is.
 */
export const KZ_APP_UTC_OFFSET_HOURS: number = 0;
export const KZ_TEST_HOST_WORDS: readonly string[] = ["preview.example.com"];
export const KZ_FAILURE_WORDS: Readonly<Record<string, readonly string[]>> = {
  gemini_timeout: ["timed out"],
  empty_answer: ["empty answer"],
  schema: ["validation failed"],
  file_type: ["unsupported file type"],
  pdf_instead: ["%PDF"],
  html_instead: ["DOCTYPE"],
  scan_unreadable: ["could not read the scan"],
  required_fields: ["required field"],
  network: ["Failed to fetch", "Load failed"],
  unauthorized: ["Unauthorized"],
  upstream: ["upstream"],
};
/** Placeholder: put your app's cost events and the model each should come from. */
export const KZ_EXPECTED_MODELS: Readonly<Record<string, string>> = {};

/**
 * The companies' own mail domains (and every subdomain of them): an address
 * there is a teammate's, never a contact, so a contacts push from mail or
 * meetings leaves it out (convex/lib/contactPush.ts).
 */
export const OWN_EMAIL_DOMAINS: readonly string[] = ["example.com"];
export const POSTHOG_TEST_COHORT = 0;

/** The second company's Intercom workspace, as its inbox's address names it (`pnpm support:envelope`). */
export const INTERCOM_APP_ID = "exampleapp";

/**
 * A self-hosted GPU the OS's own agents may run on (provider `astana_gpu`;
 * the address the code calls and its key stay in OPEN_MODELS_BASE_URL and
 * OPEN_MODELS_API_KEY): what it is called, and the models it serves. Unused
 * until those two are set.
 */
export const GPU = {
  label: "Self-hosted GPU",
  models: ["example/open-model-a", "example/open-model-b"],
} as const;

/** A financial model to link from Finance; empty, no link is shown. */
export const FINANCIAL_MODEL_URL: string = "";
