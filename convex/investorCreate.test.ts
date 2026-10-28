import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS } from "./lib/agentRules";
import { INVESTOR_TOOL_WORDS } from "./lib/pipelineCards";
import { ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// `investor_create` is the fundraising bot's way to add a firm, through the
// same function the page's "Add an investor" runs. Write on fundraising is
// what lets a bot call it: the suggested fundraising bot has it, and no other
// suggested bot does. Every name is made up.

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
  return { t, ids, owner, grok: grok.token };
}

const investors = (t: TestBackend) => t.run((ctx) => ctx.db.query("investors").collect());

describe("investor_create", () => {
  test("the fundraising bot adds an investor through the board's own create, and the row records the bot", async () => {
    const { t, owner, grok } = await setUp();
    const reply = await call(t, grok, "investor_create", {
      agent: "fundraising",
      name: "Northwind Capital",
      stage: "diligence",
      partner: "Made-up Partner, General Partner",
      checkSize: 500_000,
      notes: "Met at a made-up conference",
      nextStep: "Send the deck",
      source: "Warm intro",
    });
    expect(reply.output).toMatchObject({ created: true });
    const id = reply.output.id as Id<"investors">;
    const board = await owner.query(api.investors.board, {});
    expect(board.diligence.find((card) => card.id === id)).toMatchObject({
      name: "Northwind Capital",
      contact: "Made-up Partner, General Partner",
      amount: 500_000,
      notes: "Met at a made-up conference",
      nextStep: "Send the deck",
      source: "manual",
      mirrored: false,
      createdBy: "fundraising",
      referralSource: "Warm intro",
    });
    const row = (await investors(t)).find((investor) => investor._id === id)!;
    expect(row.createdBy).toBe("fundraising");
    expect(row.source).toBe("manual");
    const calls = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(calls.find((call) => call.tool === "investor_create")).toMatchObject({ bot: "fundraising", kind: "act", outcome: "ok" });
    expect(JSON.stringify(calls)).not.toContain("Northwind");
  });

  test("a bot without write on fundraising is refused, and nothing is added", async () => {
    const { t, grok } = await setUp();
    const before = (await investors(t)).length;
    for (const agent of ["growth", "research"]) {
      const reply = await call(t, grok, "investor_create", { agent, name: "Made-up Second Fund" });
      expect(reply.refusal).toEqual({ code: "not_permitted", tool: "investor_create", area: "fundraising", need: "write" });
    }
    expect(await investors(t)).toHaveLength(before);
  });

  test("a firm already here, under a normalized name, comes back as that id and is not written again", async () => {
    const { t, ids, grok } = await setUp();
    const before = JSON.stringify(await t.run((ctx) => ctx.db.get(ids.investor)));
    const reply = await call(t, grok, "investor_create", {
      agent: "fundraising",
      name: "  example fund, LLC ",
      notes: "This must not land",
      partner: "Somebody Else",
      checkSize: 1,
    });
    expect(reply.output).toEqual({ id: ids.investor, created: false, truncated: false });
    expect(JSON.stringify(await t.run((ctx) => ctx.db.get(ids.investor)))).toBe(before);
    expect(await investors(t)).toHaveLength(1);
  });

  test("a card still on the board wins over an archived one of the same name", async () => {
    const { t, owner, grok } = await setUp();
    await t.run((ctx) =>
      ctx.db.insert("investors", {
        source: "manual",
        externalId: "archived-split",
        name: "Split Capital, LLC",
        stage: "passed",
        order: 0,
        archivedAt: NOW - 1,
        lastActivityAt: NOW - 1,
      }),
    );
    const live = await owner.mutation(api.investors.create, { name: "Split Capital", stage: "meeting" });
    const reply = await call(t, grok, "investor_create", { agent: "fundraising", name: "split capital inc" });
    expect(reply.output.id).toBe(live);
    expect(reply.output.created).toBe(false);
  });

  test("an email address or a phone number in the partner or the source is refused, and nothing is added", async () => {
    const { t, grok } = await setUp();
    const before = (await investors(t)).length;
    const partner = await call(t, grok, "investor_create", {
      agent: "fundraising",
      name: "Made-up Mail Fund",
      partner: "Made-up person@example.test",
    });
    expect(partner.said).toBe(INVESTOR_TOOL_WORDS.contact);
    expect(partner.refusal).toEqual({ code: "contact_detail" });
    const source = await call(t, grok, "investor_create", {
      agent: "fundraising",
      name: "Made-up Phone Fund",
      source: "Intro via +1 (415) 555-0100",
    });
    expect(source.said).toBe(INVESTOR_TOOL_WORDS.source);
    expect(source.refusal).toEqual({ code: "contact_detail" });
    expect(await investors(t)).toHaveLength(before);
  });

  test("a bot working for Globex is refused, even with write on fundraising", async () => {
    const { t, owner, grok } = await setUp();
    const bot = (await t.run((ctx) => ctx.db.query("bots").collect())).find((row) => row.botId === "fundraising")!;
    await owner.mutation(api.bots.update, { id: bot._id, company: "kz" });
    const before = (await investors(t)).length;
    const reply = await call(t, grok, "investor_create", { agent: "fundraising", name: "Made-up KZ Fund" });
    expect(reply.said).toBe(AGENT_WORDS.notAllowed);
    expect(await investors(t)).toHaveLength(before);
  });
});
