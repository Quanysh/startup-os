// @vitest-environment jsdom
// One-company mode as the app shows it: with the `secondCompany` switch of
// convex/lib/features.ts off, the OS is run for "us" alone. No company switch,
// no page, tab or "both" of the second company, Finance in the one company's
// own lens with no group, and no tenge anywhere. Main has both companies; a
// case turns the switch off and `afterEach` puts it back. The viewer below is
// kept on both companies, as an older teammate row would be: the app still
// shows one.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { FeatureId } from "@convex/lib/features";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import { AREAS } from "@convex/lib/roles";
import type { Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";

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
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
vi.mock("@/components/approvals/inbox-count", () => ({ InboxCount: () => null }));
vi.mock("@/components/notifications/notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/manual-entry", () => ({ ManualEntry: () => null }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const NOW = Date.UTC(2026, 9, 12, 12);

const { AppShell } = await import("@/components/app-shell");
const { ViewerProvider } = await import("@/components/viewer-provider");
const { CompanyProvider } = await import("@/components/company-provider");
const { CompanyChecks } = await import("@/components/team/company-checks");
const { lensesOf } = await import("@/components/finance/lens");
const { LineEditor } = await import("@/components/costs/line-editor");
const { default: FinancePage } = await import("@/app/(app)/finance/page");

const off = (feature: FeatureId) => {
  switches[feature] = false;
};

/** The second company's words as main has them: none may show in one-company mode. */
const SECOND_COMPANY = /Globex|Kazakhstan|\bKZ\b|\bKZT\b|tenge|₸|Group|both companies/i;

beforeAll(() => {
  // jsdom has no matchMedia, which the sidebar asks for the screen's width.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const feature of Object.keys(switches) as FeatureId[]) switches[feature] = true;
});

const owner = { role: "owner", companies: ["us", "kz"], areas: AREAS, email: "owner@example.test", name: null } as const;

/** The owner's shell, as this browser last left it: on the second company. */
const shell = () => {
  window.localStorage.setItem("startup-os:company", "kz");
  return render(
    <ViewerProvider viewer={owner}>
      <AppShell viewer={{ email: "owner@example.test", name: null }}>
        <p>the page</p>
      </AppShell>
    </ViewerProvider>,
  );
};
const navHrefs = () =>
  [...document.querySelectorAll('[data-sidebar="menu-button"]')].map((a) => a.getAttribute("href"));

describe("the shell", () => {
  test("main: the company switch offers both companies", () => {
    shell();
    const sw = screen.getByRole("group", { name: "Company" });
    expect(within(sw).getAllByRole("button")).toHaveLength(2);
    expect(navHrefs()).toContain("/support");
  });

  test("one company: no switch, and the first company's pages alone", () => {
    off("secondCompany");
    shell();
    expect(screen.queryByRole("group", { name: "Company" })).toBeNull();
    const hrefs = navHrefs();
    expect(hrefs).not.toContain("/support");
    expect(hrefs.some((href) => href?.startsWith("/product/kz"))).toBe(false);
    // The stored choice of the second company is ignored: the first company's own pages are there.
    expect(hrefs).toContain("/fundraising");
    expect(document.body.textContent).not.toMatch(SECOND_COMPANY);
  });
});

describe("the forms that ask for a company", () => {
  test("a teammate's companies are not asked for with one company", () => {
    render(<CompanyChecks value={["us"]} onChange={() => {}} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    cleanup();
    off("secondCompany");
    const { container } = render(<CompanyChecks value={["us"]} onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  test("a cost line offers dollars alone: no tenge", () => {
    const currencies = () =>
      within(screen.getByLabelText("Currency"))
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"));
    render(<LineEditor company="us" line={null} month="2026-10" onClose={() => {}} />);
    expect(currencies()).toEqual(["USD", "KZT"]);
    cleanup();
    off("secondCompany");
    render(<LineEditor company="us" line={null} month="2026-10" onClose={() => {}} />);
    expect(currencies()).toEqual(["USD"]);
  });
});

describe("Finance", () => {
  // Figures of both companies, as a server would send them in main.
  const SERIES: Record<string, [string, number][]> = {
    "cash:us": [["2026-10-12", 400_000]],
    "cash:kz": [["2026-09-30", 5_000_000]],
    "fx_usd_kzt:company": [["2026-09-01", 500]],
    "cash_in:us": [["2026-08-01", 30_000], ["2026-09-01", 32_000], ["2026-10-01", 9_000]],
    "cash_out:us": [["2026-08-01", 50_000], ["2026-09-01", 52_000], ["2026-10-01", 20_000]],
    "mrr:us": [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
    "mrr:kz": [["2026-09-01", 5_000_000]],
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
          ? { value: last[1], periodStart: last[0], currency: null, source: "manual", syncedAt: NOW }
          : null,
        series: points.map(([periodStart, value]) => ({ periodStart, value })),
      };
    }),
  );
  const page = () => {
    convex.setQuery(api.metrics.scorecard, { tiles, sources: {} });
    convex.setQuery(api.metrics.series, []);
    for (const query of [api.payroll.listPeople, api.payroll.listLines, api.payroll.listRuns, api.costs.list]) {
      convex.setQuery(query, []);
    }
    return render(
      <ViewerProvider viewer={owner}>
        <CompanyProvider>
          <FinancePage />
        </CompanyProvider>
      </ViewerProvider>,
    );
  };

  test("main: the group is the first lens, beside each company", () => {
    expect(lensesOf(["us", "kz"])).toEqual(["group", "us", "kz"]);
    page();
    expect(screen.getByRole("group", { name: "Show" })).toBeTruthy();
  });

  test("one company: no group and no lens to pick; the company's own figures, with no tenge", () => {
    off("secondCompany");
    expect(lensesOf(["us", "kz"])).toEqual(["us"]);
    // A tab that last looked at the group falls back to the one company.
    window.sessionStorage.setItem("startup-os:finance-lens", "group");
    page();
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.getByText("What the company has, what it spends and how long that lasts.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Summary" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(SECOND_COMPANY);
  });
});
