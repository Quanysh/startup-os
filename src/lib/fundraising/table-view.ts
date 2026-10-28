// The fundraising page's view: board or table, and in the table which
// investors are shown (stage, what it says about Visible, a search) and in
// what order. Worked out in the browser on the cards `investors.board` sent.
//
// Everything but the search is kept in the address (`readInvestorView` /
// `writeInvestorView`), never in component state. The search is not: what is
// typed there is a firm's or a person's name, and no name goes in a URL
// (CLAUDE.md, Pipelines).

import { CLOSED_STAGES, INVESTOR_STAGES, UNMAPPED } from "@convex/lib/pipelineStages";
import { sortRows, type PipelineLayout, type Sort, type SortValue } from "@/lib/pipeline/table-sort";
import { SYNC_STATES, syncStateOf, type InvestorCard, type SyncState } from "./sync";

export const INVESTOR_STAGE_FILTERS = ["open", "closed", "all", ...INVESTOR_STAGES, UNMAPPED] as const;
export type InvestorStageFilter = (typeof INVESTOR_STAGE_FILTERS)[number];
export const SYNC_FILTERS = ["any", ...SYNC_STATES] as const;
export type SyncFilter = (typeof SYNC_FILTERS)[number];

export const INVESTOR_SORT_KEYS = ["name", "stage", "amount", "activity", "sync", "nextStep"] as const;
export type InvestorSortKey = (typeof INVESTOR_SORT_KEYS)[number];
export type InvestorSort = Sort<InvestorSortKey>;

export type InvestorView = {
  layout: PipelineLayout;
  stage: InvestorStageFilter;
  sync: SyncFilter;
  sort: InvestorSort;
};

/** The board, as the page has always opened; the table opens on the investors still in play. */
export const DEFAULT_INVESTOR_VIEW: InvestorView = {
  layout: "board",
  stage: "open",
  sync: "any",
  sort: null,
};

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

export function readInvestorView(params: URLSearchParams): InvestorView {
  const key = params.get("sort");
  return {
    layout: params.get("view") === "table" ? "table" : "board",
    stage: oneOf(INVESTOR_STAGE_FILTERS, params.get("stage"), "open"),
    sync: oneOf(SYNC_FILTERS, params.get("sync"), "any"),
    sort: INVESTOR_SORT_KEYS.includes(key as InvestorSortKey)
      ? { key: key as InvestorSortKey, dir: params.get("dir") === "desc" ? "desc" : "asc" }
      : null,
  };
}

/** The view as an address query, leaving out whatever is the default. */
export function writeInvestorView(view: InvestorView): string {
  const params = new URLSearchParams();
  if (view.layout !== "board") params.set("view", view.layout);
  if (view.stage !== "open") params.set("stage", view.stage);
  if (view.sync !== "any") params.set("sync", view.sync);
  if (view.sort !== null) {
    params.set("sort", view.sort.key);
    if (view.sort.dir === "desc") params.set("dir", "desc");
  }
  return params.toString();
}

/** Whether anything holds investors back beyond the default. Sorting and the layout do not. */
export function isInvestorFiltered(view: InvestorView, q: string): boolean {
  return q.trim() !== "" || view.stage !== "open" || view.sync !== "any";
}

/** The view with every filter at its default; the layout and sort kept. */
export const clearedInvestorView = (view: InvestorView): InvestorView => ({
  ...DEFAULT_INVESTOR_VIEW,
  layout: view.layout,
  sort: view.sort,
});

const CLOSED: readonly string[] = CLOSED_STAGES.investors;

function stageOk(stage: string, filter: InvestorStageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return !CLOSED.includes(stage);
  if (filter === "closed") return CLOSED.includes(stage);
  return stage === filter;
}

export function filterInvestors<T extends InvestorCard>(
  rows: readonly T[],
  view: InvestorView,
  q: string,
): T[] {
  const words = q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      stageOk(row.stage, view.stage) &&
      (view.sync === "any" || syncStateOf(row) === view.sync) &&
      (words === "" ||
        [row.name, row.contact, row.nextStep, row.notes].some((text) =>
          (text ?? "").toLowerCase().includes(words),
        )),
  );
}

const STAGE_ORDER: readonly string[] = [...INVESTOR_STAGES, UNMAPPED];
const SYNC_RANK: Record<SyncState, number> = { failed: 0, syncing: 1, changed: 2, none: 3 };

const VALUE: Record<InvestorSortKey, (row: InvestorCard) => SortValue> = {
  name: (row) => row.name,
  stage: (row) => STAGE_ORDER.indexOf(row.stage),
  amount: (row) => row.amount,
  activity: (row) => row.lastActivityAt,
  sync: (row) => SYNC_RANK[syncStateOf(row)],
  nextStep: (row) => row.nextStep,
};

/** The investors in order. Unsorted is the board's order; ties keep it too. */
export function sortInvestors<T extends InvestorCard>(rows: readonly T[], sort: InvestorSort): T[] {
  return sortRows(rows, sort, (row, key) => VALUE[key](row));
}

/** The most investors one bulk action takes: `investors.bulk`'s own cap. */
export const MAX_INVESTORS_SELECTED = 100;
