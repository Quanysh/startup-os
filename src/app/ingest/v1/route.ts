import { passThrough } from "@/lib/os/pass-through";

// POST /ingest/v1, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts). Never cached, never prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = passThrough("/ingest/v1");
