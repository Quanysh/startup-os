// Rules for mirrored records: text another system chose, stored so the owner
// can read it. Pure, so the UI can share the types and the grouping.
//
// The one thing every function here guarantees: a message it returns is made
// of this file's words and numbers, never of a record's content.

import type { Infer } from "convex/values";
import type { recordValidator } from "./mirrorValidators";

export type MirrorRecord = Infer<typeof recordValidator>;
export type MirrorKind = MirrorRecord["kind"];
export type RecordOf<K extends MirrorKind> = Extract<MirrorRecord, { kind: K }>;
export type Person = { name: string; address: string };

export const MIRROR_SOURCES = ["gmail", "google_calendar", "linear", "fireflies"] as const;
export type MirrorSource = (typeof MIRROR_SOURCES)[number];

/**
 * Lists a source pushes for the whole team rather than for one person: Apollo's
 * sequences and its contacts and accounts by stage. They hold the team's own
 * labels and counts, and nothing about a person has a field in them. They are
 * no work tool: a personal token cannot write them, they have no off switch,
 * and their rules live apart (`sharedRecords.ts`) so the four tools' cannot
 * reach them. One source carries several kinds, so a push says which.
 */
export const SHARED_SOURCES = ["apollo", "github"] as const;
export type SharedSource = (typeof SHARED_SOURCES)[number];
export const SHARED_KINDS = ["sequence", "stage_count", "repo", "pull_request"] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];
/**
 * Which lists each shared source carries, and no others: GitHub's token
 * cannot write a sequence, and Apollo's cannot write a repository. GitHub's
 * two lists are its repositories (a name, a company and counts) and its pull
 * requests (each with its title, its author and who is asked to review: the
 * owner asked for those; no description, comment, branch or commit has a field).
 */
export const SHARED_KINDS_OF: Record<SharedSource, readonly SharedKind[]> = {
  apollo: ["sequence", "stage_count"],
  github: ["repo", "pull_request"],
};

export const isSharedSource = (source: string): source is SharedSource =>
  (SHARED_SOURCES as readonly string[]).includes(source);

/** The sources read with the Google grant. Without a grant, nothing of theirs is written. */
export const GOOGLE_SOURCES: readonly MirrorSource[] = ["gmail", "google_calendar"];

export const KIND_OF: Record<MirrorSource, MirrorKind> = {
  gmail: "mail",
  google_calendar: "event",
  linear: "issue",
  fireflies: "meeting",
};

/**
 * True where a good read is the whole current set, so a stored record the
 * read no longer holds is removed (a thread that was answered). Meeting notes
 * only accumulate: a read is the latest few, not all of them.
 */
export const REPLACES: Record<MirrorKind, boolean> = {
  mail: true,
  event: true,
  issue: true,
  meeting: false,
};

export const MAX_MIRROR_ROWS = 1000;
/** Meeting notes are kept this long after the meeting, and older ones are never taken in. */
export const MEETING_NOTE_DAYS = 90;
export const CAPS = {
  id: 1100, // Calendar ids may be 1024 characters
  title: 200,
  name: 100,
  address: 254,
  overview: 1200,
  actionItem: 300,
  actionItems: 20,
  people: 30,
  url: 300,
} as const;

// Control characters, line separators, and the invisible direction overrides
// that can make a sender's name or a subject read as something it is not.
// Each becomes a space: where one stood, two words were apart.
const UNSAFE = "\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";
// Characters that take no room on screen and so can sit inside a word unseen:
// zero-width space, non-joiner and joiner, the word joiner, the byte-order
// mark, the left-to-right, right-to-left and Arabic letter marks, and the
// Unicode tag block (which can carry a whole hidden message). Each is removed
// outright, so what is stored is what the eye reads.
const HIDDEN = "\\u200b-\\u200f\\u2060\\ufeff\\u061c\\u{e0000}-\\u{e007f}";
const CONTROL = new RegExp(`[${UNSAFE}${HIDDEN}]`, "u");
const CONTROL_RUNS = new RegExp(`[${UNSAFE}]+`, "gu");
const HIDDEN_RUNS = new RegExp(`[${HIDDEN}]+`, "gu");

/** Remote text made storable: one line, single spaces, at most `max` characters. */
export function cleanRemote(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value
    .replace(HIDDEN_RUNS, "")
    .replace(CONTROL_RUNS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A lower-cased email address, or "" for anything that is not plainly one:
 * printable ASCII only, with exactly one "@" and a dot in the domain. An
 * address is shown, compared with the owner's own and grouped by its domain,
 * so nothing invisible, direction-changing or merely Latin-looking is let in;
 * a record whose address fails this is dropped by its parser.
 */
export function cleanAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  const address = value.trim().toLowerCase();
  return address.length <= CAPS.address &&
    /^[\x21-\x7e]+$/.test(address) &&
    /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address)
    ? address
    : "";
}

/** A domain the owner typed ("@Fund.com" → "fund.com"), or null. */
export function cleanDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.length <= CAPS.address ? domain : null;
}

export type MailGroup = "investor" | "customer" | "other";
export type DomainLists = { investorDomains: readonly string[]; customerDomains: readonly string[] };

export function groupOf(address: string, lists: DomainLists): MailGroup {
  const domain = address.split("@")[1] ?? "";
  const within = (list: readonly string[]) =>
    list.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (within(lists.investorDomains)) return "investor";
  if (within(lists.customerDomains)) return "customer";
  return "other";
}

/** The only link a mirrored record may carry: it becomes an href. */
export function isLinearUrl(url: string): boolean {
  return url.length <= CAPS.url && /^https:\/\/linear\.app\/[^\s"<>]*$/.test(url);
}

export function keyOf(record: MirrorRecord): { externalId: string; sortAt: number } {
  switch (record.kind) {
    case "mail":
      return { externalId: record.threadId, sortAt: record.lastMessageAt };
    case "event":
      return { externalId: record.eventId, sortAt: record.startsAt };
    case "issue":
      return { externalId: record.issueId, sortAt: record.updatedAt };
    case "meeting":
      return { externalId: record.meetingId, sortAt: record.heldAt };
  }
}

/** Text as `cleanRemote` leaves it: within `max`, with nothing invisible or controlling in it. */
export const fitsText = (value: string, max: number) => value.length <= max && !CONTROL.test(value);
const text = fitsText;
// Later than 2001 and earlier than 2100: a number that is plainly a time.
const instant = (value: number) =>
  Number.isFinite(value) && value > 1_000_000_000_000 && value < 4_102_444_800_000;
const day = (value: string | undefined) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value);
const person = (p: Person) =>
  text(p.name, CAPS.name) && (p.address === "" || cleanAddress(p.address) === p.address);
const people = (list: readonly Person[]) => list.length <= CAPS.people && list.every(person);

function fits(r: MirrorRecord): boolean {
  switch (r.kind) {
    case "mail":
      return (
        text(r.subject, CAPS.title) &&
        r.fromAddress !== "" &&
        person({ name: r.fromName, address: r.fromAddress }) &&
        instant(r.lastMessageAt)
      );
    case "event":
      return (
        text(r.title, CAPS.title) &&
        instant(r.startsAt) &&
        instant(r.endsAt) &&
        r.endsAt >= r.startsAt &&
        day(r.startDate) &&
        day(r.endDate) &&
        people(r.attendees) &&
        Number.isInteger(r.attendeeCount) &&
        r.attendeeCount >= r.attendees.length
      );
    case "issue":
      return (
        text(r.identifier, 40) &&
        text(r.title, CAPS.title) &&
        (r.url === "" || isLinearUrl(r.url)) &&
        text(r.stateName, CAPS.name) &&
        text(r.teamKey, 20) &&
        text(r.teamName, CAPS.name) &&
        text(r.assigneeName, CAPS.name) &&
        Number.isInteger(r.priority) &&
        r.priority >= 0 &&
        r.priority <= 4 &&
        day(r.dueDate) &&
        instant(r.updatedAt)
      );
    case "meeting":
      return (
        text(r.title, CAPS.title) &&
        instant(r.heldAt) &&
        Number.isFinite(r.durationMinutes) &&
        r.durationMinutes >= 0 &&
        r.durationMinutes <= 1440 &&
        people(r.participants) &&
        text(r.overview, CAPS.overview) &&
        r.actionItems.length <= CAPS.actionItems &&
        r.actionItems.every((item) => text(item, CAPS.actionItem))
      );
  }
}

/**
 * Why a batch may not be written, or null. One bad record refuses the whole
 * batch: with replace semantics, writing the rest would delete the bad one's
 * stored copy. The sentence holds counts only.
 */
export function refusal(source: MirrorSource, rows: readonly MirrorRecord[]): string | null {
  if (rows.length > MAX_MIRROR_ROWS) return `More than ${MAX_MIRROR_ROWS} records in one read.`;
  const kind = KIND_OF[source];
  const seen = new Set<string>();
  let bad = 0;
  for (const row of rows) {
    const { externalId } = keyOf(row);
    if (
      row.kind !== kind ||
      externalId === "" ||
      !text(externalId, CAPS.id) ||
      seen.has(externalId) ||
      !fits(row)
    ) {
      bad += 1;
    }
    seen.add(externalId);
  }
  return bad === 0
    ? null
    : `${bad} of ${rows.length} records broke the size and shape rules, so nothing was written.`;
}
