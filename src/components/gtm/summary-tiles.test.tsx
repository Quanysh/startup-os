// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Tile } from "@/lib/metrics/scorecard";
import type { DealsCreated } from "@/lib/pipeline/created";
import { GtmSummary } from "./summary-tiles";

afterEach(cleanup);

// Wednesday 14 October 2026: this week began on Monday the 12th, last week on the 5th.
const NOW = Date.UTC(2026, 9, 14, 9);

const made = (key: string, points: [string, number][]): Tile => {
  const last = points.at(-1);
  return {
    key,
    scope: "us",
    firstPeriodStart: points[0]?.[0] ?? null,
    latest: last
      ? { value: last[1], periodStart: last[0], currency: null, source: "apollo", syncedAt: NOW }
      : null,
    series: points.map(([periodStart, value]) => ({ periodStart, value })),
  };
};
const NO_DEALS: DealsCreated = { total: 0, us: 0, kz: 0, kzMirrored: 0 };
const show = (
  series: { delivered?: [string, number][]; replied?: [string, number][] },
  dealsCreated: DealsCreated | "loading" = NO_DEALS,
) =>
  render(
    <GtmSummary
      now={NOW}
      dealsCreated={dealsCreated === "loading" ? undefined : dealsCreated}
      tiles={[
        made("outbound_delivered", series.delivered ?? []),
        made("outbound_replied", series.replied ?? []),
      ]}
    />,
  );
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const RATE = "Outbound reply rate";
const DELIVERED = "Delivered last week";
const PIPELINE = "Deals created, last four weeks";
const THREE_WEEKS: [string, number][] = [
  ["2026-09-28", 200],
  ["2026-10-05", 240],
  ["2026-10-12", 246],
];

describe("Outbound reply rate", () => {
  test("before Apollo's first read", () => {
    show({});
    expect(tile(RATE).getByText("No value yet")).toBeTruthy();
    expect(tile(RATE).getByText("Arrives with Apollo.")).toBeTruthy();
  });

  test("with nothing delivered there is no rate, and no 0%", () => {
    show({ delivered: [["2026-10-12", 0]], replied: [["2026-10-12", 0]] });
    const t = tile(RATE);
    expect(t.getByText("No outbound email has been delivered yet.")).toBeTruthy();
    expect(t.queryByText("0%")).toBeNull();
  });

  test("more replies than delivered is withheld", () => {
    show({ delivered: [["2026-10-12", 5]], replied: [["2026-10-12", 6]] });
    const t = tile(RATE);
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(
      t.getByText("Apollo reports more replies than emails delivered, so no rate is given."),
    ).toBeTruthy();
    expect(t.queryByText(/%/)).toBeNull();
  });

  test("a small sample shows the rate without a verdict", () => {
    show({ delivered: [["2026-10-12", 24]], replied: [["2026-10-12", 0]] });
    const t = tile(RATE);
    expect(t.getByText("0%")).toBeTruthy();
    expect(t.getByText("0 replies to 24 delivered, every sequence to date.")).toBeTruthy();
    expect(t.getByText("Under 100 delivered, so no benchmark verdict yet.")).toBeTruthy();
    expect(t.queryByRole("button")).toBeNull();
  });

  test("100 delivered or more carries the benchmark verdict", () => {
    show({ delivered: [["2026-10-12", 240]], replied: [["2026-10-12", 8]] });
    const t = tile(RATE);
    expect(t.getByText("3.3%")).toBeTruthy();
    // 3.3% is just under the typical band of 3.4–4.5%.
    expect(t.getByRole("button", { name: "Weaker than typical for seed" })).toBeTruthy();
    expect(t.getByText("8 replies to 240 delivered, every sequence to date.")).toBeTruthy();
    expect(t.queryByText(/no benchmark verdict/)).toBeNull();
  });

  test("one reply is singular", () => {
    show({ delivered: [["2026-10-12", 24]], replied: [["2026-10-12", 1]] });
    expect(tile(RATE).getByText("1 reply to 24 delivered, every sequence to date.")).toBeTruthy();
  });

  test("totals last read weeks ago say so", () => {
    show({ delivered: [["2026-09-28", 240]], replied: [["2026-09-28", 8]] });
    expect(
      tile(RATE).getByText("Out of date: Apollo was last read in the week of Sep 28."),
    ).toBeTruthy();
  });

  test("totals read this week are not called old", () => {
    show({ delivered: [["2026-10-12", 240]], replied: [["2026-10-12", 8]] });
    expect(tile(RATE).queryByText(/Out of date/)).toBeNull();
  });
});

describe("Delivered last week", () => {
  test("before Apollo's first read", () => {
    show({});
    expect(tile(DELIVERED).getByText("No value yet")).toBeTruthy();
    expect(tile(DELIVERED).getByText("Arrives with Apollo.")).toBeTruthy();
  });

  test("last week's figure, how it is measured, and this week so far", () => {
    show({ delivered: THREE_WEEKS });
    const t = tile(DELIVERED);
    expect(t.getByText("40")).toBeTruthy();
    expect(
      t.getByText(
        "The week of Oct 5, measured between that week's last daily read and the one before.",
      ),
    ).toBeTruthy();
    expect(t.getByText("This week so far: 6.")).toBeTruthy();
  });

  test("with only this week's total, it names the two weeks it needs and prints no number", () => {
    show({ delivered: [["2026-10-12", 246]] });
    const t = tile(DELIVERED);
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(
      t.getByText("Needs Apollo's totals from two weeks in a row: the weeks of Sep 28 and Oct 5."),
    ).toBeTruthy();
    expect(t.queryByText(/This week so far/)).toBeNull();
  });

  test("a week Apollo was not read in leaves a gap, not a zero or a two-week figure", () => {
    show({
      delivered: [
        ["2026-09-28", 200],
        ["2026-10-12", 246],
      ],
    });
    const t = tile(DELIVERED);
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(t.queryByText("46")).toBeNull();
    expect(t.queryByText(/This week so far/)).toBeNull();
  });

  test("a total that fell is explained, never shown as a negative", () => {
    show({
      delivered: [
        ["2026-09-28", 240],
        ["2026-10-05", 200],
      ],
    });
    const t = tile(DELIVERED);
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(
      t.getByText(
        "Apollo's total fell between the two weeks, as it does when a sequence is deleted, so no weekly figure is given.",
      ),
    ).toBeTruthy();
    expect(t.queryByText(/40/)).toBeNull();
  });
});

describe("Deals created, last four weeks", () => {
  const KZ_NOTE = "Kazakhstan deals count from when the CRM first listed them here.";

  test("while the counts are loading there is a placeholder, and no number or sentence", () => {
    const { container } = show({}, "loading");
    expect(screen.queryByRole("heading", { name: PIPELINE })).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText(/created in the last four weeks/)).toBeNull();
  });

  test("the count, with each market's share", () => {
    show({}, { total: 7, us: 3, kz: 4, kzMirrored: 0 });
    const t = tile(PIPELINE);
    expect(t.getByText("7")).toBeTruthy();
    expect(t.getByText("7 deals created in the last four weeks: 3 US, 4 Kazakhstan.")).toBeTruthy();
    expect(t.queryByText(KZ_NOTE)).toBeNull();
    // A count of deals, never a sum of money.
    expect(t.queryByText(/\$/)).toBeNull();
  });

  test("none is a real zero, said in words", () => {
    show({});
    const t = tile(PIPELINE);
    expect(t.getByText("0")).toBeTruthy();
    expect(t.getByText("No deals created in the last four weeks.")).toBeTruthy();
    expect(t.queryByText("No value yet")).toBeNull();
    expect(t.queryByText(KZ_NOTE)).toBeNull();
  });

  test("mirrored Kazakhstan deals carry a note on what their date means", () => {
    show({}, { total: 4, us: 0, kz: 4, kzMirrored: 4 });
    const t = tile(PIPELINE);
    expect(t.getByText("4 deals created in the last four weeks: 0 US, 4 Kazakhstan.")).toBeTruthy();
    expect(t.getByText(KZ_NOTE)).toBeTruthy();
  });
});
