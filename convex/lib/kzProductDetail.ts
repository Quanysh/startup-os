// Globex's app in detail: the parts of the Kazakhstan product the Product
// page breaks its weekly figures into. One list each, shared by the metric
// registry (one key per part: a snapshot carries no dimension), the made-up
// seed and the page, so a part added here is added everywhere.
//
// Every figure is a weekly count from PostHog's app.globex.example.com project, with
// the team's own accounts and the test cohort left out. Nothing here names a
// clinic or a person: the clinics a module serves are on /customers.

import { COMPANIES } from "./company";

/** The app's modules, in the order the app's own menu shows them. */
export const KZ_MODULES = [
  { id: "intake", label: "Intake" },
  { id: "records", label: "Records" },
  { id: "visits", label: "Visits" },
  { id: "search", label: "Quick search" },
  { id: "inquiries", label: "Inquiries" },
  { id: "forms", label: "Forms" },
  { id: "capture", label: "Capture" },
  { id: "journal", label: "Journal" },
  { id: "lookup", label: "Lookup" },
  { id: "orders", label: "Orders" },
] as const;
export type KzModuleId = (typeof KZ_MODULES)[number]["id"];

/**
 * Per module, each week: actions started, doctors and clinics that started
 * one, failures, the slowest answers (95th percentile, whole seconds) and
 * what its AI calls cost (US dollars, as Globex's token bill is).
 */
export const MODULE_KINDS = [
  "actions",
  "doctors",
  "clinics",
  "failures",
  "p95",
  "ai_cost",
  // Speed & AI: the median answer, the share over a minute, requests the
  // backend sent twice because the model was slow, dollars a result, and the
  // largest requests (95th percentile of input tokens).
  "p50",
  "slow_share",
  "hedged_share",
  "cost_per_result",
  "tokens_p95",
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];
export const moduleKey = (kind: ModuleKind, module: KzModuleId) => `module_${kind}_${module}`;

/**
 * Why a failure happened, as a cause, never the error's own text (it can hold
 * a model's answer, and with it part of a medical record).
 */
export const KZ_FAILURE_CAUSES = [
  { id: "gemini_timeout", label: "The model timed out" },
  { id: "empty_answer", label: "The model answered nothing" },
  { id: "schema", label: "The answer was not in the expected shape" },
  { id: "file_type", label: "A file of a kind not handled" },
  { id: "pdf_instead", label: "A document in an unexpected format" },
  { id: "html_instead", label: "The server answered in the wrong format" },
  { id: "scan_unreadable", label: "A file could not be read" },
  { id: "required_fields", label: "A required field was empty" },
  { id: "network", label: "A network failure" },
  { id: "unauthorized", label: "Unauthorized" },
  { id: "upstream", label: "An upstream service failed" },
  { id: "no_text", label: "An error with no text" },
  { id: "other", label: "Another cause" },
] as const;
export const failureKey = (cause: (typeof KZ_FAILURE_CAUSES)[number]["id"]) => `failures_${cause}`;

/**
 * Doctors by what their week looked like against their own usual week (the
 * four weeks before). Each doctor is in one group; the groups are counts.
 */
export const KZ_DOCTOR_GROUPS = [
  { key: "doctors_daily", label: "Doctors working most days", better: "up", note: "an action on 4 or more days of the week" },
  { key: "doctors_new", label: "New doctors", better: "up", note: "a first week in the app" },
  { key: "doctors_more", label: "Doctors working more", better: "up", note: "twice their usual week or more" },
  { key: "doctors_less", label: "Doctors working less", better: "down", note: "half their usual week or less, or half of last week" },
  { key: "doctors_stopped", label: "Doctors who stopped", better: "down", note: "worked last week, nothing this week" },
  { key: "doctors_never_started", label: "Signed up, never started", better: "down", note: "signed up in the last 90 days, no action yet" },
] as const;

/** What happened when a doctor's trial ended, counted in the week it ended. */
export const KZ_TRIAL_OUTCOMES = [
  { key: "trials_ended", label: "Trials ended", better: "up", note: "every trial that ended this week" },
  { key: "trials_converted", label: "Trials that paid", better: "up", note: "a subscription after the trial ended" },
  { key: "trials_continuing", label: "Kept working, not paid", better: "up", note: "still active after the trial, no subscription" },
  { key: "trials_lost", label: "Left after the trial", better: "down", note: "no action since the trial ended" },
] as const;

/** Clinics whose week changed against their own usual week. */
export const KZ_CLINIC_CHANGES = [
  { key: "clinics_silent", label: "Clinics that went silent", better: "down", note: "worked before, no action this week" },
  { key: "clinics_declining", label: "Clinics below their usual week", better: "down", note: "under 70% of their usual week" },
  { key: "clinics_new", label: "Clinics new this week", better: "up", note: "a first action this week" },
] as const;

/**
 * The period's figures split by plan (what the doctor or clinic was on that
 * week), and the AI bill, as the weekly report's overview gives them.
 */
export const KZ_PLAN_SPLIT = [
  { key: "checks_trial", label: "Checks by doctors on a trial", better: "up", note: "checks started on a trial plan" },
  { key: "checks_paid", label: "Checks by paying doctors", better: "up", note: "checks started on a paid plan" },
  { key: "clinics_trial", label: "Clinics on a trial that ran a check", better: "up", note: "" },
  // Paying clinics are paying clients, as `clinics_active` is: Finance's figure.
  { key: "clinics_paid", label: "Paying clinics that ran a check", better: "up", note: "", finance: true },
] as const;

/** The headline counts beside the three the tab already had. */
export const KZ_HEADLINE = [
  { key: "doctors_working", label: "Doctors who used it", better: "up", note: "an action this week, not only a look-in" },
  { key: "checks_started", label: "Checks started", better: "up", note: "every check a doctor ran, finished or not" },
  { key: "actions", label: "Actions", better: "up", note: "checks, searches, inquiries, forms, scans and uploads" },
  { key: "failures_total", label: "Failures", better: "down", note: "every action that ended in an error" },
  { key: "error_record_text", label: "Errors carrying record text", better: "down", note: "error messages that hold a model's answer: must be zero" },
] as const;

/** Every key above, with its label and good direction, in the page's order. */
export type KzDetailFigure = {
  key: string;
  label: string;
  better: "up" | "down";
  /** A count unless said; AI cost is dollars. */
  unit?: "count" | "currency" | "percent";
  /** A count that may hold a fraction (events a doctor); whole otherwise. */
  fraction?: boolean;
  /**
   * Finance's figure, not Product's: sent only to Finance's holders. Money
   * (`unit: "currency"`) always is; a count of paying clients is too.
   */
  finance?: boolean;
};
const MODULE_FIGURES: Record<ModuleKind, { words: string; better: "up" | "down"; unit?: "currency" | "percent" }> = {
  actions: { words: "actions", better: "up" },
  doctors: { words: "doctors", better: "up" },
  clinics: { words: "clinics", better: "up" },
  failures: { words: "failures", better: "down" },
  p95: { words: "slowest answers (p95, seconds)", better: "down" },
  ai_cost: { words: "AI cost", better: "down", unit: "currency" },
  p50: { words: "median answer (p50, seconds)", better: "down" },
  slow_share: { words: "answers over 60 seconds", better: "down", unit: "percent" },
  hedged_share: { words: "requests sent twice (hedged)", better: "down", unit: "percent" },
  cost_per_result: { words: "AI cost a result", better: "down", unit: "currency" },
  tokens_p95: { words: "largest requests (p95 input tokens)", better: "down" },
};

/**
 * What a failure was, from the event's own fields (error type, stage, HTTP
 * status), never its text: the technical side, beside the causes above.
 */
export const KZ_ERROR_KINDS = [
  { id: "timeout", label: "Timeout" },
  { id: "http_5xx", label: "Server error (HTTP 5xx)" },
  { id: "network", label: "Network" },
  { id: "auth", label: "Signed out (auth)" },
  { id: "validation", label: "Validation" },
  { id: "schema", label: "Schema" },
  { id: "unknown", label: "Unknown" },
] as const;
export const errorKindKey = (kind: (typeof KZ_ERROR_KINDS)[number]["id"]) => `failures_kind_${kind}`;

/** The app as a whole: its model, its interface, its sign-ins, its uploads and its busiest hours. */
export const KZ_HEALTH: KzDetailFigure[] = [
  { key: "ai_calls", label: "AI calls", better: "up" },
  { key: "ai_calls_off_model", label: "AI calls by a model not on the list", better: "down" },
  { key: "inp_p75", label: "Interface response (INP p75, ms)", better: "down" },
  { key: "inp_poor_share", label: "Slow interface responses (INP over 500 ms)", better: "down", unit: "percent" },
  { key: "lcp_p75", label: "Page load (LCP p75, ms)", better: "down" },
  { key: "rage_clicks", label: "Rage clicks", better: "down" },
  { key: "rage_session_share", label: "Sessions with a rage click", better: "down", unit: "percent" },
  { key: "exceptions_web", label: "Errors in the browser", better: "down" },
  { key: "exceptions_server", label: "Errors on the server", better: "down" },
  { key: "stale_session_retries", label: "Expired sessions retried", better: "down" },
  { key: "auth_redirects", label: "Requests sent to sign-in", better: "down" },
  { key: "uploads", label: "Uploads", better: "up" },
  { key: "uploads_failed", label: "Failed uploads", better: "down" },
  { key: "failure_hours_busy", label: "Hours with 5 or more failures", better: "down" },
  { key: "failure_worst_hour", label: "Failures in the worst hour", better: "down" },
  { key: "trial_ended_per_doctor", label: "trial_ended events a doctor", better: "down", fraction: true },
];
export const KZ_DETAIL_FIGURES: readonly KzDetailFigure[] = [
  ...KZ_HEADLINE,
  ...KZ_PLAN_SPLIT,
  { key: "ai_cost_total", label: "AI cost", better: "down", unit: "currency" },
  { key: "new_doctors", label: "New doctors who signed up", better: "up" },
  { key: "new_doctors_started", label: "New doctors who started working", better: "up" },
  { key: "doctors_never_started_recent", label: "Never started, signed up in the last 3 weeks", better: "down" },
  ...KZ_MODULES.flatMap((m) =>
    MODULE_KINDS.map((kind): KzDetailFigure => ({
      key: moduleKey(kind, m.id),
      label: `${m.label}: ${MODULE_FIGURES[kind].words}`,
      better: MODULE_FIGURES[kind].better,
      ...(MODULE_FIGURES[kind].unit ? { unit: MODULE_FIGURES[kind].unit } : null),
    })),
  ),
  ...KZ_FAILURE_CAUSES.map((c): KzDetailFigure => ({ key: failureKey(c.id), label: `Failures: ${c.label.toLowerCase()}`, better: "down" })),
  ...KZ_ERROR_KINDS.map((k): KzDetailFigure => ({ key: errorKindKey(k.id), label: `Failures by type: ${k.label.toLowerCase()}`, better: "down" })),
  ...KZ_HEALTH,
  ...KZ_DOCTOR_GROUPS,
  ...KZ_TRIAL_OUTCOMES,
  ...KZ_CLINIC_CHANGES,
];

/**
 * A doctor's last week, by the weekly report's segments: the first that fits,
 * in this order. `usual` is their average over the four weeks before.
 * - new: their first week in the app, with an action
 * - stopped: nothing this week, though they worked before (usual ≥ 1 or last week)
 * - dormant: nothing this week, and usually under one action
 * - less: half their usual (from 3) or half of last week (from 10), or less
 * - more: twice their usual and 5 more, or over
 * - daily: an action on 4 or more days of the week
 * - usual: the rest, working in their own usual way
 */
export const DOCTOR_WEEKS = ["stopped", "less", "more", "new", "daily", "usual", "dormant"] as const;
export type DoctorWeek = (typeof DOCTOR_WEEKS)[number];
export const DOCTOR_WEEK_LABELS: Record<DoctorWeek, string> = {
  daily: "Every day",
  usual: "Regularly",
  new: "New",
  more: "More than usual",
  less: "Less than usual",
  stopped: "Stopped",
  dormant: "Rarely in",
};
export const DOCTOR_WEEK_NOTES: Record<DoctorWeek, string> = {
  daily: "worked 4 or more days of the 7",
  usual: "less often, but in their usual amount",
  new: `new to ${COMPANIES.kz.name} this week`,
  more: "twice their usual or more",
  less: "half their usual or of last week, or less",
  stopped: "no action this week, though they worked before",
  dormant: "no action this week, and usually under one",
};
/** Which segments read as working, changed and not working, as the report groups them. */
export const DOCTOR_WEEK_GROUPS: { title: string; weeks: readonly DoctorWeek[] }[] = [
  { title: "Working", weeks: ["daily", "usual", "new"] },
  { title: "Changed", weeks: ["more", "less"] },
  { title: "Not working", weeks: ["stopped", "dormant"] },
];

/** What happened after a doctor's trial ended, the first that fits. */
export const TRIAL_OUTCOMES = ["paid", "kept", "left", "never"] as const;
export type TrialOutcome = (typeof TRIAL_OUTCOMES)[number];
export const TRIAL_OUTCOME_LABELS: Record<TrialOutcome, string> = {
  paid: "Paid",
  kept: "Kept working",
  left: "Left",
  never: "Never used it",
};

/**
 * A doctor's segment for a week (`DOCTOR_WEEKS`, the first that fits). `firstWeek`
 * is true in their first week in the app; `lastWeek` is their actions the week
 * before, where known. Days are the days of the week with an action.
 */
export function doctorWeekOf(a: {
  actions: number;
  usual: number;
  days: number;
  firstWeek: boolean;
  lastWeek?: number | null;
}): DoctorWeek {
  const before = a.lastWeek ?? 0;
  if (a.firstWeek && a.actions > 0) return "new";
  if (a.actions === 0) return a.usual >= 1 || before > 0 ? "stopped" : "dormant";
  if ((a.usual >= 3 && a.actions <= 0.5 * a.usual) || (before >= 10 && a.actions <= 0.5 * before)) return "less";
  if (a.actions >= 2 * a.usual && a.actions - a.usual >= 5) return "more";
  if (a.days >= 4) return "daily";
  return "usual";
}

/** What came of a trial, the first that fits (`TRIAL_OUTCOMES`). */
export function trialOutcomeOf(a: { paid: boolean; lastActiveOn: string | null; endedOn: string; before: number; after: number }): TrialOutcome {
  if (a.paid) return "paid";
  // An action on the day it ended does not count as keeping on.
  if (a.lastActiveOn !== null && a.lastActiveOn > a.endedOn) return "kept";
  if (a.before > 0 || a.after > 0) return "left";
  return "never";
}
