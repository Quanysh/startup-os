// An investor card as the fundraising page reads it: a board card, plus
// whether its last change is on its way to Visible (the daily run sends the
// queue and acks each item: docs/ingest.md), whether someone changed it in
// Visible since, and what the page may do with it.
//
// `investorCard` fills in what an older server does not send yet, so the page
// reads the same before and after the write-back lands: no sync, and a card
// dragged and edited only when it is made here, as before.

import { INVESTOR_STAGES, UNMAPPED } from "@convex/lib/pipelineStages";
import type { BoardCard } from "@/lib/pipeline/derive";
import { rowsInStages } from "@/lib/pipeline/table-sort";

export const SYNC_STATUSES = ["pending", "sent", "failed", "confirmed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** The investor's queued change for Visible, as `investors.board` sends it. */
export type InvestorSync = { status: SyncStatus; errorCode?: string | null; queuedAt: number };

export type InvestorExtras = {
  sync: InvestorSync | null;
  /** Visible's value replaced one sent from here, in the last 7 days. */
  changedInVisible: boolean;
  /** Its name and amount (and stage) can be changed here. Never its contact if mirrored. */
  editable: boolean;
  /** It can be dragged to another stage. */
  draggable: boolean;
};

export type InvestorCard = BoardCard & InvestorExtras;

/** A card with every field the page reads, whichever server sent it. */
export function investorCard(card: BoardCard & Partial<InvestorExtras>): InvestorCard {
  return {
    ...card,
    sync: card.sync ?? null,
    changedInVisible: card.changedInVisible ?? false,
    editable: card.editable ?? !card.mirrored,
    draggable: card.draggable ?? !card.mirrored,
  };
}

/** Every investor on a board, stage by stage in the board's order, then Unsorted. */
export function investorRows(
  board: Readonly<Record<string, readonly (BoardCard & Partial<InvestorExtras>)[]>>,
): InvestorCard[] {
  return rowsInStages(board, [...INVESTOR_STAGES, UNMAPPED]).map(investorCard);
}

/** What a card says about Visible, the most pressing first. */
export const SYNC_STATES = ["failed", "syncing", "changed", "none"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export function syncStateOf(card: Pick<InvestorCard, "sync" | "changedInVisible">): SyncState {
  const status = card.sync?.status;
  if (status === "failed") return "failed";
  if (status === "pending" || status === "sent") return "syncing";
  if (card.changedInVisible) return "changed";
  return "none";
}
