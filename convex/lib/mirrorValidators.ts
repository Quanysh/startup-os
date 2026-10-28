import { v } from "convex/values";

// The four kinds of mirrored record. Everything a remote service chose
// (names, subjects, titles) lives inside one of these and nowhere else.
const person = v.object({ name: v.string(), address: v.string() });

export const mirrorSourceValidator = v.union(
  v.literal("gmail"),
  v.literal("google_calendar"),
  v.literal("linear"),
  v.literal("fireflies"),
);

export const recordValidator = v.union(
  // A thread waiting on the owner. No body, no snippet.
  v.object({
    kind: v.literal("mail"),
    threadId: v.string(),
    fromName: v.string(),
    fromAddress: v.string(),
    subject: v.string(),
    lastMessageAt: v.number(),
  }),
  // A meeting. No description, no location, no meeting link.
  v.object({
    kind: v.literal("event"),
    eventId: v.string(),
    title: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    allDay: v.boolean(),
    // All-day events only: the calendar's own dates ("YYYY-MM-DD"; end exclusive).
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    attendees: v.array(person),
    attendeeCount: v.number(),
    hasMeetingLink: v.boolean(),
  }),
  v.object({
    kind: v.literal("issue"),
    issueId: v.string(),
    identifier: v.string(),
    title: v.string(),
    url: v.string(),
    stateType: v.union(
      v.literal("backlog"),
      v.literal("unstarted"),
      v.literal("started"),
      v.literal("completed"),
    ),
    stateName: v.string(),
    teamKey: v.string(),
    teamName: v.string(),
    assigneeName: v.string(),
    mine: v.boolean(),
    priority: v.number(),
    dueDate: v.optional(v.string()),
    updatedAt: v.number(),
  }),
  // Meeting notes. Never the transcript.
  v.object({
    kind: v.literal("meeting"),
    meetingId: v.string(),
    title: v.string(),
    heldAt: v.number(),
    durationMinutes: v.number(),
    participants: v.array(person),
    overview: v.string(),
    actionItems: v.array(v.string()),
  }),
);

// ── Shared lists (Apollo) ───────────────────────────────────────────────────
// What a source pushes for the whole team: its sequences, and how many
// contacts and accounts stand at each stage. A name here is a label the team
// gave a sequence or a stage. Nothing about a person has a field.

export const sharedSourceValidator = v.union(v.literal("apollo"), v.literal("github"));
export const sharedKindValidator = v.union(
  v.literal("sequence"),
  v.literal("stage_count"),
  v.literal("repo"),
  v.literal("pull_request"),
);

export const sharedRecordValidator = v.union(
  v.object({
    kind: v.literal("sequence"),
    sequenceId: v.string(),
    name: v.string(),
    active: v.boolean(),
    archived: v.boolean(),
    steps: v.number(),
    // UTC days ("YYYY-MM-DD"). A sequence never used has no `lastUsedAt`.
    createdAt: v.string(),
    lastUsedAt: v.optional(v.string()),
    delivered: v.number(),
    opened: v.number(),
    replied: v.number(),
    bounced: v.number(),
    unsubscribed: v.number(),
    clicked: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("stage_count"),
    entity: v.union(v.literal("contact"), v.literal("account")),
    stage: v.string(),
    count: v.number(),
  }),
  // GitHub's repositories: a repository and its counts, as last read. The
  // whole allow-list: no branch and no person has a field.
  v.object({
    kind: v.literal("repo"),
    /** "org/name": what a later push matches on. */
    repoId: v.string(),
    org: v.string(),
    name: v.string(),
    company: v.union(v.literal("us"), v.literal("kz")),
    /** Pull requests merged in the last finished week before the read. */
    mergedLastWeek: v.number(),
    open: v.number(),
    stuck: v.number(),
    /** The default branch's latest build. */
    main: v.union(
      v.literal("passing"),
      v.literal("failing"),
      v.literal("pending"),
      v.literal("none"),
    ),
    /** The UTC day code last landed ("YYYY-MM-DD"). */
    pushedAt: v.string(),
  }),
  // GitHub's other list: one pull request, open or lately merged or closed.
  // The owner asked for these by name: its title and who opened it are
  // stored, for the Engineering page. Still metadata only: no description, no
  // comment, no file, no branch, no commit message, no diff.
  v.object({
    kind: v.literal("pull_request"),
    /** "org/name" of its repository. */
    repoId: v.string(),
    number: v.number(),
    company: v.union(v.literal("us"), v.literal("kz")),
    title: v.string(),
    /** `https://github.com/<repoId>/pull/<number>` and nothing else: the one link rendered. */
    url: v.string(),
    /** Absent for a deleted account. */
    authorLogin: v.optional(v.string()),
    authorName: v.optional(v.string()),
    draft: v.boolean(),
    state: v.union(v.literal("open"), v.literal("merged"), v.literal("closed")),
    createdAt: v.number(),
    updatedAt: v.number(),
    mergedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    reviewDecision: v.union(
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("review_required"),
      v.literal("none"),
    ),
    /** When its newest submitted review was submitted. */
    lastReviewAt: v.optional(v.number()),
    /** How many reviewers are asked, people and teams together. */
    reviewersRequested: v.number(),
    /** The logins of the people asked, five at most. */
    reviewers: v.array(v.string()),
    /** The head commit's checks. */
    checks: v.union(
      v.literal("passing"),
      v.literal("failing"),
      v.literal("pending"),
      v.literal("none"),
    ),
  }),
);

/** Everything `mirrorRecords` may hold: a work tool's records, or a shared list's. */
export const storedSourceValidator = v.union(mirrorSourceValidator, sharedSourceValidator);
export const storedRecordValidator = v.union(recordValidator, sharedRecordValidator);
