// @vitest-environment jsdom
// The switches of convex/lib/features.ts as the app shows them: each one off
// takes its page, its nav entry, its tab, its box and its words away. Every
// switch is on in main; a case turns one off and `afterEach` puts it back.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { FeatureId } from "@convex/lib/features";
import { AREAS } from "@convex/lib/roles";
import type { FinanceSummary } from "@convex/lib/finance";
import type { CostsShare, MoneyOutRow, PayrollShare } from "@/lib/finance/money-out";

const switches = vi.hoisted(() => ({
  secondCompany: true,
  subsidiaryFunding: true,
  kzProduct: true,
  supportInbox: true,
  verticalStartupAgents: true,
  startupInsights: true,
  verticalStartupProduct: true,
  kztCurrency: true,
}));
vi.mock("@convex/lib/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex/lib/features")>()),
  // The made-up deployment's ids, as every test has them (convex/test.deployment.ts).
  ...(await import("@convex/lib/deployment.kit")).MADE_UP_DEPLOYMENT,
  FEATURES: switches,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
vi.mock("@/components/approvals/inbox-count", () => ({ InboxCount: () => null }));
vi.mock("@/components/notifications/notification-bell", () => ({ NotificationBell: () => null }));

const { AppShell } = await import("@/components/app-shell");
const { ViewerProvider } = await import("@/components/viewer-provider");
const { PageChecks } = await import("@/components/team/page-checks");
const { canOpen } = await import("@/lib/nav");
const { productOf, productsOf } = await import("@/lib/metrics/products");
const { startupFigures } = await import("@/lib/finance/group");
const { groupMoneyOut, remainderOf } = await import("@/lib/finance/money-out");
const { default: SupportLayout } = await import("@/app/(app)/support/layout");
const { default: KzProductLayout } = await import("@/app/(app)/product/kz/layout");

const off = (feature: FeatureId) => {
  switches[feature] = false;
};
beforeAll(() => {
  // jsdom has no matchMedia, which the sidebar asks for the screen's width.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  for (const feature of Object.keys(switches) as FeatureId[]) switches[feature] = true;
});

/** The owner's sidebar on Globex (where /support is), every area held (as a viewer from before the switch was turned off). */
const ownerNav = () => {
  window.localStorage.setItem("startup-os:company", "kz");
  render(
    <ViewerProvider viewer={{ role: "owner", companies: ["us", "kz"], areas: AREAS, email: "owner@example.test", name: null }}>
      <AppShell viewer={{ email: "owner@example.test", name: null }}>
        <p>the page</p>
      </AppShell>
    </ViewerProvider>,
  );
  return [...document.querySelectorAll('[data-sidebar="menu-button"]')].map((a) => a.getAttribute("href"));
};

/** What `notFound()` throws: Next.js's own 404, by its digest. */
const notFoundDigest = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? "");
  }
};

describe("supportInbox off", () => {
  test("/support is gone from the nav and links, and its route is a 404", () => {
    expect(ownerNav()).toContain("/support");
    cleanup();
    expect(notFoundDigest(() => SupportLayout({ children: null }))).toBeNull();

    off("supportInbox");
    expect(ownerNav()).not.toContain("/support");
    expect(canOpen(AREAS, "/support")).toBe(false);
    expect(canOpen(AREAS, "/finance")).toBe(true);
    expect(notFoundDigest(() => SupportLayout({ children: null }))).toMatch(/404/);
  });

  test("the team page offers no Support box", () => {
    const boxes = () => screen.queryAllByRole("checkbox", { name: /Intercom/ });
    render(<PageChecks value={[]} onChange={() => {}} />);
    expect(boxes()).toHaveLength(1);
    cleanup();
    off("supportInbox");
    render(<PageChecks value={[]} onChange={() => {}} />);
    expect(boxes()).toHaveLength(0);
  });
});

describe("kzProduct off", () => {
  test("/product has no Kazakhstan tab, and a clinic's page is a 404", () => {
    expect(productsOf("kz").map((p) => p.id)).toEqual(["kz_product"]);
    off("kzProduct");
    expect(productsOf("kz")).toEqual([]);
    expect(productsOf(null).map((p) => p.id)).not.toContain("kz_product");
    expect(productOf("kz_product", null)?.id).not.toBe("kz_product");
    expect(canOpen(AREAS, "/product/kz/clinics/org_1")).toBe(false);
    expect(canOpen(AREAS, "/product")).toBe(true);
    expect(notFoundDigest(() => KzProductLayout({ children: null }))).toMatch(/404/);
  });
});

describe("startupInsights off", () => {
  test("/product has no Startup Insights tab", () => {
    off("startupInsights");
    expect(productsOf("us").map((p) => p.id)).toEqual(["vertical_startup"]);
    expect(productOf(null, "us")?.id).toBe("vertical_startup");
  });
});

describe("verticalStartupProduct off", () => {
  test("/product has no Vertical Startup tab", () => {
    off("verticalStartupProduct");
    expect(productsOf("us").map((p) => p.id)).toEqual(["startup_insights"]);
    expect(productOf("vertical_startup", "us")?.id).toBe("startup_insights");
  });

  test("with every product switched off there is no tab at all, and no product to fall back on", () => {
    for (const feature of ["verticalStartupProduct", "startupInsights", "secondCompany"] as const) off(feature);
    expect(productsOf(null)).toEqual([]);
    expect(productOf(null, "us")).toBeNull();
    expect(productOf("vertical_startup", null)).toBeNull();
    expect(canOpen(AREAS, "/product")).toBe(true);
  });
});

describe("subsidiaryFunding off", () => {
  // Startup's burn over one month, and no figure of what it sent Globex.
  const summary = {
    cash: null,
    average: { value: 50_000, months: ["2026-09-01"], expected: ["2026-09-01"] },
    burn: [{ periodStart: "2026-09-01", value: 50_000 }],
  } as unknown as FinanceSummary;

  test("Startup's part of the group's burn is its whole burn, waiting for nothing", () => {
    expect(startupFigures(summary, []).groupBurn).toBeNull();
    off("subsidiaryFunding");
    const figures = startupFigures(summary, []);
    expect(figures.groupBurn).toEqual({ amount: 50_000, months: ["2026-09-01"] });
    expect(figures.unsent).toEqual([]);
  });

  test("the group's money out needs no figure of what was sent", () => {
    const pay: PayrollShare = { kind: "known", amount: 0, basis: "live" };
    const costs: CostsShare = { kind: "known", amount: 0, byCategory: [] };
    const row = (actual: number): MoneyOutRow => ({
      month: "2026-09",
      actual,
      moneyIn: null,
      payroll: pay,
      costs,
      sent: null,
      remainder: remainderOf(actual, pay, costs),
    });
    const us = { currency: "USD" as const, fx: 500, rows: [row(10_000_00)], holdsPayroll: true, holdsCosts: true };
    const kz = { currency: "KZT" as const, fx: 500, rows: [row(500_000_00)], holdsPayroll: true, holdsCosts: true };
    expect(groupMoneyOut(us, kz, 500).rows[0]!.actual).toBeNull();
    off("subsidiaryFunding");
    expect(groupMoneyOut(us, kz, 500).rows[0]!.actual).toBe(11_000_00);
  });
});
