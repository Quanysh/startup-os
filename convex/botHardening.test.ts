import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { BOT_WORDS, CALLER_TOOL_CALLS } from "./lib/botRules";
import { AGENT_HEADER } from "./lib/osAgents";
import { approve, exchange, publicClient } from "./oauth.kit";
import { ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// The security review of the bots' branches (2026-10-19): `whoami` and
// `bot_rules` are metered and cannot flood the audit; auto-approval needs a
// credential bound to the bot; removing a bot takes its credentials and grants
// with it; a bot that lost write on a kind's area loses auto-approval.
// Made-up names throughout.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("SITE_URL", "https://os.example.test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner, token } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, token, grok: grok.token };
}

const audit = (t: TestBackend) => t.run((ctx) => ctx.db.query("agentCalls").collect());

describe("whoami and bot_rules are metered", () => {
  test("a loop of 1,000 whoami calls is refused past the limit and does not flood the audit", { timeout: 120_000 }, async () => {
    const { t, grok } = await setUp();
    // Another call on record first: the loop must not push it out.
    expect((await call(t, grok, "goals", { agent: "growth" })).said).toBeNull();
    const [first] = await audit(t);

    let answered = 0;
    let refused = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const reply = await call(t, grok, "whoami", { agent: "growth" });
      if (reply.said === null) answered += 1;
      else {
        refused += 1;
        expect(reply.refusal).toMatchObject({ code: "rate_limited", limit: "caller_calls", max: CALLER_TOOL_CALLS });
      }
    }
    expect(answered).toBe(CALLER_TOOL_CALLS);
    expect(refused).toBe(1_000 - CALLER_TOOL_CALLS);

    const rows = await audit(t);
    // The first call, one whoami answered and one limit refusal: nothing more.
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r._id)).toContain(first!._id);
    expect(rows.filter((r) => r.tool === "whoami").map((r) => r.outcome).sort()).toEqual(["ok", "refused"]);
  });

  test("a client naming no bot is metered too, and a new window answers again", async () => {
    const { t, token } = await setUp();
    for (let i = 0; i < CALLER_TOOL_CALLS; i += 1) {
      expect((await call(t, token, "bot_rules", {})).said).toBeNull();
    }
    expect((await call(t, token, "whoami", {})).refusal).toMatchObject({ code: "rate_limited", limit: "caller_calls" });
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    expect((await call(t, token, "whoami", {})).said).toBeNull();
    // One answered row a window, one refusal in the first.
    expect((await audit(t)).length).toBe(3);
  });

  test("a loop of whoami naming an unknown bot is noted once a window", async () => {
    const { t, grok } = await setUp();
    for (let i = 0; i < 20; i += 1) {
      expect((await call(t, grok, "whoami", { agent: "nobody-here" })).said).toBe(BOT_WORDS.unknown);
    }
    const rows = await audit(t);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ tool: "whoami", outcome: "refused", refusal: { code: "unknown_bot" } });
  });
});

const botId = (t: TestBackend, id: string) =>
  t.run(async (ctx) => (await ctx.db.query("bots").collect()).find((b) => b.botId === id)!._id);
const proposalsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());

/** Growth's grant for `task_create`, as `trust.grant` writes it once earned. */
async function grantGrowth(t: TestBackend) {
  const userId = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
  await t.run((ctx) => ctx.db.insert("autonomyGrants", { userId, proposer: "growth", kind: "task_create", grantedAt: NOW }));
}

let keys = 0;
const newTask = (agent: string | null) => ({
  ...(agent === null ? null : { agent }),
  company: "us",
  kind: "task_create",
  why: "Made-up why.",
  dedupeKey: `bot-growth:task_create:made-up-${(keys += 1)}`,
  payload: { title: `Made-up task ${keys}` },
});

/** One `tools/call` at a bot's own connector address. */
async function atAddress(t: TestBackend, bot: string, token: string, name: string, args: unknown) {
  const response = await t.fetch(`/mcp/v1/bot/${bot}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await response.json()) as any;
}

describe("auto-approval needs a credential bound to the bot", () => {
  test("a bot named on a shared client is not auto-approved: the proposal waits, attributed as usual", async () => {
    const { t, grok } = await setUp();
    await grantGrowth(t);
    const made = await call(t, grok, "propose", newTask("growth"));
    expect(made.output).toMatchObject({ proposed: true });
    expect(made.output.autoApproved).toBeUndefined();
    const [row] = await proposalsOf(t);
    expect(row).toMatchObject({ bot: "growth", status: "open" });
  });

  test("at the bot's own address, or through its own token, the grant holds", async () => {
    const { t, owner, grok } = await setUp();
    await grantGrowth(t);
    const there = await atAddress(t, "growth", grok, "propose", newTask(null));
    expect(there.result.structuredContent).toMatchObject({ proposed: true, autoApproved: { taskId: expect.any(String) } });
    const { token } = await owner.mutation(api.bots.makeToken, { id: await botId(t, "growth"), entropy: ENTROPY });
    const own = await call(t, token, "propose", newTask("growth"));
    expect(own.output).toMatchObject({ proposed: true, autoApproved: { taskId: expect.any(String) } });
    expect((await proposalsOf(t)).map((p) => p.status)).toEqual(["auto_approved", "auto_approved"]);
  });

  test("a token made for one bot refuses no name and the four's even with bots-only switched off", async () => {
    const { t, owner } = await setUp();
    const made = await owner.mutation(api.bots.makeToken, { id: await botId(t, "growth"), entropy: ENTROPY });
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: made.id, on: false });
    const none = await call(t, made.token, "goals", {});
    expect(none.refusal).toMatchObject({ code: "bots_only" });
    expect((await call(t, made.token, "goals", {}, { [AGENT_HEADER]: "sales" })).refusal).toMatchObject({ code: "bots_only" });
    // The chief of staff named through it is the external profile, and the token is another bot's.
    expect((await call(t, made.token, "goals", { agent: "chief_of_staff" })).refusal).toMatchObject({ code: "wrong_client" });
    expect((await call(t, made.token, "goals", { agent: "growth" })).said).toBeNull();
  });
});

describe("removing a bot", () => {
  test("revokes its grants, forgets its trust, and deletes the credentials made for it", async () => {
    const { t, owner, grok } = await setUp();
    await grantGrowth(t);
    await call(t, grok, "propose", newTask("growth"));
    const [open] = await proposalsOf(t);
    await owner.mutation(api.assistant.approve, { id: open!._id });
    expect(await t.run((ctx) => ctx.db.query("botTrust").collect())).toHaveLength(1);

    const growth = await botId(t, "growth");
    const clientId = await publicClient(t);
    const resource = "https://os.example.test/mcp/v1/bot/growth";
    const { code } = await approve(owner, clientId, "act", { resource });
    const access = (await exchange(t, clientId, code, { resource })).body.access_token as string;
    expect((await atAddress(t, "growth", access, "goals", {})).result.isError).toBe(false);
    // Made after: its token becomes Growth's only client.
    const own = await owner.mutation(api.bots.makeToken, { id: growth, entropy: ENTROPY });
    // A grant made at the plain address is no bot's: it stays.
    const plain = await publicClient(t);
    const plainCode = (await approve(owner, plain, "act")).code;
    await exchange(t, plain, plainCode);

    await owner.mutation(api.bots.remove, { id: growth });

    const grants = await t.run((ctx) => ctx.db.query("autonomyGrants").collect());
    expect(grants).toEqual([expect.objectContaining({ proposer: "growth", revokedBy: "owner", revokedAt: NOW })]);
    expect(await t.run((ctx) => ctx.db.query("botTrust").collect())).toEqual([]);
    const tokens = await t.run((ctx) => ctx.db.query("agentTokens").collect());
    expect(tokens.some((row) => row.onlyBot === "growth")).toBe(false);
    expect(tokens.some((row) => row._id === own.id)).toBe(false);
    const oauth = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(oauth.map((g) => g.onlyBot ?? null)).toEqual([null]);

    // The same id made again starts clean, and the old credentials are refused.
    await owner.mutation(api.bots.create, { botId: "growth", name: "Growth Bot", role: "Growth" });
    expect(await owner.query(api.trust.grants, {})).toEqual([]);
    expect((await call(t, own.token, "goals", { agent: "growth" })).status).toBe(401);
    const response = await t.fetch("/mcp/v1/bot/growth", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(access) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
    // A proposal through a credential bound to it waits for the owner again.
    const there = await atAddress(t, "growth", grok, "propose", newTask(null));
    expect(there.result.structuredContent.autoApproved).toBeUndefined();
  });
});

describe("a bot that lost write on a kind's area", () => {
  test("loses auto-approval, its grant listed as paused; write back resumes it", async () => {
    const { t, owner, grok } = await setUp();
    await grantGrowth(t);
    const growth = await botId(t, "growth");
    // Growth writes gtm and board; take board (task_create's area) down to read.
    await owner.mutation(api.bots.update, {
      id: growth,
      permissions: [
        { area: "gtm", level: "write" },
        { area: "board", level: "read" },
      ],
    });
    const held = await atAddress(t, "growth", grok, "propose", newTask(null));
    expect(held.result.structuredContent.autoApproved).toBeUndefined();
    expect((await proposalsOf(t)).map((p) => p.status)).toEqual(["open"]);
    expect(await owner.query(api.trust.grants, {})).toEqual([
      expect.objectContaining({ proposer: "growth", kind: "task_create", paused: { area: "board", name: expect.any(String) } }),
    ]);
    expect((await call(t, grok, "whoami", { agent: "growth" })).output.autoApproved).toEqual([]);

    await owner.mutation(api.bots.grant, { id: growth, area: "board", level: "write" });
    const again = await atAddress(t, "growth", grok, "propose", newTask(null));
    expect(again.result.structuredContent).toMatchObject({ autoApproved: { taskId: expect.any(String) } });
    expect(await owner.query(api.trust.grants, {})).toEqual([expect.objectContaining({ paused: null })]);
  });
});
