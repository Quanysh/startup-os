import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { seal } from "../lib/tokenCrypto";
import schema from "../schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "../test.setup";
import { ada, allDay, event, me, page, stubCalendar, type CalendarCall } from "./calendar.fixtures";

// Nothing here is real: no client, no key, no token, no calendar.
const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;
const REFRESH = "fake-refresh-token-not-real-0001";
const SECRET = "fake-client-secret-not-real";
const KEY = btoa("0123456789abcdef0123456789abcdef");

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("GOOGLE_WORK_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GOOGLE_WORK_CLIENT_SECRET", SECRET);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connected() {
  const t = convexTest(schema, modules);
  const sealed = await seal(REFRESH, "google-refresh-token");
  await t.run((ctx) =>
    ctx.db.insert("oauthConnections", {
      provider: "google",
      sealedRefreshToken: sealed,
      connectedAt: NOW - 1000,
    }),
  );
  return t;
}

const sync = (t: TestBackend) => t.action(internal.connectors.googleCalendar.sync, {});
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "google_calendar"))
      .unique(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const records = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const storedIds = async (t: TestBackend) => (await records(t)).map((doc) => doc.externalId).sort();
const calendarCalls = (calls: CalendarCall[]) =>
  calls.filter((c) => c.url.host === "www.googleapis.com");

const WEEK = [
  event({ id: "evt1" }),
  event({
    id: "evt2",
    summary: "Another made-up meeting",
    start: { dateTime: "2026-10-13T09:00:00+05:00" },
    end: { dateTime: "2026-10-13T10:00:00+05:00" },
    attendees: [me(), ada, { email: "bo@clinic.test", displayName: "Bo Example" }],
  }),
  allDay(),
  event({ id: "gone", status: "cancelled" }),
];

async function withStoredEvents(t: TestBackend) {
  stubCalendar({ pages: [page(WEEK)] });
  expect(await sync(t)).toBe("ok");
  const before = await records(t);
  expect(before).toHaveLength(3);
  return before;
}

describe("googleCalendar.sync", () => {
  test("not connected: a setup step, and Calendar is never asked", async () => {
    const calls = stubCalendar({ pages: [page(WEEK)] });
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Connect Google under Settings → Work tools.",
    });
    expect(await runs(t)).toEqual([]);
  });

  test("stores the week's meetings, asking for no description, location or link", async () => {
    const calls = stubCalendar({ pages: [page(WEEK)] });
    const t = await connected();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["day1", "evt1", "evt2"]);
    expect(await runs(t)).toMatchObject([
      { source: "google_calendar", status: "ok", inserted: 3, startedAt: NOW },
    ]);

    const owner = await signInAsOwner(t);
    const { events } = await owner.query(api.workTools.events, { from: NOW, to: NOW + 8 * DAY });
    expect(events.map((e) => [e.eventId, e.title, e.attendeeCount])).toEqual([
      ["evt1", "Made-up meeting", 1],
      ["evt2", "Another made-up meeting", 2],
      ["day1", "Made-up offsite", 0],
    ]);

    expect(calls[0]?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    const asked = calendarCalls(calls);
    expect(asked).toHaveLength(1);
    const [list] = asked;
    expect(list?.method).toBe("GET");
    expect(list?.authorization).toBe("Bearer fake-access-token");
    expect(list?.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(list?.url.searchParams.get("singleEvents")).toBe("true");
    expect(list?.url.searchParams.get("orderBy")).toBe("startTime");
    expect(list?.url.searchParams.get("maxResults")).toBe("250");
    const fields = list?.url.searchParams.get("fields") ?? "";
    expect(fields).toBe(
      "kind,nextPageToken,items(id,status,summary,visibility,eventType,start,end,attendees(email,displayName,responseStatus,self,resource),conferenceData/entryPoints/entryPointType)",
    );
    for (const never of ["description", "location", "hangoutLink", "uri", "htmlLink", "attachments"]) {
      expect(fields).not.toContain(never);
    }
    const sent = `${list?.url.href} ${list?.body} ${list?.authorization}`;
    expect(sent).not.toContain(REFRESH);
    expect(sent).not.toContain(SECRET);
  });

  test("asks for yesterday to nine days ahead, from the run's own clock", async () => {
    const calls = stubCalendar({ pages: [page(WEEK)] });
    const t = await connected();
    await sync(t);
    const [list] = calendarCalls(calls);
    expect(list?.url.searchParams.get("timeMin")).toBe(new Date(NOW - DAY).toISOString());
    expect(list?.url.searchParams.get("timeMax")).toBe(new Date(NOW + 9 * DAY).toISOString());
    expect(list?.url.searchParams.get("timeMin")).toBe("2026-10-11T06:00:00.000Z");
    expect(list?.url.searchParams.get("timeMax")).toBe("2026-10-21T06:00:00.000Z");
  });

  test("an empty week is a real answer: the run is ok and stored meetings are removed", async () => {
    const t = await connected();
    await withStoredEvents(t);
    stubCalendar({ pages: [page([])] });
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual([]);
    expect(await status(t)).toMatchObject({ state: "ok", lastOkAt: NOW });
  });

  test("a meeting that was cancelled is gone at the next read", async () => {
    const t = await connected();
    await withStoredEvents(t);
    stubCalendar({ pages: [page([event({ id: "evt1" }), event({ id: "evt2", status: "cancelled" })])] });
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["evt1"]);
  });

  test("a 500 twice is an error, and stored meetings are untouched", async () => {
    const t = await connected();
    const before = await withStoredEvents(t);
    const calls = stubCalendar({ pages: [{ status: 500, body: { error: "REMOTE-TEXT" } }] });
    expect(await sync(t)).toBe("error");
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Google Calendar answered 500 for events.",
    });
    expect(await records(t)).toEqual(before);
    expect(calendarCalls(calls)).toHaveLength(2);
  });

  test("a failing second page leaves stored meetings untouched: half a week is never applied", async () => {
    const t = await connected();
    const before = await withStoredEvents(t);
    const calls = stubCalendar({
      pages: [page([event({ id: "new1" })], "p2"), { status: 403, body: {} }],
    });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Google Calendar answered 403 for events.");
    expect(await records(t)).toEqual(before);
    expect(calendarCalls(calls)[1]?.url.searchParams.get("pageToken")).toBe("p2");
  });

  test("a meeting repeated across two pages is stored once", async () => {
    const calls = stubCalendar({
      pages: [
        page([event({ id: "evt1" }), event({ id: "evt2" })], "p2"),
        page([event({ id: "evt2" }), event({ id: "evt3" })]),
      ],
    });
    const t = await connected();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["evt1", "evt2", "evt3"]);
    expect(calendarCalls(calls)).toHaveLength(2);
    // The second page keeps the same window and field list.
    const [first, second] = calendarCalls(calls);
    expect(second?.url.searchParams.get("fields")).toBe(first?.url.searchParams.get("fields"));
    expect(second?.url.searchParams.get("timeMin")).toBe(first?.url.searchParams.get("timeMin"));
  });

  test("more than five pages fails the read rather than showing part of the calendar", async () => {
    const t = await connected();
    const before = await withStoredEvents(t);
    const calls = stubCalendar({
      pages: [1, 2, 3, 4, 5, 6].map((n) => page([event({ id: `evt${n}` })], `p${n + 1}`)),
    });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("The calendar has more than 1,250 events in ten days.");
    expect(calendarCalls(calls)).toHaveLength(5);
    expect(await records(t)).toEqual(before);
  });

  test("an event that is not in the expected shape fails the read", async () => {
    const t = await connected();
    const before = await withStoredEvents(t);
    stubCalendar({ pages: [page([event({ id: "evt1" }), event({ id: "evt9", start: {} })])] });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("A calendar event was not in the expected shape.");
    expect(await records(t)).toEqual(before);
  });

  test("a grant that has died at Google takes the stored meetings with it", async () => {
    const t = await connected();
    await withStoredEvents(t);
    const calls = stubCalendar({
      token: { status: 400, body: { error: "invalid_grant" } },
      pages: [page(WEEK)],
    });
    expect(await sync(t)).toBe("not_configured");
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Google access was removed. Connect Google again.",
    });
    expect((await status(t))?.lastOkAt).toBeUndefined();
    expect(calendarCalls(calls)).toEqual([]);
    expect(await records(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("oauthConnections").collect())).toEqual([]);
  });

  test("switched off: nothing is fetched at all, not even the token", async () => {
    const t = await connected();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "google_calendar" });
    const calls = stubCalendar({ pages: [page(WEEK)] });
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
  });

  test("nothing personal is logged: runs, status and the console hold counts and our own words", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(JSON.stringify(args)));
    }
    const t = await connected();
    await withStoredEvents(t);
    stubCalendar({ pages: [page([event({ id: "evt9", summary: "REMOTE-TITLE", start: {} })])] });
    expect(await sync(t)).toBe("error");

    const logged = JSON.stringify([await runs(t), await status(t)]) + lines.join("\n");
    for (const personal of [
      "Ada",
      "Bo Example",
      "example-fund",
      "clinic.test",
      "Made-up meeting",
      "Made-up offsite",
      "REMOTE-TITLE",
      "evt1",
      REFRESH,
      "fake-access-token",
      SECRET,
      KEY,
    ]) {
      expect(logged).not.toContain(personal);
    }
  });
});
