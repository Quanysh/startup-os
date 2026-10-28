import { describe, expect, test } from "vitest";
import { changeFromPrevious, combineInUsd } from "./derive";

const p = (periodStart: string, value: number) => ({ periodStart, value });

describe("changeFromPrevious", () => {
  test("compares the latest bucket with the one immediately before it", () => {
    const change = changeFromPrevious("month", [p("2026-09-01", 100), p("2026-10-01", 108)]);
    expect(change?.ratio).toBeCloseTo(0.08);
    expect(change?.previousPeriodStart).toBe("2026-09-01");
  });

  test("null when the preceding bucket is missing, rather than comparing across a gap", () => {
    expect(
      changeFromPrevious("month", [p("2026-07-01", 100), p("2026-10-01", 108)]),
    ).toBeNull();
  });

  test("null with fewer than two points", () => {
    expect(changeFromPrevious("month", [p("2026-10-01", 108)])).toBeNull();
    expect(changeFromPrevious("month", [])).toBeNull();
  });

  test("null when the previous value is zero", () => {
    expect(changeFromPrevious("month", [p("2026-09-01", 0), p("2026-10-01", 5)])).toBeNull();
  });

  test("works on weekly buckets", () => {
    const change = changeFromPrevious("week", [p("2026-10-05", 50), p("2026-10-12", 45)]);
    expect(change?.ratio).toBeCloseTo(-0.1);
  });
});

describe("combineInUsd", () => {
  // A market's series as the scorecard query returns it: the recent points
  // plus the first bucket it ever reported.
  const market = (points: { periodStart: string; value: number }[], first?: string | null) => ({
    points,
    firstPeriodStart: first === undefined ? (points[0]?.periodStart ?? null) : first,
  });
  const never = market([]);

  const usd = market([p("2026-09-01", 1_000), p("2026-10-01", 1_200)]);
  const kzt = market([p("2026-09-01", 4_400_000), p("2026-10-01", 5_000_000)]);
  const rates = [p("2026-09-01", 440), p("2026-10-01", 500)];

  const summary = (series: ReturnType<typeof combineInUsd>) =>
    series.map(({ periodStart, value, complete, missing }) => ({
      periodStart,
      value,
      complete,
      missing,
    }));

  test("adds dollars and converted tenge bucket by bucket", () => {
    expect(summary(combineInUsd(usd, kzt, rates))).toEqual([
      { periodStart: "2026-09-01", value: 11_000, complete: true, missing: [] },
      { periodStart: "2026-10-01", value: 11_200, complete: true, missing: [] },
    ]);
  });

  test("a month the US has not reported yet is partial, not a drop", () => {
    // September had both markets. October has Kazakhstan only so far.
    const series = combineInUsd(market([p("2026-09-01", 5_000)]), kzt, rates);
    expect(summary(series).at(-1)).toEqual({
      periodStart: "2026-10-01",
      value: 10_000,
      complete: false,
      missing: ["us"],
    });
  });

  test("a month Kazakhstan has not reported yet is partial, not a drop", () => {
    const series = combineInUsd(usd, market([p("2026-09-01", 4_400_000)]), rates);
    expect(summary(series).at(-1)).toEqual({
      periodStart: "2026-10-01",
      value: 1_200,
      complete: false,
      missing: ["kz"],
    });
  });

  test("a gap in the middle of a market's history is partial too", () => {
    const gappy = market([p("2026-08-01", 4_400_000), p("2026-10-01", 5_000_000)]);
    const series = combineInUsd(
      market([p("2026-08-01", 1_000), p("2026-09-01", 1_000), p("2026-10-01", 1_200)]),
      gappy,
      [p("2026-08-01", 440)],
    );
    expect(summary(series)[1]).toMatchObject({
      periodStart: "2026-09-01",
      complete: false,
      missing: ["kz"],
    });
  });

  test("a market that has never reported is not expected", () => {
    expect(summary(combineInUsd(usd, never, []))).toEqual([
      { periodStart: "2026-09-01", value: 1_000, complete: true, missing: [] },
      { periodStart: "2026-10-01", value: 1_200, complete: true, missing: [] },
    ]);
  });

  test("a market is not expected in months before its first report", () => {
    const lateStarter = market([p("2026-10-01", 880_000)]);
    const series = combineInUsd(usd, lateStarter, [p("2026-10-01", 440)]);
    expect(summary(series)[0]).toEqual({
      periodStart: "2026-09-01",
      value: 1_000,
      complete: true,
      missing: [],
    });
  });

  test("a month older than the points on hand is partial when the market had already started", () => {
    // The query returns only recent points. If a market's history began
    // earlier than the points we hold, its value for that month is unknown.
    const truncated = market([p("2026-10-01", 4_400_000)], "2026-01-01");
    const series = combineInUsd(usd, truncated, rates);
    expect(summary(series)[0]).toMatchObject({
      periodStart: "2026-09-01",
      complete: false,
      missing: ["kz"],
    });
  });

  test("uses the most recent rate at or before the bucket and says which", () => {
    const [point] = combineInUsd(never, market([p("2026-10-01", 880_000)]), [
      p("2026-08-01", 440),
    ]);
    expect(point).toMatchObject({
      value: 2_000,
      complete: true,
      rate: 440,
      ratePeriodStart: "2026-08-01",
    });
  });

  test("falls back to the earliest rate for buckets that predate every rate", () => {
    const [point] = combineInUsd(never, market([p("2026-08-01", 880_000)]), [
      p("2026-10-01", 440),
    ]);
    expect(point).toMatchObject({ value: 2_000, complete: true, ratePeriodStart: "2026-10-01" });
  });

  test("leaves tenge out and says the rate is missing when there is none", () => {
    expect(summary(combineInUsd(usd, kzt, []))).toEqual([
      { periodStart: "2026-09-01", value: 1_000, complete: false, missing: ["fx"] },
      { periodStart: "2026-10-01", value: 1_200, complete: false, missing: ["fx"] },
    ]);
  });

  test("no rate is reported for a bucket with no tenge in it", () => {
    const [point] = combineInUsd(market([p("2026-10-01", 1_200)]), never, rates);
    expect(point).toMatchObject({ rate: null, ratePeriodStart: null });
  });

  test("reports each market's dollars beside the total", () => {
    const [point] = combineInUsd(
      { points: [{ periodStart: "2026-10-01", value: 5_000 }], firstPeriodStart: "2026-10-01" },
      { points: [{ periodStart: "2026-10-01", value: 4_400_000 }], firstPeriodStart: "2026-10-01" },
      [{ periodStart: "2026-10-01", value: 440 }],
    );
    expect(point?.parts).toEqual({ us: 5_000, kz: 10_000 });
  });

  test("a market with no figure, or tenge with no rate, has no part rather than a zero", () => {
    const [noKz] = combineInUsd(
      { points: [{ periodStart: "2026-10-01", value: 5_000 }], firstPeriodStart: "2026-10-01" },
      { points: [], firstPeriodStart: "2026-09-01" },
      [],
    );
    expect(noKz?.parts).toEqual({ us: 5_000, kz: null });

    const [noRate] = combineInUsd(
      { points: [], firstPeriodStart: null },
      { points: [{ periodStart: "2026-10-01", value: 4_400_000 }], firstPeriodStart: "2026-10-01" },
      [],
    );
    expect(noRate?.parts).toEqual({ us: null, kz: null });
  });

  test("zero is a figure: a market that reported 0 has a part of 0, not none", () => {
    const [zeroUs] = combineInUsd(
      { points: [{ periodStart: "2026-10-01", value: 0 }], firstPeriodStart: "2026-10-01" },
      { points: [], firstPeriodStart: null },
      [],
    );
    expect(zeroUs?.parts).toEqual({ us: 0, kz: null });

    const [zeroKz] = combineInUsd(
      { points: [], firstPeriodStart: null },
      { points: [{ periodStart: "2026-10-01", value: 0 }], firstPeriodStart: "2026-10-01" },
      [{ periodStart: "2026-10-01", value: 440 }],
    );
    expect(zeroKz?.parts).toEqual({ us: null, kz: 0 });
    expect(zeroKz?.complete).toBe(true);
  });

  test("returns buckets oldest first", () => {
    const series = combineInUsd(
      market([p("2026-10-01", 1)]),
      market([p("2026-09-01", 440)]),
      [p("2026-09-01", 440)],
    );
    expect(series.map((s) => s.periodStart)).toEqual(["2026-09-01", "2026-10-01"]);
  });
});
