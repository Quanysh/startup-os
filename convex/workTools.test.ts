import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { MirrorRecord, MirrorSource, RecordOf } from "./lib/mirrorRules";
import { keyOf } from "./lib/mirrorRules";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAs,
  signInAsEngineer,
  signInAsOwner,
  type TestBackend,
} from "./test.setup";

// Every name, address, subject and title here is made up.
const NOW = Date.UTC(2026, 9, 12, 6);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const mail = (threadId: string, over: Partial<RecordOf<"mail">> = {}): RecordOf<"mail"> => ({
  kind: "mail",
  threadId,
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: "Made-up subject",
  lastMessageAt: NOW - HOUR,
  ...over,
});

const event = (eventId: string, startsAt: number, endsAt: number): RecordOf<"event"> => ({
  kind: "event",
  eventId,
  title: "Made-up meeting",
  startsAt,
  endsAt,
  allDay: false,
  attendees: [{ name: "Bo Example", address: "bo@clinic.test" }],
  attendeeCount: 1,
  hasMeetingLink: true,
});

const issue = (issueId: string, updatedAt: number): RecordOf<"issue"> => ({
  kind: "issue",
  issueId,
  identifier: `ENG-${issueId}`,
  title: "Made-up title",
  url: "",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "",
  mine: false,
  priority: 0,
  updatedAt,
});

const meeting = (meetingId: string, heldAt: number): RecordOf<"meeting"> => ({
  kind: "meeting",
  meetingId,
  title: "Made-up meeting",
  heldAt,
  durationMinutes: 30,
  participants: [],
  overview: "A made-up summary.",
  actionItems: [],
});

async function seed(t: TestBackend, source: MirrorSource, rows: MirrorRecord[]) {
  await t.run(async (ctx) => {
    for (const record of rows) {
      await ctx.db.insert("mirrorRecords", { source, ...keyOf(record), syncedAt: NOW, record });
    }
  });
}

const setStatus = (
  t: TestBackend,
  source: MirrorSource,
  status: { state: "ok" | "error"; message?: string; lastOkAt?: number },
) =>
  t.run((ctx) => ctx.db.insert("sourceStatus", { source, lastRunAt: NOW, ...status }));

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("access", () => {
  test("a signed-in non-owner is refused by every function", async () => {
    const t = convexTest(schema, modules);
    await seed(t, "gmail", [mail("a1")]);
    const stranger = await signInAs(t, { email: "someone@else.test", emailVerificationTime: 1 });
    // The personal lists are for the Today area, the board's for the board:
    // someone who is not let in at all is refused each as a missing permission.
    await expect(stranger.query(api.workTools.needsReply, {})).rejects.toThrow("not_allowed");
    await expect(stranger.query(api.workTools.events, { from: NOW, to: NOW + DAY })).rejects.toThrow(
      "not_allowed",
    );
    await expect(stranger.query(api.workTools.issues, {})).rejects.toThrow("not_allowed");
    await expect(stranger.query(api.workTools.myIssues, {})).rejects.toThrow("not_allowed");
    await expect(stranger.query(api.workTools.meetings, {})).rejects.toThrow("not_allowed");
    await expect(stranger.query(api.workTools.settings, {})).rejects.toThrow("not_owner");
    await expect(
      stranger.mutation(api.workTools.setDomains, { investor: [], customer: [] }),
    ).rejects.toThrow("not_owner");
    await expect(stranger.mutation(api.workTools.turnOff, { source: "gmail" })).rejects.toThrow(
      "not_owner",
    );
    await expect(stranger.mutation(api.workTools.turnOn, { source: "gmail" })).rejects.toThrow(
      "not_owner",
    );
  });

  test("a visitor with no session is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.workTools.needsReply, {})).rejects.toThrow("not_allowed");
    await expect(t.query(api.workTools.meetings, {})).rejects.toThrow("not_allowed");
    await expect(t.query(api.workTools.settings, {})).rejects.toThrow("not_owner");
  });
});

describe("needsReply", () => {
  test("oldest first, each thread grouped by the owner's lists, regrouped without a sync", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(t, "gmail", [
      mail("newer", { lastMessageAt: NOW - HOUR }),
      mail("older", { lastMessageAt: NOW - 3 * HOUR, fromAddress: "bo@clinic.test" }),
      mail("middle", { lastMessageAt: NOW - 2 * HOUR, fromAddress: "cy@elsewhere.test" }),
    ]);
    const before = await owner.query(api.workTools.needsReply, {});
    expect(before.threads.map((thread) => [thread.threadId, thread.group])).toEqual([
      ["older", "other"],
      ["middle", "other"],
      ["newer", "other"],
    ]);

    await owner.mutation(api.workTools.setDomains, {
      investor: ["example-fund.test"],
      customer: ["clinic.test"],
    });
    const after = await owner.query(api.workTools.needsReply, {});
    expect(after.threads.map((thread) => [thread.threadId, thread.group])).toEqual([
      ["older", "customer"],
      ["middle", "other"],
      ["newer", "investor"],
    ]);
  });
});

describe("events", () => {
  test("returns what overlaps the span, including a meeting already under way", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(t, "google_calendar", [
      event("running", NOW - HOUR, NOW + HOUR),
      event("ended", NOW - 3 * HOUR, NOW - 2 * HOUR),
      event("inside", NOW + 2 * HOUR, NOW + 3 * HOUR),
      event("after", NOW + DAY, NOW + DAY + HOUR),
    ]);
    const { events } = await owner.query(api.workTools.events, { from: NOW, to: NOW + DAY });
    expect(events.map((e) => e.eventId)).toEqual(["running", "inside"]);
  });

  test("refuses a span over ten days, and a span that is not one", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.query(api.workTools.events, { from: NOW, to: NOW + 10 * DAY + 1 }),
    ).rejects.toThrow("Ask for at most ten days of meetings.");
    await expect(owner.query(api.workTools.events, { from: NOW, to: NOW })).rejects.toThrow(
      "That is not a span of time.",
    );
  });
});

describe("issues and meetings", () => {
  test("issues come newest first", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(t, "linear", [issue("1", NOW - 2 * HOUR), issue("2", NOW - HOUR)]);
    const { issues } = await owner.query(api.workTools.issues, {});
    expect(issues.map((i) => i.issueId)).toEqual(["2", "1"]);
  });

  test("a teammate on one company gets that company's team's issues and the shared teams'", async () => {
    const t = convexTest(schema, modules);
    await seed(t, "linear", [
      { ...issue("1", NOW - 3 * HOUR), teamKey: "SEC", teamName: "Second" },
      { ...issue("2", NOW - 2 * HOUR), teamKey: "FIR", teamName: "First" },
      issue("3", NOW - HOUR),
    ]);
    const ids = async (as: Awaited<ReturnType<typeof signInAsOwner>>) =>
      (await as.query(api.workTools.issues, {})).issues.map((i) => i.issueId);
    expect(await ids(await signInAsEngineer(t, ["kz"]))).toEqual(["3", "1"]);
    expect(await ids(await signInAsEngineer(t, ["us"]))).toEqual(["3", "2"]);
    expect(await ids(await signInAsOwner(t))).toEqual(["3", "2", "1"]);
  });

  test("meetings come newest first and honour the limit, up to 50", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(
      t,
      "fireflies",
      Array.from({ length: 60 }, (_, n) => meeting(`m${n}`, NOW - n * HOUR)),
    );
    const byDefault = await owner.query(api.workTools.meetings, {});
    expect(byDefault.meetings.map((m) => m.meetingId).slice(0, 2)).toEqual(["m0", "m1"]);
    expect(byDefault.meetings).toHaveLength(10);
    expect((await owner.query(api.workTools.meetings, { limit: 3 })).meetings).toHaveLength(3);
    expect((await owner.query(api.workTools.meetings, { limit: 500 })).meetings).toHaveLength(50);
  });
});

describe("how the last read went", () => {
  test("nulls when a source has never run", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const never = { state: null, message: null, lastOkAt: null };
    expect((await owner.query(api.workTools.needsReply, {})).source).toEqual(never);
    expect((await owner.query(api.workTools.events, { from: NOW, to: NOW + DAY })).source).toEqual(
      never,
    );
    expect((await owner.query(api.workTools.issues, {})).source).toEqual(never);
    expect((await owner.query(api.workTools.meetings, {})).source).toEqual(never);
  });

  test("each read query reports its own source's status", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await setStatus(t, "gmail", { state: "ok", lastOkAt: NOW - 1 });
    await setStatus(t, "google_calendar", { state: "ok", lastOkAt: NOW - 2 });
    await setStatus(t, "linear", {
      state: "error",
      message: "Linear answered 401 for issues.",
      lastOkAt: NOW - 3,
    });
    await setStatus(t, "fireflies", { state: "ok", lastOkAt: NOW - 4 });
    expect((await owner.query(api.workTools.needsReply, {})).source).toEqual({
      state: "ok",
      message: null,
      lastOkAt: NOW - 1,
    });
    expect((await owner.query(api.workTools.events, { from: NOW, to: NOW + DAY })).source).toEqual({
      state: "ok",
      message: null,
      lastOkAt: NOW - 2,
    });
    expect((await owner.query(api.workTools.issues, {})).source).toEqual({
      state: "error",
      message: "Linear answered 401 for issues.",
      lastOkAt: NOW - 3,
    });
    expect((await owner.query(api.workTools.meetings, {})).source.lastOkAt).toBe(NOW - 4);
  });
});

describe("setDomains", () => {
  test("lower-cases, de-duplicates, strips the @ and drops blank lines", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.workTools.settings, {})).toEqual({
      off: [],
      investorDomains: [],
      customerDomains: [],
    });
    await owner.mutation(api.workTools.setDomains, {
      investor: [" @Example-Fund.test ", "example-fund.test", "", "  "],
      customer: ["Clinic.TEST"],
    });
    expect(await owner.query(api.workTools.settings, {})).toEqual({
      off: [],
      investorDomains: ["example-fund.test"],
      customerDomains: ["clinic.test"],
    });
  });

  test("refuses what is not a domain, quoting the owner's own typing, and saves nothing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.workTools.setDomains, {
        investor: ["example-fund.test"],
        customer: ["not a domain"],
      }),
    ).rejects.toThrow('"not a domain" is not a domain. Write it like "example.com".');
    expect((await owner.query(api.workTools.settings, {})).investorDomains).toEqual([]);
  });

  test("refuses more than 50 domains in a list", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const many = Array.from({ length: 51 }, (_, n) => `fund-${n}.test`);
    await expect(
      owner.mutation(api.workTools.setDomains, { investor: many, customer: [] }),
    ).rejects.toThrow("Keep each list to 50 domains.");
    await owner.mutation(api.workTools.setDomains, { investor: many.slice(0, 50), customer: [] });
    expect((await owner.query(api.workTools.settings, {})).investorDomains).toHaveLength(50);
  });
});

describe("turning a source off and on", () => {
  test("turnOff deletes that source's records only, and says why nothing is read", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(t, "linear", [issue("1", NOW)]);
    await seed(t, "fireflies", [meeting("m1", NOW)]);
    await setStatus(t, "linear", { state: "ok", lastOkAt: NOW });

    await owner.mutation(api.workTools.turnOff, { source: "linear" });

    const left = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
    expect(left.map((doc) => doc.source)).toEqual(["fireflies"]);
    expect(await t.query(internal.workTools.isOff, { source: "linear" })).toBe(true);
    expect(await t.query(internal.workTools.isOff, { source: "fireflies" })).toBe(false);
    expect((await owner.query(api.workTools.settings, {})).off).toEqual(["linear"]);
    // The list is gone, so nothing may go on saying when it was last read.
    expect((await owner.query(api.workTools.issues, {})).source).toEqual({
      state: "not_configured",
      message: "Turned off under Settings → Work tools.",
      lastOkAt: null,
    });

    // Pressing it twice changes nothing.
    await owner.mutation(api.workTools.turnOff, { source: "linear" });
    expect((await owner.query(api.workTools.settings, {})).off).toEqual(["linear"]);
  });

  test("turnOn clears the switch and starts a read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "linear" });
    await owner.mutation(api.workTools.turnOn, { source: "linear" });
    expect(await t.query(internal.workTools.isOff, { source: "linear" })).toBe(false);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((job) => job.name)).toEqual(["connectors/linear:sync"]);

    // The read it started ran, and got as far as finding no key.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await owner.query(api.workTools.issues, {})).source).toMatchObject({
      state: "not_configured",
      message: "Set LINEAR_API_KEY on the Convex deployment.",
    });
  });

  test("a source switched off stays off through a scheduled read", async () => {
    vi.stubEnv("LINEAR_API_KEY", "fake-linear-key");
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "linear" });
    expect(await t.action(internal.connectors.linear.sync, {})).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
  });
});
