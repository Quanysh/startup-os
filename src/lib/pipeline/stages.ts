// The pipeline boards' columns: a title and a hint for each stage. The stage
// ids themselves, and the mapping from another system's stage names, live in
// convex/lib/pipelineStages.ts, because the ingest endpoint needs them too.

import {
  UNMAPPED,
  type DealStage,
  type InvestorStage,
} from "@convex/lib/pipelineStages";
import type { BoardColumn } from "@/components/board/board";

// Closed stages keep their own order (most recently closed first), so cards
// cannot be arranged within them by hand: the server would not store it.
export const DEAL_COLUMNS = [
  { id: "lead", title: "Lead", hint: "Not yet a real conversation" },
  { id: "qualified", title: "Qualified", hint: "Has the problem and is talking" },
  { id: "demo", title: "Demo", hint: "Has seen the product" },
  { id: "proposal", title: "Proposal", hint: "Pricing or a pilot is on the table" },
  { id: "won", title: "Won", hint: "Signed, newest first", sortable: false },
  { id: "lost", title: "Lost", hint: "Closed without a sale, newest first", sortable: false },
] as const satisfies readonly (BoardColumn & { id: DealStage })[];

export const INVESTOR_COLUMNS = [
  { id: "target", title: "To contact", hint: "On the list, not yet approached" },
  { id: "contacted", title: "Contacted", hint: "Reached out, no meeting yet" },
  { id: "meeting", title: "Meeting", hint: "In conversation" },
  { id: "diligence", title: "Diligence", hint: "Looking at the numbers or the terms" },
  { id: "committed", title: "Committed", hint: "Said yes, newest first", sortable: false },
  { id: "passed", title: "Passed", hint: "Said no, newest first", sortable: false },
] as const satisfies readonly (BoardColumn & { id: InvestorStage })[];

/** Where a mirrored card waits when its source's stage name is not known. */
export const UNSORTED_COLUMN = {
  id: UNMAPPED,
  title: "Unsorted",
  hint: "A stage name the OS does not know",
  sortable: false,
} as const satisfies BoardColumn;

// Which stages are still in play is the pipeline numbers' to say, and the
// owner's agent reads those too: they live where Convex can import them.
export { ACTIVE_INVESTOR_STAGES, OPEN_DEAL_STAGES } from "@convex/lib/attention/pipelineDerive";

/** The columns to draw: every stage, and "Unsorted" only while it holds a card. */
export function boardColumns(
  columns: readonly BoardColumn[],
  board: Readonly<Record<string, readonly unknown[]>>,
): BoardColumn[] {
  return (board[UNMAPPED]?.length ?? 0) > 0 ? [...columns, UNSORTED_COLUMN] : [...columns];
}

export function stageTitle(columns: readonly BoardColumn[], id: string): string {
  if (id === UNMAPPED) return UNSORTED_COLUMN.title;
  return columns.find((column) => column.id === id)?.title ?? id;
}
