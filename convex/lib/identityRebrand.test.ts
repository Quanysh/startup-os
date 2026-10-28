import { describe, expect, test, vi } from "vitest";

// A fork's identity, made up: changing convex/lib/identity.ts alone must
// rebrand every word below. Whatever the real identity is (this deployment's,
// or the public template's), none of its names may be left. The original
// company's own products (convex/lib/features.ts: `verticalStartupAgents`,
// `startupInsights`) are switched off here so their words go with them; the second
// company stays on, so its words are read too.
vi.mock("./identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("./identity")>();
  const PRODUCT = { ...real.PRODUCT, name: "Zenith OS", description: "Zenith's internal operating system", slug: "zenith-os" };
  return {
    ...real,
    PRODUCT,
    PAGE_TITLE: { template: `%s · ${PRODUCT.name}`, default: PRODUCT.name },
    HEADERS: Object.fromEntries(
      Object.entries(real.HEADERS).map(([key, header]) => [key, header.replace(real.HEADER_PREFIX, "X-Zenith")]),
    ),
    COMPANY_IDENTITY: {
      us: { ...real.COMPANY_IDENTITY.us, name: "Zenith", legalName: "Zenith Inc", hashtags: ["zenith"] },
      kz: { ...real.COMPANY_IDENTITY.kz, name: "Nova Labs", legalName: "Nova Labs LLP", hashtags: ["nova", "novalabs"] },
    },
  };
});
vi.mock("./features", async (importOriginal) => {
  const real = await importOriginal<typeof import("./features")>();
  const { MADE_UP_DEPLOYMENT, allSwitchesOn } = await import("./deployment.kit");
  return {
    ...real,
    ...MADE_UP_DEPLOYMENT,
    FEATURES: { ...allSwitchesOn(real.FEATURES), verticalStartupAgents: false, startupInsights: false },
    DEV_REPO: "Zenith-Inc/zenith-os",
  };
});

/** The real identity, which the made-up one replaces. */
const real = await vi.importActual<typeof import("./identity")>("./identity");

const { parseRequest, HELP_REPLY, REPLIES, untaggedRefusal, firstTaskLine } = await import("./telegramCommand");
const { TEST_MESSAGE } = await import("./telegramMessage");
const { HANDOFF_REPAIR_BY } = await import("./handoffs");
const { seedGoals, SEED_TASKS, SEED_NOTIFICATIONS } = await import("./devSeedData");
const { SEED_MEETINGS, SEED_DECISIONS } = await import("./devSeedMemory");
const { SEED_LINKEDIN } = await import("./devSeedLinkedin");
const { BOT_WORDS } = await import("./botRules");
const { OS_AGENT_WORDS, RUNS_ON_WORDS, RUNS_ON_LINES, MAC_TOOLS_LINE } = await import("./osAgents");
const { RUNTIME_ACTION_WORDS, STARTUP_OS_WORDS } = await import("./agentStartupOs");
const { PROJECT_WORDS } = await import("./agentProjects");
const { OAUTH_WORDS, CONSENT_WORDS } = await import("./oauthRules");
const { BUILDER_WORDS } = await import("./agentBuilder");
const { DEV_REQUEST_WORDS, parseDecision } = await import("./devRequests");
const { DECIDE_WORDS, PROPOSAL_WORDS } = await import("./agents");
const { connectPrompt } = await import("./connectPrompt");
const { TOOLS, describeTool, NO_CALLER } = await import("./mcpTools");
const { serverInstructions } = await import("./mcpProtocol");

/** Every string in a value, however deep. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

/**
 * The real identity's own names: each word of the product's and the
 * companies' names and legal names, but the legal forms and the short tag.
 */
const REAL_NAMES = [
  real.PRODUCT.name,
  ...Object.values(real.COMPANY_IDENTITY).flatMap((company) => [company.name, company.legalName]),
]
  .flatMap((name) => name.split(/[\s«»"]+/))
  .filter((word) => word.length >= 3 && !["Corp", "Inc", "LLP", "ТОО", "TOO", real.PRODUCT.shortName].includes(word));

/** What still names the real product or companies. */
const leaks = (value: unknown) =>
  strings(value).filter((text) => REAL_NAMES.some((name) => text.toLowerCase().includes(name.toLowerCase())));

const task = (text: string) => parseRequest({ text, entities: [], caption: false }, undefined);

describe("Telegram's board hashtags are the identity's", () => {
  test.each([
    ["#zenith", "us"],
    ["#nova", "kz"],
    ["#NovaLabs", "kz"],
    ["#us", "us"],
    ["#kz", "kz"],
    ["#both", "both"],
  ])("%s names the board %s", (tag, board) => {
    expect(task(`/task ${tag} call back`)).toEqual({ kind: "task", board, title: "call back" });
  });

  test("the real companies' hashtags are no board's: they stay in the title", () => {
    const tags = `#${real.COMPANY_IDENTITY.us.hashtags[0]} #${real.COMPANY_IDENTITY.kz.hashtags[0]}`;
    expect(task(`/task ${tags} call back`)).toEqual({ kind: "task", title: `${tags} call back` });
  });

  test("the help and the refusals show the identity's hashtags and names", () => {
    const help = HELP_REPLY("zenithbot");
    expect(help).toContain("Add a task to the Zenith OS board");
    expect(help).toContain("<code>#zenith</code>, <code>#nova</code> or <code>#both</code>");
    expect(help).toContain("@zenithbot @username #nova Title of the task");
    expect(REPLIES.oneBoard).toBe("Name one board: #zenith, #nova or #both. Nothing was added.");
    expect(REPLIES.strangers).toBe("Only teammates in Zenith OS can add tasks here.");
    expect(untaggedRefusal("kz", "us")).toBe(
      "With no hashtag a task from this group goes to Nova Labs's board, which you are not on. Add <code>#zenith</code> to put it on Zenith's. Nothing was added.",
    );
    expect(firstTaskLine("fakeone")).toContain("in Zenith OS.");
    expect(TEST_MESSAGE).toBe("Zenith OS is connected to this group.");
    expect(leaks([help, REPLIES, untaggedRefusal("us", "kz")])).toEqual([]);
  });
});

describe("what was written out now reads the identity", () => {
  test("a handoff repair signs as the product", () => {
    expect(HANDOFF_REPAIR_BY).toBe("zenith-os");
  });

  test("a fix's pull request is read in the repository features.ts names", () => {
    const fix = (link: string) => parseDecision(`<!-- claude-decision: fix -->\nA made-up fix: ${link}`)?.prNumber;
    expect(fix("https://github.com/Zenith-Inc/zenith-os/pull/77")).toBe(77);
    expect(fix("https://github.com/Made-Up-Org/made-up-os/pull/77")).toBeNull();
    expect(fix("https://github.com/Zenith-Inc/zenith-osx/pull/77")).toBeNull();
  });

  test("the dev seed names the second company as the identity does", () => {
    const now = Date.parse("2026-10-13T11:00:00Z");
    expect(seedGoals(now).map((goal) => goal.title)).toContain("Example: first three Nova Labs renewals");
    expect(leaks([seedGoals(now), SEED_TASKS, SEED_NOTIFICATIONS, SEED_MEETINGS, SEED_DECISIONS, SEED_LINKEDIN])).toEqual(
      [],
    );
  });

  test("the words the agents, bots and clients are given", () => {
    expect(
      leaks([
        BOT_WORDS,
        OS_AGENT_WORDS,
        RUNS_ON_WORDS,
        RUNS_ON_LINES,
        MAC_TOOLS_LINE,
        RUNTIME_ACTION_WORDS,
        STARTUP_OS_WORDS,
        PROJECT_WORDS,
        OAUTH_WORDS,
        CONSENT_WORDS,
        BUILDER_WORDS,
        DEV_REQUEST_WORDS,
        DECIDE_WORDS,
        PROPOSAL_WORDS,
        NO_CALLER,
        serverInstructions(),
      ]),
    ).toEqual([]);
    expect(OS_AGENT_WORDS.reserved).toBe("That id is one of Zenith OS's own four agents.");
  });

  test("the Today prompt", () => {
    const prompt = connectPrompt({
      ingestUrl: "https://made-up-deployment-123.convex.site/ingest/v1",
      token: null,
      email: "me@example.test",
      today: "2026-10-13",
    });
    expect(prompt).toContain('my "Today" page in Zenith OS');
    expect(leaks(prompt)).toEqual([]);
  });

  test("every MCP tool, as tools/list gives it", () => {
    expect(leaks(TOOLS.map((tool) => describeTool(tool)))).toEqual([]);
  });
});
