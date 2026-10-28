// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// What the agent's tools can reach is what their file imports. The registry
// (convex/lib/mcpTools.ts) and the endpoint that runs it (convex/mcp.ts) may
// import only the modules named here: a tool that needs another is a
// decision, made by adding a line with its reason. Payroll, tokens, team
// management, source settings and runs, personal rows, notifications and the
// Telegram settings are in neither list, and the second test names them.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Every module a file imports, from its `import … from "…"` lines. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!).sort();
}

const TOOLS_MAY_IMPORT = [
  "../_generated/dataModel", // types
  "../_generated/server", // types
  "../agentControl", // agentsFor: Vertical Startup's agents as the Agents page reads them; the tool keeps totals only
  "../budget", // budgetReportFor: plan vs actual, plan vs run-rate, scenarios' run-out months; reads no payroll table
  "../comments", // commentsFor, addComment: comments on a task, a deal or a handoff, the page's own functions
  "../contacts", // contactsPage, introPathsFor, upsertContact, linkContact, mergeContacts: the page's own functions
  "../costs", // costSummaryFor, costLinesFor: planned burn; the tool drops each line's note and paid-by
  "../customers", // customersFor: the clinic list the page reads; setCustomerOwnerFields: the owner's note and next touch, the page's own function
  "../dealIntel", // agentIntelFor: a US deal's intelligence, cut short, through the function dealIntel.list calls
  "../deals", // dealBoardFor, updateDeal
  "../devRequests", // fileDevRequest, devRequestsSince: a bot's own request for a fix and its answers; the issue is filed by an action, never by the tool
  "../decisions", // decisionsFor: company memory, text cut in the tool
  "../evidence", // the questionnaire, answer-bank, agreement and evidence reads and upserts: the page's own functions
  "../goals", // goalsFor
  "../handoffs", // handoffRows, createHandoff, answerHandoff, reassignHandoff: bots' coordination records; the tools attribute each write to the calling bot
  "../investors", // investorBoardFor, updateInvestor, addInvestor: the board's own edit and add, a mirrored investor's source fields refused
  "../linkedin", // postsFor, savePost, addStats: the LinkedIn calendar, the page's own functions; nothing is sent to LinkedIn
  "../meetingNotes", // meetingsFor: the company's notes, no attendee; never the owner's Fireflies rows
  "../metrics", // scorecardFor
  "../notes", // notesFor, createNote: a note that is not a meeting's, the page's own functions
  "../obligations", // obligationsFor
  "../outcomes", // logOutcome, outcomeRows: what came of a bot's play, attributed to the calling bot; evidence holds no address or number
  "../partnerships", // partnerBoardFor, partnersFor, upsertPartner, movePartner: the page's own functions
  "../sources", // sourcesFor: cut to state and run times in the tool
  "../support", // supportFor: Globex's inbox as the Support page reads it; the tool sends counts and waits
  "../tasks", // boardFor, createTask, updateTask, moveTask, archiveTask
  "../workTools", // pullRequestsFor, repositoriesFor: GitHub's shared lists only
  "./agentRules",
  "./agentStore", // requireAgentOn: a switched-off agent adds no task
  "./agents", // the closed sets, the limits and the fixed words
  "./botRules", // memberAsBot: a bot is sent what its own areas open (metrics, goals, budget); levelOf (people)
  "./botTelemetry", // botRegistry: the owner's bots and their week for `agents`, from the bots' daily rollup; counts only
  "./botStore", // botNamed: whether a bot may give tasks, so is told addresses (people)
  "./duplicates", // the near-duplicate check a creating tool makes before it writes (Bot Loop v3): open titles compared, never returned beyond the top three
  "./botRuleVersions", // rulesForBot: the owner's published rules for the bots, for `bot_rules`
  "./briefs", // writeBrief, latestBrief
  "./chat", // the chat runner's three tools, and the answer a proposal goes under
  "./chatRules", // the chat's limits and closed sets: pure
  "./comments", // comment subjects, the area a comment needs, and the fixed sentences: pure
  "./attention/dates",
  "./attention/overview",
  "./company",
  "./contacts", // categories, limits and the fixed words of business contacts: pure
  "./costs", // monthlyEquivalent: pure arithmetic, no table
  "./customerRules", // CUSTOMER_WORDS: a clinic edit's fixed refusals, naming no clinic. Pure
  "./devRequests", // a bot's request for a fix: its limits and closed sets. Pure
  "./dealDetails", // looksLikeContactDetail: an email address or phone number in an investor's contact or a clinic's note is refused. Pure
  "./handoffs", // names, limits and the receiving-bot rule: pure
  "./evidence", // the closed sets and pure rules: expiry, coverage
  "./featureGates", // toolOn, withFeatures: the tools and the words a switched-off feature takes away. Pure
  "./features", // GPU: the self-hosted GPU's label, an outside id of this deployment. Pure
  "./identity", // PRODUCT: the product's name in the tools' descriptions. Pure constants
  "./limits",
  "./linkedin", // the closed sets, limits and fixed words: pure
  "./mcpBound",
  "./memory", // agentCut and the limits: pure
  "./metricRegistry",
  "./notify", // a type
  "./outcomes", // the closed sets, limits and fixed words of outcomes: pure
  "./osAgentRuns", // the runner's two tools for the four agents: which are due, and how a run ended
  "./osAgents", // MAC_RUN_ID: a run's id as the runner sends it back. Pure
  "./owner", // a type, and isOwner: the bots in `agents` are the owner's alone
  "./partnerFields", // the refusals' sentences: pure
  "./partnerStages", // the stages and types and the closed sets: pure
  "./pipelineCards", // INVESTOR_TOOL_WORDS: investor_update's fixed refusals
  "./pipelineStages", // INVESTOR_STAGES: the stages investor_update takes. Pure
  "./proposalSweep", // sweepProposals: withdraws duplicate and superseded open proposals and logs the reason, no title
  "./proposals", // propose, openProposals, feedback, the sweep's withdraw, and proposal_decide, which carries one out through approveProposal and dismiss
  "./taskOrigin", // agentTaskOrigin: the bot id stamped on a card the caller made. Pure of tables
  "./quarter",
  "./runway", // a type
  "./supportMetrics", // supportFigures: the Support page's figures, pure
  "./teamDirectory", // assignablePeople: a name and an address
  "./whoami", // whoamiFor: who the caller is taken for, its permissions, limits left and the rules; reads its own client's rows
  "convex/values",
  "zod",
].sort();

const ENDPOINT_MAY_IMPORT = [
  "./_generated/api",
  "./_generated/server",
  "./lib/agentRules",
  "./lib/agentToken",
  "./lib/agents", // isAgentId: which agent a call says it is, for the audit row
  "./lib/botRules", // the shape of a bot's id, which tools a bot may be listed, and the words of a refusal: pure
  "./lib/duplicates", // which tools a refused near-duplicate check's log line may name: a closed set
  "./lib/mcpBound",
  "./lib/mcpProtocol",
  "./lib/mcpTools",
  "./lib/oauthRules", // what an OAuth access token begins with, and where a 401 says to sign in: pure
  "./lib/osAgents", // the runner's two headers and the words of a refusal: pure
  "./lib/owner",
  "./lib/personalRules", // hashToken
  "convex/values",
].sort();

const NEVER_REACHED =
  /payroll|connect|personal(?!Rules)|team(?!Directory)|telegram|notifications|google|mirror|roles|authOwner|devSeed|devSession|snapshots|targets|suggestions|standup|ingest|reviews|plan/i;

describe("what the agent's tools can reach", () => {
  test("the registry imports exactly these modules", () => {
    expect(importsOf(read("./lib/mcpTools.ts"))).toEqual(TOOLS_MAY_IMPORT);
  });

  test("the endpoint imports exactly these modules", () => {
    expect(importsOf(read("./mcp.ts"))).toEqual(ENDPOINT_MAY_IMPORT);
  });

  test("none of them is a module of what is never exposed", () => {
    for (const path of [...TOOLS_MAY_IMPORT, ...ENDPOINT_MAY_IMPORT]) {
      expect(path, path).not.toMatch(NEVER_REACHED);
    }
    // Guards the pattern: it must catch the modules it is there for.
    for (const path of [
      "../payroll",
      "./lib/payroll",
      "../connect",
      "./personal",
      "../team",
      "../telegram",
      "../notifications",
      "../google",
      "../mirror",
      "../roles",
    ]) {
      expect(path, path).toMatch(NEVER_REACHED);
    }
    // And must not catch what is allowed for a stated reason.
    expect("./teamDirectory").not.toMatch(NEVER_REACHED);
    expect("./lib/personalRules").not.toMatch(NEVER_REACHED);
  });

  test("no tool reads a table itself: every read and write goes through the app's own function", () => {
    const source = read("./lib/mcpTools.ts");
    expect(source).not.toMatch(/ctx\.db\.(query|get|insert|patch|replace|delete)\(/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/Date\.now\(\)/);
  });

  test("nothing on the way logs", () => {
    for (const path of [
      "./mcp.ts",
      "./assistant.ts",
      "./oauth.ts",
      "./lib/mcpTools.ts",
      "./lib/agentToken.ts",
      "./lib/mcpBound.ts",
      "./lib/mcpProtocol.ts",
      "./lib/oauthRules.ts",
      "./lib/oauthStore.ts",
    ]) {
      expect(read(path), path).not.toMatch(/console\./);
    }
  });

  test("a read never reads the clock: the endpoint does, and hands it in", () => {
    const endpoint = read("./mcp.ts");
    const handlers = endpoint.slice(endpoint.indexOf("async function runTool"));
    expect(handlers).not.toMatch(/Date\.now\(\)/);
  });
});
