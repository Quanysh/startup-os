// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { PipelineBoard, PipelineCard } from "@/lib/pipeline/derive";
import { SalesTiles } from "./sales-tiles";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);
const ago = (days: number) => NOW - days * DAY;

let next = 0;
const deal = (stage: string, extra: Partial<PipelineCard> = {}): PipelineCard => ({
  id: `d${next++}`,
  name: "Clinic",
  stage,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: null,
  ...extra,
});
const closed = (stage: "won" | "lost", n: number, daysAgo = 10) =>
  Array.from({ length: n }, () => deal(stage, { closedAt: ago(daysAgo) }));
const boardOf = (deals: PipelineCard[]): PipelineBoard => {
  const board: Record<string, PipelineCard[]> = {};
  for (const d of deals) (board[d.stage] ??= []).push(d);
  return board;
};
const show = (deals: PipelineCard[], market: "us" | "kz" = "us") =>
  render(<SalesTiles board={boardOf(deals)} market={market} now={NOW} />);
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);

describe("Open pipeline", () => {
  test("with no open deals it says so in words, not $0", () => {
    show([...closed("won", 1)]);
    const pipeline = tile("Open pipeline");
    expect(pipeline.getByText("No open deals")).toBeTruthy();
    expect(pipeline.getByText("Nothing is in Lead, Qualified, Demo or Proposal.")).toBeTruthy();
    expect(pipeline.queryByText("$0")).toBeNull();
  });

  test("the sum of monthly fees, and how many deals it is across", () => {
    show([deal("lead", { amount: 300 }), deal("demo", { amount: 450 }), deal("proposal", { amount: 750 })]);
    const pipeline = tile("Open pipeline");
    expect(pipeline.getByText("$1,500")).toBeTruthy();
    expect(pipeline.getByText("Monthly fees across 3 open deals, unweighted.")).toBeTruthy();
    expect(pipeline.queryByText("partial")).toBeNull();
  });

  test("one deal reads in the singular", () => {
    show([deal("demo", { amount: 450 })]);
    expect(tile("Open pipeline").getByText("Monthly fees across 1 open deal, unweighted.")).toBeTruthy();
  });

  test("deals without an amount make it partial and are counted, not added as zero", () => {
    show([deal("demo", { amount: 450 }), deal("lead"), deal("lead")]);
    const pipeline = tile("Open pipeline");
    expect(pipeline.getByText("$450")).toBeTruthy();
    expect(pipeline.getByText("partial")).toBeTruthy();
    expect(pipeline.getByText("Monthly fees across 1 of 3 open deals, unweighted.")).toBeTruthy();
    expect(pipeline.getByText("2 open deals have no amount and are left out.")).toBeTruthy();
  });

  test("one deal without an amount reads in the singular", () => {
    show([deal("demo", { amount: 450 }), deal("lead")]);
    expect(tile("Open pipeline").getByText("1 open deal has no amount and is left out.")).toBeTruthy();
  });

  test("when no open deal has an amount there is no value", () => {
    show([deal("lead"), deal("demo")]);
    const pipeline = tile("Open pipeline");
    expect(pipeline.getByText("No value yet")).toBeTruthy();
    expect(pipeline.getByText("None of the 2 open deals has an amount yet.")).toBeTruthy();
    expect(pipeline.queryByText("$0")).toBeNull();
  });

  test("a single open deal with no amount", () => {
    show([deal("lead")]);
    expect(tile("Open pipeline").getByText("The one open deal has no amount yet.")).toBeTruthy();
  });

  test("Kazakhstan's pipeline is in tenge", () => {
    show([deal("demo", { amount: 250_000 })], "kz");
    expect(tile("Open pipeline").getByText("₸250K")).toBeTruthy();
  });

  test("deals in a stage the OS does not know are said to be left out", () => {
    show([deal("demo", { amount: 450 }), deal("unmapped", { amount: 9_000 }), deal("unmapped")]);
    const pipeline = tile("Open pipeline");
    expect(pipeline.getByText("$450")).toBeTruthy();
    expect(
      pipeline.getByText("2 deals are in a stage the OS does not know and are left out."),
    ).toBeTruthy();
  });

  test("one unsorted deal reads in the singular, and shows with no open deals too", () => {
    show([deal("unmapped")]);
    expect(
      tile("Open pipeline").getByText("1 deal is in a stage the OS does not know and is left out."),
    ).toBeTruthy();
  });
});

describe("Win rate", () => {
  test("with nothing closed in the window there is no value, not 0%", () => {
    show([deal("demo"), ...closed("lost", 2, 400)]);
    const rate = tile("Win rate");
    expect(rate.getByText("No value yet")).toBeTruthy();
    expect(rate.getByText("No deal has closed in the last 180 days.")).toBeTruthy();
    expect(rate.queryByText("0%")).toBeNull();
  });

  test("under ten closed deals it shows the rate with no benchmark verdict", () => {
    show([...closed("won", 1), ...closed("lost", 3)]);
    const rate = tile("Win rate");
    expect(rate.getByText("25%")).toBeTruthy();
    expect(rate.getByText("1 won of 4 closed in the last 180 days.")).toBeTruthy();
    expect(
      rate.getByText("Too few to hold against a benchmark: that needs 10 closed deals."),
    ).toBeTruthy();
    expect(rate.queryByText(/for seed/i)).toBeNull();
  });

  test("from ten closed deals the US rate is held against the benchmark", () => {
    show([...closed("won", 2), ...closed("lost", 8)]);
    const rate = tile("Win rate");
    expect(rate.getByText("20%")).toBeTruthy();
    expect(rate.getByText("2 won of 10 closed in the last 180 days.")).toBeTruthy();
    expect(rate.getByText("Typical for seed")).toBeTruthy();
    expect(rate.queryByText(/Too few/)).toBeNull();
  });

  test("a real 0% is shown as 0%", () => {
    show([...closed("lost", 3)]);
    expect(tile("Win rate").getByText("0%")).toBeTruthy();
  });

  test("Kazakhstan never gets a benchmark verdict, or a remark about one", () => {
    // The published band is US and EU data.
    show([...closed("won", 2), ...closed("lost", 8)], "kz");
    const rate = tile("Win rate");
    expect(rate.getByText("20%")).toBeTruthy();
    expect(rate.queryByText(/for seed/i)).toBeNull();
    cleanup();
    show([...closed("won", 1), ...closed("lost", 1)], "kz");
    expect(tile("Win rate").queryByText(/benchmark/i)).toBeNull();
  });

  test("closed deals with no close date are said to be left out", () => {
    show([...closed("won", 1), deal("lost"), deal("won")]);
    const rate = tile("Win rate");
    expect(rate.getByText("100%")).toBeTruthy();
    expect(rate.getByText("2 closed deals have no close date and are left out.")).toBeTruthy();
    cleanup();
    show([deal("lost")]);
    expect(tile("Win rate").getByText("No value yet")).toBeTruthy();
    expect(
      tile("Win rate").getByText("1 closed deal has no close date and is left out."),
    ).toBeTruthy();
  });
});

describe("Coverage needed", () => {
  test("needs a win rate", () => {
    show([deal("demo", { amount: 450 })]);
    const coverage = tile("Coverage needed");
    expect(coverage.getByText("No value yet")).toBeTruthy();
    expect(coverage.getByText("Needs a win rate first.")).toBeTruthy();
  });

  test("with no wins it is said in words", () => {
    show([...closed("lost", 3)]);
    const coverage = tile("Coverage needed");
    expect(coverage.getByText("No wins yet")).toBeTruthy();
    expect(
      coverage.getByText("Nothing was won in the last 180 days, so there is no multiple to give."),
    ).toBeTruthy();
  });

  test("one over the win rate, and what today's pipeline closes at that rate", () => {
    show([...closed("won", 3), ...closed("lost", 9), deal("demo", { amount: 2_000 })]);
    const coverage = tile("Coverage needed");
    expect(coverage.getByText("4×")).toBeTruthy();
    expect(
      coverage.getByText("1 ÷ win rate: the open pipeline needed for each unit of new monthly fees."),
    ).toBeTruthy();
    expect(
      coverage.getByText("At that rate today's open pipeline closes about $500 a month."),
    ).toBeTruthy();
    expect(coverage.queryByText(/treat it as rough/)).toBeNull();
  });

  test("on few closed deals it says it is rough", () => {
    show([...closed("won", 1), ...closed("lost", 2)]);
    const coverage = tile("Coverage needed");
    expect(coverage.getByText("3×")).toBeTruthy();
    expect(coverage.getByText("Rests on 3 closed deals, so treat it as rough.")).toBeTruthy();
  });

  test("without a pipeline value it gives the multiple alone", () => {
    show([...closed("won", 1), ...closed("lost", 1), deal("lead")]);
    const coverage = tile("Coverage needed");
    expect(coverage.getByText("2×")).toBeTruthy();
    expect(coverage.queryByText(/closes about/)).toBeNull();
  });
});

describe("Gone quiet", () => {
  test("with no open deals", () => {
    show([...closed("won", 1)]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("None")).toBeTruthy();
    expect(quiet.getByText("There are no open deals.")).toBeTruthy();
  });

  test("none quiet", () => {
    show([deal("demo", { lastActivityAt: ago(14) }), deal("lead", { lastActivityAt: ago(1) })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("None")).toBeTruthy();
    expect(quiet.getByText("Every open deal had activity in the last 14 days.")).toBeTruthy();
  });

  test("how many, and the longest silence", () => {
    show([
      deal("demo", { lastActivityAt: ago(41) }),
      deal("lead", { lastActivityAt: ago(15) }),
      deal("lead", { lastActivityAt: ago(2) }),
    ]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("2")).toBeTruthy();
    expect(
      quiet.getByText("No activity for more than 14 days. Longest: 41 days."),
    ).toBeTruthy();
  });

  test("a deal with no activity date is not called quiet or active", () => {
    show([deal("demo", { lastActivityAt: ago(2) }), deal("lead", { lastActivityAt: null })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("None")).toBeTruthy();
    expect(
      quiet.getByText("Every open deal with an activity date had activity in the last 14 days."),
    ).toBeTruthy();
    expect(
      quiet.getByText("1 open deal has no activity date and cannot be judged."),
    ).toBeTruthy();
  });

  test("when no open deal has an activity date there is no number at all", () => {
    // "None" here would be reassurance the board cannot give.
    show([deal("demo", { lastActivityAt: null }), deal("lead", { lastActivityAt: null })], "kz");
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("No value yet")).toBeTruthy();
    expect(quiet.queryByText("None")).toBeNull();
    expect(
      quiet.getByText("None of the 2 open deals has an activity date, so none can be judged."),
    ).toBeTruthy();
    cleanup();
    show([deal("demo", { lastActivityAt: null })], "kz");
    expect(
      tile("Gone quiet").getByText("The one open deal has no activity date, so it cannot be judged."),
    ).toBeTruthy();
  });

  test("quiet deals and undated ones are both reported", () => {
    show([deal("demo", { lastActivityAt: ago(20) }), deal("lead", { lastActivityAt: null }), deal("lead", { lastActivityAt: null })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("1")).toBeTruthy();
    expect(
      quiet.getByText("2 open deals have no activity date and cannot be judged."),
    ).toBeTruthy();
  });
});
