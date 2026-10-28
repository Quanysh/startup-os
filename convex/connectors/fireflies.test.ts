import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "../test.setup";
import { RECENT_QUERY } from "./fireflies";
import { HELD, answer, stubFireflies, transcript } from "./fireflies.fixtures";

// Obviously not a real key.
const KEY = "fake-fireflies-key";
const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configured() {
  vi.stubEnv("FIREFLIES_API_KEY", KEY);
  return convexTest(schema, modules);
}

const sync = (t: TestBackend) => t.action(internal.connectors.fireflies.sync, {});
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "fireflies"))
      .unique(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const records = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const storedIds = async (t: TestBackend) => (await records(t)).map((doc) => doc.externalId).sort();

const M1 = transcript({ id: "meet-1" });
const M2 = transcript({ id: "meet-2", title: "Another made-up meeting", date: HELD + DAY });

async function withStoredNote(t: TestBackend) {
  stubFireflies(answer([M1]));
  expect(await sync(t)).toBe("ok");
  const before = await records(t);
  expect(before).toHaveLength(1);
  return before;
}

describe("the one thing sent to Fireflies", () => {
  test("is a query that asks for no transcript", () => {
    expect(RECENT_QUERY.trimStart().startsWith("query ")).toBe(true);
    expect(RECENT_QUERY).not.toMatch(/mutation/i);
    for (const never of ["sentences", "transcript_url", "audio_url", "video_url", "speakers"]) {
      expect(RECENT_QUERY).not.toContain(never);
    }
  });
});

describe("fireflies.sync", () => {
  test("without a key it says which variable to set, and fetches nothing", async () => {
    const calls = stubFireflies(answer([M1]));
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set FIREFLIES_API_KEY on the Convex deployment.",
    });
    expect(await runs(t)).toEqual([]);
  });

  test("stores recent meetings' notes with one read-only request", async () => {
    const calls = stubFireflies(answer([M2, M1]));
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["meet-1", "meet-2"]);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.fireflies.ai/graphql");
    expect(call?.method).toBe("POST");
    expect(call?.redirect).toBe("manual");
    expect(call?.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.contentType).toBe("application/json");
    expect(call?.query).toBe(RECENT_QUERY);
    expect(call?.query).not.toContain("sentences");
    expect(call?.query).not.toMatch(/mutation/i);
    expect(call?.variables).toEqual({ limit: 20 });

    const owner = await signInAsOwner(t);
    const { meetings } = await owner.query(api.workTools.meetings, {});
    expect(meetings.map((m) => [m.meetingId, m.title, m.durationMinutes])).toEqual([
      ["meet-2", "Another made-up meeting", 31],
      ["meet-1", "Made-up meeting", 31],
    ]);
    expect(meetings[1]).toMatchObject({
      overview: "A made-up summary.",
      actionItems: ["Send the made-up deck", "Book a made-up follow-up"],
    });
  });

  test("notes accumulate: a read of newer meetings keeps the older ones", async () => {
    const t = configured();
    await withStoredNote(t);
    stubFireflies(answer([M2]));
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["meet-1", "meet-2"]);
  });

  test("the same meeting read twice is unchanged; a summary that arrives later is an update", async () => {
    const t = configured();
    stubFireflies(answer([transcript({ id: "meet-1", summary: null })]));
    await sync(t);
    stubFireflies(answer([transcript({ id: "meet-1", summary: null })]));
    await sync(t);
    stubFireflies(answer([M1]));
    await sync(t);
    expect((await runs(t)).map((run) => [run.inserted, run.updated, run.unchanged])).toEqual([
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ]);
  });

  test("a meeting listed twice in one answer is one note", async () => {
    stubFireflies(answer([M1, M1]));
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["meet-1"]);
  });

  test("a meeting older than the notes are kept for is not taken in", async () => {
    stubFireflies(answer([M1, transcript({ id: "meet-old", date: NOW - 91 * DAY })]));
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["meet-1"]);
  });

  test("an empty answer is recorded as empty, and stored notes are untouched", async () => {
    const t = configured();
    const before = await withStoredNote(t);
    stubFireflies(answer([]));
    expect(await sync(t)).toBe("empty");
    expect(await status(t)).toMatchObject({
      state: "empty",
      message: "The source returned nothing.",
      lastOkAt: NOW,
    });
    expect(await records(t)).toEqual(before);
  });

  test("a 429 twice is reported by its status, and stored notes are untouched", async () => {
    const t = configured();
    const before = await withStoredNote(t);
    const calls = stubFireflies({ message: "REMOTE-TEXT" }, 429);
    expect(await sync(t)).toBe("error");
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Fireflies answered 429 for meetings.",
    });
    expect(calls).toHaveLength(2);
    expect(await records(t)).toEqual(before);
  });

  test("a 401 is not retried", async () => {
    const t = configured();
    const calls = stubFireflies({}, 401);
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Fireflies answered 401 for meetings.");
    expect(calls).toHaveLength(1);
  });

  test("an errors array with a 200 fails the read in our words", async () => {
    const t = configured();
    const before = await withStoredNote(t);
    stubFireflies({ errors: [{ message: "REMOTE-TEXT" }] });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Fireflies reported an error for meetings.");
    expect(await records(t)).toEqual(before);
  });

  test("one unreadable transcript fails the whole read", async () => {
    const t = configured();
    const before = await withStoredNote(t);
    stubFireflies(answer([M2, transcript({ id: "meet-3", date: "soon" })]));
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Fireflies' meetings were not in the expected shape.");
    expect(await records(t)).toEqual(before);
  });

  test("switched off: nothing is fetched", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "fireflies" });
    const calls = stubFireflies(answer([M1]));
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
  });

  test("the log holds no title, name, summary or key", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(JSON.stringify(args)));
    }
    const t = configured();
    await withStoredNote(t);
    stubFireflies(answer([transcript({ id: "meet-3", title: "REMOTE-TITLE", date: "REMOTE-DATE" })]));
    expect(await sync(t)).toBe("error");
    stubFireflies({ message: "REMOTE-TEXT" }, 500);
    expect(await sync(t)).toBe("error");

    const logged = JSON.stringify([await runs(t), await status(t)]) + lines.join("\n");
    for (const personal of [
      "Made-up meeting",
      "Ada Example",
      "example-fund",
      "made-up summary",
      "made-up deck",
      "meet-1",
      "REMOTE-",
      KEY,
    ]) {
      expect(logged).not.toContain(personal);
    }
  });
});
