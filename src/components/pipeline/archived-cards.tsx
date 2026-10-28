"use client";

import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";
import type { BoardColumn } from "@/components/board/board";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { formatPeriod } from "@/lib/format";
import { stageTitle } from "@/lib/pipeline/stages";
import { cn } from "@/lib/utils";

export type ArchivedCard = { id: string; name: string; stage: string; archivedAt: number };

/**
 * The cards taken off a board without being deleted, folded away under it.
 * The caller asks for them only while `open` (a query skipped until then),
 * and restores one through `onRestore`; a card restored goes back to the
 * bottom of its stage, with everything it held. The deals and the investors
 * each wrap it with their own query and words.
 */
export function ArchivedCards({
  title,
  empty,
  failed,
  open,
  onToggle,
  rows,
  columns,
  onRestore,
}: {
  /** The toggle and the table's name: "Archived deals". */
  title: string;
  /** Said when nothing is archived. */
  empty: string;
  /** Said when a restore fails and the server gave no reason. */
  failed: string;
  open: boolean;
  onToggle: () => void;
  /** undefined while loading (or folded). */
  rows: readonly ArchivedCard[] | undefined;
  columns: readonly BoardColumn[];
  onRestore: (id: string) => Promise<unknown>;
}) {
  const [report, setReport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const put = async (id: string, stage: string) => {
    setError(null);
    setReport("");
    try {
      await onRestore(id);
      setReport(`Restored to ${stageTitle(columns, stage)}.`);
    } catch (failure) {
      setError(messageOf(failure, failed));
    }
  };

  return (
    <section className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")}
        />
        {title}
      </button>
      {open && (
        <div id={panelId}>
          {rows === undefined ? (
            <Skeleton className="h-24 rounded-card" />
          ) : rows.length === 0 ? (
            <p className="rounded-card bg-surface px-4 py-4 text-sm text-ink-2">{empty}</p>
          ) : (
            <div className="rounded-card bg-panel p-3 shadow-soft-sm">
              <DataTable label={title} bleed={false}>
                <DataHead>
                  <DataHeader pinned>Name</DataHeader>
                  <DataHeader>Stage</DataHeader>
                  <DataHeader>Archived</DataHeader>
                  <ActionsHeader />
                </DataHead>
                <DataBody>
                  {rows.map((card) => (
                    <DataRow key={card.id}>
                      <DataRowHeader pinned>{card.name}</DataRowHeader>
                      <DataCell className="whitespace-nowrap text-ink-2">
                        {stageTitle(columns, card.stage)}
                      </DataCell>
                      <DataCell className="font-num whitespace-nowrap text-ink-2">
                        {formatPeriod("day", localIsoDate(card.archivedAt))}
                      </DataCell>
                      <DataCell actions>
                        <button
                          type="button"
                          aria-label={`Restore ${card.name}`}
                          onClick={() => void put(card.id, card.stage)}
                          className={rowActionClass}
                        >
                          <RotateCcwIcon aria-hidden className="size-3.5" />
                          Restore
                        </button>
                      </DataCell>
                    </DataRow>
                  ))}
                </DataBody>
              </DataTable>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p role="status" className="text-xs text-ink-2 empty:hidden">
        {report}
      </p>
    </section>
  );
}
