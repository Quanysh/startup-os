// The US sales table's view: which deals are shown (stage, priority, region,
// search) and in what order, and whether the section shows the table or the
// board. Worked out in the browser on the cards `deals.board` already sent.
//
// Which columns it shows is a choice of two sets: the pipeline's own (who,
// what next, notes, sources) and the intelligence (fit, EHR, billing,
// ownership, signals), each a table that reads on a laptop without scrolling
// sideways. The intelligence set has filters of its own (EHR, billing model,
// whether research names a competitor).
//
// Everything but the search is kept in the address (`readTableView` /
// `writeTableView`), never in component state. The search is not: what is
// typed there is a clinic's or a person's name, and no name goes in a URL
// (CLAUDE.md, Pipelines). It lives in the page while it is open.

import { DEAL_PRIORITIES, type DealDetails, type DealPriority } from "@convex/lib/dealDetails";
import {
  BILLING_MODELS,
  INTEL_LIMITS,
  type BillingModel,
  type IntelSummary,
} from "@convex/lib/dealIntel";
import { MAX_REGION_LENGTH } from "@convex/lib/limits";
import { DEAL_STAGES, UNMAPPED } from "@convex/lib/pipelineStages";
import { OPEN_DEAL_STAGES, type BoardCard } from "@/lib/pipeline/derive";
import {
  ariaSort as ariaSortOf,
  nextSort as nextSortOf,
  rowsInStages,
  sortRows,
  type Sort,
  type SortValue,
} from "@/lib/pipeline/table-sort";

// The sort and its headers are every pipeline table's (`table-sort.ts`).
export { lastActivityLabel } from "@/lib/pipeline/table-sort";

/**
 * A deal as the table reads it: a board card with its details (a mirrored one
 * has none), and what its research found (`dealIntel.list`), null when none.
 */
export type TableDeal = BoardCard & Partial<DealDetails> & { intel?: IntelSummary | null };

export const STAGE_FILTERS = ["open", "closed", "all", ...DEAL_STAGES] as const;
export type StageFilter = (typeof STAGE_FILTERS)[number];
export const PRIORITY_FILTERS = ["any", ...DEAL_PRIORITIES, "none"] as const;
export type PriorityFilter = (typeof PRIORITY_FILTERS)[number];
/** The region filter's value for deals with no region. */
export const NO_REGION = "none";
/** The EHR filter's value for deals whose research names none (or that have no research). */
export const NO_EHR = "none";
export const BILLING_FILTERS = ["any", ...BILLING_MODELS, "none"] as const;
export type BillingFilter = (typeof BILLING_FILTERS)[number];
export const COMPETITOR_FILTERS = ["any", "yes", "no"] as const;
export type CompetitorFilter = (typeof COMPETITOR_FILTERS)[number];
export const COLUMN_SETS = ["pipeline", "intel"] as const;
export type ColumnSet = (typeof COLUMN_SETS)[number];

export const TABLE_SORT_KEYS = [
  "name",
  "stage",
  "priority",
  "region",
  "size",
  "contact",
  "nextStep",
  "activity",
  "notes",
  "sources",
  "fit",
  "ehr",
  "billing",
  "ownership",
  "signals",
] as const;
export type TableSortKey = (typeof TABLE_SORT_KEYS)[number];

/**
 * The columns each set shows after the name, in order. The pipeline's are the
 * table as it was; the intelligence set keeps who and what next and trades
 * contact, notes and sources (on the deal's page) for what research found.
 */
export const COLUMNS: Record<ColumnSet, readonly TableSortKey[]> = {
  pipeline: ["stage", "priority", "region", "size", "contact", "nextStep", "activity", "notes", "sources"],
  intel: ["stage", "priority", "fit", "ehr", "billing", "ownership", "signals", "region", "size", "nextStep", "activity"],
};

/** Whether a set shows a column; the name is in both. */
const shows = (set: ColumnSet, key: TableSortKey) => key === "name" || COLUMNS[set].includes(key);
/** null: the board's order (stage by stage, each column as arranged). */
export type TableSort = Sort<TableSortKey>;

export type DealTableView = {
  layout: "table" | "board";
  stage: StageFilter;
  priority: PriorityFilter;
  /** A region, NO_REGION, or null for any. */
  region: string | null;
  sort: TableSort;
  /** Which columns: the pipeline's, or the intelligence. */
  columns: ColumnSet;
  /** An EHR, NO_EHR, or null for any. */
  ehr: string | null;
  billing: BillingFilter;
  competitor: CompetitorFilter;
};

/** The table, the deals still in play, any priority and region, in the board's order. */
export const DEFAULT_TABLE_VIEW: DealTableView = {
  layout: "table",
  stage: "open",
  priority: "any",
  region: null,
  sort: null,
  columns: "pipeline",
  ehr: null,
  billing: "any",
  competitor: "any",
};

const CLOSED: readonly string[] = ["won", "lost"];

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

export function readTableView(params: URLSearchParams): DealTableView {
  const region = (params.get("region") ?? "").trim().slice(0, MAX_REGION_LENGTH);
  const ehr = (params.get("ehr") ?? "").trim().slice(0, INTEL_LIMITS.system);
  const columns = oneOf(COLUMN_SETS, params.get("cols"), "pipeline");
  const key = params.get("sort");
  return {
    layout: params.get("view") === "board" ? "board" : "table",
    stage: oneOf(STAGE_FILTERS, params.get("stage"), "open"),
    priority: oneOf(PRIORITY_FILTERS, params.get("priority"), "any"),
    region: region === "" ? null : region,
    // A sort by a column the set does not show is not kept: nothing would say it.
    sort:
      TABLE_SORT_KEYS.includes(key as TableSortKey) && shows(columns, key as TableSortKey)
        ? { key: key as TableSortKey, dir: params.get("dir") === "desc" ? "desc" : "asc" }
        : null,
    columns,
    ehr: ehr === "" ? null : ehr,
    billing: oneOf(BILLING_FILTERS, params.get("billing"), "any"),
    competitor: oneOf(COMPETITOR_FILTERS, params.get("competitor"), "any"),
  };
}

/** The view with another set of columns, and without a sort the set no longer shows. */
export function withColumns(view: DealTableView, columns: ColumnSet): DealTableView {
  return {
    ...view,
    columns,
    sort: view.sort !== null && shows(columns, view.sort.key) ? view.sort : null,
  };
}

/** The view as an address query, leaving out whatever is the default. */
export function writeTableView(view: DealTableView): string {
  const params = new URLSearchParams();
  if (view.layout !== "table") params.set("view", view.layout);
  if (view.stage !== "open") params.set("stage", view.stage);
  if (view.priority !== "any") params.set("priority", view.priority);
  if (view.region !== null) params.set("region", view.region);
  if (view.columns !== "pipeline") params.set("cols", view.columns);
  if (view.ehr !== null) params.set("ehr", view.ehr);
  if (view.billing !== "any") params.set("billing", view.billing);
  if (view.competitor !== "any") params.set("competitor", view.competitor);
  if (view.sort !== null) {
    params.set("sort", view.sort.key);
    if (view.sort.dir === "desc") params.set("dir", "desc");
  }
  return params.toString();
}

/** Whether anything holds deals back beyond the default. Sorting and the layout do not. */
export function isTableFiltered(view: DealTableView, q: string): boolean {
  return (
    q.trim() !== "" ||
    view.stage !== "open" ||
    view.priority !== "any" ||
    view.region !== null ||
    isIntelFiltered(view)
  );
}

/** Whether the intelligence's own filters hold deals back. */
export function isIntelFiltered(view: DealTableView): boolean {
  return view.ehr !== null || view.billing !== "any" || view.competitor !== "any";
}

/** Every card of a board, in the board's order: the stages in turn, then "unmapped". */
export function boardRows<T>(board: Readonly<Record<string, readonly T[]>>): T[] {
  return rowsInStages(board, [...DEAL_STAGES, UNMAPPED]);
}

const sameText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;

function stageOk(stage: string, filter: StageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return (OPEN_DEAL_STAGES as readonly string[]).includes(stage);
  if (filter === "closed") return CLOSED.includes(stage);
  return stage === filter;
}

export function filterDeals<T extends TableDeal>(
  rows: readonly T[],
  view: DealTableView,
  q: string,
): T[] {
  const words = q.trim().toLowerCase();
  return rows.filter(
    (deal) =>
      stageOk(deal.stage, view.stage) &&
      (view.priority === "any" ||
        (view.priority === "none" ? (deal.priority ?? null) === null : deal.priority === view.priority)) &&
      (view.region === null ||
        (view.region === NO_REGION
          ? (deal.region ?? null) === null
          : deal.region != null && sameText(deal.region, view.region))) &&
      intelOk(deal.intel ?? null, view) &&
      (words === "" ||
        [deal.name, deal.contact, deal.notes, deal.intel?.ehr, deal.intel?.ownership].some((text) =>
          (text ?? "").toLowerCase().includes(words),
        )),
  );
}

function intelOk(intel: IntelSummary | null, view: DealTableView): boolean {
  const ehr = intel?.ehr ?? null;
  const billing = intel?.billingModel ?? null;
  const competitors = intel?.competitors ?? 0;
  return (
    (view.ehr === null ||
      (view.ehr === NO_EHR ? ehr === null : ehr !== null && sameText(ehr, view.ehr))) &&
    (view.billing === "any" || (view.billing === "none" ? billing === null : billing === view.billing)) &&
    (view.competitor === "any" || (view.competitor === "yes") === competitors > 0)
  );
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
const stageRank = (stage: string) => {
  const at = (DEAL_STAGES as readonly string[]).indexOf(stage);
  return at === -1 ? DEAL_STAGES.length : at;
};
const PRIORITY_RANK: Record<DealPriority, number> = { high: 0, medium: 1, low: 2 };


/** How each key reads a deal; null sorts last whichever way. */
const VALUE: Record<TableSortKey, (deal: TableDeal) => SortValue> = {
  name: (deal) => deal.name,
  stage: (deal) => stageRank(deal.stage),
  priority: (deal) => (deal.priority == null ? null : PRIORITY_RANK[deal.priority]),
  region: (deal) => deal.region ?? null,
  size: (deal) =>
    deal.physicians == null && deal.locations == null
      ? null
      : [deal.physicians ?? -1, deal.locations ?? -1],
  contact: (deal) => deal.contact,
  nextStep: (deal) => deal.nextStep,
  activity: (deal) => deal.lastActivityAt,
  notes: (deal) => deal.notes,
  sources: (deal) => deal.sources?.length ?? 0,
  fit: (deal) => deal.intel?.fit ?? null,
  ehr: (deal) => deal.intel?.ehr ?? null,
  billing: (deal) => deal.intel?.billingModel ?? null,
  ownership: (deal) => deal.intel?.ownership ?? null,
  // The newest signal's date (a month alone before its days, undated first),
  // then how many. A deal with none sorts last either way.
  signals: (deal) =>
    (deal.intel?.signals ?? 0) === 0
      ? null
      : [signalDay(deal.intel!.newestSignal), deal.intel!.signals],
};

/** "2026-09" → 20260900, "2026-09-14" → 20260914, none → 0: a date as a number that sorts. */
function signalDay(date: string | null): number {
  if (date === null) return 0;
  const [year, month, day] = date.split("-").map(Number);
  return (year ?? 0) * 10_000 + (month ?? 0) * 100 + (day ?? 0);
}

/** The deals in order. Unsorted is the order given; ties keep it too. */
export function sortDeals<T extends TableDeal>(rows: readonly T[], sort: TableSort): T[] {
  return sortRows(rows, sort, (deal, key) => VALUE[key](deal));
}

/** What a click on a column's header asks for: ascending first, then the other way. */
export const nextSort = (current: TableSort, key: TableSortKey): TableSort => nextSortOf(current, key);

/** A header's `aria-sort`. */
export const ariaSort = (sort: TableSort, key: TableSortKey) => ariaSortOf(sort, key);

/** The regions the deals name, once each whatever their capitals, in order. */
export function regionsOf(rows: readonly TableDeal[]): string[] {
  const found: string[] = [];
  for (const deal of rows) {
    if (deal.region != null && !found.some((region) => sameText(region, deal.region!))) {
      found.push(deal.region);
    }
  }
  return found.sort(byText);
}

/** The EHRs research names, once each whatever their capitals, in order. */
export function ehrsOf(rows: readonly TableDeal[]): string[] {
  const found: string[] = [];
  for (const deal of rows) {
    const ehr = deal.intel?.ehr ?? null;
    if (ehr !== null && !found.some((known) => sameText(known, ehr))) found.push(ehr);
  }
  return found.sort(byText);
}

/** How a billing model reads. */
export const BILLING_LABELS: Record<BillingModel, string> = {
  "in-house": "In-house",
  outsourced: "Outsourced",
  hybrid: "Hybrid",
};

/** "59 phys · 29 loc", or as much of it as is known; null when neither is. */
export function sizeLabel(physicians: number | null, locations: number | null): string | null {
  const parts = [
    physicians === null ? null : `${physicians} phys`,
    locations === null ? null : `${locations} loc`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
