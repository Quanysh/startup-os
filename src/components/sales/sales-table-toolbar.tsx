"use client";

import {
  FlagIcon,
  KanbanSquareIcon,
  MapPinIcon,
  MonitorIcon,
  ReceiptTextIcon,
  SwordsIcon,
  XIcon,
} from "lucide-react";
import { SearchBox, Select } from "@/components/tasks/board-toolbar";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";
import {
  BILLING_LABELS,
  DEFAULT_TABLE_VIEW,
  NO_EHR,
  NO_REGION,
  isIntelFiltered,
  isTableFiltered,
  withColumns,
  type BillingFilter,
  type ColumnSet,
  type CompetitorFilter,
  type DealTableView,
  type PriorityFilter,
  type StageFilter,
} from "@/lib/pipeline/table-view";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<StageFilter, string> = {
  open: "Open stages",
  closed: "Won and lost",
  all: "Every stage",
  ...(Object.fromEntries(DEAL_COLUMNS.map((column) => [column.id, column.title])) as Record<
    (typeof DEAL_COLUMNS)[number]["id"],
    string
  >),
};
const PRIORITY_LABELS: Record<PriorityFilter, string> = {
  any: "Any priority",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};
const BILLING_FILTER_LABELS: Record<BillingFilter, string> = {
  any: "Any billing",
  ...BILLING_LABELS,
  none: "Billing not known",
};
const COMPETITOR_LABELS: Record<CompetitorFilter, string> = {
  any: "Any competitor",
  yes: "Competitor named",
  no: "No competitor named",
};

/** The view with every filter at its default; the layout, sort and columns kept. */
export const clearedView = (view: DealTableView): DealTableView => ({
  ...DEFAULT_TABLE_VIEW,
  layout: view.layout,
  sort: view.sort,
  columns: view.columns,
});

/**
 * The sales table's toolbar: search, then which columns and what narrows the
 * table (stage, priority, region; with the intelligence's columns, EHR,
 * billing and competitors too), then the count. Every filter writes the view,
 * which the page keeps in the address; the search is the page's alone (it
 * holds names). An intelligence filter that is set stays in sight whichever
 * columns are shown, so nothing narrows the table unseen.
 */
export function SalesTableToolbar({
  view,
  onView,
  q,
  onQ,
  regions,
  ehrs = [],
  shown,
  total,
  add,
  aside,
}: {
  view: DealTableView;
  onView: (next: DealTableView) => void;
  q: string;
  onQ: (q: string) => void;
  /** The regions the deals name. */
  regions: readonly string[];
  /** The EHRs the deals' research names. */
  ehrs?: readonly string[];
  shown: number;
  total: number;
  /** The add-a-deal control. */
  add: React.ReactNode;
  /** Beside it, at the row's end: the layout switch. */
  aside?: React.ReactNode;
}) {
  const set = (change: Partial<DealTableView>) => onView({ ...view, ...change });
  const filtered = isTableFiltered(view, q);
  // A region in the address that no deal names any more is still offered, so
  // the control shows what is narrowing the table.
  const named = view.region !== null && view.region !== NO_REGION && !regions.includes(view.region);
  const regionOptions: Record<string, string> = {
    any: "Any region",
    ...Object.fromEntries([...regions, ...(named ? [view.region!] : [])].map((r) => [r, r])),
    [NO_REGION]: "No region",
  };
  const ehrNamed = view.ehr !== null && view.ehr !== NO_EHR && !ehrs.includes(view.ehr);
  const ehrOptions: Record<string, string> = {
    any: "Any EHR",
    ...Object.fromEntries([...ehrs, ...(ehrNamed ? [view.ehr!] : [])].map((e) => [e, e])),
    [NO_EHR]: "No EHR known",
  };
  const intelFilters = view.columns === "intel" || isIntelFiltered(view);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={onQ} label="Search deals" />
        {/* Wraps on a phone: the add box and the Table/Board switch side by side
            are wider than the screen there. */}
        <div className="ml-auto flex min-w-0 flex-wrap items-start justify-end gap-2">
          <div className="w-56 max-w-full shrink-0">{add}</div>
          {aside}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ColumnsSwitch columns={view.columns} onColumns={(columns) => onView(withColumns(view, columns))} />
        <Select
          label="Stage"
          icon={KanbanSquareIcon}
          value={view.stage}
          active={view.stage !== DEFAULT_TABLE_VIEW.stage}
          options={STAGE_LABELS}
          onChange={(stage) => set({ stage })}
        />
        <Select
          label="Priority"
          icon={FlagIcon}
          value={view.priority}
          active={view.priority !== "any"}
          options={PRIORITY_LABELS}
          onChange={(priority) => set({ priority })}
        />
        <Select
          label="Region"
          icon={MapPinIcon}
          value={view.region ?? "any"}
          active={view.region !== null}
          options={regionOptions}
          onChange={(region) => set({ region: region === "any" ? null : region })}
        />
        {intelFilters && (
          <>
            <Select
              label="EHR"
              icon={MonitorIcon}
              value={view.ehr ?? "any"}
              active={view.ehr !== null}
              options={ehrOptions}
              onChange={(ehr) => set({ ehr: ehr === "any" ? null : ehr })}
            />
            <Select
              label="Billing"
              icon={ReceiptTextIcon}
              value={view.billing}
              active={view.billing !== "any"}
              options={BILLING_FILTER_LABELS}
              onChange={(billing) => set({ billing })}
            />
            <Select
              label="Competitors"
              icon={SwordsIcon}
              value={view.competitor}
              active={view.competitor !== "any"}
              options={COMPETITOR_LABELS}
              onChange={(competitor) => set({ competitor })}
            />
          </>
        )}
        <p className="ml-auto flex items-center gap-x-3 pl-2 text-xs text-ink-3">
          {filtered && (
            <button
              type="button"
              onClick={() => {
                onQ("");
                onView(clearedView(view));
              }}
              className="inline-flex items-center gap-0.5 rounded text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <XIcon aria-hidden className="size-3" />
              Clear filters
            </button>
          )}
          <span className="font-num">
            {shown === total
              ? `${total} ${total === 1 ? "deal" : "deals"}`
              : `Showing ${shown} of ${total} deals`}
          </span>
        </p>
      </div>
    </div>
  );
}

/**
 * Which columns the table shows: the pipeline's own, or what research found
 * (fit, EHR, billing, ownership, signals). Two sets rather than fifteen
 * columns, so each reads on a laptop without scrolling sideways.
 */
export function ColumnsSwitch({
  columns,
  onColumns,
}: {
  columns: ColumnSet;
  onColumns: (columns: ColumnSet) => void;
}) {
  const choices: [ColumnSet, string, string][] = [
    ["pipeline", "Pipeline", "Show the pipeline's columns: contact, next step, notes, sources"],
    ["intel", "Intelligence", "Show what research found: fit, EHR, billing, ownership, signals"],
  ];
  return (
    <div role="group" aria-label="Columns" className="inline-flex h-8 shrink-0 gap-0.5 rounded-full bg-surface p-0.5">
      {choices.map(([id, label, title]) => (
        <button
          key={id}
          type="button"
          aria-pressed={columns === id}
          title={title}
          onClick={() => onColumns(id)}
          className={cn(
            "inline-flex items-center rounded-full px-3 text-xs font-medium text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
            columns === id && "bg-panel text-ink shadow-soft-sm",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// The Layout switch is every pipeline's (the US deals and the investors).
export { LayoutSwitch } from "@/components/pipeline/layout-switch";
