// Outcomes (Bot Loop v3, section G): what came of a play a bot ran on a deal,
// a customer, an investor or a partner. A bot logs one with `outcome_log`
// (convex/lib/mcpTools.ts, written through convex/outcomes.ts) and reads them
// back with a win rate per play (`outcomes`); the owner sees them on the
// deal, customer and partner views and per bot on Agents › Bots.
//
// Pure: the UI imports it. Every refusal is fixed words: none quotes what
// was sent. Evidence is plain text a model wrote: no email address or phone
// number (refused, never cut), stored cleaned, shown as text.

/** What an outcome is about: a row of one of these, of the outcome's company. */
export const OUTCOME_SUBJECT_KINDS = ["deal", "customer", "investor", "partner"] as const;
export type OutcomeSubjectKind = (typeof OUTCOME_SUBJECT_KINDS)[number];

/**
 * The area each subject's own rows are read on: an outcome is read only by
 * whoever also reads what it is about (the security review of 2026-10-19),
 * not on the `outcomes` area alone.
 */
export const OUTCOME_SUBJECT_AREAS = {
  deal: "sales",
  customer: "customers",
  investor: "fundraising",
  partner: "partnerships",
} as const satisfies Record<OutcomeSubjectKind, string>;

export const OUTCOME_CHANNELS = ["email", "linkedin", "call", "telegram", "other"] as const;
export type OutcomeChannel = (typeof OUTCOME_CHANNELS)[number];

export const OUTCOME_RESULTS = ["worked", "failed", "pending"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const OUTCOME_SIGNALS = [
  "reply",
  "meeting",
  "stage_moved",
  "paid",
  "renewed",
  "churned",
  "no_reply",
  "bounced",
  "contact_left",
  "other",
] as const;
export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];

export const MAX_PLAY_LENGTH = 80;
export const MAX_EVIDENCE_LENGTH = 500;
/** Rows the `outcomes` read and a subject's timeline return at most, newest first. */
export const OUTCOME_ROWS = 300;
/** The window of the Bots tab's "Plays" table. */
export const PLAYS_WINDOW_DAYS = 30;

/**
 * The bots whose suggested profile writes outcomes (the rest read them):
 * the ones that run plays on deals, customers, investors and partners.
 */
export const OUTCOME_WRITERS = [
  "growth",
  "globex_ai_sales",
  "customer_success",
  "fundraising",
  "partnerships",
  "linkedin",
] as const;

export const OUTCOME_WORDS = {
  contact: "Leave email addresses and phone numbers out of an outcome: say what happened, and name people by name and role.",
  subject: "That subject does not exist for this company: give the id a read tool returned (deals, customers, investors or partners).",
  needs: "A new outcome needs subject, play, result, evidence and actedOn.",
  gone: "That outcome no longer exists.",
  notYours: "That outcome was logged by another bot. Log your own.",
  notPending: "Only a pending outcome can be updated. Log a new one instead.",
  otherCompany: "That outcome is the other company's.",
  empty: "That needs some text.",
  tooLong: "Some of that text is too long.",
  notADate: 'A day is written "YYYY-MM-DD".',
  proposalGone: "That proposal does not exist.",
  whoLogs: "Only a bot logs an outcome: call as the bot you are (`agent: <bot id>`).",
} as const;

export const RESULT_LABELS: Record<OutcomeResult, string> = {
  worked: "Worked",
  failed: "Failed",
  pending: "Pending",
};

export type PlayTally = { play: string; worked: number; failed: number; pending: number; winRate: number | null };

/**
 * Each play's tally: worked, failed and pending, and its win rate (worked of
 * worked and failed: a pending one is nobody's result yet; null with neither).
 * Most results first, then by name.
 */
export function playsOf(rows: readonly { play: string; result: OutcomeResult }[]): PlayTally[] {
  const by = new Map<string, PlayTally>();
  for (const row of rows) {
    const tally = by.get(row.play) ?? { play: row.play, worked: 0, failed: 0, pending: 0, winRate: null };
    tally[row.result] += 1;
    by.set(row.play, tally);
  }
  return [...by.values()]
    .map((tally) => {
      const decided = tally.worked + tally.failed;
      return { ...tally, winRate: decided === 0 ? null : tally.worked / decided };
    })
    .sort((a, b) => b.worked + b.failed + b.pending - (a.worked + a.failed + a.pending) || (a.play < b.play ? -1 : 1));
}

/** A win rate as the page says it: "67%", or "–" with nothing decided. */
export const winRateText = (rate: number | null): string => (rate === null ? "–" : `${Math.round(rate * 100)}%`);

const HOUR = 60 * 60 * 1000;
/** The start of the Bots tab's window, from the page's clock: to the hour, so it does not change every second. */
export const playsSince = (now: number) => now - (now % HOUR) - PLAYS_WINDOW_DAYS * 24 * HOUR;
