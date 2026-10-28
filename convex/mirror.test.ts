import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { MirrorRecord, MirrorSource, RecordOf } from "./lib/mirrorRules";
import schema from "./schema";
import { modules, type TestBackend } from "./test.setup";

// Every name, address, subject and title here is made up.
const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;

const mail = (threadId: string, over: Partial<RecordOf<"mail">> = {}): RecordOf<"mail"> => ({
  kind: "mail",
  threadId,
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: "Made-up subject",
  lastMessageAt: NOW - 60_000,
  ...over,
});

const issue = (issueId: string): RecordOf<"issue"> => ({
  kind: "issue",
  issueId,
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
  updatedAt: NOW - 60_000,
});

const meeting = (meetingId: string, heldAt = NOW - DAY): RecordOf<"meeting"> => ({
  kind: "meeting",
  meetingId,
  title: "Made-up meeting",
  heldAt,
  durationMinutes: 30,
  participants: [{ name: "Ada Example", address: "ada@example-fund.test" }],
  overview: "A made-up summary.",
  actionItems: ["A made-up action item"],
});

/** When the made-up grant in `connected()` was made. */
const GRANT_AT = NOW - DAY;
const isGoogle = (source: MirrorSource) => source === "gmail" || source === "google_calendar";
// A read of a Google source says which grant it began under, as the runner does.
const apply = (
  t: TestBackend,
  source: MirrorSource,
  rows: MirrorRecord[],
  grantAt: number | undefined = isGoogle(source) ? GRANT_AT : undefined,
) => t.mutation(internal.mirror.apply, { source, startedAt: NOW, rows, grantAt });

const stored = (t: TestBackend, source?: MirrorSource) =>
  t.run(async (ctx) =>
    (await ctx.db.query("mirrorRecords").collect())
      .filter((doc) => source === undefined || doc.source === source)
      .map((doc) => doc.externalId)
      .sort(),
  );

const status = (t: TestBackend, source: MirrorSource) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", source))
      .unique(),
  );

const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());

/** A backend where Google is connected (the value is not a real grant). */
async function connected() {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("oauthConnections", {
      provider: "google",
      sealedRefreshToken: "v1.not-a-real-grant.not-a-real-grant",
      connectedAt: GRANT_AT,
    }),
  );
  return t;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("mirror.apply", () => {
  test("inserts, updates and leaves alone, and says how many of each", async () => {
    const t = await connected();
    expect(await apply(t, "gmail", [mail("a1"), mail("a2")])).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await apply(t, "gmail", [mail("a1"), mail("a2")])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(
      await apply(t, "gmail", [mail("a1"), mail("a2", { subject: "Another made-up subject" })]),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 1 });
    const docs = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
    expect(docs.find((doc) => doc.externalId === "a2")?.record).toMatchObject({
      subject: "Another made-up subject",
    });
  });

  test("a good read replaces the set: a thread that was answered is removed", async () => {
    const t = await connected();
    await apply(t, "gmail", [mail("a1"), mail("b1")]);
    await apply(t, "gmail", [mail("a1")]);
    expect(await stored(t)).toEqual(["a1"]);
  });

  test("meeting notes accumulate", async () => {
    const t = convexTest(schema, modules);
    await apply(t, "fireflies", [meeting("m1")]);
    await apply(t, "fireflies", [meeting("m2")]);
    expect(await stored(t)).toEqual(["m1", "m2"]);
  });

  test("an empty batch for a replacing source empties it, and is a good run", async () => {
    const t = await connected();
    await apply(t, "gmail", [mail("a1")]);
    await apply(t, "gmail", []);
    expect(await stored(t)).toEqual([]);
    expect((await runs(t)).map((run) => run.status)).toEqual(["ok", "ok"]);
    expect(await status(t, "gmail")).toMatchObject({ state: "ok", lastOkAt: NOW });
  });

  test("a refused batch writes nothing (guard: the refusal in apply)", async () => {
    const t = await connected();
    await apply(t, "gmail", [mail("a1")]);
    const before = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
    await expect(
      apply(t, "gmail", [
        mail("a1", { subject: "Changed" }),
        mail("a2", { fromAddress: "not an address" }),
      ]),
    ).rejects.toThrow("1 of 2 records broke the size and shape rules, so nothing was written.");
    expect(await t.run((ctx) => ctx.db.query("mirrorRecords").collect())).toEqual(before);
    expect(await runs(t)).toHaveLength(1);
  });

  test("one source never touches another's rows", async () => {
    const t = await connected();
    await apply(t, "linear", [issue("i1")]);
    await apply(t, "gmail", []);
    expect(await stored(t)).toEqual(["i1"]);
  });

  test("the run log holds counts and no record text", async () => {
    const t = await connected();
    await apply(t, "gmail", [
      mail("a1", {
        subject: "REMOTE-SUBJECT-XYZ",
        fromName: "REMOTE-NAME-XYZ",
        fromAddress: "remote-address-xyz@example.test",
      }),
    ]);
    const logged = JSON.stringify([await runs(t), await status(t, "gmail")]);
    expect(logged).not.toContain("REMOTE-SUBJECT-XYZ");
    expect(logged).not.toContain("REMOTE-NAME-XYZ");
    expect(logged).not.toContain("remote-address-xyz");
    expect(await runs(t)).toMatchObject([
      { source: "gmail", status: "ok", inserted: 1, updated: 0, unchanged: 0, startedAt: NOW },
    ]);
  });

  test("a read that lands after its source was turned off is dropped (guard: mayWrite)", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("workToolSettings", { off: ["linear"], investorDomains: [], customerDomains: [] }),
    );
    expect(await apply(t, "linear", [issue("i1")])).toBeNull();
    expect(await stored(t)).toEqual([]);
    expect(await runs(t)).toEqual([]);
    expect(await status(t, "linear")).toBeNull();
  });

  test.each(["gmail", "google_calendar"] as const)(
    "a %s read that lands after Google was disconnected is dropped (guard: mayWrite)",
    async (source) => {
      const t = convexTest(schema, modules);
      expect(await apply(t, source, [])).toBeNull();
      expect(await apply(t, "gmail", [mail("a1")])).toBeNull();
      expect(await stored(t)).toEqual([]);
      expect(await runs(t)).toEqual([]);
    },
  );
});

describe("mirror.apply: a Google read is written only under the grant it began with", () => {
  const reconnect = (t: TestBackend, connectedAt: number) =>
    t.run(async (ctx) => {
      for (const row of await ctx.db.query("oauthConnections").collect()) await ctx.db.delete(row._id);
      await ctx.db.insert("oauthConnections", {
        provider: "google",
        sealedRefreshToken: "v1.another-made-up-grant.another-made-up-grant",
        connectedAt,
      });
    });

  test.each(["gmail", "google_calendar"] as const)(
    "a %s read begun under an earlier grant is dropped after a reconnect",
    async (source) => {
      const t = await connected();
      await reconnect(t, NOW - 1000);
      expect(await apply(t, source, source === "gmail" ? [mail("a1")] : [], GRANT_AT)).toBeNull();
      expect(await stored(t)).toEqual([]);
      expect(await runs(t)).toEqual([]);
      expect(await status(t, source)).toBeNull();
    },
  );

  test("a read that does not say which grant it began under is dropped", async () => {
    const t = await connected();
    const unstamped = (rows: MirrorRecord[]) =>
      t.mutation(internal.mirror.apply, { source: "gmail", startedAt: NOW, rows });
    expect(await unstamped([mail("a1")])).toBeNull();
    expect(await unstamped([])).toBeNull();
    expect(await stored(t)).toEqual([]);
  });

  test("a read under the current grant is written", async () => {
    const t = await connected();
    expect(await apply(t, "gmail", [mail("a1")], GRANT_AT)).toMatchObject({ inserted: 1 });
    await reconnect(t, NOW - 1000);
    expect(await apply(t, "gmail", [mail("a1"), mail("a2")], NOW - 1000)).toMatchObject({
      inserted: 1,
      unchanged: 1,
    });
  });

  test("the other tools need no grant, and are not asked for one", async () => {
    const t = convexTest(schema, modules);
    expect(await apply(t, "linear", [issue("i1")])).toMatchObject({ inserted: 1 });
    expect(await apply(t, "fireflies", [meeting("m1")])).toMatchObject({ inserted: 1 });
  });
});

describe("mirror.apply for a pushed write", () => {
  const pushed = (t: TestBackend, source: MirrorSource, rows: MirrorRecord[]) =>
    t.mutation(internal.mirror.apply, { source, startedAt: NOW, rows, pushed: true });

  test("needs no Google grant: the pushing session read the source itself", async () => {
    const t = convexTest(schema, modules);
    expect(await pushed(t, "gmail", [mail("a1")])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await stored(t, "gmail")).toEqual(["a1"]);
    expect(await status(t, "gmail")).toMatchObject({ state: "ok", lastOkAt: NOW });
  });

  test("is dropped when the source is turned off (guard: switchedOff)", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("workToolSettings", { off: ["gmail"], investorDomains: [], customerDomains: [] }),
    );
    expect(await pushed(t, "gmail", [mail("a1")])).toBeNull();
    expect(await stored(t)).toEqual([]);
    expect(await runs(t)).toEqual([]);
  });

  test("passes the same refusal as any write", async () => {
    const t = convexTest(schema, modules);
    await expect(pushed(t, "gmail", [issue("i1")])).rejects.toThrow(
      "1 of 1 records broke the size and shape rules, so nothing was written.",
    );
    expect(await stored(t)).toEqual([]);
  });

  test("a write that is not marked pushed still needs the grant", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.mirror.apply, { source: "gmail", startedAt: NOW, rows: [mail("a1")], pushed: false }),
    ).toBeNull();
    expect(await stored(t)).toEqual([]);
  });
});

describe("mirror.noteNotConfigured", () => {
  const note = (t: TestBackend, message: string) =>
    t.mutation(internal.mirror.noteNotConfigured, { source: "linear", message });

  test("sets the status, once, and never adds to the run log", async () => {
    const t = convexTest(schema, modules);
    await note(t, "Set LINEAR_API_KEY on the Convex deployment.");
    expect(await status(t, "linear")).toMatchObject({
      state: "not_configured",
      message: "Set LINEAR_API_KEY on the Convex deployment.",
      lastRunAt: NOW,
    });

    vi.setSystemTime(NOW + 15 * 60_000);
    await note(t, "Set LINEAR_API_KEY on the Convex deployment.");
    expect((await status(t, "linear"))?.lastRunAt).toBe(NOW);
    expect(await runs(t)).toEqual([]);

    await note(t, "Turned off under Settings → Work tools.");
    expect(await status(t, "linear")).toMatchObject({
      message: "Turned off under Settings → Work tools.",
      lastRunAt: NOW + 15 * 60_000,
    });
  });

  test("keeps the time of the last good read", async () => {
    const t = convexTest(schema, modules);
    await apply(t, "linear", [issue("i1")]);
    await note(t, "Set LINEAR_API_KEY on the Convex deployment.");
    expect(await status(t, "linear")).toMatchObject({ state: "not_configured", lastOkAt: NOW });
    expect(await stored(t)).toEqual(["i1"]);
  });
});

describe("mirror.prune", () => {
  const prune = (t: TestBackend) => t.mutation(internal.mirror.prune, {});

  async function readAt(t: TestBackend, source: MirrorSource, rows: MirrorRecord[], at: number) {
    vi.setSystemTime(at);
    await apply(t, source, rows);
    vi.setSystemTime(NOW);
  }

  test("a source with no good read for 30 days loses what it stored", async () => {
    const t = convexTest(schema, modules);
    await readAt(t, "linear", [issue("i1")], NOW - 31 * DAY);
    expect(await prune(t)).toBe(1);
    expect(await stored(t)).toEqual([]);
    // And nothing claims a "last read" over a list that is gone.
    expect((await status(t, "linear"))?.lastOkAt).toBeUndefined();
  });

  test("a source read 29 days ago keeps its records", async () => {
    const t = convexTest(schema, modules);
    await readAt(t, "linear", [issue("i1")], NOW - 29 * DAY);
    expect(await prune(t)).toBe(0);
    expect(await stored(t)).toEqual(["i1"]);
    expect((await status(t, "linear"))?.lastOkAt).toBe(NOW - 29 * DAY);
  });

  test("meeting notes go 90 days after the meeting", async () => {
    const t = convexTest(schema, modules);
    await apply(t, "fireflies", [
      meeting("old", NOW - 91 * DAY),
      meeting("recent", NOW - 89 * DAY),
    ]);
    expect(await prune(t)).toBe(1);
    expect(await stored(t)).toEqual(["recent"]);
  });

  test("age alone never deletes mail from a source that is being read", async () => {
    const t = await connected();
    await apply(t, "gmail", [mail("a1", { lastMessageAt: NOW - 200 * DAY })]);
    expect(await prune(t)).toBe(0);
    expect(await stored(t)).toEqual(["a1"]);
  });

  test("expired connect attempts are deleted; a live one is kept", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", { state: "expired", verifier: "v", expiresAt: NOW - 1 });
      await ctx.db.insert("oauthStates", { state: "live", verifier: "v", expiresAt: NOW + 60_000 });
    });
    await prune(t);
    const left = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(left.map((row) => row.state)).toEqual(["live"]);
  });
});
