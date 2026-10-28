import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  AGENT_CALL_RETENTION_DAYS,
  AGENT_WORDS,
  CALL_WINDOW_MS,
  MAX_ACTS_PER_WINDOW,
  MAX_AGENT_CALLS,
  MAX_CALLS_PER_WINDOW,
  MAX_MCP_BYTES,
  RECENT_AGENT_CALLS,
} from "./lib/agentRules";
import { LATEST_PROTOCOL_VERSION, PROTOCOL_VERSIONS, RPC, SERVER_INFO, catalogueVersion } from "./lib/mcpProtocol";
import { TOOLS, describeTool } from "./lib/mcpTools";
import { hashToken } from "./lib/personalRules";
import {
  DAY,
  ENTROPY,
  GITHUB_TOKEN,
  MAC_CLIENT,
  NOW,
  STANDUP_TOKEN,
  bearer,
  call,
  calls,
  ownerWithToken,
  post,
  raw,
  rpc,
} from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner } from "./test.setup";

// POST /mcp/v1: the protocol, the token and the limits. What the tools return
// is convex/mcpTools.test.ts.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_GITHUB", GITHUB_TOKEN);
  vi.stubEnv("INGEST_TOKEN_STANDUP", STANDUP_TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const UNAUTHORIZED = {
  jsonrpc: "2.0",
  id: null,
  error: { code: RPC.unauthorized, message: AGENT_WORDS.unauthorized },
};

describe("the protocol", () => {
  test("initialize answers with the version asked for, the tools capability and who the server is", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    for (const version of PROTOCOL_VERSIONS) {
      const reply = await rpc(t, token, "initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "made-up-client", version: "0" },
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: version,
          // A client that keeps the tool list fetches it again when the version moves.
          capabilities: { tools: { listChanged: true } },
          serverInfo: { ...SERVER_INFO, version: catalogueVersion(TOOLS.map(describeTool)) },
        },
      });
      expect(typeof reply.body.result!.instructions).toBe("string");
    }
  });

  test("a version it does not know is answered with its newest, for the client to accept or leave", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    const reply = await rpc(t, token, "initialize", { protocolVersion: "1999-01-01" });
    expect(reply.body.result!.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  test("the answer is JSON, never cached, and opens no session", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    const response = await post(t, token, { jsonrpc: "2.0", id: "a", method: "ping" });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "a", result: {} });
  });

  test("notifications/initialized, and any other notification, is taken with 202 and no body", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    for (const method of ["notifications/initialized", "notifications/cancelled", "anything/else"]) {
      const reply = await raw(t, token, { jsonrpc: "2.0", method });
      expect([method, reply.status, reply.text]).toEqual([method, 202, ""]);
    }
    // A client's answer to a request this server never makes is taken the same way.
    expect((await raw(t, token, { jsonrpc: "2.0", id: 9, result: {} })).status).toBe(202);
  });

  test("GET answers 405: there is no stream to open", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    for (const headers of [{}, bearer(token)]) {
      const response = await t.fetch("/mcp/v1", { method: "GET", headers });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }
  });

  test("tools/list gives each tool a name, a title, a description and an object schema", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    const reply = await rpc(t, token, "tools/list");
    const tools = reply.body.result!.tools as {
      name: string;
      title: string;
      description: string;
      inputSchema: { type: string; additionalProperties: boolean; properties: object };
      annotations: { readOnlyHint: boolean };
    }[];
    // Every tool a model may call: the chat runner program's own three are not listed.
    expect(tools.map((tool) => tool.name)).toEqual(
      TOOLS.filter((tool) => tool.audience !== "runner").map((tool) => tool.name),
    );
    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(3);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      // A strict object: a field the tool does not take is refused, not ignored.
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(TOOLS.find((x) => x.name === tool.name)!.kind === "read");
    }
  });

  test("a read-only token is listed the read tools and no other", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const reply = await rpc(t, token, "tools/list");
    const names = (reply.body.result!.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(TOOLS.filter((tool) => tool.kind === "read").map((tool) => tool.name));
  });

  describe("what is not a request it answers", () => {
    test("a body that is not JSON: -32700", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, '{"jsonrpc": "2.0", "SECRET');
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC.parse, message: AGENT_WORDS.parse },
      });
      expect(reply.text).not.toContain("SECRET");
    });

    test.each([
      ["a number", 7],
      ["text", '"SECRET text"'],
      ["null", null],
      ["no jsonrpc", { id: 1, method: "ping" }],
      ["the wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
      ["no method and no result", { jsonrpc: "2.0", id: 1 }],
      ["a method that is not text", { jsonrpc: "2.0", id: 1, method: 7 }],
      ["a null id", { jsonrpc: "2.0", id: null, method: "ping" }],
      ["an id that is an object", { jsonrpc: "2.0", id: { SECRET: 1 }, method: "ping" }],
      ["an id that is a fraction", { jsonrpc: "2.0", id: 1.5, method: "ping" }],
    ])("%s: -32600", async (_what, body) => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, body);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC.invalidRequest, message: AGENT_WORDS.invalidRequest },
      });
    });

    test("a batch is refused whole, and nothing in it runs", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_create", arguments: { title: "x" } } },
      ]);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toEqual({ code: RPC.invalidRequest, message: AGENT_WORDS.batch });
      expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    });

    test("a method it does not have: -32601, with the request's id and not its method", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      for (const method of ["resources/list", "prompts/list", "SECRET/method"]) {
        const reply = await rpc(t, token, method);
        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({
          jsonrpc: "2.0",
          id: 1,
          error: { code: RPC.methodNotFound, message: AGENT_WORDS.method },
        });
      }
    });

    test.each([
      ["params that are a list", { jsonrpc: "2.0", id: 1, method: "tools/call", params: ["tasks"] }],
      ["params that are text", { jsonrpc: "2.0", id: 1, method: "tools/list", params: "SECRET" }],
      ["a call with no tool name", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }],
      [
        "a call whose name is not text",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 7 } },
      ],
      [
        "a call whose arguments are a list",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks", arguments: [1] } },
      ],
      [
        "a call whose arguments are text",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks", arguments: "SECRET" } },
      ],
    ])("%s: -32602", async (_what, body) => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, body);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: RPC.invalidParams, message: AGENT_WORDS.params },
      });
    });

    test("a tool it does not have: -32602, and the name sent is neither echoed nor kept", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await call(t, token, "SECRET_payroll_list");
      expect(reply.error).toEqual({ code: RPC.invalidParams, message: AGENT_WORDS.unknownTool });
      expect(reply.text).not.toContain("SECRET");
      expect(await calls(t)).toEqual([{ tool: "unknown", kind: "read", outcome: "invalid" }]);
    });

    test("an MCP-Protocol-Version header it does not know is refused; one it knows, or none, is not", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const bad = await rpc(t, token, "ping", undefined, { "MCP-Protocol-Version": "1999-01-01" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toEqual({ code: RPC.invalidRequest, message: AGENT_WORDS.version });
      for (const version of PROTOCOL_VERSIONS) {
        const ok = await rpc(t, token, "ping", undefined, { "MCP-Protocol-Version": version });
        expect(ok.status).toBe(200);
      }
      expect((await rpc(t, token, "ping")).status).toBe(200);
    });
  });

  describe("a request that is too large", () => {
    const big = (bytes: number) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(bytes) } });

    test("is refused by the size it declares, before it is read", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, '{"jsonrpc":"2.0","id":1,"method":"ping"}', {
        "Content-Length": String(MAX_MCP_BYTES + 1),
      });
      expect(reply.status).toBe(413);
      expect(reply.body.error).toEqual({ code: RPC.invalidRequest, message: AGENT_WORDS.tooLarge });
    });

    test("and by the bytes it really holds, whatever it declared", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      const reply = await raw(t, token, big(MAX_MCP_BYTES), { "Content-Length": "10" });
      expect(reply.status).toBe(413);
      expect(reply.body.error!.message).toBe(AGENT_WORDS.tooLarge);
    });

    test("one just under the cap is read", async () => {
      const t = convexTest(schema, modules);
      const { token } = await ownerWithToken(t);
      expect((await raw(t, token, big(MAX_MCP_BYTES - 200))).status).toBe(200);
    });
  });
});

describe("the token", () => {
  test("it is made once, begins sosa_, and only its hash is stored", async () => {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "read");
    expect(token).toMatch(/^sosa_[A-Za-z0-9_-]{43}$/);
    const rows = await t.run((ctx) => ctx.db.query("agentTokens").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(await hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await owner.query(api.assistant.clients, {})).toEqual([
      {
        id: rows[0]!._id,
        kind: "token",
        name: MAC_CLIENT,
        scope: "read",
        runner: false,
        botsOnly: false,
        onlyBot: null,
        createdAt: NOW,
        lastUsedAt: null,
        host: null,
      },
    ]);
    // Nothing the owner can read afterwards holds it.
    expect(JSON.stringify(await owner.query(api.assistant.clients, {}))).not.toContain("sosa_");
  });

  test("entropy the browser did not draw properly is refused in fixed words", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    for (const entropy of ["", "short", "has spaces ".repeat(6), "x".repeat(129)]) {
      await expect(
        owner.mutation(api.assistant.createToken, { entropy, scope: "read", name: "Made-up client" }),
      ).rejects.toThrow("That token could not be made. Try again.");
    }
  });

  test.each([
    ["no Authorization header", null],
    ["an empty bearer", ""],
    ["a token that was never made", `sosa_${"x".repeat(43)}`],
    ["a source's ingest token", GITHUB_TOKEN],
    ["the standup's token", STANDUP_TOKEN],
  ])("%s is refused with one 401, in fixed words", async (_what, given) => {
    const t = convexTest(schema, modules);
    await ownerWithToken(t);
    const reply = await rpc(t, given, "tools/list");
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(UNAUTHORIZED);
  });

  test("a teammate's personal token (sos_) is refused here", async () => {
    const t = convexTest(schema, modules);
    await ownerWithToken(t);
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.teammate@gmail.com", ["today", "board"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(token.startsWith("sos_")).toBe(true);
    const reply = await call(t, token, "tasks");
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(UNAUTHORIZED);
  });

  test("an agent token is refused by the ingest endpoint and by both standup routes", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    const ingest = await t.fetch("/ingest/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(token) },
      body: JSON.stringify({ version: 1, source: "gmail", records: [] }),
    });
    expect(ingest.status).toBe(401);
    expect(await ingest.json()).toEqual({ ok: false, error: "unauthorized" });
    const open = await t.fetch("/standup/v1/open", { method: "GET", headers: bearer(token) });
    expect(open.status).toBe(401);
    const tasks = await t.fetch("/standup/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(token) },
      body: "{}",
    });
    expect(tasks.status).toBe(401);
    // And it wrote nothing anywhere on the way.
    expect(await t.run((ctx) => ctx.db.query("mirrorRecords").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
  });

  test("the token is checked before the body is read: a wrong token with a huge or broken body is a 401", async () => {
    const t = convexTest(schema, modules);
    await ownerWithToken(t);
    const wrong = `sosa_${"y".repeat(43)}`;
    expect((await raw(t, wrong, "not json")).status).toBe(401);
    expect((await raw(t, wrong, "{}", { "Content-Length": String(MAX_MCP_BYTES * 4) })).status).toBe(401);
  });

  test("a revoked token stops at once", async () => {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t);
    expect((await rpc(t, token, "ping")).status).toBe(200);
    const [client] = await owner.query(api.assistant.clients, {});
    await owner.mutation(api.assistant.revokeClient, { kind: "token", id: client!.id });
    expect((await rpc(t, token, "ping")).body).toEqual(UNAUTHORIZED);
    expect((await call(t, token, "tasks")).status).toBe(401);
    expect(await owner.query(api.assistant.clients, {})).toEqual([]);
  });

  test("making another, for another client, leaves the first working: one token a client", async () => {
    const t = convexTest(schema, modules);
    const { owner, token: first } = await ownerWithToken(t, "act");
    const { token: second } = await owner.mutation(api.assistant.createToken, {
      entropy: ENTROPY,
      scope: "read",
      name: "Another client",
      botsOnly: false,
    });
    expect(second).not.toBe(first);
    expect((await rpc(t, first, "ping")).status).toBe(200);
    expect((await rpc(t, second, "ping")).status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("agentTokens").collect())).toHaveLength(2);
  });

  test("a token whose holder is no longer an owner is refused, for a read and for a write", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    expect((await call(t, token, "tasks")).status).toBe(200);
    vi.stubEnv("OWNER_EMAILS", "someone.else@example.test");
    expect((await rpc(t, token, "tools/list")).body).toEqual(UNAUTHORIZED);
    expect((await call(t, token, "tasks")).status).toBe(401);
    expect((await call(t, token, "task_create", { title: "x" })).status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // With nobody an owner at all, nobody is let in.
    vi.stubEnv("OWNER_EMAILS", "");
    expect((await rpc(t, token, "ping")).status).toBe(401);
  });

  test("the holder is asked again inside the read and the write, not only when the request arrives", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    const run = { credential, name: "tasks", input: "{}", now: NOW, today: "2026-10-14" };
    expect((await t.query(internal.mcp.read, run)).status).toBe("ok");
    vi.stubEnv("OWNER_EMAILS", "someone.else@example.test");
    expect(await t.query(internal.mcp.read, run)).toEqual({ status: "unauthorized" });
    expect(
      await t.mutation(internal.mcp.act, { ...run, name: "task_create", input: '{"title":"x"}' }),
    ).toEqual({ status: "unauthorized" });
    expect(await t.mutation(internal.assistant.admit, { credential, name: "tasks", now: NOW })).toEqual({
      status: "unauthorized",
    });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
  });

  test("an owner whose address is not verified holds no working token", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("agentTokens").collect();
      await ctx.db.patch(row!.userId, { emailVerificationTime: undefined });
    });
    expect((await rpc(t, token, "ping")).status).toBe(401);
  });

  test("a token row is honoured only for the users row the gate takes for that address", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    // The row is moved under another users row that is not an owner.
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("agentTokens").collect();
      const other = await ctx.db.insert("users", { email: "stranger@gmail.com", emailVerificationTime: 1 });
      await ctx.db.patch(row!._id, { userId: other });
    });
    expect((await rpc(t, token, "ping")).status).toBe(401);
  });

  test("nor for a second users row under the owner's own address", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    // The gate takes the first row that holds an address; a later one is not the owner.
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("agentTokens").collect();
      const second = await ctx.db.insert("users", { email: OWNER, emailVerificationTime: 1 });
      await ctx.db.patch(row!._id, { userId: second });
    });
    expect((await rpc(t, token, "ping")).status).toBe(401);
  });

  test("it counts when it was last used", async () => {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t);
    vi.setSystemTime(NOW + 5_000);
    await call(t, token, "tasks");
    expect((await owner.query(api.assistant.clients, {}))[0]!.lastUsedAt).toBe(NOW + 5_000);
  });
});

describe("a read-only token", () => {
  test("is told so by an act tool, in fixed words, and nothing is changed", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    // The runner's tools are not this client's at all (convex/mcpClients.test.ts).
    const acts = TOOLS.filter((x) => x.kind === "act" && x.audience !== "runner");
    for (const tool of acts) {
      const reply = await call(t, token, tool.name, { title: "SECRET title", id: "x" });
      expect(reply.status).toBe(200);
      expect(reply.isError).toBe(true);
      expect(reply.said).toBe(AGENT_WORDS.readOnly);
    }
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    // One row an act tool, however many there are.
    expect((await calls(t)).map((row) => row.outcome)).toEqual(acts.map(() => "refused"));
  });

  test("the write itself refuses it too, whatever let the call through", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const ran = await t.mutation(internal.mcp.act, {
      credential: { kind: "token" as const, hash: await hashToken(token) },
      name: "task_create",
      input: '{"title":"x"}',
      now: NOW,
      today: "2026-10-14",
    });
    expect(ran).toEqual({ status: "invalid", message: AGENT_WORDS.readOnly });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
  });

  test("an act tool cannot be run as a read, nor a read as an act", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    const run = { credential: { kind: "token" as const, hash: await hashToken(token) }, input: "{}", now: NOW, today: "2026-10-14" };
    expect((await t.query(internal.mcp.read, { ...run, name: "task_create" })).status).toBe("invalid");
    expect((await t.mutation(internal.mcp.act, { ...run, name: "tasks" })).status).toBe("invalid");
  });
});

describe("the limits", () => {
  test(`a token makes ${MAX_CALLS_PER_WINDOW} calls in a window, then is refused in fixed words until it closes`, async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      const admitted = await t.mutation(internal.assistant.admit, { credential, name: "goals", now: NOW + n });
      expect(admitted.status).toBe("ok");
    }
    const over = await call(t, token, "goals");
    expect(over.status).toBe(200);
    expect(over.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RPC.limited, message: AGENT_WORDS.limited },
    });
    // The other methods are not tool calls and are still answered.
    expect((await rpc(t, token, "ping")).status).toBe(200);

    vi.setSystemTime(NOW + CALL_WINDOW_MS - 1);
    expect((await call(t, token, "goals")).error!.message).toBe(AGENT_WORDS.limited);
    vi.setSystemTime(NOW + CALL_WINDOW_MS);
    expect((await call(t, token, "goals")).output).not.toBeNull();
  });

  test(`acts have a limit of their own: ${MAX_ACTS_PER_WINDOW} in a window, and reads go on`, async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "act");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    for (let n = 0; n < MAX_ACTS_PER_WINDOW; n++) {
      const admitted = await t.mutation(internal.assistant.admit, {
        credential,
        name: "task_create",
        now: NOW + n,
      });
      expect(admitted.status).toBe("ok");
    }
    const over = await call(t, token, "task_create", { title: "One too many" });
    expect(over.error).toEqual({ code: RPC.limited, message: AGENT_WORDS.actsLimited });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toEqual([]);
    expect((await call(t, token, "tasks")).output).not.toBeNull();

    vi.setSystemTime(NOW + CALL_WINDOW_MS + MAX_ACTS_PER_WINDOW);
    expect((await call(t, token, "task_create", { title: "After the window" })).output).toMatchObject({
      created: true,
    });
  });

  test("calls that are turned away are still counted, so an unknown tool cannot be hammered", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      const name = n % 2 === 0 ? "no_such_tool" : "task_create";
      const admitted = await t.mutation(internal.assistant.admit, { credential, name, now: NOW });
      expect(admitted.status).toBe(n % 2 === 0 ? "unknown_tool" : "read_only");
    }
    expect((await call(t, token, "no_such_tool")).error!.message).toBe(AGENT_WORDS.limited);
  });

  test("a caller stuck in a loop writes one refusal for the window, not one a call", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      await t.mutation(internal.assistant.admit, { credential, name: "goals", now: NOW });
    }
    for (let n = 0; n < 5; n++) await call(t, token, "goals");
    expect(await calls(t)).toEqual([{ tool: "goals", kind: "read", outcome: "refused" }]);
    // The next window's first refusal is written again.
    vi.setSystemTime(NOW + CALL_WINDOW_MS);
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      await t.mutation(internal.assistant.admit, { credential, name: "goals", now: NOW + CALL_WINDOW_MS });
    }
    await call(t, token, "goals");
    await call(t, token, "goals");
    expect((await calls(t)).filter((row) => row.outcome === "refused")).toHaveLength(2);
  });

  test("a new token starts its own count", async () => {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "read");
    const credential = { kind: "token" as const, hash: await hashToken(token) };
    for (let n = 0; n < MAX_CALLS_PER_WINDOW; n++) {
      await t.mutation(internal.assistant.admit, { credential, name: "goals", now: NOW });
    }
    const { token: next } = await owner.mutation(api.assistant.createToken, {
      entropy: ENTROPY,
      scope: "read",
      name: "Another client",
      botsOnly: false,
    });
    expect((await call(t, next, "goals")).output).not.toBeNull();
  });
});

describe("the audit", () => {
  test("a row is the tool, its kind, when, how it ended and how long it took: no argument, title, name or text", async () => {
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "act");
    vi.setSystemTime(NOW + 1_000);
    await call(t, token, "task_create", { title: "SECRET title", notes: "SECRET notes" });
    await call(t, token, "tasks", { company: "us" });
    await call(t, token, "tasks", { company: "SECRET" });
    await call(t, token, "task_update", { id: "SECRET-not-an-id", title: "SECRET" });

    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.map(({ tool, kind, outcome }) => [tool, kind, outcome])).toEqual([
      ["task_create", "act", "ok"],
      ["tasks", "read", "ok"],
      ["tasks", "read", "invalid"],
      ["task_update", "act", "refused"],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["_creationTime", "_id", "at", "client", "clientName", "durationMs", "kind", "outcome", "tool", "userId"].sort(),
      );
      expect(row.at).toBe(NOW + 1_000);
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(rows)).not.toContain("SECRET");

    const listed = await owner.query(api.assistant.recentCalls, {});
    expect(listed.map((row) => [row.tool, row.outcome]).sort()).toEqual(
      rows.map((row) => [row.tool, row.outcome]).sort(),
    );
    expect(JSON.stringify(listed)).not.toContain("SECRET");
  });

  test("a tool that fails is written as an error, and the caller hears fixed words", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t, "read");
    // A row no validator would write: the tool's own code throws on it.
    await t.run((ctx) =>
      ctx.db.insert("sourceStatus", { source: "mercury", state: "ok", lastRunAt: 1, lastOkAt: 1 }),
    );
    await t.run((ctx) =>
      ctx.db.insert("sourceStatus", { source: "mercury", state: "ok", lastRunAt: 2, lastOkAt: 2 }),
    );
    const reply = await call(t, token, "sources");
    expect(reply.isError).toBe(true);
    expect(reply.said).toBe(AGENT_WORDS.failed);
    expect(await calls(t)).toEqual([{ tool: "sources", kind: "read", outcome: "error" }]);
  });

  test(`the owner is listed the newest ${RECENT_AGENT_CALLS}, newest first, and only their own`, async () => {
    const t = convexTest(schema, modules);
    const { owner } = await ownerWithToken(t);
    await t.run(async (ctx) => {
      const [token] = await ctx.db.query("agentTokens").collect();
      const other = await ctx.db.insert("users", {});
      for (let n = 0; n < RECENT_AGENT_CALLS + 10; n++) {
        await ctx.db.insert("agentCalls", {
          userId: token!.userId,
          tool: "tasks",
          kind: "read",
          at: NOW + n,
          outcome: "ok",
          durationMs: 1,
        });
      }
      await ctx.db.insert("agentCalls", {
        userId: other,
        tool: "deals",
        kind: "read",
        at: NOW + 10_000,
        outcome: "ok",
        durationMs: 1,
      });
    });
    const listed = await owner.query(api.assistant.recentCalls, {});
    expect(listed).toHaveLength(RECENT_AGENT_CALLS);
    expect(listed[0]!.at).toBe(NOW + RECENT_AGENT_CALLS + 9);
    expect(listed.every((row) => row.tool === "tasks")).toBe(true);
  });

  describe("pruning", () => {
    const fill = (t: ReturnType<typeof convexTest>, ats: number[]) =>
      t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        for (const at of ats) {
          await ctx.db.insert("agentCalls", { userId, tool: "tasks", kind: "read", at, outcome: "ok", durationMs: 1 });
        }
      });
    const left = (t: ReturnType<typeof convexTest>) =>
      t.run(async (ctx) => (await ctx.db.query("agentCalls").collect()).map((row) => row.at).sort((a, b) => a - b));

    test(`rows older than ${AGENT_CALL_RETENTION_DAYS} days go, and newer ones stay`, async () => {
      const t = convexTest(schema, modules);
      const edge = NOW - AGENT_CALL_RETENTION_DAYS * DAY;
      await fill(t, [edge - 1, edge, edge + 1, NOW]);
      await t.mutation(internal.assistant.prune, {});
      expect(await left(t)).toEqual([edge, edge + 1, NOW]);
    });

    test(`only the newest ${MAX_AGENT_CALLS} are kept`, async () => {
      const t = convexTest(schema, modules);
      await fill(t, Array.from({ length: MAX_AGENT_CALLS + 25 }, (_, n) => NOW - n));
      await t.mutation(internal.assistant.prune, {});
      const kept = await left(t);
      expect(kept).toHaveLength(MAX_AGENT_CALLS);
      expect(kept[0]).toBe(NOW - (MAX_AGENT_CALLS - 1));
    });

    test("a run with more to delete than one batch schedules its own next one, with no arguments", async () => {
      const t = convexTest(schema, modules);
      const old = NOW - (AGENT_CALL_RETENTION_DAYS + 1) * DAY;
      await fill(t, Array.from({ length: 620 }, (_, n) => old - n));
      await t.mutation(internal.assistant.prune, {});
      expect(await left(t)).toHaveLength(120);
      const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.map((job) => [job.name, job.args])).toEqual([["assistant:prune", [{}]]]);
    });

    test("the daily cron is registered", async () => {
      const { default: crons } = await import("./crons");
      const jobs = (crons as unknown as { crons: Record<string, { name: string }> }).crons;
      expect(Object.keys(jobs)).toContain("prune agent calls");
    });
  });
});

describe("the server's version follows its tools", () => {
  test("the same catalogue gives the same version; a tool added or changed gives another", () => {
    const tools = TOOLS.map(describeTool);
    const version = catalogueVersion(tools);
    expect(version).toMatch(/^1\.0\.0\+[0-9a-f]{8}$/);
    expect(catalogueVersion([...tools])).toBe(version);
    expect(catalogueVersion(tools.slice(1))).not.toBe(version);
    const changed = [{ ...tools[0]!, description: `${tools[0]!.description} More.` }, ...tools.slice(1)];
    expect(catalogueVersion(changed)).not.toBe(version);
  });
});
