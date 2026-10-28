"use client";

import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { DealPriority } from "@convex/lib/dealDetails";
import { MAX_DEALS_SELECTED } from "@convex/lib/limits";
import { AddCard } from "@/components/pipeline/add-card";
import { useSelection } from "@/components/tasks/use-selection";
import { messageOf } from "@/lib/errors";
import {
  boardRows,
  ehrsOf,
  filterDeals,
  regionsOf,
  sortDeals,
  type DealTableView,
  type TableDeal,
} from "@/lib/pipeline/table-view";
import { ArchivedDeals } from "./archived-deals";
import { DealBulkBar } from "./deal-bulk-bar";
import { DealTable } from "./deal-table";
import { SalesTableToolbar, clearedView } from "./sales-table-toolbar";

/** A large index: the end of the stage, wherever that is. */
const END = Number.MAX_SAFE_INTEGER;

type Board = Readonly<Record<string, readonly TableDeal[]>>;

/**
 * Startup's (US) deals as a table: the same cards `deals.board` sends the
 * board, filtered and sorted in the browser by the view the page keeps in the
 * address, with the search held here. A change made in a row goes through the
 * same mutation the board and its editor use (a stage through `onMove`, the
 * rest through `deals.update`), and a refusal is said in the server's words.
 *
 * What research found about each deal (`dealIntel.list`) rides on its row as
 * `intel`, for the intelligence's columns and filters. A deal's name opens its
 * page (`/sales/deals/[id]`), where its intelligence is read and its editor
 * is "Edit details".
 */
export function SalesTable({
  board,
  view,
  onView,
  now,
  onMove,
  onCreate,
  aside,
}: {
  board: Board;
  view: DealTableView;
  onView: (next: DealTableView) => void;
  now: number | null;
  onMove: (id: string, stage: string, index: number) => Promise<unknown>;
  onCreate: (stage: string, name: string) => Promise<unknown>;
  /** At the end of the toolbar's first row: the layout switch. */
  aside?: React.ReactNode;
}) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const intel = useQuery(api.dealIntel.list, {});
  // A priority shows at once; the server's answer replaces it a moment later.
  const setPriority = useMutation(api.deals.update).withOptimisticUpdate((store, args) => {
    if (args.priority === undefined) return;
    const current = store.getQuery(api.deals.board, { market: "us" });
    if (!current) return;
    const next = Object.fromEntries(
      Object.entries(current).map(([stage, cards]) => [
        stage,
        cards.map((card) => (card.id === args.id ? { ...card, priority: args.priority ?? null } : card)),
      ]),
    ) as typeof current;
    store.setQuery(api.deals.board, { market: "us" }, next);
  });
  const archive = useMutation(api.deals.archive);

  const all = useMemo(() => {
    const byDeal = new Map((intel ?? []).map(({ dealId, ...summary }) => [dealId as string, summary]));
    return boardRows(board).map((deal) => ({ ...deal, intel: byDeal.get(deal.id) ?? null }));
  }, [board, intel]);
  const shown = useMemo(() => sortDeals(filterDeals(all, view, q), view.sort), [all, view, q]);
  const regions = useMemo(() => regionsOf(all), [all]);
  const ehrs = useMemo(() => ehrsOf(all), [all]);
  const selection = useSelection(
    useMemo(() => shown.filter((deal) => !deal.mirrored).map((deal) => deal.id), [shown]),
    { max: MAX_DEALS_SELECTED, noun: "deals" },
  );
  const selected = useMemo(
    () => shown.filter((deal) => selection.ids.includes(deal.id)),
    [shown, selection.ids],
  );

  const changePriority = (id: string, priority: DealPriority | null) =>
    setPriority({ id: id as Id<"deals">, priority });
  const tell = (action: Promise<unknown>, fallback: string) => {
    setError(null);
    action.catch((failure) => setError(messageOf(failure, fallback)));
  };

  return (
    <div className="space-y-4">
      <SalesTableToolbar
        view={view}
        onView={onView}
        q={q}
        onQ={setQ}
        regions={regions}
        ehrs={ehrs}
        aside={aside}
        shown={shown.length}
        total={all.length}
        add={
          <AddCard
            label="Add a deal"
            fieldLabel="New deal in Lead"
            placeholder="Clinic or company"
            onAdd={(name) => onCreate("lead", name)}
          />
        }
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {selection.notice && (
        <p role="status" className="text-xs text-ink-2">
          {selection.notice}
        </p>
      )}

      {all.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-6 text-sm text-ink-2">
          No US deals yet. Add the first one above.
        </p>
      ) : shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface px-4 py-6 text-sm text-ink-2">
          No deals match.
          <button
            type="button"
            onClick={() => {
              setQ("");
              onView(clearedView(view));
            }}
            className="rounded font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <DealTable
          deals={shown}
          sort={view.sort}
          onSort={(sort) => onView({ ...view, sort })}
          now={now}
          columns={view.columns}
          isSelected={selection.has}
          onToggle={selection.toggle}
          onToggleAll={() => {
            const ids = shown.filter((deal) => !deal.mirrored).map((deal) => deal.id);
            const every = ids.length > 0 && ids.slice(0, MAX_DEALS_SELECTED).every(selection.has);
            if (every) selection.clear();
            else selection.pickAll(ids);
          }}
          onStage={(id, stage) => tell(onMove(id, stage, END), "That move could not be saved.")}
          onPriority={(id, priority) =>
            tell(changePriority(id, priority), "That priority could not be saved.")
          }
        />
      )}

      <DealBulkBar
        selected={selected}
        onStage={(id, stage) => onMove(id, stage, END)}
        onPriority={changePriority}
        onArchive={(id) => archive({ id: id as Id<"deals"> })}
        onKeep={selection.keep}
        onClear={selection.clear}
      />

      <ArchivedDeals market="us" />
    </div>
  );
}
