import { passThrough } from "./pass-through";

// A client that treats the MCP URL as the issuer asks for the metadata there
// (`/mcp/v1/.well-known/oauth-authorization-server`) instead of at the root.
// The same documents, from the same place (convex/oauth.ts). Anything else
// under that prefix is a JSON 404, never the app's HTML page.

const authorization = passThrough("/.well-known/oauth-authorization-server");
const resource = passThrough("/.well-known/oauth-protected-resource");

const notFound = () =>
  Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export function discoveryAlias(request: Request): Promise<Response> | Response {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return notFound();
  }
  if (path.includes("/oauth-protected-resource")) return resource(request);
  if (
    path.endsWith("/oauth-authorization-server") ||
    path.endsWith("/openid-configuration") ||
    path.includes("/oauth-authorization-server/")
  ) {
    return authorization(request);
  }
  return notFound();
}
