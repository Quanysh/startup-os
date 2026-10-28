// The group: Startup and Globex as one, in US dollars, for a viewer on both
// companies. Pure, read by the Finance page alone. Nothing here reads a clock.
//
// Each company's own figures stay in its own currency (Startup's dollars,
// Globex's tenge) and need no rate. A group figure is Startup's plus Globex
// AI's converted at the newest stored USD/KZT rate, and only when both are
// there: a company with no figure, or tenge with no rate to convert it, makes
// the group figure not known, and says which. Never the part as if it were
// the whole, never a zero.
//
//   group cash      Startup's balance + Globex's balance ÷ rate
//   group net burn  Startup's own spending + Globex's own burn (tenge) ÷ rate
//   group runway    group cash ÷ group net burn
//   group MRR       Startup's latest MRR + Globex's latest ÷ rate
//
// Startup funds Globex, its subsidiary, from Mercury (`cash_to_subsidiary`),
// and the split follows the intercompany rule: that money is Globex's
// financing, never its income. Globex's own burn takes it out of its
// balances as it takes out investor money (`withSubsidiaryFunding`), so it
// is what Globex spends of its own and its runway how long it lasts
// without new money from Startup. Startup's part of the group is its burn less
// what it sent, its own spending; Startup's own lens keeps the bank's figure.
// The funding leaves one part as it enters the other, at the one rate, so
// the group's figure is what it always was (Startup's whole burn plus Globex
// AI's from balances alone), and the parts add up to it. Globex's typed
// `financing_in` is outside money only: a transfer typed there too would be
// counted twice.

import type { Point } from "@convex/lib/attention/metricDerive";
import { REGISTERS, type BudgetTotal, type Register } from "@convex/lib/budget";
import {
  AVERAGE_MONTHS,
  SENT_TO_SUBSIDIARY,
  averageBurn,
  burnFromBalances,
  financeSummary,
  monthCloses,
  monthsBefore,
  runway,
  withSubsidiaryFunding,
  type FinanceSummary,
  type FundingGap,
  type Runway,
} from "@convex/lib/finance";
import { kztToUsd } from "@convex/lib/costs";
import { featureOn } from "@convex/lib/featureGates";
import { periodStart } from "@convex/lib/periods";
import type { Tile } from "@/lib/metrics/scorecard";

/** What a group figure lacks: a company's own figure, or a rate to convert tenge with. */
export type Missing = "us" | "kz" | "fx";

export type GroupAmount = { kind: "known"; usd: number } | { kind: "unknown"; missing: Missing[] };

const usable = (fx: number | null): fx is number => fx !== null && Number.isFinite(fx) && fx > 0;

/**
 * Startup's figure (dollars) plus Globex's (tenge) at `fx` tenge to the
 * dollar. In minor units the tenge part is rounded to a whole cent.
 */
export function groupSum(
  parts: { us: number | null; kz: number | null },
  fx: number | null,
  options: { minor?: boolean } = {},
): GroupAmount {
  const missing: Missing[] = [];
  if (parts.us === null) missing.push("us");
  if (parts.kz === null) missing.push("kz");
  // Zero tenge is zero dollars at any rate.
  else if (parts.kz !== 0 && !usable(fx)) missing.push("fx");
  if (missing.length > 0) return { kind: "unknown", missing };
  const kz = parts.kz! === 0 ? 0 : options.minor ? kztToUsd(parts.kz!, fx!) : parts.kz! / fx!;
  return { kind: "known", usd: parts.us! + kz };
}

export type GroupRunway = Runway | { kind: "unknown"; missing: Missing[] };

/** Group cash ÷ group net burn: not known while either is, with all that is missing. */
export function groupRunway(cash: GroupAmount, burn: GroupAmount): GroupRunway {
  const missing = [...new Set([...(cash.kind === "unknown" ? cash.missing : []), ...(burn.kind === "unknown" ? burn.missing : [])])];
  if (cash.kind === "unknown" || burn.kind === "unknown") {
    return { kind: "unknown", missing: (["us", "kz", "fx"] as const).filter((m) => missing.includes(m)) };
  }
  return runway(cash.usd, burn.usd);
}

/** An average monthly net burn, and the complete months it is of. */
export type BurnFigure = { amount: number; months: string[] };

/** One company's figures in its own currency (major units); null where it has none. */
export type CompanyFigures = {
  cash: { amount: number; periodStart: string } | null;
  /** Its own average monthly net burn, as its own lens gives it: what its runway is of. */
  netBurn: BurnFigure | null;
  /**
   * Its part of the group's net burn. Startup's is its own spending: its burn
   * less what it sent Globex. Globex's is its own burn, which already
   * takes Startup's funding out. The two add up to the group's figure.
   */
  groupBurn: BurnFigure | null;
  /**
   * Months among the three the average is of that lack Mercury's figure of
   * what Startup sent Globex, or a rate to put it in tenge: left out of the
   * part above (and of Globex's own burn), oldest first.
   */
  unsent: FundingGap[];
  mrr: { amount: number; periodStart: string } | null;
};

const latestOf = (tiles: readonly Tile[], key: string, scope: string) => {
  const latest = tiles.find((t) => t.key === key && t.scope === scope)?.latest;
  return latest ? { amount: latest.value, periodStart: latest.periodStart } : null;
};

/** The newest stored USD/KZT rate above zero, or null where none is on record. */
export function latestRate(tiles: readonly Tile[]): { rate: number; periodStart: string } | null {
  const series = tiles.find((t) => t.key === "fx_usd_kzt" && t.scope === "company")?.series ?? [];
  const newest = [...series]
    .filter((p) => p.value > 0)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .at(-1);
  return newest === undefined ? null : { rate: newest.value, periodStart: newest.periodStart };
}

const sentOf = (tiles: readonly Tile[]) =>
  tiles.find((t) => t.key === SENT_TO_SUBSIDIARY && t.scope === "us")?.series ?? null;

/**
 * Startup's figures: the Finance page's own summary of Startup alone (Mercury's
 * balance and burn), and its latest typed MRR. Its part of the group's burn
 * is that burn less what it sent Globex, month by month over the same
 * months; a month with no figure of what was sent is left out of the part,
 * never counted as if nothing were.
 */
export function startupFigures(summary: FinanceSummary, tiles: readonly Tile[]): CompanyFigures {
  const part = summary.cash?.missing.length === 0 ? summary.cash.parts.find((p) => p.scope === "us") : undefined;
  const { average } = summary;
  const sent = new Map((sentOf(tiles) ?? []).map((point) => [point.periodStart, point.value]));
  // No subsidiary funded from Mercury (convex/lib/features.ts): nothing was sent, and Startup's part is its whole burn.
  const funds = featureOn("subsidiaryFunding");
  const unsent: FundingGap[] = [];
  const own: { periodStart: string; value: number }[] = [];
  for (const month of average?.months ?? []) {
    const burned = summary.burn.find((point) => point.periodStart === month)!.value;
    const went = funds ? sent.get(month) : 0;
    if (went === undefined) unsent.push({ month, lacks: "sent" });
    else own.push({ periodStart: month, value: burned - went });
  }
  return {
    cash: part === undefined ? null : { amount: part.native, periodStart: part.periodStart },
    netBurn: average === null ? null : { amount: average.value, months: average.months },
    groupBurn:
      own.length === 0
        ? null
        : { amount: own.reduce((sum, point) => sum + point.value, 0) / own.length, months: own.map((p) => p.periodStart) },
    unsent,
    mrr: latestOf(tiles, "mrr", "us"),
  };
}

/**
 * Globex's figures in tenge: its latest typed balance, its own net burn
 * (the fall in its month-end balances with financing taken out, Startup's
 * funding included at the newest stored rate, averaged over the complete
 * months among the three before this one), and its latest MRR from the
 * workbook. Only Startup's funding needs the rate, and only where some was
 * sent; a month whose funding is not known (`unsent`) is left out of the
 * average. `mercuryReadAt` is Mercury's last successful run, which decides
 * whether a month of what was sent is whole.
 */
export function globexFigures(
  tiles: readonly Tile[],
  kzCashDaily: readonly Point[],
  currentMonth: string,
  mercuryReadAt: number | null,
): CompanyFigures {
  const thisMonth = periodStart("month", Date.parse(`${currentMonth.slice(0, 10)}T00:00:00Z`));
  const financing = tiles.find((t) => t.key === "financing_in" && t.scope === "kz")?.series ?? [];
  const { burn: own, gaps } = withSubsidiaryFunding(
    burnFromBalances(monthCloses(kzCashDaily), financing),
    sentOf(tiles),
    mercuryReadAt,
    latestRate(tiles)?.rate ?? null,
  );
  const burn = own.map((point) => ({
    ...point,
    complete: true,
    missing: [],
    rate: null,
    ratePeriodStart: null,
    parts: { us: null, kz: point.value },
  }));
  const average = averageBurn(burn, thisMonth);
  const expected = monthsBefore(thisMonth, AVERAGE_MONTHS);
  const netBurn = average === null ? null : { amount: average.value, months: average.months };
  return {
    cash: latestOf(tiles, "cash", "kz"),
    netBurn,
    groupBurn: netBurn,
    unsent: gaps.filter((gap) => expected.includes(gap.month)),
    mrr: latestOf(tiles, "mrr", "kz"),
  };
}

/** A company's runway in months from its own figures, or null where either is missing. */
export function ownRunway(figures: CompanyFigures): Runway | null {
  if (figures.cash === null || figures.netBurn === null) return null;
  return runway(figures.cash.amount, figures.netBurn.amount);
}

/**
 * A month's budget for the group, in dollar cents: Startup's total plus Globex
 * AI's at the rate. Each company's total leaves out the same registers (the
 * viewer's own pages decide them, not the company), and the group says so.
 * A company whose total is not known, still loading, or wholly hidden makes
 * the group's not known.
 */
export function groupBudgetTotal(
  us: BudgetTotal,
  kz: BudgetTotal,
  fx: number | null,
): { amount: GroupAmount; excludes: Register[] } | { kind: "loading" } {
  if (us.kind === "loading" || kz.kind === "loading") return { kind: "loading" };
  const excludes = REGISTERS.filter((r) => us.excludes.includes(r) || kz.excludes.includes(r));
  return {
    amount: groupSum(
      { us: us.kind === "known" ? us.amount : null, kz: kz.kind === "known" ? kz.amount : null },
      fx,
      { minor: true },
    ),
    excludes,
  };
}

export type GroupFigures = {
  cash: GroupAmount;
  netBurn: GroupAmount;
  mrr: GroupAmount;
  runway: GroupRunway;
};

/**
 * The group's four figures in dollars, from each company's own. Net burn is
 * the two parts added (`groupBurn`): Startup's own spending and Globex's
 * own burn, the funding in neither.
 */
export function groupFigures(us: CompanyFigures, kz: CompanyFigures, fx: number | null): GroupFigures {
  const cash = groupSum({ us: us.cash?.amount ?? null, kz: kz.cash?.amount ?? null }, fx);
  const summed = groupSum({ us: us.groupBurn?.amount ?? null, kz: kz.groupBurn?.amount ?? null }, fx);
  // Globex's part waiting only for a rate to put what Startup sent it in
  // tenge lacks the rate, not a figure of its own: say what would fill it.
  const onlyRate = kz.groupBurn === null && kz.unsent.length > 0 && kz.unsent.every((gap) => gap.lacks === "fx");
  const netBurn: GroupAmount =
    summed.kind === "unknown" && onlyRate
      ? { kind: "unknown", missing: [...(summed.missing.includes("us") ? (["us"] as const) : []), "fx"] }
      : summed;
  return {
    cash,
    netBurn,
    mrr: groupSum({ us: us.mrr?.amount ?? null, kz: kz.mrr?.amount ?? null }, fx),
    runway: groupRunway(cash, netBurn),
  };
}

/**
 * The group lens's figures from the scorecard as the server sends it: Startup's
 * own summary, each company's figures, the newest rate and the group's four
 * figures. One place for the Finance page's group lens and Today's opening
 * line, so the two can never work the group out differently.
 */
export function groupOfCard(
  tiles: readonly Tile[],
  kzCashDaily: readonly Point[],
  currentMonth: string,
  mercuryReadAt: number | null,
) {
  const usSummary = financeSummary(tiles, kzCashDaily, currentMonth, mercuryReadAt, ["us"]);
  const rate = latestRate(tiles);
  const us = startupFigures(usSummary, tiles);
  const kz = globexFigures(tiles, kzCashDaily, currentMonth, mercuryReadAt);
  return { usSummary, rate, us, kz, group: groupFigures(us, kz, rate?.rate ?? null) };
}
