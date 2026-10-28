import { describe, expect, test } from "vitest";
import {
  engineeringAttention,
  engineeringLine,
  levelOf,
  mainStatus,
  repoTone,
  sortRepos,
  type RepoRow,
} from "./engineering";
import type { PullRow } from "@/lib/engineering/flow";
import { sortAttention, type Tile } from "./scorecard";

// Wednesday, October 14: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 24 * 60 * 60 * 1000;

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
const THIS_WEEK = "2026-10-12";

describe("levelOf: a level as last read", () => {
  test("the newest week's figure, current while that week is the one in progress", () => {
    const tiles = [tile("prs_stuck", "us", [["2026-10-05", 4], [THIS_WEEK, 2]])];
    expect(levelOf(tiles, "prs_stuck", "us", NOW)).toEqual({
      value: 2,
      periodStart: THIS_WEEK,
      stale: false,
    });
  });

  test("no tile, or a tile with nothing in it, is no level: never a zero", () => {
    expect(levelOf([], "prs_stuck", "us", NOW)).toBeNull();
    expect(levelOf([tile("prs_stuck", "us")], "prs_stuck", "us", NOW)).toBeNull();
    expect(levelOf([tile("prs_stuck", "kz", [[THIS_WEEK, 2]])], "prs_stuck", "us", NOW)).toBeNull();
  });

  test("a level last read in a week that ended more than four days ago is out of date", () => {
    const tiles = [tile("prs_stuck", "us", [["2026-10-05", 4]])];
    // That week ended on Monday the 12th; four days on is Friday the 16th.
    expect(levelOf(tiles, "prs_stuck", "us", Date.UTC(2026, 9, 16, 0))!.stale).toBe(false);
    expect(levelOf(tiles, "prs_stuck", "us", Date.UTC(2026, 9, 16, 0) + 1)!.stale).toBe(true);
  });
});

// A pull request as `workTools.pullRequests` sends it; made up.
const pull = (over: Partial<PullRow> = {}): PullRow => ({
  repoId: "Made-Up-Org/startup-app",
  number: 1,
  company: "us",
  title: "Made-up change",
  url: "https://github.com/Made-Up-Org/startup-app/pull/1",
  authorLogin: "made-up-ada",
  draft: false,
  state: "open",
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
  reviewDecision: "none",
  reviewersRequested: 0,
  reviewers: [],
  checks: "passing",
  ...over,
});
/** N pull requests of a company, each stuck by the "waiting for review" rule. */
const stuckOnes = (n: number, company: "us" | "kz" = "us") =>
  Array.from({ length: n }, (_, i) => pull({ number: i + 1, company, createdAt: NOW - 5 * DAY }));
const pulls = (rows: PullRow[], companies: ("us" | "kz")[] = ["us"], readAt: number | null = NOW) => ({
  companies,
  readAt,
  rows,
});

describe("engineeringAttention", () => {
  const items = (tiles: Tile[], list: ReturnType<typeof pulls> | null = null, now = NOW) =>
    engineeringAttention(tiles, list, now);

  test("stuck pull requests: one line, counted from the list by the five rules, leading to the stuck ones", () => {
    expect(items([], pulls(stuckOnes(4)))).toEqual([
      {
        id: "engineering:stuck:us",
        severity: "stale",
        title: "4 pull requests stuck",
        detail: "Startup: held up by one of the Engineering page's five rules.",
        href: "/engineering?stuck=1",
      },
    ]);
  });

  test("the stored prs_stuck figure no longer raises a line: the list is the one count", () => {
    expect(items([tile("prs_stuck", "us", [[THIS_WEEK, 4]])])).toEqual([]);
    expect(items([tile("prs_stuck", "us", [[THIS_WEEK, 4]])], pulls([pull()]))).toEqual([]);
  });

  test("a failing main branch: one line, and the more severe of the two", () => {
    expect(items([tile("repos_failing", "kz", [[THIS_WEEK, 2]])])).toEqual([
      {
        id: "engineering:failing:kz",
        severity: "risk",
        title: "2 repositories have a failing main branch",
        detail: "Globex: the latest build on the default branch failed.",
        href: "/engineering",
      },
    ]);
  });

  test("one of each reads as one", () => {
    const [failing, stuck] = sortAttention(
      items([tile("repos_failing", "us", [[THIS_WEEK, 1]])], pulls(stuckOnes(1))),
    );
    expect(failing!.title).toBe("1 repository has a failing main branch");
    expect(stuck!.title).toBe("1 pull request stuck");
  });

  test("a failing main is listed above stuck pull requests", () => {
    const sorted = sortAttention(items([tile("repos_failing", "us", [[THIS_WEEK, 1]])], pulls(stuckOnes(9))));
    expect(sorted.map((item) => item.id)).toEqual(["engineering:failing:us", "engineering:stuck:us"]);
  });

  test("zero is good news and says nothing", () => {
    expect(items([tile("repos_failing", "us", [[THIS_WEEK, 0]])], pulls([pull()]))).toEqual([]);
  });

  test("a list never read, or not asked for, produces no line: not 'none stuck'", () => {
    expect(items([])).toEqual([]);
    expect(items([], pulls(stuckOnes(3), ["us"], null))).toEqual([]);
    expect(items([tile("repos_failing", "us")])).toEqual([]);
  });

  test("a failing figure that is out of date produces no line: it is not known to be true today", () => {
    expect(items([tile("repos_failing", "us", [["2026-09-21", 3]])])).toEqual([]);
    expect(items([tile("repos_failing", "us", [["2026-10-05", 3]])])).toHaveLength(1);
    expect(items([tile("repos_failing", "us", [["2026-10-05", 3]])], null, NOW + 3 * DAY)).toEqual([]);
  });

  test("with both companies in view, each has its own line, by name; a company not in view has none", () => {
    const rows = [...stuckOnes(2, "us"), ...stuckOnes(5, "kz")];
    const both = items([], pulls(rows, ["us", "kz"]));
    expect(both.map((item) => [item.id, item.title, item.detail.split(":")[0]])).toEqual([
      ["engineering:stuck:us", "2 pull requests stuck", "Startup"],
      ["engineering:stuck:kz", "5 pull requests stuck", "Globex"],
    ]);
    expect(items([], pulls(rows, ["kz"])).map((item) => item.id)).toEqual(["engineering:stuck:kz"]);
  });

  test("no other figure raises a line: not open pull requests, not a quiet week of merges", () => {
    expect(
      items([
        tile("prs_open", "us", [[THIS_WEEK, 40]]),
        tile("prs_merged", "us", [["2026-10-05", 0]]),
        tile("prs_opened", "us", [["2026-10-05", 0]]),
        tile("repos_tracked", "us", [[THIS_WEEK, 12]]),
      ]),
    ).toEqual([]);
  });

  test("a scope that is not a company's is passed over", () => {
    expect(items([tile("repos_failing", "startup_insights", [[THIS_WEEK, 3]])])).toEqual([]);
  });
});

const row = (name: string, over: Partial<RepoRow> = {}): RepoRow => ({
  repoId: `Made-Up-Org/${name}`,
  org: "Made-Up-Org",
  name,
  company: "us",
  mergedLastWeek: 0,
  open: 0,
  stuck: 0,
  main: "passing",
  pushedAt: "2026-10-10",
  ...over,
});

describe("a repository's row", () => {
  test.each([
    ["passing", "Passing", "success"],
    ["failing", "Failing", "danger"],
    ["pending", "Running", "info"],
    ["none", "No checks", "neutral"],
  ] as const)("main %s reads %s, in the %s tone", (main, label, tone) => {
    expect(mainStatus(main)).toEqual({ label, tone });
  });

  test("the tint: danger for a failing main, warning for waiting pull requests, else none", () => {
    expect(repoTone(row("a", { main: "failing" }))).toBe("danger");
    expect(repoTone(row("a", { main: "failing", open: 2, stuck: 2 }))).toBe("danger");
    expect(repoTone(row("a", { open: 2, stuck: 1 }))).toBe("warning");
    expect(repoTone(row("a", { open: 9 }))).toBeUndefined();
    expect(repoTone(row("a", { main: "pending" }))).toBeUndefined();
    expect(repoTone(row("a", { main: "none" }))).toBeUndefined();
  });

  test("the order: failing first, then the most waiting, then the newest push, then by name", () => {
    const sorted = sortRepos([
      row("quiet", { pushedAt: "2026-09-01" }),
      row("busy", { pushedAt: "2026-10-13" }),
      row("also-busy", { pushedAt: "2026-10-13" }),
      row("waiting-one", { open: 3, stuck: 1 }),
      row("waiting-three", { open: 3, stuck: 3, pushedAt: "2026-08-01" }),
      row("broken", { main: "failing", pushedAt: "2026-07-20" }),
    ]);
    expect(sorted.map((r) => r.name)).toEqual([
      "broken",
      "waiting-three",
      "waiting-one",
      "also-busy",
      "busy",
      "quiet",
    ]);
  });
});

describe("engineeringLine: the dashboard's one line", () => {
  const merged = (scope: string, value: number, week = "2026-10-05") => tile("prs_merged", scope, [[week, value]]);

  test("merged last week and stuck, in one sentence; stuck is the list's count", () => {
    expect(engineeringLine([merged("us", 12)], 2, "us", NOW)).toBe(
      "12 pull requests merged last week, 2 pull requests stuck.",
    );
  });

  test("one of each, and none stuck", () => {
    expect(engineeringLine([merged("us", 1)], 1, "us", NOW)).toBe(
      "1 pull request merged last week, 1 pull request stuck.",
    );
    expect(engineeringLine([merged("us", 0)], 0, "us", NOW)).toBe(
      "0 pull requests merged last week, 0 pull requests stuck.",
    );
  });

  test("only what is known is said: a missing half is left out, never a zero", () => {
    expect(engineeringLine([merged("us", 12)], null, "us", NOW)).toBe("12 pull requests merged last week.");
    expect(engineeringLine([], 2, "us", NOW)).toBe("2 pull requests stuck.");
    // The stored prs_stuck figure is not the count.
    expect(engineeringLine([tile("prs_stuck", "us", [[THIS_WEEK, 2]])], null, "us", NOW)).toBeNull();
  });

  test("nothing known is no line at all", () => {
    expect(engineeringLine([], null, "us", NOW)).toBeNull();
    expect(engineeringLine([tile("prs_merged", "us")], null, "us", NOW)).toBeNull();
    // The other company's figures are not this one's.
    expect(engineeringLine([merged("kz", 12)], null, "us", NOW)).toBeNull();
  });

  test("an older week is not last week", () => {
    expect(engineeringLine([merged("us", 12, "2026-09-28")], null, "us", NOW)).toBeNull();
    // The week in progress is never "last week".
    expect(engineeringLine([merged("us", 12, THIS_WEEK)], null, "us", NOW)).toBeNull();
  });
});
