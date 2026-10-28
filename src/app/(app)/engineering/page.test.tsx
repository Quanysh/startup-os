// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import type { PullRow } from "@/lib/engineering/flow";
import type { Tile } from "@/lib/metrics/scorecard";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import EngineeringPage from "./page";

// The address bar, as a small store: `router.replace` changes the query and
// whatever reads it renders again, as the real router does.
const nav = vi.hoisted(() => ({
  query: "",
  listeners: new Set<() => void>(),
  replaced: [] as string[],
}));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    nav.listeners.add(listener);
    return () => nav.listeners.delete(listener);
  };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => nav.query)),
    usePathname: () => "/engineering",
    useRouter: () => ({
      replace: (href: string) => {
        nav.replaced.push(href);
        nav.query = href.split("?")[1] ?? "";
        nav.listeners.forEach((listener) => listener());
      },
    }),
  };
});
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

// Wednesday, October 14: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

// Every pull request, repository and person here is made up.
const pr = (number: number, over: Partial<PullRow> = {}): PullRow => {
  const repoId = over.repoId ?? "Made-Up-Org/startup-app";
  return {
    repoId,
    number,
    company: "us",
    title: `Made-up change ${number}`,
    url: `https://github.com/${repoId}/pull/${number}`,
    authorLogin: "made-up-ada",
    authorName: "Made-up Ada",
    draft: false,
    state: "open",
    createdAt: ago(DAY),
    updatedAt: ago(HOUR),
    reviewDecision: "none",
    reviewersRequested: 0,
    reviewers: [],
    checks: "passing",
    ...over,
  };
};
const ben = { authorLogin: "made-up-ben", authorName: "Made-up Ben" };
const cy = { authorLogin: "made-up-cy", authorName: undefined };
const API = "Made-Up-Org/startup-api";

const ROWS: PullRow[] = [
  pr(1, { draft: true, updatedAt: ago(9 * DAY), createdAt: ago(20 * DAY), checks: "none" }),
  pr(2, { createdAt: ago(5 * DAY), reviewersRequested: 3, reviewers: ["made-up-ben", "made-up-cy"] }),
  pr(3, { createdAt: ago(DAY), ...ben }),
  pr(4, { createdAt: ago(2 * DAY), ...ben, checks: "failing" }),
  pr(5, { reviewDecision: "changes_requested", createdAt: ago(8 * DAY), lastReviewAt: ago(2 * DAY), ...cy, checks: "pending" }),
  pr(6, { reviewDecision: "approved", createdAt: ago(6 * DAY), updatedAt: ago(3 * DAY), ...ben }),
  pr(7, { state: "merged", createdAt: ago(4 * DAY), mergedAt: ago(DAY), repoId: API }),
  pr(8, { state: "merged", createdAt: ago(9 * DAY), mergedAt: ago(3 * DAY), ...ben }),
  pr(9, { state: "closed", createdAt: ago(9 * DAY), closedAt: ago(2 * DAY), ...cy }),
  // Long gone: in no stage, and nowhere on the page.
  pr(10, { state: "merged", createdAt: ago(40 * DAY), mergedAt: ago(30 * DAY), title: "Long gone" }),
  // Globex's: never in Startup's view.
  pr(11, { company: "kz", repoId: "Made-Up-Org/globex-app", title: "Globex change", authorLogin: "made-up-dee", authorName: "Made-up Dee" }),
];
const LIST = { readAt: NOW - 3 * HOUR, rows: ROWS };

const WEEKS = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
function tile(key: string, scope: string, points: [string, number][] = []): Tile {
  const series = points.map(([periodStart, value]) => ({ periodStart, value }));
  const last = series.at(-1);
  return {
    key,
    scope,
    firstPeriodStart: series[0]?.periodStart ?? null,
    latest: last ? { ...last, currency: null, source: "github", syncedAt: NOW - 60_000 } : null,
    series,
  };
}
const TILES: Tile[] = [
  tile("prs_merged", "us", WEEKS.map((week, i) => [week, [8, 6, 9, 3][i]!])),
  tile("prs_opened", "us", WEEKS.map((week, i) => [week, [9, 7, 9, 5][i]!])),
  tile("prs_open", "us", [["2026-10-12", 6]]),
  tile("prs_stuck", "us", [["2026-10-12", 1]]),
  tile("repos_failing", "us", [["2026-10-12", 0]]),
  tile("repos_tracked", "us", [["2026-10-12", 2]]),
  tile("prs_merged", "kz", [["2026-10-05", 77]]),
];
const REPOS = {
  readAt: NOW - 3 * HOUR,
  rows: [
    {
      repoId: "Made-Up-Org/startup-app",
      org: "Made-Up-Org",
      name: "startup-app",
      company: "us" as const,
      mergedLastWeek: 3,
      open: 6,
      stuck: 1,
      main: "passing" as const,
      pushedAt: "2026-10-13",
    },
  ],
};

let convex: ReturnType<typeof mockConvex>;
type Options = {
  list?: { readAt: number | null; rows: PullRow[] } | undefined;
  tiles?: Tile[];
  company?: "us" | "kz";
  query?: string;
  areas?: Area[];
};
function show({ list = LIST, tiles = TILES, company = "us", query = "", areas }: Options = {}) {
  nav.query = query;
  convex.setQuery(api.workTools.pullRequests, list);
  convex.setQuery(api.workTools.engineering, REPOS);
  convex.setQuery(api.metrics.scorecard, { tiles, sources: {} });
  vi.mocked(useNow).mockReturnValue(NOW);
  window.localStorage.setItem("startup-os:company", company);
  const page = (
    <CompanyProvider>
      <EngineeringPage />
    </CompanyProvider>
  );
  return render(
    areas === undefined ? (
      page
    ) : (
      <ViewerProvider viewer={{ role: "engineer", companies: ["us", "kz"], areas, email: null, name: null }}>
        {page}
      </ViewerProvider>
    ),
  );
}

beforeEach(() => {
  convex = mockConvex();
  nav.query = "";
  nav.replaced.length = 0;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const region = (name: string) => within(screen.getByRole("region", { name }));
const column = (name: string) => within(region("The flow").getByRole("group", { name }));
const cards = (name: string) => column(name).queryAllByRole("listitem");
const chipsIn = (scope: ReturnType<typeof within>) =>
  [...scope.queryAllByText(/.+/, { selector: '[data-slot="status-chip"]' })].map((chip) => [
    chip.textContent,
    chip.getAttribute("data-tone"),
  ]);
const table = () => within(region("All pull requests").getByRole("table", { name: "Pull requests" }));
const titles = () =>
  table()
    .getAllByRole("rowheader")
    .map((cell) => within(cell).getByRole("link").textContent);
const numbersShown = () => titles().map((title) => Number(title!.replace("Made-up change ", "")));

describe("the Engineering page", () => {
  test("its heading, and the blocks in their order", () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Engineering" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Stuck and piling up",
      "The flow",
      "By owner",
      "All pull requests",
      "Figures and repositories",
    ]);
  });

  test.each([
    ["the pull requests", () => convex.setQuery(api.workTools.pullRequests, undefined)],
    ["the scorecard", () => convex.setQuery(api.metrics.scorecard, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("holds its place and shows no number until %s are in", (_name, withhold) => {
    show();
    cleanup();
    withhold();
    const { container } = render(<EngineeringPage />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/pull requests? (is|are) stuck/)).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  test("the company in view only: Globex's pull request is not on Startup's page, and the other way round", () => {
    show();
    expect(screen.queryByText("Globex change")).toBeNull();
    expect(screen.queryByText("Made-up Dee")).toBeNull();
    cleanup();
    show({ company: "kz" });
    expect(screen.getAllByText("Globex change").length).toBeGreaterThan(0);
    expect(screen.queryByText("Made-up change 2")).toBeNull();
    expect(screen.queryByText("Made-up Ada")).toBeNull();
  });

  test("without the engineering area nothing is asked of the server", () => {
    show({ areas: ["product", "board"] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Made-up change 2")).toBeNull();
  });

  test("what long left the flow is nowhere on the page", () => {
    show();
    expect(screen.queryByText("Long gone")).toBeNull();
  });
});

describe("the flow", () => {
  test("five stages left to right, each with how many are in it", () => {
    show();
    const groups = region("The flow").getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Draft",
      "Waiting for review",
      "Changes requested",
      "Approved",
      "Merged",
    ]);
    expect(groups.map((g) => g.querySelector('[data-slot="flow-count"]')!.textContent)).toEqual([
      "1",
      "3",
      "1",
      "1",
      "2",
    ]);
    // The merged column is the last 14 days, and says so.
    expect(column("Merged").getByText("last 14 days")).toBeTruthy();
  });

  test("each head says how many are stuck, with a danger chip, and the median age", () => {
    show();
    expect(chipsIn(within(column("Waiting for review").getByTestId("flow-head")))).toEqual([["2 stuck", "danger"]]);
    expect(chipsIn(within(column("Draft").getByTestId("flow-head")))).toEqual([["1 stuck", "danger"]]);
    expect(chipsIn(within(column("Changes requested").getByTestId("flow-head")))).toEqual([]);
    expect(column("Waiting for review").getByText("Median 2 days")).toBeTruthy();
    expect(column("Draft").getByText("Median 9 days")).toBeTruthy();
    expect(column("Merged").getByText("Median 2 days")).toBeTruthy();
  });

  test("one band runs through the stages, drawn for the eye and hidden from a reader: the numbers are written", () => {
    show();
    // One path, seen through a window per stage, so it stays under its head.
    const bands = screen.getAllByTestId("flow-band");
    expect(bands).toHaveLength(5);
    // Thickest where the most sit: waiting for review, with three.
    expect(bands.map((band) => band.getAttribute("data-thickness"))).toEqual(["16", "48", "16", "16", "32"]);
    expect(new Set(bands.map((band) => band.querySelector("path")!.getAttribute("d"))).size).toBe(1);
    expect(bands.map((band) => band.getAttribute("viewBox"))).toEqual([
      "0 0 100 48",
      "100 0 100 48",
      "200 0 100 48",
      "300 0 100 48",
      "400 0 100 48",
    ]);
    for (const band of bands) {
      expect(band.getAttribute("aria-hidden")).toBe("true");
      // One hue for every stage.
      expect(band.querySelector("path")!.getAttribute("fill")).toBe("var(--chart-1)");
      expect(band.querySelectorAll("path")).toHaveLength(1);
    }
  });

  test("the cards of a stage, the longest there first", () => {
    show();
    expect(cards("Waiting for review").map((card) => within(card).getByRole("link").textContent)).toEqual([
      "Made-up change 2",
      "Made-up change 4",
      "Made-up change 3",
    ]);
    // Merged: the most recent first.
    expect(cards("Merged").map((card) => within(card).getByRole("link").textContent)).toEqual([
      "Made-up change 7",
      "Made-up change 8",
    ]);
  });

  test("a card: title linked to GitHub in a new tab, repository, number, owner, age, checks and who is asked", () => {
    show();
    const card = within(cards("Waiting for review")[0]!);
    const link = card.getByRole("link", { name: "Made-up change 2" });
    expect(link.getAttribute("href")).toBe("https://github.com/Made-Up-Org/startup-app/pull/2");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(card.getByText("startup-app")).toBeTruthy();
    expect(card.getByText("#2")).toBeTruthy();
    // The owner: initials for the eye, the name for everyone.
    const owner = card.getByTestId("owner");
    expect(owner.textContent).toBe("MAMade-up Ada");
    expect(owner.querySelector("[aria-hidden]")!.textContent).toBe("MA");
    expect(card.getByText("5 days since it was opened")).toBeTruthy();
    expect(chipsIn(card)).toEqual([["Checks passing", "success"]]);
    // Three asked, two of them people who are named.
    expect(card.getByText("Asked to review: made-up-ben, made-up-cy and 1 more")).toBeTruthy();
  });

  test("the owner is their login where GitHub has no name", () => {
    show();
    const owner = within(cards("Changes requested")[0]!).getByTestId("owner");
    expect(owner.textContent).toBe("MUmade-up-cy");
  });

  test("a stuck card is tinted and says why in words; one that is not says nothing of it", () => {
    show();
    const [waited, failing, fine] = cards("Waiting for review");
    expect(waited!.getAttribute("data-stuck")).toBe("true");
    expect(within(waited!).getByText("Waiting 5 days for a first review")).toBeTruthy();
    expect(failing!.getAttribute("data-stuck")).toBe("true");
    expect(within(failing!).getByText("Checks are failing")).toBeTruthy();
    expect(chipsIn(within(failing!))).toEqual([["Checks failing", "danger"]]);
    expect(fine!.getAttribute("data-stuck")).toBeNull();
    expect(within(fine!).queryByText(/Waiting|failing/)).toBeNull();
    expect(within(fine!).getByText("Nobody is asked to review")).toBeTruthy();
  });

  test("each check result has its chip", () => {
    show();
    expect(chipsIn(within(cards("Draft")[0]!))).toEqual([["No checks", "neutral"]]);
    expect(chipsIn(within(cards("Changes requested")[0]!))).toEqual([["Checks running", "info"]]);
  });

  test("where the facts cannot say when a stage began, the age is since last activity", () => {
    show();
    expect(within(cards("Approved")[0]!).getByText("3 days since last activity")).toBeTruthy();
    expect(within(cards("Changes requested")[0]!).getByText("2 days since the last review")).toBeTruthy();
    expect(within(cards("Merged")[0]!).getByText("1 day since it was merged")).toBeTruthy();
  });

  test("a title is text: markup in it is shown as typed, never run, and never becomes the address", () => {
    const nasty = pr(31, {
      title: '<img src=x onerror="alert(1)"> https://example.test/phish',
    });
    const { container } = show({ list: { readAt: NOW, rows: [nasty] } });
    expect(container.querySelector("img")).toBeNull();
    const link = within(cards("Waiting for review")[0]!).getByRole("link");
    expect(link.textContent).toBe('<img src=x onerror="alert(1)"> https://example.test/phish');
    expect(link.getAttribute("href")).toBe("https://github.com/Made-Up-Org/startup-app/pull/31");
  });

  test("a pull request whose stored address is not GitHub's own for it is shown without a link", () => {
    const odd = pr(32, { url: "https://example.test/Made-Up-Org/startup-app/pull/32" });
    show({ list: { readAt: NOW, rows: [odd] } });
    const card = within(cards("Waiting for review")[0]!);
    expect(card.queryByRole("link")).toBeNull();
    expect(card.getByText("Made-up change 32")).toBeTruthy();
    expect(document.querySelector('a[href*="example.test"]')).toBeNull();
  });

  test("an empty stage is a quiet dash: a real zero in its head, no median, no box of cards", () => {
    show({ list: { readAt: NOW, rows: [ROWS[1]!] } });
    const draft = column("Draft");
    expect(draft.getByTestId("flow-head").querySelector('[data-slot="flow-count"]')!.textContent).toBe("0");
    expect(draft.queryByText(/Median/)).toBeNull();
    expect(draft.queryAllByRole("listitem")).toEqual([]);
    expect(draft.getByText("—")).toBeTruthy();
  });

  test("a long stage shows the first six, and the rest on request", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 9 }, (_, i) => pr(40 + i, { createdAt: ago((i + 1) * HOUR) }));
    show({ list: { readAt: NOW, rows: many } });
    expect(cards("Waiting for review")).toHaveLength(6);
    const more = column("Waiting for review").getByRole("button", { name: "Show all 9" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);
    expect(cards("Waiting for review")).toHaveLength(9);
    await user.click(column("Waiting for review").getByRole("button", { name: "Show the first 6" }));
    expect(cards("Waiting for review")).toHaveLength(6);
    // The head counts all of them either way.
    expect(column("Waiting for review").getByTestId("flow-head").querySelector('[data-slot="flow-count"]')!.textContent).toBe("9");
  });

  test("closed without merging has no column, and is said under the flow", () => {
    show();
    expect(region("The flow").getByText("1 closed without merging in the last 14 days, listed in the table below.")).toBeTruthy();
  });

  test("it is read-only: no grip, no button that writes, nothing to drag", () => {
    show();
    const flow = screen.getByRole("region", { name: "The flow" });
    expect(flow.querySelector("[draggable='true']")).toBeNull();
    expect(within(flow).queryAllByRole("button")).toEqual([]);
  });
});

describe("stuck and piling up", () => {
  test("how many are stuck, and the three stuck the longest, each named with its owner and why", () => {
    show();
    const strip = region("Stuck and piling up");
    expect(strip.getByText("4 pull requests are stuck.")).toBeTruthy();
    const named = strip.getAllByRole("listitem");
    expect(named.map((item) => within(item).getByRole("link").textContent)).toEqual([
      "Made-up change 1",
      "Made-up change 2",
      "Made-up change 6",
    ]);
    expect(named[0]!.textContent).toContain("Made-up Ada");
    expect(named[0]!.textContent).toContain("Draft untouched for 9 days");
    expect(named[2]!.textContent).toContain("Made-up Ben");
    const link = within(named[0]!).getByRole("link");
    expect([link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["_blank", "noreferrer"]);
  });

  test("which stage holds the most, against last week's merged count", () => {
    show();
    expect(
      region("Stuck and piling up").getByText(
        "3 waiting for review, about a week of work at last week's pace of 3 merged.",
      ),
    ).toBeTruthy();
  });

  test("without last week's figure there is no such sentence, and no number is made up", () => {
    show({ tiles: [] });
    expect(region("Stuck and piling up").queryByText(/pace/)).toBeNull();
    expect(region("Stuck and piling up").getByText("4 pull requests are stuck.")).toBeTruthy();
  });

  test("one, and none", () => {
    show({ list: { readAt: NOW, rows: [ROWS[1]!] } });
    expect(region("Stuck and piling up").getByText("1 pull request is stuck.")).toBeTruthy();
    cleanup();
    show({ list: { readAt: NOW, rows: [ROWS[2]!] } });
    expect(region("Stuck and piling up").getByText("No pull request is stuck.")).toBeTruthy();
    expect(region("Stuck and piling up").queryAllByRole("listitem")).toEqual([]);
  });
});

describe("by owner", () => {
  const owners = () => within(region("By owner").getByRole("table"));

  test("load and blockage for each engineer, the most stuck first", () => {
    show();
    expect(owners().getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Engineer",
      "Open",
      "Waiting for review",
      "Changes requested",
      "Approved",
      "Stuck",
      "Oldest open",
    ]);
    const rows = owners().getAllByRole("row").slice(1);
    expect(rows.map((row) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent))).toEqual([
      ["MAMade-up Ada", "2", "1", "0", "0", "2", "20 days"],
      ["MBMade-up Ben", "3", "2", "0", "1", "2", "6 days"],
      ["MUmade-up-cy", "1", "0", "1", "0", "0", "8 days"],
    ]);
  });

  test("downloads each engineer by name, without the initials drawn beside it", () => {
    show();
    expect(screen.getByRole("button", { name: "Download Open pull requests by owner as CSV" })).toBeTruthy();
    const rows = readTable(region("By owner").getByRole("table"));
    expect(rows.slice(1).map((cells) => cells[0])).toEqual(["Made-up Ada", "Made-up Ben", "made-up-cy"]);
  });

  test("no column counts what anyone merged, and the caption says why", () => {
    show();
    const text = screen.getByRole("region", { name: "By owner" }).textContent ?? "";
    for (const word of ["Merged", "merged per", "Closed", "Shipped", "Output per", "Rank", "Leaderboard"]) {
      expect(owners().queryByRole("columnheader", { name: new RegExp(word, "i") })).toBeNull();
    }
    expect(text).toContain(
      "Open work and what is blocked, by engineer. Load, not output: nothing here counts what anyone merged.",
    );
  });

  test("clicking a row filters the page to that person, and clicking again shows everyone", async () => {
    const user = userEvent.setup();
    show();
    const button = owners().getByRole("button", { name: "Made-up Ben" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(nav.replaced.at(-1)).toBe("/engineering?owner=made-up-ben");
    expect(owners().getByRole("button", { name: "Made-up Ben" }).getAttribute("aria-pressed")).toBe("true");
    // The flow, the strip and the table are Ben's now; the owners' table still lists everyone.
    expect(cards("Waiting for review").map((c) => within(c).getByRole("link").textContent)).toEqual([
      "Made-up change 4",
      "Made-up change 3",
    ]);
    expect(cards("Draft")).toEqual([]);
    expect(region("Stuck and piling up").getByText("2 pull requests are stuck.")).toBeTruthy();
    expect(numbersShown().sort()).toEqual([3, 4, 6, 8]);
    expect(owners().getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Showing Made-up Ben's pull requests.")).toBeTruthy();

    await user.click(owners().getByRole("button", { name: "Made-up Ben" }));
    expect(nav.replaced.at(-1)).toBe("/engineering");
    expect(cards("Draft")).toHaveLength(1);
  });

  test("“Show everyone” clears the person", async () => {
    const user = userEvent.setup();
    show({ query: "owner=made-up-ben" });
    await user.click(screen.getByRole("button", { name: "Show everyone" }));
    expect(nav.query).toBe("");
    expect(screen.queryByText(/Showing .* pull requests\./)).toBeNull();
  });
});

describe("all pull requests: the table", () => {
  test("every pull request in a stage, stuck first and then the oldest, and it says so", () => {
    show();
    expect(numbersShown()).toEqual([1, 6, 2, 4, 8, 9, 5, 7, 3]);
    expect(region("All pull requests").getByText("Showing 9 of 9. Sorted: stuck first, then the oldest.")).toBeTruthy();
    for (const header of table().getAllByRole("columnheader")) {
      expect(["none", null]).toContain(header.getAttribute("aria-sort"));
    }
  });

  test("a row: the title linked, its repository and number, owner, stage, dates, age and checks", () => {
    show();
    const row = within(table().getAllByRole("row")[3]!);
    const link = row.getByRole("link", { name: "Made-up change 2" });
    expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual([
      "https://github.com/Made-Up-Org/startup-app/pull/2",
      "_blank",
      "noreferrer",
    ]);
    expect(row.getByText("Made-up Ada")).toBeTruthy();
    expect(row.getByText("startup-app")).toBeTruthy();
    expect(chipsIn(row)).toEqual([
      ["Waiting for review", "info"],
      ["Stuck", "danger"],
      ["Checks passing", "success"],
    ]);
    expect(row.getByText("Waiting 5 days for a first review")).toBeTruthy();
    expect(row.getByText("Oct 9")).toBeTruthy();
    expect(row.getByText("Oct 14")).toBeTruthy();
    expect(row.getByText("5 days")).toBeTruthy();
  });

  const SORTS: [string, string, number[], number[]][] = [
    ["Opened", "opened", [1, 8, 9, 5, 6, 2, 7, 4, 3], [3, 4, 7, 2, 6, 5, 8, 9, 1]],
    // Ties in age go to the one opened first, whichever way the column runs.
    ["Age in stage", "age", [7, 3, 9, 5, 4, 8, 6, 2, 1], [1, 2, 8, 6, 9, 5, 4, 7, 3]],
    ["Repository", "repo", [7, 1, 8, 9, 5, 6, 2, 4, 3], [1, 8, 9, 5, 6, 2, 4, 3, 7]],
    ["Owner", "owner", [1, 2, 7, 8, 6, 4, 3, 9, 5], [9, 5, 8, 6, 4, 3, 1, 2, 7]],
    ["Stage", "stage", [1, 2, 4, 3, 5, 6, 8, 7, 9], [9, 8, 7, 6, 5, 2, 4, 3, 1]],
  ];
  test.each(SORTS)("clicking “%s” sorts by it, and again the other way, with aria-sort on the header", async (name, key, up, down) => {
    const user = userEvent.setup();
    show();
    const header = () => table().getByRole("columnheader", { name });
    await user.click(within(header()).getByRole("button", { name }));
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    expect(nav.query).toBe(`sort=${key}`);
    expect(numbersShown()).toEqual(up);
    await user.click(within(header()).getByRole("button", { name }));
    expect(header().getAttribute("aria-sort")).toBe("descending");
    expect(nav.query).toBe(`sort=${key}&dir=desc`);
    expect(numbersShown()).toEqual(down);
    // Only one header orders the table at a time.
    expect(
      table()
        .getAllByRole("columnheader")
        .filter((h) => h.getAttribute("aria-sort") !== "none" && h.getAttribute("aria-sort") !== null),
    ).toHaveLength(1);
  });

  test("clicking “Last activity” sorts by it", async () => {
    const user = userEvent.setup();
    const rows = [
      pr(21, { updatedAt: ago(3 * HOUR) }),
      pr(22, { updatedAt: ago(HOUR) }),
      pr(23, { updatedAt: ago(2 * HOUR) }),
    ];
    show({ list: { readAt: NOW, rows } });
    const header = () => table().getByRole("columnheader", { name: "Last activity" });
    await user.click(within(header()).getByRole("button"));
    expect(numbersShown()).toEqual([21, 23, 22]);
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    await user.click(within(header()).getByRole("button"));
    expect(numbersShown()).toEqual([22, 23, 21]);
    expect(nav.query).toBe("sort=activity&dir=desc");
  });

  test("the sort is done here, in the browser: no query is asked again with an order", async () => {
    const user = userEvent.setup();
    show();
    const { useQuery } = await import("convex/react");
    const before = vi.mocked(useQuery).mock.calls.map((call) => JSON.stringify(call[1] ?? null));
    await user.click(table().getByRole("button", { name: "Opened" }));
    const after = vi.mocked(useQuery).mock.calls.map((call) => JSON.stringify(call[1] ?? null));
    expect(new Set(after)).toEqual(new Set(before));
  });
});

describe("all pull requests: the filters", () => {
  const filters = () => within(region("All pull requests").getByRole("group", { name: "Filters" }));

  test("by owner", async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(filters().getByLabelText("Owner"), "made-up-cy");
    expect(nav.query).toBe("owner=made-up-cy");
    expect(numbersShown().sort()).toEqual([5, 9]);
    expect(region("All pull requests").getByText(/^Showing 2 of 9\./)).toBeTruthy();
  });

  test("by repository", async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(filters().getByLabelText("Repository"), API);
    expect(nav.query).toBe("repo=Made-Up-Org%2Fstartup-api");
    expect(numbersShown()).toEqual([7]);
  });

  test("by stage, closed among them", async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(filters().getByLabelText("Stage"), "waiting_for_review");
    expect(nav.query).toBe("stage=waiting_for_review");
    expect(numbersShown()).toEqual([2, 4, 3]);
    await user.selectOptions(filters().getByLabelText("Stage"), "closed");
    expect(numbersShown()).toEqual([9]);
  });

  test("stuck only", async () => {
    const user = userEvent.setup();
    show();
    await user.click(filters().getByRole("checkbox", { name: "Stuck only" }));
    expect(nav.query).toBe("stuck=1");
    expect(numbersShown()).toEqual([1, 6, 2, 4]);
  });

  test("a date range on Opened, and the same on Last activity", async () => {
    const user = userEvent.setup();
    show();
    const from = filters().getByLabelText("From") as HTMLInputElement;
    const to = filters().getByLabelText("To") as HTMLInputElement;
    expect([from.type, to.type]).toEqual(["date", "date"]);
    await user.type(from, "2026-10-05");
    await user.type(to, "2026-10-06");
    expect(nav.query).toBe("from=2026-10-05&to=2026-10-06");
    expect(numbersShown().sort()).toEqual([5, 8, 9]);

    await user.selectOptions(filters().getByLabelText("Date"), "activity");
    expect(nav.query).toBe("by=activity&from=2026-10-05&to=2026-10-06");
    // Only the draft was last touched then.
    expect(numbersShown()).toEqual([1]);
  });

  test("filters together, with a sort, and “Clear filters” puts everything back but the sort", async () => {
    const user = userEvent.setup();
    show({ query: "owner=made-up-ben&stuck=1&sort=opened&dir=desc" });
    expect(numbersShown()).toEqual([4, 6]);
    await user.click(filters().getByRole("button", { name: "Clear filters" }));
    expect(nav.query).toBe("sort=opened&dir=desc");
    expect(numbersShown()).toHaveLength(9);
    expect(filters().queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  test("the address is the view: opening it shows the same filters, sort and rows", () => {
    show({ query: "repo=Made-Up-Org%2Fstartup-app&stage=waiting_for_review&stuck=1&by=activity&from=2026-10-01&to=2026-10-14&sort=age&dir=desc" });
    expect((filters().getByLabelText("Repository") as HTMLSelectElement).value).toBe("Made-Up-Org/startup-app");
    expect((filters().getByLabelText("Stage") as HTMLSelectElement).value).toBe("waiting_for_review");
    expect((filters().getByRole("checkbox", { name: "Stuck only" }) as HTMLInputElement).checked).toBe(true);
    expect((filters().getByLabelText("Date") as HTMLSelectElement).value).toBe("activity");
    expect((filters().getByLabelText("From") as HTMLInputElement).value).toBe("2026-10-01");
    expect((filters().getByLabelText("To") as HTMLInputElement).value).toBe("2026-10-14");
    expect(table().getByRole("columnheader", { name: "Age in stage" }).getAttribute("aria-sort")).toBe("descending");
    expect(numbersShown()).toEqual([2, 4]);
  });

  test("a filter changes the address without leaving the page or scrolling it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(filters().getByRole("checkbox", { name: "Stuck only" }));
    expect(nav.replaced).toEqual(["/engineering?stuck=1"]);
  });

  test("an address that makes no sense is the plain page", () => {
    show({ query: "owner=%3Cscript%3E&stage=shipped&sort=title&from=never" });
    expect(numbersShown()).toHaveLength(9);
    expect(document.querySelector("script")).toBeNull();
  });

  test("an owner in the address whom nobody here is: no rows, said plainly, and a way back", () => {
    show({ query: "owner=nobody-here" });
    expect(region("All pull requests").getByText("No pull request matches these filters.")).toBeTruthy();
    expect(region("All pull requests").queryByRole("table")).toBeNull();
    expect(filters().getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});

describe("a failed GitHub read", () => {
  test("is said at the top of the page, and no other source's failure is", () => {
    show();
    cleanup();
    convex.setQuery(api.metrics.scorecard, {
      tiles: TILES,
      sources: {
        github: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "invalid_records: records.3.url" },
        posthog: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "PostHog answered 500 for visits." },
      },
    });
    render(<EngineeringPage />);
    const attention = within(screen.getByRole("region", { name: "Needs attention" }));
    expect(attention.getByText("GitHub: last run failed")).toBeTruthy();
    expect(screen.queryByText("PostHog answered 500 for visits.")).toBeNull();
  });

  test("with nothing failed there is no such block", () => {
    show();
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  });
});

describe("states", () => {
  test("before the first read: one sentence per block, and nothing shown as 0", () => {
    show({ list: { readAt: null, rows: [] }, tiles: [] });
    expect(region("Stuck and piling up").getByText("What is stuck arrives with the daily GitHub read.")).toBeTruthy();
    expect(region("The flow").getByText("The flow arrives with the daily GitHub read.")).toBeTruthy();
    expect(region("By owner").getByText("Who owns what arrives with the daily GitHub read.")).toBeTruthy();
    expect(region("All pull requests").getByText("The pull requests arrive with the daily GitHub read.")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText(/No pull request is stuck/)).toBeNull();
    expect(screen.queryAllByTestId("flow-band")).toEqual([]);
    expect(region("The flow").queryAllByRole("group")).toEqual([]);
  });

  test("read, and this company has none: the flow stands with real zeros, and the rest say so", () => {
    show({ list: { readAt: NOW, rows: [ROWS[10]!] } });
    expect(region("The flow").getAllByRole("group")).toHaveLength(5);
    expect(region("Stuck and piling up").getByText("No pull request is stuck.")).toBeTruthy();
    expect(region("By owner").getByText("Nobody has an open pull request.")).toBeTruthy();
    expect(region("All pull requests").getByText("No pull request is open, and none was merged or closed in the last 14 days.")).toBeTruthy();
  });

  // The time itself is the header's (PageFreshness), said once: the note
  // says what it means for the stages, not when.
  test("a list read today says nothing about its age; an old one says the stages are as of then", () => {
    show();
    expect(screen.queryByText(/Out of date/)).toBeNull();
    cleanup();
    show({ list: { readAt: NOW - 6 * DAY, rows: ROWS } });
    expect(
      screen.getByText("Out of date: stages and ages below are as of GitHub's last read, given above."),
    ).toBeTruthy();
  });

  test("what is read and what is not, and the thresholds, said once", () => {
    show();
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Read from GitHub once a day: a pull request's title, who opened it, who is asked to review, its dates, review decision and check result. Never code, a diff, a description, a comment or a commit message.",
    );
    expect(text).toContain(
      "Stuck means: waiting more than 3 days for a review, changes requested with no update for more than 3 days, approved and unmerged for more than 2 days, a draft untouched for more than 7 days, or failing checks on one that is not a draft.",
    );
  });
});
