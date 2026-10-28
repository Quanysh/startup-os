// What the "Needs attention" list says about clinics.
//
// The code is in convex/lib/attention/customers.ts: pure, and shared with the
// owner's agent (convex/lib/mcpTools.ts), which works the same list out
// inside Convex. Convex cannot import from src/, so it lives there and the
// app reads it through this path, as it always has.
export * from "@convex/lib/attention/customers";
