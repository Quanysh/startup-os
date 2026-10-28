import { passThrough } from "@/lib/os/pass-through";

// GET /.well-known/oauth-protected-resource/mcp/v1, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts): OAuth for the agent endpoint
// (convex/oauth.ts), checked and answered there. Never cached, never
// prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = passThrough("/.well-known/oauth-protected-resource/mcp/v1");
