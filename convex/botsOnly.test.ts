import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { BOT_WORDS } from "./lib/botRules";
import { AGENT_HEADER } from "./lib/osAgents";
import { ENTROPY, NOW, call, ownerWithToken, rpc } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember } from "./test.setup";

// "Only bots may use this client" (docs/assistant.md, "Bots"): a client the
// owner gave its bots is no way around a bot's profile. Made-up names.

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
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token, grokId: grok.id as string };
}

const clientRow = async (owner: Awaited<ReturnType<typeof setUp>>["owner"], id: string) =>
  (await owner.query(api.assistant.clients, {})).find((c) => c.id === id)!;

describe("only bots may use this client", () => {
  test("on by default for a named token that is not the runner's, off for the runner's", async () => {
    const { t, owner, grokId } = await setUp();
    expect((await clientRow(owner, grokId)).botsOnly).toBe(true);
    const clients = await owner.query(api.assistant.clients, {});
    expect(clients.find((c) => c.runner)!.botsOnly).toBe(false);
    // The one token of before (no name, no setting) reads as the runner's: off.
    const legacy = await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").first())!;
      return await ctx.db.insert("agentTokens", { userId: user._id, tokenHash: "made-up-hash", scope: "act", createdAt: NOW });
    });
    expect((await clientRow(owner, legacy as string)).botsOnly).toBe(false);
  });

  test("a call naming no bot is refused, and so is one naming one of the four", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    expect((await call(t, grok, "goals", {})).said).toBe(BOT_WORDS.botsOnly);
    expect((await call(t, grok, "task_create", { title: "Made-up" })).said).toBe(BOT_WORDS.botsOnly);
    expect((await call(t, grok, "goals", {}, { [AGENT_HEADER]: "sales" })).said).toBe(BOT_WORDS.botsOnlyFour);
    expect((await call(t, grok, "goals", { agent: "sales" })).said).toBe(BOT_WORDS.botsOnlyFour);
    // The chief of staff (and engineering) through any client but the Mac runner's is an external profile (Bot Loop v3), admitted as a bot.
    expect((await call(t, grok, "goals", { agent: "chief_of_staff" })).said).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // A bot it names is admitted against its profile.
    expect((await call(t, grok, "goals", { agent: "growth" })).output).not.toBeNull();
    // And the four's tools are not listed to it.
    const listed = (await rpc(t, grok, "tools/list", {}, { [AGENT_HEADER]: "finance" })).body.result!.tools as unknown[];
    expect(listed).toEqual([]);
  });

  test("the Mac runner's token may name the four even when the owner turns the setting on", async () => {
    const { t, owner, mac } = await setUp();
    const runner = (await owner.query(api.assistant.clients, {})).find((c) => c.runner)!;
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: runner.id, on: true });
    expect((await call(t, mac, "deals", {}, { [AGENT_HEADER]: "sales" })).output).not.toBeNull();
    expect((await call(t, mac, "goals", {})).said).toBe(BOT_WORDS.botsOnly);
  });

  test("the owner turns it off in one click, and the client behaves as before", async () => {
    const { t, owner, grok, grokId } = await setUp();
    await owner.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId, on: false });
    expect((await clientRow(owner, grokId)).botsOnly).toBe(false);
    expect((await call(t, grok, "task_create", { title: "Made-up plain" })).output).toMatchObject({ created: true });
  });

  test("an OAuth grant approved from now on is bots-only; one from before is not", async () => {
    const { t, owner } = await setUp();
    const ids = await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").first())!;
      const old = await ctx.db.insert("oauthGrants", {
        userId: user._id,
        clientId: "made-up-old",
        clientName: "Old client",
        redirectHost: "old.example.test",
        scope: "read",
        resource: "https://os.example.test/mcp/v1",
        createdAt: NOW,
      });
      return { old: old as string };
    });
    expect((await clientRow(owner, ids.old)).botsOnly).toBe(false);
    await owner.mutation(api.assistant.setBotsOnly, { kind: "oauth", id: ids.old, on: true });
    expect((await clientRow(owner, ids.old)).botsOnly).toBe(true);
  });

  test("only the owner may change it, and only on their own clients", async () => {
    const { t, grokId } = await setUp();
    const sam = await signInAsMember(t, "cofounder", ["us"]);
    await expect(sam.mutation(api.assistant.setBotsOnly, { kind: "token", id: grokId, on: false })).rejects.toThrow();
  });
});

describe("what a connected client may do, changed in place", () => {
  test("read only to read and act and back, at once, with no reconnecting", async () => {
    const { owner, grokId } = await setUp();
    await owner.mutation(api.assistant.setScope, { kind: "token", id: grokId, scope: "read" });
    expect((await clientRow(owner, grokId)).scope).toBe("read");
    const grok = (await owner.query(api.assistant.clients, {})).find((c) => c.id === grokId)!;
    expect(grok.scope).toBe("read");
    await owner.mutation(api.assistant.setScope, { kind: "token", id: grokId, scope: "act" });
    expect((await clientRow(owner, grokId)).scope).toBe("act");
  });

  test("a client made read only can no longer act, on its very next call", async () => {
    const { t, owner, grok, grokId } = await setUp();
    await owner.mutation(api.assistant.setScope, { kind: "token", id: grokId, scope: "read" });
    const refused = await call(t, grok, "task_create", { title: "Made-up", agent: "growth" });
    expect(refused.output).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
  });

  test("the Mac runner's token stays read and act: the runner's tools need it", async () => {
    const { owner } = await setUp();
    const runner = (await owner.query(api.assistant.clients, {})).find((c) => c.runner)!;
    await expect(owner.mutation(api.assistant.setScope, { kind: "token", id: runner.id, scope: "read" })).rejects.toThrow();
  });

  test("only the owner may change it", async () => {
    const { t, grokId } = await setUp();
    const engineer = await signInAsMember(t, "engineer");
    await expect(engineer.mutation(api.assistant.setScope, { kind: "token", id: grokId, scope: "act" })).rejects.toThrow();
  });
});
