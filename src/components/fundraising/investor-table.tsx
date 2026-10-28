"use client";

import { CircleXIcon, FileTextIcon, HandshakeIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { UNMAPPED } from "@convex/lib/pipelineStages";
import { ActivityCell, ChipSelect, SelectAll, SortButton, SortHeader } from "@/components/pipeline/table-parts";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNarrow } from "@/hooks/use-narrow";
import { formatValue } from "@/lib/format";
import { syncStateOf, type InvestorCard } from "@/lib/fundraising/sync";
import { ariaSort } from "@/lib/pipeline/table-sort";
import type { InvestorSort, InvestorSortKey } from "@/lib/fundraising/table-view";
import { SYNC_STATE_LABELS } from "@/lib/fundraising/words";
import { ACTIVE_INVESTOR_STAGES, INVESTOR_STALE_DAYS, quietness } from "@/lib/pipeline/derive";
import { INVESTOR_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import { SyncChips } from "./sync-chips";

/** How each investor stage reads as a chip: in conversation in blue, committed in green, the rest quiet. */
export const INVESTOR_STAGE_LOOK: Record<string, { tone: StatusTone; icon?: LucideIcon }> = {
  target: { tone: "neutral" },
  contacted: { tone: "info" },
  meeting: { tone: "info", icon: HandshakeIcon },
  diligence: { tone: "info", icon: FileTextIcon },
  committed: { tone: "success" },
  passed: { tone: "neutral", icon: CircleXIcon },
  [UNMAPPED]: { tone: "neutral" },
};

/** The page of one investor. The id is in the address, never the name. */
export const investorHref = (id: string) => `/fundraising/investors/${encodeURIComponent(id)}`;

const STAGE_OPTIONS = INVESTOR_COLUMNS.map((column) => ({ value: column.id, label: column.title }));

const HEADS: [Exclude<InvestorSortKey, "name">, string, { numeric?: boolean; narrow?: boolean }][] = [
  ["stage", "Stage", { narrow: true }],
  ["amount", "Amount", { numeric: true }],
  ["activity", "Last activity", { narrow: true }],
  ["sync", "Sync", {}],
  ["nextStep", "Next step", {}],
];

/**
 * The investors as a table: the rows the toolbar lets through, in its order.
 * A header that is a button sorts by it (`aria-sort`); the name opens the
 * investor's page; the stage changes in the row for a card that may move;
 * the checkbox selects it for the bulk bar. On a phone (below `sm`) each
 * investor is a card instead, its fields stacked, so nothing sits off to the
 * side of a 375px screen.
 */
export function InvestorTable({
  rows,
  sort,
  onSort,
  now,
  isSelected,
  onToggle,
  onToggleAll,
  onStage,
  onRetry,
}: {
  rows: readonly InvestorCard[];
  sort: InvestorSort;
  onSort: (next: InvestorSort) => void;
  now: number | null;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onStage: (id: string, stage: string) => void;
  onRetry: (id: string) => Promise<unknown>;
}) {
  const narrow = useNarrow();
  const picked = rows.filter((row) => isSelected(row.id)).length;
  const selectAll = (
    <SelectAll
      label="Select every investor shown"
      all={rows.length > 0 && picked === rows.length}
      some={picked > 0 && picked < rows.length}
      disabled={rows.length === 0}
      onToggle={onToggleAll}
    />
  );
  const quietDays = (row: InvestorCard) => {
    if (now === null || row.lastActivityAt === null) return null;
    if (!(ACTIVE_INVESTOR_STAGES as readonly string[]).includes(row.stage)) return null;
    const quiet = quietness(row, now, INVESTOR_STALE_DAYS);
    return quiet.kind === "quiet" ? quiet.days : null;
  };
  const cells = (row: InvestorCard): Record<Exclude<InvestorSortKey, "name">, ReactNode> => ({
    stage: <StageCell row={row} onStage={onStage} />,
    amount: row.amount === null ? <Blank /> : formatValue(row.amount, "currency", "USD"),
    activity: <ActivityCell at={row.lastActivityAt} now={now} quietDays={quietDays(row)} />,
    sync:
      syncStateOf(row) === "none" ? (
        <span className="text-ink-3">{SYNC_STATE_LABELS.none}</span>
      ) : (
        <SyncChips card={row} onRetry={onRetry} className="flex flex-wrap items-center gap-1.5" />
      ),
    nextStep: row.nextStep ?? <Blank>No next step</Blank>,
  });
  const nameLink = (row: InvestorCard) => (
    <Link
      href={investorHref(row.id)}
      className="rounded text-left font-medium text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {row.name}
    </Link>
  );
  const box = (row: InvestorCard, className: string) => (
    <input
      type="checkbox"
      aria-label={`Select ${row.name}`}
      checked={isSelected(row.id)}
      onChange={() => onToggle(row.id)}
      className={className}
    />
  );

  if (narrow) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-2">
          <label className="flex items-center gap-2">
            {selectAll}
            Select all
          </label>
          <span className="inline-flex items-center gap-2">
            Sort by
            <SortButton sort={sort} column="name" onSort={onSort}>
              Name
            </SortButton>
            <SortButton sort={sort} column="amount" onSort={onSort}>
              Amount
            </SortButton>
            <SortButton sort={sort} column="activity" onSort={onSort}>
              Activity
            </SortButton>
          </span>
        </div>
        <ul aria-label="Investors" className="space-y-3">
          {rows.map((row) => {
            const shown = cells(row);
            return (
              <li
                key={row.id}
                data-layout="card"
                className="min-w-0 rounded-inner border border-line bg-panel p-3 text-sm"
              >
                <div className="flex items-start gap-3">
                  {box(row, "mt-1 size-4 shrink-0 accent-brand")}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 [overflow-wrap:anywhere]">{nameLink(row)}</span>
                      <span className="shrink-0 font-num text-xs text-ink-2">{shown.amount}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {shown.stage}
                      {shown.activity}
                    </div>
                    {syncStateOf(row) !== "none" && shown.sync}
                    <p className="text-xs text-ink-2">
                      <span className="text-ink-3">Next: </span>
                      {shown.nextStep}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-panel p-3 shadow-soft-sm">
      <DataTable label="Investors" bleed={false} className="min-w-[56rem]">
        <DataHead>
          <DataHeader aria-sort={ariaSort(sort, "name")} pinned className="sm:min-w-56">
            <span className="inline-flex items-center gap-2.5">
              {selectAll}
              <SortButton sort={sort} column="name" onSort={onSort}>
                Name
              </SortButton>
            </span>
          </DataHeader>
          {HEADS.map(([key, label, options]) => (
            <SortHeader key={key} sort={sort} column={key} onSort={onSort} {...options}>
              {label}
            </SortHeader>
          ))}
        </DataHead>
        <DataBody>
          {rows.map((row) => {
            const shown = cells(row);
            return (
              <DataRow
                key={row.id}
                tone={syncStateOf(row) === "failed" ? "danger" : quietDays(row) !== null ? "warning" : undefined}
              >
                <DataRowHeader pinned className="max-w-[18rem] font-normal sm:min-w-56">
                  <span className="flex items-start gap-2.5">
                    {box(row, "mt-1 size-3.5 shrink-0 accent-brand")}
                    {nameLink(row)}
                  </span>
                </DataRowHeader>
                {HEADS.map(([key, , options]) => (
                  <DataCell
                    key={key}
                    numeric={options.numeric}
                    narrow={options.narrow}
                    className={key === "nextStep" ? "max-w-[16rem]" : key === "activity" ? "whitespace-nowrap" : undefined}
                  >
                    {shown[key]}
                  </DataCell>
                ))}
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
    </div>
  );
}

function StageCell({ row, onStage }: { row: InvestorCard; onStage: (id: string, stage: string) => void }) {
  const look = INVESTOR_STAGE_LOOK[row.stage] ?? INVESTOR_STAGE_LOOK[UNMAPPED]!;
  const title = stageTitle(INVESTOR_COLUMNS, row.stage);
  if (!row.draggable || row.stage === UNMAPPED) {
    return (
      <StatusChip tone={look.tone} icon={look.icon}>
        {title}
      </StatusChip>
    );
  }
  return (
    <ChipSelect
      label={`Stage of ${row.name}`}
      value={row.stage}
      options={STAGE_OPTIONS}
      tone={look.tone}
      icon={look.icon}
      text={title}
      onChange={(stage) => stage !== row.stage && onStage(row.id, stage)}
    />
  );
}
