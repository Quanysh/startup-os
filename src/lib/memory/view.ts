import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { DECISION_STATUSES, isRevisitDue, type DecisionStatus } from "@convex/lib/memory";

// /memory's view: which tab, and the decisions' filters. It lives in the
// address (read with `readView`, written with `writeView`), never in
// component state, and the narrowing is done here on the rows already sent.

export type DecisionRow = FunctionReturnType<typeof api.decisions.list>[number];

export const MEMORY_TABS = ["decisions", "meetings", "notes"] as const;
export type MemoryTab = (typeof MEMORY_TABS)[number];

export type View = {
  tab: MemoryTab;
  status: DecisionStatus | null;
  /** An owner's address. */
  owner: string | null;
  tag: string | null;
  /** Words to look for. */
  q: string;
  /** Decided on or after this day, "YYYY-MM-DD". */
  from: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readView(params: URLSearchParams): View {
  const tab = params.get("tab");
  const status = params.get("status");
  const from = params.get("from");
  return {
    tab: tab === "meetings" || tab === "notes" ? tab : "decisions",
    status: (DECISION_STATUSES as readonly string[]).includes(status ?? "") ? (status as DecisionStatus) : null,
    owner: params.get("owner") || null,
    tag: params.get("tag") || null,
    q: (params.get("q") ?? "").slice(0, 100),
    from: from !== null && DAY.test(from) ? from : null,
  };
}

/** The query string for a view: only what differs from the default. */
export function writeView(view: View): string {
  const params = new URLSearchParams();
  if (view.tab !== "decisions") params.set("tab", view.tab);
  if (view.status !== null) params.set("status", view.status);
  if (view.owner !== null) params.set("owner", view.owner);
  if (view.tag !== null) params.set("tag", view.tag);
  if (view.q !== "") params.set("q", view.q);
  if (view.from !== null) params.set("from", view.from);
  return params.toString();
}

export function filterDecisions(rows: readonly DecisionRow[], view: View): DecisionRow[] {
  const words = view.q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (view.status === null || row.status === view.status) &&
      (view.owner === null || row.owner?.email === view.owner) &&
      (view.tag === null || row.tags.includes(view.tag)) &&
      (view.from === null || row.decidedOn >= view.from) &&
      (words === "" ||
        [row.title, row.decision, row.context ?? ""].some((text) => text.toLowerCase().includes(words))),
  );
}

/** The decisions whose revisit has come on `today`, oldest date first. */
export function dueForRevisit(rows: readonly DecisionRow[], today: string): DecisionRow[] {
  return rows
    .filter((row) => isRevisitDue(row, today))
    .sort((a, b) => (a.revisitOn! < b.revisitOn! ? -1 : 1));
}
