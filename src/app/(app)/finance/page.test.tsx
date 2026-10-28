// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { METRICS, metricScopes } from "@convex/lib/metricRegistry";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import type { SourceStates, Tile } from "@/lib/metrics/scorecard";
import { mockConvex } from "@/test-support/convex";
import FinancePage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// The made-up deployment every test runs as (convex/test.deployment.ts), with
// its financial model held here so one test can take it away.
const model = vi.hoisted(() => ({ url: "https://financial-model.example.test/" }));
vi.mock("@convex/lib/features", async (importOriginal) => {
  const { MADE_UP_DEPLOYMENT, allSwitchesOn } = await import("@convex/lib/deployment.kit");
  const real = await importOriginal<typeof import("@convex/lib/features")>();
  return {
    ...real,
    ...MADE_UP_DEPLOYMENT,
    FEATURES: allSwitchesOn(real.FEATURES),
    get FINANCIAL_MODEL_URL() {
      return model.url;
    },
  };
});
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
// The form has its own tests; here, where it is and for whom.
vi.mock("@/components/manual-entry", () => ({ ManualEntry: () => <form aria-label="Entry form" /> }));
// All costs keeps its sort in the address.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/finance",
  useRouter: () => ({ replace: vi.fn() }),
}));

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60 * 1000;

// What the scorecard query returns: a tile for every metric and scope, empty
// unless a series is given for it here.
const SERIES: Record<string, [string, number][]> = {
  "cash:us": [["2026-10-12", 400_000]],
  "cash:kz": [["2026-08-31", 5_369_500], ["2026-09-30", 5_000_000]],
  "fx_usd_kzt:company": [["2026-09-01", 500]],
  "cash_in:us": [["2026-08-01", 30_000], ["2026-09-01", 32_000], ["2026-10-01", 9_000]],
  "cash_out:us": [["2026-08-01", 50_000], ["2026-09-01", 52_000], ["2026-10-01", 20_000]],
  // Of cash out, what Startup sent Globex, its subsidiary.
  "cash_to_subsidiary:us": [["2026-08-01", 20_000], ["2026-09-01", 40_000], ["2026-10-01", 5_000]],
  "mrr:us": [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
  "mrr:kz": [["2026-09-01", 5_000_000]],
};
const tilesOf = (series: Record<string, [string, number][]>): Tile[] => METRICS.flatMap((metric) =>
  metricScopes(metric).map((scope) => {
    const points = series[`${metric.key}:${scope}`] ?? [];
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
const tiles = tilesOf(SERIES);
// The longer Kazakhstan balance history the page asks for separately.
const kzCash = [
  ["2026-07-31", 5_569_500],
  ["2026-08-31", 5_369_500],
  ["2026-09-30", 5_000_000],
].map(([periodStart, value]) => ({ periodStart, value, currency: "KZT", source: "manual", syncedAt: NOW }));
// The US balances the page asks for: last month's close and today's.
const usCash = [
  ["2026-09-30", 410_000],
  ["2026-10-12", 400_000],
].map(([periodStart, value]) => ({ periodStart, value, currency: "USD", source: "mercury", syncedAt: NOW }));

let convex: ReturnType<typeof mockConvex>;
// Mercury last ran this morning, so every month before this one was read whole.
const MERCURY_OK = { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null };
const ready = (sources: SourceStates = { mercury: MERCURY_OK }, shown: Tile[] = tiles) => {
  convex.setQuery(api.metrics.scorecard, { tiles: shown, sources });
  convex.setQueryBy(api.metrics.series, (args) => ((args as { scope: string }).scope === "kz" ? kzCash : usCash));
  // Payroll and Costs, asked for by a viewer who holds them (All costs, Where
  // the money goes): in, and empty.
  for (const query of [api.payroll.listPeople, api.payroll.listLines, api.payroll.listRuns, api.costs.list]) {
    convex.setQuery(query, []);
  }
  vi.mocked(useNow).mockReturnValue(NOW);
};
const section = (name: string) => within(screen.getByRole("region", { name }));
// A viewer on both companies opens on the group: its hero is "Group, in US dollars".
const GROUP = "Group, in US dollars";
const summaryTile = (label: string) =>
  within(
    within(screen.getByRole("region", { name: GROUP }))
      .getByRole("heading", { name: label })
      .closest("article")!,
  );
/** A summary figure's words in full: the number and its quieter unit ("$20K / mo"). */
const valueOf = (label: string) =>
  within(screen.getByRole("region", { name: GROUP }))
    .getByRole("heading", { name: label })
    .closest("article")!
    .querySelector("p")!.textContent;
/** Each company's own figure under a group figure, as "Company: figure". */
const splitOf = (label: string) =>
  Array.from(
    within(screen.getByRole("region", { name: GROUP }))
      .getByRole("heading", { name: label })
      .closest("article")!
      .querySelectorAll("dl dt"),
    (dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`,
  );
/** Open one company's lens, as its button on the page does. */
const lens = (name: "Startup" | "Globex") => fireEvent.click(screen.getByRole("button", { name }));
/** Globex's actual spend as typed on the Budget tab: ₸5,000,000 in August ($10K), ₸2,500,000 in September ($5K). */
const KZ_SPEND = [
  { month: "2026-08", amount: 5_000_000_00 },
  { month: "2026-09", amount: 2_500_000_00 },
];

beforeEach(() => {
  convex = mockConvex();
  convex.setQueryBy(api.budget.view, (args) => ({
    company: (args as { company: string }).company,
    actuals: (args as { company: string }).company === "kz" ? KZ_SPEND : [],
  }));
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("the finance page", () => {
  test.each([
    ["the scorecard", () => convex.setQuery(api.metrics.scorecard, undefined)],
    ["the balance histories", () => convex.setQueryBy(api.metrics.series, () => undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows placeholders, and no number, until %s is in", (_name, withhold) => {
    ready();
    withhold();
    const { container } = render(<FinancePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Finance" })).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByRole("region", { name: GROUP })).toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  test("links to the CFO model in a new tab", () => {
    ready();
    render(<FinancePage />);
    const link = screen.getByRole("link", { name: "Open the CFO model" });
    expect(link.getAttribute("href")).toBe("https://financial-model.example.test/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  test("a deployment with no financial model (an empty FINANCIAL_MODEL_URL) shows no link", () => {
    model.url = "";
    try {
      ready();
      render(<FinancePage />);
      // Nor an anchor without an address: React drops an empty href, so look for the words.
      expect(screen.queryByText("Open the CFO model")).toBeNull();
    } finally {
      model.url = "https://financial-model.example.test/";
    }
  });

  test("the CFO model is Startup's: its link is in the group's and Startup's view, not Globex's alone", () => {
    ready();
    render(<FinancePage />);
    lens("Startup");
    expect(screen.getByRole("link", { name: "Open the CFO model" })).toBeTruthy();
    lens("Globex");
    expect(screen.queryByRole("link", { name: "Open the CFO model" })).toBeNull();
  });

  test("the group's figures: each company's own added at the stored rate, with each company's under it", () => {
    ready();
    const { container } = render(<FinancePage />);
    expect(container.querySelector("[aria-busy]")).toBeNull();
    // 400,000 + 5,000,000 / 500
    expect(valueOf("Cash")).toBe("$410K");
    expect(splitOf("Cash")).toEqual(["Startup: $400K · Oct 12", "Globex: ₸5M · Sep 30"]);
    // Startup's bank burned 20,000 in August and in September, having sent
    // Globex 20,000 and 40,000: its own spending 0 and −20,000. Globex's
    // balance fell 200,000 and 369,500 tenge, lifted by what Startup sent
    // (10,000,000 and 20,000,000 at 500): its own burn 10,200,000 and
    // 20,369,500. The group's is what it was: $20K + ₸284,750 ÷ 500.
    expect(valueOf("Net burn")).toBe("$20.6K / mo");
    expect(splitOf("Net burn")).toEqual(["Startup: −$10K / mo", "Globex: ₸15.3M / mo"]);
    expect(
      summaryTile("Net burn").getByText(
        "Startup's is of 2 of the last 3 months; Globex's is of 2 of the last 3 months: the rest are not complete. Each company's own view says why.",
      ),
    ).toBeTruthy();
    expect(valueOf("Runway")).toBe("19.9 mo");
    // Each company's own: Startup's bank, and Globex without new money from Startup.
    expect(splitOf("Runway")).toEqual(["Startup: 20 mo", "Globex: 0.3 mo"]);
    expect(summaryTile("Runway").getByText("Group cash ÷ group net burn.")).toBeTruthy();
    expect(screen.getByText("Globex's tenge at ₸500 per $1, the Sep 2026 rate.")).toBeTruthy();
  });

  test("the group is the money story: cash ÷ net burn = runway, then MRR, each company's latest", () => {
    ready();
    render(<FinancePage />);
    expect(
      within(screen.getByRole("region", { name: GROUP }))
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Cash", "Net burn", "Runway", "MRR"]);
    expect(valueOf("MRR")).toBe("$15.5K");
    expect(splitOf("MRR")).toEqual(["Startup: $5,500", "Globex: ₸5M"]);
    expect(
      summaryTile("MRR").getByText("Each company's latest: Startup's is of Oct 2026, Globex's is of Sep 2026."),
    ).toBeTruthy();
  });

  test("with no rate on record, every group figure is 'Not known yet', and each company's own still shows", () => {
    ready(undefined, tilesOf({ ...SERIES, "fx_usd_kzt:company": [] }));
    render(<FinancePage />);
    for (const label of ["Cash", "Net burn", "Runway", "MRR"]) {
      expect([label, valueOf(label)]).toEqual([label, "Not known yet"]);
      expect(
        summaryTile(label).getByText(
          "Needs a USD/KZT rate to add Globex's tenge: it arrives with the CFO workbook.",
        ),
      ).toBeTruthy();
    }
    expect(splitOf("Cash")).toEqual(["Startup: $400K · Oct 12", "Globex: ₸5M · Sep 30"]);
    // Globex's own burn needs the rate too: Startup sent it dollars.
    expect(splitOf("Net burn")).toEqual(["Startup: −$10K / mo", "Globex: Not known yet"]);
    expect(splitOf("Runway")).toEqual(["Startup: 20 mo", "Globex: Not known yet"]);
    expect(within(screen.getByRole("region", { name: GROUP })).queryByText(/\$0\b/)).toBeNull();
  });

  test("a month Mercury did not finish reading is not in Startup's average, and the group says whose is short", () => {
    // The last successful run was on September 20: September's row is twenty days.
    const lastOkAt = Date.parse("2026-09-20T06:00:00Z");
    ready({ mercury: { state: "ok", lastRunAt: lastOkAt, lastOkAt, message: null } });
    render(<FinancePage />);
    // Startup's August alone: 20,000, all of it sent to Globex. September's
    // figure of what was sent is part of a month too, so out of both parts.
    expect(splitOf("Net burn")[0]).toBe("Startup: $0 / mo");
    expect(summaryTile("Net burn").getByText(/^Startup's is of 1 of the last 3 months/)).toBeTruthy();
    expect(
      summaryTile("Net burn").getByText(
        "Sep 2026 has no whole figure from Mercury of what Startup sent Globex, so it is left out of both companies' parts.",
      ),
    ).toBeTruthy();
    // Where the money goes draws no money out for it either.
    expect(screen.queryByRole("img", { name: /^Sep 2026:/ })).toBeNull();
    // Startup's own lens says why.
    lens("Startup");
    expect(
      within(screen.getByRole("region", { name: "Summary" })).getByText(
        "Sep 2026 is not counted: Mercury was last read on Sep 20, before the month ended.",
      ),
    ).toBeTruthy();
  });

  test("the clock it waited for decides what is out of date", () => {
    ready();
    // Four days on, Mercury's balance is past its three-day limit.
    vi.mocked(useNow).mockReturnValue(NOW + 4 * 24 * 60 * 60 * 1000);
    render(<FinancePage />);
    expect(splitOf("Cash")[0]).toBe("Startup: $400K · Oct 12 · out of date");
    expect(summaryTile("Runway").getByText("Uses a balance that is out of date.")).toBeTruthy();
  });

  test("a failed source run is shown on the page whose numbers it feeds", () => {
    ready({
      mercury: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "Mercury answered 401." },
    });
    render(<FinancePage />);
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getByText("Mercury: last run failed")).toBeTruthy();
    expect(attention.getByText("Mercury answered 401.")).toBeTruthy();
    // Only failures: a number that is merely missing has its own tile below.
    expect(attention.queryByText(/has no value yet/)).toBeNull();
  });

  test("a failed run of a source that feeds another page is not Finance's to show", () => {
    const failed = (message: string) => ({ state: "error", lastRunAt: NOW, lastOkAt: NOW, message });
    ready({ mercury: MERCURY_OK, vercel: failed("Vercel answered 500.") });
    const { unmount } = render(<FinancePage />);
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    unmount();

    // Beside failures that are Finance's, it is still left out.
    ready({
      mercury: failed("Mercury answered 401."),
      cfo_workbook: failed("The workbook push was refused."),
      vercel: failed("Vercel answered 500."),
    });
    render(<FinancePage />);
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("link").map((a) => a.textContent)).toEqual([
      expect.stringContaining("Mercury answered 401."),
      expect.stringContaining("The workbook push was refused."),
    ]);
    expect(attention.queryByText("Vercel answered 500.")).toBeNull();
  });

  test("PostHog's failed run is Finance's too: it brings Globex's AI token cost (COGS)", () => {
    const failed = (message: string) => ({ state: "error", lastRunAt: NOW, lastOkAt: NOW, message });
    ready({ mercury: MERCURY_OK, posthog_globex: failed("PostHog answered 500.") });
    render(<FinancePage />);
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("PostHog answered 500.")]);
  });

  test("a number that is merely out of date is not in the failure list", () => {
    // Four days on, Mercury's balance is stale; the home page lists that, this one does not.
    ready();
    vi.mocked(useNow).mockReturnValue(NOW + 4 * DAY);
    const { unmount } = render(<FinancePage />);
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    unmount();

    ready({
      mercury: { state: "error", lastRunAt: NOW, lastOkAt: NOW, message: "Mercury answered 401." },
    });
    vi.mocked(useNow).mockReturnValue(NOW + 4 * DAY);
    render(<FinancePage />);
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getAllByRole("link")).toHaveLength(1);
    expect(attention.queryByText(/is out of date/)).toBeNull();
  });

  test("with no failed run there is no attention list at all", () => {
    ready({ mercury: { state: "ok", lastRunAt: NOW, lastOkAt: NOW, message: null } });
    render(<FinancePage />);
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    expect(screen.queryByText(/Nothing right now/)).toBeNull();
  });

  test("where the group's money goes: both companies' money out in dollars, each company's own under it", () => {
    ready();
    render(<FinancePage />);
    const money = section("Where the money goes");
    expect(money.getByText(/^Both companies in dollars/)).toBeTruthy();
    // August and September: two months are not a chart.
    expect(money.getByText(/the chart needs 3 (such )?months, there are 2 so far/)).toBeTruthy();
    const september = within(money.getByRole("region", { name: "Sep 2026" }));
    // Startup's $52K less the $40K it sent Globex, and Globex's ₸2,500,000
    // at 500: $5K. (The registers are in and empty, so what is not in them
    // is $17K too.) Never $57K: that would count the $40K twice.
    expect(september.getByText("Money out", { selector: "dt" }).parentElement!.textContent).toContain("$17K");
    expect(
      september.getByText("Startup $12K ($40K sent to Globex left out), Globex ₸2.5M. Tenge at ₸500 per $1."),
    ).toBeTruthy();
    expect(money.getByText(/^Startup's money out here leaves out what it sent Globex/)).toBeTruthy();
    // The group has no money-in line: Globex's is not on record.
    expect(september.queryByText("Money in, before financing")).toBeNull();
    expect(money.queryByRole("link", { name: "Record financing received" })).toBeNull();
  });

  test("all costs come right after the money story, before where the money goes, in every lens", () => {
    ready();
    render(<FinancePage />);
    const order = () =>
      [GROUP, "All costs", "Where the money goes"].map((name) => screen.queryByRole("region", { name }));
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const [hero, all, money] = order();
    expect(follows(hero!, all!) && follows(all!, money!)).toBe(true);
    expect(all!.getAttribute("data-lens")).toBe("group");
    lens("Globex");
    const allKz = screen.getByRole("region", { name: "All costs" });
    expect(allKz.getAttribute("data-lens")).toBe("kz");
    expect(follows(allKz, screen.getByRole("region", { name: "Where the money goes" }))).toBe(true);
  });

  test("a group month with one company's money out missing is not known, and says which", () => {
    ready();
    // Nothing typed for Globex: no group month is known, and the latest is shown.
    convex.setQueryBy(api.budget.view, () => ({ company: "kz", actuals: [] }));
    render(<FinancePage />);
    expect(section("Where the money goes").getByText(/there are none yet/)).toBeTruthy();
    const september = within(section("Where the money goes").getByRole("region", { name: "Sep 2026" }));
    expect(
      september.getByText(
        "Not known yet: Globex's actual spend for Sep 2026 is not typed in. Startup $12K ($40K sent to Globex left out), Globex not known.",
      ),
    ).toBeTruthy();
    expect(september.getByRole("link", { name: "Open the Budget tab" }).getAttribute("href")).toBe("/finance/plan");
  });

  test("where the money goes is Startup's in Startup's lens, with money in from Mercury and the financing note", () => {
    ready();
    render(<FinancePage />);
    lens("Startup");
    const money = section("Where the money goes");
    // August and September are the only months Mercury read whole: two are not a chart.
    expect(money.getByText(/the chart needs 3 (such )?months, there are 2 so far/)).toBeTruthy();
    const september = within(money.getByRole("region", { name: "Sep 2026" }));
    // Money out is the bank's $52K, $40K of it sent to Globex. The registers
    // are in and empty, so what is in none of them is the other $12K.
    expect(september.getByText("Money out", { selector: "dt" }).parentElement!.textContent).toContain("$52K");
    expect(september.getByText("Sent to Globex", { selector: "dt" }).parentElement!.textContent).toContain("$40K");
    expect(september.getByText("Not in the registers", { selector: "dt" }).parentElement!.textContent).toContain("$12K");
    expect(september.getByText("$32K")).toBeTruthy();
    expect(money.getByRole("link", { name: "Record financing received" }).getAttribute("href")).toBe(
      "/finance?metric=financing_in&scope=us#record-a-figure",
    );
    expect(money.getByRole("link", { name: "Record financing received" }).closest("p")!.textContent).toBe(
      'Financing is left out of "Money in". Record financing received when investor money arrives, so it is not counted as income. Outside money only: a transfer between Startup\'s own entities is not financing.',
    );
  });

  test("financing is taken out of money in, and the page says how much and when", () => {
    ready(
      undefined,
      tilesOf({
        ...SERIES,
        "cash_in:us": [["2026-08-01", 530_000], ["2026-09-01", 52_000], ["2026-10-01", 9_000]],
        "financing_in:us": [["2026-03-01", 900_000], ["2026-08-01", 500_000], ["2026-09-01", 20_000]],
      }),
    );
    render(<FinancePage />);
    lens("Startup");
    const money = section("Where the money goes");
    // September's money in is its cash in less the $20K round: $32K.
    expect(within(money.getByRole("region", { name: "Sep 2026" })).getByText("$32K")).toBeTruthy();
    // March's round is not on the chart, so it is not in the sentence either.
    expect(money.getByRole("link", { name: "Record financing received" }).closest("p")!.textContent).toBe(
      'Financing is left out of "Money in": $500K in Aug 2026, $20K in Sep 2026. Record financing received when investor money arrives, so it is not counted as income. Outside money only: a transfer between Startup\'s own entities is not financing.',
    );
  });

  test("the group's runway above each company's side by side; the plan is Startup's, a click away", () => {
    ready();
    convex.setQuery(api.plan.get, null);
    convex.setQuery(api.scenarios.list, []);
    render(<FinancePage />);
    // One group panel, in dollars at the group's net burn, before the two companies'.
    const group = screen.getByRole("region", { name: "Group runway" });
    expect(within(group).getByText(/what Startup sends Globex counted once/)).toBeTruthy();
    const startup = screen.getByRole("region", { name: "Runway and what changes it · Startup" });
    expect(group.compareDocumentPosition(startup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(startup).getByText(/do not add up/)).toBeTruthy();
    for (const name of ["Startup", "Globex"]) {
      expect(
        section(`Runway and what changes it · ${name}`)
          .getByRole("link", { name: /Edit on Budget and runway/ })
          .getAttribute("href"),
      ).toBe("/finance/plan");
    }
    const plan = section("Plan against reality");
    expect(plan.getByText(/The financial model's plan is Startup's/)).toBeTruthy();
    fireEvent.click(plan.getByRole("button", { name: "Show Startup" }));
    expect(section("Plan against reality").getByText(/No plan from the financial model yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Startup" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("each balance history is asked for by name: Kazakhstan's year and more, the US's two months", () => {
    ready();
    render(<FinancePage />);
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([ref]) => getFunctionName(ref) === getFunctionName(api.metrics.series))
      .map(([, args]) => args);
    expect(asked.length).toBeGreaterThan(0);
    for (const args of asked) {
      expect([
        { key: "cash", scope: "kz", limit: 400 },
        { key: "cash", scope: "us", limit: 62 },
      ]).toContainEqual(args);
    }
  });

  test("no figure twice: cash and MRR are the summary's, not revenue health's", () => {
    ready();
    render(<FinancePage />);
    const health = section("Revenue health");
    expect(health.queryByRole("heading", { name: "Cash" })).toBeNull();
    expect(health.queryByRole("heading", { name: "MRR" })).toBeNull();
    expect(health.queryByRole("heading", { name: "USD/KZT rate" })).toBeNull();
    expect(summaryTile("Cash")).toBeTruthy();
  });

  test("the month in progress is the clock's: in November, October is a month like any other", () => {
    const november = Date.UTC(2026, 10, 5, 12);
    ready({ mercury: { state: "ok", lastRunAt: november, lastOkAt: november, message: null } });
    vi.mocked(useNow).mockReturnValue(november);
    render(<FinancePage />);
    // Startup's average is now of Aug-Oct, all three; Globex's waits for October's close.
    expect(
      summaryTile("Net burn").getByText(/^Globex's is of 2 of the last 3 months: the rest are not complete/),
    ).toBeTruthy();
    lens("Startup");
    expect(screen.getByRole("img", { name: /^Oct 2026: money in \$9,000, money out \$20K/ })).toBeTruthy();
  });

  test("revenue health, each company's under its name: every scope of each stored figure, then its burn multiple", () => {
    ready();
    render(<FinancePage />);
    const health = screen.getByRole("region", { name: "Revenue health" });
    const names = (company: string) =>
      Array.from(within(health).getByRole("group", { name: company }).querySelectorAll("article"), (article) =>
        Array.from(article.querySelectorAll("header > *"), (part) => part.textContent).join(" · "),
      );
    expect(names("Startup")).toEqual(["Paying clinics · US", "Burn multiple"]);
    expect(names("Globex")).toEqual([
      "Paying clinics · Kazakhstan",
      "Active clients · Kazakhstan",
      "Contracted monthly fees · Kazakhstan",
      "Owed by clients · Kazakhstan",
      "Average monthly client churn · Kazakhstan",
      "Burn multiple",
    ]);
    // The published bands are US and EU data; most of these are Kazakhstan's.
    expect(within(health).queryByText(/typical for seed/i)).toBeNull();
  });
});

describe("Record a figure", () => {
  const as = (areas: Area[]) =>
    render(
      <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas, email: null, name: null }}>
        <FinancePage />
      </ViewerProvider>,
    );

  test("the typed-in figures are entered here, by whoever holds the settings area, behind a quiet disclosure", () => {
    ready();
    as(["finance", "settings"]);
    const panel = screen.getByRole("region", { name: "Record a figure" });
    expect(panel.id).toBe("record-a-figure");
    // Closed until asked for: the page is for reading.
    expect(within(panel).queryByRole("form", { name: "Entry form" })).toBeNull();
    const toggle = within(panel).getByRole("button", { name: "Record a figure" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByRole("form", { name: "Entry form" })).toBeTruthy();
  });

  test("open on arrival when a note's link points at it", () => {
    ready();
    window.history.replaceState(null, "", "/finance?metric=cash&scope=kz#record-a-figure");
    try {
      as(["finance", "settings"]);
      const panel = screen.getByRole("region", { name: "Record a figure" });
      expect(within(panel).getByRole("form", { name: "Entry form" })).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("without the settings area there is no panel, and no link to one", () => {
    ready();
    as(["finance"]);
    expect(screen.queryByRole("region", { name: "Record a figure" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Record financing received" })).toBeNull();
  });
});

describe("ARR per person in the OS", () => {
  test("is on Finance for the owner, and is never asked for by a teammate", () => {
    ready();
    render(
      <ViewerProvider viewer={{ role: "owner", companies: ["us", "kz"], areas: ["finance", "personal"], email: null, name: null }}>
        <FinancePage />
      </ViewerProvider>,
    );
    expect(screen.getByRole("heading", { name: "ARR per person in the OS" })).toBeTruthy();
    cleanup();
    vi.mocked(useQuery).mockClear();
    render(
      <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas: ["finance"], email: null, name: null }}>
        <FinancePage />
      </ViewerProvider>,
    );
    expect(screen.queryByRole("heading", { name: "ARR per person in the OS" })).toBeNull();
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([, args]) => args !== "skip")
      .map(([ref]) => getFunctionName(ref as never));
    expect(asked).not.toContain("assistant:measure");
  });
});
