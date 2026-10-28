// What the Support page, Today's "Needs you" and the owner's agent say about
// Globex's inbox, worked out from the stored rows (./support.ts) at read
// time. Pure, and no clock: every function takes `now` from its caller (the
// page's `useNow`, the agent tool's `clock.now`), since a query never reads
// one.
//
// A figure that cannot be known is null and is said so, never 0: a median of
// no replies, a rate of no chats, Fin's resolved share with no chat Fin
// answered. A count over rows that were read is a count, and 0 is a real 0.

import { weekIndex, weekStartOfIndex } from "./weeks";
import type { FinOutcome, SupportRow } from "./support";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A customer waiting on a person longer than this, at the time of Intercom's
 * last push, is a row of Today's "Needs you".
 */
export const NEEDS_YOU_AFTER_MS = 4 * HOUR;
/** The window the reply times, Fin's outcomes and the help articles are counted over. */
export const SUPPORT_WINDOW_DAYS = 30;
/** Weeks of chats on the chart, the week in progress the last. */
export const SUPPORT_WEEKS = 8;
/** Help articles listed. */
export const TOP_ARTICLES = 5;
/** A chat open longer than this is an inbox-hygiene count. */
export const OPEN_TOO_LONG_DAYS = 30;

/** What the figures read of a row: everything but the counts and the rating. */
export type SupportRowView = Pick<
  SupportRow,
  | "intercomId"
  | "createdAt"
  | "updatedAt"
  | "state"
  | "open"
  | "waitingSince"
  | "origin"
  | "pageArea"
  | "finParticipated"
  | "finOutcome"
  | "humanRepliedAt"
  | "timeToHumanReply"
  | "lastCustomerReplyAt"
  | "lastHumanReplyAt"
  | "assigneeId"
  | "assigneeName"
  | "articles"
>;

/** Fin's part in a chat, in the page's terms: Intercom's two resolutions are one "resolved". */
export const FIN_RESULTS = ["resolved", "escalated", "negative_feedback", "no_fin", "pending"] as const;
export type FinResult = (typeof FIN_RESULTS)[number];

export const FIN_RESULT_WORDS: Record<FinResult, string> = {
  resolved: "Resolved by Fin",
  escalated: "Handed to a person",
  negative_feedback: "Unhappy with Fin",
  no_fin: "Fin did not answer",
  pending: "No outcome yet",
};

const RESULT_OF: Record<FinOutcome, FinResult> = {
  assumed_resolution: "resolved",
  confirmed_resolution: "resolved",
  escalated: "escalated",
  negative_feedback: "negative_feedback",
};

export function finOf(row: Pick<SupportRowView, "finParticipated" | "finOutcome">): FinResult {
  if (!row.finParticipated) return "no_fin";
  return row.finOutcome === null ? "pending" : RESULT_OF[row.finOutcome];
}

/**
 * Whether a person owes a customer an answer now. State table, every row
 * needed:
 *   a customer's chat (began on Globex's product)
 *   open, and not snoozed
 *   Fin handed it on, the customer was unhappy with Fin, or Fin never answered
 *   no person has answered since the customer last wrote
 */
export function isWaitingOnPerson(row: SupportRowView): boolean {
  if (row.origin !== "customer" || row.state !== "open") return false;
  const fin = finOf(row);
  if (fin !== "escalated" && fin !== "negative_feedback" && fin !== "no_fin") return false;
  if (row.lastHumanReplyAt === null) return true;
  return row.lastCustomerReplyAt !== null && row.lastHumanReplyAt < row.lastCustomerReplyAt;
}

export type Wait = {
  intercomId: string;
  /** When the wait began: Intercom's `waiting_since`, else the customer's last message, else the chat's start. */
  since: number;
  waitedMs: number;
  pageArea: string | null;
  fin: FinResult;
  /** The teammate it is assigned to, by Intercom's id; null for nobody. */
  assigneeId: string | null;
  /** Their name where the push carried one: the connector has no list of teammates. */
  assigneeName: string | null;
  lastCustomerReplyAt: number | null;
};

/**
 * Every chat waiting on a person, the longest wait first, its wait counted to
 * `asOf`: the time of Intercom's last push. What happened since is not known
 * (the push is daily), so a wait is never counted to the browser's clock.
 */
export function waitsOf(rows: readonly SupportRowView[], asOf: number): Wait[] {
  return rows
    .filter(isWaitingOnPerson)
    .map((row): Wait => {
      const since = row.waitingSince ?? row.lastCustomerReplyAt ?? row.createdAt;
      return {
        intercomId: row.intercomId,
        since,
        waitedMs: Math.max(0, asOf - since),
        pageArea: row.pageArea,
        fin: finOf(row),
        assigneeId: row.assigneeId,
        assigneeName: row.assigneeName,
        lastCustomerReplyAt: row.lastCustomerReplyAt,
      };
    })
    .sort((a, b) => a.since - b.since || a.intercomId.localeCompare(b.intercomId));
}

/** The waits Today's "Needs you" lists: longer than `NEEDS_YOU_AFTER_MS` at the last push. */
export function needsYou(rows: readonly SupportRowView[], asOf: number): Wait[] {
  return waitsOf(rows, asOf).filter((wait) => wait.waitedMs > NEEDS_YOU_AFTER_MS);
}

/** The nearest-rank percentile of `values` (0 < p ≤ 1); null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

export type WeekCount = {
  /** The Monday the week starts on, UTC. */
  weekStart: string;
  customer: number;
  test: number;
  other: number;
  unknown: number;
  /** The week has not ended. */
  inProgress: boolean;
};

export type SupportFigures = {
  /** Customers' open chats, snoozed ones included. */
  openCustomer: number;
  waiting: Wait[];
  /** Seconds to the first reply by a person, over the customer chats begun in the window that had one. */
  firstReply: { median: number | null; p90: number | null; replied: number; chats: number };
  fin: {
    /** Customer chats begun in the window. */
    chats: number;
    /** Of those, the ones Fin answered. */
    finChats: number;
    counts: Record<FinResult, number>;
    /** Each count over `chats`; null with no chat. */
    rates: Record<FinResult, number | null>;
    /** Resolved over `finChats`; null when Fin answered none. */
    resolvedShare: number | null;
  };
  weeks: WeekCount[];
  articles: { title: string; chats: number }[];
  hygiene: { testOpen: number; openOver30Days: number };
};

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/**
 * Everything the page's blocks say, from the stored rows: windows and weeks
 * by the browser's clock (`now`), waits as of the last push (`asOf`).
 */
export function supportFigures(rows: readonly SupportRowView[], now: number, asOf: number = now): SupportFigures {
  const since = now - SUPPORT_WINDOW_DAYS * DAY;
  const customers = rows.filter((row) => row.origin === "customer");
  const recent = customers.filter((row) => row.createdAt >= since);

  const replies = recent.flatMap((row) => (row.timeToHumanReply === null ? [] : [row.timeToHumanReply]));

  const counts = Object.fromEntries(FIN_RESULTS.map((result) => [result, 0])) as Record<FinResult, number>;
  for (const row of recent) counts[finOf(row)] += 1;
  const finChats = recent.length - counts.no_fin;

  const current = weekIndex(now);
  const first = current - SUPPORT_WEEKS + 1;
  const weeks: WeekCount[] = Array.from({ length: SUPPORT_WEEKS }, (_, i) => ({
    weekStart: weekStartOfIndex(first + i),
    customer: 0,
    test: 0,
    other: 0,
    unknown: 0,
    inProgress: first + i === current,
  }));
  for (const row of rows) {
    const index = weekIndex(row.createdAt) - first;
    if (index >= 0 && index < SUPPORT_WEEKS) weeks[index]![row.origin] += 1;
  }

  const used = new Map<string, number>();
  for (const row of recent) for (const title of new Set(row.articles)) used.set(title, (used.get(title) ?? 0) + 1);
  const articles = [...used]
    .map(([title, chats]) => ({ title, chats }))
    .sort((a, b) => b.chats - a.chats || a.title.localeCompare(b.title))
    .slice(0, TOP_ARTICLES);

  return {
    openCustomer: customers.filter((row) => row.open).length,
    waiting: waitsOf(rows, asOf),
    firstReply: {
      median: percentile(replies, 0.5),
      p90: percentile(replies, 0.9),
      replied: replies.length,
      chats: recent.length,
    },
    fin: {
      chats: recent.length,
      finChats,
      counts,
      rates: Object.fromEntries(
        FIN_RESULTS.map((result) => [result, ratio(counts[result], recent.length)]),
      ) as Record<FinResult, number | null>,
      resolvedShare: ratio(counts.resolved, finChats),
    },
    weeks,
    articles,
    hygiene: {
      testOpen: rows.filter((row) => row.origin === "test" && row.open).length,
      openOver30Days: rows.filter((row) => row.open && now - row.createdAt > OPEN_TOO_LONG_DAYS * DAY).length,
    },
  };
}
