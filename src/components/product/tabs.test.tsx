// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { ViewerProvider } from "@/components/viewer-provider";
import { KazakhstanTab } from "./kazakhstan-tab";
import { VerticalTab } from "./vertical-tab";
import { ProductNav } from "./product-nav";
import { StartupInsightsTab } from "./startup-insights-tab";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: vi.fn(), useRouter: () => ({ replace }), usePathname: () => "/product" }));
// The overview names clinics from the register; with nothing sent, it names none.
vi.mock("convex/react", () => ({ useQuery: () => undefined, useMutation: vi.fn() }));
const at = (query: string) =>
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>);
beforeEach(() => at(""));

afterEach(cleanup);

// Wednesday, October 14: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 12);
// PostHog's Monday-morning run.
const READ = Date.UTC(2026, 9, 12, 6, 10);
const WEEKS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];

/** A stored tile: its series, with the newest point as `latest`. Written a minute ago. */
function tile(key: string, scope: string, source: string, points: [string, number][] = []): Tile {
  const series = points.map(([periodStart, value]) => ({ periodStart, value }));
  const last = series.at(-1);
  return {
    key,
    scope,
    firstPeriodStart: series[0]?.periodStart ?? null,
    latest: last ? { ...last, currency: null, source, syncedAt: NOW - 60_000 } : null,
    series,
  };
}
const weekly = (key: string, source: string, values: number[]) =>
  tile(key, "startup_insights", source, WEEKS.map((week, i) => [week, values[i]!]));

const SEARCH_TILES = [
  weekly("signups", "posthog", [10, 8, 10, 12, 9]),
  weekly("signups_activated", "posthog", [4, 2, 4, 6, 1]),
  weekly("web_visitors", "posthog", [150, 200, 250, 300, 250]),
  weekly("searches", "posthog", [300, 310, 300, 410, 380]),
  weekly("weekly_active_users", "posthog", [30, 35, 40, 55, 50]),
  tile("site_pageviews", "startup_insights", "vercel"),
  tile("deploys", "startup_insights", "vercel"),
  tile("deploys_failed", "startup_insights", "vercel"),
];
const readAt = (lastOkAt: number | null): SourceStates => ({
  posthog: { state: lastOkAt === null ? "error" : "ok", lastRunAt: READ, lastOkAt, message: null },
  posthog_globex: { state: lastOkAt === null ? "error" : "ok", lastRunAt: READ, lastOkAt, message: null },
});
const article = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const VERDICT = /for seed/i;

describe("ProductNav", () => {
  test("a link per product, with the open one marked", () => {
    render(<ProductNav current="vertical_startup" />);
    const nav = within(screen.getByRole("navigation", { name: "Products" }));
    expect(nav.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Startup Insights", "/product"],
      ["Vertical Startup", "/product?product=vertical_startup"],
      ["Kazakhstan", "/product?product=kz_product"],
    ]);
    expect(nav.getByRole("link", { name: "Vertical Startup" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Startup Insights" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("Startup Insights", () => {
  test("two rates from settled weeks, then the weekly figures", () => {
    render(<StartupInsightsTab tiles={SEARCH_TILES} sources={readAt(READ)} now={NOW} />);
    expect(article("Activation rate").getByText("40%")).toBeTruthy();
    expect(
      article("Activation rate").getByText(
        "16 of 40 signups ran a search within 7 days of signing up. Signups of Sep 7–Oct 4.",
      ),
    ).toBeTruthy();
    expect(article("Visitor to signup").getByText("3.9%")).toBeTruthy();
    for (const label of [
      "Weekly active users",
      "Searches",
      "Visitors",
      "Signups",
      "Page views",
      "Production deploys",
      "Failed production deploys",
    ]) {
      expect(screen.getByRole("heading", { name: label }), label).toBeTruthy();
    }
  });

  test("activated signups are not a tile: the newest week has not settled and reads as a fall", () => {
    render(<StartupInsightsTab tiles={SEARCH_TILES} sources={readAt(READ)} now={NOW} />);
    expect(screen.queryByRole("heading", { name: "Activated signups" })).toBeNull();
    // The rate tile, which waits for a week to settle, is where they show.
    expect(article("Activation rate").getByText("40%")).toBeTruthy();
  });

  test("a week counts by PostHog's last successful run, not by when a tile was written", () => {
    // Every tile was written a minute ago, and no run has ever succeeded.
    render(<StartupInsightsTab tiles={SEARCH_TILES} sources={readAt(null)} now={NOW} />);
    expect(
      article("Activation rate").getByText(
        "Appears once a week of signups has had seven days to activate.",
      ),
    ).toBeTruthy();
    expect(
      article("Visitor to signup").getByText("Appears once a full week has been read."),
    ).toBeTruthy();
  });

  test("a source that has never run leaves both rates without a value", () => {
    render(<StartupInsightsTab tiles={SEARCH_TILES} sources={{}} now={NOW} />);
    expect(article("Activation rate").getByText("No value yet")).toBeTruthy();
    expect(article("Visitor to signup").getByText("No value yet")).toBeTruthy();
  });

  test("says how weeks are cut", () => {
    render(<StartupInsightsTab tiles={SEARCH_TILES} sources={readAt(READ)} now={NOW} />);
    expect(
      screen.getByText("Weeks run Monday to Sunday, UTC. Only weeks that have ended are shown."),
    ).toBeTruthy();
  });
});

describe("Vertical Startup", () => {
  const tiles = [
    // Startup Insights' figure of the same name must not appear on this tab. It
    // comes first, as the scorecard sends it, so a lookup by name alone would
    // show it in place of Vertical Startup's.
    weekly("weekly_active_users", "posthog", [30, 35, 40, 55, 50]),
    tile("weekly_active_users", "vertical_startup", "vertical_startup", [["2026-10-05", 14]]),
    tile("practices_active", "vertical_startup", "vertical_startup", [["2026-10-05", 3]]),
    tile("core_actions", "vertical_startup", "vertical_startup", [["2026-10-05", 212]]),
    tile("practices", "vertical_startup", "vertical_startup", [["2026-10-14", 4]]),
  ];

  test("its four figures, its own active users, and no benchmark", () => {
    render(<VerticalTab tiles={tiles} sources={{}} now={NOW} />);
    expect(article("Weekly active users").getByText("14")).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Weekly active users" })).toHaveLength(1);
    for (const label of ["Active practices", "Work items handled", "Practices"]) {
      expect(screen.getByRole("heading", { name: label }), label).toBeTruthy();
    }
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(
      screen.getByText(
        "Counts only, from Vertical Startup's own health endpoint. No published benchmark fits these, so they show trend only.",
      ),
    ).toBeTruthy();
  });
});

describe("Kazakhstan", () => {
  const tiles = [
    tile("clinics_using", "kz_product", "cfo_workbook", [
      ["2026-07-01", 3],
      ["2026-08-01", 4],
      ["2026-09-01", 5],
    ]),
    tile("clinics_active", "kz", "cfo_workbook", [
      ["2026-07-01", 29],
      ["2026-08-01", 30],
      ["2026-09-01", 32],
    ]),
  ];

  test("clinics using and active, a chart by month, and never a benchmark", () => {
    render(<KazakhstanTab tiles={tiles} sources={{}} now={NOW} />);
    expect(screen.getByRole("heading", { name: "Using the product, not active" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active clients" })).toBeTruthy();
    expect(screen.getByText("Clinics by month")).toBeTruthy();
    // Every published band is US or EU data.
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText(/benchmark verdict/i)).toBeNull();
    expect(
      screen.getByText(
        "Trend only: the published benchmarks are US and EU data, so none is shown for Kazakhstan.",
      ),
    ).toBeTruthy();
  });

  test("active clients are Finance's: a viewer without it is shown the product's own clinics alone", () => {
    render(
      <ViewerProvider viewer={{ role: "engineer", companies: ["kz"], areas: ["product"], email: null, name: null }}>
        <KazakhstanTab tiles={tiles.filter((t) => t.key !== "clinics_active")} sources={{}} now={NOW} />
      </ViewerProvider>,
    );
    expect(screen.getByRole("heading", { name: "Using the product, not active" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Active clients" })).toBeNull();
    // The chart keeps the series the viewer is sent, under its own name.
    expect(screen.getByText("Clinics by month")).toBeTruthy();
    expect(screen.queryByText("Active clients")).toBeNull();
  });

  test("a month or two is not charted: the tiles already say it", () => {
    const short = tiles.map((t) => ({ ...t, series: t.series.slice(-1) }));
    render(<KazakhstanTab tiles={short} sources={{}} now={NOW} />);
    expect(screen.queryByText("Clinics by month")).toBeNull();
  });

  test("the app's own usage is charted by week", () => {
    const weeks: [string, number][] = [
      ["2026-09-21", 576],
      ["2026-09-28", 427],
      ["2026-10-05", 537],
    ];
    render(
      <KazakhstanTab
        tiles={[...tiles, tile("checks_completed", "kz_product", "posthog", weeks)]}
        sources={{}}
        now={NOW}
      />,
    );
    expect(screen.getByText("Actions by week")).toBeTruthy();
    expect(screen.getByText("Doctors and clinics by week")).toBeTruthy();
    // A week is named by its Monday.
    expect(screen.getAllByText(/Week of Oct 5/).length).toBeGreaterThan(0);
  });
});

describe("Kazakhstan in detail", () => {
  const weeks = (values: number[]): [string, number][] =>
    values.map((value, i) => [["2026-09-21", "2026-09-28", "2026-10-05"][i]!, value]);

  test("the weekly report's views, with Speed & AI and Tracking health, the overview open by default", () => {
    render(<KazakhstanTab tiles={[]} sources={{}} now={NOW} />);
    const nav = screen.getByRole("navigation", { name: "Kazakhstan product" });
    // Each link's own words (a hidden bold copy holds its width).
    expect(within(nav).getAllByRole("link").map((a) => a.lastElementChild?.lastElementChild?.textContent ?? a.textContent)).toEqual([
      "Overview",
      "Modules",
      "Clinics",
      "Doctors",
      "Speed & AI",
      "Errors",
      "Tracking health",
    ]);
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  });

  test("the overview opens with the report: the main line, then what to watch", () => {
    render(
      <KazakhstanTab
        tiles={[
          tile("checks_started", "kz_product", "posthog", weeks([500, 596, 658])),
          tile("doctors_less", "kz_product", "posthog", weeks([4, 6, 9])),
        ]}
        sources={{}}
        now={NOW}
      />,
    );
    const main = screen.getByRole("region", { name: "This week" });
    expect(main.textContent).toContain("Checks started: 596 → 658 (+10%).");
    // The figures are set in bold, as the weekly report sets them.
    expect(within(main).getByText("596 → 658 (+10%)").tagName).toBe("B");
    expect(screen.getByText(/9 doctors worked half their usual week or less/)).toBeTruthy();
    expect(screen.getByText("Nothing broke this week")).toBeTruthy();
  });

  test("modules are a table, busiest first, and one with no figure says so", () => {
    at("product=kz_product&view=modules");
    render(
      <KazakhstanTab
        tiles={[
          tile("module_actions_search", "kz_product", "posthog", weeks([40, 50, 60])),
          tile("module_actions_intake", "kz_product", "posthog", weeks([300, 310, 320])),
        ]}
        sources={{}}
        now={NOW}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("rowheader")[0]?.textContent);
    expect(rows.slice(0, 2)).toEqual(["Intake", "Quick search"]);
    expect(screen.getAllByText("Not read yet").length).toBeGreaterThan(0);
    expect(screen.queryByText(VERDICT)).toBeNull();
  });

  test("an error carrying record text is P0 on Errors", () => {
    at("product=kz_product&view=issues");
    render(
      <KazakhstanTab tiles={[tile("error_record_text", "kz_product", "posthog", weeks([0, 0, 2]))]} sources={{}} now={NOW} />,
    );
    expect(screen.getByText("P0")).toBeTruthy();
    expect(screen.getByText(/2 error messages held a model's answer/)).toBeTruthy();
  });
});

describe("Kazakhstan over a period", () => {
  const eight = (values: number[]): [string, number][] =>
    values.map((v, i) => [["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"][i]!, v]);

  test("the picker writes the weeks into the address", async () => {
    render(<KazakhstanTab tiles={[]} sources={{}} now={NOW} />);
    const select = screen.getByRole("combobox", { name: /Period/ });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(select, { target: { value: "4" } });
    expect(replace).toHaveBeenCalledWith("/product?product=kz_product&weeks=4", { scroll: false });
  });

  test("over 4 weeks counts add up and doctors are a weekly average, against the 4 weeks before", () => {
    at("product=kz_product&weeks=4");
    render(
      <KazakhstanTab
        tiles={[
          tile("checks_started", "kz_product", "posthog", eight([10, 10, 10, 10, 20, 20, 20, 20])),
          tile("doctors_working", "kz_product", "posthog", eight([4, 4, 4, 4, 5, 6, 5, 6])),
        ]}
        sources={{}}
        now={NOW}
      />,
    );
    const figures = within(screen.getByRole("region", { name: "This week's figures" }));
    expect(figures.getByText("The last 4 weeks' figures")).toBeTruthy();
    expect(figures.getByText("the 4 weeks before: 40")).toBeTruthy();
    expect(figures.getByText("Doctors with an action, a week on average")).toBeTruthy();
    expect(figures.getByText("the 4 weeks before: 4")).toBeTruthy();
  });

  test("the picker stays on every view, so the tabs under it do not move; PostHog's read time is shown", () => {
    at("product=kz_product&view=doctors&weeks=4");
    render(
      <KazakhstanTab
        tiles={[]}
        sources={{ posthog_globex: { state: "ok", lastRunAt: 1, lastOkAt: Date.UTC(2026, 9, 19, 11, 40), message: null } }}
        now={NOW}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Period" })).toBeTruthy();
    expect(screen.getByText(/^PostHog data as of 19 Oct 2026/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh from PostHog" })).toBeTruthy();
  });

  test("the title says the weeks shown against the weeks before, and follows the picker", () => {
    const series = tile("checks_started", "kz_product", "posthog", eight([1, 1, 1, 1, 1, 1, 1, 1]));
    render(<KazakhstanTab tiles={[series]} sources={{}} now={NOW} />);
    expect(screen.getByRole("heading", { level: 2, name: /Globex — 05\.10–11\.10 vs 28\.09–04\.10/ })).toBeTruthy();
    // And under the picker, as the weekly report has it.
    expect(screen.getByText("05.10–11.10 (1 week) against 28.09–04.10")).toBeTruthy();
    cleanup();
    at("product=kz_product&weeks=4");
    render(<KazakhstanTab tiles={[series]} sources={{}} now={NOW} />);
    expect(screen.getByRole("heading", { level: 2, name: /Globex — 14\.09–11\.10 vs 17\.08–13\.09 4 weeks/ })).toBeTruthy();
  });

  test("a custom period: the whole weeks between two dates", () => {
    at("product=kz_product&weeks=2&end=2026-09-21");
    render(
      <KazakhstanTab
        tiles={[tile("checks_started", "kz_product", "posthog", eight([1, 2, 3, 4, 5, 6, 7, 8]))]}
        sources={{}}
        now={NOW}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: /Globex — 14\.09–27\.09 vs 31\.08–13\.09/ })).toBeTruthy();
    // Weeks of 14 and 21 September (5 + 6) against 31 August and 7 September (3 + 4).
    expect(screen.getByText("the 2 weeks before: 7")).toBeTruthy();
    // The dates picked, rounded to the whole weeks they fall in.
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-14");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-09-27");
  });
});


describe("picking a custom period by dates", () => {
  test("two dates become the whole weeks they fall in, held to the weeks on record", async () => {
    at("product=kz_product&weeks=2&end=2026-09-21");
    const { fireEvent } = await import("@testing-library/react");
    render(
      <KazakhstanTab
        tiles={[
          tile("checks_started", "kz_product", "posthog", [
            ["2026-09-07", 1],
            ["2026-09-14", 1],
            ["2026-09-21", 1],
            ["2026-09-28", 1],
          ]),
        ]}
        sources={{}}
        now={NOW}
      />,
    );
    replace.mockClear();
    // A Wednesday to a Tuesday: the weeks of 7 and 28 September, four whole weeks.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-09" } });
    expect(replace).toHaveBeenLastCalledWith("/product?product=kz_product&weeks=3&end=2026-09-21", { scroll: false });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-29" } });
    expect(replace).toHaveBeenLastCalledWith("/product?product=kz_product&weeks=3&end=2026-09-28", { scroll: false });
    expect(screen.getByRole("option", { name: "Custom period…" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Last 13 weeks" })).toBeNull();
  });
});

describe("Speed & AI", () => {
  test("modules slowest first, a module over 10% of answers past a minute marked slow", () => {
    at("product=kz_product&view=speed");
    const two = (values: [number, number]): [string, number][] => [
      ["2026-09-28", values[0]],
      ["2026-10-05", values[1]],
    ];
    render(
      <KazakhstanTab
        tiles={[
          tile("module_p50_search", "kz_product", "posthog", two([19, 38])),
          tile("module_slow_share_search", "kz_product", "posthog", two([6.7, 21.8])),
          tile("module_p50_intake", "kz_product", "posthog", two([29, 29])),
          tile("module_slow_share_intake", "kz_product", "posthog", two([4.7, 6.1])),
          tile("ai_calls_off_model", "kz_product", "posthog", two([0, 110])),
        ]}
        sources={{}}
        now={NOW}
      />,
    );
    const table = within(screen.getByRole("table", { name: "Speed and AI by module" }));
    expect(table.getAllByRole("rowheader").map((th) => th.textContent)).toEqual(["Quick search", "Intake"]);
    expect(table.getByText("Slow")).toBeTruthy();
    expect(table.getByText("Watch")).toBeTruthy();
    expect(screen.getByText("110 calls")).toBeTruthy();
  });
});

