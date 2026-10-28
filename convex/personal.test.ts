import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resolveOwnerUser } from "./authOwner";
import {
  MIRROR_SOURCES,
  keyOf,
  type MirrorRecord,
  type MirrorSource,
  type RecordOf,
} from "./lib/mirrorRules";
import { NOT_ALLOWED, type Member } from "./lib/owner";
import { holderOf } from "./lib/personal";
import { OWNER_HAS_NO_PERSONAL_TOKEN, hashToken, tokenFrom } from "./lib/personalRules";
import type { GrantableArea } from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  addMember,
  modules,
  signInAs,
  signInAsMember,
  signInAsOwner,
  type TestBackend,
} from "./test.setup";
import { finishScheduled } from "./test.timers";

// Personal records: each person's own mail, calendar, meeting notes and
// issues. What is proved here, read path by read path: A is never sent B's,
// the owner is never sent a teammate's, a teammate is never sent the owner's,
// and nothing of a person is left once they are removed.
//
// Every name, address, subject and title is made up, and each carries the
// word SECRET and whose it is, so one string search proves a surface clean.

const NOW = Date.UTC(2026, 9, 12, 6);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ADA = "ada.teammate@gmail.com";
const BEN = "ben.teammate@gmail.com";
// Obviously not real: what the browser would draw at random.
const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";

type Who = "OWNER" | "ADA" | "BEN";
const OWNER_OF: Record<Who, string | undefined> = { OWNER: undefined, ADA, BEN };

const mail = (who: Who, id = "aa01"): RecordOf<"mail"> => ({
  kind: "mail",
  threadId: id,
  fromName: `SECRET ${who} SENDER`,
  fromAddress: `secret.${who.toLowerCase()}@example.test`,
  subject: `SECRET ${who} SUBJECT`,
  lastMessageAt: NOW - HOUR,
});
const event = (who: Who, id = "evt-1"): RecordOf<"event"> => ({
  kind: "event",
  eventId: id,
  title: `SECRET ${who} EVENT`,
  startsAt: NOW + HOUR,
  endsAt: NOW + 2 * HOUR,
  allDay: false,
  attendees: [{ name: `SECRET ${who} GUEST`, address: `guest.${who.toLowerCase()}@example.test` }],
  attendeeCount: 1,
  hasMeetingLink: false,
});
const issue = (who: Who, id = "iss-1", mine = true): RecordOf<"issue"> => ({
  kind: "issue",
  issueId: id,
  identifier: "ENG-1",
  title: `SECRET ${who} ISSUE`,
  url: "",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: `SECRET ${who} ASSIGNEE`,
  mine,
  priority: 0,
  updatedAt: NOW - HOUR,
});
const meeting = (who: Who, id = "meet-1", heldAt = NOW - DAY): RecordOf<"meeting"> => ({
  kind: "meeting",
  meetingId: id,
  title: `SECRET ${who} MEETING`,
  heldAt,
  durationMinutes: 30,
  participants: [],
  overview: `SECRET ${who} OVERVIEW`,
  actionItems: [`SECRET ${who} ACTION`],
});

const SOURCE_OF = {
  mail: "gmail",
  event: "google_calendar",
  issue: "linear",
  meeting: "fireflies",
} as const;

type Seed = Parameters<Parameters<TestBackend["run"]>[0]>[0];

/**
 * What a teammate's row carries besides its content: their address and, once
 * they have signed in, their own `users` row. A row seeded before its person
 * signed in is given the person by `adopt` when they do.
 */
async function filedFor(ctx: Seed, owner: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", owner))
    .first();
  return user === null ? { owner } : { owner, userId: user._id };
}

/**
 * Make every row seeded under an address, and not yet anybody's, the row of
 * the person who has now signed in with it. The fixtures here are seeded by
 * address, often before the sign-in; stored rows name the person too.
 */
async function adopt(t: TestBackend, email: string) {
  await t.run(async (ctx) => {
    const filed = await filedFor(ctx, email);
    for (const table of ["mirrorRecords", "personalSourceStatus", "personalTokens"] as const) {
      for (const doc of await ctx.db.query(table).collect()) {
        if (doc.owner === email && doc.userId === undefined) await ctx.db.patch(doc._id, filed);
      }
    }
  });
}

async function hold(t: TestBackend, who: Who, rows: MirrorRecord[]) {
  const owner = OWNER_OF[who];
  await t.run(async (ctx) => {
    for (const record of rows) {
      await ctx.db.insert("mirrorRecords", {
        ...(owner === undefined ? {} : await filedFor(ctx, owner)),
        source: SOURCE_OF[record.kind],
        ...keyOf(record),
        syncedAt: NOW,
        record,
      });
    }
  });
}

/** One of everything for each of the three people, under the same ids. */
async function seedAll(t: TestBackend) {
  for (const who of ["OWNER", "ADA", "BEN"] as const) {
    await hold(t, who, [mail(who), event(who), issue(who), meeting(who)]);
  }
  await t.run(async (ctx) => {
    await ctx.db.insert("sourceStatus", {
      source: "gmail",
      state: "ok",
      lastRunAt: NOW - 1,
      lastOkAt: NOW - 1,
    });
    await ctx.db.insert("personalSourceStatus", {
      ...(await filedFor(ctx, ADA)),
      source: "gmail",
      state: "ok",
      lastRunAt: NOW - 2,
      lastOkAt: NOW - 2,
    });
    await ctx.db.insert("personalSourceStatus", {
      ...(await filedFor(ctx, BEN)),
      source: "gmail",
      state: "error",
      message: "invalid_records: records.0.subject — is too long or too large",
      lastRunAt: NOW - 3,
      lastOkAt: NOW - 3,
    });
  });
}

const TODAY: GrantableArea[] = ["today"];
async function asAda(t: TestBackend, areas: GrantableArea[] = TODAY) {
  const client = await signInAsMember(t, "engineer", ["us"], ADA, areas);
  await adopt(t, ADA);
  return client;
}
async function asBen(t: TestBackend, areas: GrantableArea[] = TODAY) {
  const client = await signInAsMember(t, "sales", ["us", "kz"], BEN, areas);
  await adopt(t, BEN);
  return client;
}

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

/** Everything the four personal reads and the connect status send one caller, as one string. */
async function everythingSentTo(client: Client) {
  return JSON.stringify([
    await client.query(api.workTools.needsReply, {}),
    await client.query(api.workTools.events, { from: NOW - DAY, to: NOW + DAY }),
    await client.query(api.workTools.meetings, {}),
    await client.query(api.workTools.myIssues, {}),
    await client.query(api.connect.status, {}),
  ]);
}

const held = (t: TestBackend, who: Who) =>
  t.run(async (ctx) =>
    (await ctx.db.query("mirrorRecords").collect())
      .filter((doc) => doc.owner === OWNER_OF[who])
      .map((doc) => doc.source)
      .sort(),
  );
const ALL_FOUR = ["fireflies", "gmail", "google_calendar", "linear"];
const tokens = (t: TestBackend) => t.run((ctx) => ctx.db.query("personalTokens").collect());
const personalStatuses = (t: TestBackend) =>
  t.run((ctx) => ctx.db.query("personalSourceStatus").collect());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("each person is sent their own records and nobody else's", () => {
  test("a teammate gets their own mail, calendar, meeting notes and issues, and nothing of anyone else's", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const sent = await everythingSentTo(await asAda(t));
    for (const kind of ["SUBJECT", "SENDER", "EVENT", "GUEST", "MEETING", "OVERVIEW", "ISSUE"]) {
      expect(sent).toContain(`SECRET ADA ${kind}`);
    }
    expect(sent).not.toContain("SECRET BEN");
    expect(sent).not.toContain("SECRET OWNER");
    expect(sent).not.toContain("secret.ben");
    expect(sent).not.toContain("secret.owner");
  });

  test("another teammate gets theirs, and not the first one's", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const sent = await everythingSentTo(await asBen(t));
    expect(sent).toContain("SECRET BEN SUBJECT");
    expect(sent).toContain("SECRET BEN EVENT");
    expect(sent).not.toContain("SECRET ADA");
    expect(sent).not.toContain("SECRET OWNER");
  });

  test("the owner gets the rows with no owner, and no teammate's", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const sent = await everythingSentTo(await signInAsOwner(t));
    for (const kind of ["SUBJECT", "EVENT", "MEETING", "ISSUE"]) {
      expect(sent).toContain(`SECRET OWNER ${kind}`);
    }
    expect(sent).not.toContain("SECRET ADA");
    expect(sent).not.toContain("SECRET BEN");
    expect(sent).not.toContain("teammate@gmail.com");
  });

  test("a teammate with nothing of their own gets empty lists, never the owner's", async () => {
    const t = convexTest(schema, modules);
    await hold(t, "OWNER", [mail("OWNER"), event("OWNER"), issue("OWNER"), meeting("OWNER")]);
    await hold(t, "BEN", [mail("BEN")]);
    const ada = await asAda(t);
    expect(await ada.query(api.workTools.needsReply, {})).toEqual({
      source: { state: null, message: null, lastOkAt: null },
      threads: [],
    });
    expect((await ada.query(api.workTools.events, { from: NOW - DAY, to: NOW + DAY })).events).toEqual(
      [],
    );
    expect((await ada.query(api.workTools.meetings, {})).meetings).toEqual([]);
    expect((await ada.query(api.workTools.myIssues, {})).issues).toEqual([]);
  });

  test("how a tool's last read went is each person's own", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const source = async (client: Client) => (await client.query(api.workTools.needsReply, {})).source;
    expect(await source(await signInAsOwner(t))).toEqual({
      state: "ok",
      message: null,
      lastOkAt: NOW - 1,
    });
    expect(await source(await asAda(t))).toEqual({ state: "ok", message: null, lastOkAt: NOW - 2 });
    expect(await source(await asBen(t))).toMatchObject({ state: "error", lastOkAt: NOW - 3 });
    // A tool the teammate never pushed says so, whatever the owner's own stands at.
    const ada = await asAdaAgain(t);
    expect((await ada.query(api.workTools.meetings, {})).source.lastOkAt).toBeNull();
  });

  test("a teammate's mail is not sorted by the owner's domain lists", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.setDomains, { investor: ["example.test"], customer: [] });
    expect((await owner.query(api.workTools.needsReply, {})).threads[0]?.group).toBe("investor");
    expect((await (await asAda(t)).query(api.workTools.needsReply, {})).threads[0]?.group).toBe(
      "other",
    );
  });

  test("without the Today area a teammate is refused all of it, whatever else they have", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t, ["board", "scorecard", "finance"]);
    const calls = [
      ada.query(api.workTools.needsReply, {}),
      ada.query(api.workTools.events, { from: NOW - DAY, to: NOW + DAY }),
      ada.query(api.workTools.meetings, {}),
      ada.query(api.workTools.myIssues, {}),
      ada.query(api.connect.status, {}),
      ada.mutation(api.connect.createToken, { entropy: ENTROPY }),
      ada.mutation(api.connect.revokeToken, {}),
      ada.mutation(api.connect.forget, { source: "gmail" }),
      ada.mutation(api.connect.forgetAll, {}),
    ];
    for (const call of calls) await expect(call).rejects.toThrow("not_allowed");
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
  });
});

/** A second client for the same teammate, without adding them to the team twice. */
async function asAdaAgain(t: TestBackend) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", ADA))
      .first();
    const sessionId = await ctx.db.insert("authSessions", {
      userId: user!._id,
      expirationTime: NOW + DAY,
    });
    return { userId: user!._id, sessionId };
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

describe("the shared Linear board and the personal view", () => {
  test("the board holds the shared mirror only, for the owner and for a teammate with their own issues", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const board = async (client: Client) => JSON.stringify(await client.query(api.workTools.issues, {}));
    const owner = await board(await signInAsOwner(t));
    expect(owner).toContain("SECRET OWNER ISSUE");
    expect(owner).not.toContain("SECRET ADA");
    expect(owner).not.toContain("SECRET BEN");
    const ada = await board(await asAda(t, ["today", "board"]));
    expect(ada).toContain("SECRET OWNER ISSUE");
    expect(ada).not.toContain("SECRET ADA");
    expect(ada).not.toContain("SECRET BEN");
  });

  test("the owner's own issues are the shared mirror's flagged as theirs", async () => {
    const t = convexTest(schema, modules);
    await hold(t, "OWNER", [issue("OWNER", "mine-1", true), issue("OWNER", "not-mine", false)]);
    await hold(t, "ADA", [issue("ADA", "mine-1", true)]);
    const { issues } = await (await signInAsOwner(t)).query(api.workTools.myIssues, {});
    expect(issues.map((one) => [one.issueId, one.title])).toEqual([["mine-1", "SECRET OWNER ISSUE"]]);
  });

  test("a teammate's own issues are the ones they pushed, and nothing from the shared board", async () => {
    const t = convexTest(schema, modules);
    await hold(t, "OWNER", [issue("OWNER", "shared-1", true)]);
    await hold(t, "ADA", [issue("ADA", "a-1", true), issue("ADA", "a-2", false)]);
    const { issues } = await (await asAda(t)).query(api.workTools.myIssues, {});
    expect(issues.map((one) => one.issueId).sort()).toEqual(["a-1", "a-2"]);
    expect(JSON.stringify(issues)).not.toContain("SECRET OWNER");
  });
});

describe("connect.status", () => {
  test("a teammate is told about their own token and tools, and nothing else", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    await hold(t, "BEN", [mail("BEN", "bb02"), mail("BEN", "bb03")]);
    const ada = await asAda(t);
    const ben = await asBen(t);
    expect(await ada.query(api.connect.status, {})).toEqual({
      owner: false,
      token: null,
      tools: [
        { source: "gmail", lastOkAt: NOW - 2, held: 1 },
        { source: "google_calendar", lastOkAt: null, held: 1 },
        { source: "linear", lastOkAt: null, held: 1 },
        { source: "fireflies", lastOkAt: null, held: 1 },
      ],
    });
    await ben.mutation(api.connect.createToken, { entropy: ENTROPY });
    // Ben's token and Ben's three threads say nothing on Ada's page.
    expect((await ada.query(api.connect.status, {})).token).toBeNull();
    const bens = await ben.query(api.connect.status, {});
    expect(bens.token).toEqual({ createdAt: NOW, lastUsedAt: null });
    expect(bens.tools[0]).toEqual({ source: "gmail", lastOkAt: NOW - 3, held: 3 });
  });

  test("the owner is told only that the owner's tools are set up elsewhere", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    await (await asAda(t)).mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(await (await signInAsOwner(t)).query(api.connect.status, {})).toEqual({
      owner: true,
      token: null,
      tools: [],
    });
  });
});

describe("a personal token", () => {
  test("is returned once, with the prefix and 256 bits, and only its hash is stored", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(token).toMatch(/^sos_[A-Za-z0-9_-]{43}$/);
    const rows = await tokens(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: ADA, tokenHash: await hashToken(token), createdAt: NOW });
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The token is in no table, and no query hands it back.
    const everything = await t.run(async (ctx) => {
      const all: unknown[] = [];
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        all.push(...(await ctx.db.query(table).collect()));
      }
      return JSON.stringify(all);
    });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.slice(4));
    const said = JSON.stringify(await ada.query(api.connect.status, {}));
    expect(said).not.toContain(token.slice(4));
    expect(said).not.toContain(rows[0]!.tokenHash);
  });

  test("two tokens are never the same, even from the same browser entropy", async () => {
    const t = convexTest(schema, modules);
    const first = await (await asAda(t)).mutation(api.connect.createToken, { entropy: ENTROPY });
    const second = await (await asBen(t)).mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(first.token).not.toBe(second.token);
  });

  test("is still unguessable where the runtime gives no random bytes: the browser's are in it", async () => {
    const t = convexTest(schema, modules);
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("no randomness here");
    });
    try {
      const ada = await asAda(t);
      const one = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
      const two = await ada.mutation(api.connect.createToken, { entropy: `${ENTROPY}x` });
      expect(one.token).toMatch(/^sos_[A-Za-z0-9_-]{43}$/);
      expect(two.token).not.toBe(one.token);
    } finally {
      spy.mockRestore();
    }
  });

  test("the browser's randomness is in the token: with the same server bytes, another entropy gives another token", async () => {
    const t = convexTest(schema, modules);
    // The runtime draws the same 32 bytes every time.
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((bytes) => {
      if (bytes instanceof Uint8Array) bytes.fill(7);
      return bytes;
    });
    try {
      const ada = await asAda(t);
      const make = (entropy: string) => ada.mutation(api.connect.createToken, { entropy });
      const one = await make(ENTROPY);
      const same = await make(ENTROPY);
      const other = await make(`${ENTROPY.slice(0, -1)}X`);
      expect(spy).toHaveBeenCalledTimes(3);
      // The mock is what the mutation drew from: nothing else differs between these two.
      expect(same.token).toBe(one.token);
      expect(other.token).not.toBe(one.token);
      expect(other.token).toMatch(/^sos_[A-Za-z0-9_-]{43}$/);
    } finally {
      spy.mockRestore();
    }
  });

  test("with no random bytes from the runtime at all a token is still made, and it is the browser's bytes hashed", async () => {
    const t = convexTest(schema, modules);
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("no randomness here");
    });
    try {
      const ada = await asAda(t);
      const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
      expect(spy).toHaveBeenCalled();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ENTROPY));
      expect(token).toBe(tokenFrom(new Uint8Array(digest)));
      expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(token) })).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("the browser's part must be 32 bytes or more of URL-safe text", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    for (const entropy of ["", "short", "has spaces ".repeat(6), "x".repeat(129)]) {
      await expect(ada.mutation(api.connect.createToken, { entropy })).rejects.toThrow(
        "That token could not be made. Try again.",
      );
    }
    expect(await tokens(t)).toEqual([]);
  });

  test("a new one replaces the old one: one row per person, and the old hash is gone", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    const ben = await asBen(t);
    const old = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const bens = await ben.mutation(api.connect.createToken, { entropy: ENTROPY });
    vi.setSystemTime(NOW + HOUR);
    const next = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(next.token).not.toBe(old.token);
    const rows = await tokens(t);
    expect(rows.map((row) => row.owner).sort()).toEqual([ADA, BEN]);
    const hashes = rows.map((row) => row.tokenHash);
    expect(hashes).toContain(await hashToken(next.token));
    expect(hashes).toContain(await hashToken(bens.token));
    expect(hashes).not.toContain(await hashToken(old.token));
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(old.token) })).toBe(
      false,
    );
  });

  test("revoking deletes the caller's token and nobody else's, and keeps what was received", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    const ben = await asBen(t);
    const adas = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const bens = await ben.mutation(api.connect.createToken, { entropy: ENTROPY });
    await ada.mutation(api.connect.revokeToken, {});
    expect((await tokens(t)).map((row) => row.owner)).toEqual([BEN]);
    const knows = async (token: string) =>
      t.query(internal.connect.knows, { tokenHash: await hashToken(token) });
    expect(await knows(adas.token)).toBe(false);
    expect(await knows(bens.token)).toBe(true);
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
    // Revoking with nothing to revoke is not an error.
    await expect(ada.mutation(api.connect.revokeToken, {})).resolves.toBeNull();
  });

  test("the owner has none: making, revoking and forgetting are refused in fixed words", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const owner = await signInAsOwner(t);
    const calls = [
      owner.mutation(api.connect.createToken, { entropy: ENTROPY }),
      owner.mutation(api.connect.revokeToken, {}),
      owner.mutation(api.connect.forget, { source: "linear" }),
      owner.mutation(api.connect.forgetAll, {}),
    ];
    for (const call of calls) await expect(call).rejects.toThrow(OWNER_HAS_NO_PERSONAL_TOKEN);
    expect(await tokens(t)).toEqual([]);
    // The shared mirror, the Linear board among it, is as it was.
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
  });

  test("a token is honoured only while its person is a teammate with Today", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const tokenHash = await hashToken(token);
    const knows = () => t.query(internal.connect.knows, { tokenHash });
    expect(await knows()).toBe(true);
    // An address that became an owner's: the owner's rows are the shared mirror.
    vi.stubEnv("OWNER_EMAILS", `${OWNER},${ADA}`);
    expect(await knows()).toBe(false);
    vi.stubEnv("OWNER_EMAILS", OWNER);
    expect(await knows()).toBe(true);
    // No owner configured: nobody is let in, and no token is honoured.
    vi.stubEnv("OWNER_EMAILS", "");
    expect(await knows()).toBe(false);
    vi.stubEnv("OWNER_EMAILS", OWNER);
    // The row edited so that Today is gone, by any road.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("members").withIndex("by_email", (q) => q.eq("email", ADA)).unique();
      await ctx.db.patch(row!._id, { areas: ["board"] });
    });
    expect(await knows()).toBe(false);
  });
});

describe("forgetting", () => {
  test("one tool: the caller's own records of it go, and nothing else", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    await ada.mutation(api.connect.forget, { source: "gmail" });
    expect(await held(t, "ADA")).toEqual(["fireflies", "google_calendar", "linear"]);
    expect(await held(t, "BEN")).toEqual(ALL_FOUR);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
    // "Last received" goes with the records, on the caller's row alone.
    expect((await ada.query(api.workTools.needsReply, {})).source.lastOkAt).toBeNull();
    const rest = (await personalStatuses(t)).filter((row) => row.owner === BEN);
    expect(rest).toMatchObject([{ lastOkAt: NOW - 3 }]);
    expect(
      (await (await signInAsOwner(t)).query(api.workTools.needsReply, {})).source.lastOkAt,
    ).toBe(NOW - 1);
  });

  test("everything: all four of the caller's tools, and nobody else's", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    await ada.mutation(api.connect.forgetAll, {});
    expect(await held(t, "ADA")).toEqual([]);
    expect(await held(t, "BEN")).toEqual(ALL_FOUR);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
    // The token stays: forgetting is not disconnecting.
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(token) })).toBe(true);
  });

  test("forgetting keeps the push count, so it is no way round the rate limit", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("personalSourceStatus", {
        owner: ADA,
        source: "gmail",
        state: "ok",
        lastOkAt: NOW,
        lastRunAt: NOW,
        windowStart: NOW,
        pushes: 7,
      }),
    );
    await (await asAda(t)).mutation(api.connect.forget, { source: "gmail" });
    const [row] = await personalStatuses(t);
    expect(row).toMatchObject({ owner: ADA, source: "gmail", windowStart: NOW, pushes: 7 });
    expect(row!.lastOkAt).toBeUndefined();
    expect(row!.state).toBeUndefined();
  });
});

describe("leaving the team leaves nothing behind", () => {
  const memberId = (t: TestBackend, email: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db.query("members").withIndex("by_email", (q) => q.eq("email", email)).unique();
      return row!._id;
    });
  /** Every row, in every table, that mentions a string. */
  const mentions = (t: TestBackend, needle: string) =>
    t.run(async (ctx) => {
      const found: string[] = [];
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        for (const doc of await ctx.db.query(table).collect()) {
          if (JSON.stringify(doc).includes(needle)) found.push(table);
        }
      }
      return [...new Set(found)].sort();
    });

  test("removing a teammate deletes their token, their records and their status, and nobody else's", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    const ben = await asBen(t);
    const adas = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const bens = await ben.mutation(api.connect.createToken, { entropy: ENTROPY });
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.remove, { id: await memberId(t, ADA) });

    expect(await held(t, "ADA")).toEqual([]);
    expect((await tokens(t)).map((row) => row.owner)).toEqual([BEN]);
    expect((await personalStatuses(t)).map((row) => row.owner)).toEqual([BEN]);
    expect(await mentions(t, "SECRET ADA")).toEqual([]);
    // Their address is left only where the team keeps a person's sign-in.
    expect(await mentions(t, ADA)).toEqual(["users"]);
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(adas.token) })).toBe(
      false,
    );
    // The other teammate and the owner are untouched.
    expect(await held(t, "BEN")).toEqual(ALL_FOUR);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(bens.token) })).toBe(
      true,
    );
  });

  test("unticking Today does the same, in the same mutation", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t, ["today", "board"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, {
      id: await memberId(t, ADA),
      role: "engineer",
      companies: ["us"],
      areas: ["board"],
    });
    expect(await held(t, "ADA")).toEqual([]);
    expect(await tokens(t)).toEqual([]);
    expect((await personalStatuses(t)).map((row) => row.owner)).toEqual([BEN]);
    expect(await mentions(t, "SECRET ADA")).toEqual([]);
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(token) })).toBe(false);
    expect(await held(t, "BEN")).toEqual(ALL_FOUR);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
  });

  test("a change that keeps Today deletes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, {
      id: await memberId(t, ADA),
      role: "sales",
      companies: ["us", "kz"],
      areas: ["today", "sales"],
    });
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
    expect(await t.query(internal.connect.knows, { tokenHash: await hashToken(token) })).toBe(true);
  });

  test("a push that lands after the teammate is removed stores nothing", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const tokenHash = await hashToken(token);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.remove, { id: await memberId(t, ADA) });
    // The write half of a push that was already past the door.
    expect(
      await t.mutation(internal.mirror.applyPersonal, {
        tokenHash,
        source: "gmail",
        rows: [mail("ADA")],
      }),
    ).toEqual({ ok: false, reason: "unauthorized" });
    expect(await t.mutation(internal.connect.admit, { tokenHash, source: "gmail" })).toBe(
      "unauthorized",
    );
    await t.mutation(internal.connect.noteRefused, { tokenHash, source: "gmail", message: "x" });
    expect(await held(t, "ADA")).toEqual([]);
    expect(await personalStatuses(t)).toEqual([]);
  });

  test("so does one that lands after the token was revoked or replaced", async () => {
    const t = convexTest(schema, modules);
    const ada = await asAda(t);
    const old = await hashToken(
      (await ada.mutation(api.connect.createToken, { entropy: ENTROPY })).token,
    );
    await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const write = (tokenHash: string) =>
      t.mutation(internal.mirror.applyPersonal, { tokenHash, source: "gmail", rows: [mail("ADA")] });
    expect(await write(old)).toEqual({ ok: false, reason: "unauthorized" });
    await ada.mutation(api.connect.revokeToken, {});
    expect(await write(old)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await held(t, "ADA")).toEqual([]);
  });
});

describe("the write touches one person's rows only", () => {
  test("a teammate's push never adds to, changes or removes the owner's or another teammate's rows", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const ada = await asAda(t);
    const tokenHash = await hashToken(
      (await ada.mutation(api.connect.createToken, { entropy: ENTROPY })).token,
    );
    const others = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("mirrorRecords").collect()).filter((doc) => doc.owner !== ADA),
      );
    const before = await others();
    // The same ids the owner and Ben hold ("aa01", "iss-1"), with other
    // content, and a list that names none of theirs: a replace.
    const changed = { ...mail("ADA"), subject: "SECRET ADA CHANGED" };
    expect(
      await t.mutation(internal.mirror.applyPersonal, { tokenHash, source: "gmail", rows: [changed] }),
    ).toEqual({ ok: true, inserted: 0, updated: 1, unchanged: 0 });
    expect(
      await t.mutation(internal.mirror.applyPersonal, {
        tokenHash,
        source: "linear",
        rows: [issue("ADA", "another-id")],
      }),
    ).toEqual({ ok: true, inserted: 1, updated: 0, unchanged: 0 });
    expect(await others()).toEqual(before);
    // The deployment's status and run log, which the owner reads, were not touched.
    const shared = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(shared.runs).toEqual([]);
    expect(shared.status).toMatchObject([{ source: "gmail", lastOkAt: NOW - 1 }]);
  });

  test("a read or push for the owner never touches a teammate's rows", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const teammates = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("mirrorRecords").collect()).filter((doc) => doc.owner !== undefined),
      );
    const before = await teammates();
    // The shared Linear list replaced by one that names none of the stored ids.
    await t.mutation(internal.mirror.apply, {
      source: "linear",
      startedAt: NOW,
      rows: [issue("OWNER", "brand-new")],
      pushed: true,
    });
    expect(await teammates()).toEqual(before);
    // "Turn off and delete" is the owner's own tool's switch.
    await (await signInAsOwner(t)).mutation(api.workTools.turnOff, { source: "gmail" });
    expect(await teammates()).toEqual(before);
    expect(await held(t, "OWNER")).toEqual(["fireflies", "google_calendar", "linear"]);
  });
});

describe("prune", () => {
  const status = (owner: string, source: MirrorSource, lastOkAt: number) =>
    ({ owner, source, state: "ok", lastRunAt: lastOkAt, lastOkAt }) as const;

  test("a teammate's meeting notes age out 90 days after the meeting, as the owner's do", async () => {
    const t = convexTest(schema, modules);
    await asAda(t);
    await hold(t, "ADA", [meeting("ADA", "old", NOW - 91 * DAY), meeting("ADA", "new", NOW - DAY)]);
    await hold(t, "OWNER", [meeting("OWNER", "old", NOW - 91 * DAY), meeting("OWNER", "new")]);
    await t.run(async (ctx) => {
      await ctx.db.insert("personalSourceStatus", {
        ...status(ADA, "fireflies", NOW),
        ...(await filedFor(ctx, ADA)),
      });
      await ctx.db.insert("sourceStatus", {
        source: "fireflies",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
    });
    await t.mutation(internal.mirror.prune, {});
    await t.mutation(internal.mirror.prunePersonal, {});
    const left = await t.run(async (ctx) =>
      (await ctx.db.query("mirrorRecords").collect()).map((doc) => [
        doc.owner ?? "the owner",
        doc.externalId,
      ]),
    );
    expect(left).toEqual([
      [ADA, "new"],
      ["the owner", "new"],
    ]);
  });

  test("a tool a teammate has not pushed for 30 days loses what it held, and only theirs", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    await asAda(t);
    await asBen(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("personalSourceStatus", {
        ...status(ADA, "linear", NOW - 31 * DAY),
        ...(await filedFor(ctx, ADA)),
      });
      await ctx.db.insert("personalSourceStatus", {
        ...status(BEN, "linear", NOW - DAY),
        ...(await filedFor(ctx, BEN)),
      });
      await ctx.db.insert("sourceStatus", {
        source: "linear",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
    });
    await t.mutation(internal.mirror.prunePersonal, {});
    expect(await held(t, "ADA")).not.toContain("linear");
    expect(await held(t, "BEN")).toContain("linear");
    expect(await held(t, "OWNER")).toContain("linear");
    const adas = (await personalStatuses(t)).find(
      (row) => row.owner === ADA && row.source === "linear",
    );
    expect(adas?.lastOkAt).toBeUndefined();
  });

  test("what is held for someone no longer a teammate with Today is deleted", async () => {
    const t = convexTest(schema, modules);
    // Ben is on the team with Today; Ada was never added (rows left by some
    // other road). She has records and a status row, and no token.
    await asBen(t);
    await seedAll(t);
    await t.mutation(internal.mirror.prunePersonal, {});
    expect(await held(t, "ADA")).toEqual([]);
    expect((await personalStatuses(t)).map((row) => row.owner)).toEqual([BEN]);
    // Ben's mail was pushed three days ago and stays.
    expect(await held(t, "BEN")).toContain("gmail");
  });

  test("a token left for someone who may no longer push is deleted, with whatever they held", async () => {
    const t = convexTest(schema, modules);
    await asBen(t);
    await hold(t, "ADA", [mail("ADA")]);
    await hold(t, "BEN", [mail("BEN")]);
    // No status row for either: only the tokens say they are there.
    await t.run(async (ctx) => {
      await ctx.db.insert("personalTokens", { owner: ADA, tokenHash: "0".repeat(64), createdAt: NOW });
      await ctx.db.insert("personalTokens", {
        ...(await filedFor(ctx, BEN)),
        tokenHash: "1".repeat(64),
        createdAt: NOW,
      });
    });
    await t.mutation(internal.mirror.prunePersonal, {});
    expect((await tokens(t)).map((row) => row.owner)).toEqual([BEN]);
    expect(await held(t, "ADA")).toEqual([]);
    expect(await held(t, "BEN")).toEqual(["gmail"]);
  });
});

describe("personal records belong to the person, not to the address", () => {
  const CEE = "cee.teammate@gmail.com";
  /** What Google says of a consumer account: the address, verified. */
  const google = (email: string) => ({
    email,
    emailVerified: true,
    name: "Made-up Name",
    ...(email.endsWith("@gmail.com") ? null : { hostedDomain: email.split("@")[1] }),
  });
  /** A sign-in as Convex Auth runs it: the callback, then a session for the user it names. */
  async function googleSignIn(t: TestBackend, existingUserId: Id<"users"> | null, email: string) {
    const { userId, sessionId } = await t.run(async (ctx) => {
      const userId = await resolveOwnerUser(ctx.db, { existingUserId, profile: google(email) });
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: NOW + DAY,
      });
      return { userId, sessionId };
    });
    return { userId, client: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
  }
  const userOf = (t: TestBackend, email: string) =>
    t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      return user!._id;
    });
  /** The users row behind an address deleted, with its sessions: how an address is moved to another Google account. */
  const deleteUser = (t: TestBackend, userId: Id<"users">) =>
    t.run(async (ctx) => {
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .collect();
      for (const session of sessions) await ctx.db.delete(session._id);
      await ctx.db.delete(userId);
    });
  /** Ada, signed in through Google, with a token and one of everything sent with it. */
  async function adaSends(t: TestBackend) {
    await addMember(t, { email: ADA, role: "engineer", companies: ["us"], areas: TODAY });
    const ada = await googleSignIn(t, null, ADA);
    const { token } = await ada.client.mutation(api.connect.createToken, { entropy: ENTROPY });
    const tokenHash = await hashToken(token);
    for (const row of [mail("ADA"), event("ADA"), issue("ADA"), meeting("ADA")]) {
      expect(
        await t.mutation(internal.mirror.applyPersonal, {
          tokenHash,
          source: SOURCE_OF[row.kind],
          rows: [row],
        }),
      ).toMatchObject({ ok: true, inserted: 1 });
    }
    return { ...ada, tokenHash };
  }
  const write = (t: TestBackend, tokenHash: string, who: Who = "ADA") =>
    t.mutation(internal.mirror.applyPersonal, {
      tokenHash,
      source: "gmail",
      rows: [mail(who, "new1")],
    });
  const mentions = (t: TestBackend, needle: string) =>
    t.run(async (ctx) => {
      const found: string[] = [];
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        for (const doc of await ctx.db.query(table).collect()) {
          if (JSON.stringify(doc).includes(needle)) found.push(table);
        }
      }
      return [...new Set(found)].sort();
    });
  const NOTHING = {
    owner: false,
    token: null,
    tools: MIRROR_SOURCES.map((source) => ({ source, lastOkAt: null, held: 0 })),
  };

  test("the same identity signing in again keeps everything", async () => {
    const t = convexTest(schema, modules);
    const ada = await adaSends(t);
    const again = await googleSignIn(t, ada.userId, ADA);
    expect(again.userId).toBe(ada.userId);
    const sent = await everythingSentTo(again.client);
    for (const kind of ["SUBJECT", "EVENT", "MEETING", "ISSUE"]) {
      expect(sent).toContain(`SECRET ADA ${kind}`);
    }
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
    expect((await again.client.query(api.connect.status, {})).token).not.toBeNull();
    expect(await t.query(internal.connect.knows, { tokenHash: ada.tokenHash })).toBe(true);
    expect(await write(t, ada.tokenHash)).toMatchObject({ ok: true });
  });

  test("another Google identity that takes over the address sees nothing, the old token is refused, and the rows are gone", async () => {
    const t = convexTest(schema, modules);
    const ada = await adaSends(t);
    await deleteUser(t, ada.userId);
    // Before anybody signs in again, the token already names nobody.
    expect(await t.query(internal.connect.knows, { tokenHash: ada.tokenHash })).toBe(false);
    expect(await write(t, ada.tokenHash)).toEqual({ ok: false, reason: "unauthorized" });

    const next = await googleSignIn(t, null, ADA);
    expect(next.userId).not.toBe(ada.userId);
    expect(await everythingSentTo(next.client)).not.toContain("SECRET");
    expect(await next.client.query(api.connect.status, {})).toEqual(NOTHING);
    // Nothing of the first person is stored any more, in any table.
    expect(await held(t, "ADA")).toEqual([]);
    expect(await tokens(t)).toEqual([]);
    expect(await personalStatuses(t)).toEqual([]);
    expect(await mentions(t, "SECRET ADA")).toEqual([]);
    // The old token feeds nobody's Today.
    expect(await t.query(internal.connect.knows, { tokenHash: ada.tokenHash })).toBe(false);
    expect(await write(t, ada.tokenHash)).toEqual({ ok: false, reason: "unauthorized" });
    expect(
      await t.mutation(internal.connect.admit, { tokenHash: ada.tokenHash, source: "gmail" }),
    ).toBe("unauthorized");
    expect(await held(t, "ADA")).toEqual([]);
    // The new holder of the address starts from nothing, with a token of their own.
    const mine = await next.client.mutation(api.connect.createToken, { entropy: ENTROPY });
    expect(await write(t, await hashToken(mine.token), "BEN")).toMatchObject({
      ok: true,
      inserted: 1,
    });
    expect(await everythingSentTo(next.client)).not.toContain("SECRET ADA");
  });

  test("an identity whose address changes leaves what it sent behind: nothing follows it, and nothing waits for it", async () => {
    const t = convexTest(schema, modules);
    const ada = await adaSends(t);
    // The owner adds the new address. Rows someone else once sent under it are still stored.
    await addMember(t, { email: CEE, role: "engineer", companies: ["us"], areas: TODAY });
    await t.run(async (ctx) => {
      const stranger = await ctx.db.insert("users", {});
      const record = { ...mail("BEN", "old1"), subject: "SECRET LEFTOVER SUBJECT" };
      await ctx.db.insert("mirrorRecords", {
        owner: CEE,
        userId: stranger,
        source: "gmail",
        ...keyOf(record),
        syncedAt: NOW,
        record,
      });
      await ctx.db.insert("personalSourceStatus", {
        owner: CEE,
        userId: stranger,
        source: "gmail",
        state: "ok",
        lastOkAt: NOW - 5,
      });
    });

    const moved = await googleSignIn(t, ada.userId, CEE);
    expect(moved.userId).toBe(ada.userId);
    expect(await everythingSentTo(moved.client)).not.toContain("SECRET");
    expect(await t.run((ctx) => ctx.db.query("mirrorRecords").collect())).toEqual([]);
    expect(await tokens(t)).toEqual([]);
    expect(await personalStatuses(t)).toEqual([]);
    expect(await write(t, ada.tokenHash)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await t.query(internal.connect.knows, { tokenHash: ada.tokenHash })).toBe(false);
  });

  // The three below hold whatever sign-in did or did not delete: each read and
  // each write asks whose the row is, not only which address it is under.

  test("rows under the caller's address that another identity sent are never sent to the caller", async () => {
    const t = convexTest(schema, modules);
    const ada = await adaSends(t);
    await deleteUser(t, ada.userId);
    // A users row made by another road than sign-in: nothing was deleted.
    const next = await signInAs(t, { email: ADA, emailVerificationTime: 1 });
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
    expect(await everythingSentTo(next)).not.toContain("SECRET");
    expect(await next.query(api.connect.status, {})).toEqual(NOTHING);
    expect(await t.query(internal.connect.knows, { tokenHash: ada.tokenHash })).toBe(false);
    expect(await write(t, ada.tokenHash)).toEqual({ ok: false, reason: "unauthorized" });
    expect(
      await t.mutation(internal.connect.admit, { tokenHash: ada.tokenHash, source: "gmail" }),
    ).toBe("unauthorized");
  });

  test("the new identity's first write removes what the old one left under the address, and its status is its own", async () => {
    const t = convexTest(schema, modules);
    const ada = await adaSends(t);
    await deleteUser(t, ada.userId);
    const next = await signInAs(t, { email: ADA, emailVerificationTime: 1 });
    const mine = await next.mutation(api.connect.createToken, { entropy: ENTROPY });
    // Fireflies only accumulates: the old identity's note must still not stay.
    expect(
      await t.mutation(internal.mirror.applyPersonal, {
        tokenHash: await hashToken(mine.token),
        source: "fireflies",
        rows: [{ ...meeting("BEN", "mine-1"), title: "Made-up call of my own" }],
      }),
    ).toEqual({ ok: true, inserted: 1, updated: 0, unchanged: 0 });
    const notes = await next.query(api.workTools.meetings, {});
    expect(notes.meetings.map((note) => note.meetingId)).toEqual(["mine-1"]);
    const stored = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
    expect(
      stored.filter((doc) => doc.source === "fireflies").map((doc) => doc.externalId),
    ).toEqual(["mine-1"]);
    const userId = await userOf(t, ADA);
    expect(stored.find((doc) => doc.externalId === "mine-1")).toMatchObject({ owner: ADA, userId });
    const status = (await personalStatuses(t)).filter((row) => row.source === "fireflies");
    expect(status).toMatchObject([{ owner: ADA, userId, state: "ok", lastOkAt: NOW }]);
    expect(status).toHaveLength(1);
  });

  test("a row with no person on it is nobody's: not sent, not honoured, and prune deletes it", async () => {
    const t = convexTest(schema, modules);
    const ada = await signInAsMember(t, "engineer", ["us"], ADA, TODAY);
    const token = `sos_${"fake-legacy-row-token-".repeat(3).slice(0, 43)}`;
    const tokenHash = await hashToken(token);
    await t.run(async (ctx) => {
      await ctx.db.insert("mirrorRecords", {
        owner: ADA,
        source: "gmail",
        ...keyOf(mail("ADA")),
        syncedAt: NOW,
        record: mail("ADA"),
      });
      await ctx.db.insert("personalSourceStatus", {
        owner: ADA,
        source: "gmail",
        state: "ok",
        lastOkAt: NOW,
      });
      await ctx.db.insert("personalTokens", { owner: ADA, tokenHash, createdAt: NOW });
      // The owner's rows carry no person either.
      await ctx.db.insert("mirrorRecords", {
        source: "gmail",
        ...keyOf(mail("OWNER")),
        syncedAt: NOW,
        record: mail("OWNER"),
      });
      await ctx.db.insert("sourceStatus", {
        source: "gmail",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
    });
    expect(await everythingSentTo(ada)).not.toContain("SECRET");
    expect((await ada.query(api.connect.status, {})).token).toBeNull();
    expect(await t.query(internal.connect.knows, { tokenHash })).toBe(false);
    expect(await write(t, tokenHash)).toEqual({ ok: false, reason: "unauthorized" });
    await t.mutation(internal.mirror.prunePersonal, {});
    expect(await held(t, "ADA")).toEqual([]);
    expect(await tokens(t)).toEqual([]);
    expect(await personalStatuses(t)).toEqual([]);
    // The owner's are never touched by any of this.
    expect(await held(t, "OWNER")).toEqual(["gmail"]);
  });

  test("the owner's shared rows are untouched by a sign-in, the owner's own included", async () => {
    const t = convexTest(schema, modules);
    await hold(t, "OWNER", [mail("OWNER"), event("OWNER"), issue("OWNER"), meeting("OWNER")]);
    const ada = await adaSends(t);
    const owner = await googleSignIn(t, null, OWNER);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);
    expect(await everythingSentTo(owner.client)).toContain("SECRET OWNER SUBJECT");
    await deleteUser(t, ada.userId);
    await googleSignIn(t, null, ADA);
    expect(await held(t, "ADA")).toEqual([]);
    expect(await held(t, "OWNER")).toEqual(ALL_FOUR);
  });
});

describe("the personal sweep works within a budget, apart from the owner's retention", () => {
  const leftBehind = (n: number) => `left.behind.${n}@gmail.com`;
  /**
   * People who are no longer on the team, by a road that deleted nothing:
   * each still has a token, a status row and `each` threads.
   */
  async function backlog(t: TestBackend, people: number, each: number) {
    await t.run(async (ctx) => {
      for (let p = 0; p < people; p += 1) {
        const owner = leftBehind(p);
        const userId = await ctx.db.insert("users", { email: owner, emailVerificationTime: 1 });
        await ctx.db.insert("personalTokens", {
          owner,
          userId,
          tokenHash: p.toString(16).padStart(64, "0"),
          createdAt: NOW,
        });
        await ctx.db.insert("personalSourceStatus", {
          owner,
          userId,
          source: "gmail",
          state: "ok",
          lastRunAt: NOW,
          lastOkAt: NOW,
        });
        for (let n = 0; n < each; n += 1) {
          const record = mail("ADA", `aa${p.toString(16)}${n.toString(16).padStart(3, "0")}`);
          await ctx.db.insert("mirrorRecords", {
            owner,
            userId,
            source: "gmail",
            ...keyOf(record),
            syncedAt: NOW,
            record,
          });
        }
      }
    });
  }
  const personalRows = (t: TestBackend) =>
    t.run(async (ctx) => ({
      records: (await ctx.db.query("mirrorRecords").collect()).filter(
        (doc) => doc.owner !== undefined,
      ).length,
      tokens: (await ctx.db.query("personalTokens").collect()).length,
      statuses: (await ctx.db.query("personalSourceStatus").collect()).length,
    }));
  const scheduled = (t: TestBackend) =>
    t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
  /** Every timer, not only the clock: the sweep schedules its own next run. */
  const allTimers = () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  };

  test("the owner's retention touches nothing of a teammate's, and is done whatever is waiting there", async () => {
    const t = convexTest(schema, modules);
    await backlog(t, 5, 8);
    await hold(t, "OWNER", [meeting("OWNER", "old", NOW - 91 * DAY), meeting("OWNER", "new")]);
    await hold(t, "OWNER", [issue("OWNER")]);
    await t.run(async (ctx) => {
      await ctx.db.insert("sourceStatus", {
        source: "fireflies",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
      await ctx.db.insert("sourceStatus", {
        source: "linear",
        state: "ok",
        lastRunAt: NOW - 31 * DAY,
        lastOkAt: NOW - 31 * DAY,
      });
      await ctx.db.insert("oauthStates", { state: "expired", verifier: "v", expiresAt: NOW - 1 });
    });
    const before = await personalRows(t);
    expect(before).toEqual({ records: 40, tokens: 5, statuses: 5 });

    expect(await t.mutation(internal.mirror.prune, {})).toBe(2);
    // The owner's own: the old note and the dead source's issue went, with the expired attempt.
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("mirrorRecords").collect())
          .filter((doc) => doc.owner === undefined)
          .map((doc) => doc.externalId),
      ),
    ).toEqual(["new"]);
    expect(await t.run((ctx) => ctx.db.query("oauthStates").collect())).toEqual([]);
    // Nobody's personal rows were read or deleted by it, and it started nothing.
    expect(await personalRows(t)).toEqual(before);
    expect(await scheduled(t)).toBe(0);
  });

  test("a large backlog is cleared over several runs, each within its budget", async () => {
    allTimers();
    const t = convexTest(schema, modules);
    await asBen(t);
    await hold(t, "BEN", [mail("BEN"), meeting("BEN")]);
    await backlog(t, 6, 12);
    await t.run(async (ctx) => {
      await ctx.db.insert("personalSourceStatus", {
        ...(await filedFor(ctx, BEN)),
        source: "gmail",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
    });
    const budget = { people: 2, docs: 10, bytes: 1_000_000_000 };

    const first = await t.mutation(internal.mirror.prunePersonal, { budget });
    expect(first.more).toBe(true);
    // No more went than the run may delete, and most of it is still waiting.
    const after = await personalRows(t);
    expect(72 + 2 - after.records).toBe(first.removed);
    expect(first.removed).toBeGreaterThan(0);
    expect(first.removed).toBeLessThanOrEqual(budget.docs);
    // It asked for its own next run, with nothing in the request that names anyone.
    const queued = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued)).not.toContain("gmail.com");
    expect(JSON.stringify(queued)).not.toContain("SECRET");

    await finishScheduled(t);
    // All of it is gone, over more runs than one; who may still hold theirs was left alone.
    expect(await scheduled(t)).toBeGreaterThan(6);
    expect(await personalRows(t)).toEqual({ records: 2, tokens: 0, statuses: 1 });
    expect(await held(t, "BEN")).toEqual(["fireflies", "gmail"]);
  });

  test("a run stops at its people and its bytes too", async () => {
    allTimers();
    const t = convexTest(schema, modules);
    await backlog(t, 4, 3);
    const one = await t.mutation(internal.mirror.prunePersonal, {
      budget: { people: 1, docs: 1000, bytes: 1_000_000_000 },
    });
    expect(one).toEqual({ removed: 3, more: true });
    expect(await personalRows(t)).toEqual({ records: 9, tokens: 3, statuses: 3 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await personalRows(t)).toEqual({ records: 0, tokens: 0, statuses: 0 });

    const s = convexTest(schema, modules);
    await backlog(s, 2, 3);
    const small = await s.mutation(internal.mirror.prunePersonal, {
      budget: { people: 100, docs: 1000, bytes: 1 },
    });
    expect(small.more).toBe(true);
    expect((await personalRows(s)).records).toBeGreaterThan(0);
    await finishScheduled(s);
    expect(await personalRows(s)).toEqual({ records: 0, tokens: 0, statuses: 0 });
  });

  test("a tool gone quiet loses its records over several runs, and its 'last received' only with the last of them", async () => {
    allTimers();
    const t = convexTest(schema, modules);
    await asAda(t);
    await hold(
      t,
      "ADA",
      Array.from({ length: 25 }, (_, n) => mail("ADA", `ab${n.toString(16).padStart(2, "0")}`)),
    );
    await hold(t, "ADA", [meeting("ADA", "old", NOW - 91 * DAY), meeting("ADA", "new")]);
    await t.run(async (ctx) => {
      for (const [source, lastOkAt] of [
        ["gmail", NOW - 31 * DAY],
        ["fireflies", NOW],
      ] as const) {
        await ctx.db.insert("personalSourceStatus", {
          ...(await filedFor(ctx, ADA)),
          source,
          state: "ok",
          lastRunAt: lastOkAt,
          lastOkAt,
        });
      }
    });
    const first = await t.mutation(internal.mirror.prunePersonal, {
      budget: { people: 5, docs: 10, bytes: 1_000_000_000 },
    });
    expect(first).toEqual({ removed: 10, more: true });
    const gmail = () =>
      t.run(async (ctx) => ({
        held: (await ctx.db.query("mirrorRecords").collect()).filter((d) => d.source === "gmail")
          .length,
        status: (await ctx.db.query("personalSourceStatus").collect()).find(
          (row) => row.source === "gmail",
        ),
      }));
    expect(await gmail()).toMatchObject({ held: 15, status: { lastOkAt: NOW - 31 * DAY } });
    await finishScheduled(t);
    const done = await gmail();
    expect(done.held).toBe(0);
    expect(done.status).toBeDefined();
    expect(done.status?.lastOkAt).toBeUndefined();
    // The meeting-note rule ran in a later run of the same sweep.
    expect(await held(t, "ADA")).toEqual(["fireflies"]);
    expect(await tokens(t)).toEqual([]);
  });

  test("with no owner configured the sweep still deletes nobody", async () => {
    const t = convexTest(schema, modules);
    await backlog(t, 3, 2);
    vi.stubEnv("OWNER_EMAILS", "");
    expect(await t.mutation(internal.mirror.prunePersonal, {})).toEqual({ removed: 0, more: false });
    expect(await personalRows(t)).toEqual({ records: 6, tokens: 3, statuses: 3 });
  });
});

describe("whose rows a caller reads", () => {
  const userId = "10001;users" as Id<"users">;
  const member = (role: Member["role"], email: string | undefined): Member => ({
    user: { _id: userId, _creationTime: 1, ...(email === undefined ? {} : { email }) },
    role,
    companies: ["us"],
    areas: ["today"],
  });

  test("a teammate with no address on record is refused, never answered with the owner's rows", () => {
    for (const email of [undefined, "", "   "]) {
      for (const role of ["cofounder", "sales", "engineer"] as const) {
        expect(() => holderOf(member(role, email))).toThrow(NOT_ALLOWED);
      }
    }
  });

  test("a teammate is their own address, lower-cased, and their own users row; only the owner is the owner", () => {
    expect(holderOf(member("engineer", "  Ada.Teammate@Gmail.com "))).toEqual({
      kind: "teammate",
      email: ADA,
      userId,
    });
    expect(holderOf(member("owner", OWNER))).toEqual({ kind: "owner" });
  });
});

describe("the personal write keeps the rules itself, whoever calls it", () => {
  async function adasHash(t: TestBackend) {
    const ada = await asAda(t);
    return hashToken((await ada.mutation(api.connect.createToken, { entropy: ENTROPY })).token);
  }
  const write = (t: TestBackend, tokenHash: string, source: MirrorSource, rows: MirrorRecord[]) =>
    t.mutation(internal.mirror.applyPersonal, { tokenHash, source, rows });

  test("rows the cleaners would never let through are refused in counts, and nothing is stored", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = await adasHash(t);
    await hold(t, "ADA", [mail("ADA", "kept")]);
    const bad: [MirrorSource, MirrorRecord[]][] = [
      // Another tool's kind of record.
      ["gmail", [event("ADA")]],
      // The same id twice.
      ["gmail", [mail("ADA", "aa01"), mail("ADA", "aa01")]],
      // Text over its limit, and text with a line break in it.
      ["gmail", [{ ...mail("ADA"), subject: `SECRET ${"x".repeat(300)}` }]],
      ["fireflies", [{ ...meeting("ADA"), overview: "SECRET line one\nline two" }]],
      // A link that is not Linear's.
      ["linear", [{ ...issue("ADA"), url: "https://secret.example.test/SECRET" }]],
      // No id.
      ["google_calendar", [{ ...event("ADA"), eventId: "" }]],
    ];
    for (const [source, rows] of bad) {
      const refused = await write(t, tokenHash, source, rows).then(
        () => "stored",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refused).toContain("broke the size and shape rules, so nothing was written");
      expect(refused).not.toContain("SECRET");
      expect(refused).not.toContain("secret.");
      expect(refused).not.toContain(ADA);
    }
    // What Ada held is as it was: a refused list replaces nothing.
    expect(await t.run(async (ctx) => (await ctx.db.query("mirrorRecords").collect()).map((doc) => doc.externalId))).toEqual(["kept"]);
    expect(await personalStatuses(t)).toEqual([]);
  });

  test("it is refused before the token is looked at: a bad batch learns nothing about a token", async () => {
    const t = convexTest(schema, modules);
    await expect(write(t, "0".repeat(64), "gmail", [event("ADA")])).rejects.toThrow(
      "1 of 1 records broke the size and shape rules, so nothing was written.",
    );
  });
});

describe("an address that became an owner's", () => {
  test("what it held as a teammate is never read as the owner's, and the next sweep deletes it", async () => {
    const t = convexTest(schema, modules);
    await hold(t, "OWNER", [mail("OWNER"), issue("OWNER")]);
    const ada = await asAda(t);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    const tokenHash = await hashToken(token);
    for (const row of [mail("ADA"), event("ADA"), issue("ADA"), meeting("ADA")]) {
      await t.mutation(internal.mirror.applyPersonal, {
        tokenHash,
        source: SOURCE_OF[row.kind],
        rows: [row],
      });
    }
    await asBen(t);
    await hold(t, "BEN", [mail("BEN")]);
    await t.run(async (ctx) => {
      await ctx.db.insert("personalSourceStatus", {
        ...(await filedFor(ctx, BEN)),
        source: "gmail",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
    });

    vi.stubEnv("OWNER_EMAILS", `${OWNER},${ADA}`);
    // Ada is an owner now: she reads the shared rows, and her old ones reach nobody.
    const sent = await everythingSentTo(ada);
    expect(sent).toContain("SECRET OWNER SUBJECT");
    expect(sent).not.toContain("SECRET ADA");
    expect(await t.query(internal.connect.knows, { tokenHash })).toBe(false);
    // They sit there until the sweep.
    expect(await held(t, "ADA")).toEqual(ALL_FOUR);

    expect(await t.mutation(internal.mirror.prunePersonal, {})).toEqual({ removed: 4, more: false });
    expect(await held(t, "ADA")).toEqual([]);
    expect((await tokens(t)).map((row) => row.owner)).toEqual([]);
    expect((await personalStatuses(t)).map((row) => row.owner)).toEqual([BEN]);
    // The shared rows and the other teammate's are as they were.
    expect(await held(t, "OWNER")).toEqual(["gmail", "linear"]);
    expect(await held(t, "BEN")).toEqual(["gmail"]);
  });
});
