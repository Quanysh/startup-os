import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  AGENT_WORDS,
  CLIENT_WORDS,
  MAX_AGENT_TOKENS,
  MAX_CALLS_PER_WINDOW,
  MAX_CLIENT_NAME,
} from "./lib/agentRules";
import { LEGACY_TOKEN_NAME } from "./lib/agentToken";
import { RPC } from "./lib/mcpProtocol";
import { hashToken } from "./lib/personalRules";
import { ENTROPY, MAC_CLIENT, NOW, call, ownerWithToken, rpc } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner, type TestBackend } from "./test.setup";

/** What an owner-only function says to anyone else (convex/lib/owner.ts). */
const NOT_OWNER = "not_owner";

// Several named clients, each with its own token (`sosa_…`): made one at a
// time on the Assistant's connection page, each with its own scope, limits
// and audit, revoked one at a time. The Mac's runner is one of them.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;

const make = (owner: Owner, name: string, scope: "read" | "act" = "read", runner?: boolean) =>
  owner.mutation(api.assistant.createToken, {
    entropy: ENTROPY,
    scope,
    name,
    ...(runner === undefined ? null : { runner }),
    botsOnly: false,
  });

async function twoClients(t: TestBackend) {
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const { token: grok } = await make(owner, "Grok bot", "read");
  return { owner, mac, grok };
}

describe("several named clients", () => {
  test("each is made once with its own name and scope, and only its hash is stored", async () => {
    const t = convexTest(schema, modules);
    const { owner, mac, grok } = await twoClients(t);
    expect(mac).not.toBe(grok);
    for (const token of [mac, grok]) expect(token).toMatch(/^sosa_[A-Za-z0-9_-]{43}$/);

    const rows = await t.run((ctx) => ctx.db.query("agentTokens").collect());
    expect(rows.map((row) => row.tokenHash).sort()).toEqual([await hashToken(mac), await hashToken(grok)].sort());
    expect(JSON.stringify(rows)).not.toContain(mac);
    expect(JSON.stringify(rows)).not.toContain(grok);

    const listed = await owner.query(api.assistant.clients, {});
    expect(listed.map(({ name, kind, scope, runner, createdAt, lastUsedAt }) => ({ name, kind, scope, runner, createdAt, lastUsedAt }))).toEqual([
      { name: MAC_CLIENT, kind: "token", scope: "act", runner: true, createdAt: NOW, lastUsedAt: null },
      { name: "Grok bot", kind: "token", scope: "read", runner: false, createdAt: NOW, lastUsedAt: null },
    ]);
    // Nothing the owner can read afterwards holds a token or a hash.
    const text = JSON.stringify(listed);
    expect(text).not.toContain("sosa_");
    for (const row of rows) expect(text).not.toContain(row.tokenHash);
  });

  test("both work at once, and each one's use is its own", async () => {
    const t = convexTest(schema, modules);
    const { owner, mac, grok } = await twoClients(t);
    vi.setSystemTime(NOW + 5_000);
    expect((await call(t, grok, "goals")).output).not.toBeNull();
    expect((await call(t, mac, "goals")).output).not.toBeNull();
    vi.setSystemTime(NOW + 9_000);
    await call(t, grok, "goals");
    const listed = await owner.query(api.assistant.clients, {});
    expect(listed.map((row) => [row.name, row.lastUsedAt])).toEqual([
      [MAC_CLIENT, NOW + 5_000],
      ["Grok bot", NOW + 9_000],
    ]);
  });

  test("a revoked client stops at once, and another client's token goes on working", async () => {
    const t = convexTest(schema, modules);
    const { owner, mac, grok } = await twoClients(t);
    const grokRow = (await owner.query(api.assistant.clients, {})).find((row) => row.name === "Grok bot")!;
    expect(grokRow.kind).toBe("token");
    await owner.mutation(api.assistant.revokeClient, { kind: "token", id: grokRow.id });
    expect((await rpc(t, grok, "ping")).status).toBe(401);
    expect((await call(t, grok, "goals")).status).toBe(401);
    expect((await call(t, mac, "goals")).output).not.toBeNull();
    expect((await owner.query(api.assistant.clients, {})).map((row) => row.name)).toEqual([MAC_CLIENT]);
    // Revoking it again is no error: a double-click is safe.
    await owner.mutation(api.assistant.revokeClient, { kind: "token", id: grokRow.id });
  });

  test("a read client cannot act, whatever another client may do", async () => {
    const t = convexTest(schema, modules);
    const { mac, grok } = await twoClients(t);
    const refused = await call(t, grok, "task_create", { title: "Made-up task" });
    expect(refused.said).toBe(AGENT_WORDS.readOnly);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // Listed the reads only.
    const listed = (await rpc(t, grok, "tools/list")).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).not.toContain("task_create");
    // The act client is not held back by it.
    expect((await call(t, mac, "task_create", { title: "Made-up task" })).output).toMatchObject({ created: true });
  });

  test("limits are each client's own: one at its limit does not stop another", async () => {
    const t = convexTest(schema, modules);
    const { mac, grok } = await twoClients(t);
    const credential = { kind: "token" as const, hash: await hashToken(grok) };
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      await t.mutation(internal.assistant.admit, { credential, name: "goals", now: NOW });
    }
    expect((await call(t, grok, "goals")).error?.message).toBe(AGENT_WORDS.limited);
    expect((await call(t, mac, "goals")).output).not.toBeNull();
  });

  test("the audit says which client made each call, by name, and the owner is listed it", async () => {
    const t = convexTest(schema, modules);
    const { owner, mac, grok } = await twoClients(t);
    await call(t, mac, "goals");
    await call(t, grok, "tasks");
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.map((row) => [row.tool, row.clientName, row.client?.kind])).toEqual([
      ["goals", MAC_CLIENT, "token"],
      ["tasks", "Grok bot", "token"],
    ]);
    const listed = await owner.query(api.assistant.recentCalls, {});
    expect(listed.map((row) => [row.tool, row.client])).toEqual([
      ["tasks", "Grok bot"],
      ["goals", MAC_CLIENT],
    ]);
    // The name of a client revoked since is still said on its rows.
    const grokRow = (await owner.query(api.assistant.clients, {})).find((row) => row.name === "Grok bot")!;
    await owner.mutation(api.assistant.revokeClient, { kind: "token", id: grokRow.id });
    expect((await owner.query(api.assistant.recentCalls, {}))[0]!.client).toBe("Grok bot");
  });
});

describe("a client's name", () => {
  test("is needed, cleaned of what the eye cannot see, and held to its length", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    for (const name of ["", "   ", "​​"]) {
      await expect(make(owner, name)).rejects.toThrow(CLIENT_WORDS.nameMissing);
    }
    await expect(make(owner, "x".repeat(MAX_CLIENT_NAME + 1))).rejects.toThrow(CLIENT_WORDS.nameTooLong);
    await make(owner, "  Grok​   bot \u0007 ");
    expect((await owner.query(api.assistant.clients, {}))[0]!.name).toBe("Grok bot");
  });
});

describe(`at most ${MAX_AGENT_TOKENS} tokens`, () => {
  test("one more is refused in fixed words until one is revoked", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    for (let n = 0; n < MAX_AGENT_TOKENS; n++) await make(owner, `Made-up client ${n}`);
    await expect(make(owner, "One too many")).rejects.toThrow(CLIENT_WORDS.tooMany);
    const first = (await owner.query(api.assistant.clients, {}))[0]!;
    await owner.mutation(api.assistant.revokeClient, { kind: "token", id: first.id });
    await make(owner, "Now there is room");
  });
});

describe("the runner's tools are the Mac's client's alone", () => {
  test("another client is refused them as if they did not exist, and is never listed them", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await ownerWithToken(t, "act");
    const { token: other } = await make(owner, "Grok bot", "act");
    const reply = await call(t, other, "chat_next", { runner: "runner-aaaa-0001" });
    expect(reply.error).toEqual({ code: RPC.invalidParams, message: AGENT_WORDS.unknownTool });
    const listed = (await rpc(t, other, "tools/list")).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).not.toContain("chat_next");
    // Written down as a tool that does not exist: the runner's names are not this client's.
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.map((row) => [row.tool, row.outcome])).toEqual([["unknown", "invalid"]]);
    expect(await owner.query(api.chat.runner, {})).toEqual({ checkedInAt: null, everyMs: null });
  });

  test("the Mac's client may call them", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    expect((await call(t, token, "chat_next", { runner: "runner-aaaa-0001" })).output).toMatchObject({ none: true });
  });

  test("one client at a time is the Mac's, and it must be one that may act", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await ownerWithToken(t, "act");
    await expect(make(owner, "A second Mac", "act", true)).rejects.toThrow(CLIENT_WORDS.oneRunner);
    const fresh = convexTest(schema, modules);
    const alone = await signInAsOwner(fresh);
    await expect(make(alone, "Read-only Mac", "read", true)).rejects.toThrow(CLIENT_WORDS.runnerActs);
  });

  test("the one token of before (no name) keeps working, as the Mac's, under a name the page gives it", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const token = `sosa_${"L".repeat(43)}`;
    await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").first())!;
      await ctx.db.insert("agentTokens", { userId: user._id, tokenHash: await hashToken(token), scope: "act", createdAt: 1 });
    });
    expect((await call(t, token, "chat_next", { runner: "runner-aaaa-0001" })).output).toMatchObject({ none: true });
    const [row] = await owner.query(api.assistant.clients, {});
    expect([row!.name, row!.runner]).toEqual([LEGACY_TOKEN_NAME, true]);
    // So no second Mac can be made beside it.
    await expect(make(owner, "Another Mac", "act", true)).rejects.toThrow(CLIENT_WORDS.oneRunner);
  });
});

describe("only the owner", () => {
  test("a teammate can list, make and revoke no client", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await ownerWithToken(t, "act");
    const [mine] = await owner.query(api.assistant.clients, {});
    const ada = await signInAsMember(t, "cofounder", ["us", "kz"], "ada.teammate@gmail.com");
    await expect(ada.query(api.assistant.clients, {})).rejects.toThrow(NOT_OWNER);
    await expect(make(ada as unknown as Owner, "Mine")).rejects.toThrow(NOT_OWNER);
    await expect(ada.mutation(api.assistant.revokeClient, { kind: "token", id: mine!.id })).rejects.toThrow(NOT_OWNER);
    expect(await owner.query(api.assistant.clients, {})).toHaveLength(1);
  });
});

describe("a client with a static bearer header, as xAI's remote MCP tool is", () => {
  // It sends `Accept: application/json, text/event-stream`, no
  // MCP-Protocol-Version header, and the same Authorization on every request.
  // A server may answer a POST with plain JSON (streamable HTTP), so nothing
  // here opens a stream.
  const headers = { Accept: "application/json, text/event-stream" };

  test("initialize, notifications/initialized, tools/list and tools/call, each answered in plain JSON", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await ownerWithToken(t, "act");
    const { token } = await make(owner, "Grok bot", "read");
    const send = (body: unknown) =>
      t.fetch("/mcp/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(body),
      });

    const init = await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "made-up-xai", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.headers.get("Content-Type")).toBe("application/json");
    expect(init.headers.get("Mcp-Session-Id")).toBeNull();
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");

    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const listed = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.headers.get("Content-Type")).toBe("application/json");
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain("tasks");

    const called = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goals", arguments: {} } });
    const answer = (await called.json()) as { result: { isError: boolean; content: { type: string }[] } };
    expect(answer.result.isError).toBe(false);
    expect(answer.result.content[0]!.type).toBe("text");
  });

  test("a client that sends no Accept header, or only */*, is answered the same", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    for (const accept of [undefined, "*/*"]) {
      const response = await t.fetch("/mcp/v1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(accept === undefined ? null : { Accept: accept }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status, String(accept)).toBe(200);
    }
  });
});
