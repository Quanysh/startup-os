import { describe, expect, test, vi } from "vitest";

// The root layout's metadata only: its fonts and providers are stood in for.
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-inter" }),
  Poppins: () => ({ variable: "font-poppins" }),
}));
vi.mock("@convex-dev/auth/nextjs/server", () => ({ ConvexAuthNextjsServerProvider: () => null }));
vi.mock("@/components/ConvexClientProvider", () => ({ default: () => null }));
vi.mock("@/components/theme-provider", () => ({ ThemeProvider: () => null }));
vi.mock("@/components/ui/tooltip", () => ({ TooltipProvider: () => null }));
vi.mock("@/styles/globals.css", () => ({}));

const { metadata } = await import("./layout");
const { PRODUCT } = await import("@convex/lib/identity");

describe("the page title and description", () => {
  // Read from the identity, whose own values deployment.test.ts pins: a fork's
  // (the public template's) description is its own.
  test("are the product's, from the identity", () => {
    expect(metadata.title).toEqual({ template: `%s · ${PRODUCT.name}`, default: PRODUCT.name });
    expect(metadata.description).toBe(`${PRODUCT.description}.`);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
