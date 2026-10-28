import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { HANDOFF_STATUSES, handoffKey, isUnaccepted, type HandoffStatus } from "@convex/lib/handoffs";

// /handoffs' view: a status and a bot. It lives in the address (`readView`,
// `writeView`); the narrowing is done here, on the rows already sent.

export type HandoffRow = FunctionReturnType<typeof api.handoffs.list>[number];

export type View = {
  status: HandoffStatus | null;
  /** A bot's key: matches handoffs from it or to it. */
  bot: string | null;
};

export function readView(params: URLSearchParams): View {
  const status = params.get("status") ?? "";
  const bot = handoffKey(params.get("bot") ?? "");
  return {
    status: (HANDOFF_STATUSES as readonly string[]).includes(status) ? (status as HandoffStatus) : null,
    bot: bot === "" ? null : bot,
  };
}

/** The query string for a view: only what differs from the default. */
export function writeView(view: View): string {
  const params = new URLSearchParams();
  if (view.status !== null) params.set("status", view.status);
  if (view.bot !== null) params.set("bot", view.bot);
  return params.toString();
}

export function filterHandoffs(rows: readonly HandoffRow[], view: View): HandoffRow[] {
  return rows.filter(
    (row) =>
      (view.status === null || row.status === view.status) &&
      (view.bot === null || handoffKey(row.from) === view.bot || handoffKey(row.to) === view.bot),
  );
}

/** Every bot named on a handoff, once each by key, for the filter: the first spelling seen. */
export function botsOf(rows: readonly HandoffRow[]): { key: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const name of [row.from, row.to]) if (!seen.has(handoffKey(name))) seen.set(handoffKey(name), name);
  }
  return [...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Open handoffs nobody has accepted in a day: what Today's "Needs you" counts. */
export const unacceptedOf = (rows: readonly HandoffRow[], now: number): HandoffRow[] =>
  rows.filter((row) => isUnaccepted(row, now));

/** How long ago, in the largest whole unit: "5 min", "3 h", "2 days". */
export function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}
