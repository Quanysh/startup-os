import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { RECORDS_ONLY_WORDS, NOT_A_PERSONAL_TOOL_WORDS } from "./lib/personalRules";
import type { SharedRecord } from "./lib/sharedRecords";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAs,
  signInAsMember,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// Apollo's shared lists pushed with Apollo's own token: its sequences, and
// its contacts and accounts by stage. Every sequence and stage name here is
// made up. A value that must never be echoed or logged carries SECRET.

// Obviously not real secrets.
const APOLLO = "fake-apollo-push-token-0123456789-abcdefg";
const GMAIL = "fake-gmail-push-token-0123456789-abcdefgh";
const LINEAR = "fake-linear-push-token-0123456789-abcdefg";
const WORKBOOK = "fake-workbook-token-0123456789-abcdefghij";
const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";
// A Wednesday. The week in progress began on Monday 2026-10-12.
const NOW = Date.UTC(2026, 9, 14, 6);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_APOLLO", APOLLO);
  vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL);
  vi.stubEnv("INGEST_TOKEN_LINEAR", LINEAR);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const sequence = (sequenceId: string, over: Record<string, unknown> = {}) => ({
  sequenceId,
  name: "Made-up outreach",
  active: true,
  archived: false,
  steps: 7,
  createdAt: "2026-03-13",
  lastUsedAt: "2026-03-17",
  delivered: 24,
  opened: 1,
  replied: 0,
  bounced: 1,
  unsubscribed: 1,
  clicked: 0,
  ...over,
});
const stage = (entity: "contact" | "account", name: string, count: number) => ({
  entity,
  stage: name,
  count,
});
const mail = (threadId: string) => ({
  threadId,
  fromName: "SECRET Sender",
  fromAddress: "secret.sender@example.test",
  subject: "SECRET subject",
  lastMessageAt: "2026-10-13T15:04:05Z",
});
const issue = (issueId: string) => ({
  issueId,
  identifier: "ENG-1",
  title: "Made-up title",
  stateType: "started",
  mine: false,
  updatedAt: "2026-10-13T05:00:00Z",
});
const week = (key: string, periodStart: string, value: number) => ({
  key,
  scope: "us",
  period: "week",
  periodStart,
  value,
});

const header = (source: string) => ({
  version: 1,
  source,
  batchId: `${source}-batch-SECRET`,
  observedAt: "2026-10-14T06:00:00Z",
});
const list = (kind: string, records: unknown[], extra: Record<string, unknown> = {}) => ({
  ...header("apollo"),
  kind,
  records,
  ...extra,
});

type Reply = { status: number; text: string; json: () => unknown };
async function post(t: TestBackend, body: unknown, token: string): Promise<Reply> {
  const response = await t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

const docs = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const ids = async (t: TestBackend) => (await docs(t)).map((doc) => doc.externalId).sort();
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const statuses = (t: TestBackend) => t.run((ctx) => ctx.db.query("sourceStatus").collect());
const snapshots = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.periodStart} ${r.value}`)
      .sort(),
  );
/** Everything a push may have written or said, as one string to search. */
const said = async (t: TestBackend, response: Reply) =>
  JSON.stringify([response.text, await runs(t), await statuses(t)]);

describe("Apollo's token: the three envelopes of a daily read", () => {
  test("numbers: the levels under the week in progress, the weekly counts under finished weeks", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      {
        ...header("apollo"),
        snapshots: [
          week("outbound_delivered", "2026-10-12", 24),
          week("apollo_contacts", "2026-10-12", 760),
          week("apollo_accounts", "2026-10-12", 546),
          week("apollo_tasks_open", "2026-10-12", 23),
          week("apollo_tasks_overdue", "2026-10-12", 23),
          week("apollo_contacts_added", "2026-10-05", 710),
          week("apollo_contacts_added", "2026-09-28", 0),
          week("apollo_calls", "2026-10-05", 0),
        ],
      },
      APOLLO,
    );
    expect(response.status).toBe(200);
    expect(await snapshots(t)).toEqual([
      "apollo_accounts 2026-10-12 546",
      "apollo_calls 2026-10-05 0",
      "apollo_contacts 2026-10-12 760",
      "apollo_contacts_added 2026-09-28 0",
      "apollo_contacts_added 2026-10-05 710",
      "apollo_tasks_open 2026-10-12 23",
      "apollo_tasks_overdue 2026-10-12 23",
      "outbound_delivered 2026-10-12 24",
    ]);
  });

  test("numbers: a part-week count, a level filed under another week and an unbelievable value are refused whole", async () => {
    const t = convexTest(schema, modules);
    const refused = async (row: ReturnType<typeof week>, path: string, message: string) => {
      const response = await post(
        t,
        { ...header("apollo"), snapshots: [week("apollo_contacts", "2026-10-12", 760), row] },
        APOLLO,
      );
      expect(response.status).toBe(422);
      expect(response.json()).toMatchObject({
        error: "invalid_snapshots",
        issues: [{ path, message }],
      });
    };
    await refused(
      week("apollo_contacts_added", "2026-10-12", 10),
      "snapshots.1.periodStart",
      "This week has not ended. Only finished weeks are stored.",
    );
    await refused(
      week("apollo_tasks_open", "2026-10-05", 23),
      "snapshots.1.periodStart",
      "Totals to date belong to the week they are read in.",
    );
    const tooMany = await post(
      t,
      { ...header("apollo"), snapshots: [week("apollo_contacts", "2026-10-12", 10_000_001)] },
      APOLLO,
    );
    expect(tooMany.status).toBe(422);
    const half = await post(
      t,
      { ...header("apollo"), snapshots: [week("apollo_tasks_overdue", "2026-10-12", 2.5)] },
      APOLLO,
    );
    expect(half.status).toBe(422);
    expect(await snapshots(t)).toEqual([]);
  });

  test("sequences: stored as the team's list, with no owner", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, list("sequence", [sequence("s1"), sequence("s2")]), APOLLO);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0 });
    const stored = await docs(t);
    expect(stored.map((doc) => [doc.source, doc.owner, doc.externalId, doc.record.kind])).toEqual([
      ["apollo", undefined, "sequence:s1", "sequence"],
      ["apollo", undefined, "sequence:s2", "sequence"],
    ]);
  });

  test("stage counts: stored the same way", async () => {
    const t = convexTest(schema, modules);
    const rows = [stage("contact", "Cold", 735), stage("contact", "Approaching", 24), stage("account", "Cold", 546)];
    const response = await post(t, list("stage_count", rows), APOLLO);
    expect(response.status).toBe(200);
    expect(await ids(t)).toEqual([
      "stage:account:cold",
      "stage:contact:approaching",
      "stage:contact:cold",
    ]);
  });

  test("the run log holds counts and the source: no name, and not the sender's batch id", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      list("sequence", [sequence("s1", { name: "SECRET sequence" })]),
      APOLLO,
    );
    expect(response.status).toBe(200);
    expect(await runs(t)).toMatchObject([
      { source: "apollo", status: "ok", inserted: 1, updated: 0, unchanged: 0 },
    ]);
    expect((await runs(t))[0]).not.toHaveProperty("batchId");
    expect(await statuses(t)).toMatchObject([{ source: "apollo", state: "ok", lastOkAt: NOW }]);
    expect(await said(t, response)).not.toContain("SECRET");
  });
});

describe("Apollo's lists: a push is one list, whole", () => {
  test("a sequence missing from the next push is removed; one that changed is updated", async () => {
    const t = convexTest(schema, modules);
    await post(t, list("sequence", [sequence("s1"), sequence("s2")]), APOLLO);
    const response = await post(
      t,
      list("sequence", [sequence("s2", { delivered: 30 }), sequence("s3")]),
      APOLLO,
    );
    expect(response.json()).toEqual({ ok: true, inserted: 1, updated: 1, unchanged: 0 });
    expect(await ids(t)).toEqual(["sequence:s2", "sequence:s3"]);
  });

  test("replacing one list leaves the other alone", async () => {
    const t = convexTest(schema, modules);
    await post(t, list("sequence", [sequence("s1")]), APOLLO);
    await post(t, list("stage_count", [stage("contact", "Cold", 735), stage("account", "Cold", 546)]), APOLLO);
    await post(t, list("sequence", [sequence("s9")]), APOLLO);
    expect(await ids(t)).toEqual(["sequence:s9", "stage:account:cold", "stage:contact:cold"]);
    await post(t, list("stage_count", [stage("contact", "Warm", 3)]), APOLLO);
    expect(await ids(t)).toEqual(["sequence:s9", "stage:contact:warm"]);
  });

  test("it touches no other source's records and nobody's personal ones", async () => {
    const t = convexTest(schema, modules);
    // The owner's own mail and the shared board, pushed with those tools' tokens…
    await post(t, { ...header("gmail"), records: [mail("aa01")] }, GMAIL);
    await post(t, { ...header("linear"), records: [issue("i-1")] }, LINEAR);
    // …and a teammate's own mail, pushed with their personal token.
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.teammate@gmail.com", ["today"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    await post(t, { ...header("gmail"), records: [mail("bb01"), mail("bb02")] }, token);
    const before = (await docs(t)).map((doc) => [doc.owner, doc.source, doc.externalId]);
    expect(before).toHaveLength(4);

    await post(t, list("sequence", [sequence("s1")]), APOLLO);
    await post(t, list("sequence", [sequence("s2")]), APOLLO);
    await post(t, list("stage_count", [stage("contact", "Cold", 1)]), APOLLO);

    const after = await docs(t);
    expect(after.filter((doc) => doc.source !== "apollo").map((doc) => [doc.owner, doc.source, doc.externalId])).toEqual(before);
    expect(after.filter((doc) => doc.source === "apollo").map((doc) => doc.externalId).sort()).toEqual([
      "sequence:s2",
      "stage:contact:cold",
    ]);
    // And the other way: a work tool's whole-list replace does not reach Apollo's lists.
    await post(t, { ...header("gmail"), records: [], empty: true }, GMAIL);
    await post(t, { ...header("gmail"), records: [], empty: true }, token);
    expect(await ids(t)).toEqual(["i-1", "sequence:s2", "stage:contact:cold"]);
  });

  test("every row of a list carries the time of its latest push, changed or not", async () => {
    const t = convexTest(schema, modules);
    await post(t, list("sequence", [sequence("s1")]), APOLLO);
    await post(t, list("stage_count", [stage("contact", "Cold", 1)]), APOLLO);
    vi.setSystemTime(NOW + DAY);
    const again = await post(t, list("sequence", [sequence("s1")]), APOLLO);
    expect(again.json()).toEqual({ ok: true, inserted: 0, updated: 0, unchanged: 1 });
    const stored = await docs(t);
    expect(stored.find((doc) => doc.externalId === "sequence:s1")?.syncedAt).toBe(NOW + DAY);
    // The other list was not pushed again, and says so.
    expect(stored.find((doc) => doc.externalId === "stage:contact:cold")?.syncedAt).toBe(NOW);
  });

  test("a refused push leaves what is stored untouched, and is logged in paths and fixed words", async () => {
    const t = convexTest(schema, modules);
    await post(t, list("sequence", [sequence("s1")]), APOLLO);
    const response = await post(
      t,
      list("sequence", [sequence("s2"), sequence("s3", { name: "SECRET sequence", contactName: "SECRET Person" })]),
      APOLLO,
    );
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    expect(await ids(t)).toEqual(["sequence:s1"]);
    expect((await runs(t)).at(-1)).toMatchObject({
      source: "apollo",
      status: "error",
      message: "invalid_records: records.1 — has a field the OS does not accept",
    });
    expect((await runs(t)).at(-1)).not.toHaveProperty("batchId");
    expect(await said(t, response)).not.toContain("SECRET");
  });

  test.each(["sequence", "stage_count"])(
    "an empty %s list is refused, with or without `empty`, and nothing is removed",
    async (kind) => {
      const t = convexTest(schema, modules);
      await post(t, list("sequence", [sequence("s1")]), APOLLO);
      await post(t, list("stage_count", [stage("contact", "Cold", 1)]), APOLLO);
      const bare = await post(t, list(kind, []), APOLLO);
      expect(bare.status).toBe(422);
      expect(bare.json()).toMatchObject({ error: "invalid_envelope", issues: [{ path: "records" }] });
      const marked = await post(t, list(kind, [], { empty: true }), APOLLO);
      expect(marked.status).toBe(422);
      expect(marked.json()).toEqual({
        ok: false,
        error: "invalid_records",
        issues: [
          {
            path: "empty",
            message: "An empty push is never accepted from this source: nothing there is a failed read.",
          },
        ],
      });
      expect(await ids(t)).toEqual(["sequence:s1", "stage:contact:cold"]);
    },
  );
});

describe("who may send what", () => {
  const refusedWith = async (
    t: TestBackend,
    body: unknown,
    token: string,
    status: number,
    error: string,
  ) => {
    const response = await post(t, body, token);
    expect([response.status, (response.json() as { error: string }).error]).toEqual([status, error]);
    expect(response.text).not.toContain("SECRET");
    return response;
  };

  test("Apollo's token: records need a kind, and only its own two", async () => {
    const t = convexTest(schema, modules);
    const bare = await refusedWith(
      t,
      { ...header("apollo"), records: [sequence("s1")] },
      APOLLO,
      422,
      "invalid_envelope",
    );
    expect(bare.json()).toMatchObject({ issues: [{ path: "kind" }] });
    await refusedWith(t, list("mail", [mail("aa01")]), APOLLO, 422, "invalid_envelope");
    await refusedWith(t, list("SECRET kind", [sequence("s1")]), APOLLO, 422, "invalid_envelope");
    expect(await docs(t)).toEqual([]);
  });

  test("Apollo's token: rows of the other list, or a work tool's rows, are refused by row", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(t, list("sequence", [stage("contact", "Cold", 1)]), APOLLO, 422, "invalid_records");
    await refusedWith(t, list("stage_count", [sequence("s1")]), APOLLO, 422, "invalid_records");
    await refusedWith(t, list("sequence", [mail("aa01")]), APOLLO, 422, "invalid_records");
    await refusedWith(t, list("stage_count", [issue("i-1")]), APOLLO, 422, "invalid_records");
    expect(await docs(t)).toEqual([]);
  });

  test("Apollo's token cannot write the four work tools, under their name or its own", async () => {
    const t = convexTest(schema, modules);
    for (const source of ["gmail", "google_calendar", "linear", "fireflies"]) {
      // As that tool: the token says who is writing.
      await refusedWith(t, { ...header(source), records: [mail("aa01")] }, APOLLO, 403, "source_mismatch");
      await refusedWith(
        t,
        { ...header(source), kind: "sequence", records: [sequence("s1")] },
        APOLLO,
        422,
        "invalid_envelope",
      );
    }
    expect(await docs(t)).toEqual([]);
  });

  test("Apollo's token carries no pipeline, register or plan, and one payload per envelope", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(
      t,
      { ...header("apollo"), deals: [{ externalId: "d1", name: "SECRET Co", stage: "Lead" }] },
      APOLLO,
      422,
      "invalid_rows",
    );
    await refusedWith(
      t,
      { ...header("apollo"), customers: [{ name: "SECRET clinic", market: "us", status: "active" }] },
      APOLLO,
      422,
      "customers_not_accepted",
    );
    await refusedWith(
      t,
      {
        ...header("apollo"),
        plan: { modelVersion: "a1b2c3d", rows: [{ scenario: "base", year: 2027, key: "arr", value: 1 }] },
      },
      APOLLO,
      422,
      "plan_not_accepted",
    );
    await refusedWith(
      t,
      { ...list("sequence", [sequence("s1")]), snapshots: [week("apollo_contacts", "2026-10-12", 1)] },
      APOLLO,
      422,
      "invalid_envelope",
    );
    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
  });

  test("a work tool's token cannot write Apollo's lists", async () => {
    const t = convexTest(schema, modules);
    // As Apollo: refused by the token.
    await refusedWith(t, list("sequence", [sequence("s1")]), GMAIL, 403, "source_mismatch");
    // As itself, with a kind: the envelope refuses it.
    await refusedWith(
      t,
      { ...header("gmail"), kind: "sequence", records: [sequence("s1")] },
      GMAIL,
      422,
      "invalid_envelope",
    );
    // As itself, with Apollo's rows and no kind: they are not mail.
    await refusedWith(t, { ...header("gmail"), records: [sequence("s1")] }, GMAIL, 422, "invalid_records");
    expect(await docs(t)).toEqual([]);
  });

  test("a source that carries numbers only cannot send a list", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
    const t = convexTest(schema, modules);
    await refusedWith(t, list("sequence", [sequence("s1")]), WORKBOOK, 403, "source_mismatch");
    await refusedWith(
      t,
      { ...header("cfo_workbook"), kind: "sequence", records: [sequence("s1")] },
      WORKBOOK,
      422,
      "invalid_envelope",
    );
    expect(await docs(t)).toEqual([]);
  });

  test("a personal token cannot write Apollo's lists, with a kind or without", async () => {
    const t = convexTest(schema, modules);
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.teammate@gmail.com", ["today", "gtm"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });

    const named = await refusedWith(t, list("sequence", [sequence("s1")]), token, 422, "records_not_accepted");
    expect(named.json()).toMatchObject({
      issues: [{ path: "source", message: NOT_A_PERSONAL_TOOL_WORDS }],
    });
    await refusedWith(t, list("stage_count", [stage("contact", "Cold", 1)]), token, 422, "records_not_accepted");
    await refusedWith(t, { ...header("apollo"), records: [sequence("s1")] }, token, 422, "invalid_envelope");
    // As one of its own tools, with a kind or with Apollo's rows.
    await refusedWith(
      t,
      { ...header("gmail"), kind: "sequence", records: [sequence("s1")] },
      token,
      422,
      "invalid_envelope",
    );
    await refusedWith(t, { ...header("gmail"), records: [sequence("s1")] }, token, 422, "invalid_records");
    // And none of Apollo's numbers.
    const numbers = await refusedWith(
      t,
      { ...header("apollo"), snapshots: [week("apollo_contacts", "2026-10-12", 1)] },
      token,
      422,
      "records_only",
    );
    expect(numbers.json()).toMatchObject({ issues: [{ path: "envelope", message: RECORDS_ONLY_WORDS }] });

    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
    // Nothing of it reached the deployment's log either.
    expect(await runs(t)).toEqual([]);
  });

  test("while Apollo's API key is set the OS reads Apollo itself, and a pushed list is refused", async () => {
    vi.stubEnv("APOLLO_API_KEY", "fake-apollo-api-key");
    const t = convexTest(schema, modules);
    await refusedWith(t, list("sequence", [sequence("s1")]), APOLLO, 409, "source_is_pulled");
    expect(await docs(t)).toEqual([]);
  });
});

describe("the write's own guards, whoever calls it", () => {
  const seq: SharedRecord = {
    kind: "sequence",
    sequenceId: "s1",
    name: "Made-up outreach",
    active: true,
    archived: false,
    steps: 7,
    createdAt: "2026-03-13",
    delivered: 24,
    opened: 1,
    replied: 0,
    bounced: 1,
    unsubscribed: 1,
  };
  const cold: SharedRecord = { kind: "stage_count", entity: "contact", stage: "Cold", count: 735 };

  test("rows of another kind than the push names are refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "apollo",
        kind: "sequence",
        startedAt: NOW,
        rows: [seq, cold],
      }),
    ).rejects.toThrow("1 of 2 records broke the size and shape rules, so nothing was written.");
    expect(await docs(t)).toEqual([]);
  });

  test("an empty batch is refused: it would wipe the list", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.mirror.applyShared, {
      source: "apollo",
      kind: "stage_count",
      startedAt: NOW,
      rows: [cold],
    });
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "apollo",
        kind: "stage_count",
        startedAt: NOW,
        rows: [],
      }),
    ).rejects.toThrow("An empty list is never written for this source.");
    expect(await ids(t)).toEqual(["stage:contact:cold"]);
  });

  test("the validators keep the doors apart: no work tool's source or record here, no list there", async () => {
    const t = convexTest(schema, modules);
    const mailRecord = {
      kind: "mail" as const,
      threadId: "aa01",
      fromName: "",
      fromAddress: "a@example.test",
      subject: "s",
      lastMessageAt: NOW,
    };
    await expect(
      t.mutation(internal.mirror.applyShared, {
        // @ts-expect-error a work tool is not a shared source
        source: "gmail",
        kind: "sequence",
        startedAt: NOW,
        rows: [seq],
      }),
    ).rejects.toThrow(/Validator error/);
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "apollo",
        kind: "sequence",
        startedAt: NOW,
        // @ts-expect-error a mail record is not a shared record
        rows: [mailRecord],
      }),
    ).rejects.toThrow(/Validator error/);
    await expect(
      t.mutation(internal.mirror.apply, {
        // @ts-expect-error Apollo is not a work tool
        source: "apollo",
        startedAt: NOW,
        rows: [mailRecord],
        pushed: true,
      }),
    ).rejects.toThrow(/Validator error/);
    await expect(
      t.mutation(internal.mirror.apply, {
        source: "gmail",
        startedAt: NOW,
        // @ts-expect-error a sequence is not a work tool's record
        rows: [seq],
        pushed: true,
      }),
    ).rejects.toThrow(/Validator error/);
    expect(await docs(t)).toEqual([]);
  });
});

describe("workTools.outbound: the go-to-market page's read", () => {
  const seed = async (t: TestBackend) => {
    await post(
      t,
      list("sequence", [
        sequence("old", { name: "Older outreach", lastUsedAt: "2026-03-17", active: false }),
        sequence("new", { name: "Newer outreach", lastUsedAt: "2026-10-01", clicked: undefined }),
        sequence("unused", { name: "Never used", lastUsedAt: undefined, createdAt: "2026-10-10" }),
      ]),
      APOLLO,
    );
    vi.setSystemTime(NOW + 1000);
    await post(
      t,
      list("stage_count", [
        stage("account", "Cold", 546),
        stage("contact", "Approaching", 24),
        stage("contact", "Cold", 735),
        stage("contact", "Do Not Contact", 1),
      ]),
      APOLLO,
    );
  };

  test("before the first push: empty lists with no read time, never an error", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.workTools.outbound, {})).toEqual({
      sequences: { readAt: null, rows: [] },
      stages: { readAt: null, rows: [] },
      lastOkAt: null,
    });
  });

  test("its shape: sequences newest-used first, stages by entity then size, and when each was read", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const result = await owner.query(api.workTools.outbound, {});
    expect(result.lastOkAt).toBe(NOW + 1000);
    expect(result.sequences.readAt).toBe(NOW);
    expect(result.stages.readAt).toBe(NOW + 1000);
    expect(result.sequences.rows.map((row) => row.sequenceId)).toEqual(["unused", "new", "old"]);
    expect(result.sequences.rows[1]).toEqual({
      sequenceId: "new",
      name: "Newer outreach",
      active: true,
      archived: false,
      steps: 7,
      createdAt: "2026-03-13",
      lastUsedAt: "2026-10-01",
      delivered: 24,
      opened: 1,
      replied: 0,
      bounced: 1,
      unsubscribed: 1,
    });
    expect(result.stages.rows).toEqual([
      { entity: "contact", stage: "Cold", count: 735 },
      { entity: "contact", stage: "Approaching", count: 24 },
      { entity: "contact", stage: "Do Not Contact", count: 1 },
      { entity: "account", stage: "Cold", count: 546 },
    ]);
  });

  test("it returns Apollo's lists only: nobody's mail, issues or meetings", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await post(t, { ...header("gmail"), records: [mail("aa01")] }, GMAIL);
    await post(t, { ...header("linear"), records: [issue("i-1")] }, LINEAR);
    const owner = await signInAsOwner(t);
    const text = JSON.stringify(await owner.query(api.workTools.outbound, {}));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("aa01");
    expect(text).not.toContain("ENG-1");
  });

  test("the gate: the go-to-market area, on Startup", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const withGtm = await signInWithAreas(t, "sales", ["gtm"], ["us"]);
    expect((await withGtm.query(api.workTools.outbound, {})).sequences.rows).toHaveLength(3);

    // The area without the company: Apollo is Startup's.
    const kzOnly = await signInAsMember(t, "sales", ["kz"], "kz.sales@gmail.com", ["gtm"]);
    await expect(kzOnly.query(api.workTools.outbound, {})).rejects.toThrow("not_allowed");
    // The company without the area, Today included: these are not personal records.
    const noGtm = await signInAsMember(t, "engineer", ["us"], "us.engineer@gmail.com", [
      "today",
      "sales",
      "marketing",
    ]);
    await expect(noGtm.query(api.workTools.outbound, {})).rejects.toThrow("not_allowed");
    // Signed in, not on the team; and not signed in at all.
    const stranger = await signInAs(t, { email: "stranger@example.test", emailVerificationTime: 1 });
    await expect(stranger.query(api.workTools.outbound, {})).rejects.toThrow("not_allowed");
    await expect(t.query(api.workTools.outbound, {})).rejects.toThrow("not_allowed");
  });

  test("the personal reads are not widened: a teammate's Today holds none of Apollo's rows", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.workTools.needsReply, {})).threads).toEqual([]);
    expect((await owner.query(api.workTools.issues, {})).issues).toEqual([]);
    expect((await owner.query(api.workTools.myIssues, {})).issues).toEqual([]);
    expect((await owner.query(api.workTools.meetings, {})).meetings).toEqual([]);
  });
});
