import { passThrough } from "@/lib/os/pass-through";

// GET /.well-known/oauth-protected-resource/mcp/v1/bot/<bot id>, passed to the
// same path on the Convex deployment (src/lib/os/pass-through-routes.ts): one
// bot's own address as a protected resource (convex/oauth.ts). A path whose
// last segment is no bot id is a 404 here, unsent. Never cached, never
// prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = passThrough("/.well-known/oauth-protected-resource/mcp/v1/bot/[botId]");
