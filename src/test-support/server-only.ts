// Stands in for the `server-only` package under vitest (vitest.config.ts).
// The real one throws unless a Next.js build resolves it for the server, so a
// test could not load anything that imports it (src/proxy.ts does, through
// @convex-dev/auth).
export {};
