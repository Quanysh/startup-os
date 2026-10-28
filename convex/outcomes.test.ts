import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY, ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import { OUTCOME_WORDS } from "./lib/outcomes";
import { SUGGESTED_BOTS, suggestedPermissions } from "./lib/botRules";
import schema from "./schema";
import { OWNER, modules, signInWithAreas, type TestBackend } from "./test.setup";

// Bot Loop v3, section G: a bot logs what came of a play it ran on a deal,
// a customer, an investor or a partner (`outcome_log`), reads them back with
// a win rate per play (`outcomes`), and the owner sees them on the deal,
// customer and partner views and per bot on the Bots tab. Every name is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  const partner = await t.run((ctx) =>
    ctx.db.insert("partners", { company: "us", name: "Made-up Partner", type: "referral", stage: "contacted", order: 0 }),
  );
  const customer = (await t.run((ctx) => ctx.db.query("customers").collect())).find((c) => c.market === "us")!._id;
  return { t, ids, owner, grok: grok.token, partner, customer };
}

const log = (t: TestBackend, token: string, bot: string, args: Record<string, unknown>) =>
  call(t, token, "outcome_log", { agent: bot, company: "us", play: "cold email v2", result: "pending", evidence: "Sent the made-up email.", actedOn: "2026-10-10", ...args });

describe("outcome_log", () => {
  test("growth logs an outcome on a US deal without deal_update; it is the bot's", async () => {
    const { t, ids, grok } = await setUp();
    const logged = await log(t, grok, "growth", { subject: { kind: "deal", id: ids.usDeal }, channel: "email", signal: "reply", result: "worked" });
    expect(logged.output).toMatchObject({ id: expect.any(String), created: true });
    // Growth holds no write on sales.
    expect((await call(t, grok, "deal_update", { agent: "growth", dealId: ids.usDeal, nextStep: "x" })).refusal).toMatchObject({
      code: "not_permitted",
    });
    const rows = await t.run((ctx) => ctx.db.query("outcomes").collect());
    expect(rows).toEqual([
      expect.objectContaining({ agent: "growth", company: "us", subject: { kind: "deal", id: ids.usDeal }, result: "worked", signal: "reply" }),
    ]);
  });

  test("evidence or a play with an email address or a phone number is refused, and nothing is stored", async () => {
    const { t, ids, grok } = await setUp();
    const subject = { kind: "deal", id: ids.usDeal };
    expect((await log(t, grok, "growth", { subject, evidence: "Dana replied from dana@example.com" })).said).toBe(OUTCOME_WORDS.contact);
    expect((await log(t, grok, "growth", { subject, evidence: "Called +1 555 123 4567" })).said).toBe(OUTCOME_WORDS.contact);
    expect((await log(t, grok, "growth", { subject, play: "mail dana@example.com" })).said).toBe(OUTCOME_WORDS.contact);
    expect((await log(t, grok, "growth", { subject, evidence: "x".repeat(501) })).isError).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("outcomes").collect())).toEqual([]);
  });

  test("the subject must exist for that company", async () => {
    const { t, ids, grok, partner, customer } = await setUp();
    expect((await log(t, grok, "growth", { subject: { kind: "deal", id: ids.kzDeal } })).said).toBe(OUTCOME_WORDS.subject);
    expect((await log(t, grok, "growth", { subject: { kind: "deal", id: "nope" } })).said).toBe(OUTCOME_WORDS.subject);
    expect((await log(t, grok, "growth", { company: "kz", subject: { kind: "partner", id: partner } })).said).toBe(OUTCOME_WORDS.subject);
    expect((await log(t, grok, "growth", { company: "kz", subject: { kind: "investor", id: ids.investor } })).said).toBe(
      OUTCOME_WORDS.subject,
    );
    expect((await log(t, grok, "growth", { subject: { kind: "partner", id: partner } })).output).toMatchObject({ created: true });
    expect((await log(t, grok, "growth", { subject: { kind: "customer", id: customer } })).output).toMatchObject({ created: true });
    expect((await log(t, grok, "fundraising", { subject: { kind: "investor", id: ids.investor } })).output).toMatchObject({
      created: true,
    });
  });

  test("a pending row is updated by id, by the bot that logged it only, and once decided stays", async () => {
    const { t, ids, grok } = await setUp();
    const subject = { kind: "deal", id: ids.usDeal };
    const id = (await log(t, grok, "growth", { subject })).output.id as Id<"outcomes">;
    expect((await call(t, grok, "outcome_log", { agent: "linkedin", company: "us", id, result: "worked", evidence: "Made-up." })).said).toBe(
      OUTCOME_WORDS.notYours,
    );
    const done = await call(t, grok, "outcome_log", {
      agent: "growth",
      company: "us",
      id,
      result: "failed",
      signal: "no_reply",
      evidence: "No reply after two weeks.",
      observedOn: "2026-10-14",
    });
    expect(done.output).toMatchObject({ id, created: false });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ result: "failed", signal: "no_reply", observedOn: "2026-10-14", play: "cold email v2" });
    expect((await call(t, grok, "outcome_log", { agent: "growth", company: "us", id, result: "worked", evidence: "x" })).said).toBe(
      OUTCOME_WORDS.notPending,
    );
  });

  test("a bot without write on outcomes is refused; a caller that is no bot is refused", async () => {
    const { t, ids, owner, grok } = await setUp();
    const { token: mac } = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Plain", botsOnly: false });
    const nobody = await call(t, mac, "outcome_log", {
      company: "us",
      subject: { kind: "deal", id: ids.usDeal },
      play: "x",
      result: "pending",
      evidence: "x",
      actedOn: "2026-10-10",
    });
    expect(nobody.said).toBe(OUTCOME_WORDS.whoLogs);
    const refused = await log(t, grok, "research", { subject: { kind: "deal", id: ids.usDeal } });
    expect(refused.refusal).toEqual({ code: "not_permitted", tool: "outcome_log", area: "outcomes", need: "write" });
    // Research reads every area a bot may read: outcomes too.
    expect((await call(t, grok, "outcomes", { agent: "research" })).output).toMatchObject({ rows: [] });
  });
});

describe("outcomes (read)", () => {
  test("filters, and a win rate per play: worked of worked and failed", async () => {
    const { t, ids, grok, partner } = await setUp();
    const deal = { kind: "deal", id: ids.usDeal };
    await log(t, grok, "growth", { subject: deal, result: "worked", actedOn: "2026-10-01" });
    await log(t, grok, "growth", { subject: deal, result: "worked", actedOn: "2026-10-05" });
    await log(t, grok, "growth", { subject: deal, result: "failed", actedOn: "2026-10-06" });
    await log(t, grok, "growth", { subject: deal, result: "pending", actedOn: "2026-10-07" });
    await log(t, grok, "partnerships", { subject: { kind: "partner", id: partner }, play: "intro call", result: "failed", actedOn: "2026-09-01" });

    const all = await call(t, grok, "outcomes", { agent: "growth" });
    expect(all.output.plays).toEqual([
      { play: "cold email v2", worked: 2, failed: 1, pending: 1, winRate: 2 / 3 },
      { play: "intro call", worked: 0, failed: 1, pending: 0, winRate: 0 },
    ]);
    expect(all.output.rows).toHaveLength(5);
    // Newest first.
    expect(all.output.rows[0]).toMatchObject({ actedOn: "2026-10-07", by: "growth" });

    const since = await call(t, grok, "outcomes", { agent: "growth", since: "2026-10-05" });
    expect(since.output.rows).toHaveLength(3);
    const byBot = await call(t, grok, "outcomes", { agent: "growth", by: "partnerships" });
    expect(byBot.output.plays).toEqual([{ play: "intro call", worked: 0, failed: 1, pending: 0, winRate: 0 }]);
    const failed = await call(t, grok, "outcomes", { agent: "growth", result: "failed", play: "cold email v2" });
    expect(failed.output.rows).toHaveLength(1);
    expect((await call(t, grok, "outcomes", { agent: "growth", company: "kz" })).output.rows).toEqual([]);
  });
});

describe("in the app", () => {
  test("a deal's, a customer's and a partner's timeline, newest first; someone without the area is refused", async () => {
    const { t, ids, owner, grok, partner } = await setUp();
    await log(t, grok, "growth", { subject: { kind: "deal", id: ids.usDeal }, actedOn: "2026-10-01" });
    await log(t, grok, "growth", { subject: { kind: "deal", id: ids.usDeal }, actedOn: "2026-10-09", result: "worked" });
    await log(t, grok, "partnerships", { subject: { kind: "partner", id: partner } });
    const timeline = await owner.query(api.outcomes.forSubject, { kind: "deal", id: ids.usDeal });
    expect(timeline.map((row) => row.actedOn)).toEqual(["2026-10-09", "2026-10-01"]);
    expect(timeline[0]).toMatchObject({ by: "growth", play: "cold email v2", result: "worked", evidence: "Sent the made-up email." });
    expect(await owner.query(api.outcomes.forSubject, { kind: "partner", id: partner })).toHaveLength(1);
    expect(await owner.query(api.outcomes.forSubject, { kind: "deal", id: "not-an-id" })).toEqual([]);

    const seller = await signInWithAreas(t, "sales", ["sales"]);
    await expect(seller.query(api.outcomes.forSubject, { kind: "deal", id: ids.usDeal })).rejects.toThrow();
  });

  test("the Bots tab's plays: per bot, per play, within the window", async () => {
    const { t, ids, owner, grok } = await setUp();
    await log(t, grok, "growth", { subject: { kind: "deal", id: ids.usDeal }, result: "worked", actedOn: "2026-10-10" });
    await log(t, grok, "growth", { subject: { kind: "deal", id: ids.usDeal }, result: "failed", actedOn: "2026-08-01" });
    const plays = await owner.query(api.outcomes.playsByBot, { since: NOW - 30 * DAY });
    expect(plays).toEqual([{ by: "growth", plays: [{ play: "cold email v2", worked: 1, failed: 0, pending: 0, winRate: 1 }] }]);
  });
});

describe("the bots' defaults", () => {
  test("write for six bots, read for the rest", () => {
    const writers = ["growth", "globex_ai_sales", "customer_success", "fundraising", "partnerships", "linkedin"];
    for (const bot of SUGGESTED_BOTS) {
      const level = suggestedPermissions(bot).find((p) => p.area === "outcomes")?.level;
      expect([bot.id, level]).toEqual([bot.id, writers.includes(bot.id) ? "write" : "read"]);
    }
  });

  test("bots made before the area get its default once; a level the owner set stays", async () => {
    const { t, owner } = await setUp();
    // As made before the area existed: none on outcomes.
    await t.run(async (ctx) => {
      for (const bot of await ctx.db.query("bots").collect()) {
        await ctx.db.patch(bot._id, { permissions: bot.permissions.filter((p) => p.area !== "outcomes") });
      }
      const support = (await ctx.db.query("bots").collect()).find((b) => b.botId === "support")!;
      await ctx.db.patch(support._id, { permissions: [...support.permissions, { area: "outcomes", level: "write" }] });
    });
    const ran = await t.mutation(internal.outcomes.grantDefaults, {});
    expect(ran).toEqual({ write: 6, read: 3, kept: 1 });
    const bots = await t.run((ctx) => ctx.db.query("bots").collect());
    const level = (id: string) => bots.find((b) => b.botId === id)!.permissions.find((p) => p.area === "outcomes")?.level;
    expect(level("growth")).toBe("write");
    expect(level("research")).toBe("read");
    expect(level("support")).toBe("write");
    expect((await t.mutation(internal.outcomes.grantDefaults, {})).kept).toBe(10);
    void owner;
  });
});
