"use client";

import { useId } from "react";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import { getMetric } from "@convex/lib/metricRegistry";
import { MetricTile } from "@/components/metrics/metric-tile";
import type { FinanceSummary } from "@/lib/metrics/finance";
import { homeTiles, type Tile } from "@/lib/metrics/scorecard";
import { ArrPerPersonTile } from "./arr-per-person";
import { BurnMultipleTile } from "./burn-multiple-tile";

// The stored figures of revenue health, in reading order: who pays, what is
// contracted, what is owed, who leaves. MRR is not here (it is the hero's),
// nor the exchange rate (each converted figure names the rate it used).
const FIGURES = ["paying_clinics", "clinics_active", "mrr_contracted", "receivables", "logo_churn_monthly"].flatMap(
  (key) => {
    const metric = getMetric(key);
    return metric ? [metric] : [];
  },
);

/** One set of tiles: each stored figure of the markets given, then their burn multiple. */
function Tiles({ tiles, summary, now }: { tiles: readonly Tile[]; summary: FinanceSummary; now: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {FIGURES.flatMap((metric) =>
        homeTiles(metric, tiles).map((tile) => (
          <MetricTile key={`${tile.key}:${tile.scope}`} metric={metric} tile={tile} now={now} />
        )),
      )}
      <BurnMultipleTile burnMultiple={summary.burnMultiple} now={now} markets={summary.markets} />
    </div>
  );
}

/**
 * Revenue health, mostly from the CFO workbook: paying clinics, active
 * clients, contracted fees, what is owed and monthly churn, each with its
 * trend, then the burn multiple (with its seed benchmark) and, for the owner
 * alone, ARR per person in the OS. No published band is drawn on a
 * Kazakhstan figure: the bands are US and EU data.
 */
export function RevenueHealth({
  tiles,
  summary,
  now,
  owner,
  company,
}: {
  /** The scorecard's tiles of the markets in view. */
  tiles: readonly Tile[];
  summary: FinanceSummary;
  now: number;
  /** ARR per person is the owner's alone: its head count is an owner query. */
  owner: boolean;
  /** Whose ARR per person: the company in view. */
  company?: CompanyId;
}) {
  return (
    <section aria-labelledby="revenue-health" className="space-y-3">
      <h2 id="revenue-health" className="text-base">
        Revenue health
      </h2>
      <Tiles tiles={tiles} summary={summary} now={now} />
      {owner && <ArrPerPersonTile company={company} />}
    </section>
  );
}

/**
 * The group's revenue health: each company's own tiles under its name, each
 * with its own burn multiple (a company's figures are never added here: a
 * clinic count or a churn rate does not sum across markets), then ARR per
 * person, which is Startup's.
 */
export function GroupedRevenueHealth({
  groups,
  now,
  owner,
}: {
  groups: readonly { company: CompanyId; tiles: readonly Tile[]; summary: FinanceSummary }[];
  now: number;
  owner: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby="revenue-health" className="space-y-3">
      <h2 id="revenue-health" className="text-base">
        Revenue health
      </h2>
      {groups.map(({ company, tiles, summary }) => (
        <div key={company} role="group" aria-labelledby={`${id}-${company}`} className="space-y-2">
          <p id={`${id}-${company}`} className="text-sm font-medium text-ink-2">
            {COMPANIES[company].name}
          </p>
          <Tiles tiles={tiles} summary={summary} now={now} />
        </div>
      ))}
      {owner && <ArrPerPersonTile company="us" />}
    </section>
  );
}
