// One proposer's week on /approvals, as the Bots tab says it (bots.weeklyStats).
// Pure: the figures come from the server; this only words them.

import { REJECT_CODE_LABELS, type RejectCode } from "@convex/lib/agents";

export type WeekStat = {
  decided: number;
  approved: number;
  rejected: number;
  expired: number;
  /** Withdrawn by the proposer itself (spec §14): not decided, in no rate. */
  withdrawn?: number;
  approvalRate: number | null;
  medianDecisionMs: number | null;
  topRejectReasons: { code: RejectCode | "typed"; count: number }[];
};

const HOUR = 60 * 60 * 1000;

/** A wait, short: under an hour in minutes, under two days in hours, else in days. */
export function waitLabel(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / (24 * HOUR))} days`;
}

export const reasonLabel = (code: RejectCode | "typed") => (code === "typed" ? "Typed reason" : REJECT_CODE_LABELS[code]);

/** "This week: 4 decided · 25% approved · 2 h median to decide · Wrong data (2), Typed reason (1)". */
export function weekLine(stat: WeekStat | undefined): string {
  const withdrawn = stat === undefined || (stat.withdrawn ?? 0) === 0 ? null : `${stat.withdrawn} withdrawn by the proposer`;
  if (stat === undefined || stat.decided === 0) {
    return withdrawn === null ? "This week: nothing decided." : `This week: nothing decided · ${withdrawn}.`;
  }
  const parts = [`${stat.decided} decided`];
  parts.push(stat.approvalRate === null ? "none approved or rejected" : `${Math.round(stat.approvalRate * 100)}% approved`);
  if (stat.expired > 0) parts.push(`${stat.expired} expired`);
  if (withdrawn !== null) parts.push(withdrawn);
  if (stat.medianDecisionMs !== null) parts.push(`${waitLabel(stat.medianDecisionMs)} median to decide`);
  if (stat.topRejectReasons.length > 0) {
    parts.push(`top reasons: ${stat.topRejectReasons.map((r) => `${reasonLabel(r.code)} (${r.count})`).join(", ")}`);
  }
  return `This week: ${parts.join(" · ")}.`;
}

/** The start of the week the stats read: a week before `now`, to the hour, so the query is not asked anew every tick. */
export const weekSince = (now: number) => now - (now % HOUR) - 7 * 24 * HOUR;
