import { describe, expect, test } from "vitest";
import { cashFlowRows, financingLeftOut } from "./finance-rows";

const p = (periodStart: string, value: number) => ({ periodStart, value });
// Mercury's last successful run: in October, after every earlier month ended.
const READ = Date.parse("2026-10-12T06:00:00Z");

describe("cashFlowRows", () => {
  test("one row per month in either series, oldest first", () => {
    expect(
      cashFlowRows(
        [p("2026-09-01", 5_000), p("2026-08-01", 4_000)],
        [p("2026-08-01", 20_000), p("2026-09-01", 25_000)],
        [],
        "2026-10-01",
        READ,
      ),
    ).toEqual([
      { periodStart: "2026-08-01", values: { in: 4_000, out: 20_000 } },
      { periodStart: "2026-09-01", values: { in: 5_000, out: 25_000 } },
    ]);
  });

  test("a series with no figure for a month is null there, not zero", () => {
    expect(cashFlowRows([], [p("2026-09-01", 25_000)], [], "2026-10-01", READ)).toEqual([
      { periodStart: "2026-09-01", values: { in: null, out: 25_000 } },
    ]);
  });

  test("the month in progress is marked, since its totals are still growing", () => {
    expect(cashFlowRows([p("2026-10-01", 1)], [p("2026-10-01", 2)], [], "2026-10-01", READ)).toEqual([
      { periodStart: "2026-10-01", values: { in: 1, out: 2 }, note: "so far" },
    ]);
  });

  describe("a month Mercury did not finish reading", () => {
    const ins = [p("2026-08-01", 4_000), p("2026-09-01", 3_000), p("2026-10-01", 1)];
    const outs = [p("2026-08-01", 20_000), p("2026-09-01", 15_000), p("2026-10-01", 2)];
    const notes = (readAt: number | null) =>
      cashFlowRows(ins, outs, [], "2026-10-01", readAt).map((row) => [row.periodStart, row.note]);

    test("is marked partial: its bars are short because the read was", () => {
      expect(notes(Date.parse("2026-09-20T06:00:00Z"))).toEqual([
        ["2026-08-01", undefined],
        ["2026-09-01", "partial"],
        ["2026-10-01", "so far"],
      ]);
    });

    test("a read at the start of the next month saw all of it", () => {
      expect(notes(Date.parse("2026-10-01T00:00:00Z"))[1]).toEqual(["2026-09-01", undefined]);
    });

    test("with no successful read on record, every past month is partial", () => {
      expect(notes(null)).toEqual([
        ["2026-08-01", "partial"],
        ["2026-09-01", "partial"],
        ["2026-10-01", "so far"],
      ]);
    });
  });
});

describe("cashFlowRows: financing is left out of cash in", () => {
  const ins = [p("2026-03-01", 503_000), p("2026-04-01", 3_000)];
  const outs = [p("2026-03-01", 20_000), p("2026-04-01", 21_000)];
  const march = (financing: number) =>
    cashFlowRows(ins, outs, [p("2026-03-01", financing)], "2026-10-01", READ)[0];

  test("a round does not flatten the other months: cash in is what came in beside it", () => {
    expect(
      cashFlowRows(ins, outs, [p("2026-03-01", 500_000)], "2026-10-01", READ),
    ).toEqual([
      { periodStart: "2026-03-01", values: { in: 3_000, out: 20_000 } },
      { periodStart: "2026-04-01", values: { in: 3_000, out: 21_000 } },
    ]);
  });

  test("financing equal to all the money in leaves a true zero, not a missing figure", () => {
    expect(march(503_000)).toEqual({ periodStart: "2026-03-01", values: { in: 0, out: 20_000 } });
  });

  test("financing larger than the money in cannot be true: no figure, and the month is partial", () => {
    expect(march(600_000)).toEqual({
      periodStart: "2026-03-01",
      values: { in: null, out: 20_000 },
      note: "partial",
    });
  });

  test("financing in a month with no cash in on record does not invent one", () => {
    expect(cashFlowRows([], outs, [p("2026-03-01", 500_000)], "2026-10-01", READ)[0]).toEqual({
      periodStart: "2026-03-01",
      values: { in: null, out: 20_000 },
    });
  });

  test("financing alone does not add a month to the chart", () => {
    expect(
      cashFlowRows(ins, outs, [p("2026-01-01", 500_000)], "2026-10-01", READ).map(
        (row) => row.periodStart,
      ),
    ).toEqual(["2026-03-01", "2026-04-01"]);
  });

  test("the month in progress stays 'so far' whatever its financing", () => {
    const row = cashFlowRows(
      [p("2026-10-01", 1_000)],
      [p("2026-10-01", 2_000)],
      [p("2026-10-01", 400)],
      "2026-10-01",
      READ,
    )[0];
    expect(row).toEqual({ periodStart: "2026-10-01", values: { in: 600, out: 2_000 }, note: "so far" });
  });
});

describe("financingLeftOut", () => {
  const rows = cashFlowRows(
    [p("2026-03-01", 503_000), p("2026-06-01", 23_000)],
    [p("2026-03-01", 20_000), p("2026-06-01", 21_000)],
    [],
    "2026-10-01",
    READ,
  );

  test("the financing recorded in the months on the chart, oldest first", () => {
    expect(
      financingLeftOut(rows, [p("2026-06-01", 20_000), p("2026-03-01", 500_000)]),
    ).toEqual([p("2026-03-01", 500_000), p("2026-06-01", 20_000)]);
  });

  test("a month that is not on the chart is not mentioned, nor is a zero", () => {
    expect(
      financingLeftOut(rows, [p("2025-01-01", 900_000), p("2026-06-01", 0)]),
    ).toEqual([]);
  });
});
