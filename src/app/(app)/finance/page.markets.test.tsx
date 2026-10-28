// @vitest-environment jsdom
// The finance page in one company's lens, for a viewer on both companies or
// on that one alone. The scorecard query answers with both companies'
// figures, as the server does for a viewer on both; the lens shows that
// company's alone. The group lens is page.test.tsx's.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import { AREAS, type Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import FinancePage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
// The form has its own tests (and reads the address).
vi.mock("@/components/manual-entry", () => ({ ManualEntry: () => null }));
// All costs keeps its sort in the address.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/finance",
  useRouter: () => ({ replace: vi.fn() }),
}));

const NOW = Date.UTC(2026, 9, 12, 12);
const BOTH_CLAUSE = /across both markets/;

const SERIES: Record<string, [string, number][]> = {
  "cash:us": [["2026-10-12", 400_000]],
  "cash:kz": [["2026-08-31", 5_369_500], ["2026-09-30", 5_000_000]],
  "fx_usd_kzt:company": [["2026-09-01", 500]],
  "cash_in:us": [["2026-08-01", 30_000], ["2026-09-01", 32_000], ["2026-10-01", 9_000]],
  "cash_out:us": [["2026-08-01", 50_000], ["2026-09-01", 52_000], ["2026-10-01", 20_000]],
  // Of cash out, what Startup sent Globex: Globex's financing.
  "cash_to_subsidiary:us": [["2026-08-01", 0], ["2026-09-01", 500], ["2026-10-01", 0]],
  "mrr:us": [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
  "mrr:kz": [["2026-09-01", 5_000_000]],
};
const SOURCE: Record<string, string> = { "cash:us": "mercury", "mrr:kz": "cfo_workbook", "fx_usd_kzt:company": "cfo_workbook" };
const tiles: Tile[] = METRICS.flatMap((metric) =>
  metricScopes(metric).map((scope) => {
    const points = SERIES[`${metric.key}:${scope}`] ?? [];
    const last = points.at(-1);
    return {
      key: metric.key,
      scope,
      firstPeriodStart: points[0]?.[0] ?? null,
      latest: last
        ? { value: last[1], periodStart: last[0], currency: null, source: SOURCE[`${metric.key}:${scope}`] ?? "manual", syncedAt: NOW }
        : null,
      series: points.map(([periodStart, value]) => ({ periodStart, value })),
    };
  }),
);
const history = (scope: "us" | "kz", points: [string, number][]) =>
  points.map(([periodStart, value]) => ({ periodStart, value, currency: null, source: "manual", syncedAt: NOW }));
const kzCash = history("kz", [
  ["2026-07-31", 5_569_500],
  ["2026-08-31", 5_369_500],
  ["2026-09-30", 5_000_000],
]);
const usCash = history("us", [
  ["2026-09-30", 420_000],
  ["2026-10-12", 400_000],
]);

let convex: ReturnType<typeof mockConvex>;
const MERCURY_OK = { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null };
const failed = (message: string) => ({ state: "error", lastRunAt: NOW, lastOkAt: NOW, message });
const ready = (sources: SourceStates = { mercury: MERCURY_OK }) => {
  convex.setQuery(api.metrics.scorecard, { tiles, sources });
  convex.setQueryBy(api.metrics.series, (args) => ((args as { scope: string }).scope === "kz" ? kzCash : usCash));
  // Payroll and Costs, asked for by a viewer who holds them (All costs, Where
  // the money goes): in, and empty.
  for (const query of [api.payroll.listPeople, api.payroll.listLines, api.payroll.listRuns, api.costs.list]) {
    convex.setQuery(query, []);
  }
  vi.mocked(useNow).mockReturnValue(NOW);
};
/**
 * The page in one company's lens, for a viewer on both companies (the lens
 * this tab picked last), or for a viewer on that company alone (`only`).
 */
const show = (company: "us" | "kz", areas?: Area[], only = false) => {
  window.sessionStorage.setItem("startup-os:finance-lens", company);
  const page = (
    <CompanyProvider>
      <FinancePage />
    </CompanyProvider>
  );
  return render(
    areas === undefined && !only ? (
      page
    ) : (
      <ViewerProvider
        viewer={{
          role: "cofounder",
          companies: only ? [company] : ["us", "kz"],
          areas: areas ?? AREAS,
          email: null,
          name: null,
        }}
      >
        {page}
      </ViewerProvider>
    ),
  );
};
const summaryTile = (label: string) =>
  within(
    within(screen.getByRole("region", { name: "Summary" }))
      .getByRole("heading", { name: label })
      .closest("article")!,
  );
const lines = (label: string) =>
  Array.from(
    within(screen.getByRole("region", { name: "Summary" }))
      .getByRole("heading", { name: label })
      .closest("article")!
      .querySelectorAll("p"),
    (p) => p.textContent,
  );
const healthNames = () =>
  Array.from(screen.getByRole("region", { name: "Revenue health" }).querySelectorAll("article"), (article) =>
    Array.from(article.querySelectorAll("header > *"), (part) => part.textContent).join(" · "),
  );
const asked = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called) === getFunctionName(ref))
    .map(([, args]) => args);

beforeEach(() => {
  // The calls are read below, and a mock keeps those of the tests before.
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("the finance page for a viewer on both companies", () => {
  test("opens on the group, says so, and says the sidebar's switch does not set it", () => {
    ready();
    // The sidebar's switch on Globex: Finance still opens on the group.
    window.localStorage.setItem("startup-os:company", "kz");
    render(
      <CompanyProvider>
        <FinancePage />
      </CompanyProvider>,
    );
    const lenses = within(screen.getByRole("group", { name: "Show" }));
    expect(lenses.getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Group", "true"],
      ["Startup", "false"],
      ["Globex", "false"],
    ]);
    expect(screen.getByRole("region", { name: "Group, in US dollars" })).toBeTruthy();
    expect(
      screen.getByText("Finance shows both companies; the company switch in the sidebar sets the other pages."),
    ).toBeTruthy();
  });

  test("a lens is picked on the page, and kept for the Budget tab", async () => {
    ready();
    render(<FinancePage />);
    fireEvent.click(screen.getByRole("button", { name: "Globex" }));
    expect(screen.getByRole("button", { name: "Globex" }).getAttribute("aria-pressed")).toBe("true");
    expect(lines("Cash")[0]).toBe("₸5M");
    expect(window.sessionStorage.getItem("startup-os:finance-lens")).toBe("kz");
  });
});

describe("the finance page for the US company", () => {
  test("the header drops 'across both markets'", () => {
    ready();
    const { container } = show("us");
    expect(screen.getByText("What the company has, what it spends and how long that lasts.")).toBeTruthy();
    expect(container.textContent).not.toMatch(BOTH_CLAUSE);
  });

  test("Startup's lens does not wait for Kazakhstan's balance history", () => {
    ready();
    // Kazakhstan's never answers.
    convex.setQueryBy(api.metrics.series, (args) => ((args as { scope: string }).scope === "kz" ? undefined : usCash));
    const { container } = show("us");
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(screen.getByRole("region", { name: "Summary" })).toBeTruthy();
  });

  test("a viewer on Startup alone: no group, no lens, nothing of Globex asked for or said", () => {
    ready();
    const { container } = show("us", undefined, true);
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Group, in US dollars" })).toBeNull();
    const series = asked(api.metrics.series).filter((args) => args !== "skip");
    expect(series.length).toBeGreaterThan(0);
    for (const args of series) expect(args).toEqual({ key: "cash", scope: "us", limit: 62 });
    expect(container.textContent).not.toMatch(/Globex|Kazakhstan|both companies/);
    // All costs is Startup's alone: Payroll and Costs are asked for Startup only.
    expect(screen.getByRole("region", { name: "All costs" })).toBeTruthy();
    for (const ref of [api.payroll.listPeople, api.payroll.listLines, api.payroll.listRuns, api.costs.list]) {
      for (const args of asked(ref).filter((args) => args !== "skip")) expect(args).toEqual({ company: "us" });
    }
  });

  test("the four numbers are the US's alone: Mercury's burn and balance, each said once with its source", () => {
    ready();
    show("us");
    expect(lines("Cash")).toEqual(["$400K", "Mercury · Oct 12"]);
    expect(summaryTile("Cash").getByText("−4.8%")).toBeTruthy();
    // August and September burned 20,000 each; July is before Mercury's first month.
    expect(lines("Net burn")).toEqual([
      "$20K / mo",
      "Mercury",
      "Average of 2 of the last 3 months. The rest are not complete.",
      "Jul 2026 is missing Mercury's figures.",
      // The bank's figure: what Startup sent Globex is in it, and said.
      "Includes $250 a month sent to Globex.",
    ]);
    expect(lines("Runway")[0]).toBe("20 mo");
    expect(summaryTile("Runway").getByText("Runs out in Jun 2028")).toBeTruthy();
    expect(summaryTile("MRR").getByText("$5,500")).toBeTruthy();
    expect(summaryTile("MRR").getByText("Typed in · Oct 2026")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Summary" }).textContent).not.toMatch(
      /Kazakhstan|KZT|₸|CFO workbook|every market/,
    );
  });

  test("where the money goes is Mercury's money out, with its financing note", () => {
    ready();
    show("us");
    const money = within(screen.getByRole("region", { name: "Where the money goes" }));
    expect(money.getByText(/Money out from Mercury/)).toBeTruthy();
    expect(money.getByRole("link", { name: "Record financing received" })).toBeTruthy();
  });

  test("the plan is asked for, and only here: it is Startup's", () => {
    ready();
    convex.setQuery(api.plan.get, null);
    show("us");
    expect(asked(api.plan.get)).toContainEqual({});
    expect(
      within(screen.getByRole("region", { name: "Plan against reality" })).getByText(
        /No plan from the financial model yet/,
      ),
    ).toBeTruthy();
  });

  test("only the US's stored figures follow, then the burn multiple", () => {
    ready();
    show("us");
    expect(healthNames()).toEqual(["Paying clinics · US", "Burn multiple"]);
  });

  test("a failed workbook push is Kazakhstan's to hear about, a failed Mercury run is the US's", () => {
    ready({ mercury: failed("Mercury answered 401."), cfo_workbook: failed("The workbook push was refused.") });
    show("us");
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("link").map((a) => a.textContent)).toEqual([
      expect.stringContaining("Mercury answered 401."),
    ]);
  });
});

describe("the finance page for the Kazakhstan company", () => {
  test("the header drops 'across both markets'", () => {
    ready();
    const { container } = show("kz");
    expect(screen.getByText("What the company has, what it spends and how long that lasts.")).toBeTruthy();
    expect(container.textContent).not.toMatch(BOTH_CLAUSE);
  });

  test("Kazakhstan's balance history is asked for, and waited for; the US's is not waited for", () => {
    ready();
    convex.setQueryBy(api.metrics.series, (args) => ((args as { scope: string }).scope === "kz" ? undefined : usCash));
    const { container, unmount } = show("kz");
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    unmount();
    convex.setQueryBy(api.metrics.series, (args) => ((args as { scope: string }).scope === "us" ? undefined : kzCash));
    expect(show("kz").container.querySelector("[aria-busy]")).toBeNull();
  });

  test("a viewer on Globex alone: nothing of Startup asked for or said, its plan included", () => {
    ready({ mercury: failed("Mercury answered 401."), cfo_workbook: MERCURY_OK });
    convex.setQuery(api.plan.get, null);
    const { container } = show("kz", undefined, true);
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    const series = asked(api.metrics.series).filter((args) => args !== "skip");
    expect(series.length).toBeGreaterThan(0);
    for (const args of series) expect(args).toEqual({ key: "cash", scope: "kz", limit: 400 });
    expect(asked(api.plan.get).every((args) => args === "skip")).toBe(true);
    expect(screen.queryByRole("region", { name: "Plan against reality" })).toBeNull();
    expect(container.textContent).not.toMatch(/Startup|Mercury|both companies/);
  });

  test("the four numbers are Globex's: tenge first, dollars alongside, burn from its month-ends", () => {
    ready();
    show("kz");
    expect(lines("Cash")).toEqual([
      "₸5M",
      "≈ $10K",
      "Typed in · Sep 30",
      "Converted at ₸500 per $1, the Sep 2026 rate.",
    ]);
    // August fell 200,000 tenge; September 369,500, and Startup sent $500
    // (₸250,000) that lifted it: its own burn was ₸619,500. 400 and 1,239 dollars.
    expect(lines("Net burn (from cash)")).toEqual([
      "₸409.8K / mo",
      "≈ $820 / mo",
      "Typed-in month-end balances and Mercury",
      "Average of 2 of the last 3 months. The rest are not complete.",
      "Jul 2026 has no Kazakhstan burn figure: the balance at the end of Jun 2026 is missing.",
      "What Startup sent, ₸125K a month, is taken out as financing, not counted as income.",
      "Money out less money in, from month-end balances: not Globex's actual spend, which is typed in on the Budget tab.",
    ]);
    // How long its ₸5M lasts without new money from Startup.
    expect(lines("Runway")[0]).toBe("12.2 mo");
    expect(lines("Runway")).toContain("Without new money from Startup.");
    expect(summaryTile("MRR").getByText("₸5M")).toBeTruthy();
    expect(summaryTile("MRR").getByText("CFO workbook · Sep 2026")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Summary" }).textContent).not.toMatch(/\bUS\b|every market/);
  });

  test("before Mercury has read a month of what Startup sent to its end, Globex's burn waits for it", () => {
    ready({});
    show("kz");
    expect(lines("Net burn (from cash)")).toEqual([
      "Not known yet",
      "None of the last three months is complete yet.",
      "Jul 2026 has no Kazakhstan burn figure: the balance at the end of Jun 2026 is missing.",
      "Aug 2026 is missing Mercury's figure for what Startup sent Globex.",
      "Sep 2026 is missing Mercury's figure for what Startup sent Globex.",
    ]);
    expect(lines("Runway")[0]).toBe("Not known yet");
  });

  test("there is no Mercury chart and no financing note", () => {
    ready();
    show("kz");
    expect(screen.queryByText(/Money out from Mercury/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Record financing received" })).toBeNull();
    expect(screen.queryByText(/Financing is left out/)).toBeNull();
  });

  test("money out is the spend typed on the Budget tab, asked for as Globex's", () => {
    ready();
    show("kz");
    expect(asked(api.budget.view)).toContainEqual({ company: "kz", first: "2026-04", count: 6 });
    expect(asked(api.costs.list)).toContainEqual({ company: "kz" });
  });

  test("the plan is Startup's: not asked for here, and the page says where it is", () => {
    ready();
    show("kz");
    expect(asked(api.plan.get).every((args) => args === "skip")).toBe(true);
    expect(
      within(screen.getByRole("region", { name: "Plan against reality" })).getByText(
        /The financial model's plan is Startup's/,
      ),
    ).toBeTruthy();
  });

  test("only Kazakhstan's stored figures follow; the rate is said where it converts, not as a tile", () => {
    ready();
    show("kz");
    expect(healthNames()).toEqual([
      "Paying clinics · Kazakhstan",
      "Active clients · Kazakhstan",
      "Contracted monthly fees · Kazakhstan",
      "Owed by clients · Kazakhstan",
      "Average monthly client churn · Kazakhstan",
      "Burn multiple",
    ]);
  });

  test("a failed Mercury run is not shown here; a failed workbook push is", () => {
    ready({ mercury: failed("Mercury answered 401.") });
    const { unmount } = show("kz");
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    unmount();

    ready({ mercury: failed("Mercury answered 401."), cfo_workbook: failed("The workbook push was refused.") });
    show("kz");
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("link").map((a) => a.textContent)).toEqual([
      expect.stringContaining("The workbook push was refused."),
    ]);
  });
});

describe("a co-founder with Finance alone (access must not widen)", () => {
  test("sends no Payroll or Costs query, sees no ARR per person, and is told where pay and costs are", () => {
    ready();
    show("us", ["finance"]);
    const sent = vi
      .mocked(useQuery)
      .mock.calls.filter(([, args]) => args !== "skip")
      .map(([ref]) => getFunctionName(ref as never));
    expect(sent.filter((name) => /^(payroll|costs):/.test(name))).toEqual([]);
    expect(sent).not.toContain("assistant:measure");
    expect(screen.queryByRole("heading", { name: "ARR per person in the OS" })).toBeNull();
    const money = within(screen.getByRole("region", { name: "Where the money goes" }));
    expect(money.getByText("On the Payroll page.")).toBeTruthy();
    expect(money.getByText("On the Costs page.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Record a figure" })).toBeNull();
  });
});
