import { SOURCES } from "../../connectors/manifest";
import {
  METRICS,
  SCOPE_LABELS,
  SOURCE_IDS,
  staleAfter,
  type MetricDef,
  type Scope,
  type Section,
  type SourceId,
} from "../metricRegistry";
import { formatPeriod } from "./format";
import { freshness, type Freshness } from "./freshness";
import { previousPeriodStart } from "../periods";
import { changeFromPrevious, combineInUsd, type CombinedPoint, type Point } from "./metricDerive";

export type Tile = {
  key: string;
  scope: string;
  latest: {
    value: number;
    periodStart: string;
    currency: string | null;
    source: string;
    syncedAt: number;
  } | null;
  /** The first bucket this metric ever reported, which `series` may not reach. */
  firstPeriodStart: string | null;
  series: Point[];
};

export type SourceStates = Record<
  string,
  { state: string; lastRunAt: number; lastOkAt: number | null; message: string | null }
>;

export type AttentionItem = {
  id: string;
  severity: "error" | "overdue" | "risk" | "due" | "stale" | "empty";
  title: string;
  detail: string;
  href: string;
};

/**
 * Whether a tile belongs to this metric in this build: same key, and a scope
 * the metric has. The scorecard query runs on the server and the registry is
 * compiled into the browser, so a tab left open across a deploy can receive a
 * tile for a scope its own registry lacks. Such a tile is passed over, never
 * rendered and never asked about (`supplyOf` throws for it).
 */
export function knownTile(metric: MetricDef, tile: Tile): boolean {
  return tile.key === metric.key && metric.sources[tile.scope as Scope] !== undefined;
}

/** The tiles to draw for one metric: the ones this build's registry knows. */
export function homeTiles(metric: MetricDef, tiles: readonly Tile[]): Tile[] {
  return tiles.filter((tile) => knownTile(metric, tile));
}

export function tileLabel(metric: MetricDef, scope: string): string {
  return `${metric.label} · ${SCOPE_LABELS[scope as Scope] ?? scope}`;
}

/**
 * A source's name: its label, the one word for a tile's footer ("short"), or
 * how it reads inside a sentence ("named", which brings its own article:
 * "Mercury", "the CFO workbook"). An id this build does not know names itself.
 */
export function sourceLabel(id: string, form: "label" | "short" | "named" = "label"): string {
  return SOURCES.find((s) => s.id === id)?.[form] ?? id;
}

/**
 * The sources that feed a section: every one that owns a scope of a metric
 * declared in it. A page shows a failed run only for these, so a source that
 * feeds another section's numbers does not raise an alarm on this one.
 */
export function sourcesOfSection(
  section: Section,
  registry: readonly MetricDef[] = METRICS,
): SourceId[] {
  const owners = new Set(
    registry.filter((m) => m.section === section).flatMap((m) => Object.values(m.sources)),
  );
  return SOURCE_IDS.filter((id) => owners.has(id));
}

export type Supply =
  | { how: "enter"; href: string }
  /** `source` is the source as it reads inside a sentence: no article is to be added. */
  | { how: "source"; href: string; source: string };

/** The anchor of Finance's "Record a figure" panel, where every typed-in figure is entered. */
export const RECORD_FIGURE_ANCHOR = "record-a-figure";

/** Where one figure is typed in: Finance's "Record a figure" panel, with that figure chosen. */
export const recordFigureHref = (key: string, scope: string) =>
  `/finance?metric=${key}&scope=${scope}#${RECORD_FIGURE_ANCHOR}`;

/**
 * How a figure gets into the OS: typed on the entry form, or brought by a
 * source. Ownership is read from the metric it is given, so a caller holding a
 * fixture sees the fixture's sources, never the real registry's.
 */
export function supplyOf(metric: MetricDef, scope: string): Supply {
  const source = metric.sources[scope as Scope];
  if (source === undefined) {
    // Not "enter": there is no form that could take it.
    throw new Error(`"${metric.key}" has no "${scope}" scope.`);
  }
  if (source === "manual") return { how: "enter", href: recordFigureHref(metric.key, scope) };
  return { how: "source", href: "/settings/sources", source: sourceLabel(source, "named") };
}

/**
 * Whether a metric's newest figure, in one scope, is recent enough. The one
 * place the scope's own staleness limit is applied, so a tile and the
 * attention list cannot disagree.
 */
export function metricFreshness(
  now: number,
  metric: MetricDef,
  scope: string,
  latestPeriodStart: string | null,
): Freshness {
  return freshness(now, metric.grain, latestPeriodStart, staleAfter(metric, scope));
}

const ORDER: Record<AttentionItem["severity"], number> = {
  error: 0,
  overdue: 1,
  risk: 2,
  due: 3,
  stale: 4,
  empty: 5,
};

/**
 * Worst first: failures, then what is overdue, at risk or due soon, then what
 * has gone stale, then what is missing. One ordering for every kind of item
 * (numbers, pipelines, clinics, obligations). Items of one severity keep the
 * order they were given in.
 */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/**
 * What needs the owner's attention on the scorecard right now: sources whose
 * last run failed, then scorecard numbers that have gone stale, then ones
 * never entered. That covers every tile and every metric a tile is computed
 * from; other supporting metrics stay quiet.
 */
export function attentionItems(
  tiles: readonly Tile[],
  sources: SourceStates,
  now: number,
  registry: readonly MetricDef[] = METRICS,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const [id, status] of Object.entries(sources)) {
    // "not_configured" is a setup step, shown on the sources page; "error" and
    // "empty" mean a source that should be working is not.
    if (status.state !== "error" && status.state !== "empty") continue;
    items.push({
      id: `source:${id}`,
      severity: "error",
      title: `${sourceLabel(id)}: last run failed`,
      detail: status.message ?? "No detail was recorded.",
      href: "/settings/sources",
    });
  }

  for (const tile of tiles) {
    // Unknown to this build's registry, by metric or by scope: skipped.
    const metric = registry.find((m) => knownTile(m, tile));
    if (!metric || metric.sparse || (metric.home === undefined && !metric.watch)) continue;
    const label = tileLabel(metric, tile.scope);
    const supply = supplyOf(metric, tile.scope);

    if (tile.latest === null) {
      items.push({
        id: `empty:${tile.key}:${tile.scope}`,
        severity: "empty",
        title: `${label} has no value yet`,
        detail:
          supply.how === "enter"
            ? "Enter it to start the trend."
            : `Waiting for ${supply.source}.`,
        href: supply.href,
      });
      continue;
    }

    const { periodStart } = tile.latest;
    if (metricFreshness(now, metric, tile.scope, periodStart) === "stale") {
      items.push({
        id: `stale:${tile.key}:${tile.scope}`,
        severity: "stale",
        title: `${label} is out of date`,
        detail: `Nothing since ${formatPeriod(metric.grain, periodStart)}.`,
        href: supply.href,
      });
    }
  }

  return sortAttention(items);
}

/** Why month-over-month growth is not shown. Null on `CompanyMrr` when it is. */
export type GrowthWithheld =
  /** The latest month is missing a market, or a rate to convert it. */
  | "partial"
  /** There is no month immediately before the latest in the series. */
  | "no_previous"
  /** Both months are there and comparable, but the earlier one was zero: nothing to grow from. */
  | "zero_baseline"
  /** The month before the latest is missing a market, or a rate. */
  | "previous_partial"
  /** Both months are complete but hold different markets: a market's first month. */
  | "new_market";

export type CompanyMrr = {
  /** Every month, oldest first, comparable or not. */
  series: CombinedPoint[];
  /** The months comparable with each other: complete, and holding every market ever reported. */
  trend: CombinedPoint[];
  latest: CombinedPoint;
  growthPercent: number | null;
  previousPeriodStart: string | null;
  /** Why `growthPercent` is null; null when it is not. */
  growthWithheld: GrowthWithheld | null;
  /** KZT per USD used for the latest month, and the month that rate is from. */
  rate: number | null;
  ratePeriodStart: string | null;
  /** True when that rate is more than two months older than the month it converts. */
  rateIsOld: boolean;
};

/**
 * Company MRR in dollars: US plus Kazakhstan converted at the stored rate,
 * with month-over-month growth.
 *
 * Growth is computed only between comparable months. A month is comparable
 * when it is complete and holds every market the company has ever reported:
 * a month from before a market's first figure is a true total for its time,
 * but growth measured across that line is the market arriving, not the
 * business growing. `trend` keeps only the comparable months for the same
 * reason, and so does any net new ARR measured from it. When growth is
 * withheld, `growthWithheld` says why.
 */
export function companyMrr(tiles: readonly Tile[]): CompanyMrr | null {
  const tileOf = (key: string, scope: string) =>
    tiles.find((t) => t.key === key && t.scope === scope);
  const market = (scope: string) => {
    const tile = tileOf("mrr", scope);
    return { points: tile?.series ?? [], firstPeriodStart: tile?.firstPeriodStart ?? null };
  };

  const series = combineInUsd(
    market("us"),
    market("kz"),
    tileOf("fx_usd_kzt", "company")?.series ?? [],
  );
  const latest = series.at(-1);
  if (!latest) return null;

  // A month is comparable with the others only if it holds every market the
  // company has ever reported. A month from before a market's first figure is
  // a true total for its time, but growth measured across that line is the
  // market arriving, not the business growing.
  const markets = (["us", "kz"] as const).filter((market) =>
    series.some((point) => point.parts[market] !== null),
  );
  const comparable = (point: CombinedPoint | undefined): point is CombinedPoint =>
    point !== undefined && point.complete && markets.every((m) => point.parts[m] !== null);

  const monthBefore = previousPeriodStart("month", latest.periodStart);
  const previous = series.find((point) => point.periodStart === monthBefore);
  const change =
    comparable(latest) && comparable(previous) ? changeFromPrevious("month", series) : null;

  let growthWithheld: GrowthWithheld | null = null;
  if (!change) {
    if (!latest.complete) growthWithheld = "partial";
    else if (previous === undefined) growthWithheld = "no_previous";
    else if (!previous.complete) growthWithheld = "previous_partial";
    else if (!comparable(latest) || !comparable(previous)) growthWithheld = "new_market";
    // Everything is comparable, so the baseline was zero: nothing to grow from.
    else growthWithheld = "zero_baseline";
  }

  const twoMonthsBefore = previousPeriodStart("month", monthBefore);
  return {
    series,
    trend: series.filter(comparable),
    latest,
    growthPercent: change ? change.ratio * 100 : null,
    previousPeriodStart: change?.previousPeriodStart ?? null,
    growthWithheld,
    rate: latest.rate,
    ratePeriodStart: latest.ratePeriodStart,
    rateIsOld: latest.ratePeriodStart !== null && latest.ratePeriodStart < twoMonthsBefore,
  };
}
