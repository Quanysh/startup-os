// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { EngineeringList, RepoRow } from "@/lib/metrics/engineering";
import type { Tile } from "@/lib/metrics/scorecard";
import { EngineeringFigures } from "./figures-section";

afterEach(cleanup);

// Wednesday, October 14: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 24 * 60 * 60 * 1000;
const THIS_WEEK = "2026-10-12";
const WEEKS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];

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
const weekly = (key: string, scope: string, values: number[]) =>
  tile(key, scope, WEEKS.slice(-values.length).map((week, i) => [week, values[i]!]));
const level = (key: string, scope: string, value: number, week = THIS_WEEK) =>
  tile(key, scope, [[week, value]]);

const repo = (name: string, over: Partial<RepoRow> = {}): RepoRow => ({
  repoId: `Made-Up-Org/${name}`,
  org: "Made-Up-Org",
  name,
  company: "us",
  mergedLastWeek: 0,
  open: 0,
  stuck: 0,
  main: "passing",
  pushedAt: "2026-10-13",
  ...over,
});

// Startup's figures as a good daily read leaves them, with Globex's beside
// them so a test can see that only the company asked for is shown.
const TILES: Tile[] = [
  weekly("prs_merged", "us", [3, 8, 6, 9, 12]),
  weekly("prs_opened", "us", [4, 9, 7, 9, 14]),
  level("prs_open", "us", 5),
  level("prs_stuck", "us", 1),
  level("repos_failing", "us", 1),
  level("repos_tracked", "us", 3),
  weekly("prs_merged", "kz", [1, 1, 1, 1, 77]),
  level("prs_open", "kz", 88),
  level("prs_stuck", "kz", 0),
  level("repos_failing", "kz", 0),
  level("repos_tracked", "kz", 2),
];
const LIST: EngineeringList = {
  readAt: NOW - 3 * 60 * 60 * 1000,
  rows: [
    repo("startup-insights", { mergedLastWeek: 9, open: 3, stuck: 1 }),
    repo("startup-os", { mergedLastWeek: 3, open: 2, main: "failing", pushedAt: "2026-10-01" }),
    repo("startup-docs", { main: "none", pushedAt: "2026-08-30" }),
    repo("globex-app", { company: "kz", mergedLastWeek: 77, open: 88 }),
    repo("globex-api", { company: "kz", main: "pending" }),
  ],
};

const show = (
  props: Partial<Parameters<typeof EngineeringFigures>[0]> = {},
) => render(<EngineeringFigures tiles={TILES} now={NOW} lists={LIST} company="us" stuck={1} {...props} />);
const section = () => within(screen.getByRole("region", { name: "Figures and repositories" }));
const article = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const chips = (scope: ReturnType<typeof within>) =>
  [...scope.queryAllByText(/.+/, { selector: '[data-slot="status-chip"]' })].map((chip) => [
    chip.textContent,
    chip.getAttribute("data-tone"),
  ]);
const chartNames = () => screen.queryAllByRole("group").map((chart) => chart.getAttribute("aria-label"));
const CAPTION =
  "Read from GitHub once a day. These figures count pull requests by their states and dates, and repositories by their latest build: none of them is a number per person. Pull requests opened by bots are left out, and only repositories pushed to in the last 90 days are listed. Weeks run Monday to Sunday, UTC.";

describe("Engineering: before anything has arrived", () => {
  test("while the repository list loads: placeholders and no number", () => {
    const { container } = show({ lists: undefined });
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("12")).toBeNull();
  });

  test("nothing read yet: one sentence, and nothing shown as 0", () => {
    const empty = ["prs_merged", "prs_opened", "prs_open", "prs_stuck", "repos_failing", "repos_tracked"].map(
      (key) => tile(key, "us"),
    );
    show({ tiles: empty, lists: { readAt: null, rows: [] } });
    expect(
      section().getByText("Pull requests and build results arrive with the daily GitHub read."),
    ).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByRole("article")).toEqual([]);
    expect(chartNames()).toEqual([]);
    // What counts is still said.
    expect(section().getByText(CAPTION)).toBeTruthy();
  });

  test("no tiles sent at all (a build that does not know them) is the same sentence", () => {
    show({ tiles: [], lists: { readAt: null, rows: [] } });
    expect(
      section().getByText("Pull requests and build results arrive with the daily GitHub read."),
    ).toBeTruthy();
  });
});

describe("Engineering: the four figures", () => {
  test("merged last week, with what was opened, and the weeks as a chart", () => {
    show();
    const merged = article("Merged last week");
    expect(merged.getByText("12")).toBeTruthy();
    expect(merged.getByText("The week of Oct 5.")).toBeTruthy();
    expect(merged.getByText("14 opened that week.")).toBeTruthy();
    expect(chartNames()).toEqual(["Pull requests merged by week"]);
  });

  test("open, drafts included", () => {
    show();
    const open = article("Open");
    expect(open.getByText("5")).toBeTruthy();
    expect(open.getByText("Open pull requests, drafts included.")).toBeTruthy();
    expect(chips(open)).toEqual([]);
  });

  test("stuck is the list's count by the five rules, not the stored figure, and leads to them", () => {
    // The stored prs_stuck figure (1) is not shown: the count passed in is.
    show({ stuck: 4 });
    const stuck = article("Stuck");
    expect(stuck.getByText("4")).toBeTruthy();
    expect(chips(stuck)).toEqual([["Stuck", "danger"]]);
    expect(stuck.getByRole("link", { name: "4 pull requests stuck" }).getAttribute("href")).toBe(
      "/engineering?stuck=1",
    );
    expect(screen.queryByRole("heading", { name: /Waiting more than/ })).toBeNull();
  });

  test("stuck at zero is a real zero, with no alarm", () => {
    show({ stuck: 0 });
    const stuck = article("Stuck");
    expect(stuck.getByText("0")).toBeTruthy();
    expect(chips(stuck)).toEqual([]);
    expect(stuck.getByText("No pull request is stuck.")).toBeTruthy();
  });

  test("a failing main wears the danger tone and says of how many", () => {
    show();
    const failing = article("Failing main");
    expect(failing.getByText("1")).toBeTruthy();
    expect(chips(failing)).toEqual([["Failing", "danger"]]);
    expect(failing.getByText("Of 3 repositories tracked.")).toBeTruthy();
  });

  const noneFailing = (rows: RepoRow[]) =>
    show({
      tiles: [...TILES.filter((t) => t.key !== "repos_failing"), level("repos_failing", "us", 0)],
      lists: { readAt: NOW, rows },
    });

  test("none failing and every tracked main passing: the success tone, 'All passing'", () => {
    noneFailing([repo("startup-insights"), repo("startup-os"), repo("startup-docs")]);
    const failing = article("Failing main");
    expect(failing.getByText("0")).toBeTruthy();
    expect(chips(failing)).toEqual([["All passing", "success"]]);
    expect(failing.getByText("Of 3 repositories tracked.")).toBeTruthy();
  });

  test("none failing but some with no checks or still running is not 'all passing'", () => {
    noneFailing([repo("startup-insights"), repo("startup-os", { main: "pending" }), repo("startup-docs", { main: "none" })]);
    const failing = article("Failing main");
    expect(chips(failing)).toEqual([["None failing", "success"]]);
    expect(failing.getByText("Of 3 repositories tracked; 2 are running or have no checks.")).toBeTruthy();
    expect(failing.queryByText("All passing")).toBeNull();
  });

  test("none failing with the repository list not read yet: no claim that all pass", () => {
    show({
      tiles: [...TILES.filter((t) => t.key !== "repos_failing"), level("repos_failing", "us", 0)],
      lists: { readAt: null, rows: [] },
    });
    expect(chips(article("Failing main"))).toEqual([["None failing", "success"]]);
  });

  test("a figure that has not arrived is 'No value yet', never 0", () => {
    show({ tiles: TILES.filter((t) => t.key === "prs_merged" && t.scope === "us"), stuck: null });
    for (const label of ["Open", "Stuck", "Failing main"]) {
      const scope = article(label);
      expect(scope.getByText("No value yet"), label).toBeTruthy();
      expect(scope.getByText("Arrives with the daily GitHub read."), label).toBeTruthy();
      expect(scope.queryByText("0"), label).toBeNull();
      expect(chips(scope), label).toEqual([]);
    }
    expect(article("Merged last week").getByText("12")).toBeTruthy();
  });

  test("no count for last week yet: no value, and the newest week is named", () => {
    show({
      tiles: [
        ...TILES.filter((t) => t.key !== "prs_merged"),
        tile("prs_merged", "us", [["2026-09-14", 8], ["2026-09-21", 6], ["2026-09-28", 9]]),
      ],
    });
    const merged = article("Merged last week");
    expect(merged.getByText("No value yet")).toBeTruthy();
    expect(
      merged.getByText("No count for last week yet: the newest is for the week of Sep 28."),
    ).toBeTruthy();
    expect(merged.queryByText("9")).toBeNull();
  });

  test("a week with nothing merged is a real 0", () => {
    show({
      tiles: [...TILES.filter((t) => t.key !== "prs_merged"), weekly("prs_merged", "us", [3, 8, 6, 9, 0])],
    });
    expect(article("Merged last week").getByText("0")).toBeTruthy();
  });

  test("the chart needs three finished weeks, one above zero: fewer is the figure alone", () => {
    const withMerged = (values: number[]) => [
      ...TILES.filter((t) => t.key !== "prs_merged"),
      weekly("prs_merged", "us", values),
    ];
    const { unmount } = show({ tiles: withMerged([9, 12]) });
    expect(chartNames()).toEqual([]);
    expect(article("Merged last week").getByText("12")).toBeTruthy();
    unmount();
    const zeros = show({ tiles: withMerged([0, 0, 0]) });
    expect(chartNames()).toEqual([]);
    zeros.unmount();
    show({ tiles: withMerged([0, 2, 0]) });
    expect(chartNames()).toEqual(["Pull requests merged by week"]);
  });

  test("the week in progress is never a bar or last week's figure", () => {
    show({
      tiles: [
        ...TILES.filter((t) => t.key !== "prs_merged"),
        tile("prs_merged", "us", [...WEEKS.map((w, i): [string, number] => [w, i + 1]), [THIS_WEEK, 999]]),
      ],
    });
    expect(article("Merged last week").getByText("5")).toBeTruthy();
    expect(screen.queryByText("999")).toBeNull();
  });

  test("levels last read in an old week say so, once, and keep their figures", () => {
    const old = "2026-09-21";
    show({
      tiles: [
        ...TILES.filter((t) => !["prs_open", "prs_stuck", "repos_failing", "repos_tracked"].includes(t.key)),
        level("prs_open", "us", 5, old),
        level("prs_stuck", "us", 1, old),
        level("repos_failing", "us", 0, old),
        level("repos_tracked", "us", 3, old),
      ],
    });
    expect(
      section().getAllByText("Out of date: GitHub was last read in the week of Sep 21."),
    ).toHaveLength(1);
    expect(article("Open").getByText("5")).toBeTruthy();
    // An old reading makes no claim about today: no success chip.
    expect(chips(article("Failing main"))).toEqual([]);
  });
});

describe("Engineering: the repositories", () => {
  const table = () => section().getByRole("table", { name: "Repositories" });
  const rows = () => within(table()).getAllByRole("row");
  const cells = (row: HTMLElement) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent);

  test("the columns", () => {
    show();
    expect(
      within(rows()[0]!)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Repository", "Merged last week", "Open", "Waiting", "Main", "Last push"]);
  });

  test("only the company in view's repositories, the ones that need a look first", () => {
    show();
    expect(rows().slice(1).map(cells)).toEqual([
      ["startup-os", "3", "2", "0", "Failing", "Oct 1"],
      ["startup-insights", "9", "3", "1Waiting", "Passing", "Oct 13"],
      ["startup-docs", "0", "0", "0", "No checks", "Aug 30"],
    ]);
    expect(screen.queryByText("globex-app")).toBeNull();
    expect(screen.queryByText("88")).toBeNull();
    expect(screen.queryByText("77")).toBeNull();
  });

  test("the other company's view shows its own", () => {
    show({ company: "kz" });
    expect(rows().slice(1).map((row) => cells(row)[0])).toEqual(["globex-api", "globex-app"]);
    expect(article("Open").getByText("88")).toBeTruthy();
    expect(screen.queryByText("startup-insights")).toBeNull();
  });

  test("the main branch's chip, by state", () => {
    show({
      lists: {
        readAt: NOW,
        rows: [
          repo("a-failing", { main: "failing" }),
          repo("b-passing"),
          repo("c-running", { main: "pending", pushedAt: "2026-10-12" }),
          repo("d-none", { main: "none", pushedAt: "2026-10-11" }),
        ],
      },
    });
    expect(chips(within(table()))).toEqual([
      ["Failing", "danger"],
      ["Passing", "success"],
      ["Running", "info"],
      ["No checks", "neutral"],
    ]);
  });

  test("a failing main or a waiting pull request tints the row; the rest are plain", () => {
    show();
    const [, failing, waiting, quiet] = rows();
    expect(failing!.getAttribute("data-tone")).toBe("danger");
    expect(waiting!.getAttribute("data-tone")).toBe("warning");
    expect(quiet!.getAttribute("data-tone")).toBeNull();
    // The tint is never the only sign: the cell says why.
    expect(chips(within(waiting!))).toContainEqual(["Waiting", "warning"]);
  });

  test("a push from another year carries its year", () => {
    show({ lists: { readAt: NOW, rows: [repo("startup-old", { pushedAt: "2025-12-30" })] } });
    expect(cells(rows()[1]!).at(-1)).toBe("Dec 30, 2025");
  });

  test("the list not read yet, with figures already in: one sentence, no empty table", () => {
    show({ lists: { readAt: null, rows: [] } });
    expect(section().getByText("The repository list arrives with the daily GitHub read.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Repositories" })).toBeNull();
    expect(article("Open").getByText("5")).toBeTruthy();
  });

  test("the list read, with none of this company's in it", () => {
    show({ lists: { readAt: NOW, rows: [repo("globex-app", { company: "kz" })] } });
    expect(
      section().getByText("No repository of Startup's was pushed to in the last 90 days."),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Repositories" })).toBeNull();
  });

  test("a list last read more than four days ago says how long ago", () => {
    show({ lists: { ...LIST, readAt: NOW - 6 * DAY - 1000 } });
    expect(
      section().getByText("Out of date: the repository list was last read 6 days ago."),
    ).toBeTruthy();
    expect(rows()).toHaveLength(4);
  });

  test("a list read today says nothing about its age", () => {
    show();
    expect(screen.queryByText(/Out of date/)).toBeNull();
  });
});

describe("Engineering: what it says about itself", () => {
  test("the caption: what counts, what is left out, and how often it is read", () => {
    show();
    expect(section().getByText(CAPTION)).toBeTruthy();
  });

  test("no figure about a person, a line of code, a commit or a comment", () => {
    show();
    const text = screen.getByRole("region", { name: "Figures and repositories" }).textContent ?? "";
    for (const word of ["author", "reviewer", "lines", "commits", "comments", "leaderboard", "by person"]) {
      expect(text.toLowerCase(), word).not.toContain(word);
    }
  });

  test("with more than one company on the page, each section says whose it is", () => {
    render(
      <>
        <EngineeringFigures tiles={TILES} now={NOW} lists={LIST} company="us" stuck={0} named />
        <EngineeringFigures tiles={TILES} now={NOW} lists={LIST} company="kz" stuck={0} named />
      </>,
    );
    expect(screen.getByRole("region", { name: "Figures and repositories · Startup" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Figures and repositories · Globex" })).toBeTruthy();
  });
});
