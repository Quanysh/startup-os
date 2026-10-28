// Mirrored records that arrive by push (`records` in POST /ingest/v1) instead
// of being read by a connector here. A pushed row is the pulled parser's
// output with times as ISO text: this file turns it into the same
// `MirrorRecord` through the same cleaners (`cleanRemote`, `cleanAddress`),
// and the batch then passes the same `refusal` and the same write
// (`mirror.apply`). There is no second path to the table.
//
// Pure, so the push script checks a file with it before sending.
//
// The one thing every function here guarantees: an issue it returns is a path
// built from field names declared here plus row numbers, and words written
// here or in ingestSchema's FIXED_WORDS. Never a record's text, and never the
// name of a field the sender made up.

import { z } from "zod";
import { THREAD_ID } from "../connectors/gmailParse";
import { EMPTY_RECORDS, fixedWords, type IngestIssue } from "./ingestSchema";
import {
  CAPS,
  MAX_MIRROR_ROWS,
  MEETING_NOTE_DAYS,
  cleanAddress,
  cleanRemote,
  isLinearUrl,
  keyOf,
  refusal,
  type MirrorRecord,
  type MirrorSource,
  type Person,
  type RecordOf,
} from "./mirrorRules";
import { isCanonicalPeriodStart } from "./periods";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a push with no records is a real answer, sent with `"empty": true`:
 * an inbox with nothing waiting, a calendar with nothing on it. The same two
 * the pulled connectors apply an empty read for. Linear with no issues at
 * all, or Fireflies with no meetings, is a failed read however it is sent.
 */
export const EMPTY_IS_AN_ANSWER: Record<MirrorSource, boolean> = {
  gmail: true,
  google_calendar: true,
  linear: false,
  fireflies: false,
};

/** The field each kind is matched on. */
const ID_FIELD: Record<MirrorSource, string> = {
  gmail: "threadId",
  google_calendar: "eventId",
  linear: "issueId",
  fireflies: "meetingId",
};

/**
 * Text longer than this is refused. Up to it, text is cut to the stored cap
 * exactly as a pulled read cuts it (a 300-character subject is kept as 200).
 */
export const MAX_PUSHED_TEXT = 5000;
/** The most issues one reply lists. */
const MAX_ISSUES = 50;

const text = z.string().max(MAX_PUSHED_TEXT);
// An id is matched on and, for mail, becomes part of a link: printable ASCII
// with no spaces, so nothing in it can hide or reorder what is shown.
const id = z
  .string()
  .min(1)
  .max(CAPS.id)
  .regex(/^[\x21-\x7e]+$/);
/** An instant: ISO 8601 with a "Z" or an offset. */
const instant = z.iso.datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const personRow = z.strictObject({ name: text.optional(), address: text.optional() });
const peopleRows = z.array(personRow).max(CAPS.people);

// Each row is the whole allow-list for its kind. A body, a snippet, a
// description, a location, a meeting link, a transcript: none has a field
// here, so a push that carries one is refused, not trimmed.
const ROWS = {
  // A thread waiting on the owner, as the pushing session decided it.
  gmail: z.strictObject({
    threadId: id,
    fromName: text.optional(),
    fromAddress: text,
    subject: text.optional(),
    lastMessageAt: instant,
  }),
  google_calendar: z.strictObject({
    eventId: id,
    /** True for an event marked private or confidential: stored as "Busy", with nobody on it. */
    private: z.boolean().optional(),
    title: text.optional(),
    // A timed event has these two…
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    // …and an all-day one these (the end is the day after the last day).
    startDate: day.optional(),
    endDate: day.optional(),
    attendees: peopleRows.optional(),
    /** How many others are invited, when more than the 30 listed. */
    attendeeCount: z.number().int().min(0).max(100_000).optional(),
    hasMeetingLink: z.boolean().optional(),
  }),
  linear: z.strictObject({
    issueId: id,
    identifier: text,
    title: text.optional(),
    url: text.optional(),
    stateType: z.enum(["backlog", "unstarted", "started", "completed"]),
    stateName: text.optional(),
    teamKey: text.optional(),
    teamName: text.optional(),
    assigneeName: text.optional(),
    mine: z.boolean(),
    priority: z.number().int().min(0).max(4).optional(),
    dueDate: day.optional(),
    updatedAt: instant,
  }),
  // Meeting notes. Never the transcript.
  fireflies: z.strictObject({
    meetingId: id,
    title: text.optional(),
    heldAt: instant,
    durationMinutes: z.number().min(0).max(1440).optional(),
    participants: peopleRows.optional(),
    overview: text.optional(),
    actionItems: z.array(text).max(CAPS.actionItems).optional(),
  }),
} as const;

type Row<S extends MirrorSource> = z.infer<(typeof ROWS)[S]>;
/** A pushed row of one tool, as the sender writes it. */
export type PushedRow<S extends MirrorSource> = Row<S>;

/**
 * The fields a pushed row of a tool may have, in the validator's own order,
 * and whether each must be there. Read off `ROWS`, so whatever describes a
 * row to a sender (the prompt on the Connect page) cannot name a field the
 * validator does not take, or leave one out.
 */
export function rowFields(source: MirrorSource): { name: string; required: boolean }[] {
  const shape = ROWS[source].shape as Record<string, z.ZodType>;
  return Object.entries(shape).map(([name, field]) => ({
    name,
    required: !field.safeParse(undefined).success,
  }));
}
/** Reports a problem with one field of the row in hand. */
type Fail = (field: string, message: string) => void;

const NOT_AN_ADDRESS = "is not an email address";
const NOT_A_DATE = "is not a real date (YYYY-MM-DD)";

/** Named people, cleaned as a pulled read cleans them; one with neither a name nor an address is dropped. */
function people(list: readonly z.infer<typeof personRow>[] | undefined): Person[] {
  return (list ?? [])
    .map((p) => ({ name: cleanRemote(p.name, CAPS.name), address: cleanAddress(p.address) }))
    .filter((p) => p.name !== "" || p.address !== "");
}

function mailOf(row: Row<"gmail">, fail: Fail): RecordOf<"mail"> {
  // The id goes into a mail.google.com link, as it does for a pulled thread.
  if (!THREAD_ID.test(row.threadId)) fail("threadId", "is not a Gmail thread id");
  const fromAddress = cleanAddress(row.fromAddress);
  if (fromAddress === "") fail("fromAddress", NOT_AN_ADDRESS);
  return {
    kind: "mail",
    threadId: row.threadId,
    fromName: cleanRemote(row.fromName, CAPS.name),
    fromAddress,
    subject: cleanRemote(row.subject, CAPS.title) || "(no subject)",
    lastMessageAt: Date.parse(row.lastMessageAt),
  };
}

function eventOf(row: Row<"google_calendar">, fail: Fail): RecordOf<"event"> {
  const timed = row.startsAt !== undefined && row.endsAt !== undefined;
  const allDay = row.startDate !== undefined && row.endDate !== undefined;
  const fields = [row.startsAt, row.endsAt, row.startDate, row.endDate];
  if (timed === allDay || fields.filter((f) => f !== undefined).length !== 2) {
    fail("startsAt", "Send startsAt and endsAt, or startDate and endDate for an all-day event.");
  }
  for (const field of ["startDate", "endDate"] as const) {
    const value = row[field];
    if (value !== undefined && !isCanonicalPeriodStart("day", value)) fail(field, NOT_A_DATE);
  }
  const startsAt = Date.parse(allDay ? `${row.startDate}T00:00:00Z` : (row.startsAt ?? ""));
  const endsAt = Date.parse(allDay ? `${row.endDate}T00:00:00Z` : (row.endsAt ?? ""));
  if (endsAt < startsAt) fail(allDay ? "endDate" : "endsAt", "is before the start");

  // A private event is "Busy" and nothing more. Its title and guests are
  // refused rather than dropped, so a push that carries them is noticed.
  const hidden = row.private === true;
  if (hidden) {
    for (const field of ["title", "attendees", "attendeeCount"] as const) {
      if (row[field] !== undefined) fail(field, "A private event carries no title and no attendees.");
    }
  }
  const attendees = hidden ? [] : people(row.attendees);
  const attendeeCount = hidden ? 0 : (row.attendeeCount ?? attendees.length);
  if (attendeeCount < attendees.length) fail("attendeeCount", "is fewer than the attendees listed");

  return {
    kind: "event",
    eventId: row.eventId,
    title: hidden ? "Busy" : cleanRemote(row.title, CAPS.title) || "(no title)",
    startsAt,
    endsAt,
    allDay,
    ...(allDay ? { startDate: row.startDate, endDate: row.endDate } : {}),
    attendees,
    attendeeCount,
    hasMeetingLink: row.hasMeetingLink === true,
  };
}

function issueOf(row: Row<"linear">, fail: Fail): RecordOf<"issue"> {
  // The one link a record may carry: it becomes an href.
  const url = row.url ?? "";
  if (url !== "" && !isLinearUrl(url)) fail("url", "is not a linear.app link");
  if (row.dueDate !== undefined && !isCanonicalPeriodStart("day", row.dueDate)) {
    fail("dueDate", NOT_A_DATE);
  }
  return {
    kind: "issue",
    issueId: row.issueId,
    identifier: cleanRemote(row.identifier, 40),
    title: cleanRemote(row.title, CAPS.title) || "(no title)",
    url,
    stateType: row.stateType,
    stateName: cleanRemote(row.stateName, CAPS.name),
    teamKey: cleanRemote(row.teamKey, 20),
    teamName: cleanRemote(row.teamName, CAPS.name),
    assigneeName: cleanRemote(row.assigneeName, CAPS.name),
    mine: row.mine,
    priority: row.priority ?? 0,
    dueDate: row.dueDate,
    updatedAt: Date.parse(row.updatedAt),
  };
}

function meetingOf(row: Row<"fireflies">, fail: Fail, now: number): RecordOf<"meeting"> {
  const heldAt = Date.parse(row.heldAt);
  // The daily prune would only delete it again.
  if (heldAt < now - MEETING_NOTE_DAYS * DAY_MS) {
    fail("heldAt", `is older than the ${MEETING_NOTE_DAYS} days meeting notes are kept`);
  }
  return {
    kind: "meeting",
    meetingId: row.meetingId,
    title: cleanRemote(row.title, CAPS.title) || "(no title)",
    heldAt,
    durationMinutes: Math.round(row.durationMinutes ?? 0),
    participants: people(row.participants),
    overview: cleanRemote(row.overview, CAPS.overview),
    actionItems: (row.actionItems ?? [])
      .map((item) => cleanRemote(item, CAPS.actionItem))
      .filter((item) => item !== ""),
  };
}

function recordOf(source: MirrorSource, raw: unknown, fail: Fail, now: number): MirrorRecord | null {
  const parsed = ROWS[source].safeParse(raw);
  if (!parsed.success) {
    // Zod's path is made of this file's field names and list positions. The
    // name of a field the sender invented is in `keys`, which is never read.
    for (const issue of parsed.error.issues) fail(issue.path.join("."), fixedWords(issue));
    return null;
  }
  switch (source) {
    case "gmail":
      return mailOf(parsed.data as Row<"gmail">, fail);
    case "google_calendar":
      return eventOf(parsed.data as Row<"google_calendar">, fail);
    case "linear":
      return issueOf(parsed.data as Row<"linear">, fail);
    case "fireflies":
      return meetingOf(parsed.data as Row<"fireflies">, fail, now);
  }
}

/**
 * A pushed `records` list as the records to write, or why not. One bad row
 * refuses the whole push: with replace semantics, writing the rest would
 * delete the bad row's stored copy.
 */
export function parsePushedRecords(
  source: MirrorSource,
  raw: readonly unknown[],
  options: { empty: boolean; now: number },
): { ok: true; rows: MirrorRecord[] } | { ok: false; issues: IngestIssue[] } {
  const issues: IngestIssue[] = [];
  const refuse = () => ({ ok: false as const, issues: issues.slice(0, MAX_ISSUES) });

  if (raw.length > MAX_MIRROR_ROWS) {
    issues.push({ path: "records", message: `At most ${MAX_MIRROR_ROWS} records in one push.` });
    return refuse();
  }
  if (raw.length === 0) {
    // The envelope's own rule (ingestSchema) already asks for `empty` beside
    // an empty list; said again here for a caller that skipped it.
    if (!options.empty) {
      issues.push({ path: "records", message: EMPTY_RECORDS });
    } else if (!EMPTY_IS_AN_ANSWER[source]) {
      issues.push({
        path: "empty",
        message: "An empty push is never accepted from this source: nothing there is a failed read.",
      });
    }
    return issues.length > 0 ? refuse() : { ok: true, rows: [] };
  }

  const rows: MirrorRecord[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const fail: Fail = (field, message) =>
      issues.push({ path: ["records", index, field].filter((p) => p !== "").join("."), message });
    const record = recordOf(source, item, fail, options.now);
    if (record === null) return;
    const { externalId } = keyOf(record);
    if (seen.has(externalId)) {
      fail(ID_FIELD[source], "repeats the id of an earlier record");
    }
    seen.add(externalId);
    rows.push(record);
  });
  if (issues.length > 0) return refuse();

  // The same gate a pulled read passes. Its sentence holds counts only.
  const refused = refusal(source, rows);
  if (refused !== null) return { ok: false, issues: [{ path: "records", message: refused }] };
  return { ok: true, rows };
}
