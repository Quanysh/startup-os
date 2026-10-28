import { passThrough } from "@/lib/os/pass-through";

// An alias of /.well-known/oauth-authorization-server: the same JSON, from the
// same place (convex/oauth.ts). Clients look for the authorization server's
// metadata here too (RFC 8414's path-inserted form, OpenID discovery).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = passThrough("/.well-known/oauth-authorization-server");
