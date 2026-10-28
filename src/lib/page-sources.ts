// Which sources each page draws on, for the "Updated …" line in its header.
//
// The map is in convex/lib/pageSources.ts: `freshness.forPage` reads it to
// know what to send and to whom, and Convex cannot import from src/. The app
// reads it through this path.
export * from "@convex/lib/pageSources";
