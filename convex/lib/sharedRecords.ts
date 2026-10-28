// The shared lists as they arrive by push (`records` with a `kind` in
// POST /ingest/v1): Apollo's sequences and its contacts and accounts by
// stage, and GitHub's repositories. The team's lists, not a person's: they
// are stored with no `owner`, under their source ("apollo", "github"), and
// read by the go-to-market page and the product page.
//
// Apart from recordRows.ts on purpose. That file is the four work tools'
// (mail, calendar, issues, meeting notes), which a personal token may push;
// nothing here is reachable from one, and nothing there accepts these kinds.
//
// Each row below is the whole allow-list for its kind. A sequence is its
// name, its switches, its dates and its counters; a stage count is a stage's
// name and a number. No person, email address, step text or template has a
// field, so a push that carries one is refused, not trimmed. A repository is
// its organisation and name, the company it is counted for, three counts, its
// main branch's build and the day code last landed.
//
// A pull request is the one list here that names people and carries text
// somebody typed, because the owner asked for it: its title, who opened it
// (login, and name where GitHub has one) and who is asked to review, beside
// its state, dates, review decision and checks. Still metadata only: no
// description, comment, file, branch, commit message or diff has a field. The
// title and the name are cleaned like every other remote text, and its link
// is rebuilt from its repository and number, never taken on trust.
//
// Pure, so the push script checks a file with it before sending. Every issue
// is a path built from field names declared here plus row numbers, and words
// written here or in ingestSchema's FIXED_WORDS: never a row's text.

import type { Infer } from "convex/values";
import { z } from "zod";
import { EMPTY_RECORDS, fixedWords, type IngestIssue } from "./ingestSchema";
import { ALL_COMPANY_IDS, type CompanyId } from "./company";
import { MAX_PR_REVIEWERS, MAX_PR_TITLE_LENGTH, MAX_PULL_REQUESTS } from "./limits";
import {
  CAPS,
  SHARED_KINDS_OF,
  cleanRemote,
  fitsText,
  type SharedKind,
  type SharedSource,
} from "./mirrorRules";
import type { sharedRecordValidator } from "./mirrorValidators";
import { isCanonicalPeriodStart } from "./periods";

export type SharedRecord = Infer<typeof sharedRecordValidator>;
export type SharedRecordOf<K extends SharedKind> = Extract<SharedRecord, { kind: K }>;

const DAY_MS = 24 * 60 * 60 * 1000;

export const SHARED_CAPS = {
  /** The most sequences one push, and so the stored list, may hold. */
  sequence: 200,
  /** The most stage rows: contacts' and accounts' stages together. */
  stage_count: 100,
  id: 64,
  steps: 100,
  /** No counter of a company this size is larger; one that is, is a broken read. */
  count: 10_000_000,
  /** The most repositories one push, and so the stored list, may hold. */
  repo: 300,
  /** GitHub's own limits for an organisation's and a repository's name. */
  repoOrg: 39,
  repoName: 100,
  /** No repository here has more pull requests open, or merged in a week. */
  repoCount: 100_000,
  /** The most pull requests one push, and so the stored list, may hold. */
  pull_request: MAX_PULL_REQUESTS,
  /** GitHub's own limit for a login. */
  login: 39,
  /** No repository's pull requests are numbered past this. */
  pullNumber: 10_000_000,
  /** More reviewers asked than this is a broken read. */
  reviewersRequested: 100,
} as const;

export const PULL_STATES = ["open", "merged", "closed"] as const;
export type PullState = (typeof PULL_STATES)[number];
/** GitHub's `reviewDecision`, in this codebase's words; `none` where GitHub gives none. */
export const REVIEW_DECISIONS = ["approved", "changes_requested", "review_required", "none"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A GitHub login: ASCII letters, digits and hyphens. Nothing a sentence fits in. */
export const LOGIN = /^[A-Za-z0-9-]+$/;

/** The only address a pull request may carry: GitHub's own for it. It becomes an href. */
export const pullUrl = (repoId: string, number: number) =>
  `https://github.com/${repoId}/pull/${number}`;

/** How a repository's default branch stands, from its latest commit's checks. */
export const REPO_MAIN = ["passing", "failing", "pending", "none"] as const;
export type RepoMain = (typeof REPO_MAIN)[number];

/** Text longer than this is refused. Up to it, a name is cut to the stored cap. */
const MAX_PUSHED_TEXT = 5000;
const MAX_ISSUES = 50;
const ID = /^[\x21-\x7e]+$/;
// What GitHub lets an organisation or a repository be called: ASCII letters,
// digits, ".", "-" and "_". Nothing a person could type a sentence into.
const SLUG = /^[A-Za-z0-9._-]+$/;
const REPO_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const text = z.string().max(MAX_PUSHED_TEXT);
const count = z.number().int().min(0).max(SHARED_CAPS.count);
// A UTC day. Apollo sends an instant; the page shows a date, so a date is all
// that is taken.
const day = z.string().max(40);
const repoCount = z.number().int().min(0).max(SHARED_CAPS.repoCount);
const repoId = z
  .string()
  .min(3)
  .max(SHARED_CAPS.repoOrg + 1 + SHARED_CAPS.repoName)
  .regex(REPO_ID);
const login = z.string().min(1).max(SHARED_CAPS.login).regex(LOGIN);
// An instant with its offset, as GitHub writes one.
const instant = z.iso.datetime({ offset: true }).max(40);

const ROWS = {
  sequence: z.strictObject({
    sequenceId: z.string().min(1).max(SHARED_CAPS.id).regex(ID),
    name: text.optional(),
    active: z.boolean(),
    archived: z.boolean(),
    steps: z.number().int().min(0).max(SHARED_CAPS.steps),
    createdAt: day,
    lastUsedAt: day.optional(),
    delivered: count,
    opened: count,
    replied: count,
    bounced: count,
    unsubscribed: count,
    /** Absent where click tracking is off: unknown, not zero. */
    clicked: count.optional(),
  }),
  stage_count: z.strictObject({
    entity: z.enum(["contact", "account"]),
    stage: text,
    count,
  }),
  repo: z.strictObject({
    repoId,
    org: z.string().min(1).max(SHARED_CAPS.repoOrg).regex(SLUG),
    name: z.string().min(1).max(SHARED_CAPS.repoName).regex(SLUG),
    company: z.enum(ALL_COMPANY_IDS),
    mergedLastWeek: repoCount,
    open: repoCount,
    stuck: repoCount,
    main: z.enum(REPO_MAIN),
    pushedAt: day,
  }),
  pull_request: z.strictObject({
    repoId,
    number: z.number().int().min(1).max(SHARED_CAPS.pullNumber),
    company: z.enum(ALL_COMPANY_IDS),
    title: z.string().max(MAX_PR_TITLE_LENGTH),
    url: z.string().max(CAPS.url),
    authorLogin: login.optional(),
    authorName: z.string().max(CAPS.name).optional(),
    draft: z.boolean(),
    state: z.enum(PULL_STATES),
    createdAt: instant,
    updatedAt: instant,
    mergedAt: instant.optional(),
    closedAt: instant.optional(),
    reviewDecision: z.enum(REVIEW_DECISIONS),
    lastReviewAt: instant.optional(),
    reviewersRequested: z.number().int().min(0).max(SHARED_CAPS.reviewersRequested),
    reviewers: z.array(login).max(MAX_PR_REVIEWERS),
    checks: z.enum(REPO_MAIN),
  }),
} as const;

type Row<K extends SharedKind> = z.infer<(typeof ROWS)[K]>;
/** A pushed row of one kind, as the sender writes it. */
export type PushedSharedRow<K extends SharedKind> = Row<K>;
type Fail = (field: string, message: string) => void;

const NOT_A_DATE = "is not a real date (YYYY-MM-DD)";
const realDay = (value: string) => isCanonicalPeriodStart("day", value);
const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);

/** How a stage is matched: its entity and its name, whatever the case. */
const stageKey = (entity: string, stage: string) => `stage:${entity}:${stage.toLowerCase()}`;

/** The key a later push matches a row on, and what the list is ordered by. */
export function sharedKeyOf(record: SharedRecord): { externalId: string; sortAt: number } {
  if (record.kind === "sequence") {
    return {
      externalId: `sequence:${record.sequenceId}`,
      sortAt: dayMs(record.lastUsedAt ?? record.createdAt),
    };
  }
  if (record.kind === "repo") {
    // GitHub tells two names apart by more than their case, so case is no part of the key.
    return { externalId: `repo:${record.repoId.toLowerCase()}`, sortAt: dayMs(record.pushedAt) };
  }
  if (record.kind === "pull_request") {
    return {
      externalId: `pr:${record.repoId.toLowerCase()}#${record.number}`,
      sortAt: record.updatedAt,
    };
  }
  return { externalId: stageKey(record.entity, record.stage), sortAt: record.count };
}

function sequenceOf(row: Row<"sequence">, fail: Fail, now: number): SharedRecordOf<"sequence"> {
  // A day of grace: the reader's clock and time zone are not this one's.
  const latest = now + DAY_MS;
  for (const field of ["createdAt", "lastUsedAt"] as const) {
    const value = row[field];
    if (value === undefined) continue;
    if (!realDay(value)) fail(field, NOT_A_DATE);
    else if (dayMs(value) > latest) fail(field, "is in the future");
  }
  // An email opened or answered was delivered first. More of either than
  // were delivered is a counter read from the wrong column.
  for (const field of ["opened", "replied"] as const) {
    if (row[field] > row.delivered) fail(field, "is more than delivered");
  }
  return {
    kind: "sequence",
    sequenceId: row.sequenceId,
    name: cleanRemote(row.name, CAPS.title) || "(no name)",
    active: row.active,
    archived: row.archived,
    steps: row.steps,
    createdAt: row.createdAt,
    ...(row.lastUsedAt === undefined ? {} : { lastUsedAt: row.lastUsedAt }),
    delivered: row.delivered,
    opened: row.opened,
    replied: row.replied,
    bounced: row.bounced,
    unsubscribed: row.unsubscribed,
    ...(row.clicked === undefined ? {} : { clicked: row.clicked }),
  };
}

function stageOf(row: Row<"stage_count">, fail: Fail): SharedRecordOf<"stage_count"> {
  const stage = cleanRemote(row.stage, CAPS.name);
  // The name is what the row is matched on: one with nothing to read is no stage.
  if (stage === "") fail("stage", "is empty");
  return { kind: "stage_count", entity: row.entity, stage, count: row.count };
}

function repoOf(row: Row<"repo">, fail: Fail, now: number): SharedRecordOf<"repo"> {
  // The id is not the sender's to choose: it is the organisation and the name.
  if (row.repoId !== `${row.org}/${row.name}`) {
    fail("repoId", "is not the organisation and the name");
  }
  // A waiting pull request is an open one.
  if (row.stuck > row.open) fail("stuck", "is more than open");
  if (!realDay(row.pushedAt)) fail("pushedAt", NOT_A_DATE);
  else if (dayMs(row.pushedAt) > now + DAY_MS) fail("pushedAt", "is in the future");
  return {
    kind: "repo",
    repoId: row.repoId,
    org: row.org,
    name: row.name,
    company: row.company,
    mergedLastWeek: row.mergedLastWeek,
    open: row.open,
    stuck: row.stuck,
    main: row.main,
    pushedAt: row.pushedAt,
  };
}

const NOT_ITS_ADDRESS = "is not this pull request's address on GitHub";

function pullOf(row: Row<"pull_request">, fail: Fail, now: number): SharedRecordOf<"pull_request"> {
  // The link is not the sender's to choose: it is rebuilt and compared whole,
  // so no other host, path, query or scheme can become an href.
  if (row.url !== pullUrl(row.repoId, row.number)) fail("url", NOT_ITS_ADDRESS);
  if (row.reviewers.length > row.reviewersRequested) {
    fail("reviewers", "names more reviewers than are requested");
  }
  const at = (value: string) => Date.parse(value);
  const createdAt = at(row.createdAt);
  const latest = now + DAY_MS;
  for (const field of ["createdAt", "updatedAt", "mergedAt", "closedAt", "lastReviewAt"] as const) {
    const value = row[field];
    if (value === undefined) continue;
    if (at(value) > latest) fail(field, "is in the future");
    else if (field !== "createdAt" && at(value) < createdAt) fail(field, "is before it was opened");
  }
  // What a state says about its dates, both ways.
  if (row.state === "merged" && row.mergedAt === undefined) fail("mergedAt", "is missing for one that is merged");
  if (row.state !== "merged" && row.mergedAt !== undefined) fail("mergedAt", "is given for one that is not merged");
  if (row.state === "closed" && row.closedAt === undefined) fail("closedAt", "is missing for one that is closed");
  if (row.state === "open" && row.closedAt !== undefined) fail("closedAt", "is given for one that is open");
  const authorName = cleanRemote(row.authorName, CAPS.name);
  return {
    kind: "pull_request",
    repoId: row.repoId,
    number: row.number,
    company: row.company,
    // Text somebody typed into another system: cleaned, and only ever shown as text.
    title: cleanRemote(row.title, MAX_PR_TITLE_LENGTH) || "(no title)",
    url: row.url,
    ...(row.authorLogin === undefined ? {} : { authorLogin: row.authorLogin }),
    ...(authorName === "" ? {} : { authorName }),
    draft: row.draft,
    state: row.state,
    createdAt,
    updatedAt: at(row.updatedAt),
    ...(row.mergedAt === undefined ? {} : { mergedAt: at(row.mergedAt) }),
    ...(row.closedAt === undefined ? {} : { closedAt: at(row.closedAt) }),
    reviewDecision: row.reviewDecision,
    ...(row.lastReviewAt === undefined ? {} : { lastReviewAt: at(row.lastReviewAt) }),
    reviewersRequested: row.reviewersRequested,
    reviewers: row.reviewers,
    checks: row.checks,
  };
}

function recordOf(kind: SharedKind, raw: unknown, fail: Fail, now: number): SharedRecord | null {
  const parsed = ROWS[kind].safeParse(raw);
  if (!parsed.success) {
    // Zod's path is made of this file's field names. The name of a field the
    // sender invented is in `keys`, which is never read.
    for (const issue of parsed.error.issues) fail(issue.path.join("."), fixedWords(issue));
    return null;
  }
  if (kind === "sequence") return sequenceOf(parsed.data as Row<"sequence">, fail, now);
  if (kind === "repo") return repoOf(parsed.data as Row<"repo">, fail, now);
  if (kind === "pull_request") return pullOf(parsed.data as Row<"pull_request">, fail, now);
  return stageOf(parsed.data as Row<"stage_count">, fail);
}

/** Whether a stored row is what the parser above would have produced. */
function fits(r: SharedRecord): boolean {
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (r.kind === "stage_count") {
    return r.stage !== "" && fitsText(r.stage, CAPS.name) && whole(r.count, SHARED_CAPS.count);
  }
  if (r.kind === "repo") {
    return (
      r.org.length <= SHARED_CAPS.repoOrg &&
      SLUG.test(r.org) &&
      r.name.length <= SHARED_CAPS.repoName &&
      SLUG.test(r.name) &&
      r.repoId === `${r.org}/${r.name}` &&
      [r.mergedLastWeek, r.open, r.stuck].every((n) => whole(n, SHARED_CAPS.repoCount)) &&
      r.stuck <= r.open &&
      realDay(r.pushedAt)
    );
  }
  if (r.kind === "pull_request") {
    // Later than 2001 and earlier than 2100: a number that is plainly a time.
    const time = (n: number | undefined) =>
      n === undefined || (Number.isFinite(n) && n > 1_000_000_000_000 && n < 4_102_444_800_000);
    const isLogin = (value: string) => value.length <= SHARED_CAPS.login && LOGIN.test(value);
    return (
      REPO_ID.test(r.repoId) &&
      whole(r.number, SHARED_CAPS.pullNumber) &&
      r.number >= 1 &&
      r.url === pullUrl(r.repoId, r.number) &&
      r.url.length <= CAPS.url &&
      r.title !== "" &&
      fitsText(r.title, MAX_PR_TITLE_LENGTH) &&
      (r.authorLogin === undefined || isLogin(r.authorLogin)) &&
      (r.authorName === undefined || (r.authorName !== "" && fitsText(r.authorName, CAPS.name))) &&
      [r.createdAt, r.updatedAt, r.mergedAt, r.closedAt, r.lastReviewAt].every(time) &&
      (r.state === "merged") === (r.mergedAt !== undefined) &&
      (r.state !== "closed" || r.closedAt !== undefined) &&
      (r.state !== "open" || r.closedAt === undefined) &&
      whole(r.reviewersRequested, SHARED_CAPS.reviewersRequested) &&
      r.reviewers.length <= MAX_PR_REVIEWERS &&
      r.reviewers.length <= r.reviewersRequested &&
      r.reviewers.every(isLogin)
    );
  }
  return (
    r.sequenceId.length <= SHARED_CAPS.id &&
    ID.test(r.sequenceId) &&
    r.name !== "" &&
    fitsText(r.name, CAPS.title) &&
    whole(r.steps, SHARED_CAPS.steps) &&
    realDay(r.createdAt) &&
    (r.lastUsedAt === undefined || realDay(r.lastUsedAt)) &&
    [r.delivered, r.opened, r.replied, r.bounced, r.unsubscribed, r.clicked ?? 0].every((n) =>
      whole(n, SHARED_CAPS.count),
    ) &&
    r.opened <= r.delivered &&
    r.replied <= r.delivered
  );
}

export const NOT_THIS_SOURCES_KIND = "This source has no list of that kind.";

/** Whether a list of this kind is one this source carries. */
export const sharedKindOf = (source: SharedSource, kind: SharedKind): boolean =>
  SHARED_KINDS_OF[source].includes(kind);

/**
 * Why a batch may not be written, or null: the guard the write itself
 * applies, whoever calls it. A push is one kind's whole list, so one bad row
 * refuses all of it, and so does an empty batch: for these lists "nothing
 * there" is how a failed read looks. The sentence holds counts only.
 */
export function sharedRefusal(kind: SharedKind, rows: readonly SharedRecord[]): string | null {
  if (rows.length === 0) return "An empty list is never written for this source.";
  if (rows.length > SHARED_CAPS[kind]) return `More than ${SHARED_CAPS[kind]} records in one read.`;
  const seen = new Set<string>();
  let bad = 0;
  for (const row of rows) {
    const { externalId } = sharedKeyOf(row);
    if (row.kind !== kind || seen.has(externalId) || !fits(row)) bad += 1;
    seen.add(externalId);
  }
  return bad === 0
    ? null
    : `${bad} of ${rows.length} records broke the size and shape rules, so nothing was written.`;
}

/**
 * A pushed `records` list of one kind as the records to write, or why not.
 *
 * An empty list is refused however it is sent. For a mailbox, nothing waiting
 * is a real answer; here it is what a failed read looks like (Apollo's report
 * drops its whole table when a metric and a grouping do not go together), and
 * writing it would wipe the page's list. An account that truly has no
 * sequences keeps the last list shown, with its age.
 */
export function parseSharedRecords(
  source: SharedSource,
  kind: SharedKind,
  raw: readonly unknown[],
  options: { empty: boolean; now: number },
): { ok: true; rows: SharedRecord[] } | { ok: false; issues: IngestIssue[] } {
  const issues: IngestIssue[] = [];
  const refuse = () => ({ ok: false as const, issues: issues.slice(0, MAX_ISSUES) });

  // Each source has its own lists. Asked before a row is read, so GitHub's
  // token cannot write a sequence nor Apollo's a repository, whoever calls.
  if (!sharedKindOf(source, kind)) {
    issues.push({ path: "kind", message: NOT_THIS_SOURCES_KIND });
    return refuse();
  }
  if (raw.length > SHARED_CAPS[kind]) {
    issues.push({
      path: "records",
      message: `At most ${SHARED_CAPS[kind]} records of this kind in one push.`,
    });
    return refuse();
  }
  if (raw.length === 0) {
    issues.push(
      options.empty
        ? {
            path: "empty",
            message:
              "An empty push is never accepted from this source: nothing there is a failed read.",
          }
        : { path: "records", message: EMPTY_RECORDS },
    );
    return refuse();
  }

  const rows: SharedRecord[] = [];
  const seen = new Set<string>();
  const companyOf = new Map<string, CompanyId>();
  raw.forEach((item, index) => {
    const fail: Fail = (field, message) =>
      issues.push({ path: ["records", index, field].filter((p) => p !== "").join("."), message });
    const record = recordOf(kind, item, fail, options.now);
    if (record === null) return;
    const { externalId } = sharedKeyOf(record);
    if (seen.has(externalId)) {
      if (record.kind === "sequence") fail("sequenceId", "repeats the id of an earlier record");
      else if (record.kind === "repo") fail("repoId", "repeats the id of an earlier record");
      else if (record.kind === "pull_request") fail("number", "repeats an earlier pull request");
      else fail("stage", "repeats an earlier stage");
    }
    seen.add(externalId);
    if (record.kind === "pull_request") {
      // A repository is one company's, so its pull requests are too: a list
      // that says otherwise would show one company's work to the other.
      const repo = record.repoId.toLowerCase();
      const first = companyOf.get(repo);
      if (first === undefined) companyOf.set(repo, record.company);
      else if (first !== record.company) {
        fail("company", "is not the company of this repository's other pull requests");
      }
    }
    rows.push(record);
  });
  if (issues.length > 0) return refuse();

  // The same gate the write applies. Its sentence holds counts only.
  const refused = sharedRefusal(kind, rows);
  if (refused !== null) return { ok: false, issues: [{ path: "records", message: refused }] };
  return { ok: true, rows };
}
