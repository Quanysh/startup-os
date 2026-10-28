import { describe, expect, test } from "vitest";
import { getMetric, type MetricDef } from "@convex/lib/metricRegistry";
import {
  attentionItems,
  companyMrr,
  homeTiles,
  metricFreshness,
  sortAttention,
  sourceLabel,
  sourcesOfSection,
  supplyOf,
  type AttentionItem,
  type SourceStates,
  type Tile,
} from "./scorecard";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);

const REGISTRY: readonly MetricDef[] = [
  {
    key: "mrr",
    label: "MRR",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { us: "manual" },
    staleAfterDays: 45,
    home: 1,
  },
  {
    key: "cash",
    label: "Cash",
    section: "finance",
    unit: "currency",
    grain: "day",
    better: "up",
    sources: { us: "mercury" },
    staleAfterDays: 2,
    home: 2,
  },
  {
    key: "fx_usd_kzt",
    label: "USD/KZT rate",
    section: "finance",
    unit: "ratio",
    grain: "month",
    better: "down",
    sources: { company: "manual" },
    staleAfterDays: 45,
  },
];

const tile = (key: string, scope: string, latestPeriodStart: string | null): Tile => ({
  key,
  scope,
  latest:
    latestPeriodStart === null
      ? null
      : {
          value: 1,
          periodStart: latestPeriodStart,
          currency: "USD",
          source: "manual",
          syncedAt: NOW,
        },
  firstPeriodStart: latestPeriodStart,
  series: [],
});

// Every number current as of 12 Oct 2026.
const fresh = [
  tile("mrr", "us", "2026-10-01"),
  tile("cash", "us", "2026-10-12"),
  tile("fx_usd_kzt", "company", "2026-10-01"),
];

const items = (tiles: Tile[], sources: SourceStates = {}) =>
  attentionItems(tiles, sources, NOW, REGISTRY);

describe("companyMrr", () => {
  const series = (
    key: string,
    scope: string,
    points: [string, number][],
    firstPeriodStart: string | null = points[0]?.[0] ?? null,
  ): Tile => ({
    key,
    scope,
    latest: null,
    firstPeriodStart,
    series: points.map(([periodStart, value]) => ({ periodStart, value })),
  });
  const fx = series("fx_usd_kzt", "company", [["2026-09-01", 440]]);

  test("null when no market has an MRR figure", () => {
    expect(companyMrr([series("mrr", "us", []), series("mrr", "kz", [])])).toBeNull();
  });

  test("adds the US and converted Kazakhstan figures and reports growth", () => {
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 1_000], ["2026-10-01", 1_200]]),
      series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]]),
      fx,
    ]);
    expect(result?.latest).toMatchObject({
      periodStart: "2026-10-01",
      value: 11_200,
      complete: true,
    });
    expect(result?.growthPercent).toBeCloseTo((200 / 11_000) * 100);
    expect(result?.previousPeriodStart).toBe("2026-09-01");
  });

  test("withholds growth and names the market when this month is missing one", () => {
    // The ordinary case: the two markets are entered separately, and October
    // exists for the US before it exists for Kazakhstan.
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-09-01", 4_400_000]]),
      fx,
    ]);
    expect(result?.latest).toMatchObject({ value: 5_500, complete: false, missing: ["kz"] });
    expect(result?.growthPercent).toBeNull();
  });

  test("withholds growth when last month was the partial one", () => {
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-08-01", 4_400_000], ["2026-10-01", 4_400_000]]),
      fx,
    ]);
    expect(result?.latest.complete).toBe(true);
    expect(result?.growthPercent).toBeNull();
  });

  test("the trend keeps only complete months, so a partial one draws no cliff", () => {
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-09-01", 4_400_000]]),
      fx,
    ]);
    expect(result?.trend.map((t) => t.periodStart)).toEqual(["2026-09-01"]);
  });

  test("withholds growth in the first month a market reports", () => {
    // Kazakhstan's first figure arrives for October. September holds the US alone.
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-10-01", 4_400_000]]),
      fx,
    ]);
    expect(result?.latest).toMatchObject({ value: 15_500, complete: true });
    expect(result?.growthPercent).toBeNull();
  });

  test("the trend keeps only months that report every market the company has", () => {
    const result = companyMrr([
      series("mrr", "us", [["2026-08-01", 4_000], ["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]]),
      fx,
    ]);
    // August is a real total for its time, but not comparable with the months after it.
    expect(result?.series.map((point) => point.periodStart)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(result?.trend.map((point) => point.periodStart)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(result?.growthPercent).toBeCloseTo((500 / 15_000) * 100);
  });

  describe("growthWithheld", () => {
    const both = (us: [string, number][], kz: [string, number][]) =>
      companyMrr([series("mrr", "us", us), series("mrr", "kz", kz), fx]);

    test("null when growth is shown", () => {
      const result = both(
        [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
        [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]],
      );
      expect(result?.growthPercent).not.toBeNull();
      expect(result?.growthWithheld).toBeNull();
    });

    test("partial: the latest month is not complete", () => {
      const result = both(
        [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
        [["2026-09-01", 4_400_000]],
      );
      expect(result?.growthWithheld).toBe("partial");
    });

    test("no_previous: there is no month before the latest", () => {
      const result = both([["2026-10-01", 5_500]], [["2026-10-01", 4_400_000]]);
      expect(result?.growthWithheld).toBe("no_previous");
    });

    test("no_previous: the month before the latest is not in the series", () => {
      const result = companyMrr([series("mrr", "us", [["2026-08-01", 5_000], ["2026-10-01", 5_500]]), fx]);
      expect(result?.growthWithheld).toBe("no_previous");
    });

    test("zero_baseline: last month's MRR was zero, so there is nothing to grow from", () => {
      const result = companyMrr([series("mrr", "us", [["2026-09-01", 0], ["2026-10-01", 5_000]])]);
      expect(result?.growthPercent).toBeNull();
      expect(result?.growthWithheld).toBe("zero_baseline");
    });

    test("zero_baseline: zero in both months never becomes a percentage", () => {
      const result = companyMrr([series("mrr", "us", [["2026-09-01", 0], ["2026-10-01", 0]])]);
      expect(result?.growthPercent).toBeNull();
      expect(result?.growthWithheld).toBe("zero_baseline");
    });

    test("zero_baseline: both markets at zero last month", () => {
      const result = both(
        [["2026-09-01", 0], ["2026-10-01", 5_500]],
        [["2026-09-01", 0], ["2026-10-01", 4_400_000]],
      );
      expect(result?.growthWithheld).toBe("zero_baseline");
    });

    test("no_previous, not zero_baseline: a month that is truly missing is not a zero", () => {
      const result = companyMrr([series("mrr", "us", [["2026-08-01", 0], ["2026-10-01", 5_000]])]);
      expect(result?.growthWithheld).toBe("no_previous");
    });

    test("previous_partial: last month was the incomplete one", () => {
      const result = both(
        [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
        [["2026-08-01", 4_400_000], ["2026-10-01", 4_400_000]],
      );
      expect(result?.growthWithheld).toBe("previous_partial");
    });

    test("new_market: both months complete, but the market first reported in the latest", () => {
      const result = both(
        [["2026-09-01", 5_000], ["2026-10-01", 5_500]],
        [["2026-10-01", 4_400_000]],
      );
      expect(result?.growthWithheld).toBe("new_market");
    });
  });

  test("a company with only one market reporting still gets growth and a trend", () => {
    const result = companyMrr([
      series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_840_000]]),
      fx,
    ]);
    expect(result?.growthPercent).toBeCloseTo(10);
    expect(result?.trend.map((point) => point.periodStart)).toEqual(["2026-09-01", "2026-10-01"]);
  });

  test("a month whose tenge cannot be converted is not comparable, so not in the trend", () => {
    // No rate at all: October is partial, and the US-only month before it
    // must not stand in as a comparable pair with it.
    const result = companyMrr([
      series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
      series("mrr", "kz", [["2026-10-01", 4_400_000]]),
    ]);
    expect(result?.latest).toMatchObject({ complete: false, missing: ["fx"] });
    expect(result?.trend.map((point) => point.periodStart)).toEqual(["2026-09-01"]);
  });

  test("says the total is partial when Kazakhstan cannot be converted", () => {
    const result = companyMrr([
      series("mrr", "us", [["2026-10-01", 1_200]]),
      series("mrr", "kz", [["2026-10-01", 4_400_000]]),
    ]);
    expect(result?.latest).toMatchObject({ value: 1_200, complete: false, missing: ["fx"] });
    expect(result?.growthPercent).toBeNull();
  });

  test("reports the rate used and flags one that is more than two months old", () => {
    const fresh = companyMrr([
      series("mrr", "kz", [["2026-10-01", 4_400_000]]),
      series("fx_usd_kzt", "company", [["2026-08-01", 440]]),
    ]);
    expect(fresh).toMatchObject({ rate: 440, ratePeriodStart: "2026-08-01", rateIsOld: false });

    const old = companyMrr([
      series("mrr", "kz", [["2026-10-01", 4_400_000]]),
      series("fx_usd_kzt", "company", [["2026-07-01", 440]]),
    ]);
    expect(old?.rateIsOld).toBe(true);
  });
});

describe("attentionItems", () => {
  test("nothing to do when every number is fresh", () => {
    expect(items(fresh)).toEqual([]);
  });

  test("a scorecard metric with no value asks for one and links to the entry form", () => {
    const result = items([tile("mrr", "us", null), ...fresh.slice(1)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      severity: "empty",
      title: "MRR · US has no value yet",
      detail: "Enter it to start the trend.",
      href: "/finance?metric=mrr&scope=us#record-a-figure",
    });
  });

  test("a number with nothing newer than its window allows is called out, naming its last period", () => {
    const result = items([tile("mrr", "us", "2026-07-01"), ...fresh.slice(1)]);
    expect(result[0]).toMatchObject({
      severity: "stale",
      title: "MRR · US is out of date",
      detail: "Nothing since Jul 2026.",
    });
  });

  test("a healthy source does not make an old number current", () => {
    // The source ran an hour ago, but cash was last reported five days back:
    // a run that omits a metric must not vouch for it.
    const tiles = [fresh[0]!, tile("cash", "us", "2026-10-07"), fresh[2]!];
    const sources: SourceStates = {
      mercury: { state: "ok", lastRunAt: NOW - 3_600_000, lastOkAt: NOW - 3_600_000, message: null },
    };
    expect(items(tiles, sources).map((i) => i.id)).toEqual(["stale:cash:us"]);
  });

  test("a supporting metric that is not on the scorecard does not nag", () => {
    expect(items([...fresh.slice(0, 2), tile("fx_usd_kzt", "company", null)])).toEqual([]);
  });

  test("a metric the scorecard depends on is watched even though it has no tile", () => {
    // The exchange rate feeds the headline number. If it is missing or stale
    // the list must not claim that everything is current.
    const watched = REGISTRY.map((m) => (m.key === "fx_usd_kzt" ? { ...m, watch: true } : m));
    const result = attentionItems(
      [...fresh.slice(0, 2), tile("fx_usd_kzt", "company", null)],
      {},
      NOW,
      watched,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      severity: "empty",
      title: "USD/KZT rate · Company has no value yet",
    });
  });

  test("a failed source is reported with its message, ahead of everything else", () => {
    const result = items([tile("mrr", "us", null), ...fresh.slice(1)], {
      mercury: { state: "error", lastRunAt: NOW, lastOkAt: NOW - DAY, message: "401 from Mercury" },
    });
    expect(result.map((r) => r.severity)).toEqual(["error", "empty"]);
    expect(result[0]).toMatchObject({
      title: "Mercury: last run failed",
      detail: "401 from Mercury",
      href: "/settings/sources",
    });
  });

  test("a failing work tool is named the same way (Phase 8 adds no rule of its own)", () => {
    const result = items(fresh, {
      linear: {
        state: "error",
        lastRunAt: NOW,
        lastOkAt: NOW - DAY,
        message: "Linear answered 401 for issues.",
      },
      gmail: {
        state: "not_configured",
        lastRunAt: NOW,
        lastOkAt: null,
        message: "Connect Google under Settings → Work tools.",
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      severity: "error",
      title: "Linear: last run failed",
      detail: "Linear answered 401 for issues.",
    });
  });

  test("a source that is merely not configured is not an error", () => {
    const result = items(fresh, {
      mercury: { state: "not_configured", lastRunAt: NOW, lastOkAt: null, message: "missing" },
    });
    expect(result).toEqual([]);
  });

  test("staleness uses the scope's own limit", () => {
    const registry: MetricDef[] = [
      {
        key: "cash",
        label: "Cash",
        section: "finance",
        unit: "currency",
        grain: "day",
        better: "up",
        sources: { us: "mercury", kz: "manual" },
        staleAfterDays: 35,
        staleAfterDaysByScope: { us: 3 },
        home: 1,
      },
    ];
    const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);
    const tile = (scope: string): Tile => ({
      key: "cash",
      scope,
      firstPeriodStart: tenDaysAgo,
      latest: { value: 1, periodStart: tenDaysAgo, currency: "USD", source: "x", syncedAt: NOW },
      series: [{ periodStart: tenDaysAgo, value: 1 }],
    });
    const items = attentionItems([tile("us"), tile("kz")], {}, NOW, registry);
    expect(items.map((i) => i.id)).toEqual(["stale:cash:us"]);
  });

  test("a tile for a scope this build's registry lacks is skipped, not fatal", () => {
    // A tab left open across a deploy that added a scope.
    const registry: MetricDef[] = [
      {
        key: "cash",
        label: "Cash",
        section: "finance",
        unit: "currency",
        grain: "day",
        better: "up",
        sources: { us: "manual" },
        staleAfterDays: 2,
        home: 1,
      },
    ];
    const stray: Tile = {
      key: "cash",
      scope: "company",
      firstPeriodStart: null,
      latest: null,
      series: [],
    };
    expect(attentionItems([stray], {}, NOW, registry)).toEqual([]);
  });

  test("a sparse metric is never reported missing or stale", () => {
    const registry: MetricDef[] = [
      {
        key: "financing_in",
        label: "Financing received",
        section: "finance",
        unit: "currency",
        grain: "month",
        better: "up",
        sources: { us: "manual" },
        staleAfterDays: 45,
        sparse: true,
        // Deliberately watched here: sparse must win even if someone adds it.
        watch: true,
      },
    ];
    const empty: Tile = {
      key: "financing_in",
      scope: "us",
      firstPeriodStart: null,
      latest: null,
      series: [],
    };
    expect(attentionItems([empty], {}, NOW, registry)).toEqual([]);

    // Years since its last row is still "none happened", not "out of date".
    const old: Tile = {
      ...empty,
      firstPeriodStart: "2023-01-01",
      latest: {
        value: 1,
        periodStart: "2023-01-01",
        currency: "USD",
        source: "manual",
        syncedAt: NOW,
      },
    };
    expect(attentionItems([old], {}, NOW, registry)).toEqual([]);
  });

  describe("a figure a source brings", () => {
    // Nothing to type: the entry form would refuse it, so the item points at
    // the sources page and names who is expected to deliver.
    const registry: MetricDef[] = [
      {
        key: "receivables",
        label: "Owed by clients",
        section: "finance",
        unit: "currency",
        grain: "month",
        better: "down",
        sources: { kz: "cfo_workbook" },
        staleAfterDays: 45,
        home: 1,
      },
    ];
    const receivables = (latestPeriodStart: string | null): Tile => ({
      key: "receivables",
      scope: "kz",
      firstPeriodStart: latestPeriodStart,
      latest:
        latestPeriodStart === null
          ? null
          : {
              value: 1,
              periodStart: latestPeriodStart,
              currency: "KZT",
              source: "cfo_workbook",
              syncedAt: NOW,
            },
      series: [],
    });

    test("when empty, it waits for the source instead of asking for entry", () => {
      expect(attentionItems([receivables(null)], {}, NOW, registry)).toEqual([
        {
          id: "empty:receivables:kz",
          severity: "empty",
          title: "Owed by clients · Kazakhstan has no value yet",
          detail: "Waiting for the CFO workbook.",
          href: "/settings/sources",
        },
      ]);
    });

    test("a source whose name takes no article is not given one", () => {
      const cash: MetricDef = { ...registry[0]!, key: "cash", label: "Cash", sources: { us: "mercury" } };
      const empty: Tile = { key: "cash", scope: "us", firstPeriodStart: null, latest: null, series: [] };
      expect(attentionItems([empty], {}, NOW, [cash])[0]?.detail).toBe("Waiting for Mercury.");
    });

    test("when stale, it links to the sources page, not the entry form", () => {
      expect(attentionItems([receivables("2026-06-01")], {}, NOW, registry)).toEqual([
        {
          id: "stale:receivables:kz",
          severity: "stale",
          title: "Owed by clients · Kazakhstan is out of date",
          detail: "Nothing since Jun 2026.",
          href: "/settings/sources",
        },
      ]);
    });
  });
});

describe("homeTiles", () => {
  const cashMetric = REGISTRY.find((m) => m.key === "cash")!;

  test("keeps this metric's known tiles, and leaves out another's and a stray scope's", () => {
    const known = tile("cash", "us", "2026-10-12");
    // A tab left open across a deploy that added a scope.
    const stray = tile("cash", "company", "2026-10-12");
    const other = tile("mrr", "us", "2026-10-01");
    expect(homeTiles(cashMetric, [other, stray, known])).toEqual([known]);
  });

  test("a metric with several scopes keeps each known one, in the order given", () => {
    const both: MetricDef = { ...cashMetric, sources: { us: "mercury", kz: "manual" } };
    const kz = tile("cash", "kz", "2026-10-01");
    const us = tile("cash", "us", "2026-10-12");
    expect(homeTiles(both, [kz, us])).toEqual([kz, us]);
  });
});

describe("metricFreshness", () => {
  const cash = {
    grain: "day",
    staleAfterDays: 35,
    staleAfterDaysByScope: { us: 3 },
  } as MetricDef;
  const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);

  test("judges each scope by its own limit", () => {
    expect(metricFreshness(NOW, cash, "us", tenDaysAgo)).toBe("stale");
    expect(metricFreshness(NOW, cash, "kz", tenDaysAgo)).toBe("fresh");
  });

  test("a figure never reported is empty, whatever the limit", () => {
    expect(metricFreshness(NOW, cash, "us", null)).toBe("empty");
  });
});

describe("supplyOf", () => {
  test("a typed-in figure is supplied on the entry form", () => {
    expect(supplyOf(getMetric("mrr")!, "us")).toEqual({
      how: "enter",
      href: "/finance?metric=mrr&scope=us#record-a-figure",
    });
  });

  test("a pushed figure is supplied by its source", () => {
    expect(supplyOf(getMetric("mrr")!, "kz")).toEqual({
      how: "source",
      href: "/settings/sources",
      source: "the CFO workbook",
    });
  });

  test("ownership comes from the metric it is given, not the global registry", () => {
    // Same key as the real MRR, whose US figure is typed in.
    const fixture: MetricDef = {
      ...getMetric("mrr")!,
      sources: { us: "cfo_workbook" },
    };
    expect(supplyOf(fixture, "us")).toMatchObject({ how: "source", source: "the CFO workbook" });
  });

  test("a source is named as it reads inside a sentence, with its own article or none", () => {
    expect(supplyOf(getMetric("cash")!, "us")).toMatchObject({ how: "source", source: "Mercury" });
    expect(sourceLabel("mercury", "named")).toBe("Mercury");
    expect(sourceLabel("cfo_workbook", "named")).toBe("the CFO workbook");
    expect(sourceLabel("manual", "named")).toBe("manual entry");
    // The label, for a heading or a table cell, is unchanged.
    expect(sourceLabel("cfo_workbook")).toBe("CFO workbook");
    // A source this build does not know is named by its id, in any form.
    expect(sourceLabel("no_such_source", "named")).toBe("no_such_source");
  });

  test("a scope the metric does not have is an error, not an entry form", () => {
    expect(() => supplyOf(getMetric("mrr_contracted")!, "us")).toThrow(
      new Error('"mrr_contracted" has no "us" scope.'),
    );
  });
});

describe("sourcesOfSection", () => {
  const metric = (key: string, section: MetricDef["section"], sources: MetricDef["sources"]): MetricDef => ({
    key,
    label: key,
    section,
    unit: "count",
    grain: "month",
    better: "up",
    sources,
    staleAfterDays: 45,
  });
  const registry = [
    metric("cash", "finance", { us: "mercury", kz: "manual" }),
    metric("mrr", "finance", { us: "manual", kz: "cfo_workbook" }),
    metric("signups", "product", { startup_insights: "posthog" }),
    metric("clinics_using", "product", { kz_product: "cfo_workbook" }),
  ];

  test("every source that owns a scope of a metric in the section, each once", () => {
    expect(sourcesOfSection("finance", registry)).toEqual(["manual", "mercury", "cfo_workbook"]);
  });

  test("a source that feeds only another section is not one of them", () => {
    expect(sourcesOfSection("finance", registry)).not.toContain("posthog");
    expect(sourcesOfSection("product", registry)).toEqual(["cfo_workbook", "posthog"]);
  });

  test("a section with no metric has no source", () => {
    expect(sourcesOfSection("marketing", registry)).toEqual([]);
  });

  test("in the real registry, finance is fed by Mercury, the workbook, manual entry and PostHog", () => {
    // PostHog: Globex's app's AI token cost, a cost of serving customers (unit economics).
    expect(sourcesOfSection("finance")).toEqual(["manual", "mercury", "cfo_workbook", "posthog_globex"]);
    // The rate every converted total rests on is a finance metric, so its owner is in.
    const fx = getMetric("fx_usd_kzt")!;
    expect(fx.section).toBe("finance");
    expect(sourcesOfSection("finance")).toContain(fx.sources.company);
  });
});

describe("sortAttention", () => {
  const item = (severity: AttentionItem["severity"], id: string): AttentionItem => ({
    id,
    severity,
    title: id,
    detail: "",
    href: "/",
  });

  test("failed, overdue, at risk, due, stale, missing: in that order", () => {
    const mixed = (["empty", "due", "error", "stale", "risk", "overdue"] as const).map((s) =>
      item(s, s),
    );
    expect(sortAttention(mixed).map((i) => i.severity)).toEqual([
      "error",
      "overdue",
      "risk",
      "due",
      "stale",
      "empty",
    ]);
  });

  test("items of one severity keep their order", () => {
    expect(sortAttention([item("due", "b"), item("due", "a")]).map((i) => i.id)).toEqual(["b", "a"]);
  });
});
