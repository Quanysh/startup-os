// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// The page only works out the address and hands it on; the view has its own tests.
vi.mock("@/components/work/connect-view", () => ({
  ConnectView: ({ ingestUrl }: { ingestUrl: string | null }) => (
    <p data-testid="address">{ingestUrl ?? "none"}</p>
  ),
}));

// The three variables are read once, when the module loads (as the build
// fixes them), so each case loads the page afresh.
async function addressWith(env: Record<string, string | undefined>) {
  cleanup();
  vi.resetModules();
  for (const name of [
    "NEXT_PUBLIC_OS_URL",
    "NEXT_PUBLIC_CONVEX_SITE_URL",
    "NEXT_PUBLIC_CONVEX_URL",
  ]) {
    vi.stubEnv(name, env[name] ?? "");
  }
  const { default: ConnectionsPage } = await import("./page");
  // The same module instance the page reads its viewer from, after the reset.
  const { ViewerProvider } = await import("@/components/viewer-provider");
  // A teammate with Today: the part that hands the address to their prompt.
  render(
    <ViewerProvider
      viewer={{ role: "cofounder", companies: ["us"], areas: ["today"], email: "me@example.test", name: null }}
    >
      <ConnectionsPage />
    </ViewerProvider>,
  );
  return screen.getByTestId("address").textContent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("the address Settings › Connections hands to a teammate's prompt", () => {
  const NEXT_PUBLIC_CONVEX_URL = "https://made-up-animal-123.convex.cloud";

  test("with no public origin it is the deployment's, as before", async () => {
    expect(await addressWith({ NEXT_PUBLIC_CONVEX_URL })).toBe(
      "https://made-up-animal-123.convex.site/ingest/v1",
    );
    // A site URL for another deployment is not the one the build was given.
    expect(
      await addressWith({
        NEXT_PUBLIC_CONVEX_URL,
        NEXT_PUBLIC_CONVEX_SITE_URL: "https://other-animal-456.convex.site",
      }),
    ).toBe("https://made-up-animal-123.convex.site/ingest/v1");
  });

  test("with a public origin it is that origin's /ingest/v1", async () => {
    expect(
      await addressWith({ NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_OS_URL: "https://os.example.test" }),
    ).toBe("https://os.example.test/ingest/v1");
  });

  test("a public origin that is not one shows no address", async () => {
    expect(
      await addressWith({ NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_OS_URL: "http://os.example.test" }),
    ).toBe("none");
  });

  test("nothing configured shows no address", async () => {
    expect(await addressWith({})).toBe("none");
  });
});
