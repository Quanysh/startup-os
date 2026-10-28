import { passThrough } from "@/lib/os/pass-through";

// POST /standup/v1/tasks, passed to the same path on the Convex deployment
// (src/lib/os/pass-through-routes.ts). Never cached, never prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = passThrough("/standup/v1/tasks");
