// The money numbers nobody types in: net burn, runway, burn multiple. Worked
// out from stored snapshots at read time and never written back, so
// correcting a base value corrects everything here.
//
// Nothing here reads a clock. What depends on "now" takes the current month,
// or a timestamp, as an argument: the month in progress is never a complete
// month, and the caller knows what "now" is.
//
// A US month is complete only if Mercury's last successful run finished at or
// after the start of the month that follows it (`readWhole`): the flow rows
// hold what that run saw, so a month last read on its 20th holds twenty days.
//
// A Kazakhstan month closes on a balance dated in the last three days of the
// month, or in the first three days of the next (see `monthCloses`). The
// second case can swallow a transfer that landed on the 1st-3rd, so
// `financeSummary` reports which closes it used that were dated that late.
//
// Pure, and under convex/lib so the owner's agent (the `budget` tool) works
// runway out from the same figures the page shows. The app reads it through
// src/lib/metrics/finance.ts, as it always has.

import { combineInUsd, type CombinedPoint, type Point } from "./attention/metricDerive";
import { companyMrr, metricFreshness, type CompanyMrr, type Tile } from "./attention/scorecard";
import { companyOfMetric } from "./company";
import { featureOn } from "./featureGates";
import { getMetric } from "./metricRegistry";
import { nextPeriodStart, periodStart, previousPeriodStart } from "./periods";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const byPeriod = (points: readonly Point[]) =>
  new Map(points.map((point) => [point.periodStart, point.value]));
const oldestFirst = (a: { periodStart: string }, b: { periodStart: string }) =>
  a.periodStart.localeCompare(b.periodStart);
const monthBefore = (month: string) => previousPeriodStart("month", month);

/** A market the money is counted in. A company's id is its market. */
export type Market = "us" | "kz";
/**
 * The markets in view when a caller names none: both. A one-company view
 * passes its own market alone, and then the other is never expected, never
 * named as missing and never read, even where its figures are passed in.
 */
export const BOTH_MARKETS: readonly Market[] = ["us", "kz"];

/** Startup's payments to Globex by month: Mercury's figure, in dollars. */
export const SENT_TO_SUBSIDIARY = "cash_to_subsidiary";

/**
 * The tiles of the markets in view. The exchange rate goes with Kazakhstan:
 * it exists to convert tenge.
 */
export function tilesInView<T extends { key: string; scope: string }>(
  tiles: readonly T[],
  markets: readonly Market[],
): T[] {
  return tiles.filter((tile) => markets.includes(companyOfMetric(tile.key, tile.scope)));
}

/**
 * The tiles one company's money math reads (`financeSummary` of that company
 * alone): its own, and in Globex's also what Startup sent it
 * (`cash_to_subsidiary`), which Globex's own burn takes out as financing.
 * That figure is Startup's, so it is kept only for a viewer on Startup as well,
 * as the server sends it only to one: for a viewer on Globex alone there
 * is none, and Globex's burn is not worked out (never as if nothing were
 * sent). With no company chosen, everything is kept.
 */
export function moneyTilesOf<T extends { key: string; scope: string }>(
  company: Market | null,
  tiles: readonly T[],
  viewerCompanies: readonly Market[],
): T[] {
  if (company === null) return [...tiles];
  return tiles.filter(
    (tile) =>
      companyOfMetric(tile.key, tile.scope) === company ||
      (company === "kz" &&
        viewerCompanies.includes("us") &&
        tile.key === SENT_TO_SUBSIDIARY &&
        tile.scope === "us"),
  );
}

/** How far from a month's last day a balance may be dated and still close it. */
export const CLOSE_WINDOW_DAYS = 3;

/** A month's closing balance, and the day the balance that closed it is dated. */
export type MonthClose = {
  /** The month closed. */
  periodStart: string;
  value: number;
  /** The day the winning balance is dated: in the month, or just after it. */
  date: string;
};

/**
 * Each month's closing balance, from balances dated on whatever day they were
 * typed. A balance closes a month when it is dated in the last three days of
 * that month, or in the first three days of the next month (the entry form
 * defaults to today, so the 1st or 2nd is common). The nearest to the month's
 * last day wins; on a tie, the one on or before the last day. A balance from
 * the middle of a month closes nothing.
 */
export function monthCloses(daily: readonly Point[]): MonthClose[] {
  const best = new Map<string, { rank: number; value: number; date: string }>();
  const offer = (month: string, daysAfterLastDay: number, point: Point) => {
    if (daysAfterLastDay <= -CLOSE_WINDOW_DAYS || daysAfterLastDay > CLOSE_WINDOW_DAYS) return;
    // Nearest first; "after" loses a tie with "before".
    const rank = Math.abs(daysAfterLastDay) + (daysAfterLastDay > 0 ? 0.5 : 0);
    const held = best.get(month);
    if (held === undefined || rank < held.rank) {
      best.set(month, { rank, value: point.value, date: point.periodStart });
    }
  };

  for (const point of daily) {
    const at = dayOf(point.periodStart);
    const own = periodStart("month", at);
    const ownLastDay = dayOf(nextPeriodStart("month", own)) - DAY_MS;
    const previousLastDay = dayOf(own) - DAY_MS;
    offer(own, Math.round((at - ownLastDay) / DAY_MS), point);
    offer(monthBefore(own), Math.round((at - previousLastDay) / DAY_MS), point);
  }
  return [...best]
    .map(([month, { value, date }]) => ({ periodStart: month, value, date }))
    .sort(oldestFirst);
}

/**
 * Whether a source last read at `readAt` saw the whole of `month`: its last
 * successful run finished at or after the start of the next month. Never, when
 * there is no successful run on record.
 */
export function readWhole(month: string, readAt: number | null): boolean {
  return readAt !== null && readAt >= dayOf(nextPeriodStart("month", month));
}

/**
 * Net burn from bank flows: money out, less the money in that was not
 * financing. A month needs both flows on record. Financing is an event, so a
 * month with no financing row had none. Financing is part of the month's cash
 * in by definition, so a month where it exceeds cash in has no figure: one of
 * the two was typed wrong, and a number built on it would be a guess.
 */
export function burnFromFlows(
  cashIn: readonly Point[],
  cashOut: readonly Point[],
  financing: readonly Point[],
): Point[] {
  const received = byPeriod(cashIn);
  const financed = byPeriod(financing);
  return cashOut.flatMap((out) => {
    const cameIn = received.get(out.periodStart);
    if (cameIn === undefined) return [];
    const financing = financed.get(out.periodStart) ?? 0;
    if (financing > cameIn) return [];
    return [{ periodStart: out.periodStart, value: out.value - (cameIn - financing) }];
  });
}

/**
 * Net burn from month closes: how far the balance fell, plus any financing
 * that propped it up. A month needs the previous month's close.
 */
export function burnFromBalances(
  closes: readonly Point[],
  financing: readonly Point[],
): Point[] {
  const held = byPeriod(closes);
  const financed = byPeriod(financing);
  return closes.flatMap((close) => {
    const before = held.get(monthBefore(close.periodStart));
    if (before === undefined) return [];
    const value = before - close.value + (financed.get(close.periodStart) ?? 0);
    return [{ periodStart: close.periodStart, value }];
  });
}

/**
 * What a month of Globex's own burn lacks of Startup's funding.
 * - `sent`: a whole month of what Startup sent: Mercury has no figure for it
 *   (none on record, or the viewer may not see it), or last read it before
 *   the month ended, when it holds part of a month.
 * - `fx`: dollars were sent and there is no USD/KZT rate to put them in tenge.
 */
export type FundingGap = { month: string; lacks: "sent" | "fx" };

/**
 * Globex's own net burn by month, in tenge: its burn from month-end
 * balances (`burnFromBalances`) with what Startup sent it that month taken out
 * as financing, as the intercompany rule has it. Startup's funding lifted the
 * balance as investor money would; counted as income it hid what Globex
 * spends, so a funded month read as "not burning". What is left is what
 * Globex burns before new money from Startup, and its runway how long its
 * cash lasts without any.
 *
 * `sent` is Mercury's dollars by month (`cash_to_subsidiary`), or null where
 * the viewer may not see them; `readAt` Mercury's last successful run; `rate`
 * the newest stored USD/KZT rate, the one the group adds tenge with, so that
 * Startup's part of the group (its burn less what it sent) and this one add up
 * to the group's figure exactly. A month whose funding is not known has no
 * figure and is in `gaps`: never as if nothing had been sent.
 */
export function withSubsidiaryFunding(
  burn: readonly Point[],
  sent: readonly Point[] | null,
  readAt: number | null,
  rate: number | null,
): { burn: Point[]; gaps: FundingGap[] } {
  // No subsidiary funded from Mercury (convex/lib/features.ts): the burn is the balances' own.
  if (!featureOn("subsidiaryFunding")) return { burn: [...burn], gaps: [] };
  const sentBy = byPeriod(sent ?? []);
  const usable = rate !== null && Number.isFinite(rate) && rate > 0;
  const gaps: FundingGap[] = [];
  const own = burn.flatMap((point) => {
    const dollars = sent === null ? undefined : sentBy.get(point.periodStart);
    if (dollars === undefined || !readWhole(point.periodStart, readAt)) {
      gaps.push({ month: point.periodStart, lacks: "sent" });
      return [];
    }
    // Nothing sent needs no rate to be nothing.
    if (dollars === 0) return [point];
    if (!usable) {
      gaps.push({ month: point.periodStart, lacks: "fx" });
      return [];
    }
    return [{ periodStart: point.periodStart, value: point.value + dollars * rate }];
  });
  return { burn: own, gaps };
}

/** The `size` calendar months before `month`, oldest first. */
export function monthsBefore(month: string, size: number): string[] {
  const months: string[] = [];
  for (let m = monthBefore(month); months.length < size; m = monthBefore(m)) months.unshift(m);
  return months;
}

/** How many months the net burn average is of. */
export const AVERAGE_MONTHS = 3;

export type BurnAverage = {
  value: number;
  /** The months the mean is of. */
  months: string[];
  /** The months it should be of: the `size` before the current one. */
  expected: string[];
};

/**
 * Mean net burn over the complete months among the `size` calendar months
 * before `currentMonth`. Null when none of them is complete: older months do
 * not stand in for recent ones.
 */
export function averageBurn(
  burn: readonly CombinedPoint[],
  currentMonth: string,
  size = AVERAGE_MONTHS,
): BurnAverage | null {
  const expected = monthsBefore(currentMonth, size);
  const used = burn
    .filter((point) => point.complete && expected.includes(point.periodStart))
    .sort(oldestFirst);
  if (used.length === 0) return null;
  return {
    value: used.reduce((sum, point) => sum + point.value, 0) / used.length,
    months: used.map((point) => point.periodStart),
    expected,
  };
}

export type CashPart = {
  scope: Market;
  /** In the market's own currency. */
  native: number;
  usd: number;
  /** The day the balance is of. */
  periodStart: string;
};

export type CashNow = {
  usd: number;
  parts: CashPart[];
  /** A market in view with no balance, or tenge with no rate. The total is partial. */
  missing: (Market | "fx")[];
  /** KZT per USD used, when there was tenge to convert. */
  rate: number | null;
  /** The month that rate is from. Null whenever `rate` is. */
  ratePeriodStart: string | null;
};

/**
 * The latest balance of each market in view, tenge converted at the newest
 * rate on record. A balance of a market not in view is left out as if it had
 * not been passed, and that market is not missing.
 */
export function cashNow(
  usBalance: Point | null,
  kzBalance: Point | null,
  kztPerUsd: readonly Point[],
  markets: readonly Market[] = BOTH_MARKETS,
): CashNow | null {
  const us = markets.includes("us") ? usBalance : null;
  const kz = markets.includes("kz") ? kzBalance : null;
  if (us === null && kz === null) return null;
  const newest =
    [...kztPerUsd]
      .filter((r) => r.value > 0)
      .sort(oldestFirst)
      .at(-1) ?? null;
  const rate = newest?.value ?? null;

  const parts: CashPart[] = [];
  const missing: CashNow["missing"] = [];
  if (us !== null) {
    parts.push({ scope: "us", native: us.value, usd: us.value, periodStart: us.periodStart });
  } else if (markets.includes("us")) missing.push("us");
  if (kz === null) {
    if (markets.includes("kz")) missing.push("kz");
  } else if (rate === null) missing.push("fx");
  else parts.push({ scope: "kz", native: kz.value, usd: kz.value / rate, periodStart: kz.periodStart });

  return {
    usd: parts.reduce((sum, part) => sum + part.usd, 0),
    parts,
    missing,
    rate: kz !== null ? rate : null,
    ratePeriodStart: kz !== null ? (newest?.periodStart ?? null) : null,
  };
}

/**
 * Whether a market's balance is older than its own limit allows: three days
 * for the US, which Mercury reads daily, 35 for Kazakhstan, typed in monthly.
 * Judged here, so a tile and the investor update cannot disagree.
 */
export function cashPartIsOld(part: CashPart, now: number): boolean {
  return metricFreshness(now, getMetric("cash")!, part.scope, part.periodStart) === "stale";
}

/** Past this many months a runway is not a countdown worth printing. */
export const LONGEST_RUNWAY_MONTHS = 120;

export type Runway = { kind: "months"; months: number } | { kind: "not_burning" };

export function runway(cashUsd: number, averageNetBurn: number): Runway {
  return averageNetBurn <= 0
    ? { kind: "not_burning" }
    : { kind: "months", months: cashUsd / averageNetBurn };
}

/** How many months back a burn multiple's run may reach. */
export const BURN_MULTIPLE_MONTHS = 6;

export type BurnMultiple =
  | { kind: "value"; value: number; months: number; from: string; to: string }
  | {
      kind: "none";
      reason: "last_month_incomplete" | "too_little_history" | "no_growth" | "not_burning";
    };

/**
 * Net burn divided by net new ARR, over the unbroken run of complete months
 * ending last month: at most `maxMonths`, at least `minMonths`.
 */
export function burnMultiple(
  burn: readonly CombinedPoint[],
  mrr: readonly CombinedPoint[],
  currentMonth: string,
  maxMonths = BURN_MULTIPLE_MONTHS,
  minMonths = 3,
): BurnMultiple {
  const complete = (points: readonly CombinedPoint[]) =>
    new Map(points.filter((x) => x.complete).map((x) => [x.periodStart, x.value]));
  const burned = complete(burn);
  const revenue = complete(mrr);
  const none = (reason: Extract<BurnMultiple, { kind: "none" }>["reason"]): BurnMultiple => ({
    kind: "none",
    reason,
  });

  // Build the run as if last month were complete in both series. Early in a
  // month it often is not in yet, and that is a wait only when nothing else
  // stands in the way: if the run would fall short anyway, it is a lack of
  // history, and saying "wait" would promise an answer that will not come.
  const to = monthBefore(currentMonth);
  const hasBurn = (month: string) => month === to || burned.has(month);
  const hasMrr = (month: string) => month === to || revenue.has(month);

  const run: string[] = [];
  for (let month = to; run.length < maxMonths && hasBurn(month); month = monthBefore(month)) {
    run.unshift(month);
  }
  // Growth is measured from the month before the run, so that month needs an
  // MRR figure. Where MRR history is shorter, the run shrinks to it.
  while (run.length > 0 && !hasMrr(monthBefore(run[0]!))) run.shift();

  const from = run[0];
  if (from === undefined || run.length < minMonths) return none("too_little_history");
  if (!burned.has(to) || !revenue.has(to)) return none("last_month_incomplete");

  const spent = run.reduce((sum, month) => sum + burned.get(month)!, 0);
  if (spent <= 0) return none("not_burning");
  const netNewArr = (revenue.get(to)! - revenue.get(monthBefore(from))!) * 12;
  if (netNewArr <= 0) return none("no_growth");
  return { kind: "value", value: spent / netNewArr, months: run.length, from, to };
}

/** A month close that was measured from a balance dated after the month ended. */
export type LateClose = {
  /** The month the balance closes. */
  month: string;
  /** The day the balance is dated, in the month after. */
  date: string;
};

export type FinanceSummary = {
  /** The month in progress the summary was built for, as the first day of that month. */
  currentMonth: string;
  /**
   * The markets the summary is of: both, or one company's own. Everything
   * below is of these markets only, and says nothing about any other.
   */
  markets: readonly Market[];
  /**
   * Company net burn in dollars by month, oldest first, from the first month
   * either market has a figure up to the month before the current one. A
   * month missing a market is incomplete and names it. `parts` holds each
   * market's share, null where it has none.
   */
  burn: CombinedPoint[];
  /**
   * Whether each market has any burn figure at all. Company burn needs every
   * market in view. A market not in view is never covered and never asked.
   */
  coverage: { us: boolean; kz: boolean };
  /** The mean of the complete months among the three before the current one. Null without both markets covered, or without a complete recent month. */
  average: BurnAverage | null;
  /** Each market's latest balance in dollars. Null when neither market has one. */
  cash: CashNow | null;
  /** Company MRR with its growth, or null before any figure exists. */
  mrr: CompanyMrr | null;
  /** Cash over average burn. Null while either is unknown or partial. */
  runway: Runway | null;
  /** Null without both markets covered or without MRR. */
  burnMultiple: BurnMultiple | null;
  /**
   * Among the three months the average is expected to cover and whose
   * Kazakhstan burn exists, the closes it was measured from that are dated
   * after the month they close, oldest first. A transfer landing in those
   * first days would be counted in the wrong month. Empty when company burn
   * is withheld.
   */
  lateCloses: LateClose[];
  /**
   * Months, oldest first, where US financing exceeds that month's cash in:
   * one of the two is filed wrong, and the month has no US burn figure. Only
   * months before the current one that Mercury has read whole: until then
   * cash in is still arriving, and a wire recorded before the sync sees it is
   * not a mistake.
   */
  financingProblems: string[];
  /** The months Kazakhstan has a closing balance for, oldest first. */
  kzClosedMonths: string[];
  /**
   * Months, oldest first, that have US flow rows but were last read by
   * Mercury before they ended, among the six before the current month: the
   * three the average is of, and the rest of a burn multiple's reach. Their
   * rows hold part of a month, so they have no US burn figure.
   */
  unfinishedUsMonths: string[];
  /**
   * When Mercury's last successful run finished. Null when none is on record,
   * and when the US is not in view.
   */
  usFlowsReadAt: number | null;
  /**
   * Startup's funding of Globex, as one company's view reads it. Null with
   * both markets in view: their figure is the two companies together, where
   * a transfer is money out of one and money in to the other and cancels.
   * `perMonth` is the average sent, in dollars, over the months the average
   * net burn is of: null without an average, or where a month of it has no
   * figure.
   * - `parent` (Startup alone): its burn is the bank's, the funding included.
   * - `subsidiary` (Globex alone): its burn takes the funding out as
   *   financing (`withSubsidiaryFunding`). `hidden` when the viewer may not
   *   see Startup's figure (a viewer on Globex alone), and so has no burn;
   *   `gaps` the months before the current one that lack it, oldest first.
   */
  funding:
    | { side: "parent"; perMonth: number | null }
    | { side: "subsidiary"; perMonth: number | null; hidden: boolean; gaps: FundingGap[] }
    | null;
};

/**
 * Everything the finance page computes, from the scorecard's tiles plus the
 * Kazakhstan balance history (`kzCashDaily`, which needs more days than a
 * tile carries). `currentMonth` may be any day inside the month in progress.
 * `usFlowsReadAt` is when Mercury's last successful run finished (the source's
 * `lastOkAt`, never a tile's `syncedAt`, which an unchanged value leaves
 * untouched); null when it has never succeeded or is unknown.
 *
 * `markets` is the markets in view: both unless one company's is given. With
 * one, the summary is that market's alone. Its burn is that company's burn
 * (Mercury's flows for the US, month-end balances for Kazakhstan), and the
 * other market's figures are dropped at the door, so nothing below can wait
 * for them or count them.
 */
export function financeSummary(
  allTiles: readonly Tile[],
  allKzCashDaily: readonly Point[],
  currentMonth: string,
  mercuryReadAt: number | null,
  markets: readonly Market[] = BOTH_MARKETS,
): FinanceSummary {
  const tiles = tilesInView(allTiles, markets);
  const kzCashDaily = markets.includes("kz") ? allKzCashDaily : [];
  const usFlowsReadAt = markets.includes("us") ? mercuryReadAt : null;
  // A caller passing a day inside the month must not let that month in as complete.
  const thisMonth = periodStart("month", dayOf(currentMonth));
  const tile = (key: string, scope: string) =>
    tiles.find((t) => t.key === key && t.scope === scope);
  const series = (key: string, scope: string) => tile(key, scope)?.series ?? [];
  const latest = (key: string, scope: string): Point | null => {
    const value = tile(key, scope)?.latest;
    return value ? { periodStart: value.periodStart, value: value.value } : null;
  };

  const rates = series("fx_usd_kzt", "company");
  // A month Mercury did not finish reading is left out: its row is short, and
  // a short month is not a whole one. The company month then misses the US.
  const usBurn = burnFromFlows(
    series("cash_in", "us"),
    series("cash_out", "us"),
    series("financing_in", "us"),
  )
    .filter((point) => readWhole(point.periodStart, usFlowsReadAt))
    .sort(oldestFirst);
  const closes = monthCloses(kzCashDaily);
  const kzFromBalances = burnFromBalances(closes, series("financing_in", "kz"));

  // Startup's funding of Globex, in a one-company view. The one figure of the
  // other company a view reads: what Startup sent is Globex's financing, and
  // its tile is sent only to a viewer on Startup as well (none: `hidden`).
  const usAlone = markets.length === 1 && markets[0] === "us";
  const kzAlone = markets.length === 1 && markets[0] === "kz";
  const sentTile = allTiles.find((t) => t.key === SENT_TO_SUBSIDIARY && t.scope === "us");
  const newestRate = [...rates].filter((r) => r.value > 0).sort(oldestFirst).at(-1)?.value ?? null;
  const received = kzAlone
    ? withSubsidiaryFunding(kzFromBalances, sentTile?.series ?? null, mercuryReadAt, newestRate)
    : null;
  const kzBurn = received?.burn ?? kzFromBalances;

  const cashIn = byPeriod(series("cash_in", "us"));
  const financingProblems = series("financing_in", "us")
    .filter((f) => {
      const received = cashIn.get(f.periodStart);
      return (
        received !== undefined &&
        f.value > received &&
        f.periodStart < thisMonth &&
        readWhole(f.periodStart, usFlowsReadAt)
      );
    })
    .map((f) => f.periodStart)
    .sort();

  // With no burn figure at all, a market has not started reporting, and
  // company burn is withheld: a one-market burn understates spending, and an
  // overstated runway is the dangerous direction. Kazakhstan reports with its
  // balances: a month waiting only for Startup's funding is not complete, but
  // its balances are in.
  const coverage = { us: usBurn.length > 0, kz: kzFromBalances.length > 0 };
  // Only the markets in view are asked: one company's burn is whole on its own.
  const covered = markets.every((market) => coverage[market]);

  // Both markets are expected from the first month either has a figure.
  // Mercury backfills a year on day one while Kazakhstan's burn starts with
  // its second close; without this, the months in between would pass as
  // complete at the US figure alone.
  const first = [usBurn[0], kzFromBalances[0]].flatMap((x) => (x ? [x.periodStart] : [])).sort()[0] ?? null;
  // A market not in view has no first month: it is expected in none.
  const market = (id: Market, points: Point[]) => ({
    points,
    firstPeriodStart: markets.includes(id) ? first : null,
  });

  const burn = combineInUsd(market("us", usBurn), market("kz", kzBurn), rates).filter(
    (point) => point.periodStart < thisMonth,
  );
  const average = covered ? averageBurn(burn, thisMonth) : null;
  const cash = cashNow(latest("cash", "us"), latest("cash", "kz"), rates, markets);
  const mrr = companyMrr(tiles);

  // A close dated in the month after the one it closes. Each month in the
  // average rests on its own close and the one before it.
  const kzBurnMonths = new Set(kzBurn.map((point) => point.periodStart));
  const closeOf = new Map(closes.map((c) => [c.periodStart, c]));
  const lateMonths = new Set<string>();
  for (const month of average?.expected ?? []) {
    if (!kzBurnMonths.has(month)) continue;
    for (const closed of [monthBefore(month), month]) {
      const held = closeOf.get(closed);
      if (held !== undefined && periodStart("month", dayOf(held.date)) !== closed) {
        lateMonths.add(closed);
      }
    }
  }
  const lateCloses = [...lateMonths]
    .sort()
    .map((month) => ({ month, date: closeOf.get(month)!.date }));

  const withFlows = new Set(
    [...series("cash_in", "us"), ...series("cash_out", "us")].map((point) => point.periodStart),
  );
  const unfinishedUsMonths = monthsBefore(thisMonth, BURN_MULTIPLE_MONTHS).filter(
    (month) => withFlows.has(month) && !readWhole(month, usFlowsReadAt),
  );

  // How much went from Startup to Globex over the average's months: in
  // Startup's burn, and taken out of Globex's.
  const sentBy = byPeriod(sentTile?.series ?? []);
  const sentEach = (average?.months ?? []).map((month) => sentBy.get(month));
  const perMonth =
    sentEach.length === 0 || sentEach.some((sent) => sent === undefined)
      ? null
      : sentEach.reduce((sum: number, sent) => sum + sent!, 0) / sentEach.length;
  // No subsidiary funded from Mercury (convex/lib/features.ts): no funding to speak of.
  const funding: FinanceSummary["funding"] = !featureOn("subsidiaryFunding")
    ? null
    : kzAlone
      ? {
          side: "subsidiary",
          perMonth,
          hidden: sentTile === undefined,
          gaps: received!.gaps.filter((gap) => gap.month < thisMonth).sort((a, b) => a.month.localeCompare(b.month)),
        }
      : usAlone
        ? { side: "parent", perMonth }
        : null;

  return {
    currentMonth: thisMonth,
    markets,
    burn,
    coverage,
    average,
    cash,
    mrr,
    runway:
      average !== null && cash !== null && cash.missing.length === 0
        ? runway(cash.usd, average.value)
        : null,
    // `trend`, not `series`: only months comparable with each other may
    // anchor net new ARR (see companyMrr).
    burnMultiple: covered && mrr !== null ? burnMultiple(burn, mrr.trend, thisMonth) : null,
    lateCloses,
    financingProblems,
    kzClosedMonths: closes.map((c) => c.periodStart),
    unfinishedUsMonths,
    usFlowsReadAt,
    funding,
  };
}

/**
 * What one of the months the average is of lacks.
 * - `us`: Mercury's figure.
 * - `kz`: Kazakhstan's closing balance for the month itself.
 * - `kz_before`: that balance is there, but the previous month's is not, so
 *   no burn can be measured from it.
 * - `fx`: a rate to convert tenge with.
 * - `sent`: in Globex's own view, Mercury's figure for what Startup sent it
 *   that month, which its burn takes out (`FundingGap`).
 * - `all`: nothing from either market.
 */
export type MonthGap = { month: string; lacks: ("us" | "kz" | "kz_before" | "fx" | "sent" | "all")[] };

/**
 * Why each of the three months before the summary's current month is not a
 * complete month of company burn, oldest first. A complete month is not
 * listed.
 *
 * A missing US figure that the summary already explains (a month Mercury did
 * not finish reading, or financing larger than the money in) is not repeated
 * here; a month with nothing else missing is then not listed either.
 *
 * Only the markets the summary is of can be lacking: in one company's view a
 * month never lacks the other's figure, and "nothing from either market" is
 * said only where there are two.
 */
export function monthGaps(summary: FinanceSummary): MonthGap[] {
  const inView = (market: Market) => summary.markets.includes(market);
  const usExplained = new Set([...summary.unfinishedUsMonths, ...summary.financingProblems]);
  const closed = new Set(summary.kzClosedMonths);
  // Kazakhstan's burn needs two closes. With the month's own on record, it is
  // the one before that is missing, and saying "this month's" would be false.
  const kz = (month: string) => (closed.has(month) ? "kz_before" : "kz");
  // Globex's balances are in for these, but not Startup's funding of it.
  const unfunded = new Map(
    (summary.funding?.side === "subsidiary" ? summary.funding.gaps : []).map((gap) => [gap.month, gap.lacks]),
  );
  return monthsBefore(summary.currentMonth, AVERAGE_MONTHS).flatMap((month): MonthGap[] => {
    const point = summary.burn.find((b) => b.periodStart === month);
    const explained = usExplained.has(month);
    const funding = unfunded.get(month);
    if (point === undefined && funding !== undefined) return [{ month, lacks: [funding] }];
    if (point === undefined) {
      const lacksUs = inView("us") && !explained;
      // No figure from either market. With the US side accounted for, or a
      // Kazakhstan balance on record, say what is still to come, not "nothing".
      if (lacksUs && inView("kz") && !closed.has(month)) return [{ month, lacks: ["all"] }];
      const lacks: MonthGap["lacks"] = [];
      if (lacksUs) lacks.push("us");
      if (inView("kz")) lacks.push(kz(month));
      return lacks.length > 0 ? [{ month, lacks }] : [];
    }
    const lacks = point.missing.flatMap((what): MonthGap["lacks"] => {
      if (what === "us") return explained ? [] : ["us"];
      return [what === "kz" ? kz(month) : what];
    });
    return lacks.length > 0 ? [{ month, lacks }] : [];
  });
}
