import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS } from "./lib/agentRules";
import { BOT_WORDS, botMayCall, memberAsBot, suggestedPermissions, SUGGESTED_BOTS, type BotPermission } from "./lib/botRules";
import { getMetric } from "./lib/metricRegistry";
import type { Member } from "./lib/owner";
import { AREAS } from "./lib/roles";
import { ENTROPY, NOW, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";

// What a bot reads is what its own permissions open, never what the owner
// behind its client holds: each figure and each goal's target is filtered as
// for a teammate who holds the bot's areas, and a bot that works for one
// company reads no other's board. Made-up figures and names.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A made-up MRR no answer may carry unless the caller may see finance. */
const SECRET_MRR = 98_765;

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  await t.run(async (ctx) => {
    await ctx.db.insert("metricSnapshots", {
      key: "mrr",
      scope: "us",
      period: "month",
      periodStart: "2026-09-01",
      value: SECRET_MRR,
      source: "manual",
      syncedAt: NOW,
    });
    await ctx.db.insert("goals", {
      quarter: "2026-Q4",
      title: "Made-up goal",
      status: "on_track",
      order: 1,
      target: "MRR of 98,765",
    });
    await ctx.db.insert("investors", { source: "native", externalId: "made-up-1", name: "Made-up Fund", stage: "target", order: 1 });
  });
  const give = async (botId: string, permissions: BotPermission[], company?: "us" | "kz" | "both") => {
    const bot = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === botId)!;
    await owner.mutation(api.bots.update, {
      id: bot._id as Id<"bots">,
      permissions,
      ...(company === undefined ? null : { company }),
    });
  };
  return { t, owner, mac, grok: grok.token, give };
}

type Tile = { key: string; scope: string; latest: { value: number } | null };
const financeTiles = (tiles: Tile[]) => tiles.filter((tile) => getMetric(tile.key)?.section === "finance");

describe("metrics: a bot is sent the figures its own areas open", () => {
  test("a bot holding read on the scorecard alone gets no finance figure", async () => {
    const { t, grok, give } = await setUp();
    await give("research", [{ area: "scorecard", level: "read" }]);
    const got = await call(t, grok, "metrics", { agent: "research" });
    expect(got.isError).toBe(false);
    expect(financeTiles(got.output.tiles as Tile[])).toEqual([]);
    expect(got.textOutput).not.toContain(String(SECRET_MRR));
  });

  test("a bot holding the scorecard and finance gets them", async () => {
    const { t, grok, give } = await setUp();
    await give("research", [
      { area: "scorecard", level: "read" },
      { area: "finance", level: "read" },
    ]);
    const got = await call(t, grok, "metrics", { agent: "research" });
    const mrr = (got.output.tiles as Tile[]).find((tile) => tile.key === "mrr" && tile.scope === "us");
    expect(mrr?.latest?.value).toBe(SECRET_MRR);
    // And still no product figure: finance opens finance.
    expect((got.output.tiles as Tile[]).some((tile) => getMetric(tile.key)?.section === "product")).toBe(false);
  });

  test("the owner's own client is told every figure, as before", async () => {
    const { t, mac } = await setUp();
    const got = await call(t, mac, "metrics", {});
    const tiles = got.output.tiles as Tile[];
    expect(tiles.find((tile) => tile.key === "mrr" && tile.scope === "us")?.latest?.value).toBe(SECRET_MRR);
    expect(tiles.some((tile) => getMetric(tile.key)?.section === "product")).toBe(true);
  });
});

describe("memberAsBot", () => {
  const owner = { user: {} as never, role: "owner", companies: ["us", "kz"], areas: AREAS } as unknown as Member;

  test("holds the bot's areas, read or write, never a locked one, as a teammate who is not the owner", () => {
    const as = memberAsBot(owner, [
      { area: "scorecard", level: "read" },
      { area: "gtm", level: "write" },
    ]);
    expect(as.role).not.toBe("owner");
    // Marketing goes with go-to-market, as it does for a teammate.
    expect([...as.areas].sort()).toEqual(["gtm", "marketing", "scorecard"]);
    expect(as.companies).toEqual(["us", "kz"]);
    // A crafted stored permission on a locked area lends nothing.
    expect(memberAsBot(owner, [{ area: "payroll", level: "read" } as never]).areas).toEqual([]);
  });
});

describe("goals: read with the scorecard or the board, as the page", () => {
  test("a bot with the board alone reads them, without a target", async () => {
    const { t, grok, give } = await setUp();
    await give("research", [{ area: "board", level: "read" }]);
    const got = await call(t, grok, "goals", { agent: "research", quarter: "2026-Q4" });
    expect(got.isError).toBe(false);
    expect(got.output.rows).toHaveLength(1);
    expect(got.output.rows[0].target).toBeNull();
  });

  test("a bot with the scorecard alone reads them", async () => {
    const { t, grok, give } = await setUp();
    await give("research", [{ area: "scorecard", level: "read" }]);
    const got = await call(t, grok, "goals", { agent: "research", quarter: "2026-Q4" });
    expect(got.isError).toBe(false);
    expect(got.output.rows).toHaveLength(1);
  });

  test("a bot with neither is refused, even with write on review, and is not listed it", async () => {
    const { t, grok, give } = await setUp();
    await give("research", [
      { area: "review", level: "write" },
      { area: "memory", level: "read" },
    ]);
    const got = await call(t, grok, "goals", { agent: "research", quarter: "2026-Q4" });
    expect(got.said).toBe(BOT_WORDS.notAllowed);
    expect(got.refusal).toMatchObject({ code: "not_permitted", tool: "goals", area: "scorecard", or: ["board"], need: "read" });
    // Proposing a goal stays on review.
    expect(botMayCall([{ area: "review", level: "write" }], "goal_create", "act")).toBe(true);
    expect(botMayCall([{ area: "board", level: "write" }], "goal_create", "act")).toBe(false);
  });

  test("the suggested bots that read goals now are those holding the scorecard or the board", () => {
    for (const bot of SUGGESTED_BOTS) {
      const permissions = suggestedPermissions(bot);
      const held = (area: string) => permissions.some((p) => p.area === area);
      expect([bot.id, botMayCall(permissions, "goals", "read")]).toEqual([bot.id, held("scorecard") || held("board")]);
    }
  });
});

describe("investors: Startup's alone, as the page", () => {
  test("a bot working for Globex is refused Startup's board", async () => {
    const { t, grok, give } = await setUp();
    await give("fundraising", [{ area: "fundraising", level: "read" }], "kz");
    const got = await call(t, grok, "investors", { agent: "fundraising" });
    expect(got.said).toBe(AGENT_WORDS.notAllowed);
    expect(got.text).not.toContain("Made-up Fund");
    // Nor may it change one, with write on fundraising.
    await give("fundraising", [{ area: "fundraising", level: "write" }]);
    const fund = (await t.run((ctx) => ctx.db.query("investors").first()))!;
    const changed = await call(t, grok, "investor_update", { agent: "fundraising", id: fund._id, notes: "Made-up note" });
    expect(changed.said).toBe(AGENT_WORDS.notAllowed);
    expect((await t.run((ctx) => ctx.db.get(fund._id)))!.notes).toBeUndefined();
    // Its company's own board is empty, not refused.
    expect((await call(t, grok, "investors", { agent: "fundraising", company: "kz" })).output).toMatchObject({ company: "us", columns: {} });
  });

  test("a bot working for Startup, for both, or with no company set reads it; the owner's client as before", async () => {
    const { t, mac, grok, give } = await setUp();
    const bots = [
      ["fundraising", "us"],
      ["growth", "both"],
      ["research", undefined],
    ] as const;
    for (const [botId, company] of bots) {
      await give(botId, [{ area: "fundraising", level: "read" }], company);
      const got = await call(t, grok, "investors", { agent: botId });
      expect(got.isError).toBe(false);
      expect(got.text).toContain("Made-up Fund");
    }
    expect((await call(t, mac, "investors", {})).text).toContain("Made-up Fund");
  });
});
