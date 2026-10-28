// The daily standup's tasks: the shape a push takes, how its text is cleaned,
// and what makes two titles the same task. Pure, so the endpoint
// (convex/standup.ts), `pnpm standup:push` and the board all read one rule.
//
// What decides which commitments are tasks is a Claude session reading the
// meeting's summary (docs/setup.md, "Standup → tasks"). Nothing here
// understands a sentence: the OS stores, validates and drops what it already
// holds.
//
// A title, a context and an assignee's address are what people said in a
// meeting. No issue raised here quotes one: an issue is a path and fixed words.

import { z } from "zod";
import { ALL_COMPANY_IDS, type CompanyId } from "./company";
import { MAX_TITLE_LENGTH } from "./limits";
import { cleanRemote } from "./mirrorRules";
import { isCanonicalPeriodStart } from "./periods";

/** The source's id in the manifest, the run log and a card's `origin`. */
export const STANDUP_SOURCE = "standup";
export const STANDUP_VERSION = 1;
/** A standup's tasks are a few lines each. Far above a real push. */
export const MAX_STANDUP_BYTES = 64 * 1024;
export const MAX_STANDUP_TASKS = 30;
/** Tasks taken from this source in one UTC day, so a runaway routine cannot fill the board. */
export const MAX_STANDUP_TASKS_PER_DAY = 60;
export const MAX_CONTEXT_LENGTH = 200;
/** A person's name as it was said: used to find them in `people`, never stored. */
export const MAX_SAID_NAME = 80;
/** A card the session decided is both companies' (hiring, legal, the OS itself). */
export const SHARED_COMPANY = "shared";
/** A task finished this recently is still "already on the board". */
export const RECENT_DONE_DAYS = 14;
// What `GET /standup/v1/open` returns at most, of each kind.
export const MAX_OPEN_LISTED = 500;
export const MAX_DONE_LISTED = 200;
export const MAX_LINEAR_LISTED = 1000;

export const TOO_MANY_TODAY = "too_many_tasks";
export const TOO_MANY_TODAY_WORDS = `At most ${MAX_STANDUP_TASKS_PER_DAY} tasks a day are taken from the standup. Try again tomorrow.`;

const DAY_MS = 24 * 60 * 60 * 1000;
// Longer than anything kept, so a long field is refused in our words (after
// cleaning) and an absurd one by the schema.
const MAX_RAW_TEXT = 2000;
const NOT_A_DATE = "is not a date (YYYY-MM-DD)";
const tooLong = (max: number) => `is too long (${max} characters at most)`;

const taskRow = z.strictObject({
  /** Stable for this item within its meeting: "a1", "a2", … */
  key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  title: z.string().max(MAX_RAW_TEXT),
  /**
   * "shared" is both companies' by decision; null is unclear:
   * the OS reads the company off the text, and flags a card it cannot place.
   */
  company: z.enum([...ALL_COMPANY_IDS, SHARED_COMPANY]).nullable(),
  /** A work address. One the OS does not know leaves the task unassigned. */
  assignee: z.string().max(320).optional(),
  due: z.string().max(10).optional(),
  kind: z.enum(["task", "issue"]).optional(),
  context: z.string().max(MAX_RAW_TEXT).optional(),
  /** The person the item names as doing it ("Lena will…"): matched to `people`. */
  named: z.string().max(MAX_RAW_TEXT).optional(),
  /** Who said the item, sent only when they took it on themselves ("I will…"). */
  speaker: z.string().max(MAX_RAW_TEXT).optional(),
});

const pushShape = z.strictObject({
  version: z.literal(STANDUP_VERSION),
  /** The meeting's id in Fireflies. Never its title. */
  meetingId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  meetingDate: z.string().max(10),
  tasks: z.array(taskRow).max(MAX_STANDUP_TASKS),
});

export type StandupTask = {
  key: string;
  title: string;
  /** null: unclear, for the OS to place. */
  company: CompanyId | typeof SHARED_COMPANY | null;
  kind: "task" | "issue";
  assignee?: string;
  due?: string;
  context?: string;
  named?: string;
  speaker?: string;
};
export type StandupPush = {
  version: typeof STANDUP_VERSION;
  meetingId: string;
  meetingDate: string;
  tasks: StandupTask[];
};
export type StandupIssue = { path: string; message: string };

// Zod's own message names an unknown key and can quote a value, and here
// either may be what someone said in a meeting. These are the same words the
// main endpoint uses for a request that carries names.
const FIXED_WORDS: Record<string, string> = {
  invalid_type: "is missing or of the wrong type",
  invalid_value: "is not one of the allowed values",
  invalid_format: "is not in the expected form",
  too_big: "is too long or too large",
  too_small: "is empty or too small",
  unrecognized_keys: "has a field the OS does not accept",
};

/** The UTC day a moment falls on, "YYYY-MM-DD". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A push read with the endpoint's own rules: the strict shape, then each
 * text cleaned as mirrored text is (`cleanRemote`: control characters,
 * direction overrides and invisible characters out, one line) and held to its
 * length. One bad row refuses the whole push, and every bad row is named.
 */
export function parseStandupPush(
  raw: unknown,
  options: { now: number },
): { ok: true; push: StandupPush } | { ok: false; issues: StandupIssue[] } {
  const shaped = pushShape.safeParse(raw);
  if (!shaped.success) {
    return {
      ok: false,
      issues: shaped.error.issues.map((issue) => ({
        path: (issue.path.join(".") || "push").slice(0, 100),
        message: FIXED_WORDS[issue.code] ?? "is not valid",
      })),
    };
  }
  const { meetingId, meetingDate, tasks: rows } = shaped.data;
  const issues: StandupIssue[] = [];

  if (!isCanonicalPeriodStart("day", meetingDate)) {
    issues.push({ path: "meetingDate", message: NOT_A_DATE });
  } else if (meetingDate > utcDay(options.now + DAY_MS)) {
    // A day ahead is a time zone; more is a mistake.
    issues.push({ path: "meetingDate", message: "is in the future" });
  }

  const keys = new Set<string>();
  const tasks: StandupTask[] = [];
  for (const [index, row] of rows.entries()) {
    const at = (field: string) => `tasks.${index}.${field}`;
    const before = issues.length;

    if (keys.has(row.key)) issues.push({ path: at("key"), message: "repeats an earlier key" });
    keys.add(row.key);

    // Cleaned without a cut: a title too long is refused, never shortened.
    const title = cleanRemote(row.title, MAX_RAW_TEXT + 1);
    if (title === "") issues.push({ path: at("title"), message: "is empty" });
    else if (title.length > MAX_TITLE_LENGTH) {
      issues.push({ path: at("title"), message: tooLong(MAX_TITLE_LENGTH) });
    }

    const context = cleanRemote(row.context, MAX_RAW_TEXT + 1);
    if (context.length > MAX_CONTEXT_LENGTH) {
      issues.push({ path: at("context"), message: tooLong(MAX_CONTEXT_LENGTH) });
    }

    if (row.due !== undefined && !isCanonicalPeriodStart("day", row.due)) {
      issues.push({ path: at("due"), message: NOT_A_DATE });
    }

    const said: { named?: string; speaker?: string } = {};
    for (const field of ["named", "speaker"] as const) {
      const name = cleanRemote(row[field], MAX_RAW_TEXT + 1);
      if (name === "") continue;
      if (name.includes("@")) issues.push({ path: at(field), message: "is a name, not an address" });
      else if (name.length > MAX_SAID_NAME) issues.push({ path: at(field), message: tooLong(MAX_SAID_NAME) });
      else said[field] = name;
    }

    if (issues.length === before) {
      tasks.push({
        key: row.key,
        title,
        company: row.company,
        kind: row.kind ?? "task",
        ...(row.assignee === undefined ? null : { assignee: row.assignee }),
        ...(row.due === undefined ? null : { due: row.due }),
        ...(context === "" ? null : { context }),
        ...said,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, push: { version: STANDUP_VERSION, meetingId, meetingDate, tasks } };
}

/**
 * What makes two titles the same task: letter case, spacing, punctuation
 * (a trailing period among it) and width do not. Apostrophes close up
 * ("don't" is "dont"); any other mark is a gap ("follow-up" is "follow up").
 * Empty for a title with no letter or digit, which is then nobody's duplicate.
 */
export function normalTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two cards could be the same task by company: the same one, or
 * either is shared. Startup's "update the pricing page" is not Globex's.
 */
export function sameScope(
  a: CompanyId | null | undefined,
  b: CompanyId | null | undefined,
): boolean {
  return a == null || b == null || a === b;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-13" as "Oct 13": how a card and its note name the standup's day. */
export function standupDayLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1] ?? ""} ${day}`;
}

/** The note a card from the standup starts with. */
export function standupNotes(meetingDate: string, context?: string): string {
  const from = `From the standup of ${standupDayLabel(meetingDate)}`;
  return context ? `${from}: ${context}` : `${from}.`;
}
