import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import {
  APP_ID,
  DAY_S,
  HOUR_S,
  NOW_MS,
  NOW_S,
  conversation,
  searchPage,
  startedOn,
  statistics,
} from "./connectors/intercom.fixtures";
import { parseSearch, toRecord } from "./lib/supportParse";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// Obviously not a real token.
const TOKEN = "fake-intercom-push-token-0123456789-abcdefg";
const GMAIL = "fake-gmail-push-token-0123456789-abcdefgh";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_MS));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configured() {
  vi.stubEnv("INGEST_TOKEN_INTERCOM", TOKEN);
  return convexTest(schema, modules);
}

/** A conversation as the hourly task's script maps it. */
const record = (over: Record<string, unknown> = {}) =>
  toRecord(parseSearch(searchPage([conversation(over)])).conversations[0]!);
const envelope = (records: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  source: "intercom",
  batchId: "intercom-2026-10-17",
  observedAt: new Date(NOW_MS).toISOString(),
  appIdCode: APP_ID,
  records,
  ...(records.length === 0 ? { empty: true } : {}),
  ...extra,
});

type Reply = { status: number; text: string; json: () => unknown };
async function post(t: TestBackend, body: unknown, token = TOKEN): Promise<Reply> {
  const response = await t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

const stored = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("supportConversations").collect()).sort((a, b) => a.intercomId.localeCompare(b.intercomId)),
  );
const ids = async (t: TestBackend) => (await stored(t)).map((row) => row.intercomId);
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "intercom"))
      .unique(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const everything = async (t: TestBackend) =>
  JSON.stringify([
    await stored(t),
    await status(t),
    await runs(t),
    await t.run((ctx) => ctx.db.query("supportWorkspace").collect()),
  ]);

describe("POST /ingest/v1 as intercom", () => {
  test("without its token set, nothing is accepted", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t, envelope([record()]))).status).toBe(503);
    vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL);
    expect((await post(t, envelope([record()]))).status).toBe(401);
  });

  test("a push is stored: one row a chat, the workspace's id, the run and the status", async () => {
    const t = configured();
    const reply = await post(t, envelope([record(), record({ id: "2", ...startedOn("http://localhost:3000/") })]));
    expect([reply.status, reply.json()]).toEqual([200, { ok: true, inserted: 2, updated: 0, unchanged: 0, removed: 0 }]);
    expect((await stored(t)).map((row) => [row.intercomId, row.origin, row.pageArea])).toEqual([
      ["2", "test", null],
      ["900000001", "customer", "studies/report"],
    ]);
    expect(await status(t)).toMatchObject({ state: "ok", lastOkAt: NOW_MS });
    expect((await runs(t)).map((run) => [run.source, run.status, run.inserted])).toEqual([["intercom", "ok", 2]]);
    expect(await t.run((ctx) => ctx.db.query("supportWorkspace").collect())).toMatchObject([
      { appId: APP_ID, readAt: NOW_MS },
    ]);
  });

  test("nothing private is stored anywhere: no body, subject, contact, address, phone, company or URL", async () => {
    const t = configured();
    await post(t, envelope([record()]));
    const all = await everything(t);
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain("@");
    expect(all).not.toContain("https://");
    expect(all).not.toContain(TOKEN);
  });

  test("a record with a field the OS does not keep refuses the whole push, in fixed words that quote nothing", async () => {
    const t = configured();
    await post(t, envelope([record()]));
    const reply = await post(t, envelope([record({ id: "5" }), { ...record({ id: "6" }), body: "SECRET BODY" }]));
    expect(reply.status).toBe(422);
    expect(reply.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    expect(await ids(t)).toEqual(["900000001"]);
    expect(await status(t)).toMatchObject({ state: "error", lastOkAt: NOW_MS });
    expect(await everything(t)).not.toContain("SECRET");
  });

  test("the workspace's id is needed with the records, and nowhere else", async () => {
    const t = configured();
    const reply = await post(t, envelope([record()], { appIdCode: undefined }));
    expect(reply.status).toBe(422);
    expect(JSON.stringify(reply.json())).toContain("appIdCode");
    expect((await post(t, { ...envelope([]), records: undefined, empty: undefined, snapshots: [] })).status).toBe(422);
  });

  test("Intercom's token carries records and nothing else; another token cannot send Intercom's", async () => {
    const t = configured();
    vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL);
    const numbers = await post(t, {
      version: 1,
      source: "intercom",
      batchId: "x",
      observedAt: "2026-10-17T08:00:00Z",
      snapshots: [{ key: "signups", scope: "kz_product", period: "week", periodStart: "2026-10-05", value: 1 }],
    });
    expect(numbers.status).toBe(422);
    expect((await post(t, envelope([record()]), GMAIL)).status).toBe(403);
    const gmailWithApp = await post(t, { ...envelope([record()]), source: "gmail" }, GMAIL);
    expect(gmailWithApp.status).toBe(422);
    expect(await ids(t)).toEqual([]);
  });

  test("a push is the whole set: a stored chat it no longer holds goes if it was open or updated in its window", async () => {
    const t = configured();
    const old = NOW_S - 120 * DAY_S;
    await post(
      t,
      envelope([
        record({ id: "1" }),
        record({ id: "2", state: "closed", open: false, updated_at: NOW_S - 10 * DAY_S }),
        record({ id: "3", state: "closed", open: false, created_at: old, updated_at: old }),
      ]),
    );
    // Removing both stored chats of the window is more than half: said explicitly.
    const reply = await post(t, envelope([record({ id: "4" })], { allowShrink: true }));
    expect(reply.json()).toMatchObject({ inserted: 1, removed: 2 });
    // Closed and last updated before the 90 days a push covers: kept until 180.
    expect(await ids(t)).toEqual(["3", "4"]);
  });

  test("a chat that changed is updated; one that did not is left", async () => {
    const t = configured();
    await post(t, envelope([record({ id: "1" }), record({ id: "2" })]));
    const reply = await post(t, envelope([record({ id: "1" }), record({ id: "2", state: "closed", open: false })]));
    expect(reply.json()).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
  });

  test("an empty list without empty: true is a failed read; with it over stored chats, it needs allowShrink too", async () => {
    const t = configured();
    await post(t, envelope([record({ id: "1" })]));
    expect((await post(t, { ...envelope([]), empty: undefined })).status).toBe(422);
    expect((await post(t, envelope([]))).status).toBe(422);
    expect(await ids(t)).toEqual(["1"]);
    expect((await post(t, envelope([], { allowShrink: true }))).status).toBe(200);
    expect(await ids(t)).toEqual([]);
  });

  test("a push that would remove more than half of the chats it covers is refused, in words, and removes nothing", async () => {
    const t = configured();
    await post(t, envelope([record({ id: "1" }), record({ id: "2" }), record({ id: "3" }), record({ id: "4" })]));
    const runsBefore = (await runs(t)).length;
    const reply = await post(t, envelope([record({ id: "1" })]));
    expect(reply.status).toBe(422);
    expect(reply.json()).toEqual({
      ok: false,
      error: "support_shrank",
      issues: [
        {
          path: "records",
          message: "This push would remove 3 of the 4 chats stored for the last 90 days. Send it with allowShrink if that is right.",
        },
      ],
    });
    expect(await ids(t)).toEqual(["1", "2", "3", "4"]);
    expect((await runs(t)).length).toBe(runsBefore + 1);
    expect(await status(t)).toMatchObject({ state: "error" });
    // Half exactly is not more than half.
    expect((await post(t, envelope([record({ id: "1" }), record({ id: "2" })]))).status).toBe(200);
    expect(await ids(t)).toEqual(["1", "2"]);
  });

  test("allowShrink belongs to Intercom's push, and to no other records push", async () => {
    const t = configured();
    vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL);
    const gmail = await post(
      t,
      { version: 1, source: "gmail", batchId: "x", observedAt: "2026-10-17T08:00:00Z", records: [], empty: true, allowShrink: true },
      GMAIL,
    );
    expect(gmail.status).toBe(422);
  });

  test("a closed chat not updated in 180 days is deleted; an open one is kept", async () => {
    const t = configured();
    const old = NOW_S - 181 * DAY_S;
    await post(
      t,
      envelope([
        record({ id: "1", state: "closed", open: false, updated_at: old, created_at: old }),
        record({ id: "2", updated_at: old, created_at: old }),
      ]),
    );
    expect(await ids(t)).toEqual(["2"]);
  });
});

describe("support.overview", () => {
  async function seeded() {
    const t = configured();
    await post(
      t,
      envelope([
        record({ id: "1" }),
        record({
          id: "2",
          ...startedOn("http://localhost:3000/dashboard"),
          admin_assignee_id: 41,
          admin_assignee: { id: 41, name: "Made-up Teammate" },
        }),
        record({
          id: "3",
          statistics: statistics({
            first_admin_reply_at: NOW_S - 3 * HOUR_S,
            time_to_admin_reply: 3600,
            last_admin_reply_at: NOW_S - 3 * HOUR_S,
          }),
        }),
      ]),
    );
    return t;
  }

  test("the owner is sent each chat's kept fields, the workspace's id and how the last push went", async () => {
    const t = await seeded();
    const view = await (await signInAsOwner(t)).query(api.support.overview, {});
    expect(view.configured).toBe(true);
    expect(view.appId).toBe(APP_ID);
    expect(view.status).toEqual({ state: "ok", lastRunAt: NOW_MS, lastOkAt: NOW_MS, failure: null });
    expect(view.rows.map((row) => [row.intercomId, row.origin])).toEqual([
      ["1", "customer"],
      ["2", "test"],
      ["3", "customer"],
    ]);
    expect(view.rows[1]).toMatchObject({ assigneeId: "41", assigneeName: "Made-up Teammate" });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  test("it reads only what the page shows: open chats, and closed ones begun in the 63 days before the push", async () => {
    const t = configured();
    const old = NOW_S - 70 * DAY_S;
    await post(
      t,
      envelope([
        record({ id: "1" }),
        // Open, begun long ago: inbox hygiene counts it.
        record({ id: "2", created_at: NOW_S - 120 * DAY_S }),
        // Closed, begun 70 days ago but updated lately: in the store, not on the page.
        record({ id: "3", state: "closed", open: false, created_at: old, updated_at: NOW_S - DAY_S }),
        record({ id: "4", state: "closed", open: false, created_at: NOW_S - 10 * DAY_S }),
      ]),
    );
    const view = await (await signInAsOwner(t)).query(api.support.overview, {});
    expect(view.rows.map((row) => row.intercomId)).toEqual(["2", "4", "1"]);
    expect(await ids(t)).toEqual(["1", "2", "3", "4"]);
  });

  test("no read of the inbox's table is unbounded", () => {
    const code = readFileSync(join(__dirname, "support.ts"), "utf8");
    expect(code).not.toContain(".collect()");
  });

  test("a refused push is sent as a key, never its message; what was pushed before stays", async () => {
    const t = await seeded();
    await post(t, envelope([{ ...record(), body: "x" }]));
    const view = await (await signInAsOwner(t)).query(api.support.overview, {});
    expect(view.status.failure).toBe("refused");
    expect(JSON.stringify(view)).not.toContain("invalid_records");
    expect(view.rows).toHaveLength(3);
  });

  test("before the token is set: not configured, nothing pushed", async () => {
    const t = convexTest(schema, modules);
    const view = await (await signInAsOwner(t)).query(api.support.overview, {});
    expect(view).toEqual({
      configured: false,
      appId: null,
      status: { state: null, lastRunAt: null, lastOkAt: null, failure: null },
      rows: [],
    });
  });

  test("a teammate on Globex given Support reads it; on Startup alone, or without the area, is refused", async () => {
    const t = await seeded();
    const kz = await signInWithAreas(t, "sales", ["support"], ["kz"]);
    expect((await kz.query(api.support.overview, {})).rows).toHaveLength(3);
    const us = await signInWithAreas(t, "engineer", ["support", "board"], ["us"]);
    await expect(us.query(api.support.overview, {})).rejects.toThrow("not_allowed");
    const without = await signInWithAreas(t, "cofounder", ["customers", "sales"], ["kz"]);
    await expect(without.query(api.support.overview, {})).rejects.toThrow("not_allowed");
  });
});

describe("Startup OS never calls Intercom", () => {
  // The owner decided on 2026-10-17: the data comes from Claude's Intercom
  // connector on the Mac, pushed like the work tools. No Convex module holds
  // Intercom's API address or an Intercom credential's name.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "_generated" || name === "node_modules") return [];
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
    });

  test("no module under convex/ mentions api.intercom.io or an Intercom access token", () => {
    const self = join(__dirname, "support.test.ts");
    for (const file of files(__dirname)) {
      if (file === self) continue;
      const code = readFileSync(file, "utf8");
      expect([file, /intercom\.io/i.test(code), /INTERCOM_ACCESS_TOKEN|INTERCOM_REGION/.test(code)]).toEqual([
        file,
        false,
        false,
      ]);
    }
  });
});
