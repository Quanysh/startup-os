import { passThrough } from "@/lib/os/pass-through";

// POST /mcp/v1, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts): the owner's agent endpoint
// (convex/mcp.ts), checked there on the owner's agent token alone. Never
// cached, never prerendered.
//
// The protocol lets a client ask for a stream with GET; this server opens
// none. A GET with no token is answered as a POST with none is (401 and where
// to sign in, as OAuth clients such as the Grok app probe it); with a token,
// 405: POST is the one method. Nothing is read or forwarded for a GET.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = passThrough("/mcp/v1");

export function GET(request: Request): Response {
  if (!request.headers.get("authorization")) {
    const origin = new URL(request.url).origin;
    return Response.json(
      { error: "invalid_token", error_description: "Sign in to use this endpoint." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/v1"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
