// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { obligation } from "@/lib/compliance/fixtures";
import { US, clinic } from "@/lib/customers/fixtures";
import { formatValue } from "@/lib/format";
import type { Tile } from "@/lib/metrics/scorecard";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { ComplianceSection } from "./compliance-section";
import { CustomersSection } from "./customers-section";
import { FundraisingSection } from "./fundraising-section";
import { GtmSection } from "./gtm-section";
import { ProductSection } from "./product-section";
import { SalesSection } from "./sales-section";
import { WorkSection } from "./work-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

// Local noon on Monday 2026-10-12.
const NOW = new Date(2026, 9, 12, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;
const EVERY_AREA: Area[] = [
  "scorecard",
  "finance",
  "product",
  "sales",
  "customers",
  "compliance",
  "fundraising",
  "marketing",
  "gtm",
  "board",
  "review",
];
type Company = "us" | "kz";

let convex: ReturnType<typeof mockConvex>;

/** The section as a viewer with these areas sees it, with one company in view. */
function show(
  ui: ReactElement,
  {
    areas = EVERY_AREA,
    companies = ["us", "kz"],
    company = "us",
    email = "me@example.com",
  }: { areas?: Area[]; companies?: Company[]; company?: Company; email?: string | null } = {},
) {
  window.localStorage.setItem("startup-os:company", company);
  return render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas, email, name: null }}>
      <CompanyProvider allowed={companies}>{ui}</CompanyProvider>
    </ViewerProvider>,
  );
}

const region = (name: string | RegExp) => screen.queryByRole("region", { name });
const inRegion = (name: string | RegExp) => within(screen.getByRole("region", { name }));
const busy = (name: string) =>
  screen.getByRole("region", { name }).querySelector('[data-slot="skeleton"]');
const heading = (name: string) =>
  screen.getByRole("heading", { level: 2, name }).querySelector("a")?.getAttribute("href");

type Ref = Parameters<typeof getFunctionName>[0];
const asked = (ref: Ref) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .map(([, args]) => args);
const sent = (ref: Ref) => asked(ref).filter((args) => args !== "skip");

const tile = (key: string, scope: string, points: [string, number][], currency = "USD"): Tile => ({
  key,
  scope,
  latest:
    points.length === 0
      ? null
      : {
          value: points.at(-1)![1],
          periodStart: points.at(-1)![0],
          currency,
          source: "manual",
          syncedAt: NOW - DAY,
        },
  firstPeriodStart: points[0]?.[0] ?? null,
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});
const scorecard = (tiles: Tile[]) =>
  convex.setQuery(api.metrics.scorecard, { tiles, sources: {} });

let seq = 0;
const card = (stage: string, patch: Record<string, unknown> = {}) => ({
  id: `p${++seq}`,
  name: `SECRET CARD ${seq}`,
  stage,
  amount: null,
  lastActivityAt: NOW - DAY,
  closedAt: null,
  nextStep: "SECRET STEP",
  ...patch,
});

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  vi.mocked(useNow).mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Customers", () => {
  const LATE = { lastPaymentDate: "2026-06-01" };
  const register = (customers: ReturnType<typeof clinic>[]) =>
    convex.setQuery(api.customers.list, { customers, lastPushAt: NOW - 2 * DAY });

  test("counts clinics by health, and names none", () => {
    scorecard([tile("paying_clinics", "kz", [["2026-09-01", 14]], "KZT")]);
    register([clinic(), clinic(), clinic(LATE), clinic({ ...LATE, ...US })]);
    show(<CustomersSection />, { company: "kz" });
    expect(heading("Customers")).toBe("/customers");
    const customers = inRegion("Customers");
    const counts = customers.getAllByRole("listitem").map((item) => item.textContent);
    // The US clinic is the other company's: not counted here.
    expect(counts).toEqual(["2 Healthy", "0 Watch", "1 At risk"]);
    expect(customers.getByRole("link", { name: /At risk/ }).getAttribute("href")).toBe(
      "/customers?health=at_risk",
    );
    expect(customers.getByRole("heading", { level: 3, name: "Paying clinics" })).toBeTruthy();
    expect(customers.getByText("14")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("the amount owed is shown where the company has that figure, and only there", () => {
    scorecard([tile("receivables", "kz", [["2026-09-01", 900_000]], "KZT")]);
    register([clinic()]);
    show(<CustomersSection />, { company: "kz" });
    expect(inRegion("Customers").getByRole("heading", { name: "Owed by clients" })).toBeTruthy();
    expect(inRegion("Customers").getByText(formatValue(900_000, "currency", "KZT"))).toBeTruthy();
    cleanup();
    show(<CustomersSection />, { company: "us" });
    expect(screen.queryByRole("heading", { name: "Owed by clients" })).toBeNull();
  });

  test("a figure with no value yet is left out: no empty tile asking for one", () => {
    scorecard([tile("paying_clinics", "us", [])]);
    register([clinic(US)]);
    show(<CustomersSection />, { company: "us" });
    expect(screen.queryByRole("heading", { name: "Paying clinics" })).toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByRole("link", { name: "Add a value" })).toBeNull();
  });

  test("a clinic with nothing on record to judge by is said, not counted as healthy", () => {
    scorecard([]);
    register([clinic({ lastPaymentDate: null, amountOwed: null, lastUsageDate: null })]);
    show(<CustomersSection />, { company: "kz" });
    expect(inRegion("Customers").getAllByRole("listitem")[0]!.textContent).toBe("0 Healthy");
    expect(inRegion("Customers").getByText(/1 more has nothing on record to judge by/)).toBeTruthy();
  });

  test("with no clinic on record it is one quiet line, not three zeros", () => {
    scorecard([]);
    register([]);
    show(<CustomersSection />);
    expect(inRegion("Customers").getByText("No clinics are on record yet.")).toBeTruthy();
    expect(inRegion("Customers").queryAllByRole("listitem")).toEqual([]);
  });

  test("shows its own skeleton until the clinics arrive", () => {
    scorecard([]);
    show(<CustomersSection />);
    expect(busy("Customers")).not.toBeNull();
  });

  test("is not there without customers, and the clinics are never asked for", () => {
    scorecard([]);
    show(<CustomersSection />, { areas: ["scorecard", "finance"] });
    expect(region("Customers")).toBeNull();
    expect(sent(api.customers.list)).toEqual([]);
  });
});

describe("Sales pipeline", () => {
  const BOARD = {
    lead: [card("lead", { amount: 400 }), card("lead", { amount: 600 }), card("lead")],
    qualified: [card("qualified", { amount: 250, lastActivityAt: NOW - 40 * DAY })],
    demo: [],
    proposal: [card("proposal")],
    won: [card("won", { closedAt: NOW - 5 * DAY })],
    lost: [card("lost", { closedAt: NOW - 6 * DAY })],
  };
  const cells = (name: string) =>
    within(inRegion("Sales pipeline").getByRole("row", { name: new RegExp(`^${name}`) }))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);

  test("a funnel of open deals by stage: how many, and their monthly fees", () => {
    convex.setQuery(api.deals.board, BOARD);
    show(<SalesSection />, { company: "us" });
    expect(heading("Sales pipeline")).toBe("/sales");
    expect(cells("Lead")).toEqual(["", "3", "$1,000/mo"]);
    expect(cells("Qualified")).toEqual(["", "1", "$250/mo"]);
    // An empty stage has no fee; a stage whose deals have none says so.
    expect(cells("Demo")).toEqual(["", "0", ""]);
    expect(cells("Proposal")).toEqual(["", "1", "No amount"]);
    expect(cells("Open")).toEqual(["", "5", "$1,250/mo"]);
    const sales = inRegion("Sales pipeline");
    expect(sales.getByText("2 open deals have no amount and are left out.")).toBeTruthy();
    // Win rate and what has gone quiet, in the sales page's own words.
    expect(sales.getByRole("heading", { level: 3, name: "Win rate" })).toBeTruthy();
    expect(sales.getByText("50%")).toBeTruthy();
    expect(sales.getByText("1 won of 2 closed in the last 180 days.")).toBeTruthy();
    expect(sales.getByRole("heading", { level: 3, name: "Gone quiet" })).toBeTruthy();
    expect(sales.getByText(/Longest: 40 days/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("a summary has no download (the Sales page has the table); its rows read as stages and figures", () => {
    convex.setQuery(api.deals.board, BOARD);
    show(<SalesSection />, { company: "us" });
    const sales = inRegion("Sales pipeline");
    expect(sales.queryByRole("button", { name: /as CSV/ })).toBeNull();
    expect(readTable(sales.getByRole("table"))).toEqual([
      ["Stage", "Deals", "Monthly fee"],
      ["Lead", "3", "$1,000/mo"],
      ["Qualified", "1", "$250/mo"],
      ["Demo", "0", ""],
      ["Proposal", "1", "No amount"],
      ["Open", "5", "$1,250/mo"],
    ]);
  });

  test("with no fee on any open deal there is no column of 'No amount': one line says so", () => {
    convex.setQuery(api.deals.board, { lead: [card("lead"), card("lead")], demo: [card("demo")] });
    show(<SalesSection />, { company: "us" });
    const sales = inRegion("Sales pipeline");
    expect(sales.queryByRole("columnheader", { name: "Monthly fee" })).toBeNull();
    expect(sales.queryByText("No amount")).toBeNull();
    expect(sales.getByText("No open deal has a monthly fee yet.")).toBeTruthy();
    expect(cells("Lead")).toEqual(["", "2"]);
  });

  test("a win rate not known yet is a quiet dash beside its reason, not a headline", () => {
    convex.setQuery(api.deals.board, { lead: [card("lead")] });
    show(<SalesSection />, { company: "us" });
    const sales = inRegion("Sales pipeline");
    expect(sales.getByText("No value yet").className).toContain("sr-only");
    expect(sales.getByText("—")).toBeTruthy();
  });

  test("Kazakhstan's fees are in tenge", () => {
    convex.setQuery(api.deals.board, { lead: [card("lead", { amount: 300_000 })] });
    show(<SalesSection />, { company: "kz" });
    expect(cells("Lead")).toEqual(["", "1", `${formatValue(300_000, "currency", "KZT")}/mo`]);
  });

  test("with no open deal there is a sentence and no funnel of zeros", () => {
    convex.setQuery(api.deals.board, {});
    show(<SalesSection />, { company: "us" });
    const sales = inRegion("Sales pipeline");
    expect(sales.getByText("Nothing is in Lead, Qualified, Demo or Proposal.")).toBeTruthy();
    expect(sales.queryByRole("table")).toBeNull();
    expect(sales.getByText("No deal has closed in the last 180 days.")).toBeTruthy();
    expect(sales.queryByRole("heading", { name: "Gone quiet" })).toBeNull();
  });

  test("shows its own skeleton until the board arrives", () => {
    show(<SalesSection />, { company: "us" });
    expect(busy("Sales pipeline")).not.toBeNull();
  });

  test("only the market in view is asked for", () => {
    convex.setQuery(api.deals.board, {});
    show(<SalesSection />, { company: "kz" });
    expect(sent(api.deals.board)).toEqual([{ market: "kz" }]);
  });

  test("is not there without sales, and no board is asked for", () => {
    show(<SalesSection />, { areas: ["scorecard", "customers"] });
    expect(region("Sales pipeline")).toBeNull();
    expect(sent(api.deals.board)).toEqual([]);
  });
});

describe("Fundraising", () => {
  const BOARD = {
    target: [card("target"), card("target")],
    contacted: [card("contacted", { nextStep: null })],
    meeting: [card("meeting"), card("meeting", { nextStep: " " })],
    diligence: [],
    committed: [card("committed", { amount: 250_000 }), card("committed", { amount: 100_000 })],
    passed: [card("passed")],
  };

  test("investors by stage, what is committed, and who has no next step", () => {
    convex.setQuery(api.investors.board, BOARD);
    show(<FundraisingSection />, { company: "us" });
    expect(heading("Fundraising")).toBe("/fundraising");
    const raise = inRegion("Fundraising");
    const rows = raise
      .getAllByRole("row")
      .slice(1)
      .map((row) => [
        within(row).getByRole("rowheader").textContent,
        within(row).getAllByRole("cell").at(-1)!.textContent,
      ]);
    expect(rows).toEqual([
      ["To contact", "2"],
      ["Contacted", "1"],
      ["Meeting", "2"],
      ["Diligence", "0"],
      ["Committed", "2"],
    ]);
    expect(raise.getByRole("heading", { level: 3, name: "Committed" })).toBeTruthy();
    expect(raise.getByText("$350K")).toBeTruthy();
    expect(raise.getByRole("heading", { level: 3, name: "No next step" })).toBeTruthy();
    expect(raise.getByText("In conversation with nothing planned.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("with nobody on the board it is one quiet line", () => {
    convex.setQuery(api.investors.board, {});
    show(<FundraisingSection />, { company: "us" });
    expect(inRegion("Fundraising").getByText("No investors are on the board yet.")).toBeTruthy();
    expect(inRegion("Fundraising").queryByRole("table")).toBeNull();
  });

  test("shows its own skeleton until the board arrives", () => {
    show(<FundraisingSection />, { company: "us" });
    expect(busy("Fundraising")).not.toBeNull();
  });

  test.each([
    ["Globex's view", { company: "kz" as const }],
    ["a viewer without fundraising", { areas: ["scorecard", "sales"] as Area[] }],
    ["a viewer on Globex alone", { companies: ["kz"] as Company[], company: "kz" as const }],
  ])("is not there for %s, and investors are never asked for", (_name, viewer) => {
    show(<FundraisingSection />, viewer);
    expect(region("Fundraising")).toBeNull();
    expect(sent(api.investors.board)).toEqual([]);
  });
});

describe("Product", () => {
  const WEEKS: [string, number][] = [
    ["2026-09-14", 30],
    ["2026-09-21", 34],
    ["2026-09-28", 41],
    ["2026-10-05", 44],
  ];
  const TILES = [
    tile("weekly_active_users", "startup_insights", WEEKS),
    tile("searches", "startup_insights", [["2026-10-05", 512]]),
    tile("weekly_active_users", "vertical_startup", WEEKS.slice(2)),
    tile("weekly_active_users", "kz_product", WEEKS.slice(1)),
    tile("clinics_checking", "kz_product", [["2026-10-05", 7]]),
    tile("checks_completed", "kz_product", [["2026-10-05", 93]]),
  ];
  const charts = () => screen.queryAllByRole("group").map((chart) => chart.getAttribute("aria-label"));

  test("Startup: each product's users, Startup Insights' searches, and a trend where three weeks exist", () => {
    scorecard(TILES);
    show(<ProductSection />, { company: "us" });
    expect(heading("Product")).toBe("/product");
    const product = inRegion("Product");
    // Each product's name, then its figures.
    expect(product.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Startup Insights",
      "Weekly active users",
      "Searches",
      "Vertical Startup",
      "Weekly active users",
    ]);
    expect(product.getByText("512")).toBeTruthy();
    // Four weeks of Startup Insights are a trend; two of Vertical Startup are not.
    expect(charts()).toEqual(["Weekly active users · Startup Insights"]);
    expect(product.queryByText("7")).toBeNull();
  });

  test("Globex: users, clinics that ran a check and checks completed", () => {
    scorecard(TILES);
    show(<ProductSection />, { company: "kz" });
    const product = inRegion("Product");
    // One product: its name would only repeat the section's.
    expect(product.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Weekly active users",
      "Clinics that ran a check",
      "Checks completed",
    ]);
    expect(product.getByText("93")).toBeTruthy();
    expect(charts()).toEqual(["Weekly active users · Kazakhstan"]);
    expect(product.queryByText("512")).toBeNull();
  });

  test("a product with no figure yet is one quiet line: no empty tile, no zero, no chart", () => {
    scorecard([tile("weekly_active_users", "kz_product", [])]);
    show(<ProductSection />, { company: "kz" });
    const product = inRegion("Product");
    expect(product.getByText("No usage figures have arrived yet.")).toBeTruthy();
    expect(product.queryByText("No value yet")).toBeNull();
    expect(product.queryByText("0")).toBeNull();
    expect(product.queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(charts()).toEqual([]);
  });

  test("shows its own skeleton until the figures arrive", () => {
    show(<ProductSection />);
    expect(busy("Product")).not.toBeNull();
  });

  describe("engineering, in one line", () => {
    // NOW is Monday 2026-10-12: last week began on the 5th.
    const ENGINEERING = [
      tile("prs_merged", "us", [["2026-10-05", 12]]),
      // The stored figure is not the count: the list is.
      tile("prs_stuck", "us", [["2026-10-12", 9]]),
      tile("prs_merged", "kz", [["2026-10-05", 5]]),
    ];
    // Made-up pull requests, each stuck by the "waiting for review" rule.
    const stuckPull = (number: number, company: Company) => ({
      repoId: "Made-Up-Org/app",
      number,
      company,
      title: `Made-up change ${number}`,
      url: `https://github.com/Made-Up-Org/app/pull/${number}`,
      draft: false,
      state: "open",
      createdAt: NOW - 5 * DAY,
      updatedAt: NOW - DAY,
      reviewDecision: "none",
      reviewersRequested: 0,
      reviewers: [],
      checks: "passing",
    });
    const pulls = (readAt: number | null = NOW) =>
      convex.setQuery(api.workTools.pullRequests, {
        readAt,
        rows: [stuckPull(1, "us"), stuckPull(2, "us")],
      });
    const WITH_ENGINEERING: Area[] = [...EVERY_AREA, "engineering"];

    test("the company in view's merged and stuck pull requests, stuck counted from the list", () => {
      scorecard([...TILES, ...ENGINEERING]);
      pulls();
      show(<ProductSection />, { company: "us", areas: WITH_ENGINEERING });
      const product = inRegion("Product");
      expect(
        product.getByRole("link", { name: "12 pull requests merged last week, 2 pull requests stuck." }),
      ).toBeTruthy();
      expect(product.queryByText(/5 pull requests/)).toBeNull();
    });

    test("the other company's view has its own", () => {
      scorecard([...TILES, ...ENGINEERING]);
      pulls();
      show(<ProductSection />, { company: "kz", areas: WITH_ENGINEERING });
      expect(
        inRegion("Product").getByRole("link", {
          name: "5 pull requests merged last week, 0 pull requests stuck.",
        }),
      ).toBeTruthy();
    });

    test("no line until a figure has arrived: nothing is shown as 0", () => {
      scorecard([...TILES, tile("prs_merged", "us", [])]);
      pulls(null);
      show(<ProductSection />, { company: "us", areas: WITH_ENGINEERING });
      expect(inRegion("Product").queryByText(/Engineering/)).toBeNull();
    });

    test("the line leads to the stuck ones for a viewer with the page; without it, merged only and no list asked", () => {
      scorecard([...TILES, ...ENGINEERING]);
      pulls();
      const words = "12 pull requests merged last week, 2 pull requests stuck.";
      show(<ProductSection />, { company: "us", areas: WITH_ENGINEERING });
      expect(inRegion("Product").getByRole("link", { name: words }).getAttribute("href")).toBe(
        "/engineering?stuck=1",
      );
      cleanup();
      vi.mocked(useQuery).mockClear();
      show(<ProductSection />, { company: "us", areas: ["scorecard", "product"] });
      expect(inRegion("Product").getByText("Engineering: 12 pull requests merged last week.")).toBeTruthy();
      expect(inRegion("Product").queryByRole("link", { name: /pull requests/ })).toBeNull();
      expect(sent(api.workTools.pullRequests)).toEqual([]);
    });

    test("it adds no tile and no chart: the figures are on /engineering", () => {
      scorecard([...TILES, ...ENGINEERING]);
      show(<ProductSection />, { company: "us" });
      expect(inRegion("Product").queryByRole("heading", { name: /pull requests/i })).toBeNull();
      expect(charts().some((name) => /pull requests/i.test(name ?? ""))).toBe(false);
    });
  });

  test("is not there without product", () => {
    scorecard(TILES);
    show(<ProductSection />, { areas: ["scorecard", "board"] });
    expect(region("Product")).toBeNull();
  });
});

describe("Go to market", () => {
  const TILES = [
    tile("outbound_delivered", "us", [
      ["2026-09-28", 200],
      ["2026-10-05", 260],
    ]),
    tile("outbound_replied", "us", [
      ["2026-09-28", 8],
      ["2026-10-05", 13],
    ]),
  ];

  test("the headline numbers of /gtm, in its own words", () => {
    scorecard(TILES);
    show(<GtmSection />, { company: "us" });
    expect(heading("Go to market")).toBe("/gtm");
    const gtm = inRegion("Go to market");
    expect(
      gtm.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Visitor to signup", "Outbound reply rate", "Delivered last week"]);
    expect(gtm.getByText("5%")).toBeTruthy();
    expect(gtm.getByText("13 replies to 260 delivered, every sequence to date.")).toBeTruthy();
    expect(gtm.getByText("60")).toBeTruthy();
  });

  test("visitor to signup is left out for a viewer the figures behind it are not sent to", () => {
    scorecard(TILES);
    show(<GtmSection />, { company: "us", areas: ["scorecard", "gtm"] });
    expect(
      inRegion("Go to market")
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Outbound reply rate", "Delivered last week"]);
  });

  test("shows its own skeleton until the figures arrive", () => {
    show(<GtmSection />, { company: "us" });
    expect(busy("Go to market")).not.toBeNull();
  });

  test.each([
    ["Globex's view", { company: "kz" as const }],
    ["a viewer without the area", { areas: ["scorecard", "sales"] as Area[] }],
    ["a viewer on Globex alone", { companies: ["kz"] as Company[], company: "kz" as const }],
  ])("is not there for %s", (_name, viewer) => {
    scorecard(TILES);
    show(<GtmSection />, viewer);
    expect(region("Go to market")).toBeNull();
  });
});

describe("Work", () => {
  const task = (patch: Record<string, unknown> = {}) => ({
    id: `t${++seq}`,
    title: `SECRET TASK ${seq}`,
    notes: null,
    kind: "task",
    column: "backlog",
    due: null,
    goalId: null,
    goalTitle: null,
    doneAt: null,
    company: null,
    assignee: null,
    ...patch,
  });
  const ME = { status: "teammate", email: "me@example.com", name: null };
  const BOARD = {
    backlog: [task({ due: "2026-10-01" }), task({ company: "kz" })],
    this_week: [task({ assignee: ME })],
    doing: [task({ assignee: ME }), task()],
    done: [task({ due: "2026-01-01" })],
  };
  const NEVER = { state: null, message: null, lastOkAt: null };

  beforeEach(() => {
    convex.setQuery(api.goals.list, [
      { id: "g1", quarter: "2026-Q4", title: "Raise seed", status: "at_risk" },
    ]);
    convex.setQuery(api.tasks.openIssues, []);
    convex.setQuery(api.tasks.board, BOARD);
  });
  const tasks = () =>
    inRegion("Tasks")
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  test("goals, open issues and the board in three counts, for the company in view, nobody's own", () => {
    show(<WorkSection />, { company: "us" });
    expect(heading("Work")).toBe("/board");
    expect(inRegion(/^Goals/).getByText("Raise seed")).toBeTruthy();
    expect(region(/^Open problems/)).not.toBeNull();
    // Globex's task is not Startup's to count.
    expect(tasks()).toEqual(["4 Open", "2 Doing", "1 Overdue"]);
    expect(inRegion("Tasks").getByRole("link", { name: /Tasks/ }).getAttribute("href")).toBe(
      "/board",
    );
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("goals are a read-only summary here, for everyone, leading to Goals and targets", () => {
    for (const areas of [["scorecard", "board"], EVERY_AREA] as Area[][]) {
      cleanup();
      show(<WorkSection />, { areas });
      const goals = inRegion(/^Goals/);
      expect(goals.queryByLabelText("New goal")).toBeNull();
      expect(goals.queryAllByRole("combobox")).toEqual([]);
      expect(goals.queryAllByRole("button")).toEqual([]);
      expect(goals.getByRole("link", { name: /Goals/ }).getAttribute("href")).toBe("/goals");
    }
  });

  test("the tasks panel shows its own skeleton, and the goals do not wait for it", () => {
    convex.setQuery(api.tasks.board, undefined);
    show(<WorkSection />);
    expect(busy("Tasks")).not.toBeNull();
    expect(inRegion(/^Goals/).getByText("Raise seed")).toBeTruthy();
  });

  test("a person's own day is never here: it is Today's, whatever areas they have", () => {
    const OWN = [api.workTools.events, api.workTools.needsReply, api.workTools.myIssues];
    for (const ref of OWN) convex.setQuery(ref, { source: NEVER, events: [], threads: [], issues: [] });
    for (const areas of [[...EVERY_AREA, "personal", "admin"], ["scorecard", "today"]] as Area[][]) {
      cleanup();
      show(<WorkSection />, { areas });
      expect(region("Today")).toBeNull();
      for (const ref of OWN) expect(asked(ref)).toEqual([]);
    }
    cleanup();
    // Today alone opens no part of this section.
    show(<WorkSection />, { areas: ["today"] });
    expect(region("Work")).toBeNull();
  });

  test("without the board the tasks are not asked for; the goals still show", () => {
    convex.setQuery(api.tasks.board, undefined);
    show(<WorkSection />, { areas: ["scorecard"] });
    expect(region("Tasks")).toBeNull();
    expect(sent(api.tasks.board)).toEqual([]);
    expect(inRegion(/^Goals/).getByText("Raise seed")).toBeTruthy();
  });

  test("with neither the scorecard nor the board there is no section, and nothing is asked for", () => {
    show(<WorkSection />, { areas: ["product", "finance"] });
    expect(region("Work")).toBeNull();
    for (const ref of [api.goals.list, api.tasks.openIssues, api.tasks.board]) {
      expect(sent(ref), getFunctionName(ref)).toEqual([]);
    }
  });
});

describe("Compliance", () => {
  const counts = () =>
    inRegion("Compliance")
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  test("overdue, due in 30 days and unconfirmed, counted and never titled", () => {
    convex.setQuery(api.obligations.list, [
      obligation({ title: "SECRET tax", due: "2026-10-09", dueConfirmed: true }),
      obligation({ title: "SECRET renewal", due: "2026-10-20", dueConfirmed: true }),
      obligation({ title: "SECRET later", due: "2027-03-01", dueConfirmed: true }),
      obligation({ title: "SECRET guess", due: "2026-01-01" }),
      obligation({ title: "SECRET guess 2", due: "2026-12-01" }),
      obligation({ title: "SECRET hipaa", category: "hipaa", due: "2026-10-01", dueConfirmed: true }),
    ]);
    show(<ComplianceSection />, { company: "kz" });
    expect(heading("Compliance")).toBe("/compliance");
    // The HIPAA item is Startup's: Globex's view does not count it.
    expect(counts()).toEqual(["1 Overdue", "1 Due in 30 days", "2 Unconfirmed"]);
    cleanup();
    show(<ComplianceSection />, { company: "us" });
    expect(counts()).toEqual(["2 Overdue", "1 Due in 30 days", "2 Unconfirmed"]);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("an unconfirmed date in the past is never overdue", () => {
    convex.setQuery(api.obligations.list, [obligation({ due: "2020-01-01" })]);
    show(<ComplianceSection />);
    expect(counts()).toEqual(["0 Overdue", "0 Due in 30 days", "1 Unconfirmed"]);
  });

  test("nothing in it says the company meets a standard, and nothing wears the good colour", () => {
    convex.setQuery(api.obligations.list, [obligation({ status: "done" })]);
    show(<ComplianceSection />);
    const section = screen.getByRole("region", { name: "Compliance" });
    expect(section.textContent).not.toMatch(/compliant|certified|covered/i);
    expect(section.querySelector(".text-good")).toBeNull();
  });

  test("with nothing tracked it is one quiet line", () => {
    convex.setQuery(api.obligations.list, []);
    show(<ComplianceSection />);
    expect(inRegion("Compliance").getByText("Nothing is tracked yet.")).toBeTruthy();
    expect(inRegion("Compliance").queryAllByRole("listitem")).toEqual([]);
  });

  test("shows its own skeleton until the obligations arrive", () => {
    show(<ComplianceSection />);
    expect(busy("Compliance")).not.toBeNull();
  });

  test("is not there without compliance, and obligations are never asked for", () => {
    show(<ComplianceSection />, { areas: ["scorecard", "sales"] });
    expect(region("Compliance")).toBeNull();
    expect(sent(api.obligations.list)).toEqual([]);
  });
});
