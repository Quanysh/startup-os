import { describe, expect, test } from "vitest";
import { ada, allDay, bo, event, me, page, room } from "./calendar.fixtures";
import { parseEvents } from "./calendarParse";
import { ConnectorError } from "./errors";

const one = (item: unknown) => parseEvents(page([item])).rows;

/** What was thrown, so its class and its message can both be checked. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a throw.");
}

const LIST_SHAPE = "Google Calendar's events were not in the expected shape.";
const EVENT_SHAPE = "A calendar event was not in the expected shape.";

describe("parseEvents: what is kept", () => {
  test("a timed meeting", () => {
    expect(one(event())).toEqual([
      {
        kind: "event",
        eventId: "evt1",
        title: "Made-up meeting",
        startsAt: Date.UTC(2026, 9, 12, 15, 0),
        endsAt: Date.UTC(2026, 9, 12, 15, 30),
        allDay: false,
        attendees: [{ name: "Ada Example", address: "ada@example-fund.test" }],
        attendeeCount: 1,
        hasMeetingLink: false,
      },
    ]);
  });

  test("stores no description, location or link, even when Calendar sends them", () => {
    const [row] = one(
      event({
        description: "REMOTE-DESCRIPTION",
        location: "REMOTE-LOCATION",
        hangoutLink: "https://meet.example.test/REMOTE-LINK",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.example.test/REMOTE-LINK" }],
        },
      }),
    );
    expect(JSON.stringify(row)).not.toContain("REMOTE-");
    expect(row?.hasMeetingLink).toBe(true);
  });

  test.each([
    ["+05:00", "2026-10-12T20:00:00+05:00", Date.UTC(2026, 9, 12, 15, 0)],
    ["-08:00", "2026-10-12T07:00:00-08:00", Date.UTC(2026, 9, 12, 15, 0)],
    ["Z", "2026-10-12T15:00:00Z", Date.UTC(2026, 9, 12, 15, 0)],
  ])("a start with a %s offset is the right instant", (_name, dateTime, at) => {
    const [row] = one(event({ start: { dateTime }, end: { dateTime: "2026-10-12T16:00:00Z" } }));
    expect(row?.startsAt).toBe(at);
  });

  test("an all-day event keeps the calendar's own dates, end exclusive", () => {
    expect(one(allDay())).toEqual([
      {
        kind: "event",
        eventId: "day1",
        title: "Made-up offsite",
        startsAt: Date.UTC(2026, 9, 14),
        endsAt: Date.UTC(2026, 9, 16),
        allDay: true,
        startDate: "2026-10-14",
        endDate: "2026-10-16",
        attendees: [],
        attendeeCount: 0,
        hasMeetingLink: false,
      },
    ]);
  });

  test.each([["tentative", { status: "tentative" }], ["not yet answered", { attendees: [me("needsAction"), ada] }], ["tentatively accepted", { attendees: [me("tentative"), ada] }]])(
    "a meeting that is %s is kept",
    (_name, over) => {
      expect(one(event(over))).toHaveLength(1);
    },
  );

  test("eventType default is a meeting", () => {
    expect(one(event({ eventType: "default" }))).toHaveLength(1);
  });

  test("no summary", () => {
    expect(one(event({ summary: undefined }))[0]?.title).toBe("(no title)");
    expect(one(event({ summary: "  " }))[0]?.title).toBe("(no title)");
  });

  test("a long title with a line break is one line of 200 characters", () => {
    const title = one(event({ summary: `Made-up\n${"x".repeat(900)}` }))[0]?.title ?? "";
    expect(title).toHaveLength(200);
    expect(title).not.toContain("\n");
  });

  test("attendees: the owner's own entry and rooms are left out", () => {
    const [row] = one(event({ attendees: [me(), ada, bo, room] }));
    expect(row?.attendees).toEqual([
      { name: "Ada Example", address: "ada@example-fund.test" },
      { name: "", address: "bo@clinic.test" },
    ]);
    expect(row?.attendeeCount).toBe(2);
  });

  test("attendees: the first 30 are stored and the count is the full one", () => {
    const many = Array.from({ length: 45 }, (_, n) => ({ email: `person-${n}@example.test` }));
    const [row] = one(event({ attendees: [me(), ...many] }));
    expect(row?.attendees).toHaveLength(30);
    expect(row?.attendeeCount).toBe(45);
  });

  test("an attendee with neither a name nor an address is not counted", () => {
    const [row] = one(event({ attendees: [me(), { email: "not an address" }, ada] }));
    expect(row?.attendees).toHaveLength(1);
    expect(row?.attendeeCount).toBe(1);
  });

  test.each([["private"], ["confidential"]])(
    "a %s event is kept as Busy: its title and its attendees are not stored",
    (visibility) => {
      const [row] = one(
        event({ visibility, summary: "REMOTE-PRIVATE-TITLE", attendees: [me(), ada, bo] }),
      );
      expect(row).toMatchObject({
        title: "Busy",
        attendees: [],
        attendeeCount: 0,
        startsAt: Date.UTC(2026, 9, 12, 15, 0),
      });
      const stored = JSON.stringify(row);
      expect(stored).not.toContain("REMOTE-PRIVATE-TITLE");
      expect(stored).not.toContain("example-fund");
      expect(stored).not.toContain("Ada");
    },
  );

  test.each([["default"], ["public"]])("a %s event keeps its title", (visibility) => {
    expect(one(event({ visibility }))[0]?.title).toBe("Made-up meeting");
  });

  test("a meeting link is noted, never stored", () => {
    expect(one(event({ conferenceData: { entryPoints: [{ entryPointType: "video" }] } }))[0]?.hasMeetingLink).toBe(true);
    expect(one(event({ conferenceData: { entryPoints: [] } }))[0]?.hasMeetingLink).toBe(false);
    expect(one(event({ conferenceData: {} }))[0]?.hasMeetingLink).toBe(false);
  });
});

describe("parseEvents: what is dropped", () => {
  test.each([
    ["cancelled", { status: "cancelled" }],
    ["declined by the owner", { attendees: [me("declined"), ada] }],
    ["focus time", { eventType: "focusTime" }],
    ["out of office", { eventType: "outOfOffice" }],
    ["a working location", { eventType: "workingLocation" }],
    ["a birthday", { eventType: "birthday" }],
    ["made from an email", { eventType: "fromGmail" }],
    ["of a type this build has never heard of", { eventType: "somethingNew" }],
  ])("an event that is %s", (_name, over) => {
    expect(one(event(over))).toEqual([]);
  });

  test("someone else declining does not drop the meeting", () => {
    expect(one(event({ attendees: [me(), { ...ada, responseStatus: "declined" }] }))).toHaveLength(1);
  });

  test("a cancelled instance needs no id or times to be dropped", () => {
    expect(one({ status: "cancelled" })).toEqual([]);
  });
});

describe("parseEvents: what fails the read", () => {
  test.each([
    ["no id", { id: undefined }],
    ["an empty id", { id: "" }],
    ["no start", { start: undefined }],
    ["no end", { end: undefined }],
    ["a start that is neither a date nor a time", { start: {} }],
    ["a time that cannot be read", { start: { dateTime: "soon" } }],
    ["a date that is not a day", { start: { date: "2026-13-45" }, end: { date: "2026-13-46" } }],
    ["a date in another format", { start: { date: "14/10/2026" }, end: { date: "16/10/2026" } }],
    ["a date start with a timed end", { start: { date: "2026-10-14" }, end: { dateTime: "2026-10-14T10:00:00Z" } }],
  ])("an event with %s: a silently dropped meeting is worse than a failed read", (_name, over) => {
    const error = thrown(() => one(event(over)));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(EVENT_SHAPE);
  });

  test("an item that is not an object", () => {
    expect(thrown(() => one("x")).message).toBe(EVENT_SHAPE);
  });

  test.each([
    ["null", null],
    ["a list", []],
    ["another kind", { kind: "calendar#calendarList", items: [] }],
    ["no kind", { items: [] }],
    ["items that is not a list", { kind: "calendar#events", items: "x" }],
  ])("%s is not a list of events", (_name, json) => {
    const error = thrown(() => parseEvents(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(LIST_SHAPE);
  });

  test("no thrown message contains anything Calendar sent", () => {
    const error = thrown(() => one(event({ summary: "REMOTE-TITLE", start: { dateTime: "REMOTE-TIME" } })));
    expect(error.message).toBe(EVENT_SHAPE);
    expect(error.message).not.toContain("REMOTE");
  });
});

describe("parseEvents: pages", () => {
  test("a week with nothing in it", () => {
    expect(parseEvents(page([]))).toEqual({ rows: [], next: null });
    expect(parseEvents({ kind: "calendar#events" })).toEqual({ rows: [], next: null });
  });

  test("the next page's token, when there is one", () => {
    expect(parseEvents(page([event()], "p2")).next).toBe("p2");
    expect(parseEvents(page([event()])).next).toBeNull();
    expect(parseEvents({ ...page([]), nextPageToken: "" }).next).toBeNull();
  });
});
