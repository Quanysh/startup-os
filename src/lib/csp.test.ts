import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig, { buildCsp } from "../../next.config";
import { THEME_SCRIPT } from "./theme";
import { THEME_SCRIPT_SHA256 } from "./theme-hash";

const directive = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? [];

describe("buildCsp", () => {
  const production = buildCsp({ convexUrl: "https://happy-otter-123.convex.cloud", dev: false });

  test("production may talk to this app's own Convex deployment and nowhere else", () => {
    // A wildcard would let an injected script post data to any Convex
    // deployment, including one an attacker created for the purpose.
    expect(directive(production, "connect-src")).toEqual([
      "'self'",
      "https://happy-otter-123.convex.cloud",
      "wss://happy-otter-123.convex.cloud",
    ]);
  });

  test("production does not allow eval", () => {
    expect(directive(production, "script-src")).not.toContain("'unsafe-eval'");
  });

  test("production does not mention localhost", () => {
    expect(production).not.toContain("127.0.0.1");
    expect(production).not.toContain("localhost");
  });

  test("development allows eval and the local backend it was started with", () => {
    const dev = buildCsp({ convexUrl: "http://127.0.0.1:3210", dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toEqual([
      "'self'",
      "http://127.0.0.1:3210",
      "ws://127.0.0.1:3210",
    ]);
  });

  test("with no deployment URL it falls back to Convex's domain rather than to nothing", () => {
    // Keeps a build without the variable usable; the pinned form is the norm.
    const unknown = buildCsp({ convexUrl: undefined, dev: false });
    expect(directive(unknown, "connect-src")).toEqual([
      "'self'",
      "https://*.convex.cloud",
      "wss://*.convex.cloud",
    ]);
  });

  test("the page cannot be framed, and plugins are off", () => {
    expect(directive(production, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(production, "object-src")).toEqual(["'none'"]);
  });
});

// The one inline script of our own: it sets the theme before first paint
// (src/app/layout.tsx). Next.js's hydration scripts are inline too, with no
// nonce, which is why script-src carries 'unsafe-inline'.
describe("the pre-paint theme script and the policy", () => {
  const sha256 = async (text: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  };
  const pins = (sources: string[]) => sources.filter((source) => /^'(sha(256|384|512)|nonce)-/.test(source));
  const scriptSrc = (dev: boolean) =>
    directive(buildCsp({ convexUrl: "https://happy-otter-123.convex.cloud", dev }), "script-src");

  test("the hash is the hash of the script's exact text, as a browser works it out", async () => {
    // Worked out by Node from the text (src/lib/theme-hash.ts); checked here
    // the way a browser hashes it, for the day the policy starts listing hashes.
    expect(THEME_SCRIPT_SHA256).toBe(`sha256-${await sha256(THEME_SCRIPT)}`);
  });

  test.each([false, true])("the policy lets it run (dev: %j)", (dev) => {
    const scripts = scriptSrc(dev);
    if (pins(scripts).length === 0) {
      // No hash or nonce in the policy: inline scripts run by 'unsafe-inline'.
      expect(scripts).toContain("'unsafe-inline'");
    } else {
      // A browser ignores 'unsafe-inline' as soon as one hash or nonce is
      // listed, so from then on this script needs its own.
      expect(scripts).toContain(`'${THEME_SCRIPT_SHA256}'`);
    }
  });

  test("adding the theme did not change script-src", () => {
    expect(scriptSrc(false)).toEqual(["'self'", "'unsafe-inline'"]);
  });
});

describe("the security headers and the routes passed through to the deployment", () => {
  test("one rule covers every path, the four token routes included", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.map((rule) => rule.source)).toEqual(["/:path*"]);
    expect(rules[0]!.headers.map((header) => header.key)).toEqual([
      "X-Robots-Tag",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Content-Security-Policy",
    ]);
  });

  test("none of them is one the pass-through sets itself, so a JSON answer keeps its type and no-store", async () => {
    const [rule] = await nextConfig.headers!();
    const keys = rule!.headers.map((header) => header.key.toLowerCase());
    expect(keys).not.toContain("content-type");
    expect(keys).not.toContain("cache-control");
  });

  test("the app rewrites nothing: the routes are handlers, exact in path and method", () => {
    expect(nextConfig.rewrites).toBeUndefined();
  });

  describe("the one redirect: the project's first address to the OS's own", () => {
    const redirects = () => nextConfig.redirects!();
    afterEach(() => vi.unstubAllEnvs());

    test("none until the OS has a public address", async () => {
      vi.stubEnv("NEXT_PUBLIC_OS_URL", "");
      expect(await redirects()).toEqual([]);
    });

    test("with one, only the first address is sent there, path kept", async () => {
      vi.stubEnv("NEXT_PUBLIC_OS_URL", "https://os.example.com");
      expect(await redirects()).toEqual([
        {
          source: "/:path*",
          has: [{ type: "host", value: "startup-os.example.com" }],
          destination: "https://os.example.com/:path*",
          permanent: false,
        },
      ]);
    });

    test.each(["http://os.example.com", "https://os.example.com/path", "https://user:pw@os.example.com", "javascript:alert(1)"])(
      "an address that is not a bare https origin redirects nothing: %s",
      async (value) => {
        vi.stubEnv("NEXT_PUBLIC_OS_URL", value);
        expect(await redirects()).toEqual([]);
      },
    );
  });

  test("connect-src is as it was: no browser calls those routes", () => {
    // 'self' would cover the app's own origin in any case; the deployment's
    // site address (*.convex.site) is deliberately not in the policy.
    const csp = buildCsp({ convexUrl: "https://happy-otter-123.convex.cloud", dev: false });
    expect(csp).not.toContain("convex.site");
  });
});

describe("what a server function carries", () => {
  // `vercel build` runs on the owner's Mac, where the env files sit beside
  // the code; file tracing copied them into every function's bundle.
  test("no env file is traced into any function", () => {
    expect(nextConfig.outputFileTracingExcludes?.["*"]).toEqual(
      expect.arrayContaining([".env", ".env.*", ".env *"]),
    );
  });
});
