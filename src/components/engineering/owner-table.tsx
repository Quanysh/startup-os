"use client";

import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip } from "@/components/ui/status-chip";
import { ageWords } from "@/lib/engineering/flow";
import type { OwnerRow } from "@/lib/engineering/view";
import { OwnerChip } from "./pull-bits";

/** Said above the table: what it is for, and what it deliberately leaves out. */
export const OWNER_CAPTION =
  "Open work and what is blocked, by engineer. Load, not output: nothing here counts what anyone merged.";

/**
 * Each engineer's open pull requests: how many, where they stand, how many
 * are stuck and how old the oldest is. The most stuck first.
 *
 * About load and blockage, never output: there is no column for what a
 * person merged, and none is to be added (`OwnerRow` has no field for it).
 * A row's name is a button that filters the page to that person; pressed
 * again, it shows everyone.
 */
export function OwnerTable({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly OwnerRow[];
  /** The owner the page is filtered to, by key. */
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  return (
    <DataTable caption="Open pull requests by owner" className="min-w-[40rem]">
      <DataHead>
        <DataHeader pinned>Engineer</DataHeader>
        <DataHeader numeric>Open</DataHeader>
        <DataHeader numeric>Waiting for review</DataHeader>
        <DataHeader numeric>Changes requested</DataHeader>
        <DataHeader numeric>Approved</DataHeader>
        <DataHeader numeric>Stuck</DataHeader>
        <DataHeader numeric>Oldest open</DataHeader>
      </DataHead>
      <DataBody>
        {rows.map((row) => {
          const pressed = selected === row.owner.key;
          return (
            <DataRow key={row.owner.key} tone={row.stuck > 0 ? "danger" : undefined}>
              <DataRowHeader pinned>
                <button
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => onSelect(pressed ? null : row.owner.key)}
                  className="max-w-full rounded-full text-left outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:text-brand"
                >
                  <OwnerChip owner={row.owner} />
                </button>
              </DataRowHeader>
              <DataCell numeric>{row.open}</DataCell>
              <DataCell numeric>{row.waiting}</DataCell>
              <DataCell numeric>{row.changes}</DataCell>
              <DataCell numeric>{row.approved}</DataCell>
              <DataCell numeric>
                {row.stuck > 0 ? <StatusChip tone="danger">{row.stuck}</StatusChip> : row.stuck}
              </DataCell>
              <DataCell numeric>{ageWords(row.oldestMs)}</DataCell>
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
