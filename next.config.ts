import type { NextConfig } from "next";

/**
 * The Content-Security-Policy header.
 *
 * Scripts and styles need 'unsafe-inline' (Next.js hydration, Tailwind)
 * because there is no per-request nonce, so the policy's real work is
 * limiting where the page can send data: its own origin and this app's one
 * Convex deployment, by exact host. A `*.convex.cloud` wildcard would let an
 * injected script post to any Convex deployment, including an attacker's.
 * Fonts are self-hosted by next/font. Sign-in goes to the Convex site URL as
 * a top-level navigation, which connect-src does not govern.
 *
 * The app's one inline script of its own sets the theme before first paint
 * (`THEME_SCRIPT`, src/lib/theme.ts). It runs under the same 'unsafe-inline'.
 * Do not add its hash here on its own: a browser ignores 'unsafe-inline' once
 * a hash or nonce is listed, and Next.js's scripts would stop. If the policy
 * ever moves to hashes or a nonce, `THEME_SCRIPT_SHA256` (src/lib/theme-hash.ts) is the value for it
 * (src/lib/csp.test.ts fails until it is listed).
 *
 * 'unsafe-eval' is only for the development server's hot reloading.
 */
export function buildCsp({
  convexUrl,
  dev,
}: {
  convexUrl: string | undefined;
  dev: boolean;
}): string {
  let convex: string[];
  try {
    const url = new URL(convexUrl ?? "");
    convex = [url.origin, `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`];
  } catch {
    convex = ["https://*.convex.cloud", "wss://*.convex.cloud"];
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${convex.join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// NEXT_PUBLIC_CONVEX_URL is present at build time: `convex deploy --cmd`
// injects it on Vercel, and `convex dev` writes it to .env.local.
const CSP = buildCsp({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
  dev: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Pin the workspace root to this project. Without it Next walks up looking
  // for lockfiles and can pick a stray one in a parent directory.
  turbopack: { root: __dirname },
  // No function reads an env file, so Next's own traces leave them out. This
  // is not enough on its own: Vercel's builder still copied a checkout's
  // `.env.local` and `.env.push` into every function, so production is built
  // from a clean worktree that has none. `.env *` is the
  // copies iCloud makes (".env 2.local").
  outputFileTracingExcludes: { "*": [".env", ".env.*", ".env *"] },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  // Once the OS has a public address of its own (NEXT_PUBLIC_OS_URL), the
  // project's first address sends people there: one place to sign in, and the
  // session cookie belongs to one host.
  async redirects() {
    const os = process.env.NEXT_PUBLIC_OS_URL;
    if (!os || !/^https:\/\/[a-z0-9.-]+$/.test(os)) return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "startup-os.example.com" }],
        destination: `${os}/:path*`,
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Private tool: never index it, on any domain or environment.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: CSP },
        ],
      },
    ];
  },
};

export default nextConfig;
