// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import ProductPage from "./page";

// Every switch on, as main has them; a case turns some off and `afterEach` puts them back.
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
  ...(await import("@convex/lib/deployment.kit")).MADE_UP_DEPLOYMENT,
  FEATURES: switches,
}));
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/product",
}));

// Wednesday, October 14: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 12);

// What the scorecard query returns: a tile for every metric and scope, empty
// unless a series is given for it here.
const SERIES: Record<string, [string, number][]> = {
  "searches:startup_insights": [["2026-10-05", 380]],
  "core_actions:vertical_startup": [["2026-10-05", 212]],
  "clinics_using:kz_product": [["2026-09-01", 5]],
};
const tiles: Tile[] = METRICS.flatMap((metric) =>
  metricScopes(metric).map((scope) => {
    const points = SERIES[`${metric.key}:${scope}`] ?? [];
    const last = points.at(-1);
    return {
      key: metric.key,
      scope,
      firstPeriodStart: points[0]?.[0] ?? null,
      latest: last
        ? { value: last[1], periodStart: last[0], currency: null, source: "x", syncedAt: NOW }
        : null,
      series: points.map(([periodStart, value]) => ({ periodStart, value })),
    };
  }),
);

const failed = (message: string) => ({ state: "error", lastRunAt: NOW, lastOkAt: null, message });

let convex: ReturnType<typeof mockConvex>;
const ready = (sources: SourceStates = {}, product: string | null = null) => {
  convex.setQuery(api.metrics.scorecard, { tiles, sources });
  vi.mocked(useNow).mockReturnValue(NOW);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(product === null ? "" : `product=${product}`) as never,
  );
};
const openTab = () =>
  within(screen.getByRole("navigation", { name: "Products" })).getByRole("link", {
    current: "page",
  }).textContent;

beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  for (const key of Object.keys(switches) as (keyof typeof switches)[]) switches[key] = true;
});

describe("with every product switched off (a fork that has not connected one)", () => {
  test("says there is no product yet, with no tabs and no tiles", () => {
    switches.verticalStartupProduct = false;
    switches.startupInsights = false;
    switches.secondCompany = false;
    ready();
    render(<ProductPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Product health" })).toBeTruthy();
    expect(screen.getByText("No product is connected yet.")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Products" })).toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
  });
});

describe("the product page", () => {
  test.each([
    ["the scorecard", () => convex.setQuery(api.metrics.scorecard, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows the tabs and placeholders, and no number, until %s is in", (_name, withhold) => {
    ready();
    withhold();
    const { container } = render(<ProductPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Product health" })).toBeTruthy();
    expect(openTab()).toBe("Startup Insights");
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Searches" })).toBeNull();
  });

  test("the bare address is Startup Insights", () => {
    ready();
    render(<ProductPage />);
    expect(openTab()).toBe("Startup Insights");
    expect(screen.getByRole("heading", { name: "Activation rate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Searches" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Work items handled" })).toBeNull();
  });

  test("the address names the tab", () => {
    ready({}, "vertical_startup");
    const { unmount } = render(<ProductPage />);
    expect(openTab()).toBe("Vertical Startup");
    expect(screen.getByRole("heading", { name: "Work items handled" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Activation rate" })).toBeNull();
    unmount();

    ready({}, "kz_product");
    render(<ProductPage />);
    expect(openTab()).toBe("Kazakhstan");
    expect(screen.getByRole("heading", { name: "Using the product, not active" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Searches" })).toBeNull();
  });

  test("an address that names no product opens the first tab", () => {
    ready({}, "nonsense");
    render(<ProductPage />);
    expect(openTab()).toBe("Startup Insights");
  });

  describe("engineering has a page of its own", () => {
    const repo = (name: string, company: "us" | "kz") => ({
      repoId: `Made-Up-Org/${name}`,
      org: "Made-Up-Org",
      name,
      company,
      mergedLastWeek: 2,
      open: 1,
      stuck: 0,
      main: "passing" as const,
      pushedAt: "2026-10-13",
    });
    const LIST = { readAt: NOW, rows: [repo("startup-insights", "us"), repo("globex-app", "kz")] };
    const as = (areas: Area[], product: string | null = null) => {
      ready({}, product);
      // Even if the server would answer, the page no longer asks.
      convex.setQuery(api.workTools.engineering, LIST);
      return render(
        <ViewerProvider viewer={{ role: "engineer", companies: ["us", "kz"], areas, email: null, name: null }}>
          <ProductPage />
        </ViewerProvider>,
      );
    };

    test("the Engineering section is gone from the page: no heading, no repository, no figure of it", () => {
      as(["product", "engineering"]);
      expect(screen.queryByRole("region", { name: /Engineering|Figures and repositories/ })).toBeNull();
      expect(screen.queryByText("startup-insights")).toBeNull();
      expect(screen.queryByText("globex-app")).toBeNull();
      expect(screen.queryByRole("table", { name: "Repositories" })).toBeNull();
      expect(screen.queryByRole("heading", { name: /Merged last week|Failing main/ })).toBeNull();
    });

    test("the repositories are not asked of the server from here", async () => {
      as(["product", "engineering"]);
      const { useQuery } = await import("convex/react");
      const { getFunctionName } = await import("convex/server");
      const asked = vi.mocked(useQuery).mock.calls.map((call) => getFunctionName(call[0] as never));
      expect(asked).not.toContain("workTools:engineering");
      expect(asked).not.toContain("workTools:pullRequests");
    });

    test("one line links to the Engineering page, on every tab, for a viewer who has it", () => {
      for (const product of [null, "vertical_startup"]) {
        const { unmount } = as(["product", "engineering"], product);
        const link = screen.getByRole("link", { name: "the Engineering page" });
        expect(link.getAttribute("href")).toBe("/engineering");
        expect(link.closest("p")!.textContent).toBe(
          "Pull requests, who owns them and what is stuck are on the Engineering page.",
        );
        unmount();
      }
    });

    test("a viewer without it is shown no such line", () => {
      as(["product"]);
      expect(screen.queryByText(/Engineering page/)).toBeNull();
      expect(screen.queryByRole("link", { name: /Engineering/ })).toBeNull();
    });

    test("a failed GitHub read is the Engineering page's to say, not this one's", () => {
      ready({ github: failed("invalid_snapshots: snapshots.3.value") });
      render(<ProductPage />);
      expect(screen.queryByText("GitHub: last run failed")).toBeNull();
    });
  });

  describe("a failed run", () => {
    const SOURCES: SourceStates = {
      posthog: failed("PostHog answered 500 for visits."),
      vertical_startup: failed("Vertical Startup answered 401 for health."),
      mercury: failed("Mercury answered 500 for accounts."),
    };
    const attention = () => screen.queryByRole("region", { name: "Needs attention" });

    test("shows on the tab its source feeds, and only there", () => {
      ready(SOURCES);
      const { unmount } = render(<ProductPage />);
      expect(within(attention()!).getByText("PostHog answered 500 for visits.")).toBeTruthy();
      expect(screen.queryByText("Vertical Startup answered 401 for health.")).toBeNull();
      // Mercury feeds the finance page, not this one.
      expect(screen.queryByText("Mercury answered 500 for accounts.")).toBeNull();
      unmount();

      ready(SOURCES, "vertical_startup");
      render(<ProductPage />);
      expect(within(attention()!).getByText("Vertical Startup answered 401 for health.")).toBeTruthy();
      expect(screen.queryByText("PostHog answered 500 for visits.")).toBeNull();
    });

    test("of a source that feeds another tab leaves this one without the list", () => {
      // PostHog feeds the Kazakhstan tab too (the app's own usage); the others do not.
      const { posthog: _posthog, ...others } = SOURCES;
      ready(others, "kz_product");
      render(<ProductPage />);
      expect(attention()).toBeNull();
    });

    test("is the only thing listed: a number that is missing says so on its own tile", () => {
      // Every tile but one is empty, and nothing is listed for it.
      ready({ posthog: { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null } });
      render(<ProductPage />);
      expect(attention()).toBeNull();
      expect(screen.getAllByText("No value yet").length).toBeGreaterThan(0);
    });

    test("a source that is only not configured is not a failure", () => {
      ready({
        posthog: { state: "not_configured", lastRunAt: NOW, lastOkAt: null, message: "Set X." },
      });
      render(<ProductPage />);
      expect(attention()).toBeNull();
    });
  });
});
