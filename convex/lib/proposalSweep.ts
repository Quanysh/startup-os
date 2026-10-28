// Clearing duplicate and superseded open proposals in one pass
// (`proposal_sweep`). The plan is pure; the write is `sweepProposals`.
//
// A duplicate is an older open proposal with the same dedupeKey. A superseded
// one is an older open proposal of the same company, kind and subject, once
// duplicates are taken out (a task change does not supersede an archive: the
// kind is part of the subject). Each withdrawn row is logged with a reason
// and no title. A bot sweeps only what it filed, unless it is the chief of
// staff, which sweeps every open proposal.

import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { filedBy, type AgentId } from "./agents";
import type { CompanyId } from "./company";

/** How many proposals one sweep withdraws. A fuller pass sets `more`. */
export const SWEEP_LIMIT = 50;
/** Open proposals read in one pass. */
const SWEEP_CANDIDATES = 500;

export const SWEEP_REASONS = ["duplicate", "superseded"] as const;
export type SweepReason = (typeof SWEEP_REASONS)[number];

/** Fixed notes stored on the withdrawn row. No title, name or payload. */
export const SWEEP_NOTES: Record<SweepReason, string> = {
  duplicate: "Swept: a newer proposal has the same dedupeKey.",
  superseded: "Swept: a newer proposal is on the same subject.",
};

export const SWEEP_WORDS = {
  who: "Name the agent you run as, or call as a bot. Only the chief of staff sweeps proposals it did not file.",
} as const;

export type SweepRow = {
  id: string;
  company: string;
  kind: string;
  dedupeKey: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type SweepAction = { id: string; keptId: string; reason: SweepReason };

const norm = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  return text === "" ? null : text;
};

const idOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * What a proposal is about, within its kind, so a newer one can supersede it.
 * Null when the kind is matched only by dedupeKey (`bot_permission`).
 */
export function sweepSubject(kind: string, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case "task_create":
    case "decision_record":
    case "memory_note":
    case "draft":
      return norm(payload.title);
    case "task_change":
    case "task_archive":
      return idOf(payload.taskId);
    case "deal_next_step":
      return idOf(payload.dealId);
    case "deal_create":
      return norm(payload.name);
    case "goal_create": {
      const quarter = norm(payload.quarter);
      const title = norm(payload.title);
      return quarter === null || title === null ? null : `${quarter}:${title}`;
    }
    case "goal_update":
      return idOf(payload.goalId);
    case "comment": {
      const subjectKind = norm(payload.subjectKind);
      const subjectId = idOf(payload.subjectId);
      return subjectKind === null || subjectId === null ? null : `${subjectKind}:${subjectId}`;
    }
    case "handoff_reassign":
      return idOf(payload.handoffId);
    default:
      return null;
  }
}

const newerFirst = (a: SweepRow, b: SweepRow) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Which open proposals to withdraw, newest of each group kept. Duplicates
 * (same dedupeKey) first, then superseded (same company, kind and subject).
 * At most `cap`; `more` when some were left for a later pass.
 */
export function planSweep(rows: readonly SweepRow[], cap = SWEEP_LIMIT): { actions: SweepAction[]; more: boolean } {
  const open = [...rows].sort(newerFirst);
  const doomed = new Set<string>();
  const actions: SweepAction[] = [];
  let more = false;
  const push = (action: SweepAction) => {
    if (actions.length >= cap) {
      more = true;
      return;
    }
    actions.push(action);
    doomed.add(action.id);
  };

  const byKey = new Map<string, SweepRow[]>();
  for (const row of open) {
    const list = byKey.get(row.dedupeKey) ?? [];
    list.push(row);
    byKey.set(row.dedupeKey, list);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;
    for (const row of rest) push({ id: row.id, keptId: keep!.id, reason: "duplicate" });
  }

  const bySubject = new Map<string, SweepRow[]>();
  for (const row of open) {
    if (doomed.has(row.id)) continue;
    const subject = sweepSubject(row.kind, row.payload);
    if (subject === null) continue;
    const key = `${row.company}\0${row.kind}\0${subject}`;
    const list = bySubject.get(key) ?? [];
    list.push(row);
    bySubject.set(key, list);
  }
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;
    for (const row of rest) {
      if (doomed.has(row.id)) continue;
      push({ id: row.id, keptId: keep!.id, reason: "superseded" });
    }
  }
  return { actions, more };
}

/** The chief of staff, on the Mac or as the external bot, sweeps every proposer's open proposals. */
export const sweepSeesAll = (who: { bot?: string | undefined; agent?: string | undefined }): boolean =>
  who.bot === "chief_of_staff" || (who.bot === undefined && who.agent === "chief_of_staff");

export type Sweeper = { bot?: string | undefined; agent?: AgentId | undefined };

const sweeperOf = (who: Sweeper) => (who.bot !== undefined ? `bot:${who.bot}` : who.agent!);

/**
 * Withdraw the older duplicates and superseded proposals this caller may
 * clear, and log each with its reason. Returns ids and reasons, no titles.
 */
export async function sweepProposals(
  ctx: MutationCtx,
  who: Sweeper,
  now: number,
  company?: CompanyId,
): Promise<{ swept: number; more: boolean; results: { id: string; keptId: string; reason: SweepReason }[] }> {
  if (who.bot === undefined && who.agent === undefined) throw new ConvexError(SWEEP_WORDS.who);
  const open = await ctx.db
    .query("proposals")
    .withIndex("by_status_and_createdAt", (q) => q.eq("status", "open"))
    .take(SWEEP_CANDIDATES);
  const seesAll = sweepSeesAll(who);
  const mine = open.filter((row) => {
    if (company !== undefined && row.company !== company) return false;
    return seesAll || filedBy(row, who);
  });
  const plan = planSweep(
    mine.map((row) => ({
      id: row._id,
      company: row.company,
      kind: row.kind,
      dedupeKey: row.dedupeKey,
      createdAt: row.createdAt,
      payload: row.payload as Record<string, unknown>,
    })),
  );
  const sweeper = sweeperOf(who);
  const results: { id: string; keptId: string; reason: SweepReason }[] = [];
  for (const action of plan.actions) {
    const id = ctx.db.normalizeId("proposals", action.id);
    const kept = ctx.db.normalizeId("proposals", action.keptId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.status !== "open" || kept === null) continue;
    await ctx.db.patch(row._id, {
      status: "withdrawn",
      decidedAt: now,
      withdrawnAt: now,
      withdrawReason: action.reason,
      withdrawNote: SWEEP_NOTES[action.reason],
      replacedBy: kept,
      withdrawnBy: sweeper,
    });
    await ctx.db.insert("proposalSweeps", {
      sweeper,
      proposalId: row._id,
      keptId: kept,
      reason: action.reason,
      at: now,
    });
    results.push({ id: row._id, keptId: kept, reason: action.reason });
  }
  return { swept: results.length, more: plan.more, results };
}
