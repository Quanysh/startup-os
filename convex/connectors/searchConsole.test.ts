import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import {
  ACCESS_TOKEN,
  QUERY_ROUTE,
  SITE,
  TOKEN_ROUTE,
  fakeServiceAccount,
  stubGoogle,
  week,
} from "./searchConsole.fixtures";

let account: Awaited<ReturnType<typeof fakeServiceAccount>>;

beforeEach(async () => {
  account = await fakeServiceAccount();
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend with the three variables set, as a configured deployment has. */
function configured() {
  vi.stubEnv("GSC_CLIENT_EMAIL", account.email);
  vi.stubEnv("GSC_PRIVATE_KEY", account.pem);
  vi.stubEnv("GSC_SITE_URL", SITE);
  return convexTest(schema, modules);
}
const sync = (t: TestBackend, args: { months?: number } = {}) =>
  t.action(internal.connectors.searchConsole.sync, args);
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "search_console"))
      .unique(),
  );
const stored = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.scope} ${r.periodStart} ${r.value} ${r.source}`)
      .sort(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const logged = async (t: TestBackend) => JSON.stringify([await runs(t), await status(t)]);
/** A good run first, so there is something to protect. */
async function afterGoodRun() {
  stubGoogle();
  const t = configured();
  expect(await sync(t)).toBe("ok");
  return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
}

describe("searchConsole.sync", () => {
  test("without its variables it records 'not configured', naming them, and calls nothing", async () => {
    const calls = stubGoogle();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY, GSC_SITE_URL on the Convex deployment.",
    });
  });

  test("writes the weeks Google has finished, and not the one it has not", async () => {
    stubGoogle();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    const rows = await stored(t);
    expect(rows).toHaveLength(12);
    expect(rows).toContain("search_clicks company 2026-09-28 105 search_console");
    expect(rows).toContain("search_position company 2026-09-14 11.5 search_console");
    expect(rows.some((row) => row.includes("2026-10-05"))).toBe(false);
  });

  test("nothing secret, and nothing that names the property, reaches the log", async () => {
    const { t } = await afterGoodRun();
    stubGoogle({
      [QUERY_ROUTE]: () => {
        throw new TypeError(`fetch failed: ${QUERY_ROUTE} with "Bearer ${ACCESS_TOKEN}"`);
      },
    });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Search Console could not be reached for daily totals.");
    const log = await logged(t);
    for (const secret of [ACCESS_TOKEN, "startup.test", account.email, account.pem.split("\n")[1]!]) {
      expect(log).not.toContain(secret);
    }
  });

  test("a failed sign-in leaves stored numbers and the last good time exactly as they were", async () => {
    const { t, before, okAt } = await afterGoodRun();
    stubGoogle({ [TOKEN_ROUTE]: () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
    expect(await sync(t)).toBe("error");
    expect(await stored(t)).toEqual(before);
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Google answered 400 for sign-in.",
      lastOkAt: okAt,
    });
  });

  test("an answer with no days is an empty run, not weeks of zeros", async () => {
    const { t, before } = await afterGoodRun();
    stubGoogle({ [QUERY_ROUTE]: () => ({ responseAggregationType: "byProperty" }) });
    expect(await sync(t)).toBe("empty");
    expect(await stored(t)).toEqual(before);
  });

  test("a later, shorter answer cannot turn a stored week into a part-week", async () => {
    const { t, before } = await afterGoodRun();
    // Only three days of the newest stored week come back, and nothing after them.
    stubGoogle({ [QUERY_ROUTE]: () => ({ rows: week("2026-09-28", 15, 300, 10, 3) }) });
    expect(await sync(t)).toBe("empty");
    expect(await stored(t)).toEqual(before);
  });

  test("a row the registry refuses is logged in its words, and nothing is written", async () => {
    const { t, before } = await afterGoodRun();
    stubGoogle({ [QUERY_ROUTE]: () => ({ rows: week("2026-09-28", 15, 300, 0.4) }) });
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe("Average search position cannot be below 1.");
    expect(await stored(t)).toEqual(before);
  });

  test("running twice writes nothing new", async () => {
    stubGoogle();
    const t = configured();
    await sync(t);
    await sync(t);
    const [, second] = await runs(t);
    expect(second).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 12 });
  });
});
