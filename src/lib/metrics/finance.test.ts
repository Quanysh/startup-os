import { describe, expect, test } from "vitest";
import type { CombinedPoint, Point } from "./derive";
import {
  averageBurn,
  burnFromBalances,
  burnFromFlows,
  burnMultiple,
  cashNow,
  financeSummary,
  monthCloses,
  monthGaps,
  runway,
} from "./finance";
import type { Tile } from "./scorecard";

const p = (periodStart: string, value: number): Point => ({ periodStart, value });
const OCT = "2026-10-01";
/** A month close: the month, its balance, and the day the balance is dated. */
const close = (periodStart: string, value: number, date: string) => ({ periodStart, value, date });

/** A company-level month, complete unless said otherwise. */
const month = (periodStart: string, value: number, complete = true): CombinedPoint => ({
  periodStart,
  value,
  complete,
  missing: complete ? [] : ["kz"],
  rate: null,
  ratePeriodStart: null,
  parts: { us: value, kz: null },
});

describe("monthCloses", () => {
  test("a balance dated the last day of a month closes it", () => {
    expect(monthCloses([p("2026-09-30", 70), p("2026-08-31", 100)])).toEqual([
      close("2026-08-01", 100, "2026-08-31"),
      close("2026-09-01", 70, "2026-09-30"),
    ]);
  });

  test("a balance typed in the first days of a month closes the month before", () => {
    // The entry form defaults to today, so this is how it usually arrives.
    expect(monthCloses([p("2026-09-02", 100), p("2026-10-03", 70)])).toEqual([
      close("2026-08-01", 100, "2026-09-02"),
      close("2026-09-01", 70, "2026-10-03"),
    ]);
  });

  test("a balance from the middle of a month closes nothing", () => {
    expect(monthCloses([p("2026-09-15", 80)])).toEqual([]);
    expect(monthCloses([p("2026-10-04", 80)])).toEqual([]);
    expect(monthCloses([p("2026-09-27", 80)])).toEqual([]);
  });

  test("the balance nearest the month end wins", () => {
    expect(monthCloses([p("2026-10-02", 65), p("2026-09-30", 70), p("2026-09-28", 75)])).toEqual([
      close("2026-09-01", 70, "2026-09-30"),
    ]);
  });

  test("a day before the month end beats a day after it", () => {
    expect(monthCloses([p("2026-10-01", 65), p("2026-09-29", 75)])).toEqual([
      close("2026-09-01", 75, "2026-09-29"),
    ]);
  });

  test("February closes on its own last day", () => {
    expect(monthCloses([p("2027-02-28", 50)])).toEqual([close("2027-02-01", 50, "2027-02-28")]);
  });
});

describe("burnFromFlows", () => {
  test("money out, less money in", () => {
    expect(burnFromFlows([p("2026-09-01", 5_000)], [p("2026-09-01", 30_000)], [])).toEqual([
      p("2026-09-01", 25_000),
    ]);
  });

  test("an investor's wire is not income: financing is taken back out", () => {
    expect(
      burnFromFlows(
        [p("2026-08-01", 100_000)],
        [p("2026-08-01", 30_000)],
        [p("2026-08-01", 100_000)],
      ),
    ).toEqual([p("2026-08-01", 30_000)]);
  });

  test("a month that made money burns a negative amount", () => {
    expect(burnFromFlows([p("2026-09-01", 40_000)], [p("2026-09-01", 30_000)], [])).toEqual([
      p("2026-09-01", -10_000),
    ]);
  });

  test("a month with only one of the two flows has no burn figure", () => {
    expect(burnFromFlows([], [p("2026-09-01", 30_000)], [])).toEqual([]);
  });

  test("a month that took in nothing still has a burn figure: zero is a number", () => {
    expect(burnFromFlows([p("2026-09-01", 0)], [p("2026-09-01", 30_000)], [])).toEqual([
      p("2026-09-01", 30_000),
    ]);
  });

  test("financing larger than all the money in cannot be true, so there is no figure", () => {
    expect(
      burnFromFlows(
        [p("2026-08-01", 5_000)],
        [p("2026-08-01", 25_000)],
        [p("2026-08-01", 500_000)],
      ),
    ).toEqual([]);
  });

  test("financing equal to the money in is fine: the month burned what went out", () => {
    expect(
      burnFromFlows([p("2026-08-01", 5_000)], [p("2026-08-01", 25_000)], [p("2026-08-01", 5_000)]),
    ).toEqual([p("2026-08-01", 25_000)]);
  });
});

describe("burnFromBalances", () => {
  test("how far the balance fell", () => {
    expect(
      burnFromBalances([p("2026-07-01", 10_000_000), p("2026-08-01", 8_000_000)], []),
    ).toEqual([p("2026-08-01", 2_000_000)]);
  });

  test("financing that propped the balance up is added back", () => {
    expect(
      burnFromBalances(
        [p("2026-08-01", 8_000_000), p("2026-09-01", 9_000_000)],
        [p("2026-09-01", 2_000_000)],
      ),
    ).toEqual([p("2026-09-01", 1_000_000)]);
  });

  test("a month whose previous close is missing has no burn figure", () => {
    expect(
      burnFromBalances([p("2026-07-01", 10_000_000), p("2026-09-01", 9_000_000)], []),
    ).toEqual([]);
  });

  test("an empty account is a balance: a close of 0 burned everything that was there", () => {
    expect(burnFromBalances([p("2026-07-01", 10_000_000), p("2026-08-01", 0)], [])).toEqual([
      p("2026-08-01", 10_000_000),
    ]);
  });

  test("a previous close of 0 is a balance too", () => {
    expect(burnFromBalances([p("2026-07-01", 0), p("2026-08-01", 0)], [])).toEqual([
      p("2026-08-01", 0),
    ]);
  });
});

describe("averageBurn", () => {
  const EXPECTED = ["2026-07-01", "2026-08-01", "2026-09-01"];

  test("the mean of the three months before the current one", () => {
    expect(
      averageBurn(
        [month("2026-07-01", 30_000), month("2026-08-01", 20_000), month("2026-09-01", 10_000)],
        OCT,
      ),
    ).toEqual({ value: 20_000, months: EXPECTED, expected: EXPECTED });
  });

  test("a partial month is left out of the mean, and the result says so", () => {
    const result = averageBurn(
      [
        month("2026-07-01", 30_000),
        month("2026-08-01", 20_000),
        month("2026-09-01", 1_000, false),
      ],
      OCT,
    );
    expect(result?.value).toBe(25_000);
    expect(result?.months).toEqual(["2026-07-01", "2026-08-01"]);
    expect(result?.expected).toEqual(EXPECTED);
  });

  test("the month in progress never counts", () => {
    const result = averageBurn([month("2026-09-01", 10_000), month(OCT, 500)], OCT);
    expect(result).toMatchObject({ value: 10_000, months: ["2026-09-01"] });
  });

  test("older months do not stand in for the recent ones", () => {
    expect(averageBurn([month("2026-04-01", 30_000), month("2026-05-01", 20_000)], OCT)).toBeNull();
  });
});

describe("cashNow", () => {
  const fx = [p("2026-08-01", 480), p("2026-09-01", 500)];

  test("each market's latest balance, tenge converted at the newest rate", () => {
    const result = cashNow(p("2026-10-12", 400_000), p("2026-09-30", 5_000_000), fx);
    expect(result?.usd).toBeCloseTo(410_000);
    expect(result?.missing).toEqual([]);
    expect(result?.rate).toBe(500);
    expect(result?.ratePeriodStart).toBe("2026-09-01");
    expect(result?.parts.map((part) => [part.scope, part.native, part.periodStart])).toEqual([
      ["us", 400_000, "2026-10-12"],
      ["kz", 5_000_000, "2026-09-30"],
    ]);
  });

  test("a market that has never reported is named, not counted as zero", () => {
    expect(cashNow(p("2026-10-12", 400_000), null, fx)).toMatchObject({
      usd: 400_000,
      missing: ["kz"],
      rate: null,
      ratePeriodStart: null,
    });
  });

  test("tenge with no rate is left out and named", () => {
    expect(cashNow(p("2026-10-12", 400_000), p("2026-09-30", 5_000_000), [])).toMatchObject({
      usd: 400_000,
      missing: ["fx"],
      rate: null,
      ratePeriodStart: null,
    });
  });

  test("no balance anywhere is no figure at all", () => {
    expect(cashNow(null, null, fx)).toBeNull();
  });
});

describe("runway", () => {
  test("cash divided by average net burn", () => {
    expect(runway(410_000, 20_000)).toEqual({ kind: "months", months: 20.5 });
  });

  test("a company that is not burning has no runway to count down", () => {
    expect(runway(410_000, 0)).toEqual({ kind: "not_burning" });
    expect(runway(410_000, -5_000)).toEqual({ kind: "not_burning" });
  });
});

describe("burnMultiple", () => {
  const sixMonths = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"];
  const burn = sixMonths.map((m) => month(m, 20_000));

  test("net burn over the run, divided by the ARR added over it", () => {
    // 120,000 burned; MRR went from 10,000 (March) to 15,000 (September) = 60,000 of new ARR.
    expect(
      burnMultiple(burn, [month("2026-03-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "value", value: 2, months: 6, from: "2026-04-01", to: "2026-09-01" });
  });

  test("the run shrinks to where MRR history begins", () => {
    // MRR starts in June, so growth can only be measured from July.
    expect(
      burnMultiple(burn, [month("2026-06-01", 10_000), month("2026-09-01", 12_000)], OCT),
    ).toEqual({ kind: "value", value: 2.5, months: 3, from: "2026-07-01", to: "2026-09-01" });
  });

  test("a gap in burn ends the run", () => {
    const gappy = [
      month("2026-06-01", 20_000),
      month("2026-07-01", 20_000, false),
      month("2026-08-01", 20_000),
      month("2026-09-01", 20_000),
    ];
    expect(
      burnMultiple(gappy, [month("2026-07-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "too_little_history" });
  });

  test("fewer than three months is too little to divide", () => {
    expect(
      burnMultiple(burn.slice(-2), [month("2026-07-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "too_little_history" });
  });

  test("early in a month, last month's burn is simply not in yet", () => {
    expect(
      burnMultiple(burn.slice(0, 5), [month("2026-03-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "last_month_incomplete" });
  });

  test("nor can a partial MRR month close the run", () => {
    expect(
      burnMultiple(burn, [month("2026-03-01", 10_000), month("2026-09-01", 15_000, false)], OCT),
    ).toEqual({ kind: "none", reason: "last_month_incomplete" });
  });

  test("no growth leaves nothing to divide by", () => {
    expect(
      burnMultiple(burn, [month("2026-03-01", 15_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "no_growth" });
  });

  test("a company that made money over the run is not burning", () => {
    const earning = sixMonths.map((m) => month(m, -1_000));
    expect(
      burnMultiple(earning, [month("2026-03-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "not_burning" });
  });

  test("not burning outranks no growth when both apply", () => {
    const earning = sixMonths.map((m) => month(m, -1_000));
    expect(
      burnMultiple(earning, [month("2026-03-01", 15_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "not_burning" });
  });

  test("a run that spent exactly nothing is not burning", () => {
    const flat = sixMonths.map((m) => month(m, 0));
    expect(
      burnMultiple(flat, [month("2026-03-01", 10_000), month("2026-09-01", 15_000)], OCT),
    ).toEqual({ kind: "none", reason: "not_burning" });
  });

  describe("over a long history", () => {
    // Twelve months, Oct 2025 to Sep 2026; MRR climbs 500 a month, so the
    // anchor month matters to the answer.
    const twelve = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 9 + i, 1));
      return d.toISOString().slice(0, 10);
    });
    const mrrAll = twelve.map((m, i) => month(m, 10_000 + 500 * i));
    const burnAll = (incomplete: string[] = []) =>
      twelve.map((m) => month(m, 20_000, !incomplete.includes(m)));

    test("looks back six months and no further", () => {
      // Run Apr-Sep (120,000 spent). Anchor is March (12,500); Sep is 15,500.
      const result = burnMultiple(burnAll(), mrrAll, OCT);
      expect(result).toMatchObject({ kind: "value", months: 6, from: "2026-04-01", to: "2026-09-01" });
      expect(result.kind === "value" && result.value).toBeCloseTo(120_000 / (3_000 * 12));
    });

    test("an incomplete burn month inside the window ends the run there", () => {
      const result = burnMultiple(burnAll(["2026-06-01"]), mrrAll, OCT);
      expect(result).toMatchObject({ kind: "value", months: 3, from: "2026-07-01", to: "2026-09-01" });
      // Anchor is June (14,000), the month before the run; Sep is 15,500.
      expect(result.kind === "value" && result.value).toBeCloseTo(60_000 / (1_500 * 12));
    });
  });

  test("when last month is missing and the run could not have been long enough anyway, it is too little history", () => {
    // Only August burned: even with September in, that is two months.
    expect(
      burnMultiple([month("2026-08-01", 20_000)], [month("2026-07-01", 10_000), month("2026-08-01", 12_000)], OCT),
    ).toEqual({ kind: "none", reason: "too_little_history" });
  });

  test("when last month is missing and MRR has no anchor for the run, it is too little history", () => {
    // Burn July-August would make a three-month run with September, but MRR
    // only begins in August, so there is nothing to measure growth from.
    expect(
      burnMultiple(
        [month("2026-07-01", 20_000), month("2026-08-01", 20_000)],
        [month("2026-08-01", 10_000)],
        OCT,
      ),
    ).toEqual({ kind: "none", reason: "too_little_history" });
  });
});

describe("financeSummary", () => {
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
  const usOut = (september = 25_000) =>
    series("cash_out", "us", months.map((m) => p(m, m === "2026-09-01" ? september : 25_000)));
  const tilesWith = (cashOut: Tile) => [
    series("cash_in", "us", months.map((m) => p(m, 5_000))),
    cashOut,
    series("cash", "us", [p("2026-10-12", 400_000)]),
    series("cash", "kz", [p("2026-09-30", 4_400_000)], "KZT"),
    series("fx_usd_kzt", "company", [p("2026-06-01", 440)]),
    // MRR reaches back to June: growth is measured from the month before the run.
    series("mrr", "us", ["2026-06-01", ...months].map((m) => p(m, 5_000))),
    series("mrr", "kz", ["2026-06-01", ...months].map((m) => p(m, 4_400_000)), "KZT"),
  ];
  const tiles = tilesWith(usOut());
  // Mercury's last successful run: after September ended, so Jul-Sep are whole.
  const READ = Date.parse("2026-10-12T06:00:00Z");
  // Kazakhstan's balance falls 440,000 tenge (1,000 dollars) a month.
  const kzCash = [
    p("2026-06-30", 5_720_000),
    p("2026-07-31", 5_280_000),
    p("2026-08-31", 4_840_000),
    p("2026-09-30", 4_400_000),
  ];

  test("puts the pieces together: 20,000 US + 1,000 Kazakhstan a month", () => {
    const summary = financeSummary(tiles, kzCash, OCT, READ);
    expect(summary.coverage).toEqual({ us: true, kz: true });
    expect(summary.average?.value).toBeCloseTo(21_000);
    expect(summary.cash?.usd).toBeCloseTo(410_000);
    expect(summary.runway).toEqual({ kind: "months", months: expect.closeTo(410_000 / 21_000) });
    // MRR is flat, so there is no growth to divide the burn by.
    expect(summary.burnMultiple).toEqual({ kind: "none", reason: "no_growth" });
  });

  test("the month in progress is not in the burn series", () => {
    expect(financeSummary(tiles, kzCash, OCT, READ).burn.map((b) => b.periodStart)).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
  });

  test("months before Kazakhstan's first figure are partial, not US-only totals", () => {
    // Mercury backfills a year of US flows on day one; Kazakhstan's burn
    // begins only with its second close. July and August must not pass as
    // complete at the US figure alone.
    const summary = financeSummary(tiles, kzCash.slice(-2), OCT, READ);
    expect(summary.burn.map((b) => [b.periodStart, b.complete, b.missing])).toEqual([
      ["2026-07-01", false, ["kz"]],
      ["2026-08-01", false, ["kz"]],
      ["2026-09-01", true, []],
    ]);
    expect(summary.average?.months).toEqual(["2026-09-01"]);
    expect(summary.average?.value).toBeCloseTo(21_000);
  });

  test("a wire from the US entity to the Kazakhstan one nets out of company burn", () => {
    // 10,000 dollars leaves Mercury in September and lands as 4,400,000 tenge.
    const wired = financeSummary(
      tilesWith(usOut(35_000)),
      [...kzCash.slice(0, 3), p("2026-09-30", 8_800_000)],
      OCT,
      READ,
    );
    expect(wired.burn.at(-1)?.value).toBeCloseTo(21_000);
    expect(wired.burn.at(-1)?.parts.us).toBe(30_000);
    expect(wired.burn.at(-1)?.parts.kz).toBeCloseTo(-9_000);
  });

  test("MRR from before a market first reported does not anchor the burn multiple", () => {
    // Kazakhstan MRR starts in September. June's US-only 5,000 against
    // September's 15,000 would read as 120,000 of new ARR and a flattering
    // multiple of about 0.5.
    const lateKz = tiles.map((t) =>
      t.key === "mrr" && t.scope === "kz"
        ? series("mrr", "kz", ["2026-09-01", OCT].map((m) => p(m, 4_400_000)), "KZT")
        : t,
    );
    expect(financeSummary(lateKz, kzCash, OCT, READ).burnMultiple).toEqual({
      kind: "none",
      reason: "too_little_history",
    });
  });

  test("without Kazakhstan closes there is no company burn, and so no runway", () => {
    const summary = financeSummary(tiles, [], OCT, READ);
    expect(summary.coverage).toEqual({ us: true, kz: false });
    expect(summary.average).toBeNull();
    expect(summary.runway).toBeNull();
    expect(summary.burnMultiple).toBeNull();
  });

  test("a day inside the current month cannot let the month in progress in as complete", () => {
    const summary = financeSummary(tiles, kzCash, "2026-10-12", READ);
    expect(summary.burn.map((b) => b.periodStart)).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
    expect(summary.average?.expected).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  test("financing typed in for the US changes the US burn for that month", () => {
    const withFinancing = [...tiles, series("financing_in", "us", [p("2026-09-01", 2_000)])];
    const burn = financeSummary(withFinancing, kzCash, OCT, READ).burn;
    // 25,000 out, less 5,000 in of which 2,000 was financing.
    expect(burn.at(-1)?.parts.us).toBe(22_000);
    expect(burn.at(0)?.parts.us).toBe(20_000);
    expect(burn.at(-1)?.parts.kz).toBeCloseTo(1_000);
  });

  test("financing typed in for Kazakhstan changes Kazakhstan's burn, not the US's", () => {
    // 440,000 tenge (1,000 dollars) of investor money propped September up.
    const withFinancing = [
      ...tiles,
      series("financing_in", "us", [p("2026-09-01", 2_000)]),
      series("financing_in", "kz", [p("2026-09-01", 440_000)], "KZT"),
    ];
    const last = financeSummary(withFinancing, kzCash, OCT, READ).burn.at(-1);
    expect(last?.parts.us).toBe(22_000);
    expect(last?.parts.kz).toBeCloseTo(2_000);
  });

  test("financing larger than the month's cash in leaves that month without a US figure", () => {
    const impossible = [...tiles, series("financing_in", "us", [p("2026-08-01", 500_000)])];
    const summary = financeSummary(impossible, kzCash, OCT, READ);
    expect(summary.financingProblems).toEqual(["2026-08-01"]);
    expect(summary.burn.map((b) => [b.periodStart, b.complete, b.missing])).toEqual([
      ["2026-07-01", true, []],
      ["2026-08-01", false, ["us"]],
      ["2026-09-01", true, []],
    ]);
    expect(summary.average?.months).toEqual(["2026-07-01", "2026-09-01"]);
  });

  test("financing that fits inside the month's cash in is not a problem", () => {
    const fine = [...tiles, series("financing_in", "us", [p("2026-08-01", 5_000)])];
    expect(financeSummary(fine, kzCash, OCT, READ).financingProblems).toEqual([]);
    expect(financeSummary(tiles, kzCash, OCT, READ).financingProblems).toEqual([]);
  });

  test("a balance typed on the 2nd names the late close it measured September from", () => {
    const late = [
      p("2026-07-31", 5_280_000),
      p("2026-08-31", 4_840_000),
      p("2026-10-02", 4_400_000),
    ];
    expect(financeSummary(tiles, late, OCT, READ).lateCloses).toEqual([
      { month: "2026-09-01", date: "2026-10-02" },
    ]);
  });

  test("closes dated on the last days of their months are not late", () => {
    expect(financeSummary(tiles, kzCash, OCT, READ).lateCloses).toEqual([]);
  });

  test("late closes are listed oldest first, once each", () => {
    const late = [
      p("2026-07-01", 5_720_000),
      p("2026-08-01", 5_280_000),
      p("2026-09-01", 4_840_000),
      p("2026-10-02", 4_400_000),
    ];
    // Closes: June (Jul 1), Jul (Aug 1), Aug (Sep 1), Sep (Oct 2). Burn exists
    // for Jul, Aug and Sep, and every close behind them is late.
    expect(financeSummary(tiles, late, OCT, READ).lateCloses).toEqual([
      { month: "2026-06-01", date: "2026-07-01" },
      { month: "2026-07-01", date: "2026-08-01" },
      { month: "2026-08-01", date: "2026-09-01" },
      { month: "2026-09-01", date: "2026-10-02" },
    ]);
  });

  test("without Kazakhstan burn there are no late closes to name", () => {
    expect(financeSummary(tiles, [p("2026-10-02", 4_400_000)], OCT, READ).lateCloses).toEqual([]);
  });

  test("no US flows: the US is not covered, and company burn is withheld", () => {
    const kzOnly = tiles.filter((t) => !t.key.startsWith("cash_"));
    const summary = financeSummary(kzOnly, kzCash, OCT, READ);
    expect(summary.coverage).toEqual({ us: false, kz: true });
    expect(summary.average).toBeNull();
    expect(summary.runway).toBeNull();
    expect(summary.burnMultiple).toBeNull();
  });

  test("a market's cash that is missing withholds the runway", () => {
    const withoutKzCash = tiles.filter((t) => !(t.key === "cash" && t.scope === "kz"));
    const summary = financeSummary(withoutKzCash, kzCash, OCT, READ);
    expect(summary.cash?.missing).toEqual(["kz"]);
    expect(summary.runway).toBeNull();
  });

  describe("a US month Mercury did not finish reading", () => {
    // September's row holds twenty days of spending: 10,000 out against a
    // usual 25,000. Counted as a whole month it would pull the average from
    // 21,000 down to 16,000 and stretch the runway.
    const short = tilesWith(usOut(10_000));
    const completeness = (summary: ReturnType<typeof financeSummary>) =>
      summary.burn.map((b) => [b.periodStart, b.complete, b.missing]);

    test("is not a complete month: the average and the runway rest on the months read whole", () => {
      const summary = financeSummary(short, kzCash, OCT, Date.parse("2026-09-20T06:00:00Z"));
      expect(completeness(summary)).toEqual([
        ["2026-07-01", true, []],
        ["2026-08-01", true, []],
        ["2026-09-01", false, ["us"]],
      ]);
      expect(summary.burn.at(-1)?.parts.us).toBeNull();
      expect(summary.average?.months).toEqual(["2026-07-01", "2026-08-01"]);
      expect(summary.average?.expected).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
      expect(summary.average?.value).toBeCloseTo(21_000);
      expect(summary.unfinishedUsMonths).toEqual(["2026-09-01"]);
      expect(summary.usFlowsReadAt).toBe(Date.parse("2026-09-20T06:00:00Z"));
      expect(summary.runway).toEqual({ kind: "months", months: expect.closeTo(410_000 / 21_000) });
      expect(summary.burnMultiple).toEqual({ kind: "none", reason: "last_month_incomplete" });
    });

    test("a read after the month ended makes it complete", () => {
      const summary = financeSummary(short, kzCash, OCT, Date.parse("2026-10-01T06:00:00Z"));
      expect(completeness(summary).at(-1)).toEqual(["2026-09-01", true, []]);
      expect(summary.average?.months).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
      expect(summary.unfinishedUsMonths).toEqual([]);
    });

    test("a read at the very start of the next month counts: the boundary is inclusive", () => {
      const summary = financeSummary(short, kzCash, OCT, Date.parse("2026-10-01T00:00:00Z"));
      expect(completeness(summary).at(-1)).toEqual(["2026-09-01", true, []]);
      expect(summary.unfinishedUsMonths).toEqual([]);
    });

    test("a millisecond before the month ended does not", () => {
      const summary = financeSummary(short, kzCash, OCT, Date.parse("2026-10-01T00:00:00Z") - 1);
      expect(completeness(summary).at(-1)).toEqual(["2026-09-01", false, ["us"]]);
      expect(summary.unfinishedUsMonths).toEqual(["2026-09-01"]);
    });

    test("with no successful read on record, no US month is complete", () => {
      const summary = financeSummary(short, kzCash, OCT, null);
      expect(summary.burn.every((b) => !b.complete && b.parts.us === null)).toBe(true);
      expect(summary.coverage.us).toBe(false);
      expect(summary.average).toBeNull();
      expect(summary.runway).toBeNull();
      expect(summary.usFlowsReadAt).toBeNull();
      expect(summary.unfinishedUsMonths).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    });

    test("a short month inside the burn multiple's six months is named, though the average does not reach it", () => {
      const early = ["2026-04-01", "2026-05-01", "2026-06-01"];
      const stopped = [
        series("cash_in", "us", early.map((m) => p(m, 5_000))),
        series("cash_out", "us", early.map((m) => p(m, 25_000))),
      ];
      const read = Date.parse("2026-06-20T06:00:00Z");
      expect(financeSummary(stopped, kzCash, OCT, read).unfinishedUsMonths).toEqual(["2026-06-01"]);
      // Seven months back is out of reach of everything on the page.
      expect(financeSummary(stopped, kzCash, "2027-01-01", read).unfinishedUsMonths).toEqual([]);
    });

    test("the month in progress is never listed: it is unfinished by definition", () => {
      const summary = financeSummary(short, kzCash, OCT, Date.parse("2026-10-12T06:00:00Z"));
      expect(summary.unfinishedUsMonths).toEqual([]);
    });
  });

  describe("monthGaps: what each of the last three months lacks", () => {
    const without = (key: string, scope: string, drop: string) =>
      tiles.map((t) =>
        t.key === key && t.scope === scope
          ? series(key, scope, t.series.filter((x) => x.periodStart !== drop))
          : t,
      );
    const noRates = tiles.filter((t) => t.key !== "fx_usd_kzt");

    test("complete months lack nothing and are not listed", () => {
      expect(monthGaps(financeSummary(tiles, kzCash, OCT, READ))).toEqual([]);
    });

    test("a month without Kazakhstan's burn lacks its own close, or the one before it", () => {
      // Closes for August and September only.
      const summary = financeSummary(tiles, kzCash.slice(-2), OCT, READ);
      expect(monthGaps(summary)).toEqual([
        { month: "2026-07-01", lacks: ["kz"] },
        { month: "2026-08-01", lacks: ["kz_before"] },
      ]);
    });

    test("tenge with no rate to convert it lacks fx", () => {
      expect(monthGaps(financeSummary(noRates, kzCash, OCT, READ))).toEqual([
        { month: "2026-07-01", lacks: ["fx"] },
        { month: "2026-08-01", lacks: ["fx"] },
        { month: "2026-09-01", lacks: ["fx"] },
      ]);
    });

    test("a month Mercury has no row for lacks us", () => {
      const summary = financeSummary(without("cash_out", "us", "2026-08-01"), kzCash, OCT, READ);
      expect(monthGaps(summary)).toEqual([{ month: "2026-08-01", lacks: ["us"] }]);
    });

    test("a month can lack more than one thing", () => {
      const tilesNow = without("cash_out", "us", "2026-08-01").filter((t) => t.key !== "fx_usd_kzt");
      expect(monthGaps(financeSummary(tilesNow, kzCash, OCT, READ))[1]).toEqual({
        month: "2026-08-01",
        lacks: ["us", "fx"],
      });
    });

    test("a short US month is already explained, so it is not listed again", () => {
      const summary = financeSummary(tiles, kzCash, OCT, Date.parse("2026-09-20T06:00:00Z"));
      expect(summary.burn.at(-1)?.missing).toEqual(["us"]);
      expect(monthGaps(summary)).toEqual([]);
    });

    test("nor is a month whose financing cannot be true", () => {
      const impossible = [...tiles, series("financing_in", "us", [p("2026-08-01", 500_000)])];
      const summary = financeSummary(impossible, kzCash, OCT, READ);
      expect(summary.burn[1]?.missing).toEqual(["us"]);
      expect(monthGaps(summary)).toEqual([]);
    });

    test("an explained US month still names whatever else it lacks", () => {
      const summary = financeSummary(noRates, kzCash, OCT, Date.parse("2026-09-20T06:00:00Z"));
      expect(monthGaps(summary).at(-1)).toEqual({ month: "2026-09-01", lacks: ["fx"] });
    });

    test("a month with no figure from either market lacks everything", () => {
      // US flows begin in August, and Kazakhstan's closes too.
      const late = without("cash_in", "us", "2026-07-01");
      const summary = financeSummary(late, kzCash.slice(2), OCT, READ);
      expect(summary.burn.map((b) => b.periodStart)).toEqual(["2026-08-01", "2026-09-01"]);
      expect(monthGaps(summary)).toEqual([
        { month: "2026-07-01", lacks: ["all"] },
        { month: "2026-08-01", lacks: ["kz_before"] },
      ]);
    });

    test("with no figure at all, a short US month lacks only Kazakhstan's", () => {
      // September: Mercury's row is short, and Kazakhstan has no close for it.
      const summary = financeSummary(
        tiles,
        kzCash.slice(0, 3),
        OCT,
        Date.parse("2026-09-20T06:00:00Z"),
      );
      expect(summary.burn.map((b) => b.periodStart)).toEqual(["2026-07-01", "2026-08-01"]);
      expect(monthGaps(summary)).toEqual([{ month: "2026-09-01", lacks: ["kz"] }]);
    });

    test("the summary carries the month it was built for, normalised, and the gaps follow it", () => {
      const onADay = financeSummary(tiles, kzCash.slice(-2), "2026-10-12", READ);
      const summary = financeSummary(tiles, kzCash.slice(-2), OCT, READ);
      expect(onADay.currentMonth).toBe(OCT);
      expect(summary.currentMonth).toBe(OCT);
      expect(monthGaps(onADay)).toEqual(monthGaps(summary));
    });

    describe("Kazakhstan: this month's balance, or the one before it", () => {
      const NOV = "2026-11-01";
      const READ_NOV = Date.parse("2026-11-05T06:00:00Z");

      test("balances for Sep 30 and Oct 31, read in November: September lacks August's, not its own", () => {
        const summary = financeSummary(
          tiles,
          [p("2026-09-30", 4_840_000), p("2026-10-31", 4_400_000)],
          NOV,
          READ_NOV,
        );
        expect(summary.kzClosedMonths).toEqual(["2026-09-01", "2026-10-01"]);
        expect(summary.burn.map((b) => [b.periodStart, b.complete])).toEqual([
          ["2026-07-01", false],
          ["2026-08-01", false],
          ["2026-09-01", false],
          ["2026-10-01", true],
        ]);
        expect(monthGaps(summary)).toEqual([
          // Neither August's close nor July's: the first sentence.
          { month: "2026-08-01", lacks: ["kz"] },
          { month: "2026-09-01", lacks: ["kz_before"] },
        ]);
      });

      test("a month whose own close is absent lacks kz, whether or not the one before is there", () => {
        // Closes for July and August only: September's own is missing.
        const summary = financeSummary(tiles, kzCash.slice(1, 3), OCT, READ);
        expect(monthGaps(summary)).toEqual([
          { month: "2026-07-01", lacks: ["kz_before"] },
          { month: "2026-09-01", lacks: ["kz"] },
        ]);
      });

      test("with no US figure either, a month that has its own close still says which balance is missing", () => {
        // US flows begin in October; Kazakhstan closed September but not August.
        const lateUs = tiles.map((t) =>
          t.key.startsWith("cash_") ? series(t.key, t.scope, [p(OCT, t.series.at(-1)!.value)]) : t,
        );
        const summary = financeSummary(
          lateUs,
          [p("2026-09-30", 4_840_000), p("2026-10-31", 4_400_000)],
          NOV,
          READ_NOV,
        );
        expect(monthGaps(summary)).toEqual([
          { month: "2026-08-01", lacks: ["all"] },
          { month: "2026-09-01", lacks: ["us", "kz_before"] },
        ]);
      });
    });

    describe("financing above cash in is a filing mistake only in a month Mercury has finished", () => {
      const withFinancing = (month: string) => [
        ...tiles,
        series("financing_in", "us", [p(month, 500_000)]),
      ];

      test("in the month in progress it is not listed: the wire can be recorded before the sync sees it", () => {
        expect(financeSummary(withFinancing(OCT), kzCash, OCT, READ).financingProblems).toEqual([]);
      });

      test("in a past month Mercury did not finish reading it is not listed: that month is already explained", () => {
        const summary = financeSummary(
          withFinancing("2026-09-01"),
          kzCash,
          OCT,
          Date.parse("2026-09-20T06:00:00Z"),
        );
        expect(summary.financingProblems).toEqual([]);
        expect(summary.unfinishedUsMonths).toEqual(["2026-09-01"]);
      });

      test("in a past month read whole it is", () => {
        expect(
          financeSummary(withFinancing("2026-09-01"), kzCash, OCT, READ).financingProblems,
        ).toEqual(["2026-09-01"]);
      });
    });
  });
});
