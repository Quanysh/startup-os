// The HogQL Startup OS asks PostHog's app.globex.example.com project (Globex's app)
// each run. Pure: whole numbers computed here and the fixed lists below are
// the only things put in a query, so nothing a person typed can reach one.
//
// Every query aggregates inside PostHog and answers in rows of numbers, read
// by position (posthogGlobexParse.ts). Three columns are strings: a clinic's
// id (organization_id), a person's id, and, in `people` and `orgs` alone, a
// doctor's first and last name and a clinic's name. No email, phone, search
// text, file name or error text is ever selected: an error is read as one of
// a fixed list of causes, by `position()` over short common words.
//
// Weeks are Monday to Monday in UTC, cut by arithmetic on the Unix timestamp
// (week 0 began on Monday 1970-01-05), as every product connector counts
// them. The hour heat map alone reads the clock the app's users work by
// (`KZ_APP_UTC_OFFSET_HOURS`). This deployment's own words and ids (the test
// hosts, the error words, the expected models) are in convex/lib/features.ts.

import { FIRST_MONDAY_SECONDS, WEEK_SECONDS, msOfDay } from "../lib/weeks";
import {
  KZ_APP_HOST,
  KZ_APP_UTC_OFFSET_HOURS,
  KZ_EXPECTED_MODELS,
  KZ_FAILURE_WORDS,
  KZ_STAGING_HOST,
  KZ_TEST_HOST_WORDS,
  POSTHOG_TEST_COHORT,
  TEAM_EMAIL_DOMAIN,
} from "../lib/features";
import { KZ_FAILURE_CAUSES, KZ_MODULES } from "../lib/kzProductDetail";
import { ConnectorError } from "./errors";

/** The questions asked, by the name the run log uses for each, in the order they are asked. */
export const QUESTIONS = [
  "weeks",
  "modules",
  "failures",
  "clinics",
  "orgs",
  "doctor_days",
  "people",
  "hours",
  "pages",
  "events",
  "fields",
  "months",
] as const;
export type Question = (typeof QUESTIONS)[number];

/** A doctor used the product: one of these, and nothing else, is an action. */
export const ACTION_EVENTS = [
  "intake_check_initiated",
  "records_check_initiated",
  "globexai_check_initiated",
  "journal_check_initiated",
  "orders_check_initiated",
  "lookup_check_initiated",
  "ask_search_submitted",
  "inquiry_chat_submitted",
  "form_entry_created",
  "capture_started",
  "document_uploaded",
] as const;
/** Each module's actions, in `KZ_MODULES` order. */
export const MODULE_ACTIONS: Record<(typeof KZ_MODULES)[number]["id"], readonly string[]> = {
  intake: ["intake_check_initiated"],
  records: ["records_check_initiated"],
  visits: ["globexai_check_initiated", "document_uploaded"],
  search: ["ask_search_submitted"],
  inquiries: ["inquiry_chat_submitted"],
  forms: ["form_entry_created"],
  capture: ["capture_started"],
  journal: ["journal_check_initiated"],
  lookup: ["lookup_check_initiated"],
  orders: ["orders_check_initiated"],
};
/** The app's own events the weekly figures count, beside actions, failures and costs. */
export const APP_EVENTS = [
  "$pageview",
  "$rageclick",
  "$exception",
  "$web_vitals",
  "stale_session_retry",
  "trial_ended",
] as const;
/** A check started: the six check modules' first event. */
export const CHECK_EVENTS = ACTION_EVENTS.slice(0, 6);
/** A check finished, as the scorecard's `checks_completed` has always counted it. */
export const COMPLETED_CHECK_EVENTS = [
  "intake_check_completed",
  "records_check_completed",
  "journal_check_completed",
  "orders_check_completed",
  "globexai_check_completed",
  "lookup_check_completed",
] as const;
/** A result a doctor waited for: what the speed figures time. */
export const RESULT_EVENTS = [
  ...COMPLETED_CHECK_EVENTS,
  "capture_completed",
  "ask_search_completed",
  "inquiry_generated",
  "form_entry_created",
] as const;
/** An action that ended in an error. */
export const FAILED_EVENTS = [
  "intake_check_failed",
  "records_check_failed",
  "globexai_check_failed",
  "journal_check_failed",
  "orders_check_failed",
  "lookup_check_failed",
  "capture_failed",
  "ask_search_failed",
  "inquiry_generation_failed",
  "document_upload_failed",
  "form_entry_save_failed",
] as const;

/** A value put in a query between single quotes: refused if it could leave them. */
function quoted(value: string): string {
  if (/['\\]/.test(value)) throw new Error(`"${value.slice(0, 40)}" is not one HogQL can quote.`);
  return value;
}

/** "event · property" pairs whose emptiness Tracking health watches. */
export const FIELD_CHECKS = [
  ["intake_check_completed", "check_id"],
  ["records_check_completed", "check_id"],
  ["intake_check_cost", "subscription_type"],
  ["intake_check_failed", "time_to_result_ms"],
  ["ask_search_submitted", "conversation_id"],
  ["intake_check_completed", "time_to_result_ms"],
  ["globexai_check_completed", "organization_id"],
  ["document_uploaded", "organization_id"],
] as const;

/** Rows one answer may hold; one that reaches it is refused as cut short. */
export const ROW_LIMIT = 50_000;

const list = (names: readonly string[]) => names.map((n) => `'${n}'`).join(", ");

/** A host as a HogQL regex inside a string literal: each dot matched as a dot (`\\.`). */
const hostPattern = (host: string) => host.replaceAll(".", String.raw`\\.`);

// The project's own test-account filters: no localhost, staging or preview
// hosts, none of the team's accounts, not the test cohort, production only.
// The hosts, the team's domain and the cohort are this deployment's (convex/lib/features.ts).
const REAL = [
  String.raw`NOT match(coalesce(toString(properties.$host), ''), '^(localhost|127\\.0\\.0\\.1)|` +
    hostPattern(KZ_STAGING_HOST) +
    KZ_TEST_HOST_WORDS.map((word) => `|${hostPattern(quoted(word))}`).join("") +
    "')",
  `coalesce(toString(person.properties.email), '') NOT ILIKE '%@${TEAM_EMAIL_DOMAIN}%'`,
  `person_id NOT IN COHORT ${POSTHOG_TEST_COHORT}`,
  "coalesce(toString(properties.environment), 'production') = 'production'",
].join(" AND ");

const ON_APP = `toString(properties.$host) = '${KZ_APP_HOST}'`;
const ORG = "coalesce(toString(properties.organization_id), '')";
const PLAN = "toString(properties.subscription_type)";
const MESSAGE = "coalesce(toString(properties.error_message), toString(properties.error), '')";
const TIME_MS = "coalesce(toFloat(properties.time_to_result_ms), toFloat(properties.time_to_completion_ms))";
const COST = "toFloat(properties.estimated_cost_usd)";
const IS_COST = "endsWith(event, '_cost')";

/** The module an event belongs to, as its 1-based place in `KZ_MODULES`; 0 for none. */
export const MODULE_OF = (() => {
  const prefixes: Record<(typeof KZ_MODULES)[number]["id"], string> = {
    intake: "startsWith(event, 'intake_check_')",
    records: "startsWith(event, 'records_check_')",
    visits:
      "startsWith(event, 'globexai_check_') OR event IN ('document_uploaded', 'document_upload_failed', 'visits_enrichment_cost')",
    search: "startsWith(event, 'ask_search_')",
    inquiries: "startsWith(event, 'inquiry_') AND event != 'paywall_shown'",
    forms: "startsWith(event, 'form_entry_')",
    capture: "startsWith(event, 'capture_')",
    journal: "startsWith(event, 'journal_check_')",
    lookup: "startsWith(event, 'lookup_check_')",
    orders: "startsWith(event, 'orders_check_')",
  };
  return `multiIf(${KZ_MODULES.map((m, i) => `${prefixes[m.id]}, ${i + 1}`).join(", ")}, 0)`;
})();

/**
 * A failure's cause, as its 1-based place in `KZ_FAILURE_CAUSES`: the first
 * cause, in that order, whose words (`KZ_FAILURE_WORDS`) the message holds.
 */
export const CAUSE_OF = (() => {
  const tests = KZ_FAILURE_CAUSES.flatMap(({ id }, i) => {
    const words = KZ_FAILURE_WORDS[id] ?? [];
    return words.length === 0
      ? []
      : [`${words.map((word) => `position(${MESSAGE}, '${quoted(word)}') > 0`).join(" OR ")}, ${i + 1}`];
  });
  // 12: no text, 13: another cause (KZ_FAILURE_CAUSES ends with these two).
  return `multiIf(${MESSAGE} = '', 12, ${tests.join(", ")}, 13)`;
})();

/** A failure's technical kind, from its own fields, as its 1-based place in `KZ_ERROR_KINDS`. */
export const KIND_OF = (() => {
  const type = "toString(properties.error_type)";
  const http = "coalesce(toString(properties.http_status), '')";
  return [
    "multiIf(",
    `${type} = 'timeout' OR ${http} IN ('504', '408'), 1,`,
    `match(${http}, '^5[0-9][0-9]$'), 2,`,
    `${type} = 'network', 3,`,
    `${type} = 'auth' OR ${http} IN ('401', '403'), 4,`,
    `${type} = 'validation', 5,`,
    `${type} = 'schema', 6,`,
    "7)",
  ].join(" ");
})();

/** Whether a cost event came from a model other than the one expected of it; "0" when none is expected. */
export const offModelOf = (models: Readonly<Record<string, string>>): string => {
  const tests = Object.entries(models).map(
    ([event, model]) => `(event = '${quoted(event)}' AND toString(properties.model_name) != '${quoted(model)}')`,
  );
  return tests.length === 0 ? "0" : `(${tests.join(" OR ")})`;
};
const OFF_MODEL = offModelOf(KZ_EXPECTED_MODELS);

/** A quantile as a whole number, or 0 where nothing was measured (its count says which). */
const quantile = (q: number, value: string, where: string) =>
  `if(countIf(${where} AND isNotNull(${value})) = 0, 0, round(quantileIf(${q})(${value}, ${where} AND isNotNull(${value}))))`;
// A sum over no row is null in PostHog, not 0: a module whose AI sends no cost event.
const micro = (value: string, where: string) => `coalesce(round(sumIf(${value}, ${where}) * 1000000), 0)`;

export type Window = {
  /** The finished weeks figures are written for, oldest first. */
  weeks: readonly string[];
  /** The finished weeks the queries read, oldest first: `weeks` and the year and a month before. */
  dataWeeks: readonly string[];
  /** The weeks the breakdowns (heat map, pages, events, fields) are kept for. */
  breakdownWeeks: readonly string[];
  /** The first day of the first month AI cost is read for, and the run's own time. */
  monthsFrom: string;
  now: number;
};

/** A slice of the window, Monday to Monday: one request asks for one slice. */
export type Slice = { from: string; to: string };

/**
 * Each question's HogQL over the window given, or over the part of it inside
 * `slice`. PostHog runs an API query for 10 seconds at most, so the run asks
 * for a few weeks at a time and puts the answers together: every answer but
 * `people` and `orgs` is grouped by week or day, so slices add up exactly.
 */
export function queries(window: Window, slice?: Slice): Record<Question, string> {
  const first = window.dataWeeks[0];
  const last = window.dataWeeks.at(-1);
  const lastBreakdown = window.breakdownWeeks.at(-1);
  if (first === undefined || last === undefined || window.breakdownWeeks[0] === undefined || lastBreakdown === undefined) {
    throw new ConnectorError("No week was asked for.");
  }
  const seconds = (day: string) => Math.floor(msOfDay(day) / 1000);
  const end = Math.min(seconds(last) + WEEK_SECONDS, slice ? seconds(slice.to) : Infinity);
  const within = (from: string) =>
    `timestamp >= toDateTime(${seconds(slice && slice.from > from ? slice.from : from)}) AND timestamp < toDateTime(${end}) AND ${REAL}`;
  const week = `intDiv(toUnixTimestamp(timestamp) - ${FIRST_MONDAY_SECONDS}, ${WEEK_SECONDS}) AS week`;
  const action = `event IN (${list(ACTION_EVENTS)})`;
  const check = `event IN (${list(CHECK_EVENTS)})`;
  const failed = `event IN (${list(FAILED_EVENTS)})`;
  const result = `event IN (${list(RESULT_EVENTS)})`;
  const completed = `event IN (${list(COMPLETED_CHECK_EVENTS)})`;
  const tail = `LIMIT ${ROW_LIMIT}`;
  const breakdowns = within(window.breakdownWeeks[0]);
  const moduleCounts = KZ_MODULES.map((m) => `countIf(event IN (${list(MODULE_ACTIONS[m.id])}))`).join(", ");

  return {
    weeks: [
      `SELECT ${week},`,
      `uniqIf(person_id, ${ON_APP} AND properties.$is_identified = true),`,
      `countIf(${completed}),`,
      `uniqIf($group_0, ${completed} AND coalesce($group_0, '') != ''),`,
      `uniqIf(person_id, ${action}), countIf(${check}), countIf(${action}),`,
      `countIf(${failed}), countIf(${failed} AND position(${MESSAGE}, 'Value: {') > 0),`,
      `countIf(${check} AND ${PLAN} = 'trial'), countIf(${check} AND ${PLAN} = 'paid'),`,
      `uniqIf(${ORG}, ${check} AND ${PLAN} = 'trial' AND ${ORG} != ''), uniqIf(${ORG}, ${check} AND ${PLAN} = 'paid' AND ${ORG} != ''),`,
      `${micro(COST, IS_COST)}, countIf(${IS_COST}), countIf(${OFF_MODEL}),`,
      `countIf(event = '$rageclick'), uniqIf(toString(properties.$session_id), event = '$rageclick'),`,
      `uniqIf(toString(properties.$session_id), ${ON_APP}),`,
      "countIf(event = '$exception' AND toString(properties.$lib) = 'web'),",
      "countIf(event = '$exception' AND toString(properties.$lib) = 'posthog-node'),",
      "countIf(event = 'stale_session_retry'),",
      "countIf(event = '$exception' AND position(toString(properties.source), 'sign-in') > 0),",
      "countIf(event = 'document_uploaded'), countIf(event = 'document_upload_failed'),",
      "countIf(event = 'trial_ended'), uniqIf(person_id, event = 'trial_ended'),",
      `${quantile(0.75, "toFloat(properties.$web_vitals_INP_value)", `event = '$web_vitals' AND ${ON_APP}`)},`,
      `countIf(event = '$web_vitals' AND ${ON_APP} AND isNotNull(toFloat(properties.$web_vitals_INP_value))),`,
      `countIf(event = '$web_vitals' AND ${ON_APP} AND toFloat(properties.$web_vitals_INP_value) > 500),`,
      `${quantile(0.75, "toFloat(properties.$web_vitals_LCP_value)", `event = '$web_vitals' AND ${ON_APP}`)},`,
      `countIf(event = '$web_vitals' AND ${ON_APP} AND isNotNull(toFloat(properties.$web_vitals_LCP_value)))`,
      `FROM events WHERE ${within(window.weeks[0] ?? first)}`,
      `AND (${action} OR ${failed} OR ${completed} OR ${IS_COST} OR event IN (${list(APP_EVENTS)}))`,
      `GROUP BY week ORDER BY week ${tail}`,
    ].join(" "),

    modules: [
      `SELECT ${week}, ${MODULE_OF} AS module,`,
      `countIf(${action}), uniqIf(person_id, ${action}), uniqIf(${ORG}, ${action} AND ${ORG} != ''),`,
      `countIf(${failed}), countIf(${result}), countIf(${result} AND isNotNull(${TIME_MS})),`,
      `${quantile(0.5, TIME_MS, result)}, ${quantile(0.95, TIME_MS, result)},`,
      `countIf(${result} AND ${TIME_MS} > 60000),`,
      `${micro(COST, IS_COST)}, countIf(${IS_COST}), countIf(${IS_COST} AND toString(properties.hedged) = 'true'),`,
      `${quantile(0.95, "toFloat(properties.input_tokens)", IS_COST)}`,
      `FROM events WHERE ${within(window.weeks[0] ?? first)} AND (${action} OR ${failed} OR ${result} OR ${IS_COST})`,
      `GROUP BY week, module HAVING module > 0 ORDER BY week, module ${tail}`,
    ].join(" "),

    failures: [
      `SELECT ${week}, ${CAUSE_OF} AS cause, ${KIND_OF} AS kind, count()`,
      `FROM events WHERE ${within(window.weeks[0] ?? first)} AND ${failed}`,
      `GROUP BY week, cause, kind ORDER BY week, cause, kind ${tail}`,
    ].join(" "),

    clinics: [
      `SELECT ${week}, ${ORG} AS org,`,
      `countIf(${action}), countIf(${check}), countIf(${failed}), uniqIf(person_id, ${action}),`,
      `uniqIf(toDate(timestamp), ${action}),`,
      `if(countIf(${action}) = 0, 0, intDiv(toUnixTimestamp(maxIf(timestamp, ${action})), 86400)),`,
      `multiIf(argMaxIf(${PLAN}, timestamp, ${action}) = 'paid', 1, argMaxIf(${PLAN}, timestamp, ${action}) = 'trial', 2, 0),`,
      moduleCounts,
      `FROM events WHERE ${within(first)} AND (${action} OR ${failed}) AND ${ORG} != ''`,
      `GROUP BY week, org ORDER BY week, org ${tail}`,
    ].join(" "),

    // A clinic's name, for linking it to its row in Customers once. It is
    // compared there and never stored anywhere else.
    orgs: [
      `SELECT ${ORG} AS org, argMax(toString(properties.organization_name), timestamp) AS name`,
      `FROM events WHERE ${within(first)} AND ${action} AND ${ORG} != ''`,
      `GROUP BY org ORDER BY org ${tail}`,
    ].join(" "),

    doctor_days: [
      "SELECT toString(person_id) AS doctor, intDiv(toUnixTimestamp(timestamp), 86400) AS day,",
      `count(), ${moduleCounts}`,
      `FROM events WHERE ${within(first)} AND ${action}`,
      `GROUP BY doctor, day ORDER BY doctor, day ${tail}`,
    ].join(" "),

    // Everyone signed in to the app over the window: first and last name
    // (never the email or phone, which only decide who is left out), when
    // first seen, their trial and subscription, and their clinic and plan as
    // their latest action had them.
    people: [
      "SELECT toString(person_id) AS doctor,",
      "argMax(toString(person.properties.firstName), timestamp) AS first_name, argMax(toString(person.properties.lastName), timestamp) AS last_name,",
      "intDiv(toUnixTimestamp(min(timestamp)), 86400),",
      "if(countIf(event = 'trial_ended') = 0, 0, intDiv(toUnixTimestamp(minIf(timestamp, event = 'trial_ended')), 86400)),",
      "if(countIf(event = 'subscription_started') = 0, 0, intDiv(toUnixTimestamp(maxIf(timestamp, event = 'subscription_started')), 86400)),",
      `argMaxIf(${ORG}, timestamp, ${action}),`,
      `multiIf(argMaxIf(${PLAN}, timestamp, ${action}) = 'paid', 1, argMaxIf(${PLAN}, timestamp, ${action}) = 'trial', 2, 0),`,
      `argMaxIf(event, timestamp, ${action} OR ${failed})`,
      `FROM events WHERE ${within(first)} AND properties.$is_identified = true`,
      `AND (${action} OR ${failed} OR event IN ('$pageview', 'trial_ended', 'subscription_started'))`,
      "AND coalesce(toString(person.properties.email), '') != ''",
      `GROUP BY doctor ORDER BY doctor ${tail}`,
    ].join(" "),

    hours: [
      `SELECT ${week}, toDayOfWeek(timestamp + INTERVAL ${KZ_APP_UTC_OFFSET_HOURS} HOUR) AS dow, toHour(timestamp + INTERVAL ${KZ_APP_UTC_OFFSET_HOURS} HOUR) AS hour,`,
      `countIf(${failed}) AS failures, countIf(${action}) AS actions`,
      `FROM events WHERE ${within(window.weeks[0] ?? first)} AND (${failed} OR ${action})`,
      `GROUP BY week, dow, hour ORDER BY week, dow, hour ${tail}`,
    ].join(" "),

    // A page by its path with every id made ":id", so no id reaches a row.
    pages: [
      `SELECT ${week}, replaceRegexpAll(toString(properties.$pathname), '/[0-9a-zA-Z_-]*[0-9][0-9a-zA-Z_-]*', '/:id') AS page,`,
      `${quantile(0.75, "toFloat(properties.$web_vitals_INP_value)", "event = '$web_vitals'")},`,
      "countIf(event = '$web_vitals' AND isNotNull(toFloat(properties.$web_vitals_INP_value))),",
      "countIf(event = '$web_vitals' AND toFloat(properties.$web_vitals_INP_value) > 500),",
      "countIf(event = '$rageclick')",
      `FROM events WHERE ${breakdowns} AND ${ON_APP} AND event IN ('$web_vitals', '$rageclick')`,
      // Without its own LIMIT an answer stops at 100 rows.
      `GROUP BY week, page ORDER BY week, page LIMIT 40 BY week ${tail}`,
    ].join(" "),

    events: [
      `SELECT ${week}, event, count(), uniq(person_id)`,
      `FROM events WHERE ${breakdowns} AND (NOT startsWith(event, '$') OR event IN ('$exception', '$rageclick', '$web_vitals'))`,
      `GROUP BY week, event ORDER BY week, event ${tail}`,
    ].join(" "),

    fields: [
      `SELECT ${week},`,
      FIELD_CHECKS.map(
        ([event, property]) =>
          `countIf(event = '${event}'), countIf(event = '${event}' AND coalesce(toString(properties.${property}), '') = '')`,
      ).join(", "),
      `FROM events WHERE ${breakdowns} AND event IN (${list([...new Set(FIELD_CHECKS.map(([e]) => e))])})`,
      `GROUP BY week ORDER BY week ${tail}`,
    ].join(" "),

    // AI cost by month: the twelve months before this one and this one so far.
    months: [
      "SELECT toYear(timestamp) * 12 + toMonth(timestamp) - 1 AS month,",
      `${micro(COST, "1")}, uniqIf(${ORG}, ${ORG} != '')`,
      `FROM events WHERE timestamp >= toDateTime(${seconds(window.monthsFrom)}) AND timestamp < toDateTime(${Math.floor(window.now / 1000)})`,
      `AND ${REAL} AND ${IS_COST}`,
      `GROUP BY month ORDER BY month ${tail}`,
    ].join(" "),
  };
}
