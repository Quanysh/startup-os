import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS } from "./lib/agentRules";
import { BOT_PERMISSION_WORDS, BOT_WORDS, DEFAULT_BOT_LIMITS, limitWords } from "./lib/botRules";
import { AGENT_HEADER } from "./lib/osAgents";
import { ENTROPY, NOW, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Revision 6, items 4 and 5: every refusal a bot meets carries a code and
// details in `structuredContent`, beside the same words; a bot asks for a
// permission with `permission_request` (a `bot_permission` proposal the
// owner approves on /approvals); and a bot reads what was decided for it,
// and the handoffs addressed to it, with `my_inbox`. Made-up names.

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
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  const reader = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "read", name: "Read bot" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token, grokId: grok.id, reader: reader.token };
}

const botOf = async (t: TestBackend, botId: string) =>
  (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === botId)!;

describe("refusal codes", () => {
  test("not permitted: the tool, its area and the level it needs, beside the same words", async () => {
    const { t, grok } = await setUp();
    const write = await call(t, grok, "deal_update", { agent: "partnerships", dealId: "x", nextStep: "Made-up" });
    expect(write.said).toBe(BOT_WORDS.notAllowed);
    expect(write.refusal).toEqual({ code: "not_permitted", tool: "deal_update", area: "sales", need: "write" });
    const read = await call(t, grok, "customers", { agent: "partnerships" });
    expect(read.refusal).toEqual({ code: "not_permitted", tool: "customers", area: "customers", need: "read" });
    // A tool of a locked area says so: no permission can open it.
    const locked = await call(t, grok, "costs", { agent: "partnerships" });
    expect(locked.refusal).toEqual({ code: "not_permitted", tool: "costs", area: "costs", need: "read", locked: true });
  });

  test("unknown, switched off, wrong client, two names", async () => {
    const { t, owner, mac, grok, grokId } = await setUp();
    expect((await call(t, grok, "goals", { agent: "made_up_bot" })).refusal).toEqual({ code: "unknown_bot" });
    const growth = await botOf(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, clients: [{ kind: "token", id: grokId as string }] });
    expect((await call(t, mac, "goals", { agent: "growth" })).refusal).toEqual({ code: "wrong_client" });
    await owner.mutation(api.bots.update, { id: growth._id, enabled: false });
    expect((await call(t, grok, "goals", { agent: "growth" })).refusal).toEqual({ code: "bot_off" });
    const two = await call(t, grok, "goals", { agent: "research" }, { [AGENT_HEADER]: "fundraising" });
    expect(two.said).toBe(BOT_WORDS.wrongAgent);
    expect(two.refusal).toEqual({ code: "wrong_agent" });
  });

  test("bots only and read only", async () => {
    const { t, grok, reader } = await setUp();
    const nameless = await call(t, grok, "goals", {});
    expect(nameless.said).toBe(BOT_WORDS.botsOnly);
    expect(nameless.refusal).toEqual({ code: "bots_only" });
    const reading = await call(t, reader, "task_create", { agent: "fundraising", title: "Made-up" });
    expect(reading.said).toBe(AGENT_WORDS.readOnly);
    expect(reading.refusal).toEqual({ code: "read_only" });
  });

  test("rate limited: which limit, its size and when it resets, as a tool error a bot can read", async () => {
    const { t, owner, grok } = await setUp();
    const research = await botOf(t, "research");
    await owner.mutation(api.bots.update, { id: research._id, limits: { ...DEFAULT_BOT_LIMITS, callsPer10Min: 1 } });
    await call(t, grok, "goals", { agent: "research" });
    const over = await call(t, grok, "goals", { agent: "research" });
    expect(over.said).toBe(limitWords("calls", 1, NOW + 10 * 60 * 1000));
    expect(over.refusal).toEqual({
      code: "rate_limited",
      limit: "calls",
      max: 1,
      resetsAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });
  });

  test("the audit keeps the code (and a not-permitted call's area), never what was sent", async () => {
    const { t, grok } = await setUp();
    await call(t, grok, "deal_update", { agent: "partnerships", dealId: "made-up-id", nextStep: "Made-up step" });
    await call(t, grok, "goals", { agent: "made_up_bot" });
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.find((row) => row.bot === "partnerships")!.refusal).toEqual({ code: "not_permitted", area: "sales", need: "write" });
    expect(rows.find((row) => row.bot === undefined)!.refusal).toEqual({ code: "unknown_bot" });
    expect(JSON.stringify(rows)).not.toContain("Made-up step");
    expect(JSON.stringify(rows)).not.toContain("made_up_bot");
  });
});

describe("permission_request", () => {
  test("any known bot may ask; it lands in /approvals as bot_permission; approving changes the bot's profile", async () => {
    const { t, owner, grok } = await setUp();
    // Partnerships writes nothing in sales, and may still ask.
    const asked = await call(t, grok, "permission_request", {
      agent: "partnerships",
      area: "sales",
      level: "write",
      reason: "To set next steps on partner deals.",
    });
    expect(asked.output).toMatchObject({ proposed: true });
    const inbox = await owner.query(api.assistant.inbox, {});
    const row = inbox.find((p) => p.kind === "bot_permission")!;
    expect(row).toMatchObject({ bot: "partnerships", payload: { bot: "partnerships", area: "sales", level: "write" } });
    await owner.mutation(api.assistant.approve, { id: row.id as Id<"proposals"> });
    const bot = await botOf(t, "partnerships");
    expect(bot.permissions).toContainEqual({ area: "sales", level: "write" });
    // Now permitted.
    expect((await call(t, grok, "deal_update", { agent: "partnerships", dealId: "x", nextStep: "Made-up" })).refusal).toBeNull();
  });

  test("a locked area, a level held already, and a caller that is no bot are refused", async () => {
    const { t, owner, grok, grokId } = await setUp();
    const locked = await call(t, grok, "permission_request", { agent: "growth", area: "payroll", level: "read", reason: "Made-up." });
    expect(locked.said).toBe(BOT_WORDS.locked);
    const held = await call(t, grok, "permission_request", { agent: "growth", area: "gtm", level: "read", reason: "Made-up." });
    expect(held.said).toBe(BOT_PERMISSION_WORDS.held);
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId as string, on: false });
    const nobody = await call(t, grok, "permission_request", { area: "sales", level: "read", reason: "Made-up." });
    expect(nobody.said).toBe(BOT_PERMISSION_WORDS.botsOnly);
    // And `propose` cannot make one for another bot.
    const crafted = await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "bot_permission",
      reason: "Made-up.",
      dedupeKey: "growth:bot_permission:x",
      payload: { bot: "research", area: "sales", level: "write" },
    });
    expect(crafted.isError).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("proposals").collect())).filter((p) => p.kind === "bot_permission")).toEqual([]);
  });

  test("a rejection's reason reaches the bot through proposals_feedback and my_inbox", async () => {
    const { t, owner, grok } = await setUp();
    await call(t, grok, "permission_request", { agent: "partnerships", area: "customers", level: "read", reason: "Made-up reason." });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "bot_permission")!;
    await owner.mutation(api.assistant.dismiss, { id: row.id as Id<"proposals">, reason: "Not this quarter" });
    const feedback = await call(t, grok, "proposals_feedback", { agent: "partnerships" });
    expect(feedback.output.rows).toEqual([
      expect.objectContaining({ kind: "bot_permission", status: "dismissed", dismissReason: "Not this quarter", bot: "partnerships" }),
    ]);
    // Another bot is told nothing of it.
    expect((await call(t, grok, "proposals_feedback", { agent: "research" })).output.rows).toEqual([]);
    const inbox = await call(t, grok, "my_inbox", { agent: "partnerships" });
    expect(inbox.output.permissions).toEqual([
      expect.objectContaining({ area: "customers", level: "read", status: "dismissed", reason: "Not this quarter" }),
    ]);
  });
});

describe("my_inbox", () => {
  test("handoffs addressed to the bot, its proposals decided since the cursor, and the next cursor", async () => {
    const { t, owner, grok } = await setUp();
    await call(t, grok, "handoff_create", {
      agent: "research",
      company: "us",
      to: "strategy_advisor",
      title: "Made-up research done",
      summary: "Made-up summary.",
    });
    await call(t, grok, "handoff_create", { agent: "research", company: "us", to: "linkedin", title: "Made-up other", summary: "x" });
    await call(t, grok, "goal_create", {
      agent: "strategy_advisor",
      company: "us",
      quarter: "2026-Q4",
      title: "Made-up goal",
      reason: "Made-up.",
    });
    const goal = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "goal_create")!;
    vi.setSystemTime(NOW + 60_000);
    await owner.mutation(api.assistant.approve, { id: goal.id as Id<"proposals"> });

    const first = await call(t, grok, "my_inbox", { agent: "strategy_advisor" });
    expect(first.output.you).toBe("strategy_advisor");
    expect(first.output.handoffs.map((h: { title: string }) => h.title)).toEqual(["Made-up research done"]);
    expect(first.output.decided).toEqual([expect.objectContaining({ kind: "goal_create", status: "approved" })]);
    expect(first.output.cursor).toBe(NOW + 60_000);
    // Since the cursor: nothing new.
    vi.setSystemTime(NOW + 120_000);
    const next = await call(t, grok, "my_inbox", { agent: "strategy_advisor", since: first.output.cursor + 1 });
    expect(next.output.decided).toEqual([]);
  });

  test("a call naming no bot is refused", async () => {
    const { t, owner, grok, grokId } = await setUp();
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId as string, on: false });
    expect((await call(t, grok, "my_inbox", {})).said).toBe(BOT_PERMISSION_WORDS.botsOnly);
  });
});

describe("the Bots tab's activity", () => {
  test("last calls, refusals today by code, and refused often lately", async () => {
    const { t, owner, grok } = await setUp();
    for (let n = 0; n < 6; n++) {
      vi.setSystemTime(NOW + n * 1000);
      await call(t, grok, "deal_update", { agent: "partnerships", dealId: "x", nextStep: "Made-up" });
    }
    vi.setSystemTime(NOW + 10_000);
    await call(t, grok, "deals", { agent: "partnerships" });
    const activity = await owner.query(api.bots.activity, { since: NOW - 60_000 });
    const partnerships = activity.find((row) => row.botId === "partnerships")!;
    expect(partnerships.recent).toHaveLength(7);
    expect(partnerships.recent[0]).toMatchObject({ tool: "deals", outcome: "ok", code: null });
    expect(partnerships.recent[1]).toMatchObject({ tool: "deal_update", outcome: "refused", code: "not_permitted" });
    expect(partnerships.refusals).toEqual([{ code: "not_permitted", area: "sales", need: "write", count: 6 }]);
    const lately = await owner.query(api.bots.refusedLately, { since: NOW - 60 * 60 * 1000 });
    expect(lately).toEqual([expect.objectContaining({ botId: "partnerships", refusals: 6 })]);
  });

  test("Grant gives the level in one click, never a locked area", async () => {
    const { t, owner } = await setUp();
    const partnerships = await botOf(t, "partnerships");
    await owner.mutation(api.bots.grant, { id: partnerships._id, area: "sales", level: "write" });
    expect((await botOf(t, "partnerships")).permissions).toContainEqual({ area: "sales", level: "write" });
    await expect(owner.mutation(api.bots.grant, { id: partnerships._id, area: "costs", level: "read" })).rejects.toThrow(
      BOT_WORDS.locked,
    );
  });

  test("Grant makes the checks an approved permission request makes: on, not held already, never locked", async () => {
    const { t, owner } = await setUp();
    const partnerships = await botOf(t, "partnerships");
    // It reads sales already: granting read again is refused, as approving that request would be.
    await expect(owner.mutation(api.bots.grant, { id: partnerships._id, area: "sales", level: "read" })).rejects.toThrow(
      BOT_PERMISSION_WORDS.held,
    );
    await t.run((ctx) => ctx.db.patch(partnerships._id, { enabled: false }));
    await expect(owner.mutation(api.bots.grant, { id: partnerships._id, area: "sales", level: "write" })).rejects.toThrow(
      BOT_WORDS.off,
    );
    expect((await botOf(t, "partnerships")).permissions).not.toContainEqual({ area: "sales", level: "write" });
  });
});
