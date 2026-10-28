// Company memory: decisions and meeting notes (convex/decisions.ts,
// convex/meetingNotes.ts, /memory). The closed sets, the limits, the fixed
// sentences and the cleaners, in one pure module the page imports too.
//
// Everything typed here is data: a title, a decision, its context, a meeting's
// notes, an outside attendee's name. Each is cleaned of what the eye cannot
// see (`cleanRemote`), held to its limit (refused, never cut), stored as plain
// text and rendered as text. None goes in a log or a thrown error: every
// refusal below is fixed words.

import { ConvexError } from "convex/values";
import { MAX_NAME_LENGTH } from "./limits";
import { cleanRemote } from "./mirrorRules";

export const DECISION_STATUSES = ["proposed", "decided", "revisit", "reversed"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  decided: "Decided",
  revisit: "Revisit",
  reversed: "Reversed",
};

export const MEETING_KINDS = ["board", "investor", "leadership", "customer", "other"] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_KIND_LABELS: Record<MeetingKind, string> = {
  board: "Board",
  investor: "Investor",
  leadership: "Leadership",
  customer: "Customer",
  other: "Other",
};

export const MAX_DECISION_TEXT = 1_000;
export const MAX_DECISION_CONTEXT = 2_000;
export const MAX_MEETING_NOTES = 10_000;
/** A general note on /memory, not tied to a meeting. */
export const MAX_NOTE_BODY = 4_000;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 30;
/** Teammates, and outside people by name, on one meeting each. */
export const MAX_ATTENDEES = 20;
export const MAX_OUTSIDE_ATTENDEES = 20;
export const MAX_ACTION_ITEMS = 30;
/** Links from one decision to tasks, deals and goals, together. */
export const MAX_DECISION_LINKS = 20;
/** Rows one list sends: a bound, not a target. */
export const MEMORY_LIST_ROWS = 300;
/** What an agent's read tool sends of any one text field. */
export const AGENT_TEXT_CUT = 500;
/** Meetings of the owner's Fireflies the import offers. */
export const IMPORTABLE_MEETINGS = 20;

export const NOTE_WORDS = {
  title: "A note needs a title.",
  body: "A note needs some text.",
  gone: "That note no longer exists.",
} as const;

export const MEMORY_WORDS = {
  decisionGone: "That decision no longer exists.",
  meetingGone: "That meeting no longer exists.",
  cannotOwn: "That person cannot own a decision of that company.",
  cannotAttend: "That person cannot be an attendee of a meeting of that company.",
  noAddresses: "Outside attendees are names only: leave out email addresses.",
  tooManyAttendees: `At most ${MAX_ATTENDEES} teammates and ${MAX_OUTSIDE_ATTENDEES} outside people on one meeting.`,
  tooManyTags: `At most ${MAX_TAGS} tags, each at most ${MAX_TAG_LENGTH} characters.`,
  tooManyItems: `At most ${MAX_ACTION_ITEMS} action items on one meeting.`,
  tooManyLinks: `At most ${MAX_DECISION_LINKS} links on one decision.`,
  linkGone: "Something that decision links to is no longer there.",
  meetingElsewhere: "That meeting is the other company's.",
  notADate: "That is not a date.",
  needsDecision: "A decision needs what was decided.",
  itemGone: "That action item is no longer on the meeting.",
  itemOnBoard: "That action item is already on the board.",
  importGone: "That meeting is no longer in your Fireflies notes.",
} as const;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

/**
 * Several lines of typed text, each cleaned as `cleanRemote` cleans a line,
 * runs of blank lines kept to one, blank ends dropped. Over `max` is refused
 * in the words "<what> is too long".
 */
export function cleanMemoryLines(value: string, max: number, what: string): string {
  const kept: string[] = [];
  for (const raw of value.split(/\r\n|\n|\r|\u2028|\u2029/)) {
    const line = cleanRemote(raw, Number.MAX_SAFE_INTEGER);
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  const text = kept.join("\n");
  if (text.length > max) refuse(`${what} is too long (${max} characters at most).`);
  return text;
}

/** One line of typed text, cleaned; over `max` refused. */
export function cleanMemoryLine(value: string, max: number, what: string): string {
  const line = cleanRemote(value, Number.MAX_SAFE_INTEGER);
  if (line.length > max) refuse(`${what} is too long (${max} characters at most).`);
  return line;
}

/**
 * The people at a meeting from outside the team: plain names, cleaned, each
 * once. An email address is refused whole (a fixed sentence that does not
 * quote it): nobody's address is kept here.
 */
export function cleanOutsideNames(names: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of names) {
    const name = cleanRemote(raw, Number.MAX_SAFE_INTEGER);
    if (name === "") continue;
    if (name.includes("@")) refuse(MEMORY_WORDS.noAddresses);
    if (name.length > MAX_NAME_LENGTH) refuse(`A name is too long (${MAX_NAME_LENGTH} characters at most).`);
    if (!kept.includes(name)) kept.push(name);
  }
  if (kept.length > MAX_OUTSIDE_ATTENDEES) refuse(MEMORY_WORDS.tooManyAttendees);
  return kept;
}

/** Tags: lower-cased, single-spaced, each once. */
export function cleanTags(tags: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of tags) {
    const tag = cleanRemote(raw, Number.MAX_SAFE_INTEGER).toLowerCase();
    if (tag === "") continue;
    if (tag.length > MAX_TAG_LENGTH) refuse(MEMORY_WORDS.tooManyTags);
    if (!kept.includes(tag)) kept.push(tag);
  }
  if (kept.length > MAX_TAGS) refuse(MEMORY_WORDS.tooManyTags);
  return kept;
}

/**
 * Whether a decision is due for its revisit on `today` ("YYYY-MM-DD"): it has
 * a date, the date has come, and it was not reversed. The page, Today and the
 * daily sweep all ask this; none of them asks a clock here.
 */
export function isRevisitDue(
  decision: { revisitOn?: string | null; status: DecisionStatus },
  today: string,
): boolean {
  return (
    decision.revisitOn != null && decision.status !== "reversed" && decision.revisitOn <= today
  );
}

/** A text field as an agent's read tool sends it: at most AGENT_TEXT_CUT characters. */
export function agentCut(value: string | undefined | null): string | null {
  if (value == null || value === "") return null;
  return value.length > AGENT_TEXT_CUT ? `${value.slice(0, AGENT_TEXT_CUT - 1)}…` : value;
}
