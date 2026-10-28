import { afterEach, describe, expect, test, vi } from "vitest";
import { AGENT_WORDS, MAX_MCP_BYTES } from "@convex/lib/agentRules";
import { MAX_INGEST_BYTES } from "@convex/lib/ingestSchema";
import { MAX_ACK_BYTES } from "@convex/lib/investorSync";
import { RPC } from "@convex/lib/mcpProtocol";
import { MAX_OAUTH_BYTES, OAUTH_WORDS } from "@convex/lib/oauthRules";
import { MAX_STANDUP_BYTES } from "@convex/lib/standup";
import { BODY_CAPS, forward } from "./pass-through";
import { BOT_ID } from "@convex/lib/agents";
import {
  BOT_ID_SEGMENT,
  PASS_THROUGH,
  isPassThroughPath,
  passThroughRouteOf,
  type PassThroughPath,
} from "./pass-through-routes";

// Vite's compile-time glob import, typed here as convex/test.setup.ts does.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const ORIGIN = "https://made-up-animal-123.convex.site";
const APP = "https://os.example.test";
// Obviously not real. The word SECRET proves a surface clean.
const TOKEN = "SECRET-fake-token-0123456789-abcdefghijklmnop";
const BODY = JSON.stringify({ version: 1, source: "fake", note: "SECRET body" });

type Call = { url: string; init: RequestInit };

/** A stand-in for fetch that records what it was asked and answers as told. */
function upstream(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const post = (path: string, body: BodyInit | null = BODY, headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body,
  });

/** The one request that was made. */
function only(calls: Call[]): Call {
  const [call] = calls;
  if (calls.length !== 1 || call === undefined) throw new Error(`Expected one request, saw ${calls.length}.`);
  return call;
}

const sentHeaders = (call: Call) =>
  Object.fromEntries(new Headers(call.init.headers).entries());
const sentBody = (call: Call) => new TextDecoder().decode(call.init.body as Uint8Array);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the table of what is passed through", () => {
  // Four, since 2026-10-13: the owner decided the owner's Claude reaches the
  // OS at the app's own address too (POST /mcp/v1, convex/mcp.ts). It is
  // checked by the endpoint, on the owner's clients' credentials alone, like
  // the rest. Ten since 2026-10-18: that endpoint's OAuth (convex/oauth.ts),
  // so a client that signs in finds it at the same address: two documents,
  // registration, the token endpoint and revocation. The consent page is the
  // app's own (/oauth/authorize), behind the session, and is not here.
  // Twelve since 2026-10-19: each bot's own connector address and its
  // protected resource's metadata, two pattern routes one bot id wide.
  // Fourteen since 2026-10-22: the Visible write-back queue and its ack.
  test("is exactly these fourteen routes", () => {
    expect(PASS_THROUGH).toEqual([
      { method: "POST", path: "/ingest/v1" },
      { method: "GET", path: "/standup/v1/open" },
      { method: "POST", path: "/standup/v1/tasks" },
      { method: "POST", path: "/mcp/v1" },
      { method: "GET", path: "/.well-known/oauth-protected-resource" },
      { method: "GET", path: "/.well-known/oauth-protected-resource/mcp/v1" },
      { method: "GET", path: "/.well-known/oauth-authorization-server" },
      { method: "POST", path: "/oauth/register" },
      { method: "POST", path: "/oauth/token" },
      { method: "POST", path: "/oauth/revoke" },
      { method: "GET", path: "/ingest/v1/visible/outbox" },
      { method: "POST", path: "/ingest/v1/visible/outbox/ack" },
      { method: "POST", path: "/mcp/v1/bot/[botId]" },
      { method: "GET", path: "/.well-known/oauth-protected-resource/mcp/v1/bot/[botId]" },
    ]);
  });

  test("a pattern route is one bot id wide, of the endpoint's own shape", () => {
    expect(BOT_ID_SEGMENT.source).toBe(BOT_ID.source);
    for (const path of ["/mcp/v1/bot/growth", "/mcp/v1/bot/strategy_advisor", "/mcp/v1/bot/globex-ai"]) {
      expect(passThroughRouteOf(path)).toBe("/mcp/v1/bot/[botId]");
    }
    expect(passThroughRouteOf("/.well-known/oauth-protected-resource/mcp/v1/bot/growth")).toBe(
      "/.well-known/oauth-protected-resource/mcp/v1/bot/[botId]",
    );
    for (const near of [
      "/mcp/v1/bot",
      "/mcp/v1/bot/",
      "/mcp/v1/bot/[botId]",
      "/mcp/v1/bot/Growth",
      "/mcp/v1/bot/g",
      "/mcp/v1/bot/growth/",
      "/mcp/v1/bot/growth/x",
      "/mcp/v1/bot/../ingest/v1",
      "/mcp/v1/bot/growth%2F",
      "/mcp/v1/bots/growth",
      `/mcp/v1/bot/a${"b".repeat(40)}`,
      "/.well-known/oauth-protected-resource/mcp/v1/bot/",
    ]) {
      expect(isPassThroughPath(near), near).toBe(false);
    }
  });

  test("a path is one of them only when it is one of them whole", () => {
    for (const { path } of PASS_THROUGH) expect(isPassThroughPath(path.replace("[botId]", "growth"))).toBe(true);
    for (const near of [
      "/ingest",
      "/ingest/",
      "/ingest/v1/",
      "/ingest/v1/more",
      "/ingest/v2",
      "/ingest/V1",
      "/ingest/v1.json",
      "//ingest/v1",
      "/x/ingest/v1",
      "/standup",
      "/standup/v1",
      "/standup/v1/open/",
      "/standup/v1/tasks/1",
      "/standup/v1/done",
      "/mcp",
      "/mcp/",
      "/mcp/v1/",
      "/mcp/v1/sse",
      "/mcp/v2",
      "/MCP/v1",
      "/x/mcp/v1",
      "/api/auth/signin",
      "/api/auth",
      "/oauth",
      "/oauth/authorize",
      "/oauth/token/",
      "/oauth/tokens",
      "/.well-known",
      "/.well-known/openid-configuration",
      "/.well-known/jwks.json",
      "/.well-known/oauth-protected-resource/",
      "/.well-known/oauth-protected-resource/ingest/v1",
      "/.well-known/oauth-authorization-server/mcp/v1",
      "/google/callback",
      "/os/health",
      "/",
      "",
    ]) {
      expect(isPassThroughPath(near)).toBe(false);
    }
  });

  test("each route's body is capped where the endpoint caps it, and a GET has none", () => {
    expect(BODY_CAPS).toEqual({
      "/ingest/v1": MAX_INGEST_BYTES,
      "/standup/v1/open": 0,
      "/standup/v1/tasks": MAX_STANDUP_BYTES,
      "/mcp/v1": MAX_MCP_BYTES,
      "/.well-known/oauth-protected-resource": 0,
      "/.well-known/oauth-protected-resource/mcp/v1": 0,
      "/.well-known/oauth-authorization-server": 0,
      "/oauth/register": MAX_OAUTH_BYTES,
      "/oauth/token": MAX_OAUTH_BYTES,
      "/oauth/revoke": MAX_OAUTH_BYTES,
      "/ingest/v1/visible/outbox": 0,
      "/ingest/v1/visible/outbox/ack": MAX_ACK_BYTES,
      "/mcp/v1/bot/[botId]": MAX_MCP_BYTES,
      "/.well-known/oauth-protected-resource/mcp/v1/bot/[botId]": 0,
    });
  });

  test("the app has a route handler for each of them and for nothing else", async () => {
    const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    // A glob's "**" passes over a folder whose name begins with a dot, so the
    // well-known folder is looked in by name.
    const files = {
      ...import.meta.glob("/src/app/**/route.{ts,tsx,js,jsx,mjs}"),
      ...import.meta.glob("/src/app/.well-known/**/route.{ts,tsx,js,jsx,mjs}"),
      // `**` passes over a folder whose name begins with a dot, so a
      // well-known folder that is not at the app root is named too.
      ...import.meta.glob("/src/app/mcp/.well-known/**/route.{ts,tsx,js,jsx,mjs}"),
      ...import.meta.glob("/src/app/mcp/v1/.well-known/**/route.{ts,tsx,js,jsx,mjs}"),
    };
    const found: { method: string; path: string }[] = [];
    for (const [file, load] of Object.entries(files)) {
      const path = file.replace(/^\/src\/app/, "").replace(/\/route\.\w+$/, "");
      const handlers = (await load()) as Record<string, unknown>;
      for (const method of METHODS) if (method in handlers) found.push({ method, path });
    }
    const line = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
    // Beside the pass-through routes: handlers that answer here and forward
    // nothing new (a GET of the agent endpoint says how to sign in; two
    // aliases of the authorization server's metadata, including the path a
    // client inserts or appends; any other well-known address is a JSON 404).
    const LOCAL = [
      "GET /mcp/v1",
      "GET /mcp/v1/bot/[botId]",
      "GET /mcp/.well-known/[...rest]",
      "GET /mcp/v1/.well-known/[...rest]",
      "GET /.well-known/oauth-authorization-server/mcp",
      "GET /.well-known/oauth-authorization-server/mcp/v1",
      "GET /.well-known/openid-configuration",
      "GET /.well-known/[...rest]",
    ];
    expect(found.map(line).sort()).toEqual([...PASS_THROUGH.map(line), ...LOCAL].sort());
  });
});

describe("forward", () => {
  test("a POST goes to the same path on the deployment with its token, type and body untouched", async () => {
    const up = upstream(() => json(200, { ok: true, inserted: 2, updated: 0, unchanged: 1 }));
    const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });

    expect(up.calls).toHaveLength(1);
    const call = only(up.calls);
    expect(call.url).toBe(`${ORIGIN}/ingest/v1`);
    expect(call.init.method).toBe("POST");
    expect(sentHeaders(call)).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(sentBody(call)).toBe(BODY);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe('{"ok":true,"inserted":2,"updated":0,"unchanged":1}');
  });

  test("the body is sent byte for byte, whatever it holds", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 226, 130, 172, 34]);
    const up = upstream(() => json(400, { ok: false, error: "invalid_json", issues: [] }));
    await forward(post("/standup/v1/tasks", bytes), "/standup/v1/tasks", { origin: ORIGIN, fetch: up.fetch });
    expect(only(up.calls).url).toBe(`${ORIGIN}/standup/v1/tasks`);
    expect(Array.from(only(up.calls).init.body as Uint8Array)).toEqual(Array.from(bytes));
  });

  test("a GET is sent with its token and no body", async () => {
    const up = upstream(() => json(200, { ok: true, open: [], done: [], linear: [], truncated: false }));
    const request = new Request(`${APP}/standup/v1/open`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const response = await forward(request, "/standup/v1/open", { origin: ORIGIN, fetch: up.fetch });
    const call = only(up.calls);
    expect(call.url).toBe(`${ORIGIN}/standup/v1/open`);
    expect(call.init.method).toBe("GET");
    expect(sentHeaders(call)).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(call.init.body).toBeUndefined();
    expect(response.status).toBe(200);
    // A GET is what a platform would cache.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, open: [], done: [], linear: [], truncated: false });
  });

  test("nothing else of the request goes on: no cookie, no address, no query", async () => {
    const up = upstream(() => json(401, { ok: false, error: "unauthorized" }));
    const request = new Request(`${APP}/ingest/v1?to=https://elsewhere.example.test&x=SECRET`, {
      method: "POST",
      headers: {
        Cookie: "__convexAuthJWT=SECRET-session",
        "X-Forwarded-For": "203.0.113.7",
        "X-Forwarded-Host": "elsewhere.example.test",
        Host: "elsewhere.example.test",
        "User-Agent": "SECRET-agent",
        Accept: "text/html",
        Origin: "https://elsewhere.example.test",
      },
      body: "{}",
    });
    await forward(request, "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
    const call = only(up.calls);
    expect(call.url).toBe(`${ORIGIN}/ingest/v1`);
    // Only the Content-Type the request arrived with (a string body's default).
    expect(sentHeaders(call)).toEqual({ "content-type": "text/plain;charset=UTF-8" });
    expect(sentBody(call)).toBe("{}");
  });

  describe("the owner's agent endpoint, /mcp/v1", () => {
    const CALL = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const mcp = (headers: Record<string, string> = {}) =>
      post("/mcp/v1", CALL, {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...headers,
      });

    test("goes on with its token, its type and the two headers the protocol needs, and no other", async () => {
      const up = upstream(() => json(200, { jsonrpc: "2.0", id: 1, result: { tools: [] } }));
      const response = await forward(
        mcp({
          Cookie: "__convexAuthJWT=SECRET-session",
          "Mcp-Session-Id": "SECRET-session",
          "Last-Event-ID": "SECRET",
          Origin: "https://elsewhere.example.test",
          "User-Agent": "SECRET-agent",
          "X-Forwarded-For": "203.0.113.7",
        }),
        "/mcp/v1",
        { origin: ORIGIN, fetch: up.fetch },
      );
      const call = only(up.calls);
      expect(call.url).toBe(`${ORIGIN}/mcp/v1`);
      expect(call.init.method).toBe("POST");
      expect(sentHeaders(call)).toEqual({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      });
      expect(sentBody(call)).toBe(CALL);
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers.entries())).toEqual({
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });

    test("those two headers are this route's alone: the other routes still send on only a token and a type", async () => {
      for (const path of ["/ingest/v1", "/standup/v1/tasks"] as const) {
        const up = upstream(() => json(200, { ok: true }));
        await forward(
          post(path, BODY, { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" }),
          path,
          { origin: ORIGIN, fetch: up.fetch },
        );
        expect(sentHeaders(only(up.calls))).toEqual({
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        });
      }
      const up = upstream(() => json(200, { ok: true }));
      const request = new Request(`${APP}/standup/v1/open`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" },
      });
      await forward(request, "/standup/v1/open", { origin: ORIGIN, fetch: up.fetch });
      expect(sentHeaders(only(up.calls))).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    test("the Mac's runner's two headers go on too: which of the four agents is calling, and in which run", async () => {
      const up = upstream(() => json(200, { jsonrpc: "2.0", id: 1, result: { tools: [] } }));
      await forward(
        mcp({ "X-Startup-Agent": "engineering", "X-Startup-Run": "mac-made-up-1", "X-Startup-Other": "SECRET", "X-Forwarded-For": "203.0.113.7" }),
        "/mcp/v1",
        { origin: ORIGIN, fetch: up.fetch },
      );
      expect(sentHeaders(only(up.calls))).toEqual({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-startup-agent": "engineering",
        "x-startup-run": "mac-made-up-1",
      });
    });

    test("the runner's two headers are this route's alone", async () => {
      for (const path of ["/ingest/v1", "/standup/v1/tasks"] as const) {
        const up = upstream(() => json(200, { ok: true }));
        await forward(post(path, BODY, { "X-Startup-Agent": "engineering", "X-Startup-Run": "mac-made-up-1" }), path, {
          origin: ORIGIN,
          fetch: up.fetch,
        });
        expect(sentHeaders(only(up.calls))).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
      }
    });

    test("a bot's own address goes on to that very address, with the endpoint's headers and its 401 header back", async () => {
      const up = upstream(
        () =>
          new Response('{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"x"}}', {
            status: 401,
            headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer resource_metadata=\"x\"", "Set-Cookie": "a=SECRET" },
          }),
      );
      const request = post("/mcp/v1/bot/growth", CALL, {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        "X-Startup-Agent": "growth",
        "X-Forwarded-For": "203.0.113.7",
      });
      const response = await forward(request, "/mcp/v1/bot/[botId]", { origin: ORIGIN, fetch: up.fetch });
      const sent = only(up.calls);
      expect(sent.url).toBe(`${ORIGIN}/mcp/v1/bot/growth`);
      expect(sentHeaders(sent)).toEqual({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-startup-agent": "growth",
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer resource_metadata="x"');
      expect(response.headers.get("Set-Cookie")).toBeNull();
    });

    test("a path that is not the pattern route's whole is a 404, and nothing is sent", async () => {
      for (const path of ["/mcp/v1/bot/Growth", "/mcp/v1/bot/growth/x", "/mcp/v1", "/ingest/v1"]) {
        const up = upstream(() => json(200, { ok: true }));
        const response = await forward(post(path, CALL), "/mcp/v1/bot/[botId]", { origin: ORIGIN, fetch: up.fetch });
        expect(up.calls).toHaveLength(0);
        expect(response.status).toBe(404);
      }
    });

    test("a notification's 202 comes back with no body", async () => {
      const up = upstream(() => new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } }));
      const response = await forward(mcp(), "/mcp/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    test("the endpoint's own 401 comes back as it is, with where to sign in", async () => {
      const refusal = { jsonrpc: "2.0", id: null, error: { code: RPC.unauthorized, message: AGENT_WORDS.unauthorized } };
      const challenge = 'Bearer resource_metadata="https://os.example.test/.well-known/oauth-protected-resource/mcp/v1"';
      const up = upstream(
        () =>
          new Response(JSON.stringify(refusal), {
            status: 401,
            headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge },
          }),
      );
      const response = await forward(mcp(), "/mcp/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(refusal);
      expect(response.headers.get("WWW-Authenticate")).toBe(challenge);
    });
  });

  describe("OAuth's routes", () => {
    test("the documents are fetched with nothing but the path, and come back as they are", async () => {
      const doc = { issuer: "https://os.example.test" };
      const up = upstream(() => json(200, doc));
      const request = new Request(`${APP}/.well-known/oauth-authorization-server`, {
        headers: { Cookie: "__convexAuthJWT=SECRET", Authorization: "Bearer SECRET" },
      });
      const response = await forward(request, "/.well-known/oauth-authorization-server", { origin: ORIGIN, fetch: up.fetch });
      expect(only(up.calls).url).toBe(`${ORIGIN}/.well-known/oauth-authorization-server`);
      expect(only(up.calls).init.method).toBe("GET");
      // The token a GET carries goes on as it does for every route; no cookie ever does.
      expect(sentHeaders(only(up.calls))).toEqual({ authorization: "Bearer SECRET" });
      expect(await response.json()).toEqual(doc);
    });

    test("the token endpoint gets the form and a client's Basic credentials, and a Basic challenge comes back", async () => {
      const up = upstream(
        () =>
          new Response('{"error":"invalid_client"}', {
            status: 401,
            headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Basic realm="Startup OS"' },
          }),
      );
      const request = new Request(`${APP}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic SECRET" },
        body: "grant_type=authorization_code&code=SECRET",
      });
      const response = await forward(request, "/oauth/token", { origin: ORIGIN, fetch: up.fetch });
      expect(sentHeaders(only(up.calls))).toEqual({
        authorization: "Basic SECRET",
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(sentBody(only(up.calls))).toBe("grant_type=authorization_code&code=SECRET");
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="Startup OS"');
    });

    test("a body over the cap is refused here, in OAuth's words", async () => {
      const up = upstream(() => json(200, {}));
      const request = new Request(`${APP}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(MAX_OAUTH_BYTES + 1),
      });
      const response = await forward(request, "/oauth/register", { origin: ORIGIN, fetch: up.fetch });
      expect(up.calls).toHaveLength(0);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "invalid_request", error_description: OAUTH_WORDS.tooLarge });
    });
  });

  test("a request with no token is passed on all the same, and the endpoint's own 401 comes back", async () => {
    const up = upstream(() => json(401, { ok: false, error: "unauthorized" }));
    const request = new Request(`${APP}/ingest/v1`, { method: "POST" });
    const response = await forward(request, "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
    expect(up.calls).toHaveLength(1);
    expect(sentHeaders(only(up.calls))).toEqual({});
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"ok":false,"error":"unauthorized"}');
  });

  test.each([400, 401, 409, 413, 422, 429, 500, 503])(
    "a %i from the endpoint comes back as it is",
    async (status) => {
      const body = { ok: false, error: "some_error", issues: [{ path: "records.3.title", message: "is required" }] };
      const up = upstream(() => json(status, body));
      const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(JSON.stringify(body));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  test("only the answer's status, type and body come back: no cookie or other header of the deployment's", async () => {
    const up = upstream(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=600",
            "Set-Cookie": "a=SECRET",
            "X-Convex-Request-Id": "SECRET",
          },
        }),
    );
    const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
    });
  });

  test("requests are made with no redirect followed, no cache and a deadline", async () => {
    const up = upstream(() => json(200, { ok: true }));
    await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
    const { init } = only(up.calls);
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  describe("when the deployment's address is not known", () => {
    test.each(PASS_THROUGH.map((route) => [route.method, route.path] as const))(
      "%s %s answers 503 in fixed words and asks nobody",
      async (method, path) => {
        const up = upstream(() => json(200, { ok: true }));
        const request =
          method === "GET" ? new Request(`${APP}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }) : post(path);
        const response = await forward(request, path, { origin: null, fetch: up.fetch });
        expect(up.calls).toHaveLength(0);
        expect(response.status).toBe(503);
        expect(response.headers.get("Content-Type")).toBe("application/json");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.text()).toBe('{"ok":false,"error":"pass_through_not_configured"}');
      },
    );
  });

  describe("a body over the endpoint's cap", () => {
    const TOO_LARGE = '{"ok":false,"error":"payload_too_large","issues":[]}';
    const CAPPED: PassThroughPath[] = ["/ingest/v1", "/standup/v1/tasks"];

    test("/mcp/v1: a body of exactly the cap is sent, and one byte more is refused as the endpoint refuses it", async () => {
      const up = upstream(() => json(200, { jsonrpc: "2.0", id: 1, result: {} }));
      const ok = await forward(post("/mcp/v1", "a".repeat(MAX_MCP_BYTES)), "/mcp/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(ok.status).toBe(200);
      expect((only(up.calls).init.body as Uint8Array).byteLength).toBe(MAX_MCP_BYTES);

      const over = await forward(post("/mcp/v1", "a".repeat(MAX_MCP_BYTES + 1)), "/mcp/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(up.calls).toHaveLength(1);
      expect(over.status).toBe(413);
      expect(over.headers.get("Cache-Control")).toBe("no-store");
      // JSON-RPC, in the words convex/mcp.ts uses: an MCP client reads no other shape.
      expect(await over.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC.invalidRequest, message: AGENT_WORDS.tooLarge },
      });
    });

    test.each(CAPPED)("%s: a body of exactly the cap is sent", async (path) => {
      const up = upstream(() => json(200, { ok: true }));
      const response = await forward(post(path, "a".repeat(BODY_CAPS[path])), path, { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(200);
      expect((only(up.calls).init.body as Uint8Array).byteLength).toBe(BODY_CAPS[path]);
    });

    test.each(CAPPED)("%s: one byte more is refused in the endpoint's words, unsent", async (path) => {
      const up = upstream(() => json(200, { ok: true }));
      const response = await forward(post(path, "a".repeat(BODY_CAPS[path] + 1)), path, { origin: ORIGIN, fetch: up.fetch });
      expect(up.calls).toHaveLength(0);
      expect(response.status).toBe(413);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe(TOO_LARGE);
    });

    test("a declared length over the cap is refused before a byte is read", async () => {
      const up = upstream(() => json(200, { ok: true }));
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      });
      const request = {
        headers: new Headers({ "Content-Length": String(MAX_INGEST_BYTES + 1) }),
        body,
      } as unknown as Request;
      const response = await forward(request, "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(413);
      expect(await response.text()).toBe(TOO_LARGE);
      expect(up.calls).toHaveLength(0);
      // A stream is asked for its first chunk when it is made, and no more.
      expect(pulled).toBeLessThanOrEqual(1);
    });

    test("a body that never ends is read no further than the cap", async () => {
      const up = upstream(() => json(200, { ok: true }));
      const CHUNK = 16 * 1024;
      let sent = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            sent += CHUNK;
            controller.enqueue(new Uint8Array(CHUNK));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      // No Content-Length, or one that understates: only what is read counts.
      const request = { headers: new Headers({ "Content-Length": "10" }), body } as unknown as Request;
      const response = await forward(request, "/standup/v1/tasks", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(413);
      expect(up.calls).toHaveLength(0);
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThanOrEqual(MAX_STANDUP_BYTES + 2 * CHUNK);
    });
  });

  describe("when the deployment cannot be reached", () => {
    const UNREACHABLE = '{"ok":false,"error":"upstream_unreachable"}';

    test.each([
      ["a network failure", () => Promise.reject(new TypeError(`fetch failed: Bearer ${TOKEN}`))],
      ["a deadline passing", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))],
      [
        "an answer that breaks off",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("SECRET reset"));
              },
            }),
            { status: 200 },
          ),
      ],
    ])("%s answers 502 in fixed words", async (_what, answer) => {
      const up = upstream(answer as () => Response | Promise<Response>);
      const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(502);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe(UNREACHABLE);
    });

    test.each([301, 302, 303, 307, 308])(
      "a %i is neither followed nor handed back: its Location stays here",
      async (status) => {
        const up = upstream(
          () =>
            new Response(null, {
              status,
              headers: { Location: "https://elsewhere.example.test/SECRET" },
            }),
        );
        const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
        expect(up.calls).toHaveLength(1);
        expect(response.status).toBe(502);
        expect(response.headers.get("Location")).toBeNull();
        expect(await response.text()).toBe(UNREACHABLE);
      },
    );

    test("a redirect the runtime hides is treated the same", async () => {
      const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", {
        value: "opaqueredirect",
      });
      const up = upstream(() => opaque);
      const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch });
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(UNREACHABLE);
    });

    test("the deadline given is the one the request is made with", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const up = upstream(() => json(200, { ok: true }));
      await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: up.fetch, timeoutMs: 1234 });
      expect(timeout).toHaveBeenCalledWith(1234);
    });
  });

  test("nothing is written to a log, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const fine = () => json(200, { ok: true });
    const answers: (() => Response | Promise<Response>)[] = [
      fine,
      () => json(401, { ok: false, error: "unauthorized" }),
      () => Promise.reject(new Error(`SECRET ${TOKEN}`)),
      () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test" } }),
    ];
    for (const answer of answers) {
      const response = await forward(post("/ingest/v1"), "/ingest/v1", { origin: ORIGIN, fetch: upstream(answer).fetch });
      if (response.status >= 500) expect(await response.text()).not.toContain("SECRET");
    }
    await forward(post("/ingest/v1"), "/ingest/v1", { origin: null, fetch: upstream(fine).fetch });
    await forward(post("/ingest/v1", "a".repeat(MAX_INGEST_BYTES + 1)), "/ingest/v1", {
      origin: ORIGIN,
      fetch: upstream(fine).fetch,
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
