"use client";

import {
  ChevronsDownIcon,
  ChevronsUpIcon,
  CircleXIcon,
  EqualIcon,
  FileTextIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { DEAL_PRIORITIES, type DealPriority } from "@convex/lib/dealDetails";
import { UNMAPPED } from "@convex/lib/pipelineStages";
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
import {
  ActivityCell,
  ChipSelect,
  NotesCell,
  SelectAll,
  SortButton,
  SortHeader,
} from "@/components/pipeline/table-parts";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { DEAL_STALE_DAYS, OPEN_DEAL_STAGES, quietness } from "@/lib/pipeline/derive";
import { signalDateLabel } from "@/lib/pipeline/intel-view";
import { DEAL_COLUMNS, stageTitle } from "@/lib/pipeline/stages";
import {
  BILLING_LABELS,
  COLUMNS,
  ariaSort,
  sizeLabel,
  type ColumnSet,
  type TableDeal,
  type TableSort,
  type TableSortKey,
} from "@/lib/pipeline/table-view";

/** How each stage reads as a chip: under way in blue, won in green, the rest quiet. */
export const STAGE_LOOK: Record<string, { tone: StatusTone; icon?: LucideIcon }> = {
  lead: { tone: "neutral" },
  qualified: { tone: "info" },
  demo: { tone: "info", icon: PresentationIcon },
  proposal: { tone: "info", icon: FileTextIcon },
  won: { tone: "success" },
  lost: { tone: "neutral", icon: CircleXIcon },
  [UNMAPPED]: { tone: "neutral" },
};

/** Priority's chips: high asks first. Each has its own icon, so colour is never the only sign. */
export const PRIORITY_LOOK: Record<DealPriority, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  high: { label: "High", tone: "warning", icon: ChevronsUpIcon },
  medium: { label: "Medium", tone: "info", icon: EqualIcon },
  low: { label: "Low", tone: "neutral", icon: ChevronsDownIcon },
};

const isOpen = (stage: string) => (OPEN_DEAL_STAGES as readonly string[]).includes(stage);

/** Each column's header, and whether it holds figures (right-aligned). */
const HEADS: Record<Exclude<TableSortKey, "name">, { label: string; numeric?: boolean }> = {
  stage: { label: "Stage" },
  priority: { label: "Priority" },
  region: { label: "Region" },
  size: { label: "Size", numeric: true },
  contact: { label: "Contact" },
  nextStep: { label: "Next step" },
  activity: { label: "Last activity" },
  notes: { label: "Notes" },
  sources: { label: "Sources", numeric: true },
  fit: { label: "Fit" },
  ehr: { label: "EHR" },
  billing: { label: "Billing" },
  ownership: { label: "Ownership" },
  signals: { label: "Signals" },
};

/** The page of one deal: its intelligence, and its editor as "Edit details". */
export const dealHref = (id: string) => `/sales/deals/${encodeURIComponent(id)}`;

/**
 * The US deals as a table: the deals the toolbar lets through, in its order,
 * in the columns of the set chosen (the pipeline's, or the intelligence). A
 * header that is a button sorts by it (`aria-sort`); the name opens the
 * deal's page; stage and priority change in the row; the checkbox selects a
 * deal for a bulk action. Notes open in full and sources list their titles
 * on a click (and on hover). A mirrored deal is shown and never changed here.
 */
export function DealTable({
  deals,
  sort,
  onSort,
  now,
  isSelected,
  onToggle,
  onToggleAll,
  onStage,
  onPriority,
  columns = "pipeline",
}: {
  deals: readonly TableDeal[];
  sort: TableSort;
  onSort: (next: TableSort) => void;
  /** null while rendering on the server: dates are shown, not judged. */
  now: number | null;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** The header's checkbox: every deal shown, or none. */
  onToggleAll: () => void;
  onStage: (id: string, stage: string) => void;
  onPriority: (id: string, priority: DealPriority | null) => void;
  /** Which columns: the pipeline's (the default) or the intelligence. */
  columns?: ColumnSet;
}) {
  const selectable = deals.filter((deal) => !deal.mirrored);
  const picked = selectable.filter((deal) => isSelected(deal.id)).length;
  const keys = COLUMNS[columns] as readonly Exclude<TableSortKey, "name">[];

  return (
    <div className="rounded-card bg-panel p-3 shadow-soft-sm">
      <DataTable
        label="US deals"
        bleed={false}
        className={columns === "intel" ? "min-w-[80rem]" : "min-w-[78rem]"}
      >
        <DataHead>
          <DataHeader aria-sort={ariaSort(sort, "name")} pinned className="sm:min-w-64">
            <span className="inline-flex items-center gap-2.5">
              <SelectAll
                label="Select every deal shown"
                all={selectable.length > 0 && picked === selectable.length}
                some={picked > 0 && picked < selectable.length}
                disabled={selectable.length === 0}
                onToggle={onToggleAll}
              />
              <SortButton sort={sort} column="name" onSort={onSort}>
                Name
              </SortButton>
            </span>
          </DataHeader>
          {keys.map((key) => (
            <SortHeader key={key} sort={sort} column={key} onSort={onSort} numeric={HEADS[key].numeric}>
              {HEADS[key].label}
            </SortHeader>
          ))}
        </DataHead>
        <DataBody>
          {deals.map((deal) => {
            const quiet =
              now !== null && deal.lastActivityAt !== null && isOpen(deal.stage)
                ? quietness(deal, now, DEAL_STALE_DAYS)
                : null;
            const size = sizeLabel(deal.physicians ?? null, deal.locations ?? null);
            const cells: Record<Exclude<TableSortKey, "name">, ReactNode> = {
              stage: <StageCell deal={deal} onStage={onStage} />,
              priority: <PriorityCell deal={deal} onPriority={onPriority} />,
              region: deal.region ?? <Blank />,
              size: size ?? <Blank />,
              contact: deal.contact ?? <Blank />,
              nextStep: deal.nextStep ?? <Blank>No next step</Blank>,
              activity: (
                <ActivityCell
                  at={deal.lastActivityAt}
                  now={now}
                  quietDays={quiet?.kind === "quiet" ? quiet.days : null}
                />
              ),
              notes: <NotesCell notes={deal.notes} />,
              sources: <SourcesCell name={deal.name} sources={deal.sources ?? []} />,
              fit: <FitCell fit={deal.intel?.fit ?? null} />,
              ehr: deal.intel?.ehr ?? <Blank />,
              billing:
                deal.intel?.billingModel == null ? <Blank /> : BILLING_LABELS[deal.intel.billingModel],
              ownership: deal.intel?.ownership ?? <Blank />,
              signals: (
                <SignalsCell count={deal.intel?.signals ?? 0} newest={deal.intel?.newestSignal ?? null} />
              ),
            };
            return (
              <DataRow key={deal.id} tone={quiet?.kind === "quiet" ? "warning" : undefined}>
                <DataRowHeader pinned className="max-w-[20rem] font-normal sm:min-w-64">
                  <span className="flex items-start gap-2.5">
                    {deal.mirrored ? (
                      <span aria-hidden className="size-3.5 shrink-0" />
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Select ${deal.name}`}
                        checked={isSelected(deal.id)}
                        onChange={() => onToggle(deal.id)}
                        className="mt-1 size-3.5 shrink-0 accent-brand"
                      />
                    )}
                    <Link
                      href={dealHref(deal.id)}
                      className="rounded text-left font-medium text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {deal.name}
                    </Link>
                  </span>
                </DataRowHeader>
                {keys.map((key) => (
                  <DataCell key={key} numeric={HEADS[key].numeric} className={CELL_CLASS[key]}>
                    {cells[key]}
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

/** How wide a column's cells may grow, where it matters. */
const CELL_CLASS: Partial<Record<TableSortKey, string>> = {
  region: "whitespace-nowrap",
  contact: "max-w-[12rem]",
  nextStep: "max-w-[16rem]",
  activity: "whitespace-nowrap",
  ehr: "max-w-[10rem]",
  billing: "whitespace-nowrap",
  ownership: "max-w-[12rem]",
  signals: "whitespace-nowrap",
};

/**
 * Research's fit score: a short bar and the figure. The bar is for the eye
 * (one hue, one scale); the figure says it.
 */
function FitCell({ fit }: { fit: number | null }) {
  if (fit === null) return <Blank />;
  return (
    <span className="inline-flex items-center gap-2" title={`Fit ${fit} of 100`}>
      <span aria-hidden className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface">
        <span className="block h-full rounded-full bg-brand" style={{ width: `${fit}%` }} />
      </span>
      <span className="font-num text-ink">{fit}</span>
    </span>
  );
}

/** How many signals research found, and the newest one's date under it. */
function SignalsCell({ count, newest }: { count: number; newest: string | null }) {
  if (count === 0) return <Blank>None</Blank>;
  const date = signalDateLabel(newest ?? undefined);
  return (
    <span className="flex flex-col leading-tight">
      <span className="font-num text-ink">{count === 1 ? "1 signal" : `${count} signals`}</span>
      {date !== null && <span className="text-xs text-ink-3">{`Newest ${date}`}</span>}
    </span>
  );
}

const STAGE_OPTIONS = DEAL_COLUMNS.map((column) => ({ value: column.id, label: column.title }));

function StageCell({ deal, onStage }: { deal: TableDeal; onStage: (id: string, stage: string) => void }) {
  const look = STAGE_LOOK[deal.stage] ?? STAGE_LOOK[UNMAPPED]!;
  const title = stageTitle(DEAL_COLUMNS, deal.stage);
  if (deal.mirrored || deal.stage === UNMAPPED) {
    return (
      <StatusChip tone={look.tone} icon={look.icon}>
        {title}
      </StatusChip>
    );
  }
  return (
    <ChipSelect
      label={`Stage of ${deal.name}`}
      value={deal.stage}
      options={STAGE_OPTIONS}
      tone={look.tone}
      icon={look.icon}
      text={title}
      onChange={(stage) => stage !== deal.stage && onStage(deal.id, stage)}
    />
  );
}

const PRIORITY_OPTIONS = [
  ...DEAL_PRIORITIES.map((id) => ({ value: id, label: PRIORITY_LOOK[id].label })),
  { value: "", label: "No priority" },
];

function PriorityCell({
  deal,
  onPriority,
}: {
  deal: TableDeal;
  onPriority: (id: string, priority: DealPriority | null) => void;
}) {
  if (deal.mirrored) return <Blank />;
  const priority = deal.priority ?? null;
  const look = priority === null ? null : PRIORITY_LOOK[priority];
  return (
    <ChipSelect
      label={`Priority of ${deal.name}`}
      value={priority ?? ""}
      options={PRIORITY_OPTIONS}
      tone={look?.tone ?? "neutral"}
      icon={look?.icon ?? EqualIcon}
      variant={look === null ? "outline" : "solid"}
      text={look?.label ?? "Set"}
      onChange={(value) => {
        const next = value === "" ? null : (value as DealPriority);
        if (next !== priority) onPriority(deal.id, next);
      }}
    />
  );
}

/** How many sources; a hover names them (its title) and a click lists them. */
function SourcesCell({ name, sources }: { name: string; sources: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (sources.length === 0) return <Blank>None</Blank>;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={sources.join("\n")}
        onClick={() => setOpen((was) => !was)}
        className="rounded-sm text-ink-2 underline decoration-line decoration-dotted underline-offset-4 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {sources.length === 1 ? "1 source" : `${sources.length} sources`}
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={`Sources of ${name}`}
          className="max-w-[16rem] space-y-0.5 text-left font-sans text-xs whitespace-normal text-ink-2"
        >
          {sources.map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      )}
    </span>
  );
}
