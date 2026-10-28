// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Tile } from "@/lib/metrics/scorecard";
import { MarketingSummary } from "./summary-tiles";

afterEach(cleanup);

// Wednesday 14 October 2026: the week in progress began on Monday the 12th.
const NOW = Date.UTC(2026, 9, 14, 9);

const made = (key: string, points: [string, number][]): Tile => {
  const last = points.at(-1);
  return {
    key,
    scope: "company",
    firstPeriodStart: points[0]?.[0] ?? null,
    latest: last
      ? {
          value: last[1],
          periodStart: last[0],
          currency: null,
          source: "search_console",
          syncedAt: NOW,
        }
      : null,
    series: points.map(([periodStart, value]) => ({ periodStart, value })),
  };
};
const show = (series: { clicks?: [string, number][]; impressions?: [string, number][] }) =>
  render(
    <MarketingSummary
      now={NOW}
      posthogReadAt={null}
      tiles={[
        made("search_clicks", series.clicks ?? []),
        made("search_impressions", series.impressions ?? []),
      ]}
    />,
  );
const tile = () =>
  within(screen.getByRole("heading", { name: "Search click-through rate" }).closest("article")!);

describe("Search click-through rate", () => {
  test("before Search Console has a finished week, it says so and states the lag", () => {
    show({});
    const t = tile();
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(t.getByText("Arrives with Search Console.")).toBeTruthy();
    expect(
      t.getByText(
        "Google's figures arrive 2–3 days late, so a week appears once Google has finished it.",
      ),
    ).toBeTruthy();
    expect(t.queryByText(/%/)).toBeNull();
  });

  test("the rate, what it is of, and the lag, with no benchmark", () => {
    show({ clicks: [["2026-09-28", 105]], impressions: [["2026-09-28", 2100]] });
    const t = tile();
    expect(t.getByText("5%")).toBeTruthy();
    expect(t.getByText("105 clicks from 2,100 impressions, the week of Sep 28.")).toBeTruthy();
    expect(
      t.getByText(
        "Google's figures arrive 2–3 days late, so this is the last week Google has finished.",
      ),
    ).toBeTruthy();
    expect(t.queryByRole("button")).toBeNull();
    expect(t.queryByText(/Out of date/)).toBeNull();
  });

  test("one click is singular", () => {
    show({ clicks: [["2026-09-28", 1]], impressions: [["2026-09-28", 40]] });
    expect(tile().getByText("1 click from 40 impressions, the week of Sep 28.")).toBeTruthy();
  });

  test("the week in progress is never the week shown", () => {
    show({
      clicks: [["2026-09-28", 105], ["2026-10-12", 1]],
      impressions: [["2026-09-28", 2100], ["2026-10-12", 2]],
    });
    expect(tile().getByText("5%")).toBeTruthy();
    expect(tile().queryByText("50%")).toBeNull();
  });

  test("an old week says it is old", () => {
    show({ clicks: [["2026-09-14", 84]], impressions: [["2026-09-14", 1680]] });
    expect(tile().getByText("Out of date: nothing newer than the week of Sep 14.")).toBeTruthy();
  });
});
