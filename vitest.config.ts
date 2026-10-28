import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One config for everything. convex-test runs Convex functions in-memory and
// needs the edge-runtime environment (matching Convex's isolate) with
// `convex-test` inlined so Vite transforms it; the pure-function tests run
// fine there too. See https://docs.convex.dev/testing/convex-test.
export default defineConfig({
  resolve: {
    alias: {
      "@convex": fileURLToPath(new URL("./convex", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test-support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "edge-runtime",
    // Every test: a `fetch` that fails, so nothing unstubbed reaches the network.
    setupFiles: ["./convex/test.network.ts", "./convex/test.deployment.ts"],
    // `@convex-dev/auth` is inlined too: its Next.js entry imports
    // "next/server" by a path only a bundler resolves (src/proxy.test.ts).
    server: { deps: { inline: ["convex-test", "@convex-dev/auth"] } },
    include: [
      "convex/**/*.test.ts",
      "src/**/*.test.ts",
      // Component tests opt into jsdom with a `@vitest-environment jsdom`
      // comment at the top of the file.
      "src/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
  },
});
