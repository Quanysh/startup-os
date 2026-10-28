import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { AGENT_OFF } from "./lib/agents";
import { BOT_WORDS, EXTERNAL_OWNER_AGENTS, SUGGESTED_BOTS } from "./lib/botRules";
import { BOT_CALL_DAYS_KEPT, DURATION_BUCKETS_MS, cleanCostUsd, p95Of, providerOf } from "./lib/botTelemetry";
import { AGENT_HEADER } from "./lib/osAgents";
import { DAY, ENTROPY, NOW, TODAY, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsCofounder, type TestBackend } from "./test.setup";

// The bots in the `agents` read and on the Bots tab (Bot Loop v3, J; spec
// §13): each bot profile's week from its own calls (a daily rollup, so the
// audit's pruning does not shorten it), the cost a bot reports with
// `costUsd`, and its company and monthly budget. And a switched-off owner
// agent: its calls are refused and never written down as answered. Every
// name and figure is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  const other = await owner.mutation(api.assistant.createToken, {
    entropy: `${ENTROPY}-other`,
    scope: "act",
    name: "Made-up client",
  });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, runner: token, grok: grok.token, other: other.token };
}

type BotRow = Record<string, unknown> & { botId: string };
const botsRead = async (t: TestBackend, token: string): Promise<BotRow[]> => {
  const reply = await call(t, token, "agents", {});
  if (reply.output === null) throw new Error(`agents did not answer: ${reply.text}`);
  return reply.output.bots as BotRow[];
};
const rowOf = async (t: TestBackend, token: string, botId: string) => (await botsRead(t, token)).find((b) => b.botId === botId)!;
const profileOf = async (t: TestBackend, botId: string) =>
  (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === botId)!;

describe("the pure parts", () => {
  test("a cost is a number from 0 to 100, else nothing", () => {
    expect(cleanCostUsd(0)).toBe(0);
    expect(cleanCostUsd(0.25)).toBe(0.25);
    expect(cleanCostUsd(100)).toBe(100);
    for (const bad of [-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}]) {
      expect(cleanCostUsd(bad), String(bad)).toBeNull();
    }
  });

  test("p95 is the upper edge of the bucket it falls in, never above the slowest call; null with no calls", () => {
    const empty = DURATION_BUCKETS_MS.map(() => 0);
    expect(p95Of(empty, 0)).toBeNull();
    const fast = [...empty];
    fast[0] = 20;
    expect(p95Of(fast, 0)).toBe(0);
    expect(p95Of(fast, 30)).toBe(30);
    const mixed = [...empty];
    mixed[0] = 94;
    mixed[3] = 6;
    expect(p95Of(mixed, 999_999)).toBe(DURATION_BUCKETS_MS[3]);
    // Past the last edge: the slowest call itself.
    const slow = [...empty, 0];
    slow[slow.length - 1] = 1;
    expect(p95Of(slow, 123_456)).toBe(123_456);
  });

  test("a client named or signed in from Grok is external_grok; any other is external", () => {
    expect(providerOf("Grok app", null)).toBe("external_grok");
    expect(providerOf("Cursor", "grok.com")).toBe("external_grok");
    expect(providerOf("Made-up client", null)).toBe("external");
    expect(providerOf(undefined, null)).toBe("external");
  });
});

describe("the agents read lists every bot", () => {
  test("one row a profile, the external chief of staff and engineering included, null where nothing was reported", async () => {
    const { t, owner, runner } = await setUp();
    for (const id of EXTERNAL_OWNER_AGENTS) await owner.mutation(api.bots.addExternalProfile, { id });
    const rows = await botsRead(t, runner);
    expect(rows.map((r) => r.botId).sort()).toEqual([...SUGGESTED_BOTS.map((s) => s.id), ...EXTERNAL_OWNER_AGENTS].sort());
    expect(rows.find((r) => r.botId === "growth")).toEqual({
      botId: "growth",
      name: expect.any(String),
      provider: "external",
      owner: "owner",
      company: null,
      monthlyBudgetUsd: null,
      enabled: true,
      calls7d: null,
      errorRate7d: null,
      schemaFailureRate7d: null,
      p95Ms7d: null,
      lastSeenDay: null,
      idle7d: true,
      approvalRate: null,
      costMonthUsd: null,
      costWhy: "external_not_reported",
    });
  });

  test("a bot's week: its calls, error and schema-failure rates, p95, last day seen, and its client's provider", async () => {
    const { t, grok, runner } = await setUp();
    for (let n = 0; n < 3; n++) expect((await call(t, grok, "goals", { agent: "growth", company: "us" })).output).not.toBeNull();
    // Not of the tool's shape: invalid.
    await call(t, grok, "goals", { agent: "growth", company: "us", nonsense: 1 });
    // Not permitted: refused, and counted.
    expect((await call(t, grok, "deal_update", { agent: "growth", dealId: "x", nextStep: "y" })).refusal).toMatchObject({
      code: "not_permitted",
    });
    // A name no profile has is no bot's row.
    await call(t, grok, "goals", { agent: "made_up_stranger", company: "us" });

    const growth = await rowOf(t, runner, "growth");
    expect(growth).toMatchObject({
      provider: "external_grok",
      calls7d: 5,
      errorRate7d: 0,
      schemaFailureRate7d: 0.2,
      p95Ms7d: expect.any(Number),
      lastSeenDay: TODAY,
      idle7d: false,
    });
    expect((await botsRead(t, runner)).some((r) => r.botId === "made_up_stranger")).toBe(false);
    expect(await rowOf(t, runner, "research")).toMatchObject({ calls7d: null, lastSeenDay: null });
  });

  test("the approval rate is the bot's own decided proposals'", async () => {
    const { t, owner, grok, runner } = await setUp();
    const made = await call(t, grok, "task_create", { agent: "growth", title: "Made-up card", company: "us" });
    expect(made.output).not.toBeNull();
    const proposed = await call(t, grok, "goal_create", {
      agent: "strategy_advisor",
      company: "us",
      quarter: "2026-Q4",
      title: "Made-up: a goal",
      why: "Made-up why.",
    });
    const { id } = proposed.output as { id: never };
    await owner.mutation(api.assistant.approve, { id });
    expect(await rowOf(t, runner, "strategy_advisor")).toMatchObject({ approvalRate: 1 });
    expect(await rowOf(t, runner, "growth")).toMatchObject({ approvalRate: null });
  });

  test("seven days are seven days; the month's cost is this UTC month's alone", async () => {
    const { t, grok, runner } = await setUp();
    // 2026-09-30: last month.
    vi.setSystemTime(NOW - 14 * DAY);
    await call(t, grok, "goals", { agent: "growth", company: "us", costUsd: 5 });
    // 2026-10-06: this month, past the week.
    vi.setSystemTime(NOW - 8 * DAY);
    await call(t, grok, "goals", { agent: "growth", company: "us", costUsd: 1.5 });
    vi.setSystemTime(NOW);
    expect(await rowOf(t, runner, "growth")).toMatchObject({
      calls7d: null,
      lastSeenDay: "2026-10-06",
      idle7d: true,
      costMonthUsd: 1.5,
      costWhy: null,
    });
  });

  test("the week outlives the audit's own pruning", async () => {
    const { t, grok, runner } = await setUp();
    await call(t, grok, "goals", { agent: "growth", company: "us" });
    await call(t, grok, "goals", { agent: "growth", company: "us" });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("agentCalls").collect()) await ctx.db.delete(row._id);
    });
    expect(await rowOf(t, runner, "growth")).toMatchObject({ calls7d: 2 });
    // The rollup itself is kept BOT_CALL_DAYS_KEPT days.
    vi.setSystemTime(NOW + (BOT_CALL_DAYS_KEPT + 1) * DAY);
    await t.mutation(internal.assistant.prune, {});
    expect(await t.run((ctx) => ctx.db.query("botCallDays").collect())).toEqual([]);
  });
});

describe("costUsd on a call", () => {
  test("a bot's, 0 to 100, kept on its call's row and summed for the month; never a tool argument", async () => {
    const { t, grok, runner } = await setUp();
    expect((await call(t, grok, "goals", { agent: "growth", company: "us", costUsd: 0.25 })).output).not.toBeNull();
    for (const bad of [150, -1, "0.5"]) {
      // Out of range or not a number: the call still runs, and no cost is kept.
      expect((await call(t, grok, "goals", { agent: "growth", company: "us", costUsd: bad })).output).not.toBeNull();
    }
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.filter((r) => r.bot === "growth").map((r) => r.costUsd)).toEqual([0.25, undefined, undefined, undefined]);
    expect(await rowOf(t, runner, "growth")).toMatchObject({ calls7d: 4, costMonthUsd: 0.25, costWhy: null });
  });

  test("a caller that is no bot may send it, and nothing is kept", async () => {
    const { t, runner } = await setUp();
    expect((await call(t, runner, "goals", { company: "us", costUsd: 3 })).output).not.toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.every((r) => r.costUsd === undefined)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("botCallDays").collect())).toEqual([]);
  });

  test("at a bot's own address too", async () => {
    const { t, owner, runner } = await setUp();
    const growth = await profileOf(t, "growth");
    const made = await owner.mutation(api.bots.makeToken, { id: growth._id, entropy: `${ENTROPY}-growth` });
    const reply = await t.fetch("/mcp/v1/bot/growth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${made.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "goals", arguments: { company: "us", costUsd: 2 } },
      }),
    });
    expect(reply.status).toBe(200);
    expect(await rowOf(t, runner, "growth")).toMatchObject({ calls7d: 1, costMonthUsd: 2 });
  });
});

describe("a bot's company and monthly budget", () => {
  test("the owner sets and clears them; the read and the tab show them", async () => {
    const { t, owner, runner } = await setUp();
    const growth = await profileOf(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, company: "kz", monthlyBudgetUsd: 50 });
    expect(await rowOf(t, runner, "growth")).toMatchObject({ company: "kz", monthlyBudgetUsd: 50 });
    // Editing them is not editing what the bot may do: still marked as suggested.
    expect((await profileOf(t, "growth")).suggested).toBe(true);
    await owner.mutation(api.bots.update, { id: growth._id, monthlyBudgetUsd: null });
    expect(await rowOf(t, runner, "growth")).toMatchObject({ company: "kz", monthlyBudgetUsd: null });
    for (const bad of [-1, 10_001, Number.NaN]) {
      await expect(owner.mutation(api.bots.update, { id: growth._id, monthlyBudgetUsd: bad })).rejects.toThrow(BOT_WORDS.badBudget);
    }
    const telemetry = await owner.query(api.bots.telemetry, { today: TODAY });
    expect(telemetry.find((r) => r.botId === "growth")).toMatchObject({ company: "kz", monthlyBudgetUsd: null, calls7d: null, idle7d: true });
  });

  test("the tab's telemetry is the owner's alone", async () => {
    const { t } = await setUp();
    const cofounder = await signInAsCofounder(t);
    await expect(cofounder.query(api.bots.telemetry, { today: TODAY })).rejects.toThrow();
    await expect(cofounder.query(api.bots.telemetry, { today: "not a day" })).rejects.toThrow();
  });
});

describe("an owner agent switched off", () => {
  test("its calls are refused, and no audit row says one of them answered", async () => {
    const { t, owner, runner } = await setUp();
    await owner.mutation(api.assistant.setAgent, { agent: "sales", on: false });
    const proposed = await call(t, runner, "propose", {
      agent: "sales",
      company: "us",
      kind: "draft",
      why: "Made-up why.",
      dedupeKey: "sales:draft:made-up",
      payload: { title: "Made-up", body: "Made-up" },
    });
    expect(proposed.said).toBe(AGENT_OFF);
    const read = await call(t, runner, "deals", { market: "us" }, { [AGENT_HEADER]: "sales" });
    expect(read.output).toBeNull();
    expect(read.said).toBe(AGENT_OFF);
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.filter((r) => r.agent === "sales").map((r) => r.outcome)).toEqual(["refused", "refused"]);
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });
});
