import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { seal } from "../lib/tokenCrypto";
import schema from "../schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "../test.setup";
import { AT, message, sent, stubGmail, thread, type GmailCall } from "./gmail.fixtures";

// Nothing here is real: no client, no key, no token, no mailbox.
const NOW = Date.UTC(2026, 9, 12, 6);
const REFRESH = "fake-refresh-token-not-real-0001";
const SECRET = "fake-client-secret-not-real";
const KEY = btoa("0123456789abcdef0123456789abcdef");

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("GOOGLE_WORK_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GOOGLE_WORK_CLIENT_SECRET", SECRET);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend where Google is connected, with a sealed made-up grant. */
async function connected() {
  const t = convexTest(schema, modules);
  const sealed = await seal(REFRESH, "google-refresh-token");
  await t.run((ctx) =>
    ctx.db.insert("oauthConnections", {
      provider: "google",
      sealedRefreshToken: sealed,
      connectedAt: NOW - 1000,
    }),
  );
  return t;
}

const sync = (t: TestBackend) => t.action(internal.connectors.gmail.sync, {});
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "gmail"))
      .unique(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const storedIds = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("mirrorRecords").collect()).map((doc) => doc.externalId).sort(),
  );
const gmailCalls = (calls: GmailCall[]) =>
  calls.filter((c) => c.url.host === "gmail.googleapis.com");

/** Four listed threads, two of them waiting on the owner. */
const INBOX = {
  aa01: thread(message({ at: AT })),
  aa02: thread(message({ at: AT }), sent(AT + 1000)),
  aa03: thread(message({ from: "Made-up Service <noreply@service.test>" })),
  aa04: thread(
    message({ at: AT + 5000, from: "Bo Example <bo@clinic.test>", subject: "Another made-up subject" }),
  ),
};

/** Store two threads from a good read, then return what is stored. */
async function withStoredThreads(t: TestBackend) {
  stubGmail({ threads: INBOX });
  expect(await sync(t)).toBe("ok");
  const before = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
  expect(before).toHaveLength(2);
  return before;
}
const records = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());

describe("gmail.sync", () => {
  test("not connected: a setup step, and Gmail is never asked", async () => {
    const calls = stubGmail({ threads: INBOX });
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Connect Google under Settings → Work tools.",
    });
    expect(await runs(t)).toEqual([]);
    expect(await storedIds(t)).toEqual([]);
  });

  test("without its variables it says which to set, and asks nothing", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    const calls = stubGmail({ threads: INBOX });
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      message: "Set TOKEN_ENCRYPTION_KEY on the Convex deployment.",
    });
  });

  test("stores the threads waiting on the owner, from metadata only", async () => {
    const calls = stubGmail({ threads: INBOX });
    const t = await connected();
    expect(await sync(t)).toBe("ok");

    expect(await storedIds(t)).toEqual(["aa01", "aa04"]);
    const owner = await signInAsOwner(t);
    const { threads } = await owner.query(api.workTools.needsReply, {});
    expect(threads).toEqual([
      {
        kind: "mail",
        threadId: "aa01",
        fromName: "Ada Example",
        fromAddress: "ada@example-fund.test",
        subject: "Made-up subject",
        lastMessageAt: AT,
        group: "other",
      },
      {
        kind: "mail",
        threadId: "aa04",
        fromName: "Bo Example",
        fromAddress: "bo@clinic.test",
        subject: "Another made-up subject",
        lastMessageAt: AT + 5000,
        group: "other",
      },
    ]);
    expect(await runs(t)).toMatchObject([
      { source: "gmail", status: "ok", inserted: 2, updated: 0, unchanged: 0, startedAt: NOW },
    ]);

    // The token request first, to Google's token endpoint and nowhere else.
    expect(calls[0]?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBe(REFRESH);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);

    const asked = gmailCalls(calls);
    expect(asked).toHaveLength(5);
    const [list, ...gets] = asked;
    expect(list?.url.pathname).toBe("/gmail/v1/users/me/threads");
    expect(list?.url.searchParams.get("labelIds")).toBe("INBOX");
    expect(list?.url.searchParams.get("maxResults")).toBe("50");
    expect(list?.url.searchParams.get("fields")).toBe("threads/id");
    for (const call of asked) {
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe("Bearer fake-access-token");
      expect(call.url.searchParams.has("fields")).toBe(true);
      // Never a body, a search or a snippet.
      expect(call.url.href).not.toContain("format=full");
      expect(call.url.href).not.toContain("format=raw");
      expect(call.url.searchParams.has("q")).toBe(false);
      expect(call.url.href).not.toContain("snippet");
    }
    for (const call of gets) {
      expect(call.url.searchParams.get("format")).toBe("metadata");
      expect(call.url.searchParams.get("fields")).toBe(
        "messages(labelIds,internalDate,payload/headers)",
      );
      expect(call.url.searchParams.getAll("metadataHeaders")).toEqual([
        "From",
        "Subject",
        "List-Unsubscribe",
        "List-Id",
        "Precedence",
        "Auto-Submitted",
      ]);
    }
    // The refresh token and the client secret go to the token endpoint only.
    for (const call of asked) {
      expect(call.url.href + call.body + call.authorization).not.toContain(REFRESH);
      expect(call.url.href + call.body + call.authorization).not.toContain(SECRET);
    }
  });

  test("a thread that was answered is gone at the next read", async () => {
    const t = await connected();
    await withStoredThreads(t);
    stubGmail({ threads: { ...INBOX, aa04: thread(...INBOX.aa04.messages, sent(AT + 9000)) } });
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual(["aa01"]);
  });

  test("an empty inbox is a real answer: the run is ok and stored threads are removed", async () => {
    const t = await connected();
    await withStoredThreads(t);
    stubGmail({ threads: {} });
    expect(await sync(t)).toBe("ok");
    expect(await storedIds(t)).toEqual([]);
    expect(await status(t)).toMatchObject({ state: "ok", lastOkAt: NOW });
  });

  test("the list failing twice is an error, and stored threads are untouched", async () => {
    const t = await connected();
    const before = await withStoredThreads(t);
    const calls = stubGmail({ list: { status: 500, body: { error: { message: "REMOTE-TEXT" } } } });
    expect(await sync(t)).toBe("error");
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Gmail answered 500 for the inbox.",
    });
    expect(await records(t)).toEqual(before);
    // One retry, not more.
    expect(gmailCalls(calls)).toHaveLength(2);
  });

  test("one thread of several failing fails the read: a partial inbox is never applied", async () => {
    const t = await connected();
    const before = await withStoredThreads(t);
    stubGmail({
      threads: {
        aa01: INBOX.aa01,
        aa05: thread(message({ from: "Cy Example <cy@elsewhere.test>" })),
        aa06: { status: 404, body: {} },
      },
    });
    expect(await sync(t)).toBe("error");
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Gmail answered 404 for a thread.",
    });
    expect(await records(t)).toEqual(before);
  });

  test("a thread that is not in the expected shape fails the read", async () => {
    const t = await connected();
    const before = await withStoredThreads(t);
    stubGmail({ threads: { aa01: INBOX.aa01, aa07: { body: { messages: [] } } } });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("A Gmail thread was not in the expected shape.");
    expect(await records(t)).toEqual(before);
  });

  // The owner removed access in their Google Account, or the grant expired.
  // What was read with it goes too, as "Disconnect" would have it.
  test("a grant that has died at Google takes its data with it", async () => {
    const t = await connected();
    await withStoredThreads(t);
    await t.run((ctx) =>
      ctx.db.insert("mirrorRecords", {
        source: "google_calendar",
        externalId: "e1",
        sortAt: NOW,
        syncedAt: NOW,
        record: {
          kind: "event",
          eventId: "e1",
          title: "Made-up meeting",
          startsAt: NOW,
          endsAt: NOW + 1,
          allDay: false,
          attendees: [],
          attendeeCount: 0,
          hasMeetingLink: false,
        },
      }),
    );
    const calls = stubGmail({
      token: { status: 400, body: { error: "invalid_grant", error_description: "REMOTE-TEXT" } },
      threads: INBOX,
    });
    expect(await sync(t)).toBe("not_configured");
    expect(gmailCalls(calls)).toEqual([]);
    // Nothing is asked of Google's revoke endpoint: there is nothing left to revoke.
    expect(calls.filter((c) => c.url.pathname.includes("revoke"))).toEqual([]);

    expect(await t.run((ctx) => ctx.db.query("oauthConnections").collect())).toEqual([]);
    expect(await records(t)).toEqual([]);
    const REMOVED = "Google access was removed. Connect Google again.";
    const statuses = await t.run((ctx) => ctx.db.query("sourceStatus").collect());
    expect(Object.fromEntries(statuses.map((row) => [row.source, row]))).toMatchObject({
      gmail: { state: "not_configured", message: REMOVED },
      google_calendar: { state: "not_configured", message: REMOVED },
    });
    // No "read an hour ago" over a list that is gone.
    expect(statuses.every((row) => row.lastOkAt === undefined)).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("REMOTE-TEXT");

    const owner = await signInAsOwner(t);
    expect(await owner.query(api.google.connection, {})).toMatchObject({
      connected: false,
      connectedAt: null,
    });
    expect((await owner.query(api.workTools.needsReply, {})).threads).toEqual([]);

    // The next scheduled reads find no grant, and leave the reason standing.
    stubGmail({ threads: INBOX });
    expect(await sync(t)).toBe("not_configured");
    expect(await t.action(internal.connectors.googleCalendar.sync, {})).toBe("not_configured");
    expect((await status(t))?.message).toBe(REMOVED);
    expect(await records(t)).toEqual([]);
  });

  test("any other refusal of the token leaves the grant and its data alone", async () => {
    const t = await connected();
    const before = await withStoredThreads(t);
    for (const token of [
      { status: 400, body: { error: "invalid_client" } },
      { status: 401, body: { error: "invalid_grant" } },
      { status: 500, body: {} },
    ]) {
      stubGmail({ token, threads: INBOX });
      expect(await sync(t)).toBe("error");
    }
    expect(await t.run((ctx) => ctx.db.query("oauthConnections").collect())).toHaveLength(1);
    expect(await records(t)).toEqual(before);
  });

  test("a grant replaced while the dead one was being refused is not deleted", async () => {
    const t = await connected();
    await withStoredThreads(t);
    const fresh = await seal("fake-refresh-token-not-real-0002", "google-refresh-token");
    // The owner reconnects between the read of the stored grant and Google's refusal of it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await t.run(async (ctx) => {
          for (const row of await ctx.db.query("oauthConnections").collect()) {
            await ctx.db.delete(row._id);
          }
          await ctx.db.insert("oauthConnections", {
            provider: "google",
            sealedRefreshToken: fresh,
            connectedAt: NOW,
          });
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }),
    );
    await sync(t);
    expect(await t.run((ctx) => ctx.db.query("oauthConnections").collect())).toMatchObject([
      { sealedRefreshToken: fresh },
    ]);
    expect(await records(t)).toHaveLength(2);
  });

  test("a read begun under one grant cannot land after a disconnect and a reconnect", async () => {
    const t = await connected();
    const fresh = await seal("fake-refresh-token-not-real-0002", "google-refresh-token");
    // The read is under way (its token is in hand) when the owner disconnects
    // and connects again, perhaps as a different mailbox.
    const base = stubGmail({ threads: INBOX });
    void base;
    const real = globalThis.fetch;
    let swapped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (!swapped && String(input).includes("gmail.googleapis.com")) {
          swapped = true;
          await t.run(async (ctx) => {
            for (const row of await ctx.db.query("oauthConnections").collect()) {
              await ctx.db.delete(row._id);
            }
            await ctx.db.insert("oauthConnections", {
              provider: "google",
              sealedRefreshToken: fresh,
              connectedAt: NOW + 5,
            });
          });
        }
        return real(input as RequestInfo, init);
      }),
    );
    expect(await sync(t)).toBe("not_configured");
    expect(await records(t)).toEqual([]);
    expect(await runs(t)).toEqual([]);
    // The next read, begun under the new grant, is written.
    stubGmail({ threads: INBOX });
    expect(await sync(t)).toBe("ok");
    expect(await records(t)).toHaveLength(2);
  });

  test("a stored grant the key cannot open says so, without quoting either", async () => {
    const t = await connected();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa("fedcba9876543210fedcba9876543210"));
    const calls = stubGmail({ threads: INBOX });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe(
      "The stored Google grant could not be read. Connect Google again.",
    );
    expect(calls).toEqual([]);
  });

  test("switched off: nothing is fetched at all, not even the token", async () => {
    const t = await connected();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "gmail" });
    const calls = stubGmail({ threads: INBOX });
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await storedIds(t)).toEqual([]);
  });

  test("nothing personal is logged: runs, status and the console hold counts and our own words", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(JSON.stringify(args)));
    }
    const t = await connected();
    await withStoredThreads(t);
    stubGmail({ threads: { ...INBOX, aa09: { status: 403, body: { error: "REMOTE-TEXT" } } } });
    expect(await sync(t)).toBe("error");

    const logged = JSON.stringify([await runs(t), await status(t)]) + lines.join("\n");
    for (const personal of [
      "Ada",
      "Bo Example",
      "example-fund.test",
      "clinic.test",
      "Made-up subject",
      "Another made-up",
      "aa01",
      "REMOTE-TEXT",
      REFRESH,
      "fake-access-token",
      SECRET,
      KEY,
    ]) {
      expect(logged).not.toContain(personal);
    }
    expect((await runs(t)).map((run) => [run.status, run.message ?? null, run.inserted])).toEqual([
      ["ok", null, 2],
      ["error", "Gmail answered 403 for a thread.", 0],
    ]);
    vi.restoreAllMocks();
  });
});
