// What an obligation is, shared by Convex and the UI.

import type { Id } from "../_generated/dataModel";

export const OBLIGATION_CATEGORIES = [
  { id: "hipaa", label: "HIPAA and BAAs" },
  { id: "soc2", label: "SOC 2" },
  { id: "kz_data", label: "Kazakhstan data localisation" },
  { id: "iso27001", label: "ISO 27001" },
  { id: "corporate_tax", label: "Corporate and tax" },
  { id: "contracts", label: "Contract renewals" },
] as const;
export type ObligationCategory = (typeof OBLIGATION_CATEGORIES)[number]["id"];

export const RECURRENCES = ["none", "monthly", "quarterly", "annual"] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: "Does not repeat",
  monthly: "Every month",
  quarterly: "Every quarter",
  annual: "Every year",
};

export const OBLIGATION_STATUSES = ["open", "in_progress", "done", "not_applicable"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const OBLIGATION_STATUS_LABELS: Record<ObligationStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  not_applicable: "Not applicable",
};

/** An obligation as `obligations.list` returns it. */
export type ObligationRow = {
  id: Id<"obligations">;
  category: ObligationCategory;
  title: string;
  due: string | null;
  /** False until someone has checked the date. An unconfirmed date is not a deadline. */
  dueConfirmed: boolean;
  /** The day of the month a repeating date returns to, once it has a date. */
  anchorDay: number | null;
  recurrence: Recurrence;
  status: ObligationStatus;
  evidenceUrl: string | null;
  note: string | null;
  /** Where a date fixed by law is stated. Set only by the starter checklist. */
  sourceUrl: string | null;
  /** The last time it was finished, the date that was due then, and that cycle's evidence. */
  lastDoneAt: number | null;
  lastDoneFor: string | null;
  lastEvidenceUrl: string | null;
  /** When it was last changed (made, edited or finished): the page header's "last change". */
  changedAt: number;
};
