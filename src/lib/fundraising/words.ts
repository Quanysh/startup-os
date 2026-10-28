// The fundraising page's words about Visible: the chips on a card, a failed
// send's reason, the sync history and the bulk bar's refusals. A code from the
// server is turned into a sentence here; a code this file does not know is
// never shown as it is, only as the general sentence.

import type { EditorWords } from "@/components/pipeline/card-editor";
import type { SyncState, SyncStatus } from "./sync";

/** The investor editor's own words. */
export const INVESTOR_WORDS: EditorWords = {
  noun: "investor",
  title: "Investor",
  nameLabel: "Investor or firm",
  blankName: "An investor needs a name.",
  amountLabel: "Cheque (USD)",
};

export const SYNC_WORDS = {
  syncing: "Syncing to Visible",
  failed: (reason: string) => `Sync failed: ${reason}`,
  changed: "Changed in Visible",
  retry: "Retry",
  retryFailed: "That could not be queued again. Try again.",
  /** The editor's line for a Visible investor that can be changed here. */
  editorNote:
    "From Visible. A change to its name, stage or amount is sent to Visible in the daily run; its contact is changed there. The next step and notes go to Visible as a note.",
} as const;

/** The table's sync filter and column. */
export const SYNC_STATE_LABELS: Record<SyncState, string> = {
  failed: "Sync failed",
  syncing: "Syncing to Visible",
  changed: "Changed in Visible",
  none: "Up to date",
};

/** A row of the sync history. */
export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  pending: "Queued",
  sent: "Sent to Visible",
  failed: "Failed",
  confirmed: "Confirmed by Visible",
};

/** Why a send failed, by the ack's code (docs/ingest.md). */
const SYNC_ERRORS: Record<string, string> = {
  unmapped_stage: "Visible has no stage that matches",
  not_found: "Visible no longer has this investor",
  rejected: "Visible refused the change",
  rate_limited: "Visible asked to slow down",
  timeout: "Visible did not answer in time",
  duplicate: "Visible already has an investor of that name",
};
const SYNC_ERROR_FALLBACK = "Visible did not take the change";

export function syncErrorWords(code: string | null | undefined): string {
  return code != null && Object.hasOwn(SYNC_ERRORS, code) ? SYNC_ERRORS[code]! : SYNC_ERROR_FALLBACK;
}

/** Why `investors.bulk` refused one investor, by its code. */
const BULK_REFUSALS: Record<string, string> = {
  not_found: "It is no longer on the board.",
  archived: "It is archived.",
  mirrored: "Its source owns that field.",
  not_editable: "Its source owns that field.",
  bad_stage: "That stage is not one of the board's.",
  unmapped_stage: "That stage is not one of the board's.",
  too_long: "The next step is too long.",
  contact_detail: "A next step may not hold an email address or a phone number.",
  not_allowed: "You cannot change that investor.",
};
const BULK_FALLBACK = "That change could not be saved.";

export function bulkRefusalWords(code: string | undefined): string {
  return code !== undefined && Object.hasOwn(BULK_REFUSALS, code) ? BULK_REFUSALS[code]! : BULK_FALLBACK;
}
