// The tool calls a Startup OS run paused on (`agentApprovals`), as the owner's
// approvals read them: what waits (the inbox, its one count and the 09:00
// digest all read `waitingToolCalls`, so they agree) and what was decided
// lately (/approvals' "Decided"). Only Startup OS's own project: a call of
// another project's agent is never one of the owner's approvals.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { STARTUP_OS_PROJECT } from "./agentStartupOs";

type Db = QueryCtx["db"];

/** Tool calls the inbox lists at most (a run stops at ten waiting an agent). */
export const INBOX_TOOL_CALLS = 100;

/** Whether a call is one of the owner's approvals: a Startup OS run's, never another project's. */
export const isOwnersToolCall = (row: Pick<Doc<"agentApprovals">, "project">) => row.project === STARTUP_OS_PROJECT;

/** Every call waiting on the owner's click, newest first, at most `cap` read. */
export async function waitingToolCalls(db: Db, cap: number = INBOX_TOOL_CALLS): Promise<Doc<"agentApprovals">[]> {
  const rows = await db
    .query("agentApprovals")
    .withIndex("by_state_and_createdAt", (q) => q.eq("state", "pending"))
    .order("desc")
    .take(cap);
  return rows.filter(isOwnersToolCall);
}

/** Calls approved or denied at or after `since`, newest decision first, at most `cap` of each read. */
export async function decidedToolCalls(db: Db, since: number, cap: number): Promise<Doc<"agentApprovals">[]> {
  const rows: Doc<"agentApprovals">[] = [];
  for (const state of ["approved", "denied"] as const) {
    rows.push(
      ...(await db
        .query("agentApprovals")
        .withIndex("by_state_and_createdAt", (q) => q.eq("state", state))
        .order("desc")
        .take(cap)),
    );
  }
  return rows
    .filter((row) => isOwnersToolCall(row) && (row.decidedAt ?? 0) >= since)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
}
