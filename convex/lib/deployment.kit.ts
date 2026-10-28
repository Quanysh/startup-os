// The made-up deployment every test runs as (convex/test.deployment.ts, in
// vitest's `setupFiles`): every switch of convex/lib/features.ts on, and
// made-up outside ids in place of the deployment's own. So the suite tests
// the code of every feature, and no test depends on the real ids: the same
// suite passes in main and in the public template, whatever either's
// features.ts says. What a deployment's values actually are is pinned in
// convex/lib/deployment.test.ts, the one test that reads them.
//
// A test that mocks convex/lib/features.ts itself (to turn a switch off)
// spreads these ids into its own factory, so it runs as the same deployment.
//
// Every value is made up. Test-only: never imported by app or Convex code
// (two dots in the name, so Convex does not bundle it).

export const MADE_UP_DEPLOYMENT = {
  SUBSIDIARY_COUNTERPARTY: "northwind",
  DEV_REPO: "Made-Up-Org/made-up-os",
  GITHUB_ORGS: [
    { login: "Made-Up-Org", company: "us" },
    { login: "Second-Org", company: "kz" },
  ],
  GITHUB_NAME_RULES: [
    { company: "kz", prefixes: ["second", "radio", "pacs"] },
    { company: "us", prefixes: ["first", "vertical"] },
  ],
  GITHUB_IGNORED: ["demo-repository", "sample-intros"],
  LINEAR_TEAM_PREFIXES: [
    { prefix: "second", company: "kz" },
    { prefix: "first", company: "us" },
  ],
  KZ_APP_HOST: "app.second.example.test",
  KZ_STAGING_HOST: "staging.second.example.test",
  TEAM_EMAIL_DOMAIN: "team.example.test",
  KZ_APP_UTC_OFFSET_HOURS: 3,
  KZ_TEST_HOST_WORDS: ["preview.second.example.test", "made-up-sandbox"],
  KZ_FAILURE_WORDS: {
    gemini_timeout: ["made-up timeout"],
    empty_answer: ["made-up empty"],
    schema: ["made-up schema"],
    file_type: ["made-up file type"],
    pdf_instead: ["%PDF"],
    html_instead: ["DOCTYPE"],
    scan_unreadable: ["made-up scan"],
    required_fields: ["made-up required"],
    network: ["Failed to fetch", "Load failed"],
    unauthorized: ["Unauthorized"],
    upstream: ["upstream"],
  },
  KZ_EXPECTED_MODELS: {
    intake_check_cost: "made-up/model-a",
    ask_search_cost: "made-up/model-b",
  },
  OWN_EMAIL_DOMAINS: ["team.example.test", "second.example.test"],
  POSTHOG_TEST_COHORT: 12345,
  INTERCOM_APP_ID: "abcd1234",
  GPU: { label: "Made-up GPU", models: ["made-up/model-a", "made-up/model-b"] },
  FINANCIAL_MODEL_URL: "https://financial-model.example.test/",
} as const;

/** Every switch on: a test turns one off itself. */
export const allSwitchesOn = <T extends Record<string, boolean>>(features: T): T =>
  Object.fromEntries(Object.keys(features).map((feature) => [feature, true])) as T;
