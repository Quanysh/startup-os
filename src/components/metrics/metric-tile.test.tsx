// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { MetricDef } from "@convex/lib/metricRegistry";
import type { Tile } from "@/lib/metrics/scorecard";
import { MetricTile } from "./metric-tile";

afterEach(cleanup);

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60 * 1000;

const empty = (key: string, scope: string): Tile => ({
  key,
  scope,
  latest: null,
  firstPeriodStart: null,
  series: [],
});

describe("MetricTile with no value yet", () => {
  const typedIn: MetricDef = {
    key: "mrr",
    label: "MRR",
    section: "finance",
    unit: "currency",
    grain: "month",
    better: "up",
    sources: { us: "manual" },
    staleAfterDays: 45,
    home: 1,
  };
  const delivered: MetricDef = {
    ...typedIn,
    key: "receivables",
    label: "Owed by clients",
    sources: { kz: "cfo_workbook" },
  };

  test("a typed-in figure offers the entry form", () => {
    render(<MetricTile metric={typedIn} tile={empty("mrr", "us")} now={NOW} />);
    expect(screen.getByRole("link", { name: "Add a value" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
  });

  test("a figure a source brings offers no entry form and names the source", () => {
    render(<MetricTile metric={delivered} tile={empty("receivables", "kz")} now={NOW} />);
    expect(screen.queryByRole("link", { name: "Add a value" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Arrives with the CFO workbook." }).getAttribute("href"),
    ).toBe("/settings/sources");
  });

  test("a source whose name takes no article is not given one", () => {
    const fromMercury: MetricDef = { ...typedIn, key: "cash", label: "Cash", sources: { us: "mercury" } };
    render(<MetricTile metric={fromMercury} tile={empty("cash", "us")} now={NOW} />);
    expect(screen.getByRole("link", { name: "Arrives with Mercury." }).getAttribute("href")).toBe(
      "/settings/sources",
    );
    expect(screen.queryByText(/the Mercury/)).toBeNull();
  });

  test("ownership comes from the metric the tile is given", () => {
    // The real registry types `mrr` in for the US; this fixture says a source
    // brings it. The tile must follow the metric it was handed.
    const handed: MetricDef = { ...typedIn, sources: { us: "cfo_workbook" } };
    render(<MetricTile metric={handed} tile={empty("mrr", "us")} now={NOW} />);
    expect(screen.queryByRole("link", { name: "Add a value" })).toBeNull();
    expect(screen.getByRole("link", { name: "Arrives with the CFO workbook." })).toBeTruthy();
  });
});

describe("MetricTile staleness", () => {
  // Synced daily in the US, typed in monthly in Kazakhstan.
  const cash: MetricDef = {
    key: "cash",
    label: "Cash",
    section: "finance",
    unit: "currency",
    grain: "day",
    better: "up",
    sources: { us: "mercury", kz: "manual" },
    staleAfterDays: 35,
    staleAfterDaysByScope: { us: 3 },
    home: 2,
  };
  const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);
  const filled = (scope: string): Tile => ({
    key: "cash",
    scope,
    firstPeriodStart: tenDaysAgo,
    latest: {
      value: 1_000,
      periodStart: tenDaysAgo,
      currency: scope === "kz" ? "KZT" : "USD",
      source: scope === "us" ? "mercury" : "manual",
      syncedAt: NOW,
    },
    series: [{ periodStart: tenDaysAgo, value: 1_000 }],
  });

  test("a ten-day-old balance is stale in the US, where the limit is three days", () => {
    render(<MetricTile metric={cash} tile={filled("us")} now={NOW} />);
    expect(screen.getByText(/^Stale · /)).toBeTruthy();
  });

  test("the same age is fine in Kazakhstan, where the limit is 35 days", () => {
    render(<MetricTile metric={cash} tile={filled("kz")} now={NOW} />);
    expect(screen.queryByText(/Stale/)).toBeNull();
  });

  test("with no clock yet (the server render), even a very old value is not marked stale", () => {
    const old: Tile = {
      ...filled("us"),
      firstPeriodStart: "2020-01-01",
      latest: { ...filled("us").latest!, periodStart: "2020-01-01" },
    };
    render(<MetricTile metric={cash} tile={old} now={null} />);
    expect(screen.queryByText(/Stale/)).toBeNull();
    // The value itself still shows.
    expect(screen.getByText("$1,000")).toBeTruthy();
  });
});

describe("MetricTile's trend line", () => {
  const metric: MetricDef = {
    key: "paying_clinics",
    label: "Paying clinics",
    section: "finance",
    unit: "count",
    grain: "month",
    better: "up",
    sources: { us: "manual" },
    staleAfterDays: 45,
  };
  const months = (count: number): Tile => {
    const series = ["2026-07-01", "2026-08-01", "2026-09-01"]
      .slice(3 - count)
      .map((periodStart, i) => ({ periodStart, value: 10 + i }));
    return {
      key: metric.key,
      scope: "us",
      latest: {
        value: series.at(-1)!.value,
        periodStart: series.at(-1)!.periodStart,
        currency: null,
        source: "manual",
        syncedAt: NOW - DAY,
      },
      firstPeriodStart: series[0]!.periodStart,
      series,
    };
  };
  const trend = () => screen.queryByRole("img", { name: /Paying clinics trend/ });

  test("is drawn for any series unless a minimum is asked for", () => {
    render(<MetricTile metric={metric} tile={months(1)} now={NOW} />);
    expect(trend()).not.toBeNull();
  });

  test("with a minimum of three, two buckets draw none and three draw it", () => {
    render(<MetricTile metric={metric} tile={months(2)} now={NOW} minTrend={3} />);
    expect(trend()).toBeNull();
    cleanup();
    render(<MetricTile metric={metric} tile={months(3)} now={NOW} minTrend={3} />);
    expect(trend()).not.toBeNull();
  });

  test("the value stands without the line", () => {
    render(<MetricTile metric={metric} tile={months(3)} now={NOW} minTrend={Infinity} />);
    expect(trend()).toBeNull();
    expect(screen.getByText("12")).toBeTruthy();
  });
});
