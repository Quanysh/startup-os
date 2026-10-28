import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_INGEST_BYTES } from "./lib/ingestSchema";
import { CAPS, MIRROR_SOURCES, type MirrorSource } from "./lib/mirrorRules";
import {
  MAX_PUSHES_PER_WINDOW,
  NOT_A_PERSONAL_TOOL_WORDS,
  PERSONAL_BYTES,
  PERSONAL_CAPS,
  PUSH_WINDOW_MS,
  RECORDS_ONLY_WORDS,
  TOO_MANY_PUSHES_WORDS,
  hashToken,
  tooManyRecordsWords,
  tooMuchDataWords,
} from "./lib/personalRules";
import type { GrantableArea } from "./lib/roles";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner, type TestBackend } from "./test.setup";

// POST /ingest/v1 with a teammate's personal token. Every name, address,
// subject and title is made up, and what must never be echoed, logged or
// shown to anyone else carries the word SECRET.

const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;
const ADA = "ada.teammate@gmail.com";
const BEN = "ben.teammate@gmail.com";
// Obviously not real secrets.
const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";
const SOURCE_TOKENS: Record<MirrorSource, string> = {
  gmail: "fake-gmail-push-token-0123456789-abcdefgh",
  google_calendar: "fake-calendar-push-token-0123456789-abcde",
  linear: "fake-linear-push-token-0123456789-abcdefg",
  fireflies: "fake-fireflies-push-token-0123456789-abcd",
};
const UNKNOWN_PERSONAL = `sos_${"fake-unknown-token-".repeat(3).slice(0, 43)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  for (const [source, token] of Object.entries(SOURCE_TOKENS)) {
    vi.stubEnv(`INGEST_TOKEN_${source.toUpperCase()}`, token);
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const mail = (threadId: string, over: Record<string, unknown> = {}) => ({
  threadId,
  fromName: "SECRET Sender",
  fromAddress: "secret.sender@example.test",
  subject: "SECRET subject",
  lastMessageAt: "2026-10-11T15:04:05Z",
  ...over,
});
const event = (eventId: string, over: Record<string, unknown> = {}) => ({
  eventId,
  title: "SECRET meeting",
  startsAt: "2026-10-13T09:00:00Z",
  endsAt: "2026-10-13T09:30:00Z",
  attendees: [{ name: "SECRET Guest", address: "secret.guest@example.test" }],
  ...over,
});
const issue = (issueId: string, over: Record<string, unknown> = {}) => ({
  issueId,
  identifier: "ENG-1",
  title: "SECRET issue",
  url: "https://linear.app/example/issue/ENG-1/made-up",
  stateType: "started",
  teamName: "Engineering",
  mine: true,
  updatedAt: "2026-10-12T05:00:00Z",
  ...over,
});
const meeting = (meetingId: string, over: Record<string, unknown> = {}) => ({
  meetingId,
  title: "SECRET call",
  heldAt: "2026-10-10T16:00:00Z",
  overview: "SECRET summary.",
  actionItems: ["SECRET action item"],
  ...over,
});

const envelope = (source: string, records: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  source,
  batchId: "batch-SECRET",
  observedAt: "2026-10-12T06:00:00Z",
  records,
  ...extra,
});

type Reply = { status: number; text: string; json: () => unknown };
async function post(t: TestBackend, body: unknown, token: string): Promise<Reply> {
  const response = await t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}
const push = (
  t: TestBackend,
  token: string,
  source: string,
  records: unknown[],
  extra: Record<string, unknown> = {},
) => post(t, envelope(source, records, extra), token);

const TODAY: GrantableArea[] = ["today"];
/** A teammate with Today, signed in, and the token they made. */
async function connect(t: TestBackend, email: string, areas: GrantableArea[] = TODAY) {
  const client = await signInAsMember(t, "engineer", ["us"], email, areas);
  const { token } = await client.mutation(api.connect.createToken, { entropy: ENTROPY });
  return { client, token };
}

const records = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const idsOf = async (t: TestBackend, owner: string | undefined, source?: MirrorSource) =>
  (await records(t))
    .filter((doc) => doc.owner === owner && (source === undefined || doc.source === source))
    .map((doc) => doc.externalId)
    .sort();
const shared = (t: TestBackend) =>
  t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    status: await ctx.db.query("sourceStatus").collect(),
  }));
const personalStatus = (t: TestBackend, owner: string, source: MirrorSource) =>
  t.run(async (ctx) =>
    ctx.db
      .query("personalSourceStatus")
      .withIndex("by_owner_and_source", (q) => q.eq("owner", owner).eq("source", source))
      .unique(),
  );
/** Every row of every table, as one string to search. */
const everything = (t: TestBackend) =>
  t.run(async (ctx) => {
    const all: unknown[] = [];
    for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
      all.push(...(await ctx.db.query(table).collect()));
    }
    return JSON.stringify(all);
  });

const UNAUTHORIZED = '{"ok":false,"error":"unauthorized"}';

describe("a personal token: each tool's happy path", () => {
  test.each([
    ["gmail", [mail("18c2f0a1"), mail("18c2f0a2")], "mail"],
    ["google_calendar", [event("evt-1"), event("evt-2")], "event"],
    ["linear", [issue("iss-1"), issue("iss-2")], "issue"],
    ["fireflies", [meeting("meet-1"), meeting("meet-2")], "meeting"],
  ] as const)("%s is stored as that person's own", async (source, rows, kind) => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const response = await push(t, token, source, [...rows]);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0 });
    const stored = await records(t);
    expect(stored).toHaveLength(2);
    for (const doc of stored) {
      expect(doc).toMatchObject({ owner: ADA, source, record: { kind } });
    }
    expect(await personalStatus(t, ADA, source)).toMatchObject({
      state: "ok",
      lastOkAt: NOW,
      lastRunAt: NOW,
      pushes: 1,
    });
    // Nothing in the deployment's run log or source status: the owner reads those.
    expect(await shared(t)).toEqual({ runs: [], status: [] });
  });

  test("the person then reads it on their own Today, and nobody else does", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    await push(t, ada.token, "gmail", [mail("18c2f0a1")]);
    const adas = await ada.client.query(api.workTools.needsReply, {});
    expect(adas.threads.map((thread) => thread.subject)).toEqual(["SECRET subject"]);
    expect(adas.source).toEqual({ state: "ok", message: null, lastOkAt: NOW });
    expect((await ben.client.query(api.workTools.needsReply, {})).threads).toEqual([]);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.workTools.needsReply, {})).toEqual({
      source: { state: null, message: null, lastOkAt: null },
      threads: [],
    });
    // Settings → Sources says nothing happened: no source has a status at all.
    const sources = await owner.query(api.sources.list, {});
    expect(sources.every((source) => source.status === null)).toBe(true);
    expect(JSON.stringify(sources)).not.toContain("SECRET subject");
    expect(await owner.query(api.sources.recentRuns, {})).toEqual([]);
  });

  test("the token's last use is recorded, and the token itself is stored nowhere", async () => {
    const t = convexTest(schema, modules);
    const { client, token } = await connect(t, ADA);
    vi.setSystemTime(NOW + 5000);
    await push(t, token, "gmail", [mail("18c2f0a1")]);
    expect((await client.query(api.connect.status, {})).token).toEqual({
      createdAt: NOW,
      lastUsedAt: NOW + 5000,
    });
    const all = await everything(t);
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.slice(4));
    // Nor the sender's own label for the push.
    expect(all).not.toContain("batch-SECRET");
  });

  test("it works with no source token configured at all", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OWNER_EMAILS", OWNER);
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    expect((await push(t, token, "gmail", [mail("18c2f0a1")])).status).toBe(200);
    // What a source's token is answered with is as it was.
    const other = await post(t, envelope("gmail", [mail("18c2f0a1")]), "not-a-personal-token");
    expect(other.status).toBe(503);
    expect(other.text).toBe('{"ok":false,"error":"ingest_not_configured"}');
  });
});

describe("a personal push is scoped to its person", () => {
  test("replacing a list replaces that person's list only", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    // The same thread ids for all three.
    await post(t, envelope("gmail", [mail("aa01"), mail("aa02")]), SOURCE_TOKENS.gmail);
    await push(t, ben.token, "gmail", [mail("aa01"), mail("aa02")]);
    await push(t, ada.token, "gmail", [mail("aa01"), mail("aa02")]);
    const before = (await records(t)).filter((doc) => doc.owner !== ADA);

    const response = await push(t, ada.token, "gmail", [
      mail("aa02", { subject: "SECRET changed" }),
      mail("aa03"),
    ]);
    expect(response.json()).toEqual({ ok: true, inserted: 1, updated: 1, unchanged: 0 });
    expect(await idsOf(t, ADA)).toEqual(["aa02", "aa03"]);
    expect(await idsOf(t, BEN)).toEqual(["aa01", "aa02"]);
    expect(await idsOf(t, undefined)).toEqual(["aa01", "aa02"]);
    expect((await records(t)).filter((doc) => doc.owner !== ADA)).toEqual(before);
  });

  test("an empty inbox clears that person's list only", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    await post(t, envelope("gmail", [mail("aa01")]), SOURCE_TOKENS.gmail);
    await push(t, ben.token, "gmail", [mail("aa01")]);
    await push(t, ada.token, "gmail", [mail("aa01")]);
    const response = await push(t, ada.token, "gmail", [], { empty: true });
    expect(response.status).toBe(200);
    expect(await idsOf(t, ADA)).toEqual([]);
    expect(await idsOf(t, BEN)).toEqual(["aa01"]);
    expect(await idsOf(t, undefined)).toEqual(["aa01"]);
  });

  test("the shared Linear board is untouched by a teammate's own issues", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA, ["today", "board"]);
    await post(
      t,
      envelope("linear", [
        issue("shared-1", { title: "Shared board issue", mine: false }),
        issue("shared-2", { title: "Shared board issue two", mine: true }),
      ]),
      SOURCE_TOKENS.linear,
    );
    const owner = await signInAsOwner(t);
    const boardBefore = await owner.query(api.workTools.issues, {});
    const sharedBefore = await shared(t);
    const rowsBefore = (await records(t)).filter((doc) => doc.owner === undefined);

    // Ada's whole list: one issue, under an id the board also uses.
    const response = await push(t, ada.token, "linear", [issue("shared-1", { title: "SECRET mine" })]);
    expect(response.status).toBe(200);

    expect(await owner.query(api.workTools.issues, {})).toEqual(boardBefore);
    expect(await ada.client.query(api.workTools.issues, {})).toEqual(boardBefore);
    expect(await shared(t)).toEqual(sharedBefore);
    expect((await records(t)).filter((doc) => doc.owner === undefined)).toEqual(rowsBefore);
    // The owner's "my issues" is the board's, flagged; Ada's is what she pushed.
    expect((await owner.query(api.workTools.myIssues, {})).issues.map((i) => i.issueId)).toEqual([
      "shared-2",
    ]);
    expect((await ada.client.query(api.workTools.myIssues, {})).issues.map((i) => i.title)).toEqual([
      "SECRET mine",
    ]);
  });

  test("a push on a source's own token still writes the owner's rows and no teammate's", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    await push(t, ada.token, "google_calendar", [event("evt-1"), event("evt-2")]);
    const response = await post(
      t,
      envelope("google_calendar", [event("evt-9")]),
      SOURCE_TOKENS.google_calendar,
    );
    expect(response.status).toBe(200);
    expect(await idsOf(t, undefined)).toEqual(["evt-9"]);
    expect(await idsOf(t, ADA)).toEqual(["evt-1", "evt-2"]);
  });

  test("meeting notes accumulate for the person, and age out by the meeting's date", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await push(t, token, "fireflies", [meeting("meet-1")]);
    await push(t, token, "fireflies", [meeting("meet-2")]);
    expect(await idsOf(t, ADA)).toEqual(["meet-1", "meet-2"]);
    const old = await push(t, token, "fireflies", [
      meeting("meet-3", { heldAt: new Date(NOW - 91 * DAY).toISOString() }),
    ]);
    expect(old.status).toBe(422);
    expect(await idsOf(t, ADA)).toEqual(["meet-1", "meet-2"]);
  });

  test("the owner's switches are about the owner's own tools", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "gmail" });
    expect((await push(t, token, "gmail", [mail("aa01")])).status).toBe(200);
    expect(await idsOf(t, ADA)).toEqual(["aa01"]);
    // And the owner's own Gmail token is still refused, as before.
    const own = await post(t, envelope("gmail", [mail("aa01")]), SOURCE_TOKENS.gmail);
    expect(own.status).toBe(409);
    expect(await idsOf(t, undefined)).toEqual([]);
  });
});

describe("a token that is not honoured gets the one 401, and changes nothing", () => {
  const refusedLikeAStranger = async (t: TestBackend, token: string) => {
    const before = await everything(t);
    const response = await push(t, token, "gmail", [mail("aa01")]);
    expect(response.status).toBe(401);
    expect(response.text).toBe(UNAUTHORIZED);
    expect(await everything(t)).toBe(before);
  };

  test("an unknown one, exactly as a wrong source token is answered", async () => {
    const t = convexTest(schema, modules);
    await connect(t, ADA);
    await refusedLikeAStranger(t, UNKNOWN_PERSONAL);
    await refusedLikeAStranger(t, "sos_");
    await refusedLikeAStranger(t, "sos_short");
    const stranger = await push(t, "an-unknown-source-token-0123456789", "gmail", [mail("aa01")]);
    expect([stranger.status, stranger.text]).toEqual([401, UNAUTHORIZED]);
  });

  test("an unknown one learns nothing about its body: 401 before anything is read", async () => {
    const t = convexTest(schema, modules);
    await connect(t, ADA);
    const bodies: unknown[] = [
      "{ not json",
      { version: 1 },
      { ...envelope("gmail", [mail("aa01")]), stray: 1 },
      envelope("mercury", [mail("aa01")]),
      envelope("gmail", [mail("aa01", { subject: "x".repeat(MAX_INGEST_BYTES) })]),
    ];
    for (const body of bodies) {
      const response = await post(t, body, UNKNOWN_PERSONAL);
      expect([response.status, response.text]).toEqual([401, UNAUTHORIZED]);
    }
  });

  test("a hash is not a token: the stored hash does not authenticate", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await refusedLikeAStranger(t, `sos_${await hashToken(token)}`);
    await refusedLikeAStranger(t, await hashToken(token));
  });

  test("one that was revoked, and one that was replaced", async () => {
    const t = convexTest(schema, modules);
    const { client, token } = await connect(t, ADA);
    const next = await client.mutation(api.connect.createToken, { entropy: ENTROPY });
    await refusedLikeAStranger(t, token);
    expect((await push(t, next.token, "gmail", [mail("aa01")])).status).toBe(200);
    await client.mutation(api.connect.revokeToken, {});
    await refusedLikeAStranger(t, next.token);
  });

  test("a removed teammate's, and one whose Today was unticked", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN, ["today", "board"]);
    const owner = await signInAsOwner(t);
    const team = await owner.query(api.team.list, {});
    const idOf = (email: string) => team.find((row) => row.email === email)!.id;
    await owner.mutation(api.team.remove, { id: idOf(ADA) });
    await owner.mutation(api.team.update, {
      id: idOf(BEN),
      role: "engineer",
      companies: ["us"],
      areas: ["board"],
    });
    await refusedLikeAStranger(t, ada.token);
    await refusedLikeAStranger(t, ben.token);
    expect(await records(t)).toEqual([]);
  });

  test("a token row under an owner's address: the owner has no personal token", async () => {
    const t = convexTest(schema, modules);
    const token = `sos_${"fake-owner-row-token-".repeat(3).slice(0, 43)}`;
    const tokenHash = await hashToken(token);
    await t.run((ctx) =>
      ctx.db.insert("personalTokens", { owner: OWNER, tokenHash, createdAt: NOW }),
    );
    await refusedLikeAStranger(t, token);
  });

  test("the same hash on two rows authenticates neither", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await signInAsMember(t, "engineer", ["us"], BEN, TODAY);
    const tokenHash = await hashToken(token);
    await t.run((ctx) => ctx.db.insert("personalTokens", { owner: BEN, tokenHash, createdAt: NOW }));
    await refusedLikeAStranger(t, token);
  });
});

describe("what a personal token may carry", () => {
  /** A refusal: its status and error, that it echoes nothing, and that nothing was stored. */
  const refused = async (t: TestBackend, response: Reply, status: number, error: string) => {
    expect(response.status).toBe(status);
    expect(response.json()).toMatchObject({ ok: false, error });
    expect(response.text).not.toContain("SECRET");
    expect(response.text).not.toContain("secret.");
    expect(response.text).not.toContain("@");
    expect(await records(t)).toEqual([]);
    expect(await shared(t)).toEqual({ runs: [], status: [] });
    // What is noted for the person is fixed words too.
    const noted = await t.run((ctx) => ctx.db.query("personalSourceStatus").collect());
    expect(JSON.stringify(noted)).not.toContain("SECRET");
    expect(JSON.stringify(noted)).not.toContain("secret.");
  };
  const header = { version: 1, batchId: "batch-SECRET", observedAt: "2026-10-12T06:00:00Z" };

  test.each([
    ["numbers", { snapshots: [{ key: "cash", scope: "us", period: "day", periodStart: "2026-10-12", value: 1 }] }],
    ["deals", { deals: [{ externalId: "d1", name: "SECRET Co", stage: "Lead" }], mode: "replace" }],
    ["investors", { investors: [{ externalId: "i1", name: "SECRET Fund", stage: "Lead" }] }],
    ["the client register", { customers: [{ name: "SECRET clinic", market: "us", status: "active" }] }],
    ["the plan", { plan: { modelVersion: "a1b2c3d", rows: [{ scenario: "base", year: 2027, key: "arr", value: 1 }] } }],
  ])("%s are refused: records and nothing else", async (_what, body) => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    for (const source of ["gmail", "mercury", "visible", "client_register", "financial_model"]) {
      const response = await post(t, { ...header, source, ...body }, token);
      await refused(t, response, 422, "records_only");
      expect(response.json()).toMatchObject({
        issues: [{ path: "envelope", message: RECORDS_ONLY_WORDS }],
      });
    }
    // No number, pipeline row, clinic or plan figure was written either.
    const written = await t.run(async (ctx) => [
      ...(await ctx.db.query("metricSnapshots").collect()),
      ...(await ctx.db.query("deals").collect()),
      ...(await ctx.db.query("investors").collect()),
      ...(await ctx.db.query("customers").collect()),
      ...(await ctx.db.query("planFigures").collect()),
    ]);
    expect(written).toEqual([]);
  });

  test.each(["mercury", "posthog", "kz_crm", "SECRET-made-up-source"])(
    "records for %s are refused: the four work tools only, and the name is not echoed",
    async (source) => {
      const t = convexTest(schema, modules);
      const { token } = await connect(t, ADA);
      const response = await push(t, token, source, [mail("aa01")]);
      await refused(t, response, 422, "records_not_accepted");
      expect(response.json()).toMatchObject({
        issues: [{ path: "source", message: NOT_A_PERSONAL_TOOL_WORDS }],
      });
    },
  );

  test("a bad row refuses the whole push in paths and fixed words, and what was held stays", async () => {
    const t = convexTest(schema, modules);
    const { client, token } = await connect(t, ADA);
    await push(t, token, "gmail", [mail("aa01")]);
    vi.setSystemTime(NOW + 1000);
    const response = await push(t, token, "gmail", [
      mail("aa02"),
      mail("aa03", { fromAddress: "SECRET not an address", body: "SECRET body" }),
    ]);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    expect(response.text).not.toContain("SECRET");
    expect(await idsOf(t, ADA)).toEqual(["aa01"]);
    expect(await shared(t)).toEqual({ runs: [], status: [] });
    // Said on the person's own status, with the last good push kept.
    expect(await personalStatus(t, ADA, "gmail")).toMatchObject({
      state: "error",
      message: "invalid_records: records.1 — has a field the OS does not accept",
      lastOkAt: NOW,
      lastRunAt: NOW + 1000,
    });
    expect((await client.query(api.workTools.needsReply, {})).source).toEqual({
      state: "error",
      message: "invalid_records: records.1 — has a field the OS does not accept",
      lastOkAt: NOW,
    });
  });

  test("a body, a description, a link or a transcript has no field: the push is refused", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const tries: [MirrorSource, unknown][] = [
      ["gmail", mail("aa01", { snippet: "SECRET snippet" })],
      ["google_calendar", event("evt-1", { description: "SECRET description" })],
      ["google_calendar", event("evt-1", { meetingLink: "https://SECRET.example.test" })],
      ["fireflies", meeting("meet-1", { transcript: "SECRET transcript" })],
      ["linear", issue("iss-1", { description: "SECRET description" })],
    ];
    for (const [source, row] of tries) {
      const response = await push(t, token, source, [row]);
      expect([source, response.status]).toEqual([source, 422]);
      expect(response.text).not.toContain("SECRET");
    }
    expect(await records(t)).toEqual([]);
  });

  test("an empty list is honoured only with empty: true, and only where nothing is a real answer", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await push(t, token, "gmail", [mail("aa01")]);
    await push(t, token, "linear", [issue("iss-1")]);
    await push(t, token, "fireflies", [meeting("meet-1")]);

    const bare = await push(t, token, "gmail", []);
    expect([bare.status, (bare.json() as { error: string }).error]).toEqual([422, "invalid_envelope"]);
    for (const source of ["linear", "fireflies"] as const) {
      const response = await push(t, token, source, [], { empty: true });
      expect([source, response.status]).toEqual([source, 422]);
      expect(response.json()).toMatchObject({ error: "invalid_records", issues: [{ path: "empty" }] });
    }
    // A failed or refused push deleted nothing.
    expect(await idsOf(t, ADA)).toEqual(["aa01", "iss-1", "meet-1"]);
    expect((await push(t, token, "google_calendar", [], { empty: true })).status).toBe(200);
  });

  test("malformed bodies are refused before anything is stored or noted", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const notJson = await post(t, "{ SECRET not json", token);
    expect([notJson.status, notJson.text]).toEqual([400, '{"ok":false,"error":"invalid_json","issues":[]}']);
    const stray = await post(t, { ...envelope("gmail", [mail("aa01")]), "SECRET field": 1 }, token);
    expect(stray.status).toBe(422);
    expect(stray.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [{ path: "envelope", message: "has a field the OS does not accept" }],
    });
    const big = await post(
      t,
      envelope("gmail", [mail("aa01", { subject: "x".repeat(MAX_INGEST_BYTES) })]),
      token,
    );
    expect([big.status, big.text]).toEqual([413, '{"ok":false,"error":"payload_too_large","issues":[]}']);
    expect(await records(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("personalSourceStatus").collect())).toEqual([]);
    expect(await shared(t)).toEqual({ runs: [], status: [] });
  });
});

describe("nothing a sender wrote in the envelope is said back", () => {
  test("an unknown top-level field is answered in fixed words, even with no records beside it", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    // No `records`: only who is sending says that this body may hold a name.
    const { records: _records, ...bare } = envelope("gmail", []);
    const bodies = [
      { ...bare, "SECRET PERSON NAME": 1 },
      { ...bare, "secret.sender@example.test": { "SECRET SUBJECT": true } },
      { ...bare, batchId: { "SECRET NESTED": 1 } },
      { ...bare, version: "SECRET VERSION" },
    ];
    for (const body of bodies) {
      const reply = await post(t, body, token);
      expect(reply.status).toBe(422);
      expect(reply.text).not.toContain("SECRET");
      expect(reply.text).not.toContain("secret.");
      const said = reply.json() as { error: string; issues: { path: string; message: string }[] };
      expect(said.error).toBe("invalid_envelope");
      expect(said.issues.length).toBeGreaterThan(0);
    }
    const stray = (await post(t, bodies[0], token)).json() as { issues: unknown[] };
    expect(stray.issues).toContainEqual({
      path: "envelope",
      message: "has a field the OS does not accept",
    });
    expect(await everything(t)).not.toContain("SECRET");
  });
});

describe("limits for one person", () => {
  test(`a tool takes at most ${MAX_PUSHES_PER_WINDOW} pushes an hour from one token, then 429 in fixed words`, async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    for (let n = 0; n < MAX_PUSHES_PER_WINDOW; n += 1) {
      vi.setSystemTime(NOW + n * 1000);
      expect((await push(t, token, "gmail", [mail(`aa0${n}`)])).status).toBe(200);
    }
    const before = await records(t);
    const over = await push(t, token, "gmail", [mail("bb01")]);
    expect(over.status).toBe(429);
    expect(over.json()).toEqual({
      ok: false,
      error: "too_many_pushes",
      issues: [{ path: "records", message: TOO_MANY_PUSHES_WORDS }],
    });
    // The refused push changed nothing, and what was held is still there.
    expect(await records(t)).toEqual(before);
    expect(await personalStatus(t, ADA, "gmail")).toMatchObject({
      state: "ok",
      pushes: MAX_PUSHES_PER_WINDOW,
    });
    // Another tool has its own count.
    expect((await push(t, token, "google_calendar", [event("evt-1")])).status).toBe(200);
    // An hour after the first push of the window, the tool is open again.
    vi.setSystemTime(NOW + PUSH_WINDOW_MS);
    expect((await push(t, token, "gmail", [mail("bb01")])).status).toBe(200);
    expect(await personalStatus(t, ADA, "gmail")).toMatchObject({
      windowStart: NOW + PUSH_WINDOW_MS,
      pushes: 1,
    });
  });

  test("refused pushes count too, and one person's count is not another's", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    for (let n = 0; n < MAX_PUSHES_PER_WINDOW; n += 1) {
      expect((await push(t, ada.token, "gmail", [mail("not hex")])).status).toBe(422);
    }
    expect((await push(t, ada.token, "gmail", [mail("aa01")])).status).toBe(429);
    expect((await push(t, ben.token, "gmail", [mail("aa01")])).status).toBe(200);
    // A new token does not reset the person's count.
    const next = await ada.client.mutation(api.connect.createToken, { entropy: ENTROPY });
    expect((await push(t, next.token, "gmail", [mail("aa01")])).status).toBe(429);
  });

  test("one push holds at most the person's cap for the tool", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const many = Array.from({ length: PERSONAL_CAPS.gmail + 1 }, (_, n) =>
      mail((0x1000 + n).toString(16)),
    );
    const response = await push(t, token, "gmail", many);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "too_many_records",
      issues: [{ path: "records", message: tooManyRecordsWords("gmail") }],
    });
    expect(await records(t)).toEqual([]);
    expect((await push(t, token, "gmail", many.slice(1))).status).toBe(200);
  });

  test("meeting notes that would pile up past the cap are refused, and what is held stays", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await t.run(async (ctx) => {
      // Ada's own rows: they carry her `users` row as well as her address.
      const ada = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", ADA))
        .unique();
      for (let n = 0; n < PERSONAL_CAPS.fireflies; n += 1) {
        await ctx.db.insert("mirrorRecords", {
          owner: ADA,
          userId: ada!._id,
          source: "fireflies",
          externalId: `held-${n}`,
          sortAt: NOW - DAY,
          syncedAt: NOW,
          record: {
            kind: "meeting",
            meetingId: `held-${n}`,
            title: "Made-up call",
            heldAt: NOW - DAY,
            durationMinutes: 0,
            participants: [],
            overview: "",
            actionItems: [],
          },
        });
      }
    });
    const over = await push(t, token, "fireflies", [meeting("one-more")]);
    expect(over.status).toBe(422);
    expect(over.json()).toMatchObject({
      error: "too_many_records",
      issues: [{ path: "records", message: tooManyRecordsWords("fireflies") }],
    });
    expect(await idsOf(t, ADA)).toHaveLength(PERSONAL_CAPS.fireflies);
    // One already held is an update, not one more.
    expect((await push(t, token, "fireflies", [meeting("held-0")])).status).toBe(200);
  });
});

describe("a ceiling on how much one person holds, in bytes", () => {
  /** A meeting note as large as its fields allow, in plain letters. */
  const fullNote = (meetingId: string) =>
    meeting(meetingId, {
      title: "t".repeat(CAPS.title),
      overview: "o".repeat(CAPS.overview),
      actionItems: Array.from({ length: CAPS.actionItems }, () => "a".repeat(CAPS.actionItem)),
      participants: Array.from({ length: CAPS.people }, (_, n) => ({
        name: "n".repeat(CAPS.name),
        address: `${"p".repeat(200)}${n}@example.test`,
      })),
    });
  /** What a person's stored rows of one tool take, each whole document as JSON in UTF-8. */
  const storedBytesOf = async (t: TestBackend, owner: string, source: MirrorSource) =>
    (await records(t))
      .filter((doc) => doc.owner === owner && doc.source === source)
      .reduce((sum, doc) => sum + new TextEncoder().encode(JSON.stringify(doc)).length, 0);
  /** Push full notes, ten at a time, until one push is refused. Returns that reply. */
  async function fillWithNotes(t: TestBackend, token: string) {
    for (let batch = 0; batch < 40; batch += 1) {
      // A new hour for each push: this is about size, not the hourly limit.
      vi.setSystemTime(NOW + batch * PUSH_WINDOW_MS);
      const notes = Array.from({ length: 10 }, (_, n) => fullNote(`full-${batch}-${n}`));
      const reply = await push(t, token, "fireflies", notes);
      if (reply.status !== 200) return reply;
    }
    throw new Error("never refused");
  }

  test("the four ceilings together stay under 4 MiB for one person", () => {
    const total = MIRROR_SOURCES.reduce((sum, source) => sum + PERSONAL_BYTES[source], 0);
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });

  test("meeting notes that would take a person over the ceiling are refused in fixed words, and what is held stays", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    const over = await fillWithNotes(t, token);
    expect(over.status).toBe(422);
    expect(over.json()).toEqual({
      ok: false,
      error: "too_much_data",
      issues: [{ path: "records", message: tooMuchDataWords("fireflies") }],
    });
    expect(over.text).not.toContain("SECRET");
    const heldIds = await idsOf(t, ADA, "fireflies");
    // Well short of the count cap: it was the size that stopped it.
    expect(heldIds.length).toBeGreaterThan(20);
    expect(heldIds.length).toBeLessThan(PERSONAL_CAPS.fireflies);
    // What is stored really is under the ceiling, counted as whole documents.
    expect(await storedBytesOf(t, ADA, "fireflies")).toBeLessThanOrEqual(PERSONAL_BYTES.fireflies);
    // The refusal is noted for the person, in the same fixed words.
    expect(await personalStatus(t, ADA, "fireflies")).toMatchObject({
      state: "error",
      message: `too_much_data: records — ${tooMuchDataWords("fireflies")}`,
    });
    // One already held, sent again smaller, is a change and not more: it is taken.
    const again = await push(t, token, "fireflies", [meeting(heldIds[0]!)]);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual({ ok: true, inserted: 0, updated: 1, unchanged: 0 });
    // And then there is room for a small new one.
    expect((await push(t, token, "fireflies", [meeting("small-new")])).status).toBe(200);
  });

  test("another person's size is not counted, and the owner's own token has no such ceiling", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    await fillWithNotes(t, ada.token);
    expect((await push(t, ben.token, "fireflies", [fullNote("bens-1")])).status).toBe(200);
    // The deployment's Fireflies token keeps the shared limits it had.
    for (let batch = 0; batch < 12; batch += 1) {
      const notes = Array.from({ length: 10 }, (_, n) => fullNote(`shared-${batch}-${n}`));
      expect((await push(t, SOURCE_TOKENS.fireflies, "fireflies", notes)).status).toBe(200);
    }
    const shared = (await records(t)).filter((doc) => doc.owner === undefined);
    expect(shared).toHaveLength(120);
    expect(
      shared.reduce((sum, doc) => sum + new TextEncoder().encode(JSON.stringify(doc)).length, 0),
    ).toBeGreaterThan(PERSONAL_BYTES.fireflies);
  });

  test("someone at the ceiling is removed from the team in one go, and nothing of theirs is left", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    await fillWithNotes(t, token);
    vi.setSystemTime(NOW);
    expect((await push(t, token, "gmail", [mail("aa01")])).status).toBe(200);
    // All of it can be read in one transaction, several times over.
    const all = (await records(t)).filter((doc) => doc.owner === ADA);
    expect(new TextEncoder().encode(JSON.stringify(all)).length).toBeLessThan(4 * 1024 * 1024);
    const owner = await signInAsOwner(t);
    const team = await owner.query(api.team.list, {});
    await owner.mutation(api.team.remove, { id: team.find((row) => row.email === ADA)!.id });
    expect(await idsOf(t, ADA)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("personalTokens").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("personalSourceStatus").collect())).toEqual([]);
  });

  test("a list that replaces what is held is measured on its own, so a full valid push always fits", async () => {
    const t = convexTest(schema, modules);
    const { token } = await connect(t, ADA);
    // As many issues as one person may hold, each as large as its fields allow.
    const issues = Array.from({ length: PERSONAL_CAPS.linear }, (_, n) =>
      issue(`0a1b2c3d-0000-4000-8000-${n.toString().padStart(12, "0")}`, {
        title: "t".repeat(CAPS.title),
        assigneeName: "a".repeat(40),
      }),
    );
    // Close to the most one request may carry.
    const body = JSON.stringify(envelope("linear", issues));
    const sent = new TextEncoder().encode(body).length;
    expect(sent).toBeLessThanOrEqual(MAX_INGEST_BYTES);
    expect(sent).toBeGreaterThan(MAX_INGEST_BYTES * 0.8);
    expect((await post(t, body, token)).status).toBe(200);
    // Sent again in full: the list replaces itself and is not counted twice.
    vi.setSystemTime(NOW + 1000);
    expect((await post(t, body, token)).status).toBe(200);
    expect(await storedBytesOf(t, ADA, "linear")).toBeLessThanOrEqual(PERSONAL_BYTES.linear);
  });
});

describe("with no owner configured nobody gets in, and nothing is deleted", () => {
  test("prune run while OWNER_EMAILS is empty keeps every teammate's token, records and status", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    const ben = await connect(t, BEN);
    expect((await push(t, ada.token, "gmail", [mail("aa01")])).status).toBe(200);
    expect((await push(t, ben.token, "fireflies", [meeting("meet-1")])).status).toBe(200);
    const before = await everything(t);

    vi.stubEnv("OWNER_EMAILS", "");
    // Locked out: a push is refused, and nothing is stored.
    expect((await push(t, ada.token, "gmail", [mail("aa02")])).status).toBe(401);
    await t.mutation(internal.mirror.prunePersonal, {});
    expect(await everything(t)).toBe(before);

    // The owner is set again: everything is as it was left.
    vi.stubEnv("OWNER_EMAILS", OWNER);
    expect(await idsOf(t, ADA)).toEqual(["aa01"]);
    expect(await idsOf(t, BEN)).toEqual(["meet-1"]);
    expect(await personalStatus(t, ADA, "gmail")).toMatchObject({ state: "ok", lastOkAt: NOW });
    expect((await ada.client.query(api.connect.status, {})).token).not.toBeNull();
    expect((await push(t, ada.token, "gmail", [mail("aa01"), mail("aa02")])).status).toBe(200);
    expect(await idsOf(t, ADA)).toEqual(["aa01", "aa02"]);
  });

  test("age still counts while there is no owner: old meeting notes go, the person stays", async () => {
    const t = convexTest(schema, modules);
    const ada = await connect(t, ADA);
    expect((await push(t, ada.token, "fireflies", [meeting("meet-1")])).status).toBe(200);
    vi.stubEnv("OWNER_EMAILS", "");
    vi.setSystemTime(NOW + 91 * DAY);
    await t.mutation(internal.mirror.prunePersonal, {});
    expect(await idsOf(t, ADA)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("personalTokens").collect())).toHaveLength(1);
    expect(await personalStatus(t, ADA, "fireflies")).not.toBeNull();
  });
});
