import { describe, expect, test } from "vitest";
import { changeOf, changeWords, kzHref, lastWeek, moduleRows, readKzView, utcWords } from "./kz-detail";

const params = (query: string) => new URLSearchParams(query);

describe("the Kazakhstan view in the address", () => {
  test("anything unknown is the overview", () => {
    expect(readKzView(params("view=nope&module=search"))).toEqual({ view: "overview", module: null });
  });

  test("a module is kept only on the modules view, and only a known one", () => {
    expect(readKzView(params("view=modules&module=search"))).toEqual({ view: "modules", module: "search" });
    expect(readKzView(params("view=modules&module=nope"))).toEqual({ view: "modules", module: null });
    expect(readKzView(params("view=doctors&module=search"))).toEqual({ view: "doctors", module: null });
  });

  test("an address round-trips and says only what differs", () => {
    expect(kzHref({ view: "overview", module: null })).toBe("/product?product=kz_product");
    const href = kzHref({ view: "modules", module: "journal" });
    expect(readKzView(new URL(href, "http://x").searchParams)).toEqual({ view: "modules", module: "journal" });
  });
});

describe("a week against the one before", () => {
  test("compares only with the week just before", () => {
    expect(lastWeek([{ periodStart: "2026-09-28", value: 5 }, { periodStart: "2026-10-05", value: 8 }])).toEqual({
      periodStart: "2026-10-05",
      value: 8,
      previous: 5,
    });
    const gap = lastWeek([{ periodStart: "2026-09-21", value: 5 }, { periodStart: "2026-10-05", value: 8 }]);
    expect(gap?.previous).toBeNull();
    expect(changeWords(gap)).toBeNull();
  });

  test("says the change in words", () => {
    expect(changeWords({ periodStart: "x", value: 8, previous: 5 })).toBe("+3");
    expect(changeWords({ periodStart: "x", value: 2, previous: 5 })).toBe("−3");
    expect(changeWords({ periodStart: "x", value: 5, previous: 5 })).toBe("no change");
    expect(lastWeek([])).toBeNull();
  });
});

describe("moduleRows", () => {
  test("busiest first, a module with no figure last, and a rate only from actions", () => {
    const tile = (key: string, value: number) => ({
      key,
      scope: "kz_product",
      latest: null,
      firstPeriodStart: null,
      series: [{ periodStart: "2026-10-05", value }],
    });
    const rows = moduleRows([
      tile("module_actions_search", 50),
      tile("module_failures_search", 5),
      tile("module_actions_intake", 200),
      tile("module_actions_journal", 0),
      tile("module_failures_journal", 0),
    ]);
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(["intake", "search", "journal"]);
    expect(rows.find((r) => r.id === "search")?.failureRate?.value).toBe(10);
    expect(rows.find((r) => r.id === "journal")?.failureRate).toBeNull();
    expect(rows.at(-1)?.actions).toBeNull();
  });
});

describe("changeOf: the chip's words and colour", () => {
  const week = (previous: number | null, value: number) => ({ periodStart: "2026-10-05", value, previous });

  test.each([
    [week(487, 544), "up", { words: "+12%", tone: "good" }],
    [week(405, 308), "up", { words: "−24%", tone: "bad" }],
    [week(25, 24), "up", { words: "same", tone: "flat" }],
    [week(0, 1), "up", { words: "new", tone: "new" }],
    [week(2, 0), "up", { words: "−100%", tone: "bad" }],
    // Less of something bad is good news.
    [week(5.76, 7.15), "down", { words: "+24%", tone: "bad" }],
    [week(0.43, 0.22), "down", { words: "−49%", tone: "good" }],
  ] as const)("%o, better %s", (w, better, expected) => {
    expect(changeOf(w, better)).toEqual(expected);
  });

  test("a rate moves in points, and under one point is about the same", () => {
    expect(changeOf(week(7, 13), "down", "points")).toEqual({ words: "+6 pp", tone: "bad" });
    expect(changeOf(week(67, 22), "down", "points")).toEqual({ words: "−45 pp", tone: "good" });
    expect(changeOf(week(4, 4.6), "down", "points")).toEqual({ words: "same", tone: "flat" });
  });

  test("no week before is no chip", () => {
    expect(changeOf(week(null, 5), "up")).toBeNull();
    expect(changeOf(null, "up")).toBeNull();
  });
});

describe("answer times are noisier", () => {
  test("under 20% reads the same; from 20% it is coloured", () => {
    expect(changeOf({ periodStart: "x", value: 54, previous: 48 }, "down", "relative", 20)).toEqual({ words: "same", tone: "flat" });
    expect(changeOf({ periodStart: "x", value: 65, previous: 48 }, "down", "relative", 20)).toEqual({ words: "+35%", tone: "bad" });
  });
});

describe("a year of history", () => {
  test("the scorecard's 13 weeks give way to the year history sent, for Globex's own scope only", async () => {
    const { withHistory, chartSeries } = await import("./kz-detail");
    const year = Array.from({ length: 53 }, (_, i) => ({ periodStart: `w${String(i).padStart(2, "0")}`, value: i }));
    const tiles = [
      { key: "actions", scope: "kz_product", latest: null, firstPeriodStart: null, series: year.slice(-13) },
      { key: "actions", scope: "us", latest: null, firstPeriodStart: null, series: year.slice(-13) },
    ];
    const longer = withHistory(tiles, [{ key: "actions", series: year }]);
    expect(longer[0]!.series).toHaveLength(53);
    expect(longer[1]!.series).toHaveLength(13);
    // A chart still shows a quarter.
    expect(chartSeries(longer, "actions")).toHaveLength(13);
    expect(withHistory(tiles, undefined)[0]!.series).toHaveLength(13);
  });
});

describe("the heat map's clock", () => {
  test("is said as an offset from UTC, or UTC itself", () => {
    expect(utcWords(5)).toBe("UTC+5");
    expect(utcWords(0)).toBe("UTC");
    expect(utcWords(-3)).toBe("UTC-3");
  });
});
