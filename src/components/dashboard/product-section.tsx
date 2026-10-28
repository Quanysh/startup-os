"use client";

import Link from "next/link";
import { getMetric } from "@convex/lib/metricRegistry";
import { useCompany } from "@/components/company-provider";
import { GatedLink } from "@/components/gated-link";
import { MetricTile } from "@/components/metrics/metric-tile";
import { MonthBars } from "@/components/metrics/month-bars";
import { FlatTiles } from "@/components/metrics/tile-frame";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, companyOfMetric, marketsOf } from "@/lib/company";
import { stuckCount } from "@/lib/engineering/flow";
import { STUCK_HREF, engineeringLine } from "@/lib/metrics/engineering";
import { weekRows } from "@/lib/metrics/product";
import { productHref, productsOf, type ProductId } from "@/lib/metrics/products";
import { knownTile, type Tile } from "@/lib/metrics/scorecard";
import { cn } from "@/lib/utils";
import { usePullsInView, useTargets } from "./reads";
import { DashboardSection, QuietLine, SectionSkeleton } from "./section";

// The two or three figures that say whether each product is used. The rest
// (signups, deploys, activation) are on /product.
const FIGURES: Record<ProductId, readonly string[]> = {
  startup_insights: ["weekly_active_users", "searches"],
  vertical_startup: ["weekly_active_users"],
  kz_product: ["weekly_active_users", "clinics_checking", "checks_completed"],
};

// Every product reports this one, so it is the trend each is drawn by.
const TREND = "weekly_active_users";
const USERS = [{ id: "users", label: "Active users", color: "var(--chart-1)" }];
// Fewer weeks than this say nothing the tile does not.
const WEEKS_WORTH_CHARTING = 3;
const count = (value: number) => value.toLocaleString("en-US");

/**
 * Who uses each product of the company in view, week by week. The tiles are
 * /product's own; the one chart per product appears once there are enough
 * weeks to be a trend, and until then the tiles stand alone.
 */
export function ProductSection() {
  const { can, companies } = useViewer();
  // The products of the company in view that the viewer is on: Convex sends
  // no figure of the other company's.
  const company = useCompany();
  const products = productsOf(company).filter((product) =>
    companies.includes(companyOfMetric("", product.id)),
  );
  // The companies whose engineering is in view: the one chosen, or each the viewer is on.
  const markets = marketsOf(company).filter((market) => companies.includes(market));
  const data = useScorecard();
  const now = useNow();
  const targetOf = useTargets();
  const pulls = usePullsInView();
  if (!can("product") || products.length === 0) return null;

  // Two products sit side by side, so the section takes the row.
  const wide = products.length > 1;
  if (data === undefined || now === null) {
    return (
      <DashboardSection title="Product" href="/product" className={cn(wide && "xl:col-span-2")}>
        <SectionSkeleton className="h-40" />
      </DashboardSection>
    );
  }

  return (
    <DashboardSection title="Product" href="/product" className={cn(wide && "xl:col-span-2")}>
      <div className={cn("grid gap-x-10 gap-y-8", wide && "@2xl:grid-cols-2")}>
        {products.map((product) => (
          <ProductFigures
            key={product.id}
            id={product.id}
            // One product: its name would only repeat the section's.
            label={wide ? product.label : null}
            chartLabel={product.label}
            tiles={data.tiles}
            targetOf={targetOf}
            now={now}
          />
        ))}
      </div>
      {/* Engineering in one line: whether work shipped last week and what is
          waiting. The flow, the tiles, the chart and the repositories are on
          /engineering, which the line leads to for a viewer who has that
          page; a failing main branch is said by "Needs attention". */}
      {markets.map((market) => {
        // Stuck is the list's count, by the Engineering page's five rules; a
        // viewer not sent the list hears only what merged.
        const stuck = pulls ? stuckCount(pulls, market, now) : null;
        const line = engineeringLine(data.tiles, stuck, market, now);
        return (
          line !== null && (
            <p key={market} className="mt-5 border-t border-line pt-4 text-sm text-ink-2">
              {markets.length > 1 ? `Engineering, ${COMPANIES[market].name}: ` : "Engineering: "}
              <GatedLink
                href={stuck === null ? "/engineering" : STUCK_HREF}
                className="rounded-sm underline-offset-2 outline-none hover:text-brand hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {line}
              </GatedLink>
            </p>
          )
        );
      })}
    </DashboardSection>
  );
}

function ProductFigures({
  id,
  label,
  chartLabel,
  tiles,
  targetOf,
  now,
}: {
  id: ProductId;
  label: string | null;
  chartLabel: string;
  tiles: readonly Tile[];
  targetOf: (key: string, scope: string) => number | undefined;
  now: number;
}) {
  const figures = FIGURES[id].flatMap((key) => {
    const metric = getMetric(key);
    const tile = tiles.find((t) => t.key === key && t.scope === id);
    // A pair this build's registry does not know, or one not sent, is passed
    // over. So is a figure with no value yet: /product says how it arrives.
    return metric && tile && knownTile(metric, tile) && tile.latest !== null
      ? [{ metric, tile }]
      : [];
  });
  const weeks = figures.find(({ tile }) => tile.key === TREND)?.tile.series ?? [];
  return (
    <div className="min-w-0">
      {label !== null && (
        <h3 className="mb-3 text-sm font-medium text-ink">
          <Link
            href={productHref(id)}
            className="rounded-sm outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {label}
          </Link>
        </h3>
      )}
      {figures.length === 0 && <QuietLine>No usage figures have arrived yet.</QuietLine>}
      <FlatTiles>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 @lg:grid-cols-3">
          {figures.map(({ metric, tile }) => (
            // No line in the tile: the chart below is the trend.
            <MetricTile
              key={`${tile.key}:${tile.scope}`}
              metric={metric}
              tile={tile}
              now={now}
              target={targetOf(tile.key, tile.scope)}
              minTrend={Infinity}
            />
          ))}
        </div>
      </FlatTiles>
      {weeks.length >= WEEKS_WORTH_CHARTING && (
        <MonthBars
          className="mt-5"
          title={`Weekly active users · ${chartLabel}`}
          grain="week"
          mode="grouped"
          series={USERS}
          rows={weekRows({ users: weeks })}
          format={count}
        />
      )}
    </div>
  );
}
