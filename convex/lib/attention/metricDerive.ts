// Numbers worked out from stored snapshots at read time. Nothing here is
// written back: correcting a base value corrects everything derived from it.

import { previousPeriodStart, type Period } from "../periods";

export type Point = { periodStart: string; value: number };

/**
 * Change of the latest bucket against the one immediately before it. Returns
 * null when that bucket is missing: comparing October with July and calling
 * it month-over-month growth would be a wrong number, not an approximate one.
 */
export function changeFromPrevious(
  grain: Period,
  series: readonly Point[],
): { ratio: number; previousPeriodStart: string } | null {
  const latest = series.at(-1);
  const previous = series.at(-2);
  if (!latest || !previous) return null;
  if (previous.periodStart !== previousPeriodStart(grain, latest.periodStart)) return null;
  if (previous.value === 0) return null;
  return {
    ratio: (latest.value - previous.value) / Math.abs(previous.value),
    previousPeriodStart: previous.periodStart,
  };
}

/** A market's recent points, plus the first bucket it ever reported. */
export type MarketSeries = {
  points: readonly Point[];
  /**
   * The start of the market's history, which may be earlier than `points`
   * reaches. Null when it has never reported.
   */
  firstPeriodStart: string | null;
};

export type CombinedPoint = {
  periodStart: string;
  /** Dollars. A partial total when `complete` is false. */
  value: number;
  complete: boolean;
  /** Why the total is partial: a market with no figure, or no exchange rate. */
  missing: ("us" | "kz" | "fx")[];
  /** KZT per USD used for this bucket, when there was tenge to convert. */
  rate: number | null;
  ratePeriodStart: string | null;
  /** Each market's dollars. Null where it has no figure, or no rate to convert it. */
  parts: { us: number | null; kz: number | null };
};

/**
 * Add a dollar series and a tenge series into one dollar series.
 *
 * A market is expected in every bucket from its first report onwards. Where
 * an expected figure is absent the bucket is marked incomplete and names the
 * market, because a missing number is not a zero: the two markets are entered
 * separately, and without this a month with only one of them in reads as the
 * company's revenue collapsing.
 *
 * Tenge is converted with the USD/KZT rate known for the bucket: the latest
 * rate at or before it, or the earliest on record for buckets older than
 * every rate. The rate used is returned so the caller can show its age. With
 * no rate at all the tenge is left out and the bucket is marked incomplete.
 */
export function combineInUsd(
  usd: MarketSeries,
  kzt: MarketSeries,
  kztPerUsd: readonly Point[],
): CombinedPoint[] {
  const rates = [...kztPerUsd]
    .filter((r) => r.value > 0)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const rateFor = (periodStart: string): Point | null => {
    let rate: Point | null = rates[0] ?? null;
    for (const r of rates) {
      if (r.periodStart <= periodStart) rate = r;
      else break;
    }
    return rate;
  };

  const usdBy = new Map(usd.points.map((x) => [x.periodStart, x.value]));
  const kztBy = new Map(kzt.points.map((x) => [x.periodStart, x.value]));
  const buckets = [...new Set([...usdBy.keys(), ...kztBy.keys()])].sort();
  const expected = (market: MarketSeries, periodStart: string) =>
    market.firstPeriodStart !== null && market.firstPeriodStart <= periodStart;

  return buckets.map((periodStart) => {
    const missing: CombinedPoint["missing"] = [];
    const dollars = usdBy.get(periodStart);
    const tenge = kztBy.get(periodStart);
    if (dollars === undefined && expected(usd, periodStart)) missing.push("us");
    if (tenge === undefined && expected(kzt, periodStart)) missing.push("kz");

    const rate = tenge === undefined ? null : rateFor(periodStart);
    if (tenge !== undefined && rate === null) missing.push("fx");

    const kzUsd = tenge !== undefined && rate ? tenge / rate.value : null;

    return {
      periodStart,
      value: (dollars ?? 0) + (kzUsd ?? 0),
      complete: missing.length === 0,
      missing,
      rate: rate?.value ?? null,
      ratePeriodStart: rate?.periodStart ?? null,
      parts: { us: dollars ?? null, kz: kzUsd },
    };
  });
}
