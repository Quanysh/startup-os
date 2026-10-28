import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PASS_THROUGH } from "@/lib/os/pass-through-routes";
import proxy, { config } from "./proxy";

// The session code reads the request's Host through Next's request scope,
// which only a running Next server provides. The rest of it is the real thing.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "os.example.test" }),
  // No session: an empty jar.
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const APP = "https://os.example.test";
const EVENT = {} as NextFetchEvent;

/** What the proxy does with a request that has no session cookie. */
async function signedOut(path: string, method = "GET") {
  const response = await proxy(new NextRequest(`${APP}${path}`, { method }), EVENT);
  return {
    status: response?.status,
    location: response?.headers.get("Location") ?? null,
    // What NextResponse.next() is: the request goes on to its route.
    goesOn: response?.headers.get("x-middleware-next") === "1",
    headers: Object.fromEntries(response?.headers.entries() ?? []),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sign-in redirect", () => {
  test.each(["/", "/today", "/today/connect", "/finance", "/settings/team", "/no-such-page"])(
    "%s without a session goes to /signin",
    async (path) => {
      const result = await signedOut(path);
      expect(result.status).toBe(307);
      expect(result.location).toBe(`${APP}/signin`);
    },
  );

  test("OAuth's consent page goes to /signin with the page and its request to come back to", async () => {
    const request = "?response_type=code&client_id=sosc_x&state=a%20b";
    const result = await signedOut(`/oauth/authorize${request}`);
    expect(result.status).toBe(307);
    const location = new URL(result.location!);
    expect(`${location.origin}${location.pathname}`).toBe(`${APP}/signin`);
    expect(location.searchParams.get("next")).toBe(`/oauth/authorize${request}`);
  });

  test("/signin itself is shown", async () => {
    const result = await signedOut("/signin");
    expect(result.location).toBeNull();
    expect(result.goesOn).toBe(true);
  });
});

describe("the token routes passed through to the deployment", () => {
  // A pattern route's slot filled with a bot id, as a request would carry it.
  test.each(PASS_THROUGH.map((route) => [route.method, route.path.replace("[botId]", "growth")] as const))(
    "%s %s without a session reaches its route, not /signin",
    async (method, path) => {
      const result = await signedOut(path, method);
      expect(result.status).toBe(200);
      expect(result.location).toBeNull();
      expect(result.goesOn).toBe(true);
      // Nothing set on the way: no cookie, no rewritten header.
      expect(result.headers).toEqual({ "x-middleware-next": "1" });
    },
  );

  test("they skip the session code entirely: nothing is asked of anyone, and nothing is logged", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const errored = vi.spyOn(console, "error").mockImplementation(() => {});
    // `?code=` is what the session code would otherwise try to redeem, and a
    // cookie is what it would otherwise try to refresh.
    const request = new NextRequest(`${APP}/ingest/v1?code=SECRET`, {
      method: "POST",
      headers: { Cookie: "__convexAuthJWT=SECRET; __convexAuthRefreshToken=SECRET" },
    });
    const response = await proxy(request, EVENT);
    expect(response?.headers.get("x-middleware-next")).toBe("1");
    expect(response?.headers.get("Location")).toBeNull();
    expect(response?.headers.get("Set-Cookie")).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  test.each([
    "/ingest",
    "/ingest/",
    "/ingest/v1/",
    "/ingest/v1/more",
    "/ingest/v2",
    "/ingest/V1",
    "/x/ingest/v1",
    "/standup",
    "/standup/v1",
    "/standup/v1/open/",
    "/standup/v1/open/more",
    "/standup/v1/tasks/1",
    "/standup/v1/done",
    "/mcp",
    "/mcp/v1/",
    "/mcp/v1/sse",
    "/mcp/v2",
    "/google/callback",
    "/os/health",
    "/oauth",
    "/oauth/authorize/x",
    "/oauth/tokens",
  ])("no other path gained a way round: %s still goes to /signin", async (path) => {
    for (const method of ["GET", "POST"]) {
      const result = await signedOut(path, method);
      expect(result.status).toBe(307);
      // A closing slash on the request is kept on the redirect.
      expect(result.location).toMatch(/^https:\/\/os\.example\.test\/signin\/?$/);
      expect(result.goesOn).toBe(false);
    }
  });

  test.each([
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-authorization-server/mcp/v1",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource/mcp/v1",
    "/mcp/.well-known/oauth-authorization-server",
    "/mcp/v1/.well-known/oauth-authorization-server",
    "/mcp/v1/.well-known/openid-configuration",
    "/mcp/v1/.well-known/oauth-protected-resource",
  ])("%s without a session reaches its route, not the sign-in page", async (path) => {
    const result = await signedOut(path);
    expect(result.status).toBe(200);
    expect(result.location).toBeNull();
    expect(result.goesOn).toBe(true);
  });

  test("the matcher is as it was: the routes are let by here, not carved out of it", () => {
    expect(config.matcher).toEqual(["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"]);
  });
});
