import { beforeAll, describe, expect, test, vi } from "vitest";

// Production's failure: NEXT_PUBLIC_CONVEX_URL named the deployment that has
// OAuth, and NEXT_PUBLIC_CONVEX_SITE_URL named an older one. Discovery and
// POST /oauth/token then came back as that backend's plain-text
// "No matching routes found", and a path a client appends to the MCP URL
// came back as the app's HTML page. These handlers must answer JSON from
// the deployment the client URL names.

const CLOUD = "https://made-up-animal-123.convex.cloud";
const SITE = "https://made-up-animal-123.convex.site";
const STALE = "https://stale-animal-000.convex.site";

const METADATA = {
  issuer: "https://os.example.com",
  authorization_endpoint: "https://os.example.com/oauth/authorize",
  token_endpoint: "https://os.example.com/oauth/token",
  grant_types_supported: ["authorization_code", "refresh_token"],
};

const REFRESHED = {
  access_token: "soso_access",
  refresh_token: "sosr_next",
  token_type: "Bearer",
  expires_in: 3600,
};

type Handlers = {
  root: (request: Request) => Promise<Response>;
  mcp: (request: Request) => Promise<Response>;
  mcpV1: (request: Request) => Promise<Response>;
  openid: (request: Request) => Promise<Response>;
  resource: (request: Request) => Promise<Response>;
  resourceMcp: (request: Request) => Promise<Response>;
  token: (request: Request) => Promise<Response>;
  appended: (request: Request) => Promise<Response> | Response;
};

const calls: { url: string; init: RequestInit }[] = [];

function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const href = String(url);
  calls.push({ url: href, init: init ?? {} });
  const path = new URL(href).pathname;
  const body = path === "/oauth/token" ? REFRESHED : METADATA;
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

let handlers: Handlers;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", CLOUD);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", STALE);
  vi.resetModules();
  const [root, mcp, mcpV1, openid, resource, resourceMcp, token, alias] = await Promise.all([
    import("@/app/.well-known/oauth-authorization-server/route"),
    import("@/app/.well-known/oauth-authorization-server/mcp/route"),
    import("@/app/.well-known/oauth-authorization-server/mcp/v1/route"),
    import("@/app/.well-known/openid-configuration/route"),
    import("@/app/.well-known/oauth-protected-resource/route"),
    import("@/app/.well-known/oauth-protected-resource/mcp/v1/route"),
    import("@/app/oauth/token/route"),
    import("./discovery-alias"),
  ]);
  handlers = {
    root: root.GET,
    mcp: mcp.GET,
    mcpV1: mcpV1.GET,
    openid: openid.GET,
    resource: resource.GET,
    resourceMcp: resourceMcp.GET,
    token: token.POST,
    appended: alias.discoveryAlias,
  };
});

async function jsonFrom(run: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", fakeFetch);
  calls.length = 0;
  const response = await run();
  const type = response.headers.get("Content-Type") ?? "";
  const text = await response.text();
  expect(type).toContain("application/json");
  expect(text).not.toContain("No matching routes found");
  expect(text.trimStart().startsWith("<")).toBe(false);
  return { response, body: JSON.parse(text) as unknown, calls: [...calls] };
}

describe("OAuth discovery stays JSON and follows the client URL's deployment", () => {
  test.each([
    ["/.well-known/oauth-authorization-server", "root"],
    ["/.well-known/oauth-authorization-server/mcp", "mcp"],
    ["/.well-known/oauth-authorization-server/mcp/v1", "mcpV1"],
    ["/.well-known/openid-configuration", "openid"],
    ["/.well-known/oauth-protected-resource", "resource"],
    ["/.well-known/oauth-protected-resource/mcp/v1", "resourceMcp"],
  ] as const)("GET %s is application/json from this deployment", async (path, key) => {
    const { response, body, calls: sent } = await jsonFrom(() =>
      handlers[key](new Request(`https://os.example.com${path}`)),
    );
    expect(response.status).toBe(200);
    expect(body).toEqual(METADATA);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.startsWith(SITE)).toBe(true);
    expect(sent[0]?.url.startsWith(STALE)).toBe(false);
  });

  test("a refresh at POST /oauth/token is application/json from this deployment", async () => {
    const { response, body, calls: sent } = await jsonFrom(() =>
      handlers.token(
        new Request("https://os.example.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token&refresh_token=sosr_old&client_id=sosc_x",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(body).toEqual(REFRESHED);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${SITE}/oauth/token`);
    expect(sent[0]?.init.method).toBe("POST");
    const raw = sent[0]?.init.body;
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array();
    expect(new TextDecoder().decode(bytes)).toBe(
      "grant_type=refresh_token&refresh_token=sosr_old&client_id=sosc_x",
    );
  });

  test("appending /.well-known to the MCP URL is JSON metadata, not the app page", async () => {
    const authorization = await jsonFrom(() =>
      handlers.appended(new Request("https://os.example.com/mcp/v1/.well-known/oauth-authorization-server")),
    );
    expect(authorization.response.status).toBe(200);
    expect(authorization.body).toEqual(METADATA);
    expect(authorization.calls[0]?.url).toBe(`${SITE}/.well-known/oauth-authorization-server`);

    const openid = await jsonFrom(() =>
      handlers.appended(new Request("https://os.example.com/mcp/.well-known/openid-configuration")),
    );
    expect(openid.body).toEqual(METADATA);
    expect(openid.calls[0]?.url).toBe(`${SITE}/.well-known/oauth-authorization-server`);

    const resource = await jsonFrom(() =>
      handlers.appended(new Request("https://os.example.com/mcp/v1/.well-known/oauth-protected-resource")),
    );
    expect(resource.response.status).toBe(200);
    expect(resource.calls[0]?.url).toBe(`${SITE}/.well-known/oauth-protected-resource`);

    const other = await jsonFrom(() =>
      handlers.appended(new Request("https://os.example.com/mcp/v1/.well-known/jwks.json")),
    );
    expect(other.response.status).toBe(404);
    expect(other.body).toEqual({ error: "not_found" });
    expect(other.calls).toHaveLength(0);
  });
});
