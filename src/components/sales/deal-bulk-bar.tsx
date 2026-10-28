"use client";

import { useState } from "react";
import { DEAL_PRIORITIES, type DealPriority } from "@convex/lib/dealDetails";
import { DEAL_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import type { TableDeal } from "@/lib/pipeline/table-view";
import { BulkArchive, BulkBar, bulkControlClass as control } from "@/components/pipeline/bulk-bar";
import { bulkReport, runBulk } from "@/lib/tasks/bulk";
import { PRIORITY_LOOK } from "./deal-table";

/**
 * What to do with the deals ticked in the table: give them a stage or a
 * priority, or archive them (asked first; they can be restored). Each deal
 * goes through the same mutation a change in its row does, one after another,
 * and the outcome is said in a status line with the server's sentence for
 * whatever it refused, as the task board's bar does. The refused deals stay
 * selected; the rest are let go.
 */
export function DealBulkBar({
  selected,
  onStage,
  onPriority,
  onArchive,
  onKeep,
  onClear,
}: {
  /** The deals ticked, as they are on screen. */
  selected: readonly TableDeal[];
  onStage: (id: string, stage: string) => Promise<unknown>;
  onPriority: (id: string, priority: DealPriority | null) => Promise<unknown>;
  onArchive: (id: string) => Promise<unknown>;
  onKeep: (ids: readonly string[]) => void;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState("");
  const count = selected.length;

  const run = async (
    deals: readonly TableDeal[],
    act: (id: string) => Promise<unknown>,
    done: (count: number) => string,
  ) => {
    if (busy) return;
    setBusy(true);
    const outcomes = await runBulk(
      deals.map((deal) => deal.id),
      act,
    );
    setReport(bulkReport(outcomes, done));
    const refused = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.id);
    if (refused.length === 0) onClear();
    else onKeep(refused);
    setBusy(false);
  };

  const moveTo = (stage: string) => {
    const title = stageTitle(DEAL_COLUMNS, stage);
    const deals = selected.filter((deal) => deal.stage !== stage);
    if (deals.length === 0) return setReport(`Already in ${title}.`);
    void run(
      deals,
      (id) => onStage(id, stage),
      (n) => `${n} moved to ${title}`,
    );
  };
  const prioritise = (value: string) => {
    const priority = value === "none" ? null : (value as DealPriority);
    void run(
      selected,
      (id) => onPriority(id, priority),
      (n) =>
        priority === null
          ? `Priority cleared on ${n}`
          : `Priority set to ${PRIORITY_LOOK[priority].label} on ${n}`,
    );
  };

  return (
    <BulkBar label="Selected deals" count={count} busy={busy} onClear={onClear} report={report}>
      <select
        aria-label="Set stage"
        aria-disabled={busy}
        value=""
        onChange={(event) => event.target.value && moveTo(event.target.value)}
        className={control}
      >
        <option value="">Set stage…</option>
        {DEAL_COLUMNS.map((column) => (
          <option key={column.id} value={column.id}>
            {column.title}
          </option>
        ))}
      </select>
      <select
        aria-label="Set priority"
        aria-disabled={busy}
        value=""
        onChange={(event) => event.target.value && prioritise(event.target.value)}
        className={control}
      >
        <option value="">Set priority…</option>
        {DEAL_PRIORITIES.map((id) => (
          <option key={id} value={id}>
            {PRIORITY_LOOK[id].label}
          </option>
        ))}
        <option value="none">No priority</option>
      </select>
      <BulkArchive
        count={count}
        one="deal"
        many="deals"
        busy={busy}
        onArchive={() =>
          void run(selected, onArchive, (n) =>
            `${n} archived: ${n === 1 ? "it is" : "they are"} under Archived deals, where ${n === 1 ? "it" : "they"} can be restored`,
          )
        }
      />
    </BulkBar>
  );
}
