// Whether an obligation is due, and how to say so. Decided on the client,
// from today's date: a query cannot know what today is. Pure: `today` and
// `now` are arguments.
//
// A date is a deadline only once it is confirmed. An unconfirmed date is
// never due and never overdue, however old it is.

import { DUE_SOON_DAYS } from "../limits";
import type { ObligationRow } from "../obligationShape";
import { daysBetween } from "./dates";
import { dayLabel } from "./format";

export type DueState =
  | "done"
  | "not_applicable"
  | "no_date"
  | "unconfirmed"
  | "overdue"
  | "due_soon"
  | "upcoming";

export type Due = { state: DueState; /** Days until it is due; negative once overdue. */ days: number | null };

type Dated = Pick<ObligationRow, "status" | "due" | "dueConfirmed">;

/** `today` is the owner's calendar date, "YYYY-MM-DD" (`localIsoDate`). */
export function dueState(o: Dated, today: string): Due {
  if (o.status === "done") return { state: "done", days: null };
  if (o.status === "not_applicable") return { state: "not_applicable", days: null };
  if (o.due === null) return { state: "no_date", days: null };
  if (!o.dueConfirmed) return { state: "unconfirmed", days: null };
  const days = daysBetween(today, o.due);
  if (days < 0) return { state: "overdue", days };
  return { state: days <= DUE_SOON_DAYS ? "due_soon" : "upcoming", days };
}

export function dueText(o: Dated, today: string, now: number): string {
  const { state, days } = dueState(o, today);
  const date = o.due === null ? "" : dayLabel(o.due, now);
  switch (state) {
    case "done":
      return "Done";
    case "not_applicable":
      return "Not applicable";
    case "no_date":
      return "No date yet";
    case "unconfirmed":
      return `Unconfirmed: ${date}`;
    case "overdue":
      return `Overdue by ${days === -1 ? "1 day" : `${-days!} days`} · was due ${date}`;
    case "due_soon":
      if (days === 0) return "Due today";
      if (days === 1) return "Due tomorrow";
      return `Due in ${days} days · ${date}`;
    case "upcoming":
      return `Due ${date}`;
  }
}

export type ComplianceSummary = {
  /** Oldest first. */
  overdue: ObligationRow[];
  /** Nearest first. */
  dueSoon: ObligationRow[];
  /** A date entered and not yet confirmed. */
  unconfirmed: ObligationRow[];
  noDate: number;
  done: number;
  total: number;
};

export function complianceSummary(rows: readonly ObligationRow[], today: string): ComplianceSummary {
  const of = (state: DueState) => rows.filter((o) => dueState(o, today).state === state);
  const byDue = (a: ObligationRow, b: ObligationRow) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0);
  return {
    overdue: of("overdue").sort(byDue),
    dueSoon: of("due_soon").sort(byDue),
    unconfirmed: of("unconfirmed"),
    noDate: of("no_date").length,
    done: of("done").length,
    total: rows.length,
  };
}
