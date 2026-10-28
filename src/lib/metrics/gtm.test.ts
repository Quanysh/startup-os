import { describe, expect, test } from "vitest";
import { replyRate, weekDelta } from "./gtm";

const p = (periodStart: string, value: number) => ({ periodStart, value });

describe("replyRate", () => {
  test("replies over delivered, from the newest totals", () => {
    expect(
      replyRate(
        [p("2026-10-05", 200), p("2026-10-12", 240)],
        [p("2026-10-05", 6), p("2026-10-12", 8)],
      ),
    ).toEqual({
      kind: "value",
      percent: (8 * 100) / 240,
      delivered: 240,
      replied: 8,
      week: "2026-10-12",
    });
  });

  test("no totals, or delivered without that week's replies, is no rate", () => {
    expect(replyRate([], [])).toEqual({ kind: "none", reason: "no_data" });
    expect(replyRate([p("2026-10-12", 240)], [p("2026-10-05", 6)])).toEqual({
      kind: "none",
      reason: "no_data",
    });
  });

  test("nothing delivered is nothing to divide by, not a rate of zero", () => {
    expect(replyRate([p("2026-10-12", 0)], [p("2026-10-12", 0)])).toEqual({
      kind: "none",
      reason: "nothing_delivered",
    });
  });

  test("more replies than delivered is withheld", () => {
    expect(replyRate([p("2026-10-12", 5)], [p("2026-10-12", 6)])).toEqual({
      kind: "none",
      reason: "inconsistent",
    });
  });

  test("no reply to real sends is a true zero", () => {
    expect(replyRate([p("2026-10-12", 24)], [p("2026-10-12", 0)])).toMatchObject({
      kind: "value",
      percent: 0,
    });
  });
});

describe("weekDelta", () => {
  const totals = [p("2026-09-28", 200), p("2026-10-05", 240), p("2026-10-12", 246)];

  test("a week's own figure is its total less the week before's", () => {
    expect(weekDelta(totals, "2026-10-05")).toEqual({ kind: "value", value: 40 });
    expect(weekDelta(totals, "2026-10-12")).toEqual({ kind: "value", value: 6 });
  });

  test("a week with no total, or none the week before, has no figure: a gap is not a zero", () => {
    expect(weekDelta([], "2026-10-05")).toEqual({ kind: "none", reason: "no_data" });
    expect(weekDelta(totals, "2026-09-28")).toEqual({ kind: "none", reason: "no_previous" });
    // Two weeks apart is not "the week before".
    expect(weekDelta([p("2026-09-28", 200), p("2026-10-12", 246)], "2026-10-12")).toEqual({
      kind: "none",
      reason: "no_previous",
    });
  });

  test("a total that fell has no figure, never a negative one", () => {
    expect(weekDelta([p("2026-09-28", 240), p("2026-10-05", 200)], "2026-10-05")).toEqual({
      kind: "none",
      reason: "total_fell",
    });
  });
});
