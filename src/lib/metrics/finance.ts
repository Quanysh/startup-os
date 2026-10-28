// The money numbers nobody types in: net burn, runway, burn multiple.
//
// The code is in convex/lib/finance.ts: pure, and shared with the owner's
// agent (convex/lib/mcpTools.ts, the `budget` tool), which works runway out
// inside Convex. Convex cannot import from src/, so it lives there and the
// app reads it through this path, as it always has.
export * from "@convex/lib/finance";
