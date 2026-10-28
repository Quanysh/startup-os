// Where each pull request stands in the flow, how long it has been there, and
// whether it is stuck. Pure: from the facts GitHub's list stores and "now",
// which is an argument. Nothing here is stored, and nothing reads a clock: a
// query cannot (its result is cached), so the page decides with `useNow()`.
//
// THE STAGES (first matching row wins):
//   merged, in the last 14 days                          → merged
//   merged longer ago                                    → none (not shown)
//   closed without merging, in the last 14 days          → closed
//   closed longer ago                                    → none
//   open and a draft                                     → draft
//   open, GitHub's review decision "changes requested"   → changes_requested
//   open, review decision "approved"                     → approved
//   open otherwise (no review yet, or a review asked)    → waiting_for_review
//
// AGE IN STAGE, from the best timestamp the facts hold, and which it was:
//   draft               last activity (`updatedAt`)
//   waiting_for_review  the last review, else when it was opened
//   changes_requested   the last review, else last activity
//   approved            last activity: the facts do not say when it was approved
//   merged / closed     when it was merged / closed, else last activity
//
// STUCK, with the reason in words (thresholds in convex/lib/limits.ts):
//   waiting_for_review  more than 3 days since it was opened or last reviewed
//   changes_requested   more than 3 days with no update
//   approved            more than 2 days with no update, still unmerged
//   draft               more than 7 days untouched
//   any open non-draft  its head commit's checks are failing: stuck at once
// "More than" is strict: exactly three days is not yet more than three.

import type { CompanyId } from "../company";
import {
  PR_APPROVED_STUCK_AFTER_DAYS,
  PR_CLOSED_SHOWN_DAYS,
  PR_DRAFT_STUCK_AFTER_DAYS,
  PR_STUCK_AFTER_DAYS,
} from "../limits";
import type { PullState, RepoMain, ReviewDecision } from "../sharedRecords";

/** A pull request as `workTools.pullRequests` returns it. Times are instants. */
export type PullRow = {
  /** "org/name" of its repository. */
  repoId: string;
  number: number;
  company: CompanyId;
  /** Text from GitHub: shown as text, never as markup and never as a link target. */
  title: string;
  /** GitHub's own address for it, checked by the server: the one link rendered. */
  url: string;
  authorLogin?: string;
  authorName?: string;
  draft: boolean;
  state: PullState;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  closedAt?: number;
  reviewDecision: ReviewDecision;
  lastReviewAt?: number;
  reviewersRequested: number;
  reviewers: string[];
  checks: RepoMain;
};
/** What `workTools.pullRequests` returns: the caller's companies' rows and when the list was read. */
export type PullList = { readAt: number | null; rows: PullRow[] };

export const STAGES = [
  "draft",
  "waiting_for_review",
  "changes_requested",
  "approved",
  "merged",
  "closed",
] as const;
export type Stage = (typeof STAGES)[number];

/** The columns of the flow, left to right. Closed without merging left it, and has none. */
export const FLOW_STAGES = STAGES.filter((stage) => stage !== "closed");
/** The stages an open pull request can be in. */
export const OPEN_STAGES = ["draft", "waiting_for_review", "changes_requested", "approved"] as const;

export const STAGE_LABELS: Record<Stage, string> = {
  draft: "Draft",
  waiting_for_review: "Waiting for review",
  changes_requested: "Changes requested",
  approved: "Approved",
  merged: "Merged",
  closed: "Closed",
};

export function isStage(value: unknown): value is Stage {
  return STAGES.includes(value as Stage);
}

const REPO_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The address a pull request's title links to, or null for no link. It is
 * rebuilt here from the repository and the number and must be exactly what
 * was stored: the server holds the stored one to the same rule, and this is
 * the page's own check, so nothing else can ever become an href. A title is
 * text and is never read as an address.
 */
export function linkOf(pull: Pick<PullRow, "repoId" | "number" | "url">): string | null {
  if (!REPO_ID.test(pull.repoId) || !Number.isInteger(pull.number) || pull.number < 1) return null;
  const own = `https://github.com/${pull.repoId}/pull/${pull.number}`;
  return pull.url === own ? own : null;
}

/** Which timestamp an age is counted from. */
export type Since = "opened" | "last_review" | "last_activity" | "merged" | "closed";

const SINCE_WORDS: Record<Since, string> = {
  opened: "since it was opened",
  last_review: "since the last review",
  last_activity: "since last activity",
  merged: "since it was merged",
  closed: "since it was closed",
};
/** How a basis reads beside an age: "4 days since last activity". */
export const sinceWords = (basis: Since) => SINCE_WORDS[basis];

export type StuckReason =
  | "no_review"
  | "changes_unanswered"
  | "approved_unmerged"
  | "draft_untouched"
  | "checks_failing";
export type Stuck = { reason: StuckReason; words: string };

export type Placed = {
  stage: Stage;
  /** The instant its time in the stage is counted from. */
  since: number;
  basis: Since;
  /** Never negative: a time ahead of this clock is no age yet. */
  ageMs: number;
  /** Why it is stuck, the wait before the checks; empty when it is not. */
  stuck: Stuck[];
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An age as words: hours under a day, then whole days. */
export function ageWords(ms: number): string {
  if (ms < HOUR_MS) return "under an hour";
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.floor(ms / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The middle of some ages; null with none, which is not a zero. */
export function medianAge(ages: readonly number[]): number | null {
  if (ages.length === 0) return null;
  const sorted = [...ages].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const longerThan = (ms: number, days: number) => ms > days * DAY_MS;
const wholeDays = (ms: number) => {
  const days = Math.floor(ms / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
};

/**
 * The stage a pull request is in at `now`, since when, and why it is stuck.
 * Null for one that left the flow more than 14 days ago: it is in no stage
 * and is not shown.
 */
export function placeOf(pull: PullRow, now: number): Placed | null {
  const placed = (stage: Stage, since: number, basis: Since, stuck: Stuck[] = []): Placed => ({
    stage,
    since,
    basis,
    ageMs: Math.max(0, now - since),
    stuck,
  });
  const shown = (since: number) => now - since <= PR_CLOSED_SHOWN_DAYS * DAY_MS;

  if (pull.state === "merged") {
    const at = pull.mergedAt ?? pull.closedAt;
    if (at === undefined) {
      return shown(pull.updatedAt) ? placed("merged", pull.updatedAt, "last_activity") : null;
    }
    return shown(at) ? placed("merged", at, "merged") : null;
  }
  if (pull.state === "closed") {
    if (pull.closedAt === undefined) {
      return shown(pull.updatedAt) ? placed("closed", pull.updatedAt, "last_activity") : null;
    }
    return shown(pull.closedAt) ? placed("closed", pull.closedAt, "closed") : null;
  }

  const idle = now - pull.updatedAt;
  if (pull.draft) {
    // A draft's failing checks are its author's work in progress.
    return placed(
      "draft",
      pull.updatedAt,
      "last_activity",
      longerThan(idle, PR_DRAFT_STUCK_AFTER_DAYS)
        ? [{ reason: "draft_untouched", words: `Draft untouched for ${wholeDays(idle)}` }]
        : [],
    );
  }

  const stuck: Stuck[] = [];
  const failing: Stuck[] =
    pull.checks === "failing" ? [{ reason: "checks_failing", words: "Checks are failing" }] : [];

  if (pull.reviewDecision === "changes_requested") {
    if (longerThan(idle, PR_STUCK_AFTER_DAYS)) {
      stuck.push({
        reason: "changes_unanswered",
        words: `Changes requested, and no update for ${wholeDays(idle)}`,
      });
    }
    return pull.lastReviewAt === undefined
      ? placed("changes_requested", pull.updatedAt, "last_activity", [...stuck, ...failing])
      : placed("changes_requested", pull.lastReviewAt, "last_review", [...stuck, ...failing]);
  }

  if (pull.reviewDecision === "approved") {
    if (longerThan(idle, PR_APPROVED_STUCK_AFTER_DAYS)) {
      stuck.push({
        reason: "approved_unmerged",
        words: `Approved, and not merged for ${wholeDays(idle)} since last activity`,
      });
    }
    return placed("approved", pull.updatedAt, "last_activity", [...stuck, ...failing]);
  }

  // No review yet, or one asked for: waiting since it was opened or last reviewed.
  const reviewed = pull.lastReviewAt !== undefined && pull.lastReviewAt >= pull.createdAt;
  const since = reviewed ? pull.lastReviewAt! : pull.createdAt;
  const waited = now - since;
  if (longerThan(waited, PR_STUCK_AFTER_DAYS)) {
    stuck.push({
      reason: "no_review",
      words: reviewed
        ? `No review for ${wholeDays(waited)} since the last one`
        : `Waiting ${wholeDays(waited)} for a first review`,
    });
  }
  return placed("waiting_for_review", since, reviewed ? "last_review" : "opened", [
    ...stuck,
    ...failing,
  ]);
}

/** What `workTools.pullRequests` returns, or null where it was not asked for. */
export type PullListIn = { readAt: number | null; rows: readonly PullRow[] } | null;

/**
 * How many of one company's pull requests are stuck at `now`, by the five
 * rules above: the one count the Engineering page, the Dashboard, Today, the
 * attention list and the owner's agent all give. Null where the list was not
 * asked for or never read, which is not a zero.
 */
export function stuckCount(list: PullListIn, company: CompanyId, now: number): number | null {
  if (list === null || list.readAt === null) return null;
  return list.rows.filter((pull) => {
    if (pull.company !== company) return false;
    const placed = placeOf(pull, now);
    return placed !== null && placed.stuck.length > 0;
  }).length;
}
