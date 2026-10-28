"use client";

import { useQuery } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ComponentType } from "react";
import { api } from "@convex/_generated/api";
import { SCOPE_CURRENCY } from "@convex/lib/metricRegistry";
import { periodStart } from "@convex/lib/periods";
import { useCompany } from "@/components/company-provider";
import { ComplianceSection } from "@/components/dashboard/compliance-section";
import { CustomersSection } from "@/components/dashboard/customers-section";
import { EngineeringSection } from "@/components/dashboard/engineering-section";
import { FundraisingSection } from "@/components/dashboard/fundraising-section";
import { GtmSection } from "@/components/dashboard/gtm-section";
import { ProductSection } from "@/components/dashboard/product-section";
import { useDeals, useMarkets } from "@/components/dashboard/reads";
import { SalesSection } from "@/components/dashboard/sales-section";
import { SectionLevel } from "@/components/dashboard/section";
import { Masonry } from "@/components/masonry";
import { WorkSection } from "@/components/dashboard/work-section";
import { CountUp } from "@/components/finance/motion";
import { ChangeBadge } from "@/components/metrics/change-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { marketsOf } from "@/lib/company";
import { arrange, arrangementNote, type BlockId } from "@/lib/dashboard/arrange";
import { financeSummary } from "@/lib/metrics/finance";
import { pipelineValue } from "@/lib/pipeline/derive";
import { moneyFigures, pipelineFigure, type StripFigure } from "@/lib/today/figures";

/**
 * The company's blocks below the strip: what draws each, and whether it takes
 * the whole row. Money is not among them: the strip above carries cash,
 * runway, net burn and MRR, from the same summary the Money block drew.
 */
const BLOCKS: Record<Exclude<BlockId, "money">, { component: ComponentType; wide?: boolean }> = {
  customers: { component: CustomersSection },
  sales: { component: SalesSection },
  fundraising: { component: FundraisingSection },
  product: { component: ProductSection },
  engineering: { component: EngineeringSection },
  gtm: { component: GtmSection },
  work: { component: WorkSection, wide: true },
  compliance: { component: ComplianceSection, wide: true },
};
type Shown = keyof typeof BLOCKS;

/** Consecutive small blocks share a row; a wide one stands alone. */
function rowsOf(ids: readonly Shown[]): Shown[][] {
  const rows: Shown[][] = [];
  for (const id of ids) {
    const last = rows.at(-1);
    if (BLOCKS[id].wide || last === undefined || BLOCKS[last[0]!].wide) rows.push([id]);
    else last.push(id);
  }
  return rows;
}

const Block = ({ id }: { id: Shown }) => {
  const { component: Section } = BLOCKS[id];
  return <Section />;
};

const shownOf = (ids: readonly BlockId[]) => ids.filter((id): id is Shown => id !== "money");

/** One figure: its number, its change or a line under it, leading to its page. */
function Figure({ figure }: { figure: StripFigure }) {
  return (
    <li className="min-w-0">
      <Link
        href={figure.href}
        className="-m-2 block h-full rounded-inner p-2 outline-none transition-colors hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="block text-xs text-ink-2">{figure.label}</span>
        <span
          className={`mt-1 block font-num text-xl font-semibold tracking-tight ${figure.value === "Not known" ? "text-ink-3" : "text-ink"}`}
        >
          {figure.count === null ? (
            figure.value
          ) : (
            <CountUp id={`today-${figure.id}`} value={figure.count.value} format={figure.count.format} />
          )}
        </span>
        {figure.sub !== null && (
          <span className={`mt-0.5 flex items-center gap-1 text-xs ${figure.alert ? "font-medium text-weak" : "text-ink-2"}`}>
            {/* The icon is never the only sign: the words say it too. */}
            {figure.alert && <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />}
            {figure.sub}
          </span>
        )}
        {figure.change !== null && (
          <ChangeBadge
            className="mt-1"
            ratio={figure.change.ratio}
            better={figure.change.better}
            versus={figure.change.versus}
          />
        )}
      </Link>
    </li>
  );
}

/**
 * The few figures that say how the company is doing, for the company in
 * view: money from the Finance page's own summary (a viewer with finance),
 * the open pipeline from the Sales page's own sums (a viewer with sales).
 * What the viewer has no area for is never asked for and not shown.
 */
function CompanyStrip() {
  const { can } = useViewer();
  const finance = can("finance");
  const markets = marketsOf(useCompany());
  const kzInView = markets.includes("kz");
  const data = useScorecard();
  // Month closes need a year of Kazakhstan's balances, read where it is in view.
  const kzHistory = useQuery(api.metrics.series, finance && kzInView ? { key: "cash", scope: "kz", limit: 400 } : "skip");
  const kzCash = kzInView ? kzHistory : [];
  const now = useNow();
  const usDeals = useDeals("us");
  const kzDeals = useDeals("kz");
  const sold = useMarkets()[0];
  const board = sold === "us" ? usDeals : sold === "kz" ? kzDeals : null;
  const sells = can("sales") && board !== null;
  if (!finance && !sells) return null;

  const loading =
    (finance && (data === undefined || kzCash === undefined || now === null)) || (sells && board === undefined);
  if (loading) return <Skeleton data-testid="strip-loading" className="h-28 w-full rounded-card" />;

  const figures: StripFigure[] = [];
  if (finance && data !== undefined && kzCash !== undefined && now !== null) {
    figures.push(
      ...moneyFigures(
        financeSummary(data.money.tiles, kzCash, periodStart("month", now), data.money.mercuryReadAt, markets),
      ),
    );
  }
  if (sells && board !== undefined && board !== null && sold !== undefined) {
    figures.push(pipelineFigure(pipelineValue(board), SCOPE_CURRENCY[sold]!));
  }
  return (
    <ul
      aria-label="Key figures"
      className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-card bg-panel p-5 shadow-soft sm:p-6 lg:grid-cols-4"
    >
      {figures.map((figure) => (
        <Figure key={figure.id} figure={figure} />
      ))}
    </ul>
  );
}

/**
 * "The company": how the company in view is doing. The strip of key figures,
 * then the blocks the viewer's focus arranges (`arrange`), each a summary of
 * the page its heading leads to. The focus orders and gives nothing: a block
 * whose area the viewer lacks is not mounted, and each still decides for
 * itself whether it is this viewer's and this company's.
 */
export function TheCompany() {
  const viewer = useViewer();
  const arranged = arrange(viewer.focus, viewer.areas);
  const lead = shownOf(arranged.lead);
  const rest = shownOf(arranged.rest);
  const strip = viewer.can("finance") || viewer.can("sales");
  if (!strip && lead.length + rest.length === 0) return null;
  return (
    <section aria-labelledby="the-company" className="space-y-4">
      <div className="px-1">
        <h2 id="the-company" className="text-base">
          The company
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">{arrangementNote(viewer)}</p>
      </div>
      <CompanyStrip />
      <SectionLevel.Provider value={3}>
        {lead.length > 0 && (
          <div data-part="lead" className="space-y-6 empty:hidden">
            {lead.map((id) => (
              <Block key={id} id={id} />
            ))}
          </div>
        )}
        {rowsOf(rest).map((row) =>
          BLOCKS[row[0]!].wide ? (
            <Fragment key={row[0]}>
              <Block id={row[0]!} />
            </Fragment>
          ) : (
            // Small blocks in two columns where they fit, each under the
            // column that ends highest and both ending flush: no holes.
            <Masonry key={row[0]} minColumnWidth={440} maxColumns={2}>
              {row.map((id) => (
                <Block key={id} id={id} />
              ))}
            </Masonry>
          ),
        )}
      </SectionLevel.Provider>
    </section>
  );
}
