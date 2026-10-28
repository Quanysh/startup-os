// What the handoffs put on "Needs you": open handoffs nobody acted on within a
// day. One line with a count; the page names the bots and the titles. A
// handoff a bot made to the viewer (a person) is a line of its own, theirs to
// answer, and is not counted again in the first.

import { HANDOFF_STALE_MS, isUnaccepted, type HandoffStatus } from "../handoffs";
import type { AttentionItem } from "./scorecard";

export type HandoffStale = {
  status: HandoffStatus;
  openSince: number;
  /** Addressed to a person. */
  person?: boolean | undefined;
  /** Addressed to the viewer. */
  mine?: boolean | undefined;
};

export function handoffAttention(rows: readonly HandoffStale[] | undefined, now: number): AttentionItem[] {
  const stale = (rows ?? []).filter((row) => isUnaccepted(row, now));
  const yours = stale.filter((row) => row.mine === true).length;
  const n = stale.length - yours;
  const hours = Math.round(HANDOFF_STALE_MS / 3_600_000);
  const items: AttentionItem[] = [];
  if (n > 0) {
    items.push({
      id: "handoffs-unaccepted",
      severity: "stale",
      title: `${n} ${n === 1 ? "handoff has" : "handoffs have"} no taker`,
      detail: `Open for more than ${hours} hours and not accepted. Reassign it or close it.`,
      href: "/handoffs",
    });
  }
  if (yours > 0) {
    items.push({
      id: "handoffs-yours",
      severity: "stale",
      title: `${yours} ${yours === 1 ? "handoff to you waits" : "handoffs to you wait"} for an answer`,
      detail: `A bot handed it to you more than ${hours} hours ago. Accept it, decline it or mark it done.`,
      href: "/handoffs?status=open",
    });
  }
  return items;
}
