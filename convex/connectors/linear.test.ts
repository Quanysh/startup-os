import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "../test.setup";
import { issuePage, node, stubLinear } from "./linear.fixtures";
import { BOARD_QUERY } from "./linear";

// Obviously not a real key.
const KEY = "fake-linear-key";
const NOW = Date.UTC(2026, 9, 12, 6);

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
  vi.stubEnv("LINEAR_API_KEY", KEY);
  return convexTest(schema, modules);
}

const sync = (t: TestBackend) => t.action(internal.connectors.linear.sync, {});
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "linear"))
      .unique(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const records = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const storedIds = async (t: TestBackend) => (await records(t)).map((doc) => doc.externalId).sort();

const A = node({ id: "issue-a", identifier: "ENG-1" });
const B = node({ id: "issue-b", identifier: "ENG-2", title: "Another made-up title" });

async function withStoredIssues(t: TestBackend) {
  stubLinear([issuePage([A, B])]);
  expect(await sync(t)).toBe("ok");
  const before = await records(t);
  expect(before).toHaveLength(2);
  return before;
}

describe("the one thing sent to Linear", () => {
  test("is a query, never a mutation, and asks for no description or comment", () => {
    expect(BOARD_QUERY.trimStart().startsWith("query ")).toBe(true);
    expect(BOARD_QUERY).not.toMatch(/mutation/i);
    for (const never of ["description", "comments", "attachments", "email"]) {
      expect(BOARD_QUERY).not.toContain(never);
    }
  });
});

describe("linear.sync", () => {
  test("without a key it says which variable to set, and fetches nothing", async () => {
    const calls = stubLinear([issuePage([A])]);
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set LINEAR_API_KEY on the Convex deployment.",
    });
    expect(await runs(t)).toEqual([]);
  });

  test("stores every page's issues; each request is the read-only query, posted with the bare key", async () => {
    const calls = stubLinear([
      issuePage([A, node({ id: "issue-x", state: { name: "Triage", type: "triage" } })], "c2"),
      issuePage([B, A]),
    ]);
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["issue-a", "issue-b"]);
    expect(await runs(t)).toMatchObject([
      { source: "linear", status: "ok", inserted: 2, updated: 0, unchanged: 0, startedAt: NOW },
    ]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api.linear.app/graphql");
      expect(call.method).toBe("POST");
      expect(call.redirect).toBe("manual");
      // Exactly the key: Linear's personal keys take no "Bearer".
      expect(call.authorization).toBe(KEY);
      expect(call.contentType).toBe("application/json");
      expect(call.query).toBe(BOARD_QUERY);
      expect(call.query).not.toMatch(/mutation/i);
    }
    expect(calls.map((c) => c.variables)).toEqual([{ after: null }, { after: "c2" }]);

    const owner = await signInAsOwner(t);
    const { issues } = await owner.query(api.workTools.issues, {});
    expect(issues.map((i) => [i.identifier, i.title, i.mine])).toEqual(
      expect.arrayContaining([
        ["ENG-1", "Made-up title", true],
        ["ENG-2", "Another made-up title", true],
      ]),
    );
  });

  test("an issue that left the board is removed at the next read", async () => {
    const t = configured();
    await withStoredIssues(t);
    stubLinear([issuePage([A])]);
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["issue-a"]);
  });

  test("the same issues read again are unchanged", async () => {
    const t = configured();
    await withStoredIssues(t);
    stubLinear([issuePage([A, B])]);
    expect(await sync(t)).toBe("ok");
    expect((await runs(t)).at(-1)).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
  });

  test("an empty answer is recorded as empty, and stored issues are untouched", async () => {
    const t = configured();
    const before = await withStoredIssues(t);
    stubLinear([issuePage([])]);
    expect(await sync(t)).toBe("empty");
    expect(await status(t)).toMatchObject({
      state: "empty",
      message: "The source returned nothing.",
    });
    expect(await records(t)).toEqual(before);
  });

  test("a 401 is reported by its status, and stored issues are untouched", async () => {
    const t = configured();
    const before = await withStoredIssues(t);
    const calls = stubLinear([{ status: 401, body: { errors: [{ message: "REMOTE-TEXT" }] } }]);
    expect(await sync(t)).toBe("error");
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Linear answered 401 for issues.",
    });
    expect(calls).toHaveLength(1);
    expect(await records(t)).toEqual(before);
  });

  test("an errors array with a 200 fails the read in our words", async () => {
    const t = configured();
    const before = await withStoredIssues(t);
    stubLinear([{ errors: [{ message: "REMOTE-TEXT", extensions: { code: "RATELIMITED" } }] }]);
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Linear reported an error for issues.");
    expect(await records(t)).toEqual(before);
  });

  test("the second page failing leaves stored issues untouched: half a board is never applied", async () => {
    const t = configured();
    const before = await withStoredIssues(t);
    stubLinear([issuePage([node({ id: "issue-new" })], "c2"), { status: 400, body: {} }]);
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Linear answered 400 for issues.");
    expect(await records(t)).toEqual(before);
  });

  test("an eleventh page is an error, not a truncated board", async () => {
    const t = configured();
    const before = await withStoredIssues(t);
    const calls = stubLinear(
      Array.from({ length: 11 }, (_, n) => issuePage([node({ id: `issue-${n}` })], `c${n + 2}`)),
    );
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Linear has more than 1,000 issues to show.");
    expect(calls).toHaveLength(10);
    expect(await records(t)).toEqual(before);
  });

  test("switched off: nothing is fetched", async () => {
    const t = configured();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "linear" });
    const calls = stubLinear([issuePage([A])]);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
  });

  test("the log holds no title, name or key", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(JSON.stringify(args)));
    }
    const t = configured();
    await withStoredIssues(t);
    stubLinear([issuePage([node({ id: "issue-c", title: "REMOTE-TITLE", updatedAt: "REMOTE-TIME" })])]);
    expect(await sync(t)).toBe("error");
    stubLinear([{ status: 500, body: { message: "REMOTE-TEXT" } }]);
    expect(await sync(t)).toBe("error");

    const logged = JSON.stringify([await runs(t), await status(t)]) + lines.join("\n");
    for (const personal of [
      "Made-up title",
      "Another made-up",
      "Ada Example",
      "Engineering",
      "ENG-1",
      "issue-a",
      "REMOTE-",
      KEY,
    ]) {
      expect(logged).not.toContain(personal);
    }
    expect((await runs(t)).map((run) => run.message ?? null)).toEqual([
      null,
      "Linear's issues were not in the expected shape.",
      "Linear answered 500 for issues.",
    ]);
  });
});
