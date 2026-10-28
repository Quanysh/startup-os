// Deals created in the last four complete weeks, for the go-to-market page.
// A count of deals, not a sum of money: the two markets' amounts are in
// different currencies, and a mirrored deal need not carry one.
//
// `deals.createdSince` counts from a moment to now, so the four weeks that
// have ended are two answers apart: what was created since they began, less
// what was created since the week in progress began. Nothing here reads a
// clock; the page passes its own.

import { WEEK_MS, msOfDay } from "@convex/lib/weeks";
import { periodStart } from "@convex/lib/periods";

export const DEALS_CREATED_WEEKS = 4;

/** What `deals.createdSince` answers. */
export type DealCounts = {
  us: { native: number; mirrored: number };
  kz: { native: number; mirrored: number };
};

export type DealsCreated = { total: number; us: number; kz: number; kzMirrored: number };

/**
 * The window, as the two moments to ask `createdSince` for: Monday to Monday
 * in UTC. Both move only when a week ends, so the queries' arguments hold
 * still between ticks of the clock.
 */
export function dealsCreatedWindow(now: number): { from: number; to: number } {
  const to = msOfDay(periodStart("week", now));
  return { from: to - DEALS_CREATED_WEEKS * WEEK_MS, to };
}

/**
 * `sinceFrom` less `sinceTo`. The two are separate reads, and a deal archived
 * between them can leave the later one higher: a count is never below zero.
 */
export function dealsCreated(sinceFrom: DealCounts, sinceTo: DealCounts): DealsCreated {
  const less = (a: number, b: number) => Math.max(0, a - b);
  const usNative = less(sinceFrom.us.native, sinceTo.us.native);
  const usMirrored = less(sinceFrom.us.mirrored, sinceTo.us.mirrored);
  const kzNative = less(sinceFrom.kz.native, sinceTo.kz.native);
  const kzMirrored = less(sinceFrom.kz.mirrored, sinceTo.kz.mirrored);
  const us = usNative + usMirrored;
  const kz = kzNative + kzMirrored;
  return { total: us + kz, us, kz, kzMirrored };
}

export function dealsCreatedSentence({ total, us, kz }: DealsCreated): string {
  if (total === 0) return "No deals created in the last four weeks.";
  const noun = total === 1 ? "deal" : "deals";
  return `${total} ${noun} created in the last four weeks: ${us} US, ${kz} Kazakhstan.`;
}
