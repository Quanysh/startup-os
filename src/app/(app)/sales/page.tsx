"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { SCOPE_CURRENCY } from "@convex/lib/metricRegistry";
import { NATIVE_DEAL_MARKETS, type Market } from "@convex/lib/pipelineRules";
import { isClosedStage } from "@convex/lib/pipelineStages";
import { useCompany } from "@/components/company-provider";
import { LinkedContacts } from "@/components/contacts/linked-contacts";
import { PageFreshness, typedReading } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { MirrorStatus } from "@/components/pipeline/mirror-status";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { SalesTable } from "@/components/sales/sales-table";
import { LayoutSwitch } from "@/components/sales/sales-table-toolbar";
import { SalesTiles } from "@/components/sales/sales-tiles";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { moveOnBoard } from "@/lib/board";
import { marketsOf } from "@/lib/company";
import { sourceLabel } from "@/lib/metrics/scorecard";
import { DEAL_STALE_DAYS } from "@/lib/pipeline/derive";
import { DEAL_COLUMNS, OPEN_DEAL_STAGES } from "@/lib/pipeline/stages";
import { readTableView, writeTableView, type DealTableView } from "@/lib/pipeline/table-view";
import { boardLastChange } from "@/lib/source-freshness";

type Sources = FunctionReturnType<typeof api.sources.list>;

// Each market's board, and the source its deals are mirrored from, if any.
const MARKETS: { id: Market; title: string; mirroredFrom: string | null }[] = [
  { id: "us", title: "US", mirroredFrom: null },
  { id: "kz", title: "Kazakhstan", mirroredFrom: "kz_crm" },
];

const WORDS = {
  noun: "deal",
  title: "Deal",
  nameLabel: "Company",
  blankName: "A deal needs a company name.",
};

export default function SalesPage() {
  const { can, companies } = useViewer();
  // The sources are read by whoever has the sources page (the `settings`
  // area), and only their companies' are sent. Without them a mirrored board
  // is shown without the line saying how recently its source was read.
  const sources = useQuery(api.sources.list, can("settings") ? {} : "skip");
  const now = useNow();
  // The markets in view that the viewer is on: Convex refuses the other's deals.
  const company = useCompany();
  const markets = marketsOf(company).filter((market) => companies.includes(market));
  const one = markets.length === 1;
  // Startup's deals are typed in here: their last change is the page's own
  // (the same subscription its section reads). Globex's are the CRM's,
  // which `freshness.forPage` sends.
  const usBoard = useQuery(
    api.deals.board,
    company === "us" && markets.includes("us") ? { market: "us" } : "skip",
  );
  const typed =
    company !== "us"
      ? []
      : usBoard === undefined
        ? undefined
        : [typedReading("Deals, typed in here", boardLastChange(usBoard))];
  return (
    <div className="space-y-10">
      <PageHeader
        title="Sales"
        purpose={`${one ? "Deals" : "Deals in each market"}: what is open, how much of it closes, and which have gone quiet. A deal's amount is its expected monthly fee.`}
        aside={typed === undefined ? undefined : <PageFreshness page="sales" extra={typed} />}
      />
      {MARKETS.filter((market) => markets.includes(market.id)).map((market) => (
        <MarketSection key={market.id} {...market} sources={sources} now={now} />
      ))}
    </div>
  );
}

function MarketSection({
  id: market,
  title,
  mirroredFrom,
  sources,
  now,
}: {
  id: Market;
  title: string;
  mirroredFrom: string | null;
  sources: Sources | undefined;
  now: number | null;
}) {
  const headingId = useId();
  const board = useQuery(api.deals.board, { market });
  const create = useMutation(api.deals.create);
  const update = useMutation(api.deals.update);
  const remove = useMutation(api.deals.remove);
  // Show the card where it was dropped at once; the server's answer replaces
  // this a moment later. A closed stage is ordered by close date, so a card
  // dropped there goes to the top wherever it was let go.
  const move = useMutation(api.deals.move).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.deals.board, { market });
    if (!current || !(args.stage in current)) return;
    const closed = isClosedStage("deals", args.stage);
    store.setQuery(
      api.deals.board,
      { market },
      moveOnBoard(current, args.id, args.stage, closed ? 0 : args.index, (deal) => ({
        ...deal,
        stage: args.stage,
        closedAt: closed ? Date.now() : null,
      })),
    );
  });

  const currency = SCOPE_CURRENCY[market]!;
  const mirror =
    mirroredFrom === null
      ? null
      : { short: sourceLabel(mirroredFrom, "short"), named: sourceLabel(mirroredFrom, "named") };

  // The shared board, exactly as it has always been drawn for either market.
  const pipelineBoard = (loaded: NonNullable<typeof board>) => (
    <PipelineBoard
      board={loaded}
      columns={DEAL_COLUMNS}
      judgedStages={OPEN_DEAL_STAGES}
      limitDays={DEAL_STALE_DAYS}
      now={now}
      currency={currency}
      amountSuffix="/mo"
      mirror={mirror}
      words={{ ...WORDS, amountLabel: `Monthly fee (${currency})` }}
      add={
        NATIVE_DEAL_MARKETS.includes(market)
          ? { label: "Add a deal", placeholder: "Clinic or company", stages: OPEN_DEAL_STAGES }
          : null
      }
      onMove={(id, stage, index) => move({ id: id as Id<"deals">, stage, index })}
      onCreate={(stage, name) => create({ market, stage, name })}
      onSave={(id, edit) => update({ id: id as Id<"deals">, ...edit })}
      onDelete={(id) => remove({ id: id as Id<"deals"> })}
      editorBelow={(card) => <LinkedContacts company={market} type="deal" recordId={card.id} />}
    />
  );

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-xl">
          {title}
        </h2>
        {mirror === null ? (
          <p className="mt-1 text-xs text-ink-2">
            Kept here: add a deal, open it to edit, change its stage in the table or drag it on
            the board.
          </p>
        ) : (
          // When it was read is the page header's, said once for everyone with
          // the page; a holder of Sources is also told what the header cannot.
          <div className="mt-1 space-y-1">
            <MirrorStatus
              named={mirror.named}
              source={sources?.find((source) => source.id === mirroredFrom)}
            />
            <p className="text-xs text-ink-2">
              {`Mirrored from ${mirror.named}. Cards here cannot be dragged or edited. Open one to add your own next step and notes.`}
            </p>
          </div>
        )}
      </div>

      {board === undefined || now === null ? (
        <div className="space-y-4" aria-busy>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-card" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-card" />
        </div>
      ) : (
        <>
          <SalesTiles board={board} market={market} now={now} />
          {market === "us" ? (
            // The table reads its view from the address, which suspends while
            // the page is prerendered: it sits under a boundary of its own.
            <Suspense fallback={<Skeleton className="h-64 rounded-card" />}>
              <UsDeals
                board={board}
                now={now}
                onMove={(id, stage, index) => move({ id: id as Id<"deals">, stage, index })}
                onCreate={(stage, name) => create({ market, stage, name })}
                pipelineBoard={pipelineBoard(board)}
              />
            </Suspense>
          ) : (
            pipelineBoard(board)
          )}
        </>
      )}
    </section>
  );
}

/**
 * Startup's deals: the table (the default) or the shared board, chosen by the
 * Layout switch. The view (layout, filters, sort) is the address, so a view
 * can be shared and the back button undoes it; the search is not (it holds
 * names). Kazakhstan's section never comes here: it draws the board alone.
 * A deal's name in the table opens its page (`/sales/deals/[id]`), which
 * holds its editor; the board opens the editor as it always has.
 */
function UsDeals({
  board,
  now,
  onMove,
  onCreate,
  pipelineBoard,
}: {
  board: FunctionReturnType<typeof api.deals.board>;
  now: number | null;
  onMove: (id: string, stage: string, index: number) => Promise<unknown>;
  onCreate: (stage: string, name: string) => Promise<unknown>;
  /** The shared board, exactly as either market draws it. */
  pipelineBoard: ReactNode;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params.toString();
  const view = useMemo(() => readTableView(new URLSearchParams(query)), [query]);
  const setView = (next: DealTableView) => {
    const written = writeTableView(next);
    router.replace(written === "" ? pathname : `${pathname}?${written}`, { scroll: false });
  };
  const layoutSwitch = (
    <LayoutSwitch layout={view.layout} onLayout={(layout) => setView({ ...view, layout })} />
  );

  if (view.layout === "board") {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">{layoutSwitch}</div>
        {pipelineBoard}
      </div>
    );
  }
  return (
    <SalesTable
      board={board}
      view={view}
      onView={setView}
      now={now}
      onMove={onMove}
      onCreate={onCreate}
      aside={layoutSwitch}
    />
  );
}
