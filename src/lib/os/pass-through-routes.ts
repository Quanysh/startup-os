// The token-authenticated routes the app passes through to its Convex
// deployment, so a teammate's Claude can reach them at the app's own address
// (APP_URL/ingest/v1, convex/lib/identity.ts) as well as the deployment's
// (https://<deployment>.convex.site/ingest/v1). It is the same endpoint.
//
// The fourth, POST /mcp/v1, is the owner's agent's (convex/mcp.ts): the
// owner's clients read the OS and act in it there, on a credential the owner
// gave them. The owner decided on 2026-10-13 that it is reachable here.
//
// The last six are that endpoint's OAuth (convex/oauth.ts), so a client that
// signs in rather than taking a token (claude.ai, the Grok app) finds
// everything at the endpoint's own address: two documents that say where
// things are, open registration, the token endpoint and revocation. The
// consent page is the app's own (/oauth/authorize), behind the session, and is
// deliberately not here.
//
// Two are the Visible write-back queue (convex/visibleOutbox.ts), on the
// same Visible ingest token: the daily run fetches the queued changes and acks
// what it sent. The owner decided on 2026-10-22 that they are reachable here.
//
// Two more are pattern routes, one segment wide: each bot's own address,
// POST /mcp/v1/bot/<bot id>, and its protected resource's metadata
// (docs/assistant.md, "Bots"). `[botId]` stands for exactly one bot id of
// BOT_ID's shape (convex/lib/agents.ts, repeated here since this file imports
// nothing; a test pins the two together): never a prefix, never more.
//
// This list is exact and closed. A route is here because someone decided it
// should be: a new token route in convex/http.ts is NOT reachable through the
// app until it is added here, given a body cap (pass-through.ts) and a
// route.ts under src/app/. Convex Auth's routes (/api/auth/*) and the Google
// callback are never passed through: sign-in stays on the deployment.
//
// No imports, on purpose: src/proxy.ts reads this file too.

export const PASS_THROUGH = [
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
] as const;

export type PassThroughRoute = (typeof PASS_THROUGH)[number];
export type PassThroughPath = PassThroughRoute["path"];

/** A bot's id, as `[botId]` stands for it: BOT_ID in convex/lib/agents.ts. */
export const BOT_ID_SEGMENT = /^[a-z][a-z0-9_-]{1,39}$/;
const SLOT = "[botId]";

/** Whether a pathname is a route's: equal to it, or with `[botId]` filled by one bot id. */
function matches(route: PassThroughPath, pathname: string): boolean {
  if (!route.endsWith(SLOT)) return route === pathname;
  const prefix = route.slice(0, -SLOT.length);
  return pathname.startsWith(prefix) && BOT_ID_SEGMENT.test(pathname.slice(prefix.length));
}

/** The route a pathname is, whole (no prefix, suffix or closing slash), or null. */
export function passThroughRouteOf(pathname: string): PassThroughPath | null {
  return PASS_THROUGH.find((route) => matches(route.path, pathname))?.path ?? null;
}

/** Whether this is one of the paths above, whole: no prefix, suffix or closing slash. */
export function isPassThroughPath(pathname: string): boolean {
  return passThroughRouteOf(pathname) !== null;
}

/** Whether a pathname is this route's (a pattern route's with its one bot id). */
export const isPathOf = (route: PassThroughPath, pathname: string): boolean => matches(route, pathname);
