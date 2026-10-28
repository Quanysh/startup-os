import { describe, expect, test } from "vitest";
import http from "./http";
import type { Gate } from "./lib/owner";
import { everyFile, modules } from "./test.setup";

// The lint rule keeps raw builders out of convex/, but lint can be switched
// off or sidestepped. These tests look at what the deployment would actually
// expose, so an ungated function or a new HTTP route cannot arrive unnoticed.

// The only functions callable without being let in. Convex Auth needs the
// first three to sign anyone in at all; viewer:me reports "not let in" and
// nothing else. Adding to this list should be a deliberate, reviewed act.
const ALLOWED_UNGATED = [
  "auth:isAuthenticated",
  "auth:signIn",
  "auth:signOut",
  "viewer:me",
];

type Registered = { isPublic?: boolean; gated?: boolean; gate?: Gate };

async function publicFunctions() {
  const found: { id: string; gated: boolean; gate: Gate | undefined }[] = [];
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/")) continue;
    const exports = (await load()) as Record<string, unknown>;
    const file = path.replace(/^\.\//, "").replace(/\.[^./]+$/, "");
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== "function") continue;
      // Convex marks a registered function with flags on the function object.
      const fn = value as Registered;
      if (fn.isPublic === true) {
        found.push({ id: `${file}:${name}`, gated: fn.gated === true, gate: fn.gate });
      }
    }
  }
  return found;
}

// Files under convex/ that hold no code and that Convex does not deploy.
const NOT_CODE = ["./tsconfig.json"];

// Convex never bundles a file with two dots in its name (tests, fixtures,
// kits, auth.config.ts), whatever its extension.
const twoDots = (path: string) => path.split("/").pop()!.split(".").length > 2;

describe("public surface", () => {
  test("every file under convex/ is loaded by the module glob, so none escapes these checks", () => {
    // Convex deploys .js, .mjs, .cjs, .ts, .tsx, .mts, .cts and .jsx. If the
    // glob in test.setup.ts skipped one of them (it once skipped .tsx and
    // .jsx), a public function in such a file would be deployed and never
    // looked at below. Anything not loaded must be a two-dot file, which
    // Convex does not deploy, or be named in NOT_CODE.
    const loaded = new Set(Object.keys(modules));
    const unseen = Object.keys(everyFile)
      .filter((path) => !path.includes("/_generated/"))
      .filter((path) => !loaded.has(path) && !twoDots(path) && !NOT_CODE.includes(path))
      .sort();
    expect(unseen).toEqual([]);
    // Guards the check itself: the listing must have found the files, and
    // must see ones the module glob does not load.
    expect(Object.keys(everyFile)).toContain("./viewer.ts");
    expect(Object.keys(everyFile)).toContain("./tsconfig.json");
    expect(loaded.has("./viewer.ts")).toBe(true);
    expect(loaded.has("./publicSurface.test.ts")).toBe(false);
  });

  test("there are public functions to check", async () => {
    // Guards the test itself: if module loading silently found nothing, the
    // assertion below would pass for the wrong reason.
    expect((await publicFunctions()).length).toBeGreaterThan(10);
  });

  test("every public function is gated, apart from a short fixed list", async () => {
    const ungated = (await publicFunctions())
      .filter((fn) => !fn.gated)
      .map((fn) => fn.id)
      .sort();
    expect(ungated).toEqual(ALLOWED_UNGATED);
  });

  // The two /ingest/v1/visible/outbox routes are Visible write-back's
  // (convex/visibleOutbox.ts): both refuse anything but INGEST_TOKEN_VISIBLE.
  // The GET is a read of company data by a source's token, the second after
  // the standup's: the investor changes queued for Visible (names, stages,
  // amounts, note text), and nothing else.
  // The two /standup/v1 routes are the daily standup's (convex/standup.ts):
  // both refuse anything but INGEST_TOKEN_STANDUP, and the GET is the one
  // read of company data a source's token has. Titles only.
  // POST /telegram/v1/webhook is Telegram's (convex/telegramInbound.ts): it
  // refuses anything without the secret derived from the bot's token, and is
  // the one route whose caller holds no token the owner set.
  // /mcp/v1 is the owner's agent's (convex/mcp.ts): POST refuses anything but
  // the owner's agent token (`sosa_…`), which reads company data (the owner's
  // decision of 2026-10-13: no teammate's token does); GET answers 405.
  // /mcp/v1/bot/* is that same endpoint at one bot's own address (2026-10-19):
  // exactly one bot id after the prefix (anything else is a 404), every call
  // there that bot's; its resource metadata is the GET under
  // /.well-known/oauth-protected-resource/mcp/v1/bot/*.
  // The four /agents/v1 routes are Protocol v1.1's (convex/agentsApi.ts): each
  // refuses anything but a connected project's own token (`rap_…`), which
  // reads that project's config and test jobs, and writes that project's
  // daily totals and its own jobs' results (POST /agents/v1/jobs/{id}/results).
  // The six OAuth routes are the agent endpoint's sign-in (convex/oauth.ts):
  // two documents that say where things are, open registration (a client so
  // registered can do nothing until the owner approves it on the app's
  // consent page), and the token endpoint and revocation, which take a
  // client's own credentials and nothing else.
  test("the HTTP routes are exactly the auth routes, the ingest endpoint and Visible's outbox two, the standup's two, Telegram's webhook, the owner's agent endpoint and its OAuth, Protocol v1.1's four and Google's callback", () => {
    const routes = http
      .getRoutes()
      .map(([path, method]) => `${method} ${path}`)
      .sort();
    expect(routes).toMatchInlineSnapshot(`
      [
        "GET /.well-known/jwks.json",
        "GET /.well-known/oauth-authorization-server",
        "GET /.well-known/oauth-protected-resource",
        "GET /.well-known/oauth-protected-resource/mcp/v1",
        "GET /.well-known/oauth-protected-resource/mcp/v1/bot/*",
        "GET /.well-known/openid-configuration",
        "GET /agents/v1/config",
        "GET /agents/v1/jobs",
        "GET /api/auth/callback/*",
        "GET /api/auth/signin/*",
        "GET /google/callback",
        "GET /ingest/v1/visible/outbox",
        "GET /mcp/v1",
        "GET /mcp/v1/bot/*",
        "GET /standup/v1/open",
        "POST /agents/v1/jobs/*",
        "POST /agents/v1/usage",
        "POST /api/auth/callback/*",
        "POST /ingest/v1",
        "POST /ingest/v1/visible/outbox/ack",
        "POST /mcp/v1",
        "POST /mcp/v1/bot/*",
        "POST /oauth/register",
        "POST /oauth/revoke",
        "POST /oauth/token",
        "POST /standup/v1/tasks",
        "POST /telegram/v1/webhook",
      ]
    `);
  });
});
