// The finance math for one company's view: only the markets in view are
// expected, required or read. The both-markets behaviour is in finance.test.ts.

import { describe, expect, test } from "vitest";
import type { Point } from "./derive";
import { cashNow, financeSummary, moneyTilesOf, monthGaps } from "./finance";
import type { Tile } from "./scorecard";

const p = (periodStart: string, value: number): Point => ({ periodStart, value });
const OCT = "2026-10-01";
const US = ["us"] as const;
const KZ = ["kz"] as const;

const series = (key: string, scope: string, points: Point[], currency = "USD"): Tile => {
  const last = points.at(-1);
  return {
    key,
    scope,
    firstPeriodStart: points[0]?.periodStart ?? null,
    latest: last
      ? { value: last.value, periodStart: last.periodStart, currency, source: "test", syncedAt: 0 }
      : null,
    series: points,
  };
};
const months = ["2026-07-01", "2026-08-01", "2026-09-01", OCT];
const mrrMonths = ["2026-06-01", ...months];
// The US burns 20,000 dollars a month and its MRR grows 1,000 a month.
const usTiles = [
  series("cash_in", "us", months.map((m) => p(m, 5_000))),
  series("cash_out", "us", months.map((m) => p(m, 25_000))),
  series("cash", "us", [p("2026-10-12", 400_000)]),
  series("mrr", "us", mrrMonths.map((m, i) => p(m, 5_000 + 1_000 * i))),
];
// Kazakhstan's MRR grows 220,000 tenge (500 dollars) a month.
const kzTiles = [
  series("cash", "kz", [p("2026-09-30", 4_400_000)], "KZT"),
  series("fx_usd_kzt", "company", [p("2026-06-01", 440)]),
  series("mrr", "kz", mrrMonths.map((m, i) => p(m, 4_400_000 + 220_000 * i)), "KZT"),
];
const tiles = [...usTiles, ...kzTiles];
// What Startup sent Globex, by month (Mercury's `cash_to_subsidiary`, dollars):
// nothing, here. Globex's own burn reads it; a viewer on Globex alone is
// never sent it.
const nothingSent = series("cash_to_subsidiary", "us", months.map((m) => p(m, 0)));
const kzView = [...kzTiles, nothingSent];
// Mercury's last successful run: after September ended, so Jul-Sep are whole.
const READ = Date.parse("2026-10-12T06:00:00Z");
// Kazakhstan's balance falls 440,000 tenge (1,000 dollars) a month.
const kzCash = [
  p("2026-06-30", 5_720_000),
  p("2026-07-31", 5_280_000),
  p("2026-08-31", 4_840_000),
  p("2026-09-30", 4_400_000),
];

describe("cashNow for the markets in view", () => {
  const fx = [p("2026-09-01", 440)];
  const us = p("2026-10-12", 400_000);
  const kz = p("2026-09-30", 4_400_000);

  test("the US alone: its balance is the total, and no rate is used or missed", () => {
    expect(cashNow(us, kz, [], US)).toEqual({
      usd: 400_000,
      parts: [{ scope: "us", native: 400_000, usd: 400_000, periodStart: "2026-10-12" }],
      missing: [],
      rate: null,
      ratePeriodStart: null,
    });
  });

  test("the US alone with no US balance is no figure, whatever Kazakhstan holds", () => {
    expect(cashNow(null, kz, fx, US)).toBeNull();
  });

  test("Kazakhstan alone: its balance converted, and the US is not missing", () => {
    const result = cashNow(null, kz, fx, KZ);
    expect(result?.usd).toBeCloseTo(10_000);
    expect(result?.missing).toEqual([]);
    expect(result?.rate).toBe(440);
    expect(result?.ratePeriodStart).toBe("2026-09-01");
    expect(result?.parts.map((part) => part.scope)).toEqual(["kz"]);
  });

  test("Kazakhstan alone ignores a US balance that is passed in", () => {
    expect(cashNow(us, kz, fx, KZ)?.usd).toBeCloseTo(10_000);
    expect(cashNow(us, null, fx, KZ)).toBeNull();
  });

  test("Kazakhstan alone with no rate has no dollars, and names only the rate", () => {
    expect(cashNow(us, kz, [], KZ)).toMatchObject({ parts: [], missing: ["fx"], rate: null });
  });

  test("with no markets given it is both, as before", () => {
    expect(cashNow(us, null, fx)).toEqual(cashNow(us, null, fx, ["us", "kz"]));
    expect(cashNow(us, null, fx)?.missing).toEqual(["kz"]);
  });
});

describe("the tiles one company's money math reads", () => {
  const all = [...tiles, nothingSent];
  const keys = (kept: Tile[]) => kept.map((t) => `${t.key}:${t.scope}`);

  test("Globex's keeps what Startup sent it, for a viewer on Startup as well", () => {
    expect(keys(moneyTilesOf("kz", all, ["us", "kz"]))).toEqual([
      "cash:kz",
      "fx_usd_kzt:company",
      "mrr:kz",
      "cash_to_subsidiary:us",
    ]);
  });

  test("for a viewer on Globex alone, nothing of Startup's is kept, that figure included", () => {
    expect(keys(moneyTilesOf("kz", all, ["kz"]))).toEqual(["cash:kz", "fx_usd_kzt:company", "mrr:kz"]);
  });

  test("Startup's is its own, the figure of what it sent among them; no company keeps everything", () => {
    expect(keys(moneyTilesOf("us", all, ["us", "kz"]))).toEqual([
      "cash_in:us",
      "cash_out:us",
      "cash:us",
      "mrr:us",
      "cash_to_subsidiary:us",
    ]);
    expect(moneyTilesOf(null, all, ["us", "kz"])).toEqual(all);
  });
});

describe("financeSummary for the markets in view", () => {
  test("with no markets given it is both, and says so", () => {
    const summary = financeSummary(tiles, kzCash, OCT, READ);
    expect(summary.markets).toEqual(["us", "kz"]);
    expect(summary).toEqual(financeSummary(tiles, kzCash, OCT, READ, ["us", "kz"]));
    expect(summary.average?.value).toBeCloseTo(21_000);
  });

  describe("the US alone", () => {
    test("burn is Mercury's flows, cash the US balance, and nothing waits for Kazakhstan", () => {
      // No Kazakhstan figure of any kind: in a both-markets view this withholds everything.
      const summary = financeSummary(usTiles, [], OCT, READ, US);
      expect(summary.markets).toEqual(["us"]);
      expect(summary.coverage.us).toBe(true);
      expect(summary.burn.map((b) => [b.periodStart, b.value, b.complete, b.missing])).toEqual([
        ["2026-07-01", 20_000, true, []],
        ["2026-08-01", 20_000, true, []],
        ["2026-09-01", 20_000, true, []],
      ]);
      expect(summary.average?.value).toBe(20_000);
      expect(summary.average?.months).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
      expect(summary.cash).toMatchObject({ usd: 400_000, missing: [], rate: null });
      expect(summary.runway).toEqual({ kind: "months", months: 20 });
      // 60,000 burned over Jul-Sep; MRR 5,000 in June to 8,000 in September.
      expect(summary.burnMultiple).toEqual({
        kind: "value",
        value: expect.closeTo(60_000 / 36_000),
        months: 3,
        from: "2026-07-01",
        to: "2026-09-01",
      });
      expect(monthGaps(summary)).toEqual([]);
    });

    test("Kazakhstan's figures are ignored even when they are passed in", () => {
      const alone = financeSummary(usTiles, [], OCT, READ, US);
      const beside = financeSummary(tiles, kzCash, OCT, READ, US);
      expect(beside).toEqual(alone);
      expect(beside.burn.every((b) => b.parts.kz === null && b.rate === null)).toBe(true);
      expect(beside.mrr?.latest.parts.kz).toBeNull();
      expect(beside.mrr?.rate).toBeNull();
      expect(beside.kzClosedMonths).toEqual([]);
      expect(beside.lateCloses).toEqual([]);
      expect(beside.coverage.kz).toBe(false);
    });

    test("a Kazakhstan balance typed late is not a late close here", () => {
      const late = [...kzCash.slice(0, 3), p("2026-10-02", 4_400_000)];
      expect(financeSummary(tiles, late, OCT, READ).lateCloses).toHaveLength(1);
      expect(financeSummary(tiles, late, OCT, READ, US).lateCloses).toEqual([]);
    });

    test("with no month Mercury has read whole, burn is withheld and only the US is uncovered", () => {
      const summary = financeSummary(usTiles, [], OCT, null, US);
      expect(summary.coverage.us).toBe(false);
      expect(summary.average).toBeNull();
      expect(summary.runway).toBeNull();
      expect(summary.burnMultiple).toBeNull();
      expect(summary.cash?.missing).toEqual([]);
    });

    test("a month Mercury has no row for lacks the US figure, and never Kazakhstan's", () => {
      const holed = usTiles.map((t) =>
        t.key === "cash_out"
          ? series("cash_out", "us", t.series.filter((x) => x.periodStart !== "2026-08-01"))
          : t,
      );
      const summary = financeSummary(holed, [], OCT, READ, US);
      expect(monthGaps(summary)).toEqual([{ month: "2026-08-01", lacks: ["us"] }]);
      expect(summary.average?.months).toEqual(["2026-07-01", "2026-09-01"]);
    });

    test("a month from before Mercury's first lacks the US figure, not 'everything'", () => {
      const fromAugust = usTiles.map((t) =>
        t.key === "cash_in" || t.key === "cash_out"
          ? series(t.key, "us", t.series.filter((x) => x.periodStart !== "2026-07-01"))
          : t,
      );
      expect(monthGaps(financeSummary(fromAugust, [], OCT, READ, US))).toEqual([
        { month: "2026-07-01", lacks: ["us"] },
      ]);
    });

    test("a short US month is explained once, and not listed as a gap", () => {
      const summary = financeSummary(usTiles, [], OCT, Date.parse("2026-09-20T06:00:00Z"), US);
      expect(summary.unfinishedUsMonths).toEqual(["2026-09-01"]);
      expect(summary.average?.months).toEqual(["2026-07-01", "2026-08-01"]);
      expect(monthGaps(summary)).toEqual([]);
    });
  });

  describe("Kazakhstan alone", () => {
    test("burn is from its month-end balances, cash its balance converted, nothing waits for the US", () => {
      // No US flow and no US balance: in a both-markets view this withholds everything.
      const summary = financeSummary(kzView, kzCash, OCT, READ, KZ);
      expect(summary.markets).toEqual(["kz"]);
      expect(summary.coverage.kz).toBe(true);
      expect(summary.burn.map((b) => [b.periodStart, b.complete, b.missing, b.parts.us])).toEqual([
        ["2026-07-01", true, [], null],
        ["2026-08-01", true, [], null],
        ["2026-09-01", true, [], null],
      ]);
      expect(summary.average?.value).toBeCloseTo(1_000);
      expect(summary.cash?.usd).toBeCloseTo(10_000);
      expect(summary.cash?.missing).toEqual([]);
      expect(summary.cash?.rate).toBe(440);
      expect(summary.runway).toEqual({ kind: "months", months: expect.closeTo(10) });
      // 3,000 dollars burned over Jul-Sep; MRR up 1,500 dollars from June to September.
      expect(summary.burnMultiple).toEqual({
        kind: "value",
        value: expect.closeTo(3_000 / 18_000),
        months: 3,
        from: "2026-07-01",
        to: "2026-09-01",
      });
      expect(monthGaps(summary)).toEqual([]);
    });

    test("the US's figures are ignored even when they are passed in, but for what Startup sent", () => {
      const alone = financeSummary(kzView, kzCash, OCT, READ, KZ);
      // August's US financing cannot be true, and the US burn and balance are there.
      const troubled = [...tiles, nothingSent, series("financing_in", "us", [p("2026-08-01", 500_000)])];
      const beside = financeSummary(troubled, kzCash, OCT, READ, KZ);
      expect(beside).toEqual(alone);
      expect(beside.unfinishedUsMonths).toEqual([]);
      expect(beside.financingProblems).toEqual([]);
      expect(beside.usFlowsReadAt).toBeNull();
      expect(beside.coverage.us).toBe(false);
      expect(beside.mrr?.latest.parts.us).toBeNull();
    });

    describe("Startup's funding is Globex's financing, never its income", () => {
      // At ₸440 per $1. Startup sends $1,000 in August: ₸440,000 that lifted the
      // balance, so August's own burn is the ₸440,000 fall plus that.
      const sent = (points: Point[]) => series("cash_to_subsidiary", "us", points);
      const funded = [...kzTiles, sent([p("2026-07-01", 0), p("2026-08-01", 1_000), p("2026-09-01", 0)])];

      test("what Startup sent is taken out as financing, in tenge at the newest stored rate", () => {
        const summary = financeSummary(funded, kzCash, OCT, READ, KZ);
        expect(summary.burn.map((b) => [b.periodStart, b.value, b.complete])).toEqual([
          ["2026-07-01", expect.closeTo(1_000), true],
          ["2026-08-01", expect.closeTo(2_000), true],
          ["2026-09-01", expect.closeTo(1_000), true],
        ]);
        expect(summary.average?.value).toBeCloseTo(4_000 / 3);
        expect(summary.funding).toEqual({ side: "subsidiary", perMonth: 1_000 / 3, hidden: false, gaps: [] });
        expect(monthGaps(summary)).toEqual([]);
      });

      test("the newest rate converts every month's funding, the one the group adds with", () => {
        const rates = series("fx_usd_kzt", "company", [p("2026-06-01", 440), p("2026-10-01", 500)]);
        const later = [...funded.filter((t) => t.key !== "fx_usd_kzt"), rates];
        const summary = financeSummary(later, kzCash, OCT, READ, KZ);
        // August's own burn: ₸440,000 fallen + $1,000 at ₸500 = ₸940,000, in dollars at August's ₸440.
        expect(summary.burn.find((b) => b.periodStart === "2026-08-01")?.value).toBeCloseTo(940_000 / 440);
      });

      test("typed outside financing is still taken out beside it", () => {
        const both = [...funded, series("financing_in", "kz", [p("2026-08-01", 220_000)], "KZT")];
        expect(financeSummary(both, kzCash, OCT, READ, KZ).burn[1]?.value).toBeCloseTo(2_500);
      });

      test("a month with balances and no figure of what was sent is not known, never as if nothing were", () => {
        const holed = [...kzTiles, sent([p("2026-07-01", 0), p("2026-09-01", 0)])];
        const summary = financeSummary(holed, kzCash, OCT, READ, KZ);
        expect(summary.average?.months).toEqual(["2026-07-01", "2026-09-01"]);
        expect(summary.funding).toEqual({ side: "subsidiary", perMonth: 0, hidden: false, gaps: [{ month: "2026-08-01", lacks: "sent" }] });
        expect(monthGaps(summary)).toEqual([{ month: "2026-08-01", lacks: ["sent"] }]);
        // Coverage is the balances': two month-ends in a row are there.
        expect(summary.coverage.kz).toBe(true);
      });

      test("a month Mercury read before it ended holds part of what was sent: not known", () => {
        const summary = financeSummary(funded, kzCash, OCT, Date.parse("2026-09-20T06:00:00Z"), KZ);
        expect(summary.average?.months).toEqual(["2026-07-01", "2026-08-01"]);
        expect(monthGaps(summary)).toEqual([{ month: "2026-09-01", lacks: ["sent"] }]);
        // With no successful Mercury run on record, no month of it is whole.
        expect(financeSummary(funded, kzCash, OCT, null, KZ).average).toBeNull();
      });

      test("dollars sent and no rate to put them in tenge: that month waits for the rate", () => {
        const noRate = funded.filter((t) => t.key !== "fx_usd_kzt");
        const summary = financeSummary(noRate, kzCash, OCT, READ, KZ);
        expect(summary.funding).toEqual({ side: "subsidiary", perMonth: null, hidden: false, gaps: [{ month: "2026-08-01", lacks: "fx" }] });
        expect(monthGaps(summary).find((gap) => gap.month === "2026-08-01")).toEqual({ month: "2026-08-01", lacks: ["fx"] });
      });

      test("a viewer who may not see what Startup sent has no Globex burn: it is not worked out without it", () => {
        // A viewer on Globex alone is never sent Startup's figures, this one included.
        const summary = financeSummary(kzTiles, kzCash, OCT, READ, KZ);
        expect(summary.funding).toEqual({
          side: "subsidiary",
          perMonth: null,
          hidden: true,
          gaps: ["2026-07-01", "2026-08-01", "2026-09-01"].map((month) => ({ month, lacks: "sent" })),
        });
        expect(summary.coverage.kz).toBe(true);
        expect(summary.average).toBeNull();
        expect(summary.runway).toBeNull();
      });

      test("with both markets in view nothing changes: the funding cancels in the two companies' figure", () => {
        const withSent = [...tiles, sent([p("2026-07-01", 0), p("2026-08-01", 1_000), p("2026-09-01", 0)])];
        const both = financeSummary(withSent, kzCash, OCT, READ);
        expect(both).toEqual(financeSummary(tiles, kzCash, OCT, READ));
        expect(both.funding).toBeNull();
      });

      test("Startup's own view keeps the bank's total and says how much of it went to Globex", () => {
        const withSent = [...usTiles, sent([p("2026-07-01", 3_000), p("2026-08-01", 6_000), p("2026-09-01", 0)])];
        const summary = financeSummary(withSent, [], OCT, READ, US);
        expect(summary.average?.value).toBe(20_000);
        expect(summary.funding).toEqual({ side: "parent", perMonth: 3_000 });
        // A month of the average with no figure of it: how much is not known.
        const holed = [...usTiles, sent([p("2026-07-01", 3_000), p("2026-09-01", 0)])];
        expect(financeSummary(holed, [], OCT, READ, US).funding).toEqual({ side: "parent", perMonth: null });
      });
    });

    test("with one close there is no burn yet, and only Kazakhstan is uncovered", () => {
      const summary = financeSummary(kzView, kzCash.slice(-1), OCT, READ, KZ);
      expect(summary.coverage.kz).toBe(false);
      expect(summary.average).toBeNull();
      expect(summary.runway).toBeNull();
      expect(summary.burnMultiple).toBeNull();
      expect(summary.cash?.missing).toEqual([]);
    });

    test("a month lacks its own close or the one before it, and never the US figure", () => {
      // Closes for August and September only.
      const summary = financeSummary(kzView, kzCash.slice(-2), OCT, READ, KZ);
      expect(summary.average?.months).toEqual(["2026-09-01"]);
      expect(monthGaps(summary)).toEqual([
        { month: "2026-07-01", lacks: ["kz"] },
        { month: "2026-08-01", lacks: ["kz_before"] },
      ]);
    });

    test("with no rate the tenge cannot be dollars: burn and cash are withheld, and the rate named", () => {
      const noRate = kzView.filter((t) => t.key !== "fx_usd_kzt");
      const summary = financeSummary(noRate, kzCash, OCT, READ, KZ);
      expect(summary.average).toBeNull();
      expect(summary.cash?.missing).toEqual(["fx"]);
      expect(summary.runway).toBeNull();
      expect(monthGaps(summary)).toEqual([
        { month: "2026-07-01", lacks: ["fx"] },
        { month: "2026-08-01", lacks: ["fx"] },
        { month: "2026-09-01", lacks: ["fx"] },
      ]);
    });
  });
});
