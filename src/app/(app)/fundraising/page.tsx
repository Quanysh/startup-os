"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { isClosedStage } from "@convex/lib/pipelineStages";
import { LinkedContacts } from "@/components/contacts/linked-contacts";
import { ArchivedInvestors } from "@/components/fundraising/archived-investors";
import { FundraisingTiles } from "@/components/fundraising/fundraising-tiles";
import { InvestorsTable } from "@/components/fundraising/investors-table";
import { InvestorCardFooter } from "@/components/fundraising/investor-card-footer";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { LayoutSwitch } from "@/components/pipeline/layout-switch";
import { MirrorStatus } from "@/components/pipeline/mirror-status";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { moveOnBoard } from "@/lib/board";
import { investorCard, investorRows, type InvestorCard } from "@/lib/fundraising/sync";
import { readInvestorView, writeInvestorView, type InvestorView } from "@/lib/fundraising/table-view";
import { INVESTOR_WORDS, SYNC_WORDS } from "@/lib/fundraising/words";
import { sourceLabel } from "@/lib/metrics/scorecard";
import { INVESTOR_STALE_DAYS } from "@/lib/pipeline/derive";
import { ACTIVE_INVESTOR_STAGES, INVESTOR_COLUMNS } from "@/lib/pipeline/stages";

const MIRROR = { short: sourceLabel("visible", "short"), named: sourceLabel("visible", "named") };

// New cards go under any stage that is still open.
const ADD = {
  label: "Add an investor",
  placeholder: "Firm or angel",
  stages: ["target", ...ACTIVE_INVESTOR_STAGES],
};

type Board = NonNullable<ReturnType<typeof useInvestorBoard>>;

/** The board as the server sends it, each card with every field the page reads. */
function useInvestorBoard() {
  const board = useQuery(api.investors.board);
  return useMemo(
    () =>
      board === undefined
        ? undefined
        : (Object.fromEntries(
            Object.entries(board).map(([stage, cards]) => [stage, cards.map(investorCard)]),
          ) as Record<string, InvestorCard[]>),
    [board],
  );
}

export default function FundraisingPage() {
  const board = useInvestorBoard();
  // The sources are read by whoever has the sources page (the `settings`
  // area). Without them the board is shown without the line saying how
  // recently Visible was read.
  const sources = useQuery(api.sources.list, useViewer().can("settings") ? {} : "skip");
  const now = useNow();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fundraising"
        purpose="Investors from first contact to a decision, kept with Visible: a change made here is sent there in the daily run."
        aside={<PageFreshness page="fundraising" />}
      />
      {/* When Visible was read is the header's; a holder of Sources is also
          told what the header cannot (not connected, a refused push). */}
      <MirrorStatus named={MIRROR.named} source={sources?.find((source) => source.id === "visible")} />

      {board === undefined || now === null ? (
        <div className="space-y-6" aria-busy>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-card" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-card" />
        </div>
      ) : (
        <>
          <FundraisingTiles board={board} now={now} />
          {/* The view is read from the address, which suspends while the
              page is prerendered: it sits under a boundary of its own. */}
          <Suspense fallback={<Skeleton className="h-64 rounded-card" />}>
            <Investors board={board} now={now} />
          </Suspense>
        </>
      )}
    </div>
  );
}

/**
 * The investors as the board (the default) or the table, chosen by the
 * Layout switch. The view (layout, filters, sort) is the address, so a view
 * can be shared and the back button undoes it; the table's search is not.
 */
function Investors({ board, now }: { board: Board; now: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params.toString();
  const view = useMemo(() => readInvestorView(new URLSearchParams(query)), [query]);
  const setView = (next: InvestorView) => {
    const written = writeInvestorView(next);
    router.replace(written === "" ? pathname : `${pathname}?${written}`, { scroll: false });
  };

  const create = useMutation(api.investors.create);
  const update = useMutation(api.investors.update);
  const remove = useMutation(api.investors.remove);
  const archive = useMutation(api.investors.archive);
  const retrySync = useMutation(api.investors.retrySync);
  // Show the card where it was dropped at once. A closed stage is ordered by
  // close date, so a card dropped there goes to the top.
  const move = useMutation(api.investors.move).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.investors.board, {});
    if (!current || !(args.stage in current)) return;
    const closed = isClosedStage("investors", args.stage);
    store.setQuery(
      api.investors.board,
      {},
      moveOnBoard(current, args.id, args.stage, closed ? 0 : args.index, (investor) => ({
        ...investor,
        stage: args.stage,
        closedAt: closed ? Date.now() : null,
      })),
    );
  });
  const onMove = (id: string, stage: string, index: number) =>
    move({ id: id as Id<"investors">, stage, index });
  const onRetry = (id: string) => retrySync({ id: id as Id<"investors"> });
  const layoutSwitch = <LayoutSwitch layout={view.layout} onLayout={(layout) => setView({ ...view, layout })} />;

  if (view.layout === "table") {
    return (
      <InvestorsTable
        rows={investorRows(board)}
        view={view}
        onView={setView}
        now={now}
        onMove={onMove}
        onRetry={onRetry}
        aside={layoutSwitch}
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{layoutSwitch}</div>
      <PipelineBoard<InvestorCard>
        board={board}
        columns={INVESTOR_COLUMNS}
        judgedStages={ACTIVE_INVESTOR_STAGES}
        limitDays={INVESTOR_STALE_DAYS}
        now={now}
        currency="USD"
        mirror={MIRROR}
        words={INVESTOR_WORDS}
        add={ADD}
        canDrag={(card) => card.draggable}
        editableOf={(card) => card.editable}
        editorNote={SYNC_WORDS.editorNote}
        cardFooter={(card) => <InvestorCardFooter card={card} onRetry={onRetry} />}
        onMove={onMove}
        onCreate={(stage, name) => create({ stage, name })}
        onSave={(id, edit) => update({ id: id as Id<"investors">, ...edit })}
        onDelete={(id) => remove({ id: id as Id<"investors"> })}
        onArchive={(id) => archive({ id: id as Id<"investors"> })}
        editorBelow={(card) => <LinkedContacts company="us" type="investor" recordId={card.id} />}
      />
      <p className="max-w-2xl text-xs text-ink-2">
        An investor added here is sent to Visible as a new one in the daily run, and kept as the
        same investor once Visible has it.
      </p>
      <ArchivedInvestors />
    </div>
  );
}
