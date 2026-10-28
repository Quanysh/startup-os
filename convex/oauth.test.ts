import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BOT_WORDS } from "./lib/botRules";
import { AGENT_WORDS } from "./lib/agentRules";
import {
  ACCESS_TOKEN_SECONDS,
  CODE_SECONDS,
  CONSENT_WORDS,
  MAX_PENDING_CLIENTS,
  OAUTH_WORDS,
  REFRESH_TOKEN_SECONDS,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./lib/oauthRules";
import { RPC } from "./lib/mcpProtocol";
import { NOW, call, rpc } from "./mcp.kit";
import {
  ENTROPY,
  REDIRECT,
  SITE,
  STATE,
  VERIFIER,
  approve,
  authorizeRequest,
  connected,
  exchange,
  formPost,
  get,
  publicClient,
  register,
} from "./oauth.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner } from "./test.setup";

// OAuth 2.1 for the agent endpoint (convex/oauth.ts): discovery, a client
// registering itself, the owner's consent, the token endpoint and
// revocation, and an access token at POST /mcp/v1. The consent page itself
// is src/app/oauth/authorize.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("SITE_URL", SITE);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const at = (ms: number) => vi.setSystemTime(NOW + ms);
const fresh = () => convexTest(schema, modules);

describe("discovery", () => {
  test("the protected resource's metadata, at the root and at the endpoint's own path (RFC 9728)", async () => {
    const t = fresh();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/v1"]) {
      const reply = await get(t, path);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(protectedResourceMetadata(SITE));
      expect(reply.headers.get("Content-Type")).toBe("application/json");
    }
  });

  test("the authorization server's metadata (RFC 8414), complete for a client that reads nothing else", async () => {
    const reply = await get(fresh(), "/.well-known/oauth-authorization-server");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(authorizationServerMetadata(SITE));
  });

  test("with no public address set, each says so instead of naming one", async () => {
    vi.stubEnv("SITE_URL", "");
    const reply = await get(fresh(), "/.well-known/oauth-authorization-server");
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: "temporarily_unavailable", error_description: OAUTH_WORDS.notConfigured });
  });

  test("a 401 from the endpoint points at the resource's metadata", async () => {
    const t = fresh();
    const response = await t.fetch("/mcp/v1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp/v1"`,
    );
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  test("a public client is given an id and no secret, with what it registered", async () => {
    const t = fresh();
    const reply = await register(t, {
      client_name: "Made-up​ Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      client_name: "Made-up Claude",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(reply.body.client_id).toMatch(/^sosc_/);
    expect(reply.body.client_secret).toBeUndefined();
  });

  test("any https redirect URI is taken (Grok's, claude.ai's, anyone's), and http only on this machine", async () => {
    const t = fresh();
    for (const uri of ["https://grok.example.test/connectors/oauth/callback", "http://127.0.0.1:43123/callback"]) {
      expect((await register(t, { redirect_uris: [uri], token_endpoint_auth_method: "none" })).status, uri).toBe(201);
    }
    for (const redirect_uris of [["http://grok.example.test/cb"], ["https://a.example.test/cb#x"], [], "https://a.example.test/cb"]) {
      const reply = await register(t, { redirect_uris, token_endpoint_auth_method: "none" });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: "invalid_redirect_uri", error_description: OAUTH_WORDS.redirectUris });
    }
  });

  test("a client that asks for a secret, or says nothing of one, is confidential: its secret is shown once and kept as a hash", async () => {
    const t = fresh();
    for (const method of ["client_secret_basic", "client_secret_post", undefined]) {
      const reply = await register(t, { redirect_uris: [REDIRECT], token_endpoint_auth_method: method });
      expect(reply.status).toBe(201);
      expect(reply.body.client_secret).toMatch(/^sosk_/);
      expect(reply.body.token_endpoint_auth_method).toBe(method ?? "client_secret_basic");
      const rows = await t.run((ctx) => ctx.db.query("oauthClients").collect());
      expect(JSON.stringify(rows)).not.toContain(reply.body.client_secret as string);
    }
  });

  test("an implicit flow, a password grant or an unknown auth method is refused", async () => {
    const t = fresh();
    for (const extra of [
      { response_types: ["token"] },
      { grant_types: ["password"] },
      { grant_types: ["client_credentials"] },
      { token_endpoint_auth_method: "private_key_jwt" },
    ]) {
      const reply = await register(t, { redirect_uris: [REDIRECT], ...extra });
      expect(reply.status, JSON.stringify(extra)).toBe(400);
      expect(reply.body.error).toBe("invalid_client_metadata");
    }
    expect((await register(t, "not json" as unknown as Record<string, unknown>)).status).toBe(400);
  });

  test(`at most ${MAX_PENDING_CLIENTS} clients may wait for the owner's approval`, async () => {
    const t = fresh();
    await t.run(async (ctx) => {
      for (let n = 0; n < MAX_PENDING_CLIENTS; n++) {
        await ctx.db.insert("oauthClients", {
          clientId: `sosc_made-up-${n}`,
          name: "Made-up",
          redirectUris: [REDIRECT],
          createdBy: "dynamic",
          createdAt: NOW,
        });
      }
    });
    const reply = await register(t, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(reply.status).toBe(429);
    expect(reply.body.error_description).toBe(OAUTH_WORDS.busy);
  });
});

describe("the consent page's functions", () => {
  test("describe names the client and where it will be sent, and what it asked for", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const asked = await owner.query(api.oauth.describe, await authorizeRequest(clientId));
    expect(asked).toMatchObject({ status: "ask", clientName: "Made-up Claude", redirectHost: "claude.example.test", asked: "act" });
    expect(asked.status === "ask" && new URL(asked.denyUrl).searchParams.get("error")).toBe("access_denied");
  });

  test("an unknown client, or a redirect URI that is not exactly a registered one, is refused on the page and nobody is redirected", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    expect(await owner.query(api.oauth.describe, await authorizeRequest("sosc_never-registered"))).toEqual({
      status: "invalid",
      words: CONSENT_WORDS.unknownClient,
    });
    for (const redirectUri of [`${REDIRECT}/`, `${REDIRECT}?x=1`, "https://evil.example.test/api/mcp/auth_callback", REDIRECT.toUpperCase()]) {
      expect(await owner.query(api.oauth.describe, await authorizeRequest(clientId, { redirectUri }))).toEqual({
        status: "invalid",
        words: CONSENT_WORDS.badRedirect,
      });
      await expect(approve(owner, clientId, "act", { redirectUri })).rejects.toThrow(CONSENT_WORDS.badRedirect);
    }
  });

  test("no PKCE, plain PKCE, another response type, a scope it does not have or another resource: sent back with the error", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const cases: [Record<string, string | undefined>, string][] = [
      [{ codeChallenge: undefined }, "invalid_request"],
      [{ codeChallengeMethod: "plain" }, "invalid_request"],
      [{ responseType: "token" }, "unsupported_response_type"],
      [{ scope: "read admin" }, "invalid_scope"],
      [{ resource: "https://elsewhere.example.test/mcp/v1" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const answer = await owner.query(api.oauth.describe, await authorizeRequest(clientId, over));
      expect(answer.status, error).toBe("error");
      const url = new URL((answer as { redirect: string }).redirect);
      expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
      expect([url.searchParams.get("error"), url.searchParams.get("state"), url.searchParams.get("iss")]).toEqual([error, STATE, SITE]);
      await expect(approve(owner, clientId, "act", over)).rejects.toThrow(CONSENT_WORDS.badRequest);
    }
  });

  test("approving sends the browser back with a code, the state exactly as sent, and the issuer", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { url, code } = await approve(owner, clientId);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(code).toMatch(/^sosx_[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("iss")).toBe(SITE);
  });

  test("a teammate can neither see nor approve a request, whatever their pages", async () => {
    const t = fresh();
    await signInAsOwner(t);
    const clientId = await publicClient(t);
    const ada = await signInAsMember(t, "cofounder", ["us", "kz"], "ada.teammate@gmail.com");
    await expect(ada.query(api.oauth.describe, await authorizeRequest(clientId))).rejects.toThrow("not_owner");
    await expect(
      ada.mutation(api.oauth.approve, { ...(await authorizeRequest(clientId)), granted: "act", entropy: ENTROPY }),
    ).rejects.toThrow("not_owner");
    expect(await t.run((ctx) => ctx.db.query("oauthCodes").collect())).toEqual([]);
  });
});

describe("the token endpoint", () => {
  test("a code with its verifier gives an hour's access token, a refresh token and the scope granted", async () => {
    const t = fresh();
    const { access, refresh, reply } = await connected(t, "act");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(reply.body).toEqual({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: "read act",
    });
    expect(access).toMatch(/^soso_/);
    expect(refresh).toMatch(/^sosr_/);
  });

  test("a resource left out is the endpoint's, so a client that never read the resource's metadata still works", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId, "read", { resource: undefined });
    const reply = await exchange(t, clientId, code, { resource: undefined });
    expect(reply.status).toBe(200);
    expect((await rpc(t, reply.body.access_token as string, "tools/list")).status).toBe(200);
  });

  test("a PKCE verifier that does not match is refused, and the code is spent", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId);
    const wrong = await exchange(t, clientId, code, { code_verifier: `${VERIFIER}-not` });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: "invalid_grant", error_description: OAUTH_WORDS.badVerifier });
    expect((await exchange(t, clientId, code, { code_verifier: undefined })).body.error).toBe("invalid_request");
    expect((await exchange(t, clientId, code)).body.error).toBe("invalid_grant");
  });

  test("a code is used once: a second exchange is refused and revokes what the first gave", async () => {
    const t = fresh();
    const { clientId, code, access } = await connected(t);
    const again = await exchange(t, clientId, code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    expect((await rpc(t, access, "ping")).status).toBe(401);
  });

  test(`a code lasts ${CODE_SECONDS} seconds`, async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId);
    at(CODE_SECONDS * 1000);
    expect((await exchange(t, clientId, code)).body).toEqual({ error: "invalid_grant", error_description: OAUTH_WORDS.badGrant });
  });

  test("the redirect URI must be the code's, and the client the code's", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const other = await publicClient(t, "https://other.example.test/cb");
    const { code } = await approve(owner, clientId);
    expect((await exchange(t, clientId, code, { redirect_uri: "https://other.example.test/cb" })).body.error).toBe("invalid_grant");
    const owner2 = owner;
    const { code: second } = await approve(owner2, clientId);
    expect((await exchange(t, other, second, { redirect_uri: "https://other.example.test/cb" })).body.error).toBe("invalid_grant");
  });

  test("a token for another resource is refused", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    const clientId = await publicClient(t);
    const { code } = await approve(owner, clientId);
    const reply = await exchange(t, clientId, code, { resource: "https://elsewhere.example.test/mcp/v1" });
    expect(reply.body).toEqual({ error: "invalid_target", error_description: OAUTH_WORDS.badTarget });
  });

  test("an access token made for another resource is refused at the endpoint", async () => {
    const t = fresh();
    const { access } = await connected(t);
    expect((await rpc(t, access, "ping")).status).toBe(200);
    // The site's address changes: the token was for the old endpoint, not this one.
    vi.stubEnv("SITE_URL", "https://elsewhere.example.test");
    expect((await rpc(t, access, "ping")).status).toBe(401);
  });

  test("an unknown grant type, or no client, is refused in the protocol's words", async () => {
    const t = fresh();
    expect((await formPost(t, "/oauth/token", { grant_type: "password", username: "x", password: "y" })).body).toEqual({
      error: "unsupported_grant_type",
      error_description: OAUTH_WORDS.grantType,
    });
    expect((await formPost(t, "/oauth/token", { grant_type: "authorization_code", code: "sosx_x" })).status).toBe(401);
  });
});

describe("refresh", () => {
  test("rotates: a new access and refresh token, and the old refresh token is refused after use", async () => {
    const t = fresh();
    const { clientId, access, refresh } = await connected(t);
    at(ACCESS_TOKEN_SECONDS * 1000 + 1);
    // The hour has passed: the access token is refused.
    expect((await rpc(t, access, "ping")).status).toBe(401);
    const turned = await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(turned.status).toBe(200);
    const next = turned.body.refresh_token as string;
    expect(next).not.toBe(refresh);
    expect((await rpc(t, turned.body.access_token as string, "ping")).status).toBe(200);

    // The old one, used again, is refused, and the whole grant goes with it (RFC 9700, 4.14.2).
    const reused = await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(reused.body.error).toBe("invalid_grant");
    expect((await rpc(t, turned.body.access_token as string, "ping")).status).toBe(401);
    expect((await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: next, client_id: clientId })).body.error).toBe(
      "invalid_grant",
    );
  });

  test(`a refresh token lasts ${REFRESH_TOKEN_SECONDS / 86_400} days unused, and only for its own client`, async () => {
    const t = fresh();
    const { clientId, refresh } = await connected(t);
    const other = await publicClient(t);
    expect((await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: other })).body.error).toBe(
      "invalid_grant",
    );
    at(REFRESH_TOKEN_SECONDS * 1000);
    expect((await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error).toBe(
      "invalid_grant",
    );
  });

  test("it cannot widen what was granted", async () => {
    const t = fresh();
    const { clientId, refresh } = await connected(t, "read");
    const wider = await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, scope: "read act" });
    expect(wider.body.error).toBe("invalid_scope");
  });
});

describe("an access token at POST /mcp/v1", () => {
  test("initialize, tools/list and tools/call work, and the grant is a connected client with its own audit name", async () => {
    const t = fresh();
    const { owner, access } = await connected(t, "act");
    // A grant approved from now on is for the owner's bots only, until the owner turns that off.
    const [grant] = await owner.query(api.assistant.clients, {});
    expect(grant!.botsOnly).toBe(true);
    expect((await call(t, access, "task_create", { title: "Made-up task" })).said).toBe(BOT_WORDS.botsOnly);
    await owner.mutation(api.assistant.setBotsOnly, { kind: "oauth", id: grant!.id, on: false });
    expect((await rpc(t, access, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })).status).toBe(200);
    const listed = (await rpc(t, access, "tools/list")).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).toContain("task_create");
    expect(listed.map((tool) => tool.name)).not.toContain("chat_next");
    expect((await call(t, access, "task_create", { title: "Made-up task" })).output).toMatchObject({ created: true });

    const clients = await owner.query(api.assistant.clients, {});
    expect(clients.map(({ kind, name, scope, runner }) => ({ kind, name, scope, runner }))).toEqual([
      { kind: "oauth", name: "Made-up Claude", scope: "act", runner: false },
    ]);
    expect(clients[0]!.lastUsedAt).toBe(NOW);
    const [row] = await owner.query(api.assistant.recentCalls, {});
    expect(row!.client).toBe("Made-up Claude");
  });

  test("a read grant reads and cannot act; the runner's tools do not exist for it", async () => {
    const t = fresh();
    const { owner, access } = await connected(t, "read");
    const [grant] = await owner.query(api.assistant.clients, {});
    await owner.mutation(api.assistant.setBotsOnly, { kind: "oauth", id: grant!.id, on: false });
    expect((await call(t, access, "task_create", { title: "Made-up" })).said).toBe(AGENT_WORDS.readOnly);
    expect((await call(t, access, "chat_next", { runner: "runner-aaaa-0001" })).error).toEqual({
      code: RPC.invalidParams,
      message: AGENT_WORDS.unknownTool,
    });
  });

  test("its holder must still be the owner", async () => {
    const t = fresh();
    const { access } = await connected(t);
    vi.stubEnv("OWNER_EMAILS", "someone.else@example.test");
    expect((await rpc(t, access, "ping")).status).toBe(401);
  });
});

describe("revoking", () => {
  test("a revoked grant is refused at once: its access token and its refresh token", async () => {
    const t = fresh();
    const { owner, clientId, access, refresh } = await connected(t);
    const [client] = await owner.query(api.assistant.clients, {});
    await owner.mutation(api.assistant.revokeClient, { kind: "oauth", id: client!.id });
    expect((await rpc(t, access, "ping")).status).toBe(401);
    expect((await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error).toBe(
      "invalid_grant",
    );
    expect(await owner.query(api.assistant.clients, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("oauthTokens").collect())).toEqual([]);
  });

  test("a client may revoke its own grant at /oauth/revoke (RFC 7009); an unknown token is no error", async () => {
    const t = fresh();
    const { clientId, access } = await connected(t);
    expect((await formPost(t, "/oauth/revoke", { token: "soso_never-made", client_id: clientId })).status).toBe(200);
    const other = await publicClient(t);
    expect((await formPost(t, "/oauth/revoke", { token: access, client_id: other })).status).toBe(200);
    expect((await rpc(t, access, "ping")).status).toBe(200);
    expect((await formPost(t, "/oauth/revoke", { token: access, client_id: clientId })).status).toBe(200);
    expect((await rpc(t, access, "ping")).status).toBe(401);
  });

  test("connecting the same client again replaces its grant: one row a client", async () => {
    const t = fresh();
    const { owner, clientId, access } = await connected(t);
    const { code } = await approve(owner, clientId, "read");
    expect((await exchange(t, clientId, code)).status).toBe(200);
    expect((await rpc(t, access, "ping")).status).toBe(401);
    expect((await owner.query(api.assistant.clients, {})).map((row) => row.scope)).toEqual(["read"]);
  });
});

describe("a confidential client the owner adds by hand", () => {
  async function handClient(t: ReturnType<typeof fresh>) {
    const owner = await signInAsOwner(t);
    const made = await owner.mutation(api.oauth.createClient, {
      name: "Made-up Grok app",
      redirectUris: [REDIRECT],
      entropy: ENTROPY,
    });
    return { owner, ...made };
  }

  test("its secret is shown once, kept as a hash, and listed without it", async () => {
    const t = fresh();
    const { owner, clientId, clientSecret } = await handClient(t);
    expect(clientId).toMatch(/^sosc_/);
    expect(clientSecret).toMatch(/^sosk_/);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("oauthClients").collect()))).not.toContain(clientSecret);
    const listed = await owner.query(api.oauth.handClients, {});
    expect(listed).toEqual([
      { id: listed[0]!.id, clientId, name: "Made-up Grok app", redirectUris: [REDIRECT], createdAt: NOW },
    ]);
    expect(JSON.stringify(listed)).not.toContain("sosk_");
  });

  test("the token endpoint takes its secret in the body or by Basic, still needs PKCE, and refuses a wrong secret", async () => {
    const t = fresh();
    const { owner, clientId, clientSecret } = await handClient(t);

    let { code } = await approve(owner, clientId);
    expect((await exchange(t, clientId, code)).status).toBe(401);
    ({ code } = await approve(owner, clientId));
    const wrong = await exchange(t, clientId, code, { client_secret: "sosk_wrong" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_client");

    ({ code } = await approve(owner, clientId));
    expect((await exchange(t, clientId, code, { client_secret: clientSecret })).status).toBe(200);

    ({ code } = await approve(owner, clientId));
    const basic = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
    const viaBasic = await formPost(
      t,
      "/oauth/token",
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER },
      { Authorization: basic },
    );
    expect(viaBasic.status).toBe(200);

    ({ code } = await approve(owner, clientId));
    expect((await exchange(t, clientId, code, { client_secret: clientSecret, code_verifier: undefined })).body.error).toBe(
      "invalid_request",
    );
  });

  test("removing it ends its sign-ins too; a teammate can do none of this", async () => {
    const t = fresh();
    const { owner, clientId, clientSecret } = await handClient(t);
    const { code } = await approve(owner, clientId);
    const access = (await exchange(t, clientId, code, { client_secret: clientSecret })).body.access_token as string;
    const ada = await signInAsMember(t, "cofounder", ["us", "kz"], "ada.teammate@gmail.com");
    const [listed] = await owner.query(api.oauth.handClients, {});
    await expect(ada.query(api.oauth.handClients, {})).rejects.toThrow("not_owner");
    await expect(ada.mutation(api.oauth.removeClient, { id: listed!.id })).rejects.toThrow("not_owner");
    await expect(
      ada.mutation(api.oauth.createClient, { name: "x", redirectUris: [REDIRECT], entropy: ENTROPY }),
    ).rejects.toThrow("not_owner");
    await owner.mutation(api.oauth.removeClient, { id: listed!.id });
    expect((await rpc(t, access, "ping")).status).toBe(401);
    expect(await owner.query(api.oauth.handClients, {})).toEqual([]);
  });

  test("a name and good redirect URIs are needed", async () => {
    const t = fresh();
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.oauth.createClient, { name: " ", redirectUris: [REDIRECT], entropy: ENTROPY })).rejects.toThrow(
      CONSENT_WORDS.nameMissing,
    );
    await expect(
      owner.mutation(api.oauth.createClient, { name: "x", redirectUris: ["http://grok.example.test/cb"], entropy: ENTROPY }),
    ).rejects.toThrow(OAUTH_WORDS.redirectUris);
  });
});

describe("nothing secret is kept or said", () => {
  test("no code, token, secret or verifier is stored in plain text, and nothing on the way logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const t = fresh();
    const { owner, clientId, code, access, refresh } = await connected(t);
    const turned = await formPost(t, "/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    const hand = await owner.mutation(api.oauth.createClient, { name: "Made-up", redirectUris: [REDIRECT], entropy: ENTROPY });
    await call(t, turned.body.access_token as string, "tasks");

    const everything = await t.run(async (ctx) =>
      JSON.stringify(
        await Promise.all(
          (["oauthClients", "oauthCodes", "oauthGrants", "oauthTokens", "agentCalls", "agentTokens"] as const).map((table) =>
            ctx.db.query(table).collect(),
          ),
        ),
      ),
    );
    for (const secret of [code, access, refresh, turned.body.access_token, turned.body.refresh_token, hand.clientSecret, VERIFIER]) {
      expect(everything).not.toContain(secret as string);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("the daily sweep forgets spent codes, dead tokens, dead grants and clients never approved", async () => {
    const t = fresh();
    const { owner, clientId } = await connected(t);
    await publicClient(t); // never approved
    const kinds = () => t.run(async (ctx) => (await ctx.db.query("oauthTokens").collect()).map((row) => row.kind));
    const clientIds = () => t.run(async (ctx) => (await ctx.db.query("oauthClients").collect()).map((row) => row.clientId));

    at(8 * 86_400_000);
    await t.mutation(internal.oauth.prune, {});
    expect(await t.run((ctx) => ctx.db.query("oauthCodes").collect())).toEqual([]);
    expect(await kinds()).toEqual(["refresh"]);
    // The approved one stays while its grant can still be refreshed.
    expect(await clientIds()).toEqual([clientId]);

    at(REFRESH_TOKEN_SECONDS * 1000 + 8 * 86_400_000);
    await t.mutation(internal.oauth.prune, {});
    expect(await kinds()).toEqual([]);
    expect(await owner.query(api.assistant.clients, {})).toEqual([]);
    await t.mutation(internal.oauth.prune, {});
    expect(await clientIds()).toEqual([]);
  });

  test("the sweep is a daily cron", async () => {
    const { default: crons } = await import("./crons");
    const jobs = (crons as unknown as { crons: Record<string, { name: string }> }).crons;
    expect(Object.keys(jobs)).toContain("prune oauth sign-ins");
  });
});
