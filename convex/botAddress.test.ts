import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { BOT_WORDS, botAddressOf } from "./lib/botRules";
import { protectedResourceMetadata } from "./lib/oauthRules";
import { AGENT_HEADER } from "./lib/osAgents";
import { ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import { REDIRECT, VERIFIER, approve, exchange, get, publicClient } from "./oauth.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner } from "./test.setup";

// One connector address per bot (docs/assistant.md, "Bots"): the bot is the
// path's, not anything the call sends, so a client that cannot send a name
// (Grok's connector keeps the tool list it was given) still calls as its bot.
// `whoami` and the versioned rules. Made-up names throughout.

const SITE = "https://os.example.test";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("SITE_URL", SITE);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;
// Tests reach into answers by key; what each holds is asserted there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, grok: grok.token };
}

/** One JSON-RPC request at a path. */
async function at(t: T, path: string, token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === null ? {} : bearer(token)), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text === "" ? {} : JSON.parse(text)) as Record<string, Loose> };
}

/** One `tools/call` at a bot's address: its answer, or the words it was refused in. */
async function botCall(t: T, bot: string, token: string, name: string, args: unknown = {}, headers: Record<string, string> = {}) {
  const reply = await at(t, `/mcp/v1/bot/${bot}`, token, "tools/call", { name, arguments: args }, headers);
  const result = reply.body.result;
  return {
    ...reply,
    said: result?.isError ? (result.content[0].text as string) : null,
    output: result && !result.isError ? (result.structuredContent as Record<string, Loose>) : null,
  };
}

const auditBots = (t: T) => t.run(async (ctx) => (await ctx.db.query("agentCalls").collect()).map((row) => row.bot ?? null));

describe("a bot's own connector address", () => {
  test("a call there is that bot's with no name sent, on a client only bots may use", async () => {
    const { t, grok } = await setUp();
    const done = await botCall(t, "growth", grok, "goals", {});
    expect(done.said).toBeNull();
    expect(done.output).not.toBeNull();
    expect(await auditBots(t)).toEqual(["growth"]);
    // The same call at the plain address names no bot, and the client is bots-only.
    expect((await call(t, grok, "goals", {})).said).toBe(BOT_WORDS.botsOnly);
  });

  test("a name in the call that disagrees with the address is refused; one that agrees is fine", async () => {
    const { t, grok } = await setUp();
    expect((await botCall(t, "growth", grok, "goals", { agent: "research" })).said).toBe(BOT_WORDS.notThisAddress);
    expect((await botCall(t, "growth", grok, "goals", { bot: "research" })).said).toBe(BOT_WORDS.notThisAddress);
    expect((await botCall(t, "growth", grok, "goals", { agent: "finance" })).said).toBe(BOT_WORDS.notThisAddress);
    expect((await botCall(t, "growth", grok, "goals", {}, { [AGENT_HEADER]: "research" })).said).toBe(BOT_WORDS.notThisAddress);
    expect((await botCall(t, "growth", grok, "goals", {}, { [AGENT_HEADER]: "finance" })).said).toBe(BOT_WORDS.notThisAddress);
    expect((await botCall(t, "growth", grok, "goals", { agent: "growth" })).output).not.toBeNull();
    expect((await botCall(t, "growth", grok, "goals", {}, { [AGENT_HEADER]: "growth" })).output).not.toBeNull();
  });

  test("its tools are the bot's profile's, whoever the client is", async () => {
    const { t, grok } = await setUp();
    const listed = (await at(t, "/mcp/v1/bot/growth", grok, "tools/list")).body.result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toContain("whoami");
    expect(listed).toContain("bot_rules");
    expect(listed).toContain("linkedin_post_upsert");
    expect(listed).not.toContain("overview");
    expect(listed).not.toContain("deal_update");
    // A bot it may not use, a tool it may not call.
    expect((await botCall(t, "growth", grok, "deal_update", { id: "x", nextStep: "y" })).said).toBe(BOT_WORDS.notAllowed);
    expect((await botCall(t, "nobody_here", grok, "goals", {})).said).toBe(BOT_WORDS.unknown);
  });

  test("an address that is no bot's shape, or one of the four's, is not there", async () => {
    const { t, grok } = await setUp();
    for (const path of ["/mcp/v1/bot/Growth", "/mcp/v1/bot/sales", "/mcp/v1/bot/", "/mcp/v1/bot/growth/x", "/mcp/v1/bot/g"]) {
      const reply = await at(t, path, grok, "ping");
      expect(reply.status).toBe(404);
    }
  });

  test("with no credential it says where this address's sign-in is described", async () => {
    const { t } = await setUp();
    const reply = await at(t, "/mcp/v1/bot/growth", null, "ping");
    expect(reply.status).toBe(401);
    expect(reply.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp/v1/bot/growth"`,
    );
    const getReply = await t.fetch("/mcp/v1/bot/growth", { method: "GET" });
    expect(getReply.status).toBe(405);
  });

  test("a token made for one bot works at that bot's address and not at another's", async () => {
    const { t, owner } = await setUp();
    const research = (await owner.query(api.bots.list, { today: "2026-10-14" })).bots.find((b) => b.botId === "research")!;
    const { token } = await owner.mutation(api.bots.makeToken, { id: research.id, entropy: ENTROPY });
    expect((await botCall(t, "research", token, "goals", {})).output).not.toBeNull();
    expect((await botCall(t, "growth", token, "goals", {})).said).toBe(BOT_WORDS.tokenForBot);
  });
});

describe("signing in at a bot's address", () => {
  const resource = (bot: string) => `${SITE}/mcp/v1/bot/${bot}`;

  test("its protected resource's metadata names that address", async () => {
    const t = convexTest(schema, modules);
    const reply = await get(t, "/.well-known/oauth-protected-resource/mcp/v1/bot/growth");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(protectedResourceMetadata(SITE, "growth"));
    expect(reply.body.resource).toBe(resource("growth"));
    expect((await get(t, "/.well-known/oauth-protected-resource/mcp/v1/bot/Not-A-Bot")).status).toBe(404);
  });

  async function signedInAt(t: T, bot: string) {
    const owner = await signInAsOwner(t);
    await owner.mutation(api.bots.addSuggested, {});
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId, "act", { resource: resource(bot) });
    const reply = await exchange(t, clientId, code, { resource: resource(bot) });
    expect(reply.status).toBe(200);
    return { owner, access: reply.body.access_token as string };
  }

  test("a grant made there is that bot's alone: not another bot's address, not the plain one", async () => {
    const t = convexTest(schema, modules);
    const { access } = await signedInAt(t, "growth");
    expect((await botCall(t, "growth", access, "goals", {})).output).not.toBeNull();
    expect(await auditBots(t)).toEqual(["growth"]);
    expect((await at(t, "/mcp/v1/bot/research", access, "ping")).status).toBe(401);
    expect((await at(t, "/mcp/v1", access, "ping")).status).toBe(401);
    const grant = await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect())[0]!);
    expect(grant.onlyBot).toBe("growth");
    expect(grant.resource).toBe(resource("growth"));
  });

  test("a grant made at the plain address is not used at a bot's", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId, "act");
    const access = (await exchange(t, clientId, code)).body.access_token as string;
    expect((await at(t, "/mcp/v1", access, "ping")).status).toBe(200);
    expect((await at(t, "/mcp/v1/bot/growth", access, "ping")).status).toBe(401);
  });

  test("a code made for one bot's address is not exchanged for another's", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId, "act", { resource: resource("growth") });
    const reply = await exchange(t, clientId, code, { resource: resource("research"), redirect_uri: REDIRECT, code_verifier: VERIFIER });
    expect(reply.body.error).toBe("invalid_target");
  });
});

describe("whoami", () => {
  test("tells a bot who it is, what it may do, what is left of its limits, its address and the rules", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.publishRules, {
      rules: "Made-up rule: propose, never assume.",
      notes: [{ bot: "growth", text: "Made-up note for Growth." }],
    });
    await botCall(t, "growth", grok, "goals", {});
    const me = (await botCall(t, "growth", grok, "whoami", {})).output!;
    expect(me.bot).toMatchObject({ id: "growth", name: "Growth Bot", role: "Growth" });
    expect(me.agent).toBeNull();
    expect(me.client).toMatchObject({ name: "Grok app", kind: "token", scope: "act", botsOnly: true });
    expect(me.address).toBe(botAddressOf(SITE, "growth"));
    expect(me.permissions).toContainEqual({ area: "gtm", level: "write" });
    expect(me.limits.calls).toMatchObject({ max: 600, used: 1, remaining: 599 });
    expect(me.limits.changes).toMatchObject({ max: 120, used: 0, remaining: 120 });
    expect(me.limits.proposalsToday).toMatchObject({ max: 200, used: 0, remaining: 200 });
    expect(me.rules).toMatchObject({ version: 1, text: "Made-up rule: propose, never assume.", note: "Made-up note for Growth." });
  });

  test("costs no limit: calling it leaves the counters as they were", async () => {
    const { t, grok } = await setUp();
    await botCall(t, "growth", grok, "whoami", {});
    await botCall(t, "growth", grok, "bot_rules", {});
    const me = (await botCall(t, "growth", grok, "whoami", {})).output!;
    expect(me.limits.calls.used).toBe(0);
  });

  test("answers a caller that names no bot too, even on a client only bots may use", async () => {
    const { t, grok } = await setUp();
    const me = (await call(t, grok, "whoami", {})).output as Record<string, Loose>;
    expect(me.bot).toBeNull();
    expect(me.client).toMatchObject({ name: "Grok app", botsOnly: true });
    expect(me.address).toBeNull();
    expect(me.rules).toBeNull();
  });
});

describe("the bots' rules", () => {
  test("each publish is the next version; bot_rules returns the latest with the bot's own note", async () => {
    const { t, owner, grok } = await setUp();
    expect((await owner.query(api.bots.rules, {})).version).toBe(0);
    await owner.mutation(api.bots.publishRules, { rules: "Made-up rules one.", notes: [] });
    await owner.mutation(api.bots.publishRules, {
      rules: "Made-up rules two.",
      notes: [
        { bot: "growth", text: "Made-up growth note." },
        { bot: "research", text: "  " },
      ],
    });
    const latest = await owner.query(api.bots.rules, {});
    expect(latest).toMatchObject({ version: 2, rules: "Made-up rules two.", notes: [{ bot: "growth", text: "Made-up growth note." }] });
    expect((await botCall(t, "growth", grok, "bot_rules", {})).output).toMatchObject({
      version: 2,
      text: "Made-up rules two.",
      note: "Made-up growth note.",
    });
    expect((await botCall(t, "research", grok, "bot_rules", {})).output).toMatchObject({ version: 2, note: null });
  });

  test("only the owner publishes, notes are for the owner's bots, and the text is held to its limit", async () => {
    const { t, owner } = await setUp();
    const sam = await signInAsMember(t, "cofounder", ["us"]);
    await expect(sam.mutation(api.bots.publishRules, { rules: "x", notes: [] })).rejects.toThrow();
    await expect(owner.mutation(api.bots.publishRules, { rules: "x", notes: [{ bot: "nobody_here", text: "y" }] })).rejects.toThrow(
      BOT_WORDS.gone,
    );
    await expect(owner.mutation(api.bots.publishRules, { rules: "x".repeat(20_001), notes: [] })).rejects.toThrow(
      BOT_WORDS.rulesTooLong,
    );
  });

  test("initialize tells every client to call whoami first and follow the rules", async () => {
    const { t, grok } = await setUp();
    const reply = await at(t, "/mcp/v1/bot/growth", grok, "initialize", { protocolVersion: "2025-06-18" });
    expect(reply.body.result.instructions).toContain("Call `whoami` first");
  });
});
