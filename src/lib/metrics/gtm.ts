// The go-to-market numbers nobody stores: reply rate and a week's own
// outbound figure. Worked out at read time.
//
// Apollo's snapshots are totals to date, one bucket per week, each holding the
// totals as last read in that week. So a rate is taken from the newest
// bucket, and a week's own figure is the difference between two consecutive
// buckets. Nothing here reads a clock.

import { previousPeriodStart } from "@convex/lib/periods";
import type { Area } from "@convex/lib/roles";
import type { Point } from "./derive";

/**
 * Whether a viewer is sent visitor to signup: Inbound is the marketing area's,
 * but its two figures (`web_visitors`, `signups`) are declared with the
 * product's, so without Product they are never sent and a tile would say the
 * figure had not arrived. The one rule /gtm's Inbound and Today's Go to
 * market block both keep.
 */
export const readsVisitorSignup = (can: (area: Area) => boolean): boolean => can("marketing") && can("product");

/** A benchmark verdict on a reply rate needs at least this many emails behind it. */
export const MIN_DELIVERED_FOR_VERDICT = 100;

const newest = (points: readonly Point[]): Point | null =>
  [...points].sort((a, b) => a.periodStart.localeCompare(b.periodStart)).at(-1) ?? null;

export type ReplyRate =
  | { kind: "value"; percent: number; delivered: number; replied: number; week: string }
  | { kind: "none"; reason: "no_data" | "nothing_delivered" | "inconsistent" };

/** Replies as a share of emails delivered, over every sequence to date. */
export function replyRate(delivered: readonly Point[], replied: readonly Point[]): ReplyRate {
  const sent = newest(delivered);
  const answered = sent && replied.find((point) => point.periodStart === sent.periodStart);
  if (!sent || !answered) return { kind: "none", reason: "no_data" };
  if (sent.value <= 0) return { kind: "none", reason: "nothing_delivered" };
  if (answered.value > sent.value) return { kind: "none", reason: "inconsistent" };
  return {
    kind: "value",
    percent: (answered.value * 100) / sent.value,
    delivered: sent.value,
    replied: answered.value,
    week: sent.periodStart,
  };
}

export type WeekDelta =
  | { kind: "value"; value: number }
  | { kind: "none"; reason: "no_data" | "no_previous" | "total_fell" };

/**
 * How much a total to date grew in `week`: that week's bucket less the one
 * immediately before it. Both must exist, because a gap is not a zero. A total
 * that fell (a sequence was deleted) has no weekly figure.
 */
export function weekDelta(totals: readonly Point[], week: string): WeekDelta {
  if (totals.length === 0) return { kind: "none", reason: "no_data" };
  const of = (start: string) => totals.find((point) => point.periodStart === start);
  const now = of(week);
  const before = of(previousPeriodStart("week", week));
  if (!now || !before) return { kind: "none", reason: "no_previous" };
  if (now.value < before.value) return { kind: "none", reason: "total_fell" };
  return { kind: "value", value: now.value - before.value };
}
