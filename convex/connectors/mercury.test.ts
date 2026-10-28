import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import {
  ACCOUNTS,
  CHECKING_TRANSACTIONS,
  stubMercury,
  toSubsidiary,
  tx,
  type MercuryCall,
} from "./mercury.fixtures";

// Obviously not a real token.
const TOKEN = "fake-mercury-token-for-tests-only";
const CHECKING = "/api/v1/account/acc-checking/transactions";
const SAVINGS = "/api/v1/account/acc-savings/transactions";

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T06:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend with the token set, as a configured deployment has. */
function configured() {
  vi.stubEnv("MERCURY_API_TOKEN", TOKEN);
  return convexTest(schema, modules);
}

const sync = (t: TestBackend, args: { months?: number } = {}) =>
  t.action(internal.connectors.mercury.sync, args);

const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "mercury"))
      .unique(),
  );

const stored = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.scope} ${r.periodStart} ${r.value} ${r.currency} ${r.source}`)
      .sort(),
  );

const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const logged = async (t: TestBackend) => JSON.stringify([await runs(t), await status(t)]);

describe("mercury.sync", () => {
  test("without a token it records 'not configured' and calls nothing", async () => {
    const calls = stubMercury();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set MERCURY_API_TOKEN on the Convex deployment.",
    });
    expect(await stored(t)).toEqual([]);
  });

  test("writes today's cash and three months of flows", async () => {
    stubMercury();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await stored(t)).toEqual([
      "cash us 2026-10-12 400000.75 USD mercury",
      "cash_in us 2026-08-01 100000 USD mercury",
      "cash_in us 2026-09-01 0 USD mercury",
      "cash_in us 2026-10-01 12012.44 USD mercury",
      "cash_out us 2026-08-01 0 USD mercury",
      "cash_out us 2026-09-01 2500.5 USD mercury",
      "cash_out us 2026-10-01 4000.05 USD mercury",
      "cash_to_subsidiary us 2026-08-01 0 USD mercury",
      "cash_to_subsidiary us 2026-09-01 0 USD mercury",
      "cash_to_subsidiary us 2026-10-01 0 USD mercury",
    ]);
    expect(await status(t)).toMatchObject({ state: "ok" });
  });

  test("what was sent to the subsidiary is written on its own, inside money out, and its name is kept nowhere", async () => {
    stubMercury({
      [CHECKING]: () => ({
        total: 9,
        transactions: [...CHECKING_TRANSACTIONS.transactions, toSubsidiary("r1", 64_000, "2026-09-15T12:00:00Z")],
      }),
    });
    const t = configured();
    expect(await sync(t)).toBe("ok");
    const rows = await stored(t);
    expect(rows).toContain("cash_to_subsidiary us 2026-09-01 64000 USD mercury");
    expect(rows).toContain("cash_out us 2026-09-01 66500.5 USD mercury");
    // Only the monthly sum is stored: the name it was matched on is in no row and no log.
    const everything = JSON.stringify(
      await t.run(async (ctx) => [
        await ctx.db.query("metricSnapshots").collect(),
        await ctx.db.query("syncRuns").collect(),
        await ctx.db.query("sourceStatus").collect(),
      ]),
    );
    expect(everything).not.toMatch(/northwind/i);
    expect(everything).not.toContain("Example Co");
  });

  test("the token goes to Mercury, as a bearer header, and nowhere else", async () => {
    const calls = stubMercury();
    const t = configured();
    await sync(t);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://api.mercury.com");
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url.search).not.toContain(TOKEN);
      // A redirect is never followed, so the token can only go where it was sent.
      expect(call.redirect).toBe("manual");
    }
    expect(await logged(t)).not.toContain(TOKEN);
  });

  test("asks for sixty days before the first month, oldest first", async () => {
    // `start` may filter on creation, and a payment can post weeks after it
    // was created; the margin keeps a closed month from changing later.
    const calls = stubMercury();
    const t = configured();
    await sync(t);
    const listing = calls.find((c) => c.url.pathname === CHECKING);
    expect(listing?.url.searchParams.get("start")).toBe("2026-06-02");
    expect(listing?.url.searchParams.get("order")).toBe("asc");
  });

  describe("a request that goes wrong on the way", () => {
    /** The calls a route received, by the order they came in. */
    const to = (calls: MercuryCall[], path: string) => calls.filter((c) => c.url.pathname === path);
    const ACCOUNTS_PATH = "/api/v1/accounts";

    test("one that never answers becomes a recorded failure, and is cancelled", async () => {
      stubMercury();
      const t = configured();
      await sync(t);
      const before = await stored(t);

      const calls = stubMercury({ [ACCOUNTS_PATH]: () => new Promise(() => {}) });
      // Timers faked as well, for this test only: the deadline is a timer.
      // (Not the others: the run also waits on real I/O.)
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-10-12T06:00:00Z"));
      const run = sync(t);
      // The deadline is armed only once the run has sent its request, which
      // takes some real time (loading modules). Wait for the request, then
      // move the faked clock past the deadline; the retry does the same.
      for (const sent of [1, 2]) {
        await vi.waitFor(() => expect(to(calls, ACCOUNTS_PATH)).toHaveLength(sent));
        await vi.advanceTimersByTimeAsync(20_000);
      }
      expect(await run).toBe("error");

      expect(await status(t)).toMatchObject({
        state: "error",
        message: "Mercury did not answer in time for accounts.",
      });
      expect(await stored(t)).toEqual(before);
      // Tried twice (a silence is retried once), and both were told to stop.
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(2);
      expect(to(calls, ACCOUNTS_PATH).every((c) => c.signal?.aborted)).toBe(true);
    });

    test("a redirect is not followed: it is an answer like any other", async () => {
      stubMercury();
      const t = configured();
      const calls = stubMercury({
        [ACCOUNTS_PATH]: () =>
          new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
      });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury answered 307 for accounts.");
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(1);
    });

    test("a 500 that clears on the second try is not a failure", async () => {
      let answered = 0;
      const calls = stubMercury({
        [ACCOUNTS_PATH]: () =>
          ++answered === 1 ? new Response("down", { status: 500 }) : ACCOUNTS,
      });
      const t = configured();
      expect(await sync(t)).toBe("ok");
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(2);
    });

    test("a 429 and a dropped connection are tried again too", async () => {
      let answered = 0;
      const calls = stubMercury({
        [ACCOUNTS_PATH]: () => {
          answered += 1;
          if (answered === 1) return new Response("slow down", { status: 429 });
          return ACCOUNTS;
        },
        [CHECKING]: (() => {
          let n = 0;
          return () => {
            if (++n === 1) throw new TypeError("socket closed");
            return CHECKING_TRANSACTIONS;
          };
        })(),
      });
      const t = configured();
      expect(await sync(t)).toBe("ok");
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(2);
      expect(to(calls, CHECKING)).toHaveLength(2);
    });

    test("a 401 is not tried again", async () => {
      const calls = stubMercury({
        [ACCOUNTS_PATH]: () => new Response("no", { status: 401 }),
      });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury answered 401 for accounts.");
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(1);
    });

    test("two 500s in a row are reported once, in the same words, after exactly two calls", async () => {
      const calls = stubMercury({
        [ACCOUNTS_PATH]: () => new Response("down", { status: 500 }),
      });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury answered 500 for accounts.");
      expect(to(calls, ACCOUNTS_PATH)).toHaveLength(2);
    });
  });

  describe("when something goes wrong, stored numbers stay and the log stays clean", () => {
    /** A good run first, so there is something to protect. */
    async function afterGoodRun() {
      stubMercury();
      const t = configured();
      await sync(t);
      return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
    }

    test("a failed request says which call failed, by status only", async () => {
      const { t, before, okAt } = await afterGoodRun();
      stubMercury({
        "/api/v1/accounts": () => new Response('{"detail":"internal account dump"}', { status: 500 }),
      });
      expect(await sync(t)).toBe("error");
      expect(await stored(t)).toEqual(before);
      expect(await status(t)).toMatchObject({
        state: "error",
        message: "Mercury answered 500 for accounts.",
        lastOkAt: okAt,
      });
      expect(await logged(t)).not.toContain("internal account dump");
    });

    test("a body that is not JSON is not quoted", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({ "/api/v1/accounts": () => new Response("Initech Holdings LLC statement") });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury's accounts response was not JSON.");
      expect(await logged(t)).not.toContain("Initech");
      expect(await stored(t)).toEqual(before);
    });

    test("a network failure that names the URL or the header is not quoted", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({
        [CHECKING]: () => {
          throw new TypeError(`fetch failed: ${CHECKING} with "Bearer ${TOKEN}"`);
        },
      });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury could not be reached for transactions.");
      const log = await logged(t);
      expect(log).not.toContain(TOKEN);
      expect(log).not.toContain("acc-checking");
      expect(await stored(t)).toEqual(before);
    });

    test("a response in another shape fails the run instead of writing a guess", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({ "/api/v1/accounts": () => ({ data: ACCOUNTS.accounts }) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Mercury's accounts response is not in the expected shape (accounts).",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("no open account is an empty result, not zero cash", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({ "/api/v1/accounts": () => ({ accounts: [], page: {} }) });
      expect(await sync(t)).toBe("empty");
      expect(await stored(t)).toEqual(before);
    });

    test("no transactions at all is an empty result, not three months of zeros", async () => {
      // An answer like this once would otherwise overwrite closed months.
      const { t, before } = await afterGoodRun();
      const nothing = () => ({ total: 0, transactions: [] });
      stubMercury({ [CHECKING]: nothing, [SAVINGS]: nothing });
      expect(await sync(t)).toBe("empty");
      expect(await stored(t)).toEqual(before);
    });

    test("a row the registry refuses is logged in its words", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({
        "/api/v1/accounts": () => ({
          accounts: [{ ...ACCOUNTS.accounts[0], currentBalance: -900_000 }],
          page: {},
        }),
      });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Cash cannot be below 0.");
      expect(await stored(t)).toEqual(before);
    });

    test("a Treasury call that fails fails the run, rather than dropping Treasury from cash", async () => {
      const { t, before } = await afterGoodRun();
      stubMercury({ "/api/v1/treasury": () => new Response("not found", { status: 404 }) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Mercury answered 404 for treasury.");
      expect(await stored(t)).toEqual(before);
    });
  });

  test("only archived accounts are not an open account: nothing is written, however much Treasury holds", async () => {
    // Cash is what is spendable in open accounts. A company with none has not
    // been read correctly, and Treasury alone would be a wrong total.
    stubMercury({
      "/api/v1/accounts": () => ({ accounts: [ACCOUNTS.accounts[2]], page: {} }),
      "/api/v1/account/acc-closed/transactions": () => ({
        total: 1,
        transactions: [tx("c1", -750, "outgoingPayment", "2026-09-20T12:00:00Z")],
      }),
    });
    const t = configured();
    expect(await sync(t)).toBe("empty");
    expect(await stored(t)).toEqual([]);
  });

  test("a closed account's past payments still count, and its balance does not", async () => {
    stubMercury({
      "/api/v1/account/acc-closed/transactions": () => ({
        total: 1,
        transactions: [tx("c1", -750, "outgoingPayment", "2026-09-20T12:00:00Z")],
      }),
    });
    const t = configured();
    await sync(t);
    const rows = await stored(t);
    expect(rows).toContain("cash_out us 2026-09-01 3250.5 USD mercury");
    expect(rows).toContain("cash us 2026-10-12 400000.75 USD mercury");
  });

  test("running twice writes nothing new", async () => {
    stubMercury();
    const t = configured();
    await sync(t);
    await sync(t);
    const [, second] = await runs(t);
    expect(second).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 10 });
  });

  describe("paging", () => {
    const dollar = { ...CHECKING_TRANSACTIONS.transactions[0]!, amount: 1 };
    /** A fake listing of `count` one-dollar receipts, at most `cap` per page. */
    const listing = (count: number, cap: number) => (url: URL) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const size = Math.min(cap, Math.max(count - offset, 0));
      return {
        total: count,
        transactions: Array.from({ length: size }, (_, i) => ({ ...dollar, id: `p${offset + i}` })),
      };
    };

    test("reads every page of a long list", async () => {
      stubMercury({ [CHECKING]: listing(501, 500) });
      const t = configured();
      await sync(t);
      // 501 one-dollar receipts, plus 12.34 from the savings account.
      expect(await stored(t)).toContain("cash_in us 2026-10-01 513.34 USD mercury");
    });

    test("a page shorter than asked for does not make it skip rows", async () => {
      stubMercury({ [CHECKING]: listing(700, 300) });
      const t = configured();
      await sync(t);
      expect(await stored(t)).toContain("cash_in us 2026-10-01 712.34 USD mercury");
    });
  });

  describe("the transaction cap", () => {
    const dollar = { ...CHECKING_TRANSACTIONS.transactions[0]!, amount: 1 };
    const many = (count: number) => (url: URL) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const size = Math.min(500, Math.max(count - offset, 0));
      return {
        total: count,
        transactions: Array.from({ length: size }, (_, i) => ({ ...dollar, id: `m${offset + i}` })),
      };
    };

    test("an account with more than 20,000 in the window fails the run rather than understating spending", async () => {
      stubMercury({ [CHECKING]: many(20_001) });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "An account has more than 20000 transactions in the window.",
      );
      expect(await stored(t)).toEqual([]);
    });

    test("exactly 20,000 is read in full", async () => {
      stubMercury({ [CHECKING]: many(20_000) });
      const t = configured();
      expect(await sync(t)).toBe("ok");
      expect(await stored(t)).toContain("cash_in us 2026-10-01 20012.34 USD mercury");
    });
  });

  describe("the month that just closed is always read again", () => {
    // The finance page calls a US month complete once a run has succeeded
    // after it ended. That is true only because such a run re-reads it.
    test("a run on the 1st stores last month's flows", async () => {
      vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
      stubMercury();
      const t = configured();
      expect(await sync(t)).toBe("ok");
      expect(await stored(t)).toContain("cash_out us 2026-10-01 4000.05 USD mercury");
    });

    test("even when asked for the month in progress alone", async () => {
      vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
      stubMercury();
      const t = configured();
      expect(await sync(t, { months: 1 })).toBe("ok");
      const rows = await stored(t);
      expect(rows).toContain("cash_out us 2026-10-01 4000.05 USD mercury");
      expect(rows.filter((r) => r.startsWith("cash_out "))).toHaveLength(2);
    });
  });

  describe("backfill", () => {
    test("covers thirteen months when Mercury has that much history", async () => {
      const calls = stubMercury({
        [CHECKING]: () => ({
          total: 9,
          transactions: [
            ...CHECKING_TRANSACTIONS.transactions,
            tx("old", -500, "outgoingPayment", "2025-10-15T12:00:00Z"),
          ],
        }),
      });
      const t = configured();
      await sync(t, { months: 13 });
      const rows = await stored(t);
      expect(rows.filter((r) => r.startsWith("cash_out "))).toHaveLength(13);
      expect(rows).toContain("cash_out us 2025-10-01 500 USD mercury");
      // A quiet month inside the history is a real zero.
      expect(rows).toContain("cash_out us 2025-11-01 0 USD mercury");
      const listing = calls.find((c) => c.url.pathname === CHECKING);
      expect(listing?.url.searchParams.get("start")).toBe("2025-08-02");
    });

    test("does not invent months from before the first transaction", async () => {
      stubMercury();
      const t = configured();
      await sync(t, { months: 13 });
      expect((await stored(t)).filter((r) => r.startsWith("cash_out "))).toHaveLength(3);
    });
  });
});
