// Limits shared by Convex functions and the UI. They live here, in a plain
// module, because the browser must never import a file that defines Convex
// functions.

/** A week has a few priorities. More than this is a to-do list. */
export const MAX_PRIORITIES = 7;

// Engineering signals (GitHub). The script that counts and the page that
// explains the counts quote these, so neither restates a number.
/** An open pull request has waited too long after this many full days without a review. */
export const PR_STUCK_AFTER_DAYS = 3;
/** A repository with no push for this many days is not tracked. */
export const REPO_ACTIVE_DAYS = 90;

// The Engineering page's flow (src/lib/engineering/flow.ts). The thresholds
// past which an open pull request is "stuck", each in full days, kept here so
// the function that decides and the page that explains quote one number.
// Waiting for a review, and changes requested with no update, share
// PR_STUCK_AFTER_DAYS above.
/** Approved and still not merged after this many full days. */
export const PR_APPROVED_STUCK_AFTER_DAYS = 2;
/** A draft nobody has touched for this many full days. */
export const PR_DRAFT_STUCK_AFTER_DAYS = 7;
/** A merged or closed pull request is listed, and shown, for this many days. */
export const PR_CLOSED_SHOWN_DAYS = 14;
/** The most pull requests one push, and so the stored list, may hold. */
export const MAX_PULL_REQUESTS = 600;
/** The most requested reviewers named on one pull request. More are only counted. */
export const MAX_PR_REVIEWERS = 5;
/** A pull request's title as stored. GitHub's own limit is shorter. */
export const MAX_PR_TITLE_LENGTH = 300;

/**
 * Longest failure message kept for a run. Messages can echo text the sender
 * chose (a rejected field's name, say), and every scorecard subscription
 * carries the latest one.
 */
export const MAX_RUN_MESSAGE_LENGTH = 300;

/**
 * A caller-supplied page size made safe: a whole number between 1 and `max`,
 * or `fallback` when it is missing or not a number at all.
 */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

/** How far back a connector's backfill reaches: a year, plus the month in progress. */
export const BACKFILL_MONTHS = 13;

/** Finished tasks shown on the board. Older ones stay stored, out of view. */
export const DONE_LIMIT = 30;

// Length caps on free text. Nobody types this much by hand; the caps turn a
// runaway paste into a readable message instead of a storage error.
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 5_000;
export const MAX_REVIEW_TEXT_LENGTH = 5_000;
export const MAX_PRIORITY_LENGTH = 300;

// Notifications (convex/lib/notify.ts, convex/notifications.ts).
/** The most one person keeps; the oldest go as a new one is written. */
export const MAX_NOTIFICATIONS = 200;
/** A notification is deleted this many days after it was written. */
export const NOTIFICATION_RETENTION_DAYS = 60;
/** Notifications sent to the panel at a time. */
export const NOTIFICATION_PAGE = 20;
/** The unread count stops here. The bell says "9+" long before. */
export const UNREAD_COUNT_CAP = 100;
/** People one save of a task can mention. */
export const MAX_MENTIONS = 10;

// Pipelines (deals and investors).
/** A company, firm or person's name. */
export const MAX_NAME_LENGTH = 120;
export const MAX_NEXT_STEP_LENGTH = 300;
/** A stage name as another system writes it. */
export const MAX_STAGE_LABEL_LENGTH = 64;
export const MAX_EXTERNAL_ID_LENGTH = 100;
/**
 * Rows in one push of contacts (`contacts`, convex/lib/contactPush.ts): as
 * many as one company's book holds. The body's own cap (256 KB) still applies,
 * so a long list goes in several envelopes; contacts are only ever upserted,
 * so splitting one is safe.
 */
export const MAX_CONTACT_PUSH_ROWS = 2_000;
/** Above this an amount is a typo or the wrong unit, in dollars or in tenge. */
export const MAX_PIPELINE_AMOUNT = 100_000_000_000;
/** Closed cards shown per column on a pipeline board. Older ones still count. */
export const CLOSED_SHOWN = 30;
// A deal's details (convex/lib/dealDetails.ts): native deals only.
/** A region: a US state code, or a few words. */
export const MAX_REGION_LENGTH = 40;
/** Research titles one deal names. */
export const MAX_DEAL_SOURCES = 12;
export const MAX_DEAL_SOURCE_LENGTH = 120;
/** Physicians or locations in one practice. Above this is a typo. */
export const MAX_PRACTICE_COUNT = 100_000;
/** Rows one `deals.importProspects` call takes. */
export const MAX_IMPORT_ROWS = 250;
/** Deals one bulk action on the sales table touches. */
export const MAX_DEALS_SELECTED = 100;

// ── Customers and compliance ────────────────────────────────────────────────

/** Clinics in one register push. Far above the real list; a cap, not a target. */
export const MAX_CUSTOMERS = 500;
export const MAX_CLINIC_NAME_LENGTH = 200;
export const MAX_URL_LENGTH = 2_000;

/**
 * How much of the live list one push may archive without saying `allowShrink`:
 * a quarter, or two clinics while the list is shorter than SHRINK_SMALL_LIST.
 * A sheet cut short (a blank row in the middle) must not empty the list.
 */
export const SHRINK_MAX_FRACTION = 4;
export const SHRINK_SMALL_LIST = 8;
export const SHRINK_SMALL_LIST_MAX = 2;

/**
 * Days without a successful push before the register is said to be out of
 * date. Short, because health is counted to the push day: past this, a
 * clinic's verdict describes a day that is no longer recent.
 */
export const REGISTER_STALE_DAYS = 14;

/** A confirmed date this close, today included, is "due soon". */
export const DUE_SOON_DAYS = 30;

// ── Investor update ─────────────────────────────────────────────────────────

/** An edited investor update. A long one is a few thousand characters. */
export const MAX_INVESTOR_UPDATE_LENGTH = 20_000;

// ── Payroll ─────────────────────────────────────────────────────────────────

/** People on one company's payroll, ended and archived ones included. */
export const MAX_PAYROLL_PEOPLE = 200;
/** Tax and contribution lines per company, both kinds together. */
export const MAX_PAYROLL_LINES = 30;
/**
 * The most a salary, an allowance, a cap or an adjustment can be, in minor
 * units: a billion dollars or tenge a month. Above it the figure is a typo.
 */
export const MAX_PAYROLL_AMOUNT = 100_000_000_000;
export const MAX_LINE_NAME_LENGTH = 80;
/** A note on a person, or beside a month's adjustment. One line. */
export const MAX_PAYROLL_NOTE_LENGTH = 300;
/**
 * People × lines one saved month can hold. A month is one document of frozen
 * rows, and a document has a size limit; this keeps a month well under it.
 */
export const MAX_RUN_CELLS = 2_000;
/** Saved months listed in the history, newest first. */
export const MAX_RUNS_LISTED = 60;

// ── Costs ───────────────────────────────────────────────────────────────────

/** Active cost lines per company. Archived ones are not counted. */
export const MAX_COST_LINES = 300;
/** A vendor or a thing: "AWS", "Office rent". */
export const MAX_COST_NAME_LENGTH = 80;
/** A short word on how it is paid: "Mercury card". */
export const MAX_COST_PAID_BY_LENGTH = 60;
export const MAX_COST_NOTE_LENGTH = 300;
/** The most a line can be, in minor units: a billion dollars or tenge. */
export const MAX_COST_AMOUNT = 100_000_000_000;
