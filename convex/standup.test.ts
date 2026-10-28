import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { NOT_ALLOWED } from "./lib/owner";
import {
  MAX_OPEN_LISTED,
  MAX_STANDUP_BYTES,
  MAX_STANDUP_TASKS,
  MAX_STANDUP_TASKS_PER_DAY,
  TOO_MANY_TODAY_WORDS,
} from "./lib/standup";
import schema from "./schema";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAsEngineer,
  signInAsOwner,
  type TestBackend,
} from "./test.setup";

// The two routes a daily Claude session uses to turn the standup into cards:
// what the board already holds, and the tasks that were missing. Every title,
// note and address here is made up; the ones that must never surface say SECRET.

// Long enough to count as a real secret (see MIN_INGEST_TOKEN_LENGTH).
const TOKEN = "test-standup-token-0123456789-abcdefghij";
const OTHER_TOKEN = "test-other-source-token-0123456789-abcde";
const DAY = 24 * 60 * 60 * 1000;
// Noon UTC on the day of the standup.
const NOW = Date.UTC(2026, 9, 13, 12);

const US_SALES = memberEmail("sales", ["us"]);
const KZ_ENGINEER = memberEmail("engineer", ["kz"]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const configured = () => {
  vi.stubEnv("INGEST_TOKEN_STANDUP", TOKEN);
  return convexTest(schema, modules);
};

const auth = (token: string | null) =>
  token === null ? undefined : { Authorization: `Bearer ${token}` };

const getOpen = (t: TestBackend, token: string | null = TOKEN) =>
  t.fetch("/standup/v1/open", { method: "GET", headers: { ...auth(token) } });

const postTasks = (t: TestBackend, body: unknown, token: string | null = TOKEN) =>
  t.fetch("/standup/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(token) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ROUTES = [
  ["GET /standup/v1/open", (t: TestBackend, token: string | null) => getOpen(t, token)],
  ["POST /standup/v1/tasks", (t: TestBackend, token: string | null) => postTasks(t, push(), token)],
] as const;

type Row = Record<string, unknown>;
const task = (over: Row = {}): Row => ({
  key: "a1",
  title: "Send the pilot contract",
  company: "us",
  ...over,
});
const push = (over: Row = {}): Row => ({
  version: 1,
  meetingId: "01KFIREFLIES0001",
  meetingDate: "2026-10-13",
  tasks: [task()],
  ...over,
});
const many = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) =>
    task({ key: `${prefix}${index}`, title: `${prefix} task number ${index}` }),
  );

const tasks = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "standup"))
      .unique(),
  );
const seedTask = (t: TestBackend, over: Row) =>
  t.run((ctx) =>
    ctx.db.insert("tasks", {
      title: "Seeded",
      kind: "task",
      column: "backlog",
      order: 0,
      ...over,
    } as never),
  );
const ok = async (response: Response) => {
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

describe("who may use the standup routes", () => {
  test.each(ROUTES)("%s answers 503 while its token is unset", async (_route, call) => {
    const t = convexTest(schema, modules);
    const response = await call(t, TOKEN);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "ingest_not_configured" });
    expect(await tasks(t)).toEqual([]);
  });

  test.each(ROUTES)("%s: a token too short to be a secret is no token", async (_route, call) => {
    vi.stubEnv("INGEST_TOKEN_STANDUP", "short");
    const t = convexTest(schema, modules);
    expect((await call(t, "short")).status).toBe(503);
  });

  test.each(ROUTES)("%s: another source's token being set does not configure it", async (_r, call) => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", OTHER_TOKEN);
    const t = convexTest(schema, modules);
    expect((await call(t, OTHER_TOKEN)).status).toBe(503);
  });

  describe.each(ROUTES)("%s refuses, with one answer,", (_route, call) => {
    test.each([
      ["no Authorization header", null],
      ["an empty bearer token", ""],
      ["a wrong token", "not-the-token-0123456789-abcdefghijklmno"],
      ["the token with a character more", `${TOKEN}x`],
      ["a personal token", "sos_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"],
    ])("%s", async (_what, token) => {
      const t = configured();
      const response = await call(t, token);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"ok":false,"error":"unauthorized"}');
      expect(await tasks(t)).toEqual([]);
      // Nothing is logged for a caller who was never let in.
      expect(await runs(t)).toEqual([]);
    });

    test("another source's own token", async () => {
      vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", OTHER_TOKEN);
      const t = configured();
      const response = await call(t, OTHER_TOKEN);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"ok":false,"error":"unauthorized"}');
    });

    test("a token another source shares: it could no longer say who is asking", async () => {
      vi.stubEnv("INGEST_TOKEN_LINEAR", TOKEN);
      const t = configured();
      expect((await call(t, TOKEN)).status).toBe(401);
      expect(await tasks(t)).toEqual([]);
    });
  });

  test("an unauthorised push is refused before its body is read", async () => {
    const t = configured();
    // Not JSON and over the cap: either would be answered differently if read.
    const response = await postTasks(t, "x".repeat(MAX_STANDUP_BYTES + 1), "wrong");
    expect(response.status).toBe(401);
  });

  test("the main ingest endpoint writes nothing for the standup's token", async () => {
    const t = configured();
    const response = await t.fetch("/ingest/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: JSON.stringify({
        version: 1,
        source: "standup",
        batchId: "standup-2026-10-13",
        observedAt: "2026-10-13T12:00:00Z",
        snapshots: [{ key: "SECRET_KEY", scope: "us", period: "month", periodStart: "2026-10-01", value: 1 }],
      }),
    });
    expect(response.status).toBe(422);
    // Refused before the body is read: fixed words, and nothing the sender
    // wrote reaches the reply or the run log.
    const body = await response.text();
    expect(JSON.parse(body).error).toBe("tasks_only");
    expect(body).not.toContain("SECRET_KEY");
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(JSON.stringify(runs)).not.toContain("SECRET_KEY");
    expect(JSON.stringify(runs)).not.toContain("standup-2026-10-13");
    expect(await t.run((ctx) => ctx.db.query("metricSnapshots").collect())).toEqual([]);
    expect(await tasks(t)).toEqual([]);
  });
});

describe("GET /standup/v1/open", () => {
  const issue = (over: Row) => ({
    kind: "issue" as const,
    issueId: "i1",
    identifier: "ENG-1",
    title: "Linear issue",
    url: "https://linear.app/x/issue/ENG-1",
    stateType: "started" as const,
    stateName: "In Progress",
    teamKey: "ENG",
    teamName: "First",
    assigneeName: "SECRET Person",
    mine: false,
    priority: 0,
    updatedAt: NOW - DAY,
    ...over,
  });
  const seedIssue = (t: TestBackend, over: Row, owner?: string) =>
    t.run((ctx) => {
      const record = issue(over);
      return ctx.db.insert("mirrorRecords", {
        ...(owner === undefined ? null : { owner }),
        source: "linear",
        externalId: record.issueId,
        sortAt: record.updatedAt,
        syncedAt: NOW,
        record,
      } as never);
    });

  test("an empty board is three empty lists", async () => {
    const t = configured();
    expect(await ok(await getOpen(t))).toEqual({
      ok: true,
      open: [],
      done: [],
      linear: [],
      truncated: false,
    });
  });

  test("it returns titles, companies and columns, and nothing else", async () => {
    const t = configured();
    await seedTask(t, {
      title: "Startup backlog card",
      company: "us",
      notes: "SECRET note",
      assignee: "secret.person@example.com",
      due: "2026-10-20",
    });
    await seedTask(t, { title: "Globex card in progress", company: "kz", column: "doing" });
    await seedTask(t, { title: "Shared card for the week", column: "this_week", kind: "issue" });
    await seedTask(t, {
      title: "Finished last week",
      company: "kz",
      column: "done",
      doneAt: NOW - 13 * DAY,
      notes: "SECRET note",
    });
    await seedTask(t, { title: "Finished yesterday", column: "done", doneAt: NOW - DAY });
    await seedTask(t, { title: "SECRET finished long ago", column: "done", doneAt: NOW - 15 * DAY });
    await seedIssue(t, { issueId: "i1", title: "Startup team issue", teamName: "First Search" });
    await seedIssue(t, {
      issueId: "i2",
      title: "Globex team issue",
      teamName: "Second team",
      stateType: "backlog",
      updatedAt: NOW - 2 * DAY,
    });
    await seedIssue(t, {
      issueId: "i3",
      title: "Platform issue",
      teamName: "Platform",
      stateType: "unstarted",
      updatedAt: NOW - 3 * DAY,
    });
    await seedIssue(t, { issueId: "i4", title: "SECRET finished issue", stateType: "completed" });
    // A teammate's own pushed issues are theirs alone.
    await seedIssue(t, { issueId: "i5", title: "SECRET personal issue" }, US_SALES);

    const response = await getOpen(t);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.clone().text();
    expect(await ok(response)).toEqual({
      ok: true,
      open: [
        { title: "Startup backlog card", company: "us", column: "backlog" },
        { title: "Shared card for the week", company: null, column: "this_week" },
        { title: "Globex card in progress", company: "kz", column: "doing" },
      ],
      done: [
        { title: "Finished yesterday", company: null },
        { title: "Finished last week", company: "kz" },
      ],
      linear: [
        { title: "Startup team issue", company: "us" },
        { title: "Globex team issue", company: "kz" },
        { title: "Platform issue", company: null },
      ],
      truncated: false,
    });
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("@");
    expect(text).not.toContain("linear.app");
    // A read is not a run: nothing is logged for it.
    expect(await runs(t)).toEqual([]);
  });

  test("a board longer than the cap is cut, and says so", async () => {
    const t = configured();
    await t.run(async (ctx) => {
      for (let order = 0; order <= MAX_OPEN_LISTED; order++) {
        await ctx.db.insert("tasks", { title: `Card ${order}`, kind: "task", column: "backlog", order });
      }
    });
    const body = await ok(await getOpen(t));
    expect((body.open as unknown[]).length).toBe(MAX_OPEN_LISTED);
    expect(body.truncated).toBe(true);
  });
});

describe("POST /standup/v1/tasks", () => {
  test("a missing task is added to the bottom of Backlog, marked as the standup's", async () => {
    const t = configured();
    await seedTask(t, { title: "Already here" });
    const body = await ok(
      await postTasks(
        t,
        push({
          tasks: [
            task({ due: "2026-10-20", context: "Agreed with the clinic." }),
            task({ key: "a2", title: "Fix the KZ export", company: "kz", kind: "issue" }),
            task({ key: "a3", title: "Hire a designer", company: null }),
          ],
        }),
      ),
    );
    expect(body).toEqual({ ok: true, added: 3, known: 0, duplicate: 0, nearDuplicate: 0, unassigned: 0 });

    const stored = (await tasks(t)).sort((a, b) => a.order - b.order);
    expect(stored.map((row) => [row.title, row.column, row.order])).toEqual([
      ["Already here", "backlog", 0],
      ["Send the pilot contract", "backlog", 1],
      ["Fix the KZ export", "backlog", 2],
      ["Hire a designer", "backlog", 3],
    ]);
    expect(stored[1]).toMatchObject({
      kind: "task",
      company: "us",
      due: "2026-10-20",
      notes: "From the standup of Oct 13: Agreed with the clinic.",
      origin: { source: "standup", meetingDate: "2026-10-13", meetingId: "01KFIREFLIES0001" },
    });
    expect(stored[1]!.createdBy).toBeUndefined();
    expect(stored[1]!.assignee).toBeUndefined();
    expect(stored[2]).toMatchObject({
      kind: "issue",
      company: "kz",
      notes: "From the standup of Oct 13.",
    });
    expect(stored[3]!.company).toBeUndefined();
  });

  test("a push is a run in the log: counts, and no word of a task", async () => {
    const t = configured();
    await seedTask(t, { title: "SECRET duplicate" });
    await postTasks(
      t,
      push({
        tasks: [
          task({ title: "SECRET title", context: "SECRET context", assignee: "secret@example.com" }),
          task({ key: "a2", title: "secret duplicate.", company: null }),
        ],
      }),
    );
    const log = await runs(t);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      source: "standup",
      batchId: "standup-2026-10-13",
      status: "ok",
      inserted: 1,
      updated: 0,
      unchanged: 1,
    });
    expect(log[0]!.message).toBeUndefined();
    expect(JSON.stringify(log).toLowerCase()).not.toContain("secret");
    expect(await status(t)).toMatchObject({ state: "ok", lastOkAt: NOW });
    expect(JSON.stringify(await status(t)).toLowerCase()).not.toContain("secret");
  });

  test("an empty push is a run too: the standup was read and nothing was missing", async () => {
    const t = configured();
    expect(await ok(await postTasks(t, push({ tasks: [] })))).toEqual({
      ok: true,
      added: 0,
      known: 0,
      duplicate: 0,
      nearDuplicate: 0,
      unassigned: 0,
    });
    expect(await status(t)).toMatchObject({ state: "ok" });
  });

  describe("a push that is not well formed", () => {
    test.each([
      ["an unknown field on the push", push({ summary: "SECRET" }), "push", "has a field the OS does not accept"],
      ["an unknown field on a task", push({ tasks: [task({ notes: "SECRET" })] }), "tasks.0", "has a field the OS does not accept"],
      ["another version", push({ version: 2 }), "version", "is not one of the allowed values"],
      ["a title too long", push({ tasks: [task({ title: `SECRET ${"x".repeat(200)}` })] }), "tasks.0.title", "is too long (200 characters at most)"],
      ["an empty title", push({ tasks: [task({ title: " " })] }), "tasks.0.title", "is empty"],
      ["a context too long", push({ tasks: [task({ context: `SECRET ${"x".repeat(200)}` })] }), "tasks.0.context", "is too long (200 characters at most)"],
      ["a company left out", push({ tasks: [{ key: "a1", title: "SECRET" }] }), "tasks.0.company", "is not one of the allowed values"],
      ["a date that is not one", push({ tasks: [task({ due: "SECRET" })] }), "tasks.0.due", "is not a date (YYYY-MM-DD)"],
      ["a key used twice", push({ tasks: [task(), task({ title: "SECRET" })] }), "tasks.1.key", "repeats an earlier key"],
      ["a meeting in the future", push({ meetingDate: "2026-10-20" }), "meetingDate", "is in the future"],
      [`more than ${MAX_STANDUP_TASKS} tasks`, push({ tasks: many(MAX_STANDUP_TASKS + 1, "SECRET") }), "tasks", "is too long or too large"],
    ])("%s is refused whole, by path and fixed words", async (_what, body, path, message) => {
      const t = configured();
      const response = await postTasks(t, body);
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: "invalid_push",
        issues: [{ path, message }],
      });
      expect(text).not.toContain("SECRET");
      expect(await tasks(t)).toEqual([]);
      // Logged against the source, so a push refused here shows in the OS.
      const log = await runs(t);
      expect(log).toMatchObject([
        { source: "standup", status: "error", message: `invalid_push: ${path} — ${message}` },
      ]);
      expect(JSON.stringify(log)).not.toContain("SECRET");
    });

    test("one bad row refuses its good neighbours", async () => {
      const t = configured();
      const response = await postTasks(
        t,
        push({ tasks: [task(), task({ key: "a2", title: "" })] }),
      );
      expect(response.status).toBe(422);
      expect(await tasks(t)).toEqual([]);
      expect(await t.run((ctx) => ctx.db.query("standupItems").collect())).toEqual([]);
    });

    test("400 when the body is not JSON", async () => {
      const t = configured();
      const response = await postTasks(t, "{SECRET");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_json", issues: [] });
      expect(JSON.stringify(await runs(t))).not.toContain("SECRET");
    });

    test("413 over 64 KB, and a body just under it is read", async () => {
      const t = configured();
      const padded = (bytes: number) => {
        const body = JSON.stringify(push());
        return body + " ".repeat(bytes - body.length);
      };
      const over = await postTasks(t, padded(MAX_STANDUP_BYTES + 1));
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({ ok: false, error: "payload_too_large", issues: [] });
      expect(await tasks(t)).toEqual([]);
      expect((await postTasks(t, padded(MAX_STANDUP_BYTES))).status).toBe(200);
    });
  });

  describe("sending a meeting again", () => {
    test("adds nothing: every item is known", async () => {
      const t = configured();
      const body = push({ tasks: [task(), task({ key: "a2", title: "Fix the export" })] });
      await postTasks(t, body);
      expect(await ok(await postTasks(t, body))).toEqual({
        ok: true,
        added: 0,
        known: 2,
        duplicate: 0,
        nearDuplicate: 0,
        unassigned: 0,
      });
      expect(await tasks(t)).toHaveLength(2);
    });

    test("only the new items of a longer second push are added", async () => {
      const t = configured();
      await postTasks(t, push());
      expect(
        await ok(await postTasks(t, push({ tasks: [task(), task({ key: "a2", title: "Fix the export" })] }))),
      ).toMatchObject({ added: 1, known: 1 });
    });

    test("a card the team deleted is not made again", async () => {
      const t = configured();
      const owner = await signInAsOwner(t);
      await postTasks(t, push());
      const [card] = await tasks(t);
      await owner.mutation(api.tasks.remove, { id: card!._id });
      expect(await tasks(t)).toEqual([]);

      expect(await ok(await postTasks(t, push()))).toMatchObject({ added: 0, known: 1 });
      expect(await tasks(t)).toEqual([]);
    });

    test("an item is its meeting and its key: the same key in another meeting is new", async () => {
      const t = configured();
      await postTasks(t, push());
      expect(
        await ok(
          await postTasks(t, push({ meetingId: "01KFIREFLIES0002", tasks: [task({ title: "Something else" })] })),
        ),
      ).toMatchObject({ added: 1, known: 0 });
    });

    test("a known item's new wording changes nothing on the board", async () => {
      const t = configured();
      await postTasks(t, push());
      await postTasks(t, push({ tasks: [task({ title: "Reworded entirely" })] }));
      expect((await tasks(t)).map((row) => row.title)).toEqual(["Send the pilot contract"]);
    });
  });

  describe("a task the board already holds", () => {
    const sendOne = async (t: TestBackend, over: Row) =>
      ok(await postTasks(t, push({ tasks: [task(over)] })));

    test.each([
      ["letter case", "SEND THE PILOT CONTRACT"],
      ["spacing", "  Send   the pilot  contract "],
      ["a trailing period", "Send the pilot contract."],
      ["punctuation", "Send the pilot-contract!"],
    ])("is skipped whatever its %s", async (_what, title) => {
      const t = configured();
      await seedTask(t, { title: "Send the pilot contract", company: "us", column: "doing" });
      expect(await sendOne(t, { title })).toEqual({
        ok: true,
        added: 0,
        known: 0,
        duplicate: 1,
        nearDuplicate: 0,
        unassigned: 0,
      });
      expect(await tasks(t)).toHaveLength(1);
    });

    test("a near one (convex/lib/duplicates.ts) of an open card is skipped too, and counted apart", async () => {
      const t = configured();
      await seedTask(t, { title: "Send the signed pilot contract to the clinic", company: "us" });
      expect(await sendOne(t, { title: "Send signed pilot contract to clinic" })).toEqual({
        ok: true,
        added: 0,
        known: 0,
        duplicate: 0,
        nearDuplicate: 1,
        unassigned: 0,
      });
      expect(await tasks(t)).toHaveLength(1);
    });

    test("different words are a different task", async () => {
      const t = configured();
      await seedTask(t, { title: "Sign the pilot contract", company: "us" });
      expect(await sendOne(t, {})).toMatchObject({ added: 1, duplicate: 0 });
    });

    test("the other company's card of the same name is not this one", async () => {
      const t = configured();
      await seedTask(t, { title: "Send the pilot contract", company: "kz" });
      expect(await sendOne(t, { company: "us" })).toMatchObject({ added: 1, duplicate: 0 });
    });

    test("a shared card of the same name is", async () => {
      const t = configured();
      await seedTask(t, { title: "Send the pilot contract" });
      expect(await sendOne(t, { company: "us" })).toMatchObject({ added: 0, duplicate: 1 });
    });

    test("a shared task is held against either company's card", async () => {
      const t = configured();
      await seedTask(t, { title: "Send the pilot contract", company: "kz" });
      expect(await sendOne(t, { company: null })).toMatchObject({ added: 0, duplicate: 1 });
    });

    test("one finished in the last 14 days still counts", async () => {
      const t = configured();
      await seedTask(t, {
        title: "Send the pilot contract",
        company: "us",
        column: "done",
        doneAt: NOW - 13 * DAY,
      });
      expect(await sendOne(t, {})).toMatchObject({ added: 0, duplicate: 1 });
    });

    test("one finished longer ago does not", async () => {
      const t = configured();
      await seedTask(t, {
        title: "Send the pilot contract",
        company: "us",
        column: "done",
        doneAt: NOW - 15 * DAY,
      });
      expect(await sendOne(t, {})).toMatchObject({ added: 1, duplicate: 0 });
    });

    test("the same task twice in one push is added once", async () => {
      const t = configured();
      expect(
        await ok(
          await postTasks(
            t,
            push({ tasks: [task(), task({ key: "a2", title: "send the pilot contract." })] }),
          ),
        ),
      ).toMatchObject({ added: 1, duplicate: 1 });
    });

    test("a duplicate is remembered: it is not added later, once the card it matched is gone", async () => {
      const t = configured();
      const id = await seedTask(t, { title: "Send the pilot contract", company: "us" });
      await sendOne(t, {});
      await t.run((ctx) => ctx.db.delete(id));
      expect(await sendOne(t, {})).toMatchObject({ added: 0, known: 1, duplicate: 0 });
      expect(await tasks(t)).toEqual([]);
    });
  });

  describe("who a task is given to", () => {
    const start = async () => {
      const t = configured();
      await addMember(t, { email: US_SALES, role: "sales", companies: ["us"] });
      await addMember(t, { email: KZ_ENGINEER, role: "engineer", companies: ["kz"] });
      return t;
    };
    const given = async (t: TestBackend, over: Row) => {
      const response = await postTasks(t, push({ tasks: [task(over)] }));
      const text = await response.text();
      return { body: JSON.parse(text) as Row, text, stored: (await tasks(t)).at(-1) };
    };

    test("a teammate on the task's company, however the address is written", async () => {
      const t = await start();
      const { body, stored } = await given(t, { assignee: `  ${US_SALES.toUpperCase()} ` });
      expect(body).toMatchObject({ added: 1, unassigned: 0 });
      expect(stored?.assignee).toBe(US_SALES);
    });

    test("the owner, on either company", async () => {
      const t = await start();
      const { body, stored } = await given(t, { company: "kz", assignee: OWNER });
      expect(body).toMatchObject({ added: 1, unassigned: 0 });
      expect(stored?.assignee).toBe(OWNER);
    });

    test("any teammate, for a shared task", async () => {
      const t = await start();
      const { stored } = await given(t, { company: null, assignee: KZ_ENGINEER });
      expect(stored?.assignee).toBe(KZ_ENGINEER);
    });

    test("a teammate who is not on the task's company: added, unassigned", async () => {
      const t = await start();
      const { body, text, stored } = await given(t, { company: "us", assignee: KZ_ENGINEER });
      expect(body).toEqual({ ok: true, added: 1, known: 0, duplicate: 0, nearDuplicate: 0, unassigned: 1 });
      expect(stored?.title).toBe("Send the pilot contract");
      expect(stored?.assignee).toBeUndefined();
      expect(text).not.toContain(KZ_ENGINEER);
    });

    test.each([
      ["an address that is nobody's", "secret.stranger@example.com"],
      ["something that is not an address", "SECRET Person"],
      ["an empty one", ""],
    ])("%s: added, unassigned, and never said back", async (_what, assignee) => {
      const t = await start();
      const { body, text, stored } = await given(t, { assignee });
      expect(body).toEqual({ ok: true, added: 1, known: 0, duplicate: 0, nearDuplicate: 0, unassigned: 1 });
      expect(stored?.assignee).toBeUndefined();
      expect(text.toLowerCase()).not.toContain("secret");
      expect(JSON.stringify(await runs(t)).toLowerCase()).not.toContain("secret");
    });

    test("a teammate on the company without the board: added, unassigned (the board's own rule, `createTask`)", async () => {
      const t = await start();
      const reader = memberEmail("cofounder", ["us"]);
      await addMember(t, { email: reader, role: "cofounder", companies: ["us"], areas: ["finance"] });
      const { body, stored } = await given(t, { assignee: reader });
      expect(body).toMatchObject({ added: 1, unassigned: 1 });
      expect(stored?.assignee).toBeUndefined();
    });

    test("the card is the board's own: cleaned as `tasks.create` cleans it, at the bottom of Backlog", async () => {
      const t = await start();
      await seedTask(t, { title: "Already there", order: 4 });
      const { stored } = await given(t, { title: "  Send the pilot contract  " });
      expect(stored).toMatchObject({ title: "Send the pilot contract", column: "backlog", order: 5 });
      expect(stored?.createdBy).toBeUndefined();
    });

    test("a task with no assignee is not counted as unassigned", async () => {
      const t = await start();
      expect((await given(t, {})).body).toMatchObject({ added: 1, unassigned: 0 });
    });
  });

  describe("how many a day", () => {
    const fill = async (t: TestBackend) => {
      for (const [index, size] of [MAX_STANDUP_TASKS, MAX_STANDUP_TASKS].entries()) {
        const response = await postTasks(
          t,
          push({ meetingId: `meeting${index}`, tasks: many(size, `m${index}x`) }),
        );
        expect(response.status).toBe(200);
      }
      expect(await tasks(t)).toHaveLength(MAX_STANDUP_TASKS_PER_DAY);
    };

    test(`the ${MAX_STANDUP_TASKS_PER_DAY} of a day are taken, and one more is refused`, async () => {
      const t = configured();
      await fill(t);
      const response = await postTasks(t, push({ meetingId: "meeting9" }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        ok: false,
        error: "too_many_tasks",
        issues: [{ path: "tasks", message: TOO_MANY_TODAY_WORDS }],
      });
      expect(await tasks(t)).toHaveLength(MAX_STANDUP_TASKS_PER_DAY);
      expect((await runs(t)).at(-1)).toMatchObject({
        status: "error",
        message: `too_many_tasks: tasks — ${TOO_MANY_TODAY_WORDS}`,
      });
    });

    test("a push that would pass the limit is refused whole", async () => {
      const t = configured();
      await postTasks(t, push({ meetingId: "m0", tasks: many(MAX_STANDUP_TASKS, "m0x") }));
      await postTasks(t, push({ meetingId: "m1", tasks: many(MAX_STANDUP_TASKS - 1, "m1x") }));
      const response = await postTasks(t, push({ meetingId: "m2", tasks: many(2, "m2x") }));
      expect(response.status).toBe(429);
      expect(await tasks(t)).toHaveLength(MAX_STANDUP_TASKS_PER_DAY - 1);
      // One still fits.
      expect((await postTasks(t, push({ meetingId: "m3", tasks: many(1, "m3x") }))).status).toBe(200);
    });

    test("a duplicate counts toward the day: it was taken and decided", async () => {
      const t = configured();
      await fill(t);
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("tasks").collect()) await ctx.db.delete(row._id);
      });
      // The board is empty again, and the day is still full.
      expect((await postTasks(t, push({ meetingId: "meeting9" }))).status).toBe(429);
    });

    test("sending a known meeting again is never refused for the limit", async () => {
      const t = configured();
      await fill(t);
      const again = await postTasks(
        t,
        push({ meetingId: "meeting0", tasks: many(MAX_STANDUP_TASKS, "m0x") }),
      );
      expect(await ok(again)).toMatchObject({ added: 0, known: MAX_STANDUP_TASKS });
    });

    test("the next UTC day starts from nothing", async () => {
      const t = configured();
      await fill(t);
      vi.setSystemTime(Date.UTC(2026, 9, 14, 0, 0, 1));
      const response = await postTasks(t, push({ meetingId: "meeting9", meetingDate: "2026-10-14" }));
      expect(await ok(response)).toMatchObject({ added: 1 });
    });
  });
});

describe("the standup on Settings → Sources", () => {
  const row = async (t: TestBackend) => {
    const owner = await signInAsOwner(t);
    return (await owner.query(api.sources.list, {})).find((source) => source.id === "standup");
  };

  test("not configured, and naming its variable, until the token is set", async () => {
    expect(await row(convexTest(schema, modules))).toMatchObject({
      label: "Standup tasks",
      configured: false,
      missingEnv: ["INGEST_TOKEN_STANDUP"],
      status: null,
    });
  });

  test("configured with the token, and it says when it last ran", async () => {
    const t = configured();
    expect(await row(t)).toMatchObject({ configured: true, fedBy: "push", status: null });
    await postTasks(t, push());
    expect(await row(t)).toMatchObject({
      status: { state: "ok", message: null, lastRunAt: NOW, lastOkAt: NOW },
    });
  });

  test("a refused push shows there, in fixed words, and keeps the last good run", async () => {
    const t = configured();
    await postTasks(t, push());
    vi.setSystemTime(NOW + 1000);
    await postTasks(t, push({ tasks: [task({ key: "a2", title: "" })] }));
    expect(await row(t)).toMatchObject({
      status: {
        state: "error",
        message: "invalid_push: tasks.0.title — is empty",
        lastRunAt: NOW + 1000,
        lastOkAt: NOW,
      },
    });
  });
});

describe("a standup card on the board", () => {
  test("tasks.board returns where a card came from, and null for one typed in", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.tasks.create, { title: "Typed in" });
    await postTasks(t, push());
    const { backlog } = await owner.query(api.tasks.board, {});
    expect(backlog.map((card) => [card.title, card.origin])).toEqual([
      ["Typed in", null],
      [
        "Send the pilot contract",
        { source: "standup", meetingDate: "2026-10-13", meetingId: "01KFIREFLIES0001" },
      ],
    ]);
  });

  test("a teammate on Globex alone is not sent Startup's standup task", async () => {
    const t = configured();
    const kzEngineer = await signInAsEngineer(t, ["kz"]);
    await postTasks(
      t,
      push({
        tasks: [
          task({ title: "Startup standup task", company: "us" }),
          task({ key: "a2", title: "Globex standup task", company: "kz" }),
          task({ key: "a3", title: "Shared standup task", company: null }),
        ],
      }),
    );
    const board = await kzEngineer.query(api.tasks.board, {});
    expect(Object.values(board).flat().map((card) => card.title)).toEqual([
      "Globex standup task",
      "Shared standup task",
    ]);
    const [startup] = (await tasks(t)).filter((row) => row.company === "us");
    await expect(
      kzEngineer.mutation(api.tasks.update, { id: startup!._id, title: "Mine now" }),
    ).rejects.toThrow(NOT_ALLOWED);
  });

  test("an open issue from the standup carries its origin to the scorecard list", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await postTasks(t, push({ tasks: [task({ kind: "issue" })] }));
    expect(await owner.query(api.tasks.openIssues, {})).toMatchObject([
      { title: "Send the pilot contract", origin: { source: "standup", meetingDate: "2026-10-13" } },
    ]);
  });

  test("a flagged card says so on the board until someone picks its company", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await postTasks(t, push({ tasks: [task({ title: "Post the designer role", company: null })] }));
    const before = await owner.query(api.tasks.board, {});
    expect(before.backlog.map((card) => [card.company, card.needsCompany])).toEqual([[null, true]]);
    // Choosing "shared" on purpose is a choice too: the flag goes either way.
    await owner.mutation(api.tasks.update, { id: before.backlog[0]!.id, company: null });
    const after = await owner.query(api.tasks.board, {});
    expect(after.backlog[0]!.needsCompany).toBe(false);
    expect((await tasks(t))[0]!.needsCompany).toBeUndefined();
  });

  test("editing and moving a standup card keeps its origin", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await postTasks(t, push());
    const [card] = await tasks(t);
    await owner.mutation(api.tasks.update, { id: card!._id, title: "Reworded", column: "doing" });
    expect((await tasks(t))[0]).toMatchObject({
      title: "Reworded",
      column: "doing",
      origin: { source: "standup" },
    });
  });
});

// ── Notifications ───────────────────────────────────────────────────────────

describe("who the standup tells", () => {
  const notifications = (t: TestBackend) =>
    t.run((ctx) => ctx.db.query("notifications").collect());

  test("whoever a card is given to is told once, by the standup and by no person", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    const engineer = await signInAsEngineer(t, ["kz"]);
    await postTasks(
      t,
      push({
        tasks: [
          task({ key: "a1", title: "Check the export", company: "kz", assignee: KZ_ENGINEER }),
          task({ key: "a2", title: "Nobody's task", company: "kz" }),
        ],
      }),
    );
    const [card] = await tasks(t);
    const rows = await notifications(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "assigned",
      actor: { type: "system", source: "standup" },
      taskId: card!._id,
      company: "kz",
      title: "Check the export",
    });
    expect((await engineer.query(api.notifications.mine, {})).rows).toMatchObject([
      { kind: "assigned", title: "Check the export", actor: { type: "system", source: "standup" } },
    ]);
    expect((await owner.query(api.notifications.mine, {})).rows).toEqual([]);
  });

  test("a standup card is announced in no Telegram group: nobody sent it, so there is no assigner to name", async () => {
    const t = configured();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-telegram-token-0123456789");
    await signInAsEngineer(t, ["kz"]);
    await postTasks(t, push({ tasks: [task({ company: "kz", assignee: KZ_ENGINEER })] }));
    expect((await tasks(t))[0]?.assignee).toBe(KZ_ENGINEER);
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.map((job) => job.name)).not.toContain("telegram:notify");
  });

  test("a meeting sent again tells nobody a second time", async () => {
    const t = configured();
    await signInAsEngineer(t, ["kz"]);
    const body = push({ tasks: [task({ company: "kz", assignee: KZ_ENGINEER })] });
    await postTasks(t, body);
    await postTasks(t, body);
    expect(await notifications(t)).toHaveLength(1);
  });

  test("an assignee the standup could not keep is told nothing", async () => {
    const t = configured();
    await signInAsEngineer(t, ["kz"]);
    await postTasks(t, push({ tasks: [task({ company: "us", assignee: KZ_ENGINEER })] }));
    expect(await tasks(t)).toHaveLength(1);
    expect(await notifications(t)).toEqual([]);
  });

  test("no title reaches the run log through a notification", async () => {
    const t = configured();
    await signInAsEngineer(t, ["kz"]);
    await postTasks(
      t,
      push({ tasks: [task({ title: "SECRET title", company: "kz", assignee: KZ_ENGINEER })] }),
    );
    expect(await notifications(t)).toHaveLength(1);
    expect(JSON.stringify([await runs(t), await status(t)])).not.toContain("SECRET");
  });
});

// Who a card is for and which company it is, from a name said in the meeting
// and the card's own words (convex/lib/standupMapping.ts). Every clinic, deal,
// repository and person here is made up.
describe("the standup places a card: its person and its company", () => {
  const LENA = memberEmail("sales", ["us", "kz"]);
  const KONSTANTIN = memberEmail("engineer", ["kz"]);

  const seedPlaces = async (t: TestBackend) => {
    await addMember(t, { email: LENA, role: "sales", companies: ["us", "kz"] });
    await addMember(t, { email: KONSTANTIN, role: "engineer", companies: ["kz"] });
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: LENA, name: "Lena Sample" });
      await ctx.db.insert("users", { email: KONSTANTIN, name: "Konstantin Example" });
      for (const name of ["Example Dental", "Placeholder Clinic"]) {
        await ctx.db.insert("customers", {
          source: "cfo",
          nameKey: name.toLowerCase(),
          name,
          market: "kz",
          status: "active",
          currency: "KZT",
          syncedAt: 1,
        });
      }
      await ctx.db.insert("deals", {
        source: "manual",
        externalId: "d1",
        name: "Brightside Specialty",
        stage: "lead",
        order: 0,
        market: "us",
      });
      for (const [name, company] of [
        ["vertical-startup", "us"],
        ["globex-crm", "kz"],
      ] as const) {
        await ctx.db.insert("mirrorRecords", {
          source: "github",
          externalId: `repo:made-up/${name}`,
          sortAt: 1,
          syncedAt: 2,
          record: {
            kind: "repo",
            repoId: `made-up/${name}`,
            org: "made-up",
            name,
            company,
            mergedLastWeek: 0,
            open: 0,
            stuck: 0,
            main: "passing",
            pushedAt: "2026-10-13",
          },
        });
      }
    });
  };

  const byKey = async (t: TestBackend) => {
    const rows = await tasks(t);
    return new Map(rows.map((row) => [row.title, row]));
  };

  test("the person an item names wins over who said it; who said it counts when nobody is named", async () => {
    const t = configured();
    await seedPlaces(t);
    await ok(
      await postTasks(
        t,
        push({
          tasks: [
            task({ key: "a1", title: "Send the Example Dental contract", company: null, named: "Константин", speaker: "Lena" }),
            task({ key: "a2", title: "Call Brightside Specialty", company: null, speaker: "Lena S." }),
            task({ key: "a3", title: "Write the payer FAQ", company: "us", named: "Nobody We Know" }),
          ],
        }),
      ),
    );
    const rows = await byKey(t);
    expect(rows.get("Send the Example Dental contract")).toMatchObject({ company: "kz", assignee: KONSTANTIN });
    expect(rows.get("Call Brightside Specialty")).toMatchObject({ company: "us", assignee: LENA });
    expect(rows.get("Write the payer FAQ")!.assignee).toBeUndefined();
    // A name said is used to find a person and is kept nowhere.
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("standupItems").collect()))).not.toContain("Lena");
  });

  test("a person named who is not on the card's company is not given it", async () => {
    const t = configured();
    await seedPlaces(t);
    await ok(await postTasks(t, push({ tasks: [task({ title: "Fix the CPT lookup", company: null, named: "Konstantin" })] })));
    expect((await byKey(t)).get("Fix the CPT lookup")).toMatchObject({ company: "us" });
    expect((await byKey(t)).get("Fix the CPT lookup")!.assignee).toBeUndefined();
  });

  test("an unclear card is shared and flagged; a card the session called shared is not flagged", async () => {
    const t = configured();
    await seedPlaces(t);
    await ok(
      await postTasks(
        t,
        push({
          tasks: [
            task({ key: "a1", title: "Post the designer role", company: null }),
            task({ key: "a2", title: "Renew the office lease", company: "shared" }),
          ],
        }),
      ),
    );
    const rows = await byKey(t);
    expect(rows.get("Post the designer role")).toMatchObject({ needsCompany: true });
    expect(rows.get("Post the designer role")!.company).toBeUndefined();
    expect(rows.get("Renew the office lease")!.company).toBeUndefined();
    expect(rows.get("Renew the office lease")!.needsCompany).toBeUndefined();
  });

  test("an unclear card given to someone on one company alone is that company's", async () => {
    const t = configured();
    await seedPlaces(t);
    await ok(await postTasks(t, push({ tasks: [task({ title: "Review the onboarding copy", company: null, named: "Konstantin" })] })));
    expect((await byKey(t)).get("Review the onboarding copy")).toMatchObject({ company: "kz", assignee: KONSTANTIN });
  });

  // The last standup's envelope as the session saved it: the companies left
  // for the OS to place (null), as the session sends when it is unsure.
  const LAST_STANDUP = {
    version: 1,
    meetingId: "01KFIREFLIES0042",
    meetingDate: "2026-10-13",
    tasks: [
      { key: "a1", title: "Send the pilot contract to Example Dental", company: null, named: "Lena" },
      { key: "a2", title: "Fix the CPT lookup timeout", company: null, speaker: "Konstantin" },
      { key: "a3", title: "Выставить счёт Placeholder Clinic в тенге", company: null },
      { key: "a4", title: "Merge the eligibility fix in vertical-startup", company: null },
      { key: "a5", title: "Book the follow-up demo with Brightside Specialty", company: null, named: "Lena" },
      { key: "a6", title: "Move the reports export into globex-crm", company: null, named: "Константин" },
      { key: "a7", title: "Prepare the investor update", company: null },
      { key: "a8", title: "Check Kaspi payments for October", company: null },
      { key: "a9", title: "Draft the BAA for the new payer", company: null },
      { key: "a10", title: "Update the Globex onboarding screens", company: null },
      { key: "a11", title: "Ask the Almaty clinics about the new form", company: null },
      { key: "a12", title: "Post the designer role", company: null },
    ],
  };

  test("the last standup's saved envelope: a company on at least 90% of its cards, the rest flagged", async () => {
    const t = configured();
    await seedPlaces(t);
    await ok(await postTasks(t, LAST_STANDUP));
    const rows = await tasks(t);
    expect(rows).toHaveLength(LAST_STANDUP.tasks.length);
    const placed = rows.filter((row) => row.company !== undefined);
    expect(placed.length / rows.length).toBeGreaterThanOrEqual(0.9);
    // Every card is the standup's, by meeting.
    for (const row of rows) expect(row.origin).toMatchObject({ source: "standup", meetingId: "01KFIREFLIES0042" });
    // What could not be placed is flagged, and only that.
    expect(rows.filter((row) => row.needsCompany === true).map((row) => row.title)).toEqual(["Post the designer role"]);
    expect(rows.filter((row) => row.assignee !== undefined)).toHaveLength(3);
  });

  test("placing a meeting again sets the company of its cards that were left shared", async () => {
    const t = configured();
    await seedPlaces(t);
    // As the import before this change left them: shared, unflagged.
    for (const [index, item] of LAST_STANDUP.tasks.entries()) {
      await seedTask(t, {
        title: item.title,
        order: index,
        origin: { source: "standup", meetingDate: "2026-10-13", meetingId: LAST_STANDUP.meetingId },
      });
    }
    await seedTask(t, { title: "Typed on the board about Example Dental", order: 99 });
    const result = await t.mutation(internal.standup.placeMeeting, { meetingId: LAST_STANDUP.meetingId });
    expect(result).toEqual({ placed: 11, flagged: 1 });
    const rows = await byKey(t);
    expect(rows.get("Send the pilot contract to Example Dental")!.company).toBe("kz");
    expect(rows.get("Post the designer role")!.needsCompany).toBe(true);
    // Another meeting's card, or one typed on the board, is left alone.
    expect(rows.get("Typed on the board about Example Dental")!.company).toBeUndefined();
  });
});
