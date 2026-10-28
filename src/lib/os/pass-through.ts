// Passes a request for one of the routes in pass-through-routes.ts to the
// same path on the Convex deployment, and hands the answer back. It adds
// nothing and decides nothing: the token is checked by the endpoint, as it is
// when the endpoint is called at its own address.
//
// What goes on: the route's method, the Authorization and Content-Type
// headers as sent, and the body's bytes. Nothing else (no cookie, no query,
// no address of the caller). What comes back: the status, the Content-Type
// and the body, with `Cache-Control: no-store`.
//
// One route sends on four headers more (`ALSO_FORWARDED`): POST /mcp/v1, whose
// protocol says what the client accepts and which revision it speaks, and
// whose Mac runner says which of Startup OS's own four agents is calling and in
// which run (the endpoint then lets the call use only that agent's tools).
// They are that route's alone; the others are as they were.
//
// Three routes hand one header more back (`ALSO_RETURNED`): `WWW-Authenticate`,
// which says where to sign in (POST /mcp/v1's 401) or that a client's Basic
// credentials were wrong (OAuth's token endpoint and revocation).
//
// Nothing here writes a log line, and no reply made here quotes the request
// or a failure: a request carries a token, and a body may carry names.

import { AGENT_WORDS, MAX_MCP_BYTES } from "@convex/lib/agentRules";
import { MAX_INGEST_BYTES } from "@convex/lib/ingestSchema";
import { MAX_ACK_BYTES } from "@convex/lib/investorSync";
import { RPC, rpcError } from "@convex/lib/mcpProtocol";
import { MAX_OAUTH_BYTES, OAUTH_WORDS } from "@convex/lib/oauthRules";
import { AGENT_HEADER, RUN_HEADER } from "@convex/lib/osAgents";
import { MAX_STANDUP_BYTES } from "@convex/lib/standup";
import { convexSiteOrigin } from "@/lib/work/ingest-url";
import { PASS_THROUGH, isPathOf, type PassThroughPath } from "./pass-through-routes";

/**
 * The most bytes of a body that are read and sent on: what the endpoint
 * itself refuses above. A route with no body has 0. A new route does not
 * compile until it has a line here.
 */
export const BODY_CAPS: Record<PassThroughPath, number> = {
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
};

/**
 * How long the deployment has to answer. Under the 30 seconds the push
 * scripts wait, so they are told what happened rather than giving up first.
 */
export const PASS_THROUGH_TIMEOUT_MS = 25_000;

const FORWARDED_HEADERS = ["Authorization", "Content-Type"];

/**
 * Headers one route sends on beside those two, each for a stated reason.
 * Never a cookie, a session id or anything that says who is calling: the
 * endpoint is stateless and knows its caller by the token alone.
 */
const ALSO_FORWARDED: Partial<Record<PassThroughPath, readonly string[]>> = {
  // The Model Context Protocol: what the client will read back, and the
  // revision it speaks (convex/lib/mcpProtocol.ts). And the Mac's runner's
  // two (convex/lib/osAgents.ts): which of the four agents is calling and in
  // which run. Each only narrows what a call may do: the token alone says who.
  "/mcp/v1": ["Accept", "MCP-Protocol-Version", AGENT_HEADER, RUN_HEADER],
  // A bot's own address: the same endpoint. The two agent headers go on so the
  // endpoint can refuse one that names anyone but the address's bot.
  "/mcp/v1/bot/[botId]": ["Accept", "MCP-Protocol-Version", AGENT_HEADER, RUN_HEADER],
};

/** Headers one route hands back beside the type, each for a stated reason. */
const ALSO_RETURNED: Partial<Record<PassThroughPath, readonly string[]>> = {
  // Where an OAuth client signs in (RFC 9728): the MCP authorization specification's 401.
  "/mcp/v1": ["WWW-Authenticate"],
  "/mcp/v1/bot/[botId]": ["WWW-Authenticate"],
  // A client's Basic credentials refused (RFC 6749, 5.2).
  "/oauth/token": ["WWW-Authenticate"],
  "/oauth/revoke": ["WWW-Authenticate"],
};

function reply(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}

const notConfigured = () => reply(503, '{"ok":false,"error":"pass_through_not_configured"}');
const unreachable = () => reply(502, '{"ok":false,"error":"upstream_unreachable"}');
const notFound = () => reply(404, '{"ok":false,"error":"not_found"}');
// The endpoint's own words for it (convex/ingest.ts, convex/standup.ts), and
// for the agent endpoint the JSON-RPC answer it gives itself (convex/mcp.ts):
// its client reads no other shape.
const OAUTH_TOO_LARGE = JSON.stringify({ error: "invalid_request", error_description: OAUTH_WORDS.tooLarge });
const TOO_LARGE: Partial<Record<PassThroughPath, string>> = {
  "/mcp/v1": JSON.stringify(rpcError(null, RPC.invalidRequest, AGENT_WORDS.tooLarge)),
  "/mcp/v1/bot/[botId]": JSON.stringify(rpcError(null, RPC.invalidRequest, AGENT_WORDS.tooLarge)),
  "/oauth/register": OAUTH_TOO_LARGE,
  "/oauth/token": OAUTH_TOO_LARGE,
  "/oauth/revoke": OAUTH_TOO_LARGE,
};
const tooLarge = (path: PassThroughPath) =>
  reply(413, TOO_LARGE[path] ?? '{"ok":false,"error":"payload_too_large","issues":[]}');

/** The body's bytes, or null once it is known to be over `cap`. Never holds more than a chunk past it. */
async function readCapped(request: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > cap) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export type ForwardOptions = {
  /** The deployment's HTTP-actions origin; null when the configuration gives none. */
  origin: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Sends `request` to `path` on the deployment and returns its answer.
 * 503 when the deployment's address is not known, 413 for a body over the
 * endpoint's cap, 502 when no answer could be read or the answer was a
 * redirect (never followed, never handed back).
 */
export async function forward(
  request: Request,
  path: PassThroughPath,
  options: ForwardOptions,
): Promise<Response> {
  const route = PASS_THROUGH.find((candidate) => candidate.path === path);
  if (options.origin === null || route === undefined) return notConfigured();
  // A pattern route goes on to the path asked for, once it is that route's
  // whole (one bot id in its slot); an exact route to itself.
  let target: string = path;
  if (path.includes("[")) {
    let asked: string;
    try {
      asked = new URL(request.url).pathname;
    } catch {
      return notFound();
    }
    if (!isPathOf(path, asked)) return notFound();
    target = asked;
  }

  const headers = new Headers();
  for (const name of [...FORWARDED_HEADERS, ...(ALSO_FORWARDED[path] ?? [])]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (route.method !== "GET") {
    let read: Uint8Array<ArrayBuffer> | null;
    try {
      read = await readCapped(request, BODY_CAPS[path]);
    } catch {
      // The caller went away mid-body. There is nothing to send on.
      return reply(400, '{"ok":false,"error":"body_unreadable"}');
    }
    if (read === null) return tooLarge(path);
    body = read;
  }

  try {
    const send = options.fetch ?? fetch;
    const answer = await send(`${options.origin}${target}`, {
      method: route.method,
      headers,
      body,
      // A redirect would carry the token, and the body, to wherever it points.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? PASS_THROUGH_TIMEOUT_MS),
    });
    if (answer.type === "opaqueredirect" || (answer.status >= 300 && answer.status < 400)) {
      return unreachable();
    }
    const bytes = await answer.arrayBuffer();
    // A status that carries no body cannot be built with one.
    const empty = answer.status === 204 || answer.status === 205;
    return new Response(empty ? null : bytes, {
      status: answer.status,
      headers: {
        ...(answer.headers.has("Content-Type")
          ? { "Content-Type": answer.headers.get("Content-Type")! }
          : {}),
        ...Object.fromEntries(
          (ALSO_RETURNED[path] ?? [])
            .filter((name) => answer.headers.has(name))
            .map((name) => [name, answer.headers.get(name)!]),
        ),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // Reduced to fixed words: a fetch failure can quote the headers it was given.
    return unreachable();
  }
}

// Fixed when the app is built, like every NEXT_PUBLIC variable.
const ORIGIN = convexSiteOrigin({
  siteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
});

/** The route handler for one of the paths: `export const POST = passThrough("/ingest/v1")`. */
export function passThrough(path: PassThroughPath): (request: Request) => Promise<Response> {
  return (request) => forward(request, path, { origin: ORIGIN });
}
