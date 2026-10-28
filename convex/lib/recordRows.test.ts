import { describe, expect, test } from "vitest";
import { CAPS, MAX_MIRROR_ROWS, MIRROR_SOURCES, type MirrorSource } from "./mirrorRules";
import { EMPTY_IS_AN_ANSWER, MAX_PUSHED_TEXT, parsePushedRecords } from "./recordRows";

// Every name, address, subject and title here is made up. A value that must
// never be echoed carries the word SECRET, so one assertion proves a surface clean.
const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;

const mail = (over: Record<string, unknown> = {}) => ({
  threadId: "18c2f0a1b2c3d4e5",
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: "Made-up subject",
  lastMessageAt: "2026-10-11T15:04:05Z",
  ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  eventId: "evt_made_up_1",
  title: "Made-up meeting",
  startsAt: "2026-10-13T09:00:00Z",
  endsAt: "2026-10-13T09:30:00Z",
  attendees: [{ name: "Ada Example", address: "ada@example-fund.test" }],
  hasMeetingLink: true,
  ...over,
});
const issue = (over: Record<string, unknown> = {}) => ({
  issueId: "0a1b2c3d-made-up",
  identifier: "ENG-1",
  title: "Made-up title",
  url: "https://linear.app/startup/issue/ENG-1/made-up-title",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "Ada Example",
  mine: true,
  priority: 2,
  dueDate: "2026-10-20",
  updatedAt: "2026-10-12T05:00:00Z",
  ...over,
});
const meeting = (over: Record<string, unknown> = {}) => ({
  meetingId: "ff_made_up_1",
  title: "Made-up call",
  heldAt: "2026-10-10T16:00:00Z",
  durationMinutes: 29.6,
  participants: [{ name: "Ada Example", address: "ada@example-fund.test" }],
  overview: "A made-up summary.",
  actionItems: ["A made-up action item"],
  ...over,
});
const GOOD: Record<MirrorSource, () => Record<string, unknown>> = {
  gmail: mail,
  google_calendar: event,
  linear: issue,
  fireflies: meeting,
};

const parse = (source: MirrorSource, rows: unknown[], empty = false) =>
  parsePushedRecords(source, rows, { empty, now: NOW });
const rowsOf = (source: MirrorSource, rows: unknown[]) => {
  const result = parse(source, rows);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.issues)}`);
  return result.rows;
};
const issuesOf = (source: MirrorSource, rows: unknown[], empty = false) => {
  const result = parse(source, rows, empty);
  return result.ok ? [] : result.issues;
};

describe("parsePushedRecords: what each kind becomes", () => {
  test("mail", () => {
    expect(rowsOf("gmail", [mail()])).toEqual([
      {
        kind: "mail",
        threadId: "18c2f0a1b2c3d4e5",
        fromName: "Ada Example",
        fromAddress: "ada@example-fund.test",
        subject: "Made-up subject",
        lastMessageAt: Date.UTC(2026, 9, 11, 15, 4, 5),
      },
    ]);
  });

  test("mail with only what is required: no name, and a subject that says there is none", () => {
    const { fromName: _n, subject: _s, ...bare } = mail();
    expect(rowsOf("gmail", [bare])[0]).toMatchObject({ fromName: "", subject: "(no subject)" });
  });

  test("a timed event; a time with an offset is the same instant", () => {
    expect(
      rowsOf("google_calendar", [
        event({ startsAt: "2026-10-13T14:00:00+05:00", endsAt: "2026-10-13T14:30:00+05:00" }),
      ]),
    ).toEqual([
      {
        kind: "event",
        eventId: "evt_made_up_1",
        title: "Made-up meeting",
        startsAt: Date.UTC(2026, 9, 13, 9),
        endsAt: Date.UTC(2026, 9, 13, 9, 30),
        allDay: false,
        attendees: [{ name: "Ada Example", address: "ada@example-fund.test" }],
        attendeeCount: 1,
        hasMeetingLink: true,
      },
    ]);
  });

  test("an all-day event keeps the calendar's own dates", () => {
    const { startsAt: _a, endsAt: _b, ...rest } = event();
    expect(
      rowsOf("google_calendar", [{ ...rest, startDate: "2026-10-14", endDate: "2026-10-15" }])[0],
    ).toMatchObject({
      allDay: true,
      startDate: "2026-10-14",
      endDate: "2026-10-15",
      startsAt: Date.UTC(2026, 9, 14),
      endsAt: Date.UTC(2026, 9, 15),
    });
  });

  test("a private event is Busy, with nobody on it", () => {
    const row = {
      eventId: "evt_private",
      private: true,
      startsAt: "2026-10-13T09:00:00Z",
      endsAt: "2026-10-13T10:00:00Z",
    };
    expect(rowsOf("google_calendar", [row])[0]).toMatchObject({
      title: "Busy",
      attendees: [],
      attendeeCount: 0,
      hasMeetingLink: false,
    });
  });

  test("an attendee count may be larger than the list, never smaller", () => {
    expect(rowsOf("google_calendar", [event({ attendeeCount: 40 })])[0]).toMatchObject({
      attendeeCount: 40,
    });
    expect(issuesOf("google_calendar", [event({ attendeeCount: 0 })])).toEqual([
      { path: "records.0.attendeeCount", message: "is fewer than the attendees listed" },
    ]);
  });

  test("an issue", () => {
    expect(rowsOf("linear", [issue()])).toEqual([
      {
        kind: "issue",
        issueId: "0a1b2c3d-made-up",
        identifier: "ENG-1",
        title: "Made-up title",
        url: "https://linear.app/startup/issue/ENG-1/made-up-title",
        stateType: "started",
        stateName: "In Progress",
        teamKey: "ENG",
        teamName: "Engineering",
        assigneeName: "Ada Example",
        mine: true,
        priority: 2,
        dueDate: "2026-10-20",
        updatedAt: Date.UTC(2026, 9, 12, 5),
      },
    ]);
  });

  test("an issue with only what is required", () => {
    const bare = {
      issueId: "i-2",
      identifier: "ENG-2",
      stateType: "backlog",
      mine: false,
      updatedAt: "2026-10-12T05:00:00Z",
    };
    expect(rowsOf("linear", [bare])[0]).toMatchObject({
      title: "(no title)",
      url: "",
      assigneeName: "",
      priority: 0,
    });
  });

  test("meeting notes; minutes are rounded", () => {
    expect(rowsOf("fireflies", [meeting()])).toEqual([
      {
        kind: "meeting",
        meetingId: "ff_made_up_1",
        title: "Made-up call",
        heldAt: Date.UTC(2026, 9, 10, 16),
        durationMinutes: 30,
        participants: [{ name: "Ada Example", address: "ada@example-fund.test" }],
        overview: "A made-up summary.",
        actionItems: ["A made-up action item"],
      },
    ]);
  });
});

describe("parsePushedRecords: the same cleaning as a read made here", () => {
  test("control characters and direction overrides are cleaned out of text", () => {
    const [row] = rowsOf("gmail", [
      mail({ subject: "Paid‮gnp.exe\u0007 now\r\nBcc: x", fromName: "  Ada⁦  Example " }),
    ]);
    expect(row).toMatchObject({ subject: "Paid gnp.exe now Bcc: x", fromName: "Ada Example" });
    expect(JSON.stringify(row)).not.toMatch(/[\u0000-\u001f‪-‮⁦-⁩]/);
  });

  test("text over its cap is cut, as a pulled read cuts it", () => {
    const [row] = rowsOf("gmail", [mail({ subject: "s".repeat(300) })]);
    expect((row as { subject: string }).subject).toHaveLength(CAPS.title);
    expect((row as { subject: string }).subject.endsWith("…")).toBe(true);
  });

  test("an address is lower-cased; one that is not an address refuses the row", () => {
    expect(rowsOf("gmail", [mail({ fromAddress: " Ada@Example-Fund.TEST " })])[0]).toMatchObject({
      fromAddress: "ada@example-fund.test",
    });
    expect(issuesOf("gmail", [mail({ fromAddress: "SECRET not an address" })])).toEqual([
      { path: "records.0.fromAddress", message: "is not an email address" },
    ]);
  });

  test("a person with neither a name nor a usable address is dropped, like a pulled one", () => {
    const [row] = rowsOf("fireflies", [
      meeting({ participants: [{ name: "Ada Example" }, { address: "not-an-address" }, {}] }),
    ]);
    expect((row as { participants: unknown[] }).participants).toEqual([
      { name: "Ada Example", address: "" },
    ]);
  });

  test("blank action items are dropped", () => {
    const [row] = rowsOf("fireflies", [meeting({ actionItems: ["  ", "Send\u0000 the deck"] })]);
    expect((row as { actionItems: string[] }).actionItems).toEqual(["Send the deck"]);
  });
});

describe("parsePushedRecords: what is refused", () => {
  test.each([
    ["gmail", "body"],
    ["gmail", "snippet"],
    ["google_calendar", "description"],
    ["google_calendar", "location"],
    ["linear", "description"],
    ["fireflies", "transcript"],
    ["fireflies", "SECRET clinic"],
  ] as const)("%s: a %s field refuses the push, and its name is not echoed", (source, field) => {
    const issues = issuesOf(source, [{ ...GOOD[source](), [field]: "SECRET text" }]);
    expect(issues).toEqual([{ path: "records.0", message: "has a field the OS does not accept" }]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
    expect(JSON.stringify(issues)).not.toContain(field);
  });

  test("an unknown field on a person is refused too", () => {
    expect(
      issuesOf("google_calendar", [event({ attendees: [{ name: "Ada", phone: "SECRET" }] })]),
    ).toEqual([{ path: "records.0.attendees.0", message: "has a field the OS does not accept" }]);
  });

  test("a row of another kind does not fit: the token's source decides the shape", () => {
    const issues = issuesOf("linear", [mail()]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.path.startsWith("records.0"))).toBe(true);
    expect(JSON.stringify(issues)).not.toContain("Ada");
  });

  test("a row that is not an object", () => {
    expect(issuesOf("gmail", ["SECRET"])).toEqual([
      { path: "records.0", message: "is missing or of the wrong type" },
    ]);
  });

  test("a missing required field, and a time that is not one", () => {
    const { fromAddress: _a, ...noAddress } = mail();
    expect(issuesOf("gmail", [noAddress, mail({ lastMessageAt: "SECRET yesterday" })])).toEqual([
      { path: "records.0.fromAddress", message: "is missing or of the wrong type" },
      { path: "records.1.lastMessageAt", message: "is not in the expected form" },
    ]);
  });

  test("a time as a number is refused: times travel as ISO text", () => {
    expect(issuesOf("gmail", [mail({ lastMessageAt: NOW })])).toEqual([
      { path: "records.0.lastMessageAt", message: "is missing or of the wrong type" },
    ]);
  });

  test("a mail id that is not Gmail's is refused: it goes into a link", () => {
    expect(issuesOf("gmail", [mail({ threadId: "abc/../SECRET" })])).toEqual([
      { path: "records.0.threadId", message: "is not a Gmail thread id" },
    ]);
  });

  test("an id with a space, a control character or a direction override is refused", () => {
    for (const eventId of ["evt 1", "evt\u00001", "evt‮1", ""]) {
      const issues = issuesOf("google_calendar", [event({ eventId })]);
      expect(issues.length, JSON.stringify(eventId)).toBeGreaterThan(0);
      expect(new Set(issues.map((i) => i.path))).toEqual(new Set(["records.0.eventId"]));
    }
  });

  test("an id that repeats an earlier one", () => {
    expect(issuesOf("linear", [issue(), issue({ title: "Another" })])).toEqual([
      { path: "records.1.issueId", message: "repeats the id of an earlier record" },
    ]);
  });

  test("oversize: text past the hard limit, an id past its cap, too many people or items", () => {
    expect(issuesOf("gmail", [mail({ subject: "s".repeat(MAX_PUSHED_TEXT + 1) })])).toEqual([
      { path: "records.0.subject", message: "is too long or too large" },
    ]);
    expect(issuesOf("google_calendar", [event({ eventId: "e".repeat(CAPS.id + 1) })])).toEqual([
      { path: "records.0.eventId", message: "is too long or too large" },
    ]);
    const crowd = Array.from({ length: CAPS.people + 1 }, (_, i) => ({ name: `Guest ${i}` }));
    expect(issuesOf("google_calendar", [event({ attendees: crowd })])).toEqual([
      { path: "records.0.attendees", message: "is too long or too large" },
    ]);
    const items = Array.from({ length: CAPS.actionItems + 1 }, (_, i) => `Item ${i}`);
    expect(issuesOf("fireflies", [meeting({ actionItems: items })])).toEqual([
      { path: "records.0.actionItems", message: "is too long or too large" },
    ]);
  });

  test("oversize: more records than one push may hold", () => {
    const many = Array.from({ length: MAX_MIRROR_ROWS + 1 }, (_, i) =>
      mail({ threadId: i.toString(16) }),
    );
    expect(issuesOf("gmail", many)).toEqual([
      { path: "records", message: `At most ${MAX_MIRROR_ROWS} records in one push.` },
    ]);
  });

  test("an event needs one pair of times, not both and not half of each", () => {
    const words = "Send startsAt and endsAt, or startDate and endDate for an all-day event.";
    const { startsAt: _a, endsAt: _b, ...untimed } = event();
    for (const row of [
      untimed,
      event({ startDate: "2026-10-13", endDate: "2026-10-14" }),
      { ...untimed, startsAt: "2026-10-13T09:00:00Z", endDate: "2026-10-14" },
      event({ startDate: "2026-10-13" }),
    ]) {
      expect(issuesOf("google_calendar", [row])).toContainEqual({
        path: "records.0.startsAt",
        message: words,
      });
    }
  });

  test("an event that ends before it starts, and a date that is not one", () => {
    expect(
      issuesOf("google_calendar", [event({ endsAt: "2026-10-13T08:00:00Z" })]),
    ).toEqual([{ path: "records.0.endsAt", message: "is before the start" }]);
    const { startsAt: _a, endsAt: _b, ...untimed } = event();
    expect(
      issuesOf("google_calendar", [{ ...untimed, startDate: "2026-02-30", endDate: "2026-03-01" }]),
    ).toContainEqual({ path: "records.0.startDate", message: "is not a real date (YYYY-MM-DD)" });
  });

  test("a private event that carries its title or its guests is refused, not trimmed", () => {
    const issues = issuesOf("google_calendar", [event({ private: true, title: "SECRET review" })]);
    expect(issues).toEqual([
      { path: "records.0.title", message: "A private event carries no title and no attendees." },
      { path: "records.0.attendees", message: "A private event carries no title and no attendees." },
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  test("an issue's link must be Linear's, its priority 0 to 4, its state one the board knows", () => {
    expect(issuesOf("linear", [issue({ url: "https://evil.test/SECRET" })])).toEqual([
      { path: "records.0.url", message: "is not a linear.app link" },
    ]);
    expect(issuesOf("linear", [issue({ priority: 7 })])).toEqual([
      { path: "records.0.priority", message: "is too long or too large" },
    ]);
    expect(issuesOf("linear", [issue({ stateType: "triage" })])).toEqual([
      { path: "records.0.stateType", message: "is not one of the allowed values" },
    ]);
    expect(issuesOf("linear", [issue({ dueDate: "2026-13-01" })])).toEqual([
      { path: "records.0.dueDate", message: "is not a real date (YYYY-MM-DD)" },
    ]);
  });

  test("meeting notes older than they are kept are refused", () => {
    const old = new Date(NOW - 91 * DAY).toISOString();
    expect(issuesOf("fireflies", [meeting({ heldAt: old })])).toEqual([
      { path: "records.0.heldAt", message: "is older than the 90 days meeting notes are kept" },
    ]);
    expect(issuesOf("fireflies", [meeting({ heldAt: new Date(NOW - 89 * DAY).toISOString() })])).toEqual([]);
  });

  test("a time that is no time at all fails the shared refusal, in counts", () => {
    expect(issuesOf("gmail", [mail({ lastMessageAt: "1999-01-01T00:00:00Z" })])).toEqual([
      {
        path: "records",
        message: "1 of 1 records broke the size and shape rules, so nothing was written.",
      },
    ]);
  });

  test("one bad row refuses every row", () => {
    expect(parse("gmail", [mail(), mail({ threadId: "zz" })]).ok).toBe(false);
  });

  test("a reply lists at most fifty issues", () => {
    const bad = Array.from({ length: 80 }, () => "x");
    expect(issuesOf("gmail", bad)).toHaveLength(50);
  });
});

describe("parsePushedRecords: an empty push", () => {
  test("only Gmail and Calendar have an empty answer", () => {
    expect(EMPTY_IS_AN_ANSWER).toEqual({
      gmail: true,
      google_calendar: true,
      linear: false,
      fireflies: false,
    });
  });

  test.each(MIRROR_SOURCES)("%s: an empty list without `empty` is a failed read", (source) => {
    expect(issuesOf(source, [])).toEqual([
      {
        path: "records",
        message:
          'An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
      },
    ]);
  });

  test.each(["gmail", "google_calendar"] as const)("%s: said to be empty, it is", (source) => {
    expect(parse(source, [], true)).toEqual({ ok: true, rows: [] });
  });

  test.each(["linear", "fireflies"] as const)("%s: never, even when said", (source) => {
    expect(issuesOf(source, [], true)).toEqual([
      {
        path: "empty",
        message: "An empty push is never accepted from this source: nothing there is a failed read.",
      },
    ]);
  });
});
