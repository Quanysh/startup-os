import { describe, expect, test } from "vitest";
import type { PullRow } from "./flow";
import {
  NO_FILTERS,
  SORT_KEYS,
  ariaSort,
  columnsOf,
  filterItems,
  isFiltered,
  nextSort,
  ownerOf,
  ownerRows,
  pileUp,
  placeAll,
  readView,
  sortItems,
  stuckOnes,
  writeView,
  type Filters,
  type Sort,
} from "./view";

// Every pull request, repository and person here is made up.
const NOW = Date.UTC(2026, 9, 14, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

let next = 0;
const pr = (over: Partial<PullRow> = {}): PullRow => {
  next += 1;
  const number = over.number ?? next;
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

// A small team's week. Numbers are fixed so the assertions can name them.
const ROWS: PullRow[] = [
  pr({ number: 1, draft: true, updatedAt: ago(9 * DAY), createdAt: ago(20 * DAY) }), // Ada, draft, stuck
  pr({ number: 2, createdAt: ago(5 * DAY) }), // Ada, waiting, stuck
  pr({ number: 3, createdAt: ago(DAY), ...ben }), // Ben, waiting
  pr({ number: 4, createdAt: ago(2 * DAY), ...ben, checks: "failing" }), // Ben, waiting, stuck (checks)
  pr({ number: 5, reviewDecision: "changes_requested", createdAt: ago(8 * DAY), lastReviewAt: ago(2 * DAY), ...cy }), // Cy
  pr({ number: 6, reviewDecision: "approved", createdAt: ago(6 * DAY), updatedAt: ago(3 * DAY), ...ben }), // Ben, approved, stuck
  pr({ number: 7, state: "merged", createdAt: ago(4 * DAY), mergedAt: ago(DAY), repoId: "Made-Up-Org/startup-api" }),
  pr({ number: 8, state: "merged", createdAt: ago(9 * DAY), mergedAt: ago(3 * DAY), ...ben }),
  pr({ number: 9, state: "closed", createdAt: ago(9 * DAY), closedAt: ago(2 * DAY), ...cy }),
  pr({ number: 10, state: "merged", createdAt: ago(40 * DAY), mergedAt: ago(30 * DAY) }), // long gone
];
const items = () => placeAll(ROWS, NOW);
const numbers = (list: { pull: PullRow }[]) => list.map((item) => item.pull.number);

describe("placeAll", () => {
  test("everything in a stage now; what left the flow long ago is dropped", () => {
    expect(numbers(items())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("ownerOf", () => {
  test("the name where GitHub has one, the login where it has none", () => {
    expect(ownerOf({ authorLogin: "Made-Up-Ada", authorName: "Made-up Ada" })).toEqual({
      key: "made-up-ada",
      name: "Made-up Ada",
      initials: "MA",
    });
    expect(ownerOf({ authorLogin: "made-up-cy" })).toEqual({ key: "made-up-cy", name: "made-up-cy", initials: "MU" });
    expect(ownerOf({ authorLogin: "solo" }).initials).toBe("SO");
  });

  test("a deleted account is said to be one, and all of them are one owner", () => {
    expect(ownerOf({})).toEqual({ key: "none", name: "Deleted account", initials: "?" });
  });

  test("a name with no login (a login in no usual form) still groups by the name", () => {
    expect(ownerOf({ authorName: "Made-up Dee" })).toMatchObject({ key: "name:made-up dee", initials: "MD" });
  });
});

describe("columnsOf: the flow", () => {
  test("five columns in the flow's order, each with its count, its stuck and its median age", () => {
    const columns = columnsOf(items());
    expect(columns.map((c) => [c.stage, c.items.length, c.stuck])).toEqual([
      ["draft", 1, 1],
      ["waiting_for_review", 3, 2],
      ["changes_requested", 1, 0],
      ["approved", 1, 1],
      ["merged", 2, 0],
    ]);
    // Waiting: 5 days, 2 days and 1 day: the middle one.
    expect(columns[1]!.medianMs).toBe(2 * DAY);
    expect(columns[4]!.medianMs).toBe(2 * DAY);
  });

  test("longest in the stage first; merged the most recent first", () => {
    const columns = columnsOf(items());
    expect(numbers(columns[1]!.items)).toEqual([2, 4, 3]);
    expect(numbers(columns[4]!.items)).toEqual([7, 8]);
  });

  test("an empty stage has no median: null, never zero", () => {
    const columns = columnsOf(placeAll([ROWS[1]!], NOW));
    expect(columns[0]).toEqual({ stage: "draft", items: [], stuck: 0, medianMs: null });
  });

  test("closed without merging is in no column", () => {
    expect(columnsOf(items()).flatMap((c) => numbers(c.items))).not.toContain(9);
  });
});

describe("stuckOnes", () => {
  test("how many are stuck, and the three stuck the longest", () => {
    const { count, oldest } = stuckOnes(items());
    expect(count).toBe(4);
    expect(numbers(oldest)).toEqual([1, 2, 6]);
  });

  test("none stuck", () => {
    expect(stuckOnes(placeAll([ROWS[2]!], NOW))).toEqual({ count: 0, oldest: [] });
  });
});

describe("pileUp: the fullest open stage against last week's pace", () => {
  test("the sentence, with the count, the stage and the pace", () => {
    expect(pileUp(items(), 3)).toBe(
      "3 waiting for review, about a week of work at last week's pace of 3 merged.",
    );
    expect(pileUp(items(), 6)).toBe(
      "3 waiting for review, less than a week of work at last week's pace of 6 merged.",
    );
    expect(pileUp(items(), 2)).toBe(
      "3 waiting for review, about 1.5 weeks of work at last week's pace of 2 merged.",
    );
    expect(pileUp(items(), 1)).toBe(
      "3 waiting for review, about 3 weeks of work at last week's pace of 1 merged.",
    );
  });

  test("none merged last week is said, not divided by", () => {
    expect(pileUp(items(), 0)).toBe("3 waiting for review, and none merged last week.");
  });

  test("without last week's figure there is no sentence, and none with nothing open", () => {
    expect(pileUp(items(), null)).toBeNull();
    expect(pileUp(placeAll([ROWS[6]!], NOW), 4)).toBeNull();
  });

  test("each stage has its own words; a tie goes to the one further along", () => {
    const only = (row: PullRow) => pileUp(placeAll([row], NOW), 0);
    expect(only(ROWS[0]!)).toBe("1 in draft, and none merged last week.");
    expect(only(ROWS[4]!)).toBe("1 with changes requested, and none merged last week.");
    expect(only(ROWS[5]!)).toBe("1 approved and not merged, and none merged last week.");
    expect(pileUp(placeAll([ROWS[0]!, ROWS[5]!], NOW), 0)).toBe(
      "1 approved and not merged, and none merged last week.",
    );
  });
});

describe("ownerRows: load and blockage, never output", () => {
  test("everyone with open work: open, by stage, stuck, and their oldest", () => {
    expect(
      ownerRows(items(), NOW).map((r) => [r.owner.name, r.open, r.waiting, r.changes, r.approved, r.stuck, r.oldestMs / DAY]),
    ).toEqual([
      // Sorted by stuck, then by the oldest open.
      ["Made-up Ada", 2, 1, 0, 0, 2, 20],
      ["Made-up Ben", 3, 2, 0, 1, 2, 6],
      ["made-up-cy", 1, 0, 1, 0, 0, 8],
    ]);
  });

  test("a row has no field for what somebody merged or closed", () => {
    for (const row of ownerRows(items(), NOW)) {
      expect(Object.keys(row).sort()).toEqual(
        ["approved", "changes", "oldestMs", "open", "owner", "stuck", "waiting"].sort(),
      );
    }
  });

  test("someone whose only work is merged or closed is not listed", () => {
    expect(ownerRows(placeAll([ROWS[6]!, ROWS[8]!], NOW), NOW)).toEqual([]);
  });
});

describe("sortItems", () => {
  const sorted = (sort: Sort) => numbers(sortItems(items(), sort));

  test("the page's own order: stuck first, then the oldest", () => {
    expect(sorted(null)).toEqual([1, 6, 2, 4, 8, 9, 5, 7, 3]);
  });

  test.each([
    ["opened", "asc", [1, 8, 9, 5, 6, 2, 7, 4, 3]],
    ["opened", "desc", [3, 4, 7, 2, 6, 5, 8, 9, 1]],
    // Ties (three days, two days, one day) go to the one opened first.
    ["age", "desc", [1, 2, 8, 6, 9, 5, 4, 7, 3]],
    ["stage", "asc", [1, 2, 4, 3, 5, 6, 8, 7, 9]],
    ["repo", "desc", [1, 8, 9, 5, 6, 2, 4, 3, 7]],
    ["owner", "asc", [1, 2, 7, 8, 6, 4, 3, 9, 5]],
  ] as const)("by %s %s", (key, dir, want) => {
    expect(sorted({ key, dir })).toEqual(want);
  });

  test("by last activity", () => {
    const rows = [
      pr({ number: 21, updatedAt: ago(3 * HOUR) }),
      pr({ number: 22, updatedAt: ago(HOUR) }),
      pr({ number: 23, updatedAt: ago(2 * HOUR) }),
    ];
    const list = placeAll(rows, NOW);
    expect(numbers(sortItems(list, { key: "activity", dir: "asc" }))).toEqual([21, 23, 22]);
    expect(numbers(sortItems(list, { key: "activity", dir: "desc" }))).toEqual([22, 23, 21]);
  });

  test("it does not reorder what it was given", () => {
    const list = items();
    sortItems(list, { key: "opened", dir: "desc" });
    expect(numbers(list)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a click on a header: ascending, then descending, then ascending again; another header starts ascending", () => {
    expect(nextSort(null, "opened")).toEqual({ key: "opened", dir: "asc" });
    expect(nextSort({ key: "opened", dir: "asc" }, "opened")).toEqual({ key: "opened", dir: "desc" });
    expect(nextSort({ key: "opened", dir: "desc" }, "opened")).toEqual({ key: "opened", dir: "asc" });
    expect(nextSort({ key: "opened", dir: "desc" }, "stage")).toEqual({ key: "stage", dir: "asc" });
  });

  test("aria-sort says which header orders the table, and which way", () => {
    expect(ariaSort(null, "opened")).toBe("none");
    expect(ariaSort({ key: "opened", dir: "asc" }, "opened")).toBe("ascending");
    expect(ariaSort({ key: "opened", dir: "desc" }, "opened")).toBe("descending");
    expect(ariaSort({ key: "opened", dir: "desc" }, "stage")).toBe("none");
    expect(SORT_KEYS).toEqual(["opened", "activity", "age", "repo", "owner", "stage"]);
  });
});

describe("filterItems", () => {
  const kept = (filters: Partial<Filters>) => numbers(filterItems(items(), { ...NO_FILTERS, ...filters }));

  test("no filter keeps everything", () => {
    expect(kept({})).toHaveLength(9);
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });

  test("by owner, by repository, by stage, stuck only, and together", () => {
    expect(kept({ owner: "made-up-ben" })).toEqual([3, 4, 6, 8]);
    expect(kept({ repo: "made-up-org/STARTUP-API" })).toEqual([7]);
    expect(kept({ stage: "waiting_for_review" })).toEqual([2, 3, 4]);
    expect(kept({ stage: "closed" })).toEqual([9]);
    expect(kept({ stuck: true })).toEqual([1, 2, 4, 6]);
    expect(kept({ owner: "made-up-ben", stuck: true, stage: "approved" })).toEqual([6]);
    expect(isFiltered({ ...NO_FILTERS, stuck: true })).toBe(true);
  });

  test("a range on the day it was opened, both ends included, in UTC days", () => {
    // Opened 9 days ago: 2026-10-05. Opened 8 days ago: 2026-10-06.
    expect(kept({ from: "2026-10-05", to: "2026-10-06" })).toEqual([5, 8, 9]);
    expect(kept({ from: "2026-10-13" })).toEqual([3]);
    expect(kept({ to: "2026-09-30" })).toEqual([1]);
  });

  test("the same range on the day of last activity", () => {
    // Number 1 was last touched 9 days ago, number 6 three days ago.
    expect(kept({ by: "activity", to: "2026-10-11" })).toEqual([1, 6]);
    expect(kept({ by: "activity", from: "2026-10-14" })).toEqual([2, 3, 4, 5, 7, 8, 9]);
  });
});

describe("the view in the address", () => {
  const round = (view: Parameters<typeof writeView>[0]) => readView(new URLSearchParams(writeView(view)));

  test("the plain page is the plain address", () => {
    expect(writeView({ filters: NO_FILTERS, sort: null })).toBe("");
    expect(readView(new URLSearchParams(""))).toEqual({ filters: NO_FILTERS, sort: null });
  });

  test("every filter and the sort survive a round trip", () => {
    const view = {
      filters: {
        owner: "made-up-ben",
        repo: "Made-Up-Org/startup-app",
        stage: "changes_requested",
        stuck: true,
        by: "activity",
        from: "2026-10-01",
        to: "2026-10-14",
      },
      sort: { key: "age", dir: "desc" },
    } as const;
    expect(writeView(view)).toBe(
      "owner=made-up-ben&repo=Made-Up-Org%2Fstartup-app&stage=changes_requested&stuck=1&by=activity&from=2026-10-01&to=2026-10-14&sort=age&dir=desc",
    );
    expect(round(view)).toEqual(view);
  });

  test.each(SORT_KEYS)("sorting by %s, each way", (key) => {
    for (const dir of ["asc", "desc"] as const) {
      expect(round({ filters: NO_FILTERS, sort: { key, dir } }).sort).toEqual({ key, dir });
    }
  });

  test("which date the range is about is kept even before a date is typed", () => {
    expect(round({ filters: { ...NO_FILTERS, by: "activity" }, sort: null }).filters.by).toBe("activity");
  });

  test("an address is anybody's typing: what it does not understand is left at the default", () => {
    const view = readView(
      new URLSearchParams(
        "owner=<script>alert(1)</script>&repo=javascript:alert(1)&stage=shipped&stuck=yes&by=mood&from=2026-02-30&to=tomorrow&sort=title&dir=sideways",
      ),
    );
    expect(view).toEqual({ filters: NO_FILTERS, sort: null });
    expect(readView(new URLSearchParams(`owner=${"x".repeat(200)}`)).filters.owner).toBeNull();
    expect(readView(new URLSearchParams("sort=opened&dir=sideways")).sort).toEqual({ key: "opened", dir: "asc" });
  });
});
