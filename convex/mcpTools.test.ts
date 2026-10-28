import { convexTest } from "convex-test";
import { BOT_OWN_TOOLS } from "./lib/botRules";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { SOURCES, ingestTokenEnv, missingEnv } from "./connectors/manifest";
import { AGENT_WORDS } from "./lib/agentRules";
import { overviewItems } from "./lib/attention/overview";
import { SEED_AGENT_CALLS } from "./lib/devSeedData";
import { categoryServes, sourcesOf, tilesOf } from "./lib/company";
import {
  DEAL_GONE,
  METRIC_SERIES_POINTS,
  NOT_A_QUARTER,
  SOURCE_FAILURE_DETAIL,
  TODAY_TOO_FAR,
  TOOLS,
  describeTool,
} from "./lib/mcpTools";
import { hashToken } from "./lib/personalRules";
import { supportFigures } from "./lib/supportMetrics";
import {
  BOT_TOKEN,
  ENTROPY,
  GITHUB_TOKEN,
  NEVER,
  NOW,
  SAM,
  TODAY,
  addSam,
  answer,
  call,
  ownerWithToken,
  pushGithub,
  seed,
} from "./mcp.kit";
import schema from "./schema";
import { CANNOT_ASSIGN, TASK_GONE } from "./tasks";
import { OWNER, modules, signInAsMember, type TestBackend } from "./test.setup";
import { finishScheduled } from "./test.timers";

// What the owner's Claude is told and may do: each read tool against the
// app's own query for the same data, the act tools against what a person's
// own action does, and what no tool returns.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_GITHUB", GITHUB_TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world(scope: "read" | "act" = "read") {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await pushGithub(t);
  const { owner, token } = await ownerWithToken(t, scope);
  return { t, ids, owner, token };
}

/** An answer without its `truncated` flag, having said it was whole. */
function whole(output: Record<string, unknown> & { truncated: boolean }) {
  const { truncated, ...rest } = output;
  expect(truncated).toBe(false);
  return rest;
}

/** What a Convex query returns, as JSON carries it (an absent field stays absent). */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// The registry, pinned. A new tool fails here until it is named, and reading
// this list is how to see at a glance what the owner's agent can do.
const READS = [
  // About the caller itself: every caller's, on no area, at no limit's cost (convex/botAddress.test.ts).
  "whoami",
  "bot_rules",
  "overview",
  "metrics",
  "tasks",
  "deals",
  "investors",
  // The partnerships pipeline (convex/partnerships.ts).
  "partners",
  // Business contacts (convex/contacts.ts).
  "contacts",
  "contact_intro_paths",
  "customers",
  "pull_requests",
  "repositories",
  "obligations",
  "compliance_evidence",
  "sources",
  // Globex's Intercom inbox (convex/support.ts): counts and waits only.
  "support",
  "people",
  "goals",
  "costs",
  // Company memory (convex/decisions.ts, convex/meetingNotes.ts).
  "decisions",
  "meetings",
  "notes",
  // The LinkedIn content calendar (convex/linkedin.ts).
  "linkedin_posts",
  "budget",
  // Bot-to-bot handoffs (convex/handoffs.ts).
  "handoffs",
  // Comments on a task, a deal or a handoff (convex/comments.ts).
  "comments",
  // Vertical Startup's AI agents (convex/agentControl.ts): totals only.
  "agents",
  "brief_latest",
  "proposals_open",
  "proposals_feedback",
  // A bot's own inbox (convex/botRefusals.test.ts): it refuses any caller that is not a bot.
  "my_inbox",
  // What came of a play (Bot Loop v3).
  "outcomes",
];
const ACTS = [
  "task_create",
  "task_update",
  "task_move",
  "deal_update",
  "investor_update",
  "investor_create",
  "customer_update",
  "partner_upsert",
  "partner_move",
  "contact_upsert",
  "contact_link",
  "contact_merge",
  "note_create",
  "decision_create",
  "handoff_create",
  "handoff_update",
  "questionnaire_upsert",
  "answer_bank_upsert",
  "vendor_agreement_upsert",
  "evidence_upsert",
  "linkedin_post_upsert",
  "linkedin_stats_add",
  "brief_write",
  "propose",
  // They only propose (a goal is the owner's plan): convex/approvals.test.ts.
  "goal_create",
  "goal_update",
  // A proposer takes back its own open proposals (convex/proposalWithdraw.test.ts).
  "proposal_withdraw",
  "note_write",
  "comment_create",
  "task_archive",
  "handoff_reassign",
  // Clears duplicate and superseded open proposals (convex/lib/proposalSweep.ts).
  "proposal_sweep",
  // The chief of staff approves or dismisses, as the buttons do (convex/proposalDecide.test.ts).
  "proposal_decide",
  // A bot asks the owner for a permission (convex/botRefusals.test.ts): a `bot_permission` proposal.
  "permission_request",
  // A bot asks for a fix (convex/devRequests.test.ts): stored, filed as a GitHub issue, answered in my_inbox.
  "dev_request",
  "outcome_log",
  // The runner program's own (convex/chat.test.ts, convex/osAgentsMcp.test.ts): never a model's.
  "chat_next",
  "chat_progress",
  "chat_finish",
  "os_agents_due",
  "os_agent_start",
  "os_agent_finish",
];

describe("the registry", () => {
  test("is exactly these tools, reads first", () => {
    expect(TOOLS.filter((tool) => tool.kind === "read").map((tool) => tool.name)).toEqual(READS);
    expect(TOOLS.filter((tool) => tool.kind === "act").map((tool) => tool.name)).toEqual(ACTS);
    expect(TOOLS.map((tool) => tool.name)).toEqual([...READS, ...ACTS]);
  });

  test("the calls the local seed shows are of tools that exist, each with its own kind", () => {
    for (const row of SEED_AGENT_CALLS) {
      expect([row.tool, TOOLS.find((tool) => tool.name === row.tool)?.kind]).toEqual([row.tool, row.kind]);
    }
  });

  test("no tool is named for what is never exposed", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]{1,39}$/);
      // The one exception, by name: `meetings` is the company's meeting notes
      // on /memory (convex/meetingNotes.ts), never the owner's own Fireflies
      // rows, which no tool reads ("what no tool returns" seeds one).
      if (tool.name === "meetings") continue;
      expect(tool.name).not.toMatch(
        /payroll|salary|token|secret|env|team|member|role|area|notification|telegram|mail|calendar|meeting|run|setting/,
      );
    }
  });

  test("every tool has caps, and every read takes an optional company", () => {
    for (const tool of TOOLS) {
      expect(tool.caps.rows).toBeGreaterThan(0);
      expect(tool.caps.bytes).toBeGreaterThan(0);
      // Under what one Convex function may return, with room to spare.
      expect(tool.caps.bytes).toBeLessThanOrEqual(200_000);
      if (tool.kind !== "read") continue;
      expect(tool.input.safeParse({}).success).toBe(true);
      expect(tool.input.safeParse({ company: "us" }).success).toBe(true);
      expect(tool.input.safeParse({ company: "kz" }).success).toBe(true);
      expect(tool.input.safeParse({ company: "fr" }).success).toBe(false);
      expect(tool.input.safeParse({ company: "us", extra: 1 }).success).toBe(false);
    }
  });
});

describe("each read tool returns what the app's own query does", () => {
  test("tasks: the board, and with a company that company's cards and the shared ones", async () => {
    const { t, owner, token } = await world();
    const board = asJson(await owner.query(api.tasks.board, {}));
    expect(whole(await answer(t, token, "tasks"))).toEqual(board);
    expect(board.backlog.map((card) => card.title).sort()).toEqual([
      "Example kz task",
      "Example shared task",
      "Example us task",
    ]);

    const us = whole(await answer(t, token, "tasks", { company: "us" }));
    expect((us.backlog as { title: string }[]).map((card) => card.title).sort()).toEqual([
      "Example shared task",
      "Example us task",
    ]);
    expect(us.backlog).toEqual(board.backlog.filter((card) => card.company !== "kz"));
  });

  test("deals: each market's board, and one market by `market` or `company`", async () => {
    const { t, owner, token } = await world();
    const us = asJson(await owner.query(api.deals.board, { market: "us" }));
    const kz = asJson(await owner.query(api.deals.board, { market: "kz" }));
    expect(whole(await answer(t, token, "deals"))).toEqual({ us, kz });
    expect(whole(await answer(t, token, "deals", { market: "kz" }))).toEqual({ kz });
    expect(whole(await answer(t, token, "deals", { company: "us" }))).toEqual({ us });
    expect(us.qualified.map((deal) => deal.name)).toEqual(["Example US Deal"]);
    expect(kz.qualified[0]).toMatchObject({ name: "Example KZ Deal", mirrored: true });
  });

  test("deals: a US deal made here carries its details; a mirrored one none", async () => {
    const { t, ids, token } = await world();
    await t.run((ctx) =>
      ctx.db.patch(ids.usDeal, {
        priority: "high",
        region: "TX",
        physicians: 59,
        locations: 29,
        sources: ["Made-up market scan"],
      }),
    );
    const answered = whole(await answer(t, token, "deals"));
    const us = answered.us as Record<string, Record<string, unknown>[]>;
    const kz = answered.kz as Record<string, Record<string, unknown>[]>;
    expect(us.qualified![0]).toMatchObject({
      priority: "high",
      region: "TX",
      physicians: 59,
      locations: 29,
      sources: ["Made-up market scan"],
    });
    expect(kz.qualified![0]).not.toHaveProperty("priority");
    expect(kz.qualified![0]).not.toHaveProperty("sources");
  });

  test("deals: a US deal with research carries its intelligence, cut short; no other deal does", async () => {
    const { t, ids, owner, token } = await world();
    const stored = {
      summary: "s".repeat(600),
      ownership: "Physician-owned",
      ehr: "athenahealth",
      billingModel: "outsourced" as const,
      signals: [
        { date: "2026-01", kind: "news" as const, text: "Made-up oldest", source: "Made-up" },
        { date: "2026-09-01", kind: "hiring" as const, text: "Made-up newest", source: "SECRET source" },
        { kind: "growth" as const, text: "Made-up undated", source: "Made-up" },
        { date: "2026-05", kind: "funding" as const, text: "Made-up middle", source: "Made-up" },
      ],
      people: [{ name: "SECRET Person", role: "Managing partner" }],
      competitors: [{ name: "Made-up RCM" }],
      angle: "Made-up angle",
      nextBestAction: "Made-up action",
      fit: { score: 82, reasons: ["Made-up reason"] },
      sources: [{ title: "Made-up scan", url: "https://claude.ai/artifact/made-up-1" }],
      updatedAt: 1,
    };
    await t.run((ctx) => ctx.db.insert("dealIntel", { dealId: ids.usDeal, ...stored }));
    // A row that should never exist is never sent: a Kazakhstan deal's.
    await t.run((ctx) => ctx.db.insert("dealIntel", { dealId: ids.kzDeal, ehr: "SECRET kz", updatedAt: 1 }));
    const answered = whole(await answer(t, token, "deals"));
    const us = answered.us as Record<string, Record<string, unknown>[]>;
    const kz = answered.kz as Record<string, Record<string, unknown>[]>;
    expect(us.qualified![0]!.intel).toEqual({
      summary: `${"s".repeat(299)}\u2026`,
      fit: 82,
      ehr: "athenahealth",
      billingModel: "outsourced",
      ownership: "Physician-owned",
      signals: [
        { date: "2026-09-01", kind: "hiring", text: "Made-up newest" },
        { date: "2026-05", kind: "funding", text: "Made-up middle" },
        { date: "2026-01", kind: "news", text: "Made-up oldest" },
      ],
      angle: "Made-up angle",
      nextBestAction: "Made-up action",
    });
    expect(JSON.stringify(answered)).not.toMatch(/SECRET/);
    expect(kz.qualified![0]).not.toHaveProperty("intel");
    // Otherwise the deal is exactly what the board sends.
    const { intel: _intel, ...rest } = us.qualified![0]!;
    expect(rest).toEqual(asJson((await owner.query(api.deals.board, { market: "us" })).qualified[0]));
  });

  test("deals: a full US pipeline with every detail stays within the tool's caps", async () => {
    const { t, token } = await world();
    const { caps } = TOOLS.find((tool) => tool.name === "deals")!;
    await t.run(async (ctx) => {
      for (let n = 0; n < 250; n++) {
        const id = await ctx.db.insert("deals", {
          source: "manual",
          externalId: `made-up-${n}`,
          market: "us",
          name: `Made-up Vertical ${n}`,
          stage: "lead",
          order: n + 1,
          notes: "n".repeat(1_000),
          priority: "medium",
          region: "TX",
          physicians: 12,
          locations: 3,
          sources: Array.from({ length: 12 }, (_, i) => `Made-up research title ${i}`.padEnd(120, "x")),
        });
        // And the longest intelligence an agent is sent of it.
        await ctx.db.insert("dealIntel", {
          dealId: id,
          summary: "s".repeat(600),
          ownership: "o".repeat(120),
          ehr: "e".repeat(80),
          billingModel: "hybrid",
          signals: Array.from({ length: 8 }, (_, i) => ({
            date: "2026-09-01",
            kind: "news" as const,
            text: `${i}`.padEnd(200, "t"),
            source: "x".repeat(120),
          })),
          angle: "a".repeat(300),
          nextBestAction: "n".repeat(200),
          fit: { score: 50, reasons: [] },
          updatedAt: 1,
        });
      }
    });
    const reply = await call(t, token, "deals");
    expect(reply.output.truncated).toBe(true);
    expect(new TextEncoder().encode(reply.textOutput!).length).toBeLessThanOrEqual(caps.bytes + 20);
  });

  test("support: the Support page's figures as of the last push, counts and waits only; nothing for Startup", async () => {
    const { t, owner, token } = await world();
    // Before any push: not known, never zero.
    expect(whole(await answer(t, token, "support"))).toEqual({ company: "kz", pushedAt: null, figures: null });
    const pushedAt = NOW - 60 * 60 * 1000;
    await t.run(async (ctx) => {
      const row = {
        intercomId: "901",
        createdAt: pushedAt - 10 * 60 * 60 * 1000,
        updatedAt: pushedAt - 6 * 60 * 60 * 1000,
        state: "open" as const,
        open: true,
        priority: false,
        waitingSince: pushedAt - 6 * 60 * 60 * 1000,
        origin: "customer" as const,
        pageArea: "studies",
        finParticipated: true,
        finOutcome: "escalated" as const,
        humanRepliedAt: null,
        timeToHumanReply: null,
        lastCustomerReplyAt: pushedAt - 6 * 60 * 60 * 1000,
        lastHumanReplyAt: null,
        assigneeId: "41",
        assigneeName: "SECRET Teammate",
        parts: 4,
        reopens: 0,
        rating: null,
        articles: ["Made-up article"],
        syncedAt: pushedAt,
      };
      await ctx.db.insert("supportConversations", row);
      await ctx.db.insert("supportWorkspace", { appId: "made0up1", readAt: pushedAt });
      await ctx.db.insert("sourceStatus", { source: "intercom", state: "ok", lastRunAt: pushedAt, lastOkAt: pushedAt });
    });
    const page = await owner.query(api.support.overview, {});
    const figures = supportFigures(page.rows, NOW, pushedAt);
    const answered = whole(await answer(t, token, "support"));
    expect(answered).toEqual(
      asJson({
        company: "kz",
        pushedAt,
        figures: {
          ...figures,
          waiting: [{ waitedMs: 6 * 60 * 60 * 1000, since: pushedAt - 6 * 60 * 60 * 1000, pageArea: "studies", fin: "escalated", assigned: true }],
        },
      }),
    );
    expect(JSON.stringify(answered)).not.toContain("SECRET");
    expect(JSON.stringify(answered)).not.toContain("901");
    expect(whole(await answer(t, token, "support", { company: "us" }))).toEqual({ company: "kz", pushedAt: null, figures: null });
  });

  test("investors: Startup's board, and nothing for Globex", async () => {
    const { t, owner, token } = await world();
    const board = asJson(await owner.query(api.investors.board, {}));
    expect(whole(await answer(t, token, "investors"))).toEqual({ company: "us", columns: board });
    expect(whole(await answer(t, token, "investors", { company: "us" })).columns).toEqual(board);
    expect(whole(await answer(t, token, "investors", { company: "kz" })).columns).toEqual({});
    expect(board.meeting.map((row) => row.name)).toEqual(["Example Fund"]);
  });

  test("customers: the register, by market", async () => {
    const { t, owner, token } = await world();
    const register = asJson(await owner.query(api.customers.list, {}));
    expect(whole(await answer(t, token, "customers"))).toEqual(register);
    expect(register.customers).toHaveLength(2);
    const kz = whole(await answer(t, token, "customers", { company: "kz" }));
    expect(kz).toEqual({
      lastPushAt: register.lastPushAt,
      customers: register.customers.filter((clinic) => clinic.market === "kz"),
    });
    expect(kz.customers).toHaveLength(1);
  });

  test("pull_requests and repositories: GitHub's lists, by company", async () => {
    const { t, owner, token } = await world();
    const pulls = asJson(await owner.query(api.workTools.pullRequests, {}));
    const repos = asJson(await owner.query(api.workTools.engineering, {}));
    expect(whole(await answer(t, token, "pull_requests"))).toEqual(pulls);
    expect(whole(await answer(t, token, "repositories"))).toEqual(repos);
    expect(pulls.rows).toHaveLength(2);
    expect(repos.rows).toHaveLength(2);

    const usPulls = whole(await answer(t, token, "pull_requests", { company: "us" }));
    expect(usPulls).toEqual({ readAt: pulls.readAt, rows: pulls.rows.filter((row) => row.company === "us") });
    const kzRepos = whole(await answer(t, token, "repositories", { company: "kz" }));
    expect(kzRepos.rows).toEqual(repos.rows.filter((row) => row.company === "kz"));
    expect(kzRepos.rows).toHaveLength(1);
  });

  test("agents: the Agents page's rows for today, totals only, the same for either company", async () => {
    const { t, owner, token } = await world();
    await t.run(async (ctx) => {
      await ctx.db.insert("agentUsage", {
        product: "vertical_startup",
        agentId: "made-up.select",
        promptVersion: "v1+2e092415",
        provider: "vertex",
        model: "made-up-pro",
        day: TODAY,
        calls: 10,
        errors: 1,
        schemaFailures: 0,
        fallbacks: 0,
        refusals: 0,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.5,
        p95Ms: 2000,
        syncedAt: NOW,
      });
      await ctx.db.insert("agentProviders", {
        provider: "vertex",
        model: "made-up-pro",
        state: "up",
        checkedAt: NOW,
        syncedAt: NOW,
      });
    });
    const page = asJson(await owner.query(api.agentControl.overview, { today: TODAY }));
    const told = whole(await answer(t, token, "agents"));
    expect(told).toEqual({
      today: TODAY,
      agents: [
        {
          // A row from before projects is Vertical Startup's.
          project: "vertical-startup",
          agentId: "made-up.select",
          name: null,
          enabled: null,
          primary: page.agents[0]!.primary,
          fallback: null,
          promptVersion: "v1+2e092415",
          calls7d: 10,
          errorRate7d: page.agents[0]!.errorRate7d,
          schemaFailureRate7d: 0,
          p95Ms7d: 2000,
          costTodayUsd: 0.5,
          costTodayWhy: null,
          costMonthUsd: 0.5,
          costMonthWhy: null,
          monthlyBudgetUsd: null,
          lastSeenDay: TODAY,
          waiting: false,
          pending: false,
          // Never steered: it runs the code's own harness. Its published version's id, never its text.
          harnessVersion: null,
        },
      ],
      providers: [{ project: "vertical-startup", provider: "vertex", model: "made-up-pro", state: "up", checkedAt: NOW }],
      steeringConnected: false,
      // The owner's bots: the Bots tab's own rows (none here).
      bots: asJson(await owner.query(api.bots.telemetry, { today: TODAY })),
    });
    expect(whole(await answer(t, token, "agents", { company: "kz" }))).toEqual(told);
    // Whether steering is connected, never which variable is missing.
    expect(JSON.stringify(told)).not.toMatch(/VERTICAL_|INGEST_TOKEN/);
  });

  test("obligations: the list, and a company's categories", async () => {
    const { t, owner, token } = await world();
    const rows = asJson(await owner.query(api.obligations.list, {}));
    expect(whole(await answer(t, token, "obligations"))).toEqual({ rows });
    expect(rows).toHaveLength(3);
    const kz = whole(await answer(t, token, "obligations", { company: "kz" }));
    expect(kz.rows).toEqual(rows.filter((row) => categoryServes("kz", row.category)));
    expect((kz.rows as { category: string }[]).map((row) => row.category).sort()).toEqual([
      "corporate_tax",
      "kz_data",
    ]);
  });

  test("sources: the sources page's list, cut to state and run times", async () => {
    const { t, owner, token } = await world();
    const listed = await owner.query(api.sources.list, {});
    const rows = whole(await answer(t, token, "sources")).rows as Record<string, unknown>[];
    expect(rows).toEqual(
      listed.map((source) => ({
        id: source.id,
        label: source.label,
        configured: source.configured,
        state: source.status?.state ?? "never_run",
        lastRunAt: source.status?.lastRunAt ?? null,
        lastOkAt: source.status?.lastOkAt ?? null,
      })),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["configured", "id", "label", "lastOkAt", "lastRunAt", "state"].sort(),
      );
    }
    expect(rows.find((row) => row.id === "mercury")).toMatchObject({ state: "error" });
    const kz = whole(await answer(t, token, "sources", { company: "kz" })).rows as { id: string }[];
    expect(kz.map((row) => row.id)).toContain("cfo_workbook");
    expect(kz.map((row) => row.id)).not.toContain("mercury");
  });

  test("people: who a task can be given to, as a name and an address", async () => {
    const { t, owner, token } = await world();
    await addSam(t);
    const everyone = asJson(await owner.query(api.team.assignable, {}));
    expect(whole(await answer(t, token, "people"))).toEqual({ rows: everyone });
    expect(everyone).toContainEqual({ email: SAM, name: "Sam Teammate" });
    for (const row of everyone) expect(Object.keys(row).sort()).toEqual(["email", "name"]);
    const kz = asJson(await owner.query(api.team.assignable, { company: "kz" }));
    expect(whole(await answer(t, token, "people", { company: "kz" }))).toEqual({ rows: kz });
    expect(kz.map((row) => row.email)).not.toContain(SAM);
  });

  test("goals: a quarter's goals, the current quarter unless one is named", async () => {
    const { t, owner, token } = await world();
    const rows = asJson(await owner.query(api.goals.list, { quarter: "2026-Q4" }));
    expect(whole(await answer(t, token, "goals"))).toEqual({ quarter: "2026-Q4", rows });
    expect(rows.map((goal) => goal.title)).toEqual(["Example goal"]);
    expect(whole(await answer(t, token, "goals", { quarter: "2026-Q3" }))).toEqual({
      quarter: "2026-Q3",
      rows: [],
    });
    expect((await call(t, token, "goals", { quarter: "Q4-2026" })).said).toBe(NOT_A_QUARTER);
  });

  test("costs: the summary the page reads for each company, and the lines with no note and no paid-by", async () => {
    const { t, owner, token } = await world();
    const line = {
      name: "Example Cloud",
      category: "cloud",
      amount: 300_00,
      cadence: "monthly",
      startsOn: "2026-09",
      paidBy: "NEVER COST PAYER",
      note: "NEVER COST NOTE",
    } as const;
    await owner.mutation(api.costs.add, { company: "us", ...line, variable: true });
    await owner.mutation(api.costs.add, { company: "us", ...line, name: "Example Rent", category: "office", cadence: "yearly", amount: 1_200_00 });
    await owner.mutation(api.costs.add, { company: "kz", ...line, name: "Example KZ Tool", category: "software", amount: 50_000_00 });
    const gone = await owner.mutation(api.costs.add, { company: "us", ...line, name: "Example Archived" });
    await owner.mutation(api.costs.archive, { id: gone });

    // The server's UTC month when none is named.
    const both = await call(t, token, "costs");
    const output = whole(both.output);
    const summaries = {
      us: asJson(await owner.query(api.costs.summary, { company: "us", month: "2026-10" })),
      kz: asJson(await owner.query(api.costs.summary, { company: "kz", month: "2026-10" })),
    };
    expect(output.month).toBe("2026-10");
    expect(output.summaries).toEqual([summaries.us, summaries.kz]);
    expect(summaries.us.currencies[0]).toMatchObject({ currency: "USD", runRate: 400_00, cashDue: 300_00 });
    expect([summaries.us.lines, summaries.us.estimates]).toEqual([2, 1]);

    // The lines: what is paid, how often and since when. Nothing else.
    const lines = output.lines as Record<string, unknown>[];
    expect(lines.map((row) => `${row.company}: ${row.name}`)).toEqual([
      "us: Example Cloud",
      "us: Example Rent",
      "kz: Example KZ Tool",
    ]);
    for (const row of lines) {
      expect(Object.keys(row).sort()).toEqual(
        ["amount", "cadence", "category", "company", "countsAs", "currency", "endsOn", "estimate", "monthlyEquivalent", "name", "startsOn"].sort(),
      );
    }
    expect(lines[0]).toEqual({
      company: "us",
      name: "Example Cloud",
      category: "cloud",
      amount: 300_00,
      currency: "USD",
      cadence: "monthly",
      startsOn: "2026-09",
      endsOn: null,
      estimate: true,
      monthlyEquivalent: 300_00,
      // What it counts as in unit economics: here its category's default.
      countsAs: "cogs",
    });
    expect(lines[1]).toMatchObject({ cadence: "yearly", amount: 1_200_00, monthlyEquivalent: 100_00, countsAs: "operating" });
    // No note, no paid-by, no archived line, and nothing of payroll.
    for (const word of ["NEVER COST", "paidBy", "note", "Example Archived", NEVER.payroll, String(NEVER.gross)]) {
      expect(both.text, word).not.toContain(word);
    }
    // The fixture's notes are really there to be left out.
    const stored = await t.run(async (ctx) => JSON.stringify(await ctx.db.query("costs").collect()));
    expect(stored).toContain("NEVER COST NOTE");

    // One company, one month.
    const kz = whole((await call(t, token, "costs", { company: "kz", month: "2026-12" })).output);
    expect(kz.month).toBe("2026-12");
    expect((kz.summaries as { company: string }[]).map((row) => row.company)).toEqual(["kz"]);
    expect((kz.lines as { company: string }[]).map((row) => row.company)).toEqual(["kz"]);
    expect((await call(t, token, "costs", { month: "2026-13" })).isError).toBe(true);
  });

  test("budget: the report the plan page's own reads make, per company", async () => {
    const { t, owner, token } = await world();
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [
        { month: "2026-09", category: "cloud", amount: 100_000_00 },
        { month: "2026-09", category: "payroll", amount: 900_000_00 },
        { month: "2026-10", category: "cloud", amount: 120_000_00 },
      ],
    });
    await owner.mutation(api.budget.setActual, { company: "kz", month: "2026-09", amount: 1_100_000_00 });
    await owner.mutation(api.scenarios.save, {
      company: "kz",
      name: "Example raise",
      changes: [{ kind: "cash_in", label: "Example round", startMonth: "2026-12", amount: 1_00, currency: "KZT" }],
    });

    const answer = await call(t, token, "budget", { company: "kz" });
    const output = whole(answer.output);
    // The page's own read holds the same plan.
    const page = await owner.query(api.budget.view, { company: "kz", first: "2026-04", count: 12 });
    expect(page.cells).toHaveLength(3);
    const reports = output.reports as Record<string, unknown>[];
    expect(reports.map((row) => row.company)).toEqual(["kz"]);
    const kz = reports[0]!;
    expect(kz.month).toBe("2026-10");
    expect(kz.actualSource).toBe("typed");
    const months = kz.months as { month: string; plan: number | null; actual: number | null }[];
    expect(months.find((row) => row.month === "2026-09")).toMatchObject({
      plan: 1_000_000_00,
      actual: 1_100_000_00,
      variance: { kind: "over", diff: 100_000_00 },
    });
    // Per category: the Costs categories only, never Payroll broken out.
    expect(answer.text).not.toContain('"category":"payroll"');
    expect((kz.scenarios as { name: string }[]).map((row) => row.name)).toEqual(["Example raise"]);
    for (const word of [NEVER.payroll, String(NEVER.gross)]) expect(answer.text, word).not.toContain(word);

    const both = whole((await call(t, token, "budget", { month: "2026-11" })).output);
    expect((both.reports as { company: string; month: string }[]).map((row) => [row.company, row.month])).toEqual([
      ["us", "2026-11"],
      ["kz", "2026-11"],
    ]);
    expect((await call(t, token, "budget", { month: "2026-13" })).isError).toBe(true);
  });

  test("budget: Startup's actual is its own spending, and Globex's runway starts from its own burn", async () => {
    const { t, token } = await world();
    // Made up. Mercury last read on Oct 11, so August and September are whole.
    // Startup's money out $30K and $25K; it sent Globex $20K in August, and
    // September's figure of that is not on record. At ₸440 per $1.
    await t.run(async (ctx) => {
      const snap = (key: string, scope: string, period: "day" | "month", periodStart: string, value: number, source: string) =>
        ctx.db.insert("metricSnapshots", { key, scope, period, periodStart, value, source, syncedAt: NOW });
      await snap("cash_out", "us", "month", "2026-08-01", 30_000, "mercury");
      await snap("cash_out", "us", "month", "2026-09-01", 25_000, "mercury");
      await snap("cash_to_subsidiary", "us", "month", "2026-08-01", 20_000, "mercury");
      // Globex's balance falls ₸220,000 in August and in September.
      await snap("cash", "kz", "day", "2026-07-31", 5_000_000, "manual");
      await snap("cash", "kz", "day", "2026-08-31", 4_780_000, "manual");
      await snap("cash", "kz", "day", "2026-09-30", 4_560_000, "manual");
    });

    const reports = whole((await call(t, token, "budget", { month: "2026-10" })).output).reports as {
      company: string;
      months: { month: string; actual: number | null }[];
      start: { netBurn: number | null };
    }[];
    const us = reports.find((row) => row.company === "us")!;
    // $30K out less the $20K sent: Startup's own spending. September's is not known.
    expect(us.months.find((row) => row.month === "2026-08")?.actual).toBe(10_000_00);
    expect(us.months.find((row) => row.month === "2026-09")?.actual).toBeNull();
    const kz = reports.find((row) => row.company === "kz")!;
    // August: ₸220,000 fallen plus the ₸8.8M Startup sent that lifted it.
    // September has no figure of what was sent, so it is left out, never as
    // if nothing were: the average is August's own burn, as the page's is.
    expect(kz.start.netBurn).toBe(9_020_000_00);
  });

  test("budget: a cell nobody typed is the cost register's cash due; pay is never given, only what was typed", async () => {
    const { t, owner, token } = await world();
    await owner.mutation(api.costs.add, {
      company: "kz",
      name: "Example KZ Tool",
      category: "software",
      amount: 40_000_00,
      cadence: "monthly",
      startsOn: "2026-05",
      variable: false,
    });
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [{ month: "2026-09", category: "payroll", amount: 900_000_00 }],
    });
    await owner.mutation(api.budget.setActual, { company: "kz", month: "2026-09", amount: 1_000_000_00 });
    await owner.mutation(api.budget.setActual, { company: "kz", month: "2026-08", amount: 1_000_000_00 });

    const answer = await call(t, token, "budget", { company: "kz" });
    const months = (whole(answer.output).reports as { months: Record<string, unknown>[] }[])[0]!.months;
    // September: the register's 40,000 and the typed Payroll figure, set against the actual.
    expect(months.find((row) => row.month === "2026-09")).toMatchObject({
      plan: 940_000_00,
      excludes: [],
      variance: { kind: "over", diff: 60_000_00 },
    });
    // August: the register's figure only. Payroll's own is not given here, so
    // the month leaves it out, says so, and is not compared.
    expect(months.find((row) => row.month === "2026-08")).toMatchObject({
      plan: 40_000_00,
      excludes: ["payroll"],
      variance: { kind: "unknown", reason: "left_out" },
    });
    // The made-up person in the world is never in it, in any form.
    for (const word of [NEVER.payroll, String(NEVER.gross)]) expect(answer.text, word).not.toContain(word);
  });

  test("metrics: the scorecard's tiles, each with its latest figure and a short series", async () => {
    const { t, owner, token } = await world();
    const card = asJson(await owner.query(api.metrics.scorecard, {}));
    const output = whole(await answer(t, token, "metrics"));
    const tiles = output.tiles as {
      key: string;
      scope: string;
      latest: unknown;
      missing: boolean;
      series: unknown[];
      label: string;
      unit: string;
      grain: string;
    }[];
    expect(tiles.map(({ key, scope, latest, series }) => ({ key, scope, latest, series }))).toEqual(
      card.tiles.map((tile) => ({
        key: tile.key,
        scope: tile.scope,
        latest: tile.latest,
        series: tile.series.slice(-METRIC_SERIES_POINTS),
      })),
    );
    expect(tiles.find((tile) => tile.key === "mrr" && tile.scope === "us")).toMatchObject({
      label: "MRR",
      unit: "currency",
      grain: "month",
      missing: false,
      latest: { value: 6_000, periodStart: "2026-09-01", source: "manual" },
      series: [
        { periodStart: "2026-08-01", value: 5_000 },
        { periodStart: "2026-09-01", value: 6_000 },
      ],
    });

    const us = whole(await answer(t, token, "metrics", { company: "us" })).tiles as typeof tiles;
    expect(us.map(({ key, scope }) => `${key}/${scope}`)).toEqual(
      tilesOf("us", card.tiles).map(({ key, scope }) => `${key}/${scope}`),
    );
    expect(us.some((tile) => tile.scope === "kz")).toBe(false);

    const picked = whole(await answer(t, token, "metrics", { keys: ["mrr"] })).tiles as typeof tiles;
    expect(picked.map((tile) => `${tile.key}/${tile.scope}`).sort()).toEqual(["mrr/kz", "mrr/us"]);
  });

  test("metrics: a figure never reported is null and marked missing, never a zero", async () => {
    const { t, token } = await world();
    const tiles = (await answer(t, token, "metrics", { company: "us" })).tiles as {
      key: string;
      scope: string;
      latest: { value: number } | null;
      missing: boolean;
      series: unknown[];
    }[];
    const cash = tiles.find((tile) => tile.key === "cash" && tile.scope === "us")!;
    expect(cash).toMatchObject({ latest: null, missing: true, series: [] });
    for (const tile of tiles) {
      expect(tile.missing).toBe(tile.latest === null);
      // A missing figure is nowhere given a value.
      if (tile.latest === null) expect(JSON.stringify(tile)).not.toMatch(/"value":/);
    }
  });

  test("overview: the Dashboard's list, from the same producers and the same reads", async () => {
    const { t, owner, token } = await world();
    const card = await owner.query(api.metrics.scorecard, {});
    const clinics = await owner.query(api.customers.list, {});
    const expected = (company: "us" | "kz" | null) => async () => {
      const inView = (which: "us" | "kz") => company === null || company === which;
      return overviewItems(
        {
          tiles: tilesOf(company, card.tiles),
          sources: sourcesOf(company, card.sources),
          usDeals: inView("us") ? await owner.query(api.deals.board, { market: "us" }) : {},
          kzDeals: inView("kz") ? await owner.query(api.deals.board, { market: "kz" }) : {},
          investors: inView("us") ? await owner.query(api.investors.board, {}) : {},
          customers: clinics.customers.filter((clinic) => inView(clinic.market)),
          lastPushAt: clinics.lastPushAt,
          obligations: (await owner.query(api.obligations.list, {})).filter((o) =>
            categoryServes(company, o.category),
          ),
          pulls: {
            companies: company === null ? (["us", "kz"] as const) : [company],
            ...(await owner.query(api.workTools.pullRequests, {})),
          },
        },
        NOW,
        TODAY,
      ).map((item) => (item.id.startsWith("source:") ? { ...item, detail: SOURCE_FAILURE_DETAIL } : item));
    };

    const both = whole(await answer(t, token, "overview"));
    expect(both).toEqual({ company: "both", today: TODAY, items: await expected(null)() });
    const ids = (both.items as { id: string }[]).map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "source:mercury",
        "obligations:overdue",
        "obligations:due",
        "quiet-deals:us",
        "quiet-deals:kz",
        "quiet-investors",
        "investors-no-next-step",
        "engineering:stuck:us",
        "engineering:stuck:kz",
        "engineering:failing:kz",
      ]),
    );
    // Counted from the list by the five rules, as the Dashboard counts them:
    // the stored prs_stuck figure (2 for Startup) is not the count.
    const stuck = (both.items as { id: string }[]).find((item) => item.id === "engineering:stuck:us");
    expect(stuck).toMatchObject({ title: "1 pull request stuck", href: "/engineering?stuck=1" });
    // Worst first.
    expect(ids[0]).toBe("source:mercury");

    const us = whole(await answer(t, token, "overview", { company: "us" }));
    expect(us.items).toEqual(await expected("us")());
    const usIds = (us.items as { id: string }[]).map((item) => item.id);
    expect(usIds).toContain("quiet-deals:us");
    expect(usIds).not.toContain("quiet-deals:kz");
    expect(usIds).not.toContain("engineering:failing:kz");
    expect(usIds).not.toContain("engineering:stuck:kz");

    const kz = whole(await answer(t, token, "overview", { company: "kz" }));
    expect(kz.items).toEqual(await expected("kz")());
    const kzIds = (kz.items as { id: string }[]).map((item) => item.id);
    expect(kzIds).toEqual(expect.arrayContaining(["quiet-deals:kz", "engineering:failing:kz"]));
    expect(kzIds).not.toContain("quiet-investors");
    expect(kzIds).not.toContain("source:mercury");
  });

  test("overview: `today` may be the caller's own day, a day either side of the server's and no further", async () => {
    const { t, token } = await world();
    // On the 1st, by the caller's calendar, the obligation due that day is not overdue yet.
    const output = await answer(t, token, "overview", { today: "2026-10-13" });
    expect(output.today).toBe("2026-10-13");
    expect((await call(t, token, "overview", { today: "2026-10-15" })).output).not.toBeNull();
    expect((await call(t, token, "overview", { today: "2026-10-16" })).said).toBe(TODAY_TOO_FAR);
    expect((await call(t, token, "overview", { today: "2026-10-12" })).said).toBe(TODAY_TOO_FAR);
    expect((await call(t, token, "overview", { today: "13 October" })).isError).toBe(true);
  });

  test("overview: a failed run's stored message is not passed on", async () => {
    const { t, token } = await world();
    const output = await answer(t, token, "overview");
    const failed = (output.items as { id: string; detail: string; title: string }[]).find(
      (item) => item.id === "source:mercury",
    )!;
    expect(failed.detail).toBe(SOURCE_FAILURE_DETAIL);
    expect(JSON.stringify(output)).not.toContain("MERCURY_API_TOKEN");
  });
});

describe("what no tool returns", () => {
  test("payroll, personal rows, a Telegram username, a variable's name, a token or a run's message, in any read", async () => {
    const { t, ids, token } = await world("act");
    await addSam(t);
    // A personal token beside the agent's, so there are two hashes to leak.
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.connect@gmail.com", ["today"]);
    const personal = (await ada.mutation(api.connect.createToken, { entropy: ENTROPY })).token;

    const envNames = SOURCES.flatMap((source) => [...missingEnv(source), ingestTokenEnv(source.id)]);
    expect(envNames.length).toBeGreaterThan(5);
    const forbidden = [
      ...Object.values(NEVER).map(String),
      token,
      await hashToken(token),
      personal,
      await hashToken(personal),
      GITHUB_TOKEN,
      "OWNER_EMAILS",
      "TELEGRAM_BOT_TOKEN",
      "TOKEN_ENCRYPTION_KEY",
      ...envNames,
    ];

    const argsOf: Record<string, unknown[]> = {
      deals: [{}, { market: "us" }, { market: "kz" }],
      goals: [{}, { quarter: "2026-Q4" }],
      metrics: [{}, { keys: ["mrr"] }],
    };
    let checked = 0;
    // A bot's own read refuses this caller (no bot): convex/botRefusals.test.ts reads it as a bot.
    for (const tool of TOOLS.filter((x) => x.kind === "read" && !(BOT_OWN_TOOLS as readonly string[]).includes(x.name))) {
      for (const args of [...(argsOf[tool.name] ?? [{}]), { company: "us" }, { company: "kz" }]) {
        const reply = await call(t, token, tool.name, args);
        expect(reply.output, `${tool.name} answered`).not.toBeNull();
        for (const word of forbidden) expect(reply.text, `${tool.name} holds ${word}`).not.toContain(word);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(36);

    // And what an act tool says back.
    const made = await call(t, token, "task_create", { title: "A task" });
    const moved = await call(t, token, "task_move", { id: made.output.id, column: "doing" });
    const edited = await call(t, token, "deal_update", { id: ids.usDeal, notes: "A note" });
    for (const reply of [made, moved, edited]) {
      expect(reply.output).not.toBeNull();
      for (const word of forbidden) expect(reply.text).not.toContain(word);
    }
    // The protocol's own answers too.
    const { rpc } = await import("./mcp.kit");
    for (const method of ["initialize", "tools/list"]) {
      const reply = await rpc(t, token, method, {});
      for (const word of forbidden) expect(reply.text).not.toContain(word);
    }
  });

  test("the seeded rows are really there to be leaked", async () => {
    // Guards the test above: it proves nothing if the fixture wrote nothing.
    const { t } = await world();
    const all = await t.run(async (ctx) =>
      JSON.stringify([
        await ctx.db.query("payrollPeople").collect(),
        await ctx.db.query("payrollRuns").collect(),
        await ctx.db.query("mirrorRecords").collect(),
        await ctx.db.query("members").collect(),
        await ctx.db.query("sourceStatus").collect(),
        await ctx.db.query("notifications").collect(),
      ]),
    );
    for (const word of Object.values(NEVER)) expect(all).toContain(String(word));
  });
});

describe("caps", () => {
  async function many(t: TestBackend, count: number, notes?: string) {
    await t.run(async (ctx) => {
      for (let n = 0; n < count; n++) {
        await ctx.db.insert("tasks", {
          title: `Made-up task ${n}`,
          kind: "task",
          column: "backlog",
          order: n,
          ...(notes === undefined ? null : { notes }),
        });
      }
    });
  }

  test("a list longer than the tool's rows is cut from the end and says so", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const cap = TOOLS.find((tool) => tool.name === "tasks")!.caps.rows;
    await many(t, cap + 40);
    const output = await answer(t, token, "tasks");
    expect(output.truncated).toBe(true);
    const backlog = output.backlog as { title: string }[];
    expect(backlog).toHaveLength(cap);
    expect(backlog[0]!.title).toBe("Made-up task 0");
    expect(backlog.at(-1)!.title).toBe(`Made-up task ${cap - 1}`);
  });

  test("an answer over the tool's bytes is cut until it fits and says so", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const { caps } = TOOLS.find((tool) => tool.name === "tasks")!;
    await many(t, 100, "n".repeat(5_000));
    const reply = await call(t, token, "tasks");
    expect(reply.output.truncated).toBe(true);
    expect(reply.output.backlog.length).toBeLessThan(100);
    expect(reply.output.backlog.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(reply.textOutput!).length).toBeLessThanOrEqual(caps.bytes + 20);
  });

  test("a list within its caps is whole and says so", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    await many(t, 5);
    const output = await answer(t, token, "tasks");
    expect(output.truncated).toBe(false);
    expect(output.backlog).toHaveLength(5);
  });

  test("the text and the structured content are the same answer", async () => {
    const { t, token } = await world();
    for (const tool of TOOLS.filter((x) => x.kind === "read" && !(BOT_OWN_TOOLS as readonly string[]).includes(x.name))) {
      const reply = await call(t, token, tool.name);
      expect(JSON.parse(reply.textOutput!)).toEqual(reply.output);
      // Compact: no indentation spent on a model's context.
      expect(reply.textOutput).not.toContain("\n");
    }
  });
});

describe("arguments", () => {
  test("a field a tool does not take, or of the wrong kind, is refused by path and fixed words", async () => {
    const { t, token } = await world("act");
    const cases: [string, unknown, string][] = [
      ["tasks", { company: "SECRET" }, "company: is not one of the values this field takes"],
      ["tasks", { SECRET_FIELD: 1 }, "arguments: holds a field this tool does not take"],
      ["task_create", {}, "title: is missing or has the wrong type"],
      ["task_create", { title: 7 }, "title: is missing or has the wrong type"],
      ["task_create", { title: "x".repeat(201) }, "title: is too long or too large"],
      ["task_create", { title: "x", due: "SECRET day" }, "due: is not written the way this field is"],
      ["task_move", { id: "x", column: "SECRET" }, "column: is not one of the values this field takes"],
      ["metrics", { keys: [7] }, "keys.0: is missing or has the wrong type"],
    ];
    for (const [name, args, words] of cases) {
      const reply = await call(t, token, name, args);
      expect(reply.isError, name).toBe(true);
      expect(reply.said).toBe(`The arguments are not valid. ${words}.`);
      expect(reply.text).not.toContain("SECRET");
    }
    expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length)).toBe(3);
  });
});

describe("task tools", () => {
  /** Who was told what, without the actor: what a person's own action is compared by. */
  const told = (t: TestBackend) =>
    t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect())
        .filter((row) => row.title !== NEVER.told)
        .map((row) => ({
          to: row.recipient,
          kind: row.kind,
          title: row.title,
          company: row.company ?? null,
          column: row.column ?? null,
          due: row.due ?? null,
          moved: row.to ?? null,
        })),
    );
  const actors = (t: TestBackend) =>
    t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect())
        .filter((row) => row.title !== NEVER.told)
        .map((row) => row.actor),
    );
  const scheduled = (t: TestBackend) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name),
    );

  /** A backend with Sam on it, the owner's token, and the owner's own session. */
  async function desk() {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "act");
    const { userId: samId } = await addSam(t);
    const ownerId = (await t.run((ctx) => ctx.db.query("agentTokens").collect()))[0]!.userId;
    return { t, owner, token, samId, ownerId };
  }

  test("task_create makes the card the app would, marked as the agent's and made by the owner", async () => {
    const { t, owner, token, ownerId } = await desk();
    const made = await answer(t, token, "task_create", {
      title: "  Send the deck  ",
      notes: "  For Thursday.  ",
      kind: "issue",
      due: "2026-10-20",
      assignee: SAM,
      company: "us",
      column: "this_week",
    });
    expect(made).toMatchObject({ created: true });
    const [task] = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(task).toMatchObject({
      _id: made.id,
      // Cleaned by the app's own cleaners.
      title: "Send the deck",
      notes: "For Thursday.",
      kind: "issue",
      due: "2026-10-20",
      assignee: SAM,
      company: "us",
      column: "this_week",
      createdBy: ownerId,
      origin: { source: "agent" },
    });
    const card = (await owner.query(api.tasks.board, {})).this_week[0]!;
    expect(card.origin).toEqual({ source: "agent", for: null });
  });

  test("the card says whose Claude made it, by first name, to anyone who knows the owner", async () => {
    const { t, owner, token, ownerId } = await desk();
    await t.run((ctx) => ctx.db.patch(ownerId, { name: "Olga Owner" }));
    await answer(t, token, "task_create", { title: "A task" });
    expect((await owner.query(api.tasks.board, {})).backlog[0]!.origin).toEqual({
      source: "agent",
      for: "Olga",
    });
  });

  test("with no company it is shared, as on the board; \"shared\" says the same", async () => {
    const { t, token } = await desk();
    await answer(t, token, "task_create", { title: "One" });
    await answer(t, token, "task_create", { title: "Two", company: "shared" });
    const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.map((task) => task.company)).toEqual([undefined, undefined]);
    expect(tasks.map((task) => task.column)).toEqual(["backlog", "backlog"]);
  });

  test("create, update and move tell exactly who a person's own action tells, and announce the same", async () => {
    // The same three steps twice: by the agent, and by the owner on the board.
    const steps = async (
      create: (args: Record<string, unknown>) => Promise<string>,
      update: (args: Record<string, unknown>) => Promise<unknown>,
      move: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const id = await create({ title: "Call the clinic", assignee: SAM, company: "us" });
      await update({ id, due: "2026-10-21" });
      await move({ id, column: "doing", index: 0 });
      await move({ id, column: "done", index: 0 });
      await update({ id, assignee: null });
      // The owner's own task: nobody to tell.
      const own = await create({ title: "The owner's own", assignee: OWNER });
      await move({ id: own, column: "doing", index: 0 });
    };

    const withIds = (rows: Awaited<ReturnType<typeof told>>, sam: string) =>
      rows.map((row) => ({ ...row, to: row.to === sam ? "sam" : "someone else" }));
    // With a bot token, a task given to someone schedules the announcement.
    // Every timer is faked so the queue can be read and then run out (it
    // finds no group picked and sends nothing); Telegram is never asked.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", BOT_TOKEN);
    const asked = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", asked);

    // One backend at a time: each is read before the next is made.
    const agent = await desk();
    await steps(
      async (args) => (await answer(agent.t, agent.token, "task_create", args)).id as string,
      (args) => answer(agent.t, agent.token, "task_update", args),
      (args) => answer(agent.t, agent.token, "task_move", args),
    );
    const byAgent = {
      told: withIds(await told(agent.t), agent.samId),
      actors: await actors(agent.t),
      scheduled: await scheduled(agent.t),
    };
    await finishScheduled(agent.t);

    const person = await desk();
    await steps(
      (args) => person.owner.mutation(api.tasks.create, args as never),
      (args) => person.owner.mutation(api.tasks.update, args as never),
      (args) => person.owner.mutation(api.tasks.move, args as never),
    );
    const byPerson = {
      told: withIds(await told(person.t), person.samId),
      actors: await actors(person.t),
      scheduled: await scheduled(person.t),
    };
    await finishScheduled(person.t);
    expect(asked).not.toHaveBeenCalled();

    expect(byAgent.told).toEqual(byPerson.told);
    expect(byAgent.told.map((row) => `${row.to}: ${row.kind}`)).toEqual([
      "sam: assigned",
      "sam: due",
      "sam: moved",
      "sam: moved",
      "sam: unassigned",
    ]);
    // Said to be the owner's Claude, for that owner; the owner is told nothing of it.
    expect(byAgent.actors).toEqual(
      Array.from({ length: 5 }, () => ({ type: "agent", userId: agent.ownerId })),
    );
    expect(byPerson.actors).toEqual(
      Array.from({ length: 5 }, () => ({ type: "user", userId: person.ownerId })),
    );
    // The Telegram announcement: once, for the task given to Sam, in both.
    expect(byAgent.scheduled).toEqual(["telegram:notify"]);
    expect(byAgent.scheduled).toEqual(byPerson.scheduled);
  });

  test("a teammate reads who did it as the owner's Claude", async () => {
    const { t, token, ownerId } = await desk();
    await t.run((ctx) => ctx.db.patch(ownerId, { name: "Olga Owner" }));
    await answer(t, token, "task_create", { title: "Call the clinic", assignee: SAM, company: "us" });
    const sam = t.withIdentity({
      subject: await t.run(async (ctx) => {
        const user = (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", SAM)).first())!;
        const session = (await ctx.db.query("authSessions").collect()).find((row) => row.userId === user._id)!;
        return `${user._id}|${session._id}`;
      }),
    });
    const { rows } = await sam.query(api.notifications.mine, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "assigned",
      title: "Call the clinic",
      actor: { type: "agent", name: "Olga Owner" },
    });
  });

  test("task_update changes only what it is sent, and null clears", async () => {
    const { t, token } = await desk();
    const { id } = await answer(t, token, "task_create", {
      title: "First",
      notes: "Some notes",
      due: "2026-10-20",
      assignee: SAM,
      company: "us",
    });
    await answer(t, token, "task_update", { id, title: " Second " });
    let [task] = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(task).toMatchObject({ title: "Second", notes: "Some notes", due: "2026-10-20", assignee: SAM });

    await answer(t, token, "task_update", { id, notes: null, due: null, assignee: null, company: "shared" });
    [task] = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(task).toMatchObject({ title: "Second", column: "backlog" });
    expect([task!.notes, task!.due, task!.assignee, task!.company]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // The card stays the agent's own, made by the owner.
    expect(task!.origin).toEqual({ source: "agent" });
  });

  test("task_move puts the card where it says, among the cards of its column", async () => {
    const { t, owner, token } = await desk();
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      ids.push((await answer(t, token, "task_create", { title, column: "doing" })).id as string);
    }
    await answer(t, token, "task_move", { id: ids[2], column: "doing", index: 0 });
    expect((await owner.query(api.tasks.board, {})).doing.map((card) => card.title)).toEqual(["C", "A", "B"]);
    // No index: the top.
    await answer(t, token, "task_move", { id: ids[1], column: "this_week" });
    const board = await owner.query(api.tasks.board, {});
    expect(board.this_week.map((card) => card.title)).toEqual(["B"]);
    expect(board.doing.map((card) => card.title)).toEqual(["C", "A"]);
  });

  test("the board's own refusals hold, in the board's own words, and change nothing", async () => {
    const { t, token } = await desk();
    const before = async () => JSON.stringify(await t.run((ctx) => ctx.db.query("tasks").collect()));
    const { id } = await answer(t, token, "task_create", { title: "A task", company: "kz" });
    const was = await before();

    // Sam is on Startup alone: a Globex task cannot be given to him.
    expect((await call(t, token, "task_update", { id, assignee: SAM })).said).toBe(CANNOT_ASSIGN);
    expect((await call(t, token, "task_create", { title: "x", assignee: "nobody@example.test" })).said).toBe(
      CANNOT_ASSIGN,
    );
    expect((await call(t, token, "task_create", { title: "   " })).said).toBe("A task needs a title.");
    expect((await call(t, token, "task_update", { id: "not-an-id", title: "x" })).said).toBe(TASK_GONE);
    expect((await call(t, token, "task_move", { id: "not-an-id", column: "doing" })).said).toBe(TASK_GONE);
    // Another table's id is not a task's.
    const goal = await t.run((ctx) =>
      ctx.db.insert("goals", { quarter: "2026-Q4", title: "g", status: "on_track", order: 0 }),
    );
    expect((await call(t, token, "task_update", { id: goal, title: "x" })).said).toBe(TASK_GONE);
    expect(await before()).toBe(was);
    // A refusal names nobody back.
    const refused = await call(t, token, "task_create", { title: "x", assignee: "secret.person@example.test" });
    expect(refused.text).not.toContain("secret.person");
  });

  test("a write that is refused part-way leaves nothing behind", async () => {
    const { t, token } = await desk();
    const { id } = await answer(t, token, "task_create", { title: "Kept", company: "kz" });
    // The title is valid and would be written; the assignee then refuses the whole save.
    const reply = await call(t, token, "task_update", { id, title: "Changed", assignee: SAM, column: "doing" });
    expect(reply.said).toBe(CANNOT_ASSIGN);
    const [task] = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(task).toMatchObject({ title: "Kept", column: "backlog" });
  });
});

describe("deal_update", () => {
  test("a deal made here takes every field the board's editor does", async () => {
    const { t, ids, owner, token } = await world("act");
    await answer(t, token, "deal_update", {
      id: ids.usDeal,
      name: " Renamed Co ",
      contact: "Made-up Person",
      amount: 2_500,
      stage: "demo",
      nextStep: " Send pricing ",
      notes: "A note",
    });
    const board = await owner.query(api.deals.board, { market: "us" });
    expect(board.demo).toHaveLength(1);
    expect(board.demo[0]).toMatchObject({
      name: "Renamed Co",
      contact: "Made-up Person",
      amount: 2_500,
      nextStep: "Send pricing",
      notes: "A note",
      mirrored: false,
    });
  });

  test("a mirrored deal takes a next step and notes", async () => {
    const { t, ids, owner, token } = await world("act");
    await answer(t, token, "deal_update", { id: ids.kzDeal, nextStep: "Call on Monday", notes: "A note" });
    const deal = (await owner.query(api.deals.board, { market: "kz" })).qualified[0]!;
    expect(deal).toMatchObject({ nextStep: "Call on Monday", notes: "A note", mirrored: true });
    await answer(t, token, "deal_update", { id: ids.kzDeal, nextStep: null });
    expect((await owner.query(api.deals.board, { market: "kz" })).qualified[0]!.nextStep).toBeNull();
  });

  test.each([
    ["name", { name: "Renamed" }],
    ["contact", { contact: "Somebody" }],
    ["contact cleared", { contact: null }],
    ["amount", { amount: 5 }],
    ["stage", { stage: "won" }],
    // Even the value it already has, and even beside a field that is allowed.
    ["its own name", { name: "Example KZ Deal" }],
    ["a next step and a stage", { nextStep: "x", stage: "demo" }],
  ])("a mirrored deal's %s is refused, and nothing is changed", async (_what, edit) => {
    const { t, ids, token } = await world("act");
    const was = JSON.stringify(await t.run((ctx) => ctx.db.get(ids.kzDeal)));
    const reply = await call(t, token, "deal_update", { id: ids.kzDeal, ...edit });
    expect(reply.isError).toBe(true);
    expect(reply.said).toMatch(/^This deal is mirrored from .+\. Change it there: here you can edit only its next step and notes\.$/);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.get(ids.kzDeal)))).toBe(was);
  });

  test("a deal that is not there, or an id of something else, is refused in the board's words", async () => {
    const { t, ids, token } = await world("act");
    expect((await call(t, token, "deal_update", { id: "not-an-id", notes: "x" })).said).toBe(DEAL_GONE);
    expect((await call(t, token, "deal_update", { id: ids.usTask, notes: "x" })).said).toBe(DEAL_GONE);
    await t.run((ctx) => ctx.db.patch(ids.usDeal, { archivedAt: 1 }));
    expect((await call(t, token, "deal_update", { id: ids.usDeal, notes: "x" })).said).toBe(
      "That deal is no longer on the board.",
    );
  });

  test("a read-only token changes no deal", async () => {
    const { t, ids, token } = await world("read");
    const reply = await call(t, token, "deal_update", { id: ids.usDeal, notes: "x" });
    expect(reply.said).toBe(AGENT_WORDS.readOnly);
    expect((await t.run((ctx) => ctx.db.get(ids.usDeal)))!.notes).toBeUndefined();
  });
});

describe("what a bot reads of the `agent` field", () => {
  test("every tool with an `agent` field says a bot id is welcome, not only the four agents", () => {
    for (const tool of TOOLS) {
      const schema = describeTool(tool).inputSchema as { properties?: Record<string, { enum?: unknown; type?: string; description?: string }> };
      const field = schema.properties?.agent;
      if (field === undefined) continue;
      expect(field.enum, tool.name).toBeUndefined();
      expect(field.type, tool.name).toBe("string");
      expect(field.description, tool.name).toMatch(/bot id/);
    }
  });
});
