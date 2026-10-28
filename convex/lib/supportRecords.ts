// What the hourly Intercom task may push (source `intercom`, Globex's), and
// how a push is checked before anything is stored: docs/ingest.md,
// "Intercom". Used by the endpoint (convex/ingest.ts), `pnpm push:envelope`
// and the tests, so all three refuse the same things in the same words.
//
// A record is a strict object of exactly the fields the OS keeps
// (./support.ts, `SupportRow`): an unknown field refuses the push. Every
// string is bounded; a page area is held to `isPageArea` (no id, URL or
// query); a teammate's name and a help article's title are capped and
// cleaned of anything invisible. Issues are paths and fixed words,
// never a value: the names and titles are text from outside. Pure.

import { z } from "zod";
import { fixedWords, type IngestIssue } from "./ingestSchema";
import { cleanRemote } from "./mirrorRules";
import {
  FIN_OUTCOMES,
  MAX_ARTICLES,
  MAX_ARTICLE_TITLE,
  MAX_ASSIGNEE_NAME,
  MAX_SUPPORT_CONVERSATIONS,
  SUPPORT_ORIGINS,
  SUPPORT_STATES,
  isAppId,
  isPageArea,
  type SupportRow,
} from "./support";

/** A moment, as ISO 8601 in UTC. */
const time = z.iso.datetime();
const maybeTime = time.nullable();
const count = z.number().int().min(0).max(10_000_000).nullable();
const id = z.string().regex(/^\d{1,30}$/);
const text = (max: number) => z.string().min(1).max(max);

const recordSchema = z.strictObject({
  id,
  createdAt: time,
  updatedAt: time,
  state: z.enum(SUPPORT_STATES),
  open: z.boolean(),
  priority: z.boolean(),
  waitingSince: maybeTime,
  origin: z.enum(SUPPORT_ORIGINS),
  pageArea: z.string().max(81).nullable(),
  finParticipated: z.boolean(),
  finOutcome: z.enum(FIN_OUTCOMES).nullable(),
  humanRepliedAt: maybeTime,
  /** Seconds, as Intercom counts them. */
  timeToHumanReply: z.number().int().min(0).max(10 * 365 * 24 * 3600).nullable(),
  lastCustomerReplyAt: maybeTime,
  lastHumanReplyAt: maybeTime,
  assignee: z.strictObject({ id, name: text(MAX_ASSIGNEE_NAME).nullable() }).nullable(),
  parts: count,
  reopens: count,
  rating: z.number().int().min(1).max(5).nullable(),
  articles: z.array(text(MAX_ARTICLE_TITLE)).max(MAX_ARTICLES),
});

/** One conversation as the hourly task pushes it. */
export type SupportRecord = z.infer<typeof recordSchema>;

export const SUPPORT_WORDS = {
  appIdCode: "The workspace's id code is needed, as Intercom shows it in the inbox's address (letters and digits).",
  tooMany: `At most ${MAX_SUPPORT_CONVERSATIONS} conversations in one push.`,
  twice: "A conversation appears twice.",
  pageArea: 'A page area is "dashboard" or one or two plain words joined by "/", and only for a customer\'s chat.',
  finOutcome: "Fin's outcome is only for a chat Fin answered.",
  future: "Is in the future.",
  blank: "Is empty once cleaned.",
} as const;

/** How far ahead of the server's clock a time may be: a Mac's clock can run fast. */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

const ms = (value: string) => Date.parse(value);
const msOrNull = (value: string | null) => (value === null ? null : ms(value));

/**
 * A push's records and its workspace id, checked: the rows to store, or the
 * issues (paths and fixed words). `now` is the server's time of arrival.
 */
export function parseSupportPush(
  records: readonly unknown[],
  appIdCode: unknown,
  now: number,
): { ok: true; appId: string; rows: SupportRow[] } | { ok: false; issues: IngestIssue[] } {
  const issues: IngestIssue[] = [];
  if (!isAppId(appIdCode)) issues.push({ path: "appIdCode", message: SUPPORT_WORDS.appIdCode });
  if (records.length > MAX_SUPPORT_CONVERSATIONS) {
    issues.push({ path: "records", message: SUPPORT_WORDS.tooMany });
    return { ok: false, issues };
  }
  const rows: SupportRow[] = [];
  const seen = new Set<string>();
  records.forEach((raw, index) => {
    const at = (field: string) => `records.${index}${field === "" ? "" : `.${field}`}`;
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: at(issue.path.join(".")), message: fixedWords(issue) });
      }
      return;
    }
    const record = parsed.data;
    if (seen.has(record.id)) issues.push({ path: at("id"), message: SUPPORT_WORDS.twice });
    seen.add(record.id);
    if (record.pageArea !== null && (record.origin !== "customer" || !isPageArea(record.pageArea))) {
      issues.push({ path: at("pageArea"), message: SUPPORT_WORDS.pageArea });
    }
    if (record.finOutcome !== null && !record.finParticipated) {
      issues.push({ path: at("finOutcome"), message: SUPPORT_WORDS.finOutcome });
    }
    for (const field of ["createdAt", "updatedAt", "waitingSince", "humanRepliedAt", "lastCustomerReplyAt", "lastHumanReplyAt"] as const) {
      const value = record[field];
      if (value !== null && ms(value) > now + CLOCK_SLACK_MS) issues.push({ path: at(field), message: SUPPORT_WORDS.future });
    }
    const clean = (value: string, max: number, path: string) => {
      const cleaned = cleanRemote(value, max);
      if (cleaned === "") issues.push({ path: at(path), message: SUPPORT_WORDS.blank });
      return cleaned;
    };
    const name = record.assignee?.name ?? null;
    rows.push({
      intercomId: record.id,
      createdAt: ms(record.createdAt),
      updatedAt: ms(record.updatedAt),
      state: record.state,
      open: record.open,
      priority: record.priority,
      waitingSince: msOrNull(record.waitingSince),
      origin: record.origin,
      pageArea: record.pageArea,
      finParticipated: record.finParticipated,
      finOutcome: record.finOutcome,
      humanRepliedAt: msOrNull(record.humanRepliedAt),
      timeToHumanReply: record.timeToHumanReply,
      lastCustomerReplyAt: msOrNull(record.lastCustomerReplyAt),
      lastHumanReplyAt: msOrNull(record.lastHumanReplyAt),
      assigneeId: record.assignee?.id ?? null,
      assigneeName: name === null ? null : clean(name, MAX_ASSIGNEE_NAME, "assignee.name"),
      parts: record.parts,
      reopens: record.reopens,
      rating: record.rating,
      articles: record.articles.map((title, i) => clean(title, MAX_ARTICLE_TITLE, `articles.${i}`)),
    });
  });
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, 50) } : { ok: true, appId: appIdCode as string, rows };
}
