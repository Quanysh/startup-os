import { describe, expect, test } from "vitest";
import {
  PR_APPROVED_STUCK_AFTER_DAYS,
  PR_CLOSED_SHOWN_DAYS,
  PR_DRAFT_STUCK_AFTER_DAYS,
  PR_STUCK_AFTER_DAYS,
} from "@convex/lib/limits";
import {
  FLOW_STAGES,
  STAGES,
  STAGE_LABELS,
  ageWords,
  linkOf,
  medianAge,
  placeOf,
  sinceWords,
  stuckCount,
  type PullRow,
} from "./flow";

// Every pull request, repository and person here is made up.
const NOW = Date.UTC(2026, 9, 14, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

const pr = (over: Partial<PullRow> = {}): PullRow => ({
  repoId: "Made-Up-Org/startup-app",
  number: 1,
  company: "us",
  title: "Made-up change",
  url: "https://github.com/Made-Up-Org/startup-app/pull/1",
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
});
const stage = (over: Partial<PullRow>) => placeOf(pr(over), NOW)?.stage ?? null;
const reasons = (over: Partial<PullRow>) => placeOf(pr(over), NOW)!.stuck.map((s) => s.reason);

describe("the thresholds are the ones kept in one place", () => {
  test("three days, two days, seven days, and fourteen days of history", () => {
    expect([
      PR_STUCK_AFTER_DAYS,
      PR_APPROVED_STUCK_AFTER_DAYS,
      PR_DRAFT_STUCK_AFTER_DAYS,
      PR_CLOSED_SHOWN_DAYS,
    ]).toEqual([3, 2, 7, 14]);
  });

  test("the stages, in the order of the flow, each with a name", () => {
    expect(STAGES).toEqual(["draft", "waiting_for_review", "changes_requested", "approved", "merged", "closed"]);
    // Closed without merging left the flow: it has no column.
    expect(FLOW_STAGES).toEqual(["draft", "waiting_for_review", "changes_requested", "approved", "merged"]);
    expect(STAGES.map((s) => STAGE_LABELS[s])).toEqual([
      "Draft",
      "Waiting for review",
      "Changes requested",
      "Approved",
      "Merged",
      "Closed",
    ]);
  });
});

describe("placeOf: the stage of a pull request", () => {
  test.each([
    ["an open draft, whatever its reviews say", { draft: true, reviewDecision: "approved" }, "draft"],
    ["open with no review yet", { reviewDecision: "none" }, "waiting_for_review"],
    ["open with a review required", { reviewDecision: "review_required" }, "waiting_for_review"],
    ["open, reviewed without a verdict, still asked", { reviewDecision: "review_required", lastReviewAt: ago(HOUR) }, "waiting_for_review"],
    ["open with changes requested", { reviewDecision: "changes_requested" }, "changes_requested"],
    ["open and approved", { reviewDecision: "approved" }, "approved"],
    ["merged yesterday", { state: "merged", mergedAt: ago(DAY), closedAt: ago(DAY) }, "merged"],
    ["merged as a draft, approved or not", { state: "merged", draft: true, mergedAt: ago(DAY) }, "merged"],
    ["closed without merging yesterday", { state: "closed", closedAt: ago(DAY) }, "closed"],
  ] as const)("%s", (_what, over, want) => {
    expect(stage(over)).toBe(want);
  });

  test("merged or closed more than fourteen days ago is in no stage; exactly fourteen still is", () => {
    expect(stage({ state: "merged", mergedAt: ago(14 * DAY) })).toBe("merged");
    expect(stage({ state: "merged", mergedAt: ago(14 * DAY + 1) })).toBeNull();
    expect(stage({ state: "closed", closedAt: ago(14 * DAY) })).toBe("closed");
    expect(stage({ state: "closed", closedAt: ago(14 * DAY + 1) })).toBeNull();
  });

  test("an open one is never dropped for its age", () => {
    expect(stage({ createdAt: ago(900 * DAY), updatedAt: ago(800 * DAY) })).toBe("waiting_for_review");
  });
});

describe("placeOf: age in stage, and which timestamp it is counted from", () => {
  const place = (over: Partial<PullRow>) => {
    const placed = placeOf(pr(over), NOW)!;
    return [placed.basis, NOW - placed.since];
  };

  test("waiting for a first review: since it was opened", () => {
    expect(place({ createdAt: ago(5 * DAY), updatedAt: ago(HOUR) })).toEqual(["opened", 5 * DAY]);
  });

  test("waiting again after a review: since that review", () => {
    expect(place({ createdAt: ago(9 * DAY), lastReviewAt: ago(2 * DAY) })).toEqual(["last_review", 2 * DAY]);
  });

  test("changes requested: since the last review; with no review time on record, since last activity", () => {
    expect(
      place({ reviewDecision: "changes_requested", createdAt: ago(9 * DAY), lastReviewAt: ago(4 * DAY) }),
    ).toEqual(["last_review", 4 * DAY]);
    expect(
      place({ reviewDecision: "changes_requested", createdAt: ago(9 * DAY), updatedAt: ago(3 * HOUR) }),
    ).toEqual(["last_activity", 3 * HOUR]);
  });

  test("approved: the facts do not say when, so since last activity", () => {
    expect(
      place({ reviewDecision: "approved", createdAt: ago(9 * DAY), lastReviewAt: ago(6 * DAY), updatedAt: ago(DAY) }),
    ).toEqual(["last_activity", DAY]);
  });

  test("a draft: since last activity", () => {
    expect(place({ draft: true, createdAt: ago(30 * DAY), updatedAt: ago(8 * DAY) })).toEqual([
      "last_activity",
      8 * DAY,
    ]);
  });

  test("merged and closed: since then", () => {
    expect(place({ state: "merged", mergedAt: ago(2 * DAY), updatedAt: ago(HOUR) })).toEqual(["merged", 2 * DAY]);
    expect(place({ state: "closed", closedAt: ago(3 * DAY), updatedAt: ago(HOUR) })).toEqual(["closed", 3 * DAY]);
  });

  test("a missing timestamp falls back, and says so: merged with no time is counted from last activity", () => {
    expect(place({ state: "merged", updatedAt: ago(2 * DAY) })).toEqual(["last_activity", 2 * DAY]);
    expect(place({ state: "closed", updatedAt: ago(2 * DAY) })).toEqual(["last_activity", 2 * DAY]);
  });

  test("a time ahead of the clock is no negative age", () => {
    const placed = placeOf(pr({ createdAt: NOW + HOUR, updatedAt: NOW + HOUR }), NOW)!;
    expect(placed.ageMs).toBe(0);
  });

  test("how each basis reads beside an age", () => {
    expect(sinceWords("opened")).toBe("since it was opened");
    expect(sinceWords("last_review")).toBe("since the last review");
    expect(sinceWords("last_activity")).toBe("since last activity");
    expect(sinceWords("merged")).toBe("since it was merged");
    expect(sinceWords("closed")).toBe("since it was closed");
  });
});

describe("placeOf: stuck, and why", () => {
  test("waiting for a first review more than three days", () => {
    expect(reasons({ createdAt: ago(3 * DAY) })).toEqual([]);
    expect(reasons({ createdAt: ago(3 * DAY + 1) })).toEqual(["no_review"]);
    const [why] = placeOf(pr({ createdAt: ago(5 * DAY + HOUR) }), NOW)!.stuck;
    expect(why!.words).toBe("Waiting 5 days for a first review");
  });

  test("reviewed, still waiting, and more than three days since that review", () => {
    const over = { createdAt: ago(20 * DAY), reviewDecision: "review_required" } as const;
    expect(reasons({ ...over, lastReviewAt: ago(3 * DAY) })).toEqual([]);
    const [why] = placeOf(pr({ ...over, lastReviewAt: ago(4 * DAY) }), NOW)!.stuck;
    expect(why).toEqual({ reason: "no_review", words: "No review for 4 days since the last one" });
  });

  test("changes requested and no update for more than three days", () => {
    const over = { reviewDecision: "changes_requested", createdAt: ago(20 * DAY), lastReviewAt: ago(10 * DAY) } as const;
    expect(reasons({ ...over, updatedAt: ago(3 * DAY) })).toEqual([]);
    expect(reasons({ ...over, updatedAt: ago(HOUR) })).toEqual([]);
    const [why] = placeOf(pr({ ...over, updatedAt: ago(3 * DAY + 1) }), NOW)!.stuck;
    expect(why).toEqual({ reason: "changes_unanswered", words: "Changes requested, and no update for 3 days" });
  });

  test("approved and unmerged for more than two days", () => {
    const over = { reviewDecision: "approved", createdAt: ago(20 * DAY) } as const;
    expect(reasons({ ...over, updatedAt: ago(2 * DAY) })).toEqual([]);
    const [why] = placeOf(pr({ ...over, updatedAt: ago(2 * DAY + 1) }), NOW)!.stuck;
    expect(why).toEqual({ reason: "approved_unmerged", words: "Approved, and not merged for 2 days since last activity" });
  });

  test("a draft untouched for more than seven days", () => {
    const over = { draft: true, createdAt: ago(40 * DAY) } as const;
    expect(reasons({ ...over, updatedAt: ago(7 * DAY) })).toEqual([]);
    const [why] = placeOf(pr({ ...over, updatedAt: ago(9 * DAY) }), NOW)!.stuck;
    expect(why).toEqual({ reason: "draft_untouched", words: "Draft untouched for 9 days" });
  });

  test("failing checks on an open pull request that is not a draft: stuck at once", () => {
    const fresh = { createdAt: ago(HOUR), updatedAt: ago(HOUR), checks: "failing" } as const;
    expect(placeOf(pr(fresh), NOW)!.stuck).toEqual([{ reason: "checks_failing", words: "Checks are failing" }]);
    for (const reviewDecision of ["approved", "changes_requested", "review_required"] as const) {
      expect(reasons({ ...fresh, reviewDecision })).toEqual(["checks_failing"]);
    }
    // Pending and absent checks are not failing ones.
    expect(reasons({ ...fresh, checks: "pending" })).toEqual([]);
    expect(reasons({ ...fresh, checks: "none" })).toEqual([]);
  });

  test("a draft's failing checks are its author's work in progress, not a blockage", () => {
    expect(reasons({ draft: true, checks: "failing", updatedAt: ago(HOUR) })).toEqual([]);
  });

  test("both at once: the wait first, then the checks", () => {
    expect(reasons({ createdAt: ago(6 * DAY), checks: "failing" })).toEqual(["no_review", "checks_failing"]);
  });

  test("merged and closed ones are never stuck, whatever their checks", () => {
    expect(reasons({ state: "merged", mergedAt: ago(10 * DAY), checks: "failing" })).toEqual([]);
    expect(reasons({ state: "closed", closedAt: ago(10 * DAY), checks: "failing" })).toEqual([]);
  });

  test("one day is said in the singular", () => {
    const placed = placeOf(pr({ draft: true, updatedAt: ago(8 * DAY) }), NOW)!;
    expect(placed.stuck[0]!.words).toBe("Draft untouched for 8 days");
    expect(ageWords(DAY)).toBe("1 day");
  });
});

describe("ageWords and medianAge", () => {
  test("hours under a day, then whole days", () => {
    expect(ageWords(0)).toBe("under an hour");
    expect(ageWords(59 * 60 * 1000)).toBe("under an hour");
    expect(ageWords(HOUR)).toBe("1 hour");
    expect(ageWords(23 * HOUR)).toBe("23 hours");
    expect(ageWords(DAY)).toBe("1 day");
    expect(ageWords(2 * DAY + 23 * HOUR)).toBe("2 days");
    expect(ageWords(40 * DAY)).toBe("40 days");
  });

  test("the median of none is null, never zero", () => {
    expect(medianAge([])).toBeNull();
    expect(medianAge([5])).toBe(5);
    expect(medianAge([9, 1, 5])).toBe(5);
    expect(medianAge([1, 3, 5, 100])).toBe(4);
  });
});

describe("linkOf: the one address a pull request is linked to", () => {
  test("GitHub's own address for it, when that is what was stored", () => {
    expect(linkOf(pr())).toBe("https://github.com/Made-Up-Org/startup-app/pull/1");
  });

  test.each([
    ["another host", "https://example.test/Made-Up-Org/startup-app/pull/1"],
    ["another pull request", "https://github.com/Made-Up-Org/startup-app/pull/2"],
    ["a script", "javascript:alert(1)"],
    ["a query added", "https://github.com/Made-Up-Org/startup-app/pull/1?next=x"],
    ["nothing", ""],
  ])("%s is no link at all", (_what, url) => {
    expect(linkOf(pr({ url }))).toBeNull();
  });

  test("a title is never an address, whatever it says", () => {
    const pull = pr({ title: "https://example.test/phish", url: "https://example.test/phish" });
    expect(linkOf(pull)).toBeNull();
  });

  test("a repository id that is not one makes no address", () => {
    const repoId = "Made-Up-Org/startup app";
    expect(linkOf(pr({ repoId, url: `https://github.com/${repoId}/pull/1` }))).toBeNull();
  });
});

describe("stuckCount: the one count of stuck pull requests every summary uses", () => {
  const list = (rows: PullRow[], readAt: number | null = NOW) => ({ readAt, rows });

  test("by the same five rules the page shows, for one company", () => {
    const rows = [
      pr({ number: 1, createdAt: ago(4 * DAY) }), // waiting for a first review
      pr({ number: 2, reviewDecision: "changes_requested", updatedAt: ago(4 * DAY) }),
      pr({ number: 3, reviewDecision: "approved", updatedAt: ago(3 * DAY) }),
      pr({ number: 4, draft: true, updatedAt: ago(8 * DAY) }),
      pr({ number: 5, checks: "failing" }),
      pr({ number: 6 }), // fresh: not stuck
      pr({ number: 7, company: "kz", createdAt: ago(9 * DAY) }),
      pr({ number: 8, state: "merged", mergedAt: ago(DAY), createdAt: ago(20 * DAY) }),
    ];
    expect(stuckCount(list(rows), "us", NOW)).toBe(5);
    expect(stuckCount(list(rows), "kz", NOW)).toBe(1);
  });

  test("a list never read is no count, not a zero; a read list with none stuck is 0", () => {
    expect(stuckCount(list([], null), "us", NOW)).toBeNull();
    expect(stuckCount(null, "us", NOW)).toBeNull();
    expect(stuckCount(list([pr()]), "us", NOW)).toBe(0);
  });
});
