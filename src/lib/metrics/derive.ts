// Numbers worked out from stored snapshots at read time.
//
// The code is in convex/lib/attention/metricDerive.ts: pure, and shared with the
// owner's agent (convex/lib/mcpTools.ts), which works the same list out
// inside Convex. Convex cannot import from src/, so it lives there and the
// app reads it through this path, as it always has.
export * from "@convex/lib/attention/metricDerive";
