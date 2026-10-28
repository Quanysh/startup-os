"use client";

import { useMutation } from "convex/react";
import { CloudIcon, KanbanSquareIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { SearchBox, Select } from "@/components/tasks/board-toolbar";
import { useSelection } from "@/components/tasks/use-selection";
import { messageOf } from "@/lib/errors";
import type { InvestorCard } from "@/lib/fundraising/sync";
import {
  DEFAULT_INVESTOR_VIEW,
  MAX_INVESTORS_SELECTED,
  clearedInvestorView,
  filterInvestors,
  isInvestorFiltered,
  sortInvestors,
  type InvestorStageFilter,
  type InvestorView,
  type SyncFilter,
} from "@/lib/fundraising/table-view";
import { SYNC_STATE_LABELS } from "@/lib/fundraising/words";
import { INVESTOR_COLUMNS, UNSORTED_COLUMN } from "@/lib/pipeline/stages";
import { ArchivedInvestors } from "./archived-investors";
import { InvestorBulkBar, type InvestorBulkAction, type InvestorBulkResult } from "./investor-bulk-bar";
import { InvestorTable } from "./investor-table";

/** A large index: the end of the stage, wherever that is. */
const END = Number.MAX_SAFE_INTEGER;

const STAGE_LABELS: Record<InvestorStageFilter, string> = {
  open: "Still in play",
  closed: "Committed and passed",
  all: "Every stage",
  ...(Object.fromEntries(INVESTOR_COLUMNS.map((column) => [column.id, column.title])) as Record<
    (typeof INVESTOR_COLUMNS)[number]["id"],
    string
  >),
  [UNSORTED_COLUMN.id]: UNSORTED_COLUMN.title,
};
const SYNC_LABELS: Record<SyncFilter, string> = { any: "Any sync", ...SYNC_STATE_LABELS };

/**
 * The investors as a table: the same cards `investors.board` sends the board,
 * filtered and sorted in the browser by the view the page keeps in the
 * address, with the search held here (it holds names). A stage changed in a
 * row goes through the board's own move; the bulk bar through
 * `investors.bulk`. Archived investors are folded away under it.
 */
export function InvestorsTable({
  rows,
  view,
  onView,
  now,
  onMove,
  onRetry,
  aside,
}: {
  rows: readonly InvestorCard[];
  view: InvestorView;
  onView: (next: InvestorView) => void;
  now: number | null;
  onMove: (id: string, stage: string, index: number) => Promise<unknown>;
  onRetry: (id: string) => Promise<unknown>;
  /** At the end of the toolbar's first row: the layout switch. */
  aside?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bulk = useMutation(api.investors.bulk);

  const shown = useMemo(() => sortInvestors(filterInvestors(rows, view, q), view.sort), [rows, view, q]);
  const selection = useSelection(
    useMemo(() => shown.map((row) => row.id), [shown]),
    { max: MAX_INVESTORS_SELECTED, noun: "investors" },
  );
  const selected = useMemo(() => shown.filter((row) => selection.ids.includes(row.id)), [shown, selection.ids]);
  const filtered = isInvestorFiltered(view, q);
  const set = (change: Partial<InvestorView>) => onView({ ...view, ...change });
  const clear = () => {
    setQ("");
    onView(clearedInvestorView(view));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={q} onChange={setQ} label="Search investors" />
          <div className="ml-auto flex min-w-0 flex-wrap items-start justify-end gap-2">{aside}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            label="Stage"
            icon={KanbanSquareIcon}
            value={view.stage}
            active={view.stage !== DEFAULT_INVESTOR_VIEW.stage}
            options={STAGE_LABELS}
            onChange={(stage) => set({ stage })}
          />
          <Select
            label="Sync"
            icon={CloudIcon}
            value={view.sync}
            active={view.sync !== "any"}
            options={SYNC_LABELS}
            onChange={(sync) => set({ sync })}
          />
          <p className="ml-auto flex items-center gap-x-3 pl-2 text-xs text-ink-3">
            {filtered && (
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-0.5 rounded text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon aria-hidden className="size-3" />
                Clear filters
              </button>
            )}
            <span className="font-num">
              {shown.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? "investor" : "investors"}`
                : `Showing ${shown.length} of ${rows.length} investors`}
            </span>
          </p>
        </div>
      </div>

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

      {rows.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-6 text-sm text-ink-2">No investors yet.</p>
      ) : shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface px-4 py-6 text-sm text-ink-2">
          No investors match.
          <button
            type="button"
            onClick={clear}
            className="rounded font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <InvestorTable
          rows={shown}
          sort={view.sort}
          onSort={(sort) => onView({ ...view, sort })}
          now={now}
          isSelected={selection.has}
          onToggle={selection.toggle}
          onToggleAll={() => {
            const ids = shown.map((row) => row.id);
            const every = ids.length > 0 && ids.slice(0, MAX_INVESTORS_SELECTED).every(selection.has);
            if (every) selection.clear();
            else selection.pickAll(ids);
          }}
          onStage={(id, stage) => {
            setError(null);
            onMove(id, stage, END).catch((failure) =>
              setError(messageOf(failure, "That move could not be saved.")),
            );
          }}
          onRetry={onRetry}
        />
      )}

      <InvestorBulkBar
        selected={selected}
        onBulk={(ids: string[], action: InvestorBulkAction) =>
          bulk({ ids: ids as Id<"investors">[], action }).then((done): readonly InvestorBulkResult[] => done.results)
        }
        onKeep={selection.keep}
        onClear={selection.clear}
      />

      <ArchivedInvestors />
    </div>
  );
}
