import { isPathOf } from "@/lib/os/pass-through-routes";
import { passThrough } from "@/lib/os/pass-through";

// POST /mcp/v1/bot/<bot id>, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts): one bot's own connector address
// (convex/mcp.ts, docs/assistant.md "Bots"). Every call there is that bot's.
// A path whose last segment is no bot id is a 404 here, unsent. Never
// cached, never prerendered.
//
// As at /mcp/v1: a GET with no token is answered as a POST with none is (401
// and where this address's sign-in is described); with a token, 405.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ROUTE = "/mcp/v1/bot/[botId]";

export const POST = passThrough(ROUTE);

export function GET(request: Request): Response {
  const url = new URL(request.url);
  if (!isPathOf(ROUTE, url.pathname)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!request.headers.get("authorization")) {
    return Response.json(
      { error: "invalid_token", error_description: "Sign in to use this endpoint." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
