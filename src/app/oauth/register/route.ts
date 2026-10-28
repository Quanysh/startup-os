import { passThrough } from "@/lib/os/pass-through";

// POST /oauth/register, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts): OAuth for the agent endpoint
// (convex/oauth.ts), checked and answered there. Never cached, never
// prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = passThrough("/oauth/register");
