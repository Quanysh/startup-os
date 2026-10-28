import { passThrough } from "@/lib/os/pass-through";

// An alias of /.well-known/oauth-authorization-server: the same JSON, from the
// same place (convex/oauth.ts). Clients insert the first segment of the MCP
// path here (RFC 8414) as well as under /mcp/v1.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = passThrough("/.well-known/oauth-authorization-server");
