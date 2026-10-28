// Company MRR in a one-company view: given that company's tiles alone it is
// that company's MRR, and the other market is never waited for.

import { describe, expect, test } from "vitest";
import { tilesOf } from "../company";
import type { Point } from "./derive";
import { companyMrr, type Tile } from "./scorecard";

const p = (periodStart: string, value: number): Point => ({ periodStart, value });
const series = (key: string, scope: string, points: Point[]): Tile => {
  const last = points.at(-1);
  return {
    key,
    scope,
    firstPeriodStart: points[0]?.periodStart ?? null,
    latest: last
      ? { value: last.value, periodStart: last.periodStart, currency: null, source: "test", syncedAt: 0 }
      : null,
    series: points,
  };
};

// The US is entered for October already; Kazakhstan's workbook stops at September.
const all = [
  series("mrr", "us", [p("2026-08-01", 5_000), p("2026-09-01", 5_000), p("2026-10-01", 6_000)]),
  series("mrr", "kz", [p("2026-08-01", 4_000_000), p("2026-09-01", 4_400_000)]),
  series("fx_usd_kzt", "company", [p("2026-08-01", 400), p("2026-09-01", 440)]),
];

describe("companyMrr given one company's tiles", () => {
  test("both companies together wait for Kazakhstan's October", () => {
    const mrr = companyMrr(all)!;
    expect(mrr.latest).toMatchObject({ periodStart: "2026-10-01", complete: false, missing: ["kz"] });
    expect(mrr.growthWithheld).toBe("partial");
  });

  test("the US alone: its own MRR and growth, and Kazakhstan is not missing", () => {
    const mrr = companyMrr(tilesOf("us", all))!;
    expect(mrr.latest).toMatchObject({
      periodStart: "2026-10-01",
      value: 6_000,
      complete: true,
      missing: [],
      parts: { us: 6_000, kz: null },
    });
    expect(mrr.growthPercent).toBeCloseTo(20);
    expect(mrr.previousPeriodStart).toBe("2026-09-01");
    expect(mrr.growthWithheld).toBeNull();
    expect(mrr.rate).toBeNull();
    expect(mrr.rateIsOld).toBe(false);
    expect(mrr.trend.map((point) => point.value)).toEqual([5_000, 5_000, 6_000]);
    expect(mrr.series.every((point) => point.complete && point.missing.length === 0)).toBe(true);
  });

  test("Kazakhstan alone: its own MRR converted, with growth, and the US is not missing", () => {
    const mrr = companyMrr(tilesOf("kz", all))!;
    expect(mrr.latest).toMatchObject({
      periodStart: "2026-09-01",
      complete: true,
      missing: [],
      rate: 440,
    });
    expect(mrr.latest.value).toBeCloseTo(10_000);
    expect(mrr.latest.parts.us).toBeNull();
    // 4,000,000 at 400 was 10,000 dollars too: flat in dollars.
    expect(mrr.growthPercent).toBeCloseTo(0);
    expect(mrr.growthWithheld).toBeNull();
    expect(mrr.series.every((point) => point.complete)).toBe(true);
  });

  test("Kazakhstan alone with no rate names the rate, never the US", () => {
    const mrr = companyMrr(tilesOf("kz", all).filter((tile) => tile.key !== "fx_usd_kzt"))!;
    expect(mrr.latest.missing).toEqual(["fx"]);
    expect(mrr.growthWithheld).toBe("partial");
  });

  describe("a market that arrived later is 'new_market' only where both are in view", () => {
    // Kazakhstan from August; the US figure first entered for October.
    const usLate = [
      series("mrr", "us", [p("2026-10-01", 6_000)]),
      series("mrr", "kz", [
        p("2026-08-01", 4_400_000),
        p("2026-09-01", 4_400_000),
        p("2026-10-01", 4_840_000),
      ]),
      series("fx_usd_kzt", "company", [p("2026-08-01", 440)]),
    ];

    test("both: October is the first month with every market in it", () => {
      expect(companyMrr(usLate)!.growthWithheld).toBe("new_market");
    });

    test("the US alone: October is simply its first month", () => {
      const mrr = companyMrr(tilesOf("us", usLate))!;
      expect(mrr.growthWithheld).toBe("no_previous");
      expect(mrr.latest.complete).toBe(true);
    });

    test("Kazakhstan alone: growth on September, as if the US had never been entered", () => {
      const mrr = companyMrr(tilesOf("kz", usLate))!;
      expect(mrr.growthWithheld).toBeNull();
      expect(mrr.growthPercent).toBeCloseTo(10);
      expect(mrr.trend).toHaveLength(3);
    });
  });

  test("a company with no MRR tile of its own has no figure, whatever the other holds", () => {
    const kzOnly = all.filter((tile) => tile.scope !== "us");
    expect(companyMrr(tilesOf("us", kzOnly))).toBeNull();
  });
});
