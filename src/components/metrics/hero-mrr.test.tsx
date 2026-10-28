// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { getMetric } from "@convex/lib/metricRegistry";
import { supplyOf, type Tile } from "@/lib/metrics/scorecard";
import { HeroMrr } from "./hero-mrr";

afterEach(cleanup);

const series = (key: string, scope: string, points: [string, number][]): Tile => ({
  key,
  scope,
  latest: null,
  firstPeriodStart: points[0]?.[0] ?? null,
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});

const fx = series("fx_usd_kzt", "company", [["2026-09-01", 440]]);
const trend = () => screen.queryByRole("img", { name: /Company MRR over/ });

describe("HeroMrr", () => {
  test("with no figure at all, it asks for the US one and says Kazakhstan's comes from the workbook", () => {
    render(<HeroMrr tiles={[]} />);
    const copy = screen.getByText(/Enter this month's US figure/);
    expect(copy.textContent).toContain(
      "Enter this month's US figure to start the trend. Kazakhstan's arrives with the CFO workbook.",
    );
    expect(screen.getByRole("link", { name: "Add MRR" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
    // The copy above is only true while these hold; if ownership changes, this fails first.
    const mrr = getMetric("mrr")!;
    expect(supplyOf(mrr, "us").how).toBe("enter");
    expect(supplyOf(mrr, "kz").how).toBe("source");
  });

  test("one complete month draws no trend: a lone dot is not a trend", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(screen.getByText("$15.5K")).toBeTruthy();
    expect(trend()).toBeNull();
  });

  test("two complete months draw the trend", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(trend()?.getAttribute("aria-label")).toBe("Company MRR over 2 comparable months");
  });

  test("a month missing a market is marked partial and withholds growth", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-09-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(screen.getByText("partial")).toBeTruthy();
    expect(screen.getByText("Growth is shown once the month is complete.")).toBeTruthy();
    expect(screen.queryByText(/typical for seed/)).toBeNull();
  });

  test("with one month on record, growth is promised for next month", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(
      screen.getByText("Growth appears next month, once there are two months to compare."),
    ).toBeTruthy();
  });

  test("after a month at zero, it says there is no percentage, and promises nothing", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 0], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-09-01", 0], ["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(
      screen.getByText("The month before had no MRR, so there is no percentage to show."),
    ).toBeTruthy();
    expect(screen.queryByText(/Growth appears next month/)).toBeNull();
    expect(screen.queryByText(/typical for seed/)).toBeNull();
  });

  test("in a market's first month, growth is promised for next month and says why", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(
      screen.getByText(
        "Growth appears next month: this is the first month with every market in it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/two months to compare/)).toBeNull();
  });

  test("when last month was the partial one, growth waits for a complete figure", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-08-01", 4_400_000], ["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(
      screen.getByText("Growth appears once the previous month has a complete figure too."),
    ).toBeTruthy();
  });

  test("a missing Kazakhstan figure points at the workbook, not the entry form", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-09-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(
      screen.getByText(/Kazakhstan has no MRR figure for Oct 2026 yet\. It arrives with the CFO workbook\./),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "MRR figure" })).toBeNull();
  });

  test("a missing US figure still links to the entry form", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-09-01", 5_000]]),
          series("mrr", "kz", [["2026-09-01", 4_400_000], ["2026-10-01", 4_400_000]]),
          fx,
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "MRR figure" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
  });

  test("with no rate at all, the rate is awaited from the workbook, not asked for", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-10-01", 4_400_000]]),
        ]}
      />,
    );
    expect(
      screen.getByText("Kazakhstan is left out until a USD/KZT rate arrives with the CFO workbook."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "USD/KZT rate" })).toBeNull();
  });

  test("an old rate is renewed by the next workbook push", () => {
    render(
      <HeroMrr
        tiles={[
          series("mrr", "us", [["2026-10-01", 5_500]]),
          series("mrr", "kz", [["2026-10-01", 4_400_000]]),
          series("fx_usd_kzt", "company", [["2026-06-01", 440]]),
        ]}
      />,
    );
    expect(
      screen.getByText(
        "That rate is more than two months old. It is the company's last conversion; a newer one arrives with the CFO workbook.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "current rate" })).toBeNull();
  });
});
