"use client";

import { SCOPE_CURRENCY, SCOPE_LABELS } from "@convex/lib/metricRegistry";
import { Note } from "@/components/finance/notes";
import { FlatTiles } from "@/components/metrics/tile-frame";
import { QuietTile } from "@/components/pipeline/quiet-tile";
import { agree, countOf } from "@/components/pipeline/words";
import { WinRateTile } from "@/components/sales/sales-tiles";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import type { CompanyId } from "@/lib/company";
import { formatValue } from "@/lib/format";
import { DEAL_STALE_DAYS, pipelineValue, quietDeals, winRate } from "@/lib/pipeline/derive";
import { funnelRows } from "@/lib/pipeline/funnel";
import { DEAL_COLUMNS, OPEN_DEAL_STAGES } from "@/lib/pipeline/stages";
import { Funnel } from "./funnel";
import { useDeals, useMarkets } from "./reads";
import { DashboardSection, QuietLine, SectionSkeleton } from "./section";

/**
 * Open deals by stage for the market in view, with the win rate and what has
 * gone quiet. Counts and sums only: the deals themselves are on /sales.
 */
export function SalesSection() {
  const markets = useMarkets();
  const sells = useViewer().can("sales");
  if (!sells || markets.length === 0) return null;
  return (
    <DashboardSection title="Sales pipeline" href="/sales">
      <div className="space-y-8">
        {markets.map((market) => (
          <MarketPipeline key={market} market={market} named={markets.length > 1} />
        ))}
      </div>
    </DashboardSection>
  );
}

/** One market's board, read on its own so one market never waits for the other. */
function MarketPipeline({ market, named }: { market: CompanyId; named: boolean }) {
  const board = useDeals(market);
  const now = useNow();
  const name = named && <h3 className="mb-3 text-sm font-medium text-ink">{SCOPE_LABELS[market]}</h3>;
  if (board === null) return null;
  if (board === undefined || now === null) {
    return (
      <div>
        {name}
        <SectionSkeleton className="h-40" />
      </div>
    );
  }

  const currency = SCOPE_CURRENCY[market]!;
  const fee = (value: number) => `${formatValue(value, "currency", currency)}/mo`;
  // The sales page's own sums: the same functions its tiles use.
  const value = pipelineValue(board);
  return (
    <div>
      {name}
      {value.open === 0 ? (
        <QuietLine>Nothing is in Lead, Qualified, Demo or Proposal.</QuietLine>
      ) : (
        <Funnel
          caption={`Open ${SCOPE_LABELS[market]} deals by stage`}
          countHeading="Deals"
          rows={funnelRows(board, DEAL_COLUMNS, OPEN_DEAL_STAGES)}
          amount={{ heading: "Monthly fee", format: fee, missing: "No open deal has a monthly fee yet." }}
          total={{
            label: "Open",
            count: value.open,
            value: value.value === null ? "No amount" : fee(value.value),
          }}
        />
      )}
      {/* What the sums leave out, in the sales page's words. */}
      {(value.withoutAmount > 0 || value.unsorted > 0) && (
        <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-2">
          {value.withoutAmount > 0 && value.value !== null && (
            <Note caution>
              {`${countOf(value.withoutAmount, "open deal", "open deals")} ${agree(value.withoutAmount, "has", "have")} no amount and ${agree(value.withoutAmount, "is", "are")} left out.`}
            </Note>
          )}
          {value.unsorted > 0 && (
            <Note caution>
              {`${countOf(value.unsorted, "deal", "deals")} ${agree(value.unsorted, "is", "are")} in a stage the OS does not know and ${agree(value.unsorted, "is", "are")} left out.`}
            </Note>
          )}
        </div>
      )}

      <FlatTiles>
        <div className="mt-5 grid gap-x-6 gap-y-5 border-t border-line pt-5 @md:grid-cols-2">
          {/* The benchmark is US and EU data: never shown for Kazakhstan. */}
          <WinRateTile rate={winRate(board, now)} benchmarked={market === "us"} />
          {/* With no open deal there is nothing to have gone quiet. */}
          {value.open > 0 && (
            <QuietTile
              quiet={quietDeals(board, now)}
              limitDays={DEAL_STALE_DAYS}
              one="open deal"
              many="open deals"
              nobody="There are no open deals."
            />
          )}
        </div>
      </FlatTiles>
    </div>
  );
}
