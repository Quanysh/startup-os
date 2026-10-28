import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_INGEST_BYTES } from "./lib/ingestSchema";
import { MAX_MIRROR_ROWS, type MirrorSource } from "./lib/mirrorRules";
import schema from "./schema";
import { OWNER, modules, signInAs, signInAsOwner, type TestBackend } from "./test.setup";

// Mirrored records pushed by a connector run: `records` in POST /ingest/v1.
// Every name, address, subject and title here is made up. A value that must
// never be echoed or logged carries the word SECRET.

// Obviously not real secrets.
const TOKENS: Record<MirrorSource, string> = {
  gmail: "fake-gmail-push-token-0123456789-abcdefgh",
  google_calendar: "fake-calendar-push-token-0123456789-abcde",
  linear: "fake-linear-push-token-0123456789-abcdefg",
  fireflies: "fake-fireflies-push-token-0123456789-abcd",
};
const WORKBOOK = "fake-workbook-token-0123456789-abcdefghij";
const NOW = Date.UTC(2026, 9, 12, 6);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  for (const [source, token] of Object.entries(TOKENS)) {
    vi.stubEnv(`INGEST_TOKEN_${source.toUpperCase()}`, token);
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const mail = (threadId: string, over: Record<string, unknown> = {}) => ({
  threadId,
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: "Made-up subject",
  lastMessageAt: "2026-10-11T15:04:05Z",
  ...over,
});
const event = (eventId: string, over: Record<string, unknown> = {}) => ({
  eventId,
  title: "Made-up meeting",
  startsAt: "2026-10-13T09:00:00Z",
  endsAt: "2026-10-13T09:30:00Z",
  attendees: [{ name: "Ada Example", address: "ada@example-fund.test" }],
  hasMeetingLink: true,
  ...over,
});
const issue = (issueId: string, over: Record<string, unknown> = {}) => ({
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
  updatedAt: "2026-10-12T05:00:00Z",
  ...over,
});
const meeting = (meetingId: string, over: Record<string, unknown> = {}) => ({
  meetingId,
  title: "Made-up call",
  heldAt: "2026-10-10T16:00:00Z",
  durationMinutes: 30,
  participants: [{ name: "Ada Example", address: "ada@example-fund.test" }],
  overview: "A made-up summary.",
  actionItems: ["A made-up action item"],
  ...over,
});

const envelope = (source: string, records: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  source,
  batchId: `${source}-batch-SECRET`,
  observedAt: "2026-10-12T06:00:00Z",
  records,
  ...extra,
});

/** The reply, read once: its status, its text, and the text as JSON. */
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
  source: MirrorSource,
  records: unknown[],
  extra: Record<string, unknown> = {},
) => post(t, envelope(source, records, extra), TOKENS[source]);

const stored = (t: TestBackend, source?: MirrorSource) =>
  t.run(async (ctx) =>
    (await ctx.db.query("mirrorRecords").collect())
      .filter((doc) => source === undefined || doc.source === source)
      .map((doc) => doc.externalId)
      .sort(),
  );
const docs = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const statuses = (t: TestBackend) => t.run((ctx) => ctx.db.query("sourceStatus").collect());
const status = async (t: TestBackend, source: string) =>
  (await statuses(t)).find((row) => row.source === source) ?? null;
/** Everything a refusal may have written or said, as one string to search. */
const said = async (t: TestBackend, response: Reply) =>
  JSON.stringify([response.text, await runs(t), await statuses(t)]);

describe("POST /ingest/v1 with records: each source's happy path", () => {
  test("Gmail: threads waiting, with no Google grant on record", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [mail("18c2f0a1"), mail("18c2f0a2")]);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0 });
    expect(await docs(t)).toMatchObject([
      {
        source: "gmail",
        externalId: "18c2f0a1",
        sortAt: Date.UTC(2026, 9, 11, 15, 4, 5),
        record: {
          kind: "mail",
          threadId: "18c2f0a1",
          fromName: "Ada Example",
          fromAddress: "ada@example-fund.test",
          subject: "Made-up subject",
        },
      },
      { source: "gmail", externalId: "18c2f0a2" },
    ]);
    expect(await status(t, "gmail")).toMatchObject({ state: "ok", lastOkAt: NOW });
  });

  test("Calendar: a timed event, an all-day one and a private one", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "google_calendar", [
      event("evt_1"),
      { eventId: "evt_2", title: "Made-up offsite", startDate: "2026-10-14", endDate: "2026-10-16" },
      { eventId: "evt_3", private: true, startsAt: "2026-10-13T12:00:00Z", endsAt: "2026-10-13T13:00:00Z" },
    ]);
    expect(response.status).toBe(200);
    const records = (await docs(t)).map((doc) => doc.record);
    expect(records).toMatchObject([
      { kind: "event", eventId: "evt_1", allDay: false, attendeeCount: 1, hasMeetingLink: true },
      { kind: "event", eventId: "evt_2", allDay: true, startDate: "2026-10-14", endDate: "2026-10-16" },
      { kind: "event", eventId: "evt_3", title: "Busy", attendees: [], attendeeCount: 0 },
    ]);
  });

  test("Linear: issues", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "linear", [issue("i-1"), issue("i-2", { mine: false })]);
    expect(response.status).toBe(200);
    expect(await stored(t, "linear")).toEqual(["i-1", "i-2"]);
    expect((await docs(t))[0]?.record).toMatchObject({ kind: "issue", stateType: "started", mine: true });
  });

  test("Fireflies: meeting notes", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "fireflies", [meeting("ff-1")]);
    expect(response.status).toBe(200);
    expect((await docs(t))[0]).toMatchObject({
      source: "fireflies",
      sortAt: Date.UTC(2026, 9, 10, 16),
      record: { kind: "meeting", overview: "A made-up summary.", actionItems: ["A made-up action item"] },
    });
  });

  test("the run log holds counts: no record text, and not the sender's batch id", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [
      mail("18c2f0a1", { fromName: "SECRET sender", subject: "SECRET subject" }),
    ]);
    expect(response.status).toBe(200);
    expect(await runs(t)).toMatchObject([
      { source: "gmail", status: "ok", inserted: 1, updated: 0, unchanged: 0, startedAt: NOW },
    ]);
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test("the owner reads what was pushed; nobody else does", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1")]);
    const owner = await signInAsOwner(t);
    const inbox = await owner.query(api.workTools.needsReply, {});
    expect(inbox.threads.map((thread) => thread.threadId)).toEqual(["18c2f0a1"]);
    expect(inbox.source).toMatchObject({ state: "ok", lastOkAt: NOW });
    const stranger = await signInAs(t, { email: "stranger@example.test", emailVerificationTime: 1 });
    await expect(stranger.query(api.workTools.needsReply, {})).rejects.toThrow();
  });
});

describe("POST /ingest/v1 with records: the same cleaning and caps as a read made here", () => {
  test("direction overrides and control characters never reach the table", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [
      mail("18c2f0a1", { subject: "Paid‮gnp.exe\u0007\r\nnow", fromName: "Ada⁦ Example" }),
    ]);
    expect(response.status).toBe(200);
    const [doc] = await docs(t);
    expect(doc?.record).toMatchObject({ subject: "Paid gnp.exe now", fromName: "Ada Example" });
    expect(JSON.stringify(doc)).not.toMatch(/[\u0000-\u001f‪-‮⁦-⁩]/);
  });

  test("a subject over the cap is stored cut to it", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1", { subject: "s".repeat(400) })]);
    const [doc] = await docs(t);
    expect((doc?.record as { subject: string }).subject).toHaveLength(200);
  });

  test("oversize: a body over the size cap is 413", async () => {
    const t = convexTest(schema, modules);
    const body = JSON.stringify(
      envelope("fireflies", [meeting("ff-1", { overview: "x".repeat(MAX_INGEST_BYTES) })]),
    );
    expect((await post(t, body, TOKENS.fireflies)).status).toBe(413);
    expect(await stored(t)).toEqual([]);
  });

  test("oversize: more records than one push may hold", async () => {
    const t = convexTest(schema, modules);
    const many = Array.from({ length: MAX_MIRROR_ROWS + 1 }, (_, i) => ({
      threadId: i.toString(16),
      fromAddress: "a@b.test",
      lastMessageAt: "2026-10-11T15:04:05Z",
    }));
    const response = await push(t, "gmail", many);
    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject({
      error: "invalid_envelope",
      issues: [{ path: "records", message: "is too long or too large" }],
    });
    expect(await stored(t)).toEqual([]);
  });

  test("oversize: a field past the hard limit refuses the push", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "linear", [issue("i-1", { title: "t".repeat(5001) })]);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.0.title", message: "is too long or too large" }],
    });
    expect(await stored(t)).toEqual([]);
  });
});

describe("POST /ingest/v1 with records: who may send what", () => {
  test("a token that is not a work tool's cannot send records", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("cfo_workbook", [mail("18c2f0a1")]), WORKBOOK);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "records_not_accepted",
      issues: [{ path: "records", message: '"cfo_workbook" does not carry records.' }],
    });
    expect(await stored(t)).toEqual([]);
  });

  test("one work tool's token cannot write as another", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("linear", [issue("i-1")]), TOKENS.gmail);
    expect(response.status).toBe(403);
    expect(response.json()).toMatchObject({ error: "source_mismatch" });
    expect(await stored(t)).toEqual([]);
  });

  test("wrong token for the kind: Gmail's token with Linear's rows is refused, echoing nothing", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [issue("i-1", { title: "SECRET title" })]);
    expect(response.status).toBe(422);
    const body = (response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("invalid_records");
    expect(body.issues.every((i) => i.path.startsWith("records.0"))).toBe(true);
    expect(await stored(t)).toEqual([]);
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test("a work tool's token writes no number and no pipeline", async () => {
    const t = convexTest(schema, modules);
    const { records: _r, ...bare } = envelope("gmail", []);
    const number = { key: "cash", scope: "us", period: "day", periodStart: "2026-10-12", value: 1, currency: "USD" };
    for (const payload of [
      { snapshots: [number] },
      { deals: [{ externalId: "1", name: "SECRET clinic", stage: "New" }] },
    ]) {
      const response = await post(t, { ...bare, ...payload }, TOKENS.gmail);
      expect(response.status).toBe(422);
      expect(response.json()).toEqual({
        ok: false,
        error: "records_only",
        issues: [{ path: "envelope", message: "This token carries records and nothing else." }],
      });
      expect(await said(t, response)).not.toContain("SECRET");
    }
    expect(await t.run((ctx) => ctx.db.query("metricSnapshots").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
  });

  test.each([
    ["snapshots", [{ key: "cash", scope: "us", period: "day", periodStart: "2026-10-12", value: 1 }]],
    ["deals", [{ externalId: "1", name: "SECRET clinic", stage: "New" }]],
    ["investors", [{ externalId: "1", name: "SECRET fund", stage: "New" }]],
    ["customers", [{ name: "SECRET clinic", market: "us", status: "active" }]],
    ["mode", "replace"],
    ["allowShrink", true],
  ] as const)("records travel alone: beside %s the push is refused", async (field, value) => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [mail("18c2f0a1")], { [field]: value });
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [{ path: field, message: "A records push carries nothing else." }],
    });
    expect(await stored(t)).toEqual([]);
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test("while the tool's own API variables are set it is pulled, and a push is refused", async () => {
    vi.stubEnv("LINEAR_API_KEY", "fake-linear-key");
    const t = convexTest(schema, modules);
    const response = await push(t, "linear", [issue("i-1")]);
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ error: "source_is_pulled" });
    expect(await stored(t)).toEqual([]);
  });
});

describe("POST /ingest/v1 with records: nothing a record says is echoed or logged", () => {
  test.each(["body", "snippet"])("a mail row with a %s is refused whole", async (field) => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [
      mail("18c2f0a1"),
      mail("18c2f0a2", { [field]: "SECRET words from the message" }),
    ]);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    expect(await stored(t)).toEqual([]);
    const everything = await said(t, response);
    expect(everything).not.toContain("SECRET");
    expect(everything).not.toContain(field);
  });

  test("an unknown field named after a person is not echoed either", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "fireflies", [meeting("ff-1", { "SECRET Person": true })]);
    expect(response.status).toBe(422);
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test("a name in a refused row is in neither the reply nor the run log", async () => {
    const t = convexTest(schema, modules);
    const response = await push(t, "gmail", [
      mail("18c2f0a1", {
        fromName: "SECRET Sender",
        subject: "SECRET subject",
        fromAddress: "SECRET not an address",
      }),
    ]);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.0.fromAddress", message: "is not an email address" }],
    });
    expect(await runs(t)).toMatchObject([
      {
        source: "gmail",
        status: "error",
        message: "invalid_records: records.0.fromAddress — is not an email address",
      },
    ]);
    expect((await runs(t))[0]?.batchId).toBeUndefined();
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test("a malformed envelope from a work tool's token gets fixed words too", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      { ...envelope("gmail", [mail("18c2f0a1")]), "SECRET Person": "x" },
      TOKENS.gmail,
    );
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [{ path: "envelope", message: "has a field the OS does not accept" }],
    });
    expect(await said(t, response)).not.toContain("SECRET");
  });
});

describe("POST /ingest/v1 from a work tool's token, with no records in the body", () => {
  test("still gets fixed words: the token decides, not the body", async () => {
    const t = convexTest(schema, modules);
    const { records: _r, ...bare } = envelope("gmail", []);
    const response = await post(t, { ...bare, "SECRET Person": "x" }, TOKENS.gmail);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [
        { path: "envelope", message: "has a field the OS does not accept" },
        { path: "envelope", message: "Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage." },
      ],
    });
    expect(await said(t, response)).not.toContain("SECRET");
  });
});

describe("POST /ingest/v1 with records: a push is the whole current set", () => {
  test("replace removes records missing from the new push", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1"), mail("18c2f0a2")]);
    const response = await push(t, "gmail", [mail("18c2f0a2"), mail("18c2f0a3")]);
    expect(response.json()).toEqual({ ok: true, inserted: 1, updated: 0, unchanged: 1 });
    expect(await stored(t, "gmail")).toEqual(["18c2f0a2", "18c2f0a3"]);
  });

  test("it replaces its own source's records only", async () => {
    const t = convexTest(schema, modules);
    await push(t, "linear", [issue("i-1")]);
    await push(t, "gmail", [mail("18c2f0a1")]);
    await push(t, "gmail", [mail("18c2f0a2")]);
    expect(await stored(t)).toEqual(["18c2f0a2", "i-1"]);
  });

  test("meeting notes accumulate, as they do when read here", async () => {
    const t = convexTest(schema, modules);
    await push(t, "fireflies", [meeting("ff-1")]);
    await push(t, "fireflies", [meeting("ff-2")]);
    expect(await stored(t, "fireflies")).toEqual(["ff-1", "ff-2"]);
  });

  test("a refused push leaves what is stored untouched", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1"), mail("18c2f0a2")]);
    const before = await docs(t);
    const response = await push(t, "gmail", [mail("18c2f0a3"), mail("not hex")]);
    expect(response.status).toBe(422);
    expect(await docs(t)).toEqual(before);
    // The failure shows; the time of the last good read stays.
    expect(await status(t, "gmail")).toMatchObject({ state: "error", lastOkAt: NOW });
  });

  test("an empty list is refused unless the envelope says it is empty", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1")]);
    const response = await push(t, "gmail", []);
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [
        {
          path: "records",
          message:
            'An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
        },
      ],
    });
    expect(await stored(t, "gmail")).toEqual(["18c2f0a1"]);
  });

  test.each(["gmail", "google_calendar"] as const)(
    "%s: an explicit empty push empties the list, and is a good read",
    async (source) => {
      const t = convexTest(schema, modules);
      await push(t, source, source === "gmail" ? [mail("18c2f0a1")] : [event("evt_1")]);
      vi.setSystemTime(NOW + 60_000);
      const response = await push(t, source, [], { empty: true });
      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ ok: true, inserted: 0, updated: 0, unchanged: 0 });
      expect(await stored(t, source)).toEqual([]);
      expect(await status(t, source)).toMatchObject({ state: "ok", lastOkAt: NOW + 60_000 });
    },
  );

  test.each(["linear", "fireflies"] as const)(
    "%s: an empty push is refused even when said, and nothing is removed",
    async (source) => {
      const t = convexTest(schema, modules);
      await push(t, source, source === "linear" ? [issue("i-1")] : [meeting("ff-1")]);
      const response = await push(t, source, [], { empty: true });
      expect(response.status).toBe(422);
      expect(response.json()).toEqual({
        ok: false,
        error: "invalid_records",
        issues: [
          {
            path: "empty",
            message:
              "An empty push is never accepted from this source: nothing there is a failed read.",
          },
        ],
      });
      expect(await stored(t, source)).toHaveLength(1);
    },
  );

  test("`empty` beside records, or beside numbers, is refused", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
    const t = convexTest(schema, modules);
    const beside = await push(t, "gmail", [mail("18c2f0a1")], { empty: true });
    expect(beside.json()).toMatchObject({
      error: "invalid_envelope",
      issues: [{ path: "empty", message: "empty is for a push with no records." }],
    });
    const { records: _r, ...bare } = envelope("cfo_workbook", []);
    const numbers = await post(
      t,
      {
        ...bare,
        empty: true,
        snapshots: [{ key: "clinics_using", scope: "kz_product", period: "month", periodStart: "2026-10-01", value: 1 }],
      },
      WORKBOOK,
    );
    expect(numbers.json()).toMatchObject({
      error: "invalid_envelope",
      issues: [{ path: "empty", message: "empty belongs to a records push." }],
    });
    expect(await stored(t)).toEqual([]);
  });
});

describe("POST /ingest/v1 with records: the safety behaviours hold for a pushed source", () => {
  test("turned off: stored records are deleted, and a later push is dropped", async () => {
    const t = convexTest(schema, modules);
    await push(t, "linear", [issue("i-1")]);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "linear" });
    expect(await stored(t, "linear")).toEqual([]);

    const logged = (await runs(t)).length;
    const response = await push(t, "linear", [issue("i-2")]);
    expect(response.status).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: "source_turned_off" });
    expect(await stored(t, "linear")).toEqual([]);
    expect(await runs(t)).toHaveLength(logged);
    expect(await status(t, "linear")).toMatchObject({
      state: "not_configured",
      message: "Turned off under Settings → Work tools.",
    });
  });

  test("turned on again: the read it starts does nothing, and the next push lands", async () => {
    // Every timer, not only the clock: the read turnOn schedules must run here.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "gmail" });
    await owner.mutation(api.workTools.turnOn, { source: "gmail" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await runs(t)).toEqual([]);
    expect((await push(t, "gmail", [mail("18c2f0a1")])).status).toBe(200);
    expect(await status(t, "gmail")).toMatchObject({ state: "ok" });
    expect(await stored(t, "gmail")).toEqual(["18c2f0a1"]);
  });

  test("retention: a pushed source not pushed for 30 days loses what it stored", async () => {
    const t = convexTest(schema, modules);
    await push(t, "gmail", [mail("18c2f0a1")]);
    vi.setSystemTime(NOW + 29 * DAY);
    await t.mutation(internal.mirror.prune, {});
    expect(await stored(t, "gmail")).toEqual(["18c2f0a1"]);
    vi.setSystemTime(NOW + 31 * DAY);
    await t.mutation(internal.mirror.prune, {});
    expect(await stored(t, "gmail")).toEqual([]);
  });

  test("retention: pushed meeting notes go 90 days after the meeting", async () => {
    const t = convexTest(schema, modules);
    await push(t, "fireflies", [meeting("ff-old"), meeting("ff-new", { heldAt: "2026-10-12T05:00:00Z" })]);
    // 89 days on: pushed again so the source is alive; ff-old's meeting is now 91 days back.
    vi.setSystemTime(Date.UTC(2026, 9, 10, 16) + 91 * DAY);
    await push(t, "fireflies", [meeting("ff-new", { heldAt: "2026-10-12T05:00:00Z" })]);
    await t.mutation(internal.mirror.prune, {});
    expect(await stored(t, "fireflies")).toEqual(["ff-new"]);
  });
});
