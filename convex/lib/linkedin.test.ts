import { describe, expect, test } from "vitest";
import {
  addDays,
  cadenceVerdict,
  cadenceWeeks,
  cleanLink,
  engagementRate,
  growthWeeks,
  latestSnapshot,
  mondayOf,
  needsYou,
  topPosts,
  windowTotals,
  type DatedPost,
  type Figures,
  type Snapshot,
} from "./linkedin";

const NONE: Figures = {
  impressions: null,
  reactions: null,
  comments: null,
  reposts: null,
  clicks: null,
  followersGained: null,
};
const snap = (day: string, over: Partial<Figures> = {}): Snapshot => ({ day, ...NONE, ...over });
const post = (id: string, over: Partial<DatedPost> = {}): DatedPost => ({
  id,
  company: "us",
  account: "page",
  person: null,
  status: "published",
  title: `Post ${id}`,
  hasBody: true,
  plannedDay: null,
  publishedDay: null,
  snapshots: [],
  ...over,
});
const NAMES = { us: "Startup", kz: "Globex" } as const;

// 2026-10-18 is a Sunday; its week began on Monday 2026-10-12.
const TODAY = "2026-10-18";

describe("days and weeks", () => {
  test("a week begins on Monday, and a Sunday belongs to the week before it", () => {
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("a post's link", () => {
  test("is an https address on LinkedIn, and nothing else", () => {
    expect(cleanLink(" https://www.linkedin.com/posts/made-up-123#x ")).toBe("https://www.linkedin.com/posts/made-up-123");
    expect(cleanLink("https://lnkd.in/abc")).toBe("https://lnkd.in/abc");
    expect(cleanLink("http://www.linkedin.com/posts/x")).toBeNull();
    expect(cleanLink("https://linkedin.com.example.test/posts/x")).toBeNull();
    expect(cleanLink("https://evil.test/linkedin.com")).toBeNull();
    expect(cleanLink("https://user:pw@www.linkedin.com/posts/x")).toBeNull();
    expect(cleanLink("javascript:alert(1)")).toBeNull();
    expect(cleanLink("not a link")).toBeNull();
    expect(cleanLink(`https://www.linkedin.com/${"a".repeat(400)}`)).toBeNull();
  });
});

describe("engagement rate", () => {
  test("is reactions, comments and reposts over impressions, once all four are known", () => {
    expect(engagementRate({ ...NONE, impressions: 1000, reactions: 30, comments: 10, reposts: 10 })).toBe(0.05);
    expect(engagementRate({ ...NONE, impressions: 1000, reactions: 30, comments: 10 })).toBeNull();
    expect(engagementRate({ ...NONE, impressions: 0, reactions: 0, comments: 0, reposts: 0 })).toBeNull();
  });
});

describe("the latest snapshot", () => {
  test("is the newest day, whatever the order", () => {
    const later = snap("2026-10-10", { impressions: 5 });
    expect(latestSnapshot([later, snap("2026-10-02", { impressions: 1 })])).toBe(later);
    expect(latestSnapshot([])).toBeNull();
  });
});

describe("the last 30 days", () => {
  const out = (id: string, day: string, figures: Partial<Figures>, when = "2026-10-20") =>
    post(id, { publishedDay: day, snapshots: [snap("2026-10-01", { impressions: 1 }), snap(when, figures)] });

  test("sums each post's latest figures for the posts that went out in the window", () => {
    const rows = [
      out("a", "2026-10-10", { impressions: 1000, reactions: 40, comments: 5, reposts: 5, clicks: 20, followersGained: 3 }),
      out("b", "2026-09-19", { impressions: 500, reactions: 10, comments: 0, reposts: 0, clicks: 5, followersGained: 1 }),
      // Before the window (30 days ending 2026-10-18 begin 2026-09-19): left out.
      out("old", "2026-09-18", { impressions: 9999, reactions: 9, comments: 9, reposts: 9 }),
      // Not out yet: left out.
      post("next", { status: "scheduled", plannedDay: "2026-10-20" }),
    ];
    const totals = windowTotals(rows, TODAY);
    expect(totals).toMatchObject({ from: "2026-09-19", to: TODAY, published: 2, measured: 2 });
    expect(totals.totals).toEqual({
      impressions: 1500,
      reactions: 50,
      comments: 5,
      reposts: 5,
      clicks: 25,
      followersGained: 4,
    });
    expect(totals.rate).toBeCloseTo(60 / 1500);
  });

  test("a post without figures is counted as published, not as measured, and a figure nobody gave is unknown, not zero", () => {
    const totals = windowTotals([post("a", { publishedDay: "2026-10-10" }), out("b", "2026-10-11", { impressions: 10 })], TODAY);
    expect(totals).toMatchObject({ published: 2, measured: 1, rate: null });
    expect(totals.totals.impressions).toBe(10);
    expect(totals.totals.clicks).toBeNull();
    expect(windowTotals([], TODAY).totals.impressions).toBeNull();
  });
});

describe("top posts", () => {
  const withFigures = (id: string, impressions: number, engaged: number) =>
    post(id, {
      publishedDay: "2026-10-05",
      snapshots: [snap("2026-10-12", { impressions, reactions: engaged, comments: 0, reposts: 0 })],
    });

  test("are ranked by rate from 100 impressions, and a post with fewer is not ranked", () => {
    const ranked = topPosts([
      withFigures("low", 1000, 10),
      withFigures("best", 200, 40),
      withFigures("tiny", 50, 40),
      withFigures("mid", 1000, 50),
      post("none", { publishedDay: "2026-10-05" }),
    ]);
    expect(ranked.map((row) => row.id)).toEqual(["best", "mid", "low"]);
    expect(ranked[0]!.rate).toBeCloseTo(0.2);
    expect(topPosts([withFigures("a", 1000, 10), withFigures("b", 1000, 20)], 1)).toHaveLength(1);
  });
});

describe("cadence", () => {
  test("counts what went out and what is planned in each week, the week in progress last", () => {
    const rows = [
      post("a", { publishedDay: "2026-10-13" }),
      post("b", { publishedDay: "2026-10-18" }),
      post("c", { publishedDay: "2026-10-09" }),
      post("d", { status: "scheduled", plannedDay: "2026-10-16" }),
      post("e", { status: "dropped", plannedDay: "2026-10-16" }),
    ];
    const weeks = cadenceWeeks(rows, TODAY, 3);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(weeks.map((w) => w.published)).toEqual([0, 1, 2]);
    expect(weeks[2]).toMatchObject({ planned: 1, inProgress: true });
    expect(weeks[1]!.inProgress).toBe(false);
  });

  test("is judged on the finished weeks against the target, and only with a target", () => {
    const weeks = cadenceWeeks([post("a", { publishedDay: "2026-10-06" }), post("b", { publishedDay: "2026-10-07" })], TODAY, 3);
    expect(cadenceVerdict(weeks, 1)).toEqual({ target: 1, average: 1, verdict: "met" });
    expect(cadenceVerdict(weeks, 3)).toMatchObject({ verdict: "below", average: 1 });
    expect(cadenceVerdict(weeks, null)).toBeNull();
    expect(cadenceVerdict([weeks[2]!], 1)).toBeNull();
  });
});

describe("growth", () => {
  test("puts each step between snapshots in the week of the later one, and never goes down", () => {
    const rows = [
      post("a", {
        publishedDay: "2026-10-05",
        snapshots: [
          snap("2026-10-06", { impressions: 100, followersGained: 2 }),
          snap("2026-10-14", { impressions: 400, followersGained: 5 }),
          // revised down: no gain
          snap("2026-10-16", { impressions: 390, followersGained: 5 }),
        ],
      }),
      post("b", { publishedDay: "2026-10-13", snapshots: [snap("2026-10-14", { impressions: 50 })] }),
    ];
    const weeks = growthWeeks(rows, TODAY, 3);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(weeks.map((w) => w.impressions)).toEqual([0, 100, 350]);
    expect(weeks.map((w) => w.followersGained)).toEqual([0, 2, 3]);
  });
});

describe("needs you", () => {
  const scheduled = (id: string, plannedDay: string, over: Partial<DatedPost> = {}) =>
    post(id, { status: "scheduled", plannedDay, hasBody: false, ...over });

  test("a scheduled post with no draft within two days is flagged, past ones as overdue", () => {
    const items = needsYou(
      [
        scheduled("soon", "2026-10-20"),
        scheduled("late", "2026-10-15"),
        scheduled("far", "2026-10-21"),
        scheduled("drafted", "2026-10-19", { hasBody: true }),
        scheduled("idea", "2026-10-19", { status: "draft" }),
        // covers both weeks, so only the drafts are flagged
        post("this", { publishedDay: "2026-10-14" }),
        post("that", { status: "scheduled", plannedDay: "2026-10-22", hasBody: true }),
      ],
      TODAY,
      ["us"],
      NAMES,
    );
    expect(items.map((i) => [i.id, i.severity])).toEqual([
      ["draft:late", "overdue"],
      ["draft:soon", "due"],
    ]);
    expect(items[0]!.detail).toContain("Startup");
  });

  test("a week with no post planned is flagged for this week and next, per company in view", () => {
    const items = needsYou(
      [
        post("us-this", { publishedDay: "2026-10-14" }),
        // dropped and idea posts plan nothing
        post("us-next", { status: "dropped", plannedDay: "2026-10-22" }),
        post("kz-next", { company: "kz", status: "scheduled", plannedDay: "2026-10-22" }),
      ],
      TODAY,
      ["us", "kz"],
      NAMES,
    );
    expect(items.map((i) => i.id).sort()).toEqual(["week:kz:2026-10-12", "week:us:2026-10-19"]);
    expect(items.every((i) => i.severity === "empty")).toBe(true);
    expect(needsYou([], TODAY, [], NAMES)).toEqual([]);
  });
});
