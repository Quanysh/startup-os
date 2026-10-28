import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import {
  DEPLOYMENTS_PATH,
  PAGEVIEWS_PATH,
  daysFrom,
  dep,
  page,
  stubVercel,
  type VercelCall,
} from "./vercel.fixtures";

// Obviously not a real token.
const TOKEN = "fake-vercel-token-for-tests-only";

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // A Wednesday.
  vi.setSystemTime(new Date("2026-10-14T06:20:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend with the token and ids set, as a configured deployment has. */
function configured(options: { analytics?: boolean } = {}) {
  vi.stubEnv("VERCEL_API_TOKEN", TOKEN);
  vi.stubEnv("VERCEL_TEAM_ID", "team_fake123");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_fake456");
  if (options.analytics) vi.stubEnv("VERCEL_WEB_ANALYTICS", "on");
  return convexTest(schema, modules);
}

const sync = (t: TestBackend, args: { months?: number } = {}) =>
  t.action(internal.connectors.vercel.sync, args);

const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "vercel"))
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
const to = (calls: VercelCall[], path: string) => calls.filter((c) => c.url.pathname === path);

const DEPLOY_ROWS = [
  "deploys startup_insights 2026-09-14 1 vercel",
  "deploys startup_insights 2026-09-21 0 vercel",
  "deploys startup_insights 2026-09-28 1 vercel",
  "deploys startup_insights 2026-10-05 2 vercel",
  "deploys_failed startup_insights 2026-09-14 0 vercel",
  "deploys_failed startup_insights 2026-09-21 0 vercel",
  "deploys_failed startup_insights 2026-09-28 0 vercel",
  "deploys_failed startup_insights 2026-10-05 1 vercel",
];

describe("vercel.sync", () => {
  test("without its token it records 'not configured' and calls nothing", async () => {
    const calls = stubVercel();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message:
        "Set VERCEL_API_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID on the Convex deployment.",
    });
  });

  test("writes production deploys and failures for each closed week", async () => {
    stubVercel();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await stored(t)).toEqual(DEPLOY_ROWS);
  });

  test("nothing of a deployment but its counts is stored or logged", async () => {
    stubVercel();
    const t = configured();
    await sync(t);
    const everything = JSON.stringify([await stored(t), await logged(t)]);
    expect(everything).not.toContain("commit message");
    expect(everything).not.toContain("example.vercel.app");
  });

  test("the token goes to Vercel's API, as a bearer header, and nowhere else", async () => {
    const calls = stubVercel();
    const t = configured({ analytics: true });
    await sync(t);
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://api.vercel.com");
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url.search).not.toContain(TOKEN);
      // A redirect is never followed, so the token can only go where it was sent.
      expect(call.redirect).toBe("manual");
    }
    expect(await logged(t)).not.toContain(TOKEN);
  });

  test("asks for the one project's production deployments, from sixty days before the first week", async () => {
    const calls = stubVercel();
    const t = configured();
    await sync(t);
    const [listing] = to(calls, DEPLOYMENTS_PATH);
    expect(Object.fromEntries(listing!.url.searchParams)).toEqual({
      teamId: "team_fake123",
      projectId: "prj_fake456",
      target: "production",
      limit: "100",
      // Sixty days before Monday, August 17.
      since: String(Date.UTC(2026, 5, 18)),
    });
  });

  describe("paging", () => {
    const second = Date.parse("2026-10-07T10:00:00Z");

    test("follows the marker to the next page, and counts an overlap once", async () => {
      const calls = stubVercel({
        [DEPLOYMENTS_PATH]: (url) =>
          url.searchParams.get("until") === null
            ? page(
                [dep("d-c", "2026-10-08T10:00:00Z"), dep("d-b", "2026-10-07T10:00:00Z", "ERROR")],
                second,
              )
            : page([
                dep("d-b", "2026-10-07T10:00:00Z", "ERROR"),
                dep("d-a", "2026-10-06T10:00:00Z"),
              ]),
      });
      const t = configured();
      expect(await sync(t)).toBe("ok");
      const listings = to(calls, DEPLOYMENTS_PATH);
      expect(listings).toHaveLength(2);
      expect(listings[1]!.url.searchParams.get("until")).toBe(String(second));
      expect(await stored(t)).toEqual([
        "deploys startup_insights 2026-10-05 2 vercel",
        "deploys_failed startup_insights 2026-10-05 1 vercel",
      ]);
    });

    test("a marker that does not move on fails the run instead of looping", async () => {
      const calls = stubVercel({
        [DEPLOYMENTS_PATH]: () => page([dep("d-a", "2026-10-06T10:00:00Z")], 5),
      });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Vercel's deployments paging did not move on.");
      expect(to(calls, DEPLOYMENTS_PATH)).toHaveLength(2);
      expect(await stored(t)).toEqual([]);
    });

    test("more pages than the cap fails the run rather than understating deploys", async () => {
      const calls = stubVercel({
        [DEPLOYMENTS_PATH]: (url) => {
          const until = Number(url.searchParams.get("until") ?? 1e12);
          return page([dep(`d-${until}`, "2026-10-06T10:00:00Z")], until - 1);
        },
      });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "The project has more than 5000 production deployments in the window.",
      );
      expect(to(calls, DEPLOYMENTS_PATH)).toHaveLength(50);
      expect(await stored(t)).toEqual([]);
    });
  });

  describe("Web Analytics", () => {
    test("is not asked for unless the owner switched it on", async () => {
      const calls = stubVercel();
      const t = configured();
      await sync(t);
      expect(to(calls, PAGEVIEWS_PATH)).toEqual([]);
      expect((await stored(t)).some((row) => row.startsWith("site_pageviews"))).toBe(false);
    });

    test("switched on, each closed week is asked for on its own, through the next Monday", async () => {
      const calls = stubVercel();
      const t = configured({ analytics: true });
      expect(await sync(t)).toBe("ok");
      const asked = to(calls, PAGEVIEWS_PATH);
      expect(asked).toHaveLength(8);
      expect(Object.fromEntries(asked[0]!.url.searchParams)).toEqual({
        teamId: "team_fake123",
        projectId: "prj_fake456",
        by: "day",
        since: "2026-08-17",
        // The Monday after: a Sunday `until` would lose that day if it is exclusive.
        until: "2026-08-24",
        limit: "100",
      });
      expect(asked.at(-1)!.url.searchParams.get("until")).toBe("2026-10-12");
      const rows = await stored(t);
      expect(rows).toHaveLength(16);
      expect(rows).toContain("site_pageviews startup_insights 2026-08-17 150 vercel");
      expect(rows).toContain("site_pageviews startup_insights 2026-10-05 150 vercel");
    });

    test("switched on and refused, the whole run fails: no half a read", async () => {
      stubVercel({ [PAGEVIEWS_PATH]: () => new Response("payment required", { status: 402 }) });
      const t = configured({ analytics: true });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("Vercel answered 402 for page views.");
      expect(await stored(t)).toEqual([]);
    });

    test("a week with no rows keeps the figure it had: it is not overwritten with a zero", async () => {
      stubVercel();
      const t = configured({ analytics: true });
      await sync(t);
      stubVercel({
        [PAGEVIEWS_PATH]: (url) =>
          url.searchParams.get("since") === "2026-10-05"
            ? { version: 1, query: {}, data: [] }
            : {
                version: 1,
                query: {},
                data: daysFrom(url.searchParams.get("since")!, [1, 1, 1, 1, 1, 1, 1]),
              },
      });
      expect(await sync(t)).toBe("ok");
      const rows = await stored(t);
      expect(rows).toContain("site_pageviews startup_insights 2026-10-05 150 vercel");
      expect(rows).toContain("site_pageviews startup_insights 2026-09-28 7 vercel");
    });

    test("a week that stops short of Sunday fails the run: a short week is not written", async () => {
      stubVercel();
      const t = configured({ analytics: true });
      await sync(t);
      const before = await stored(t);
      stubVercel({
        [PAGEVIEWS_PATH]: (url) => ({
          version: 1,
          query: {},
          // Monday to Saturday: what an exclusive `until` set to Sunday would send.
          data: daysFrom(url.searchParams.get("since")!, [9, 9, 9, 9, 9, 9]),
        }),
      });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vercel's page views response does not cover the whole week.",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("a day outside the week asked for fails the run", async () => {
      stubVercel({
        [PAGEVIEWS_PATH]: () => ({
          version: 1,
          query: {},
          data: [{ timestamp: "2026-01-01T00:00:00.000Z", pageviews: 9 }],
        }),
      });
      const t = configured({ analytics: true });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vercel's page views response has a day outside the week asked for.",
      );
      expect(await stored(t)).toEqual([]);
    });
  });

  describe("when something goes wrong, stored numbers stay and the log stays clean", () => {
    /** A good run first, so there is something to protect. */
    async function afterGoodRun() {
      stubVercel();
      const t = configured();
      await sync(t);
      return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
    }

    test("a failed request says which call failed, by status only", async () => {
      const { t, before, okAt } = await afterGoodRun();
      stubVercel({
        [DEPLOYMENTS_PATH]: () =>
          new Response('{"error":{"message":"team startup internal detail"}}', { status: 500 }),
      });
      expect(await sync(t)).toBe("error");
      expect(await stored(t)).toEqual(before);
      expect(await status(t)).toMatchObject({
        state: "error",
        message: "Vercel answered 500 for deployments.",
        lastOkAt: okAt,
      });
      expect(await logged(t)).not.toContain("internal detail");
    });

    test("a response in another shape fails the run instead of writing a guess", async () => {
      const { t, before } = await afterGoodRun();
      stubVercel({ [DEPLOYMENTS_PATH]: () => ({ items: [] }) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vercel's deployments response is not in the expected shape (deployments).",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("no deployment at all is an empty result, not eight weeks of zeros", async () => {
      const { t, before } = await afterGoodRun();
      stubVercel({ [DEPLOYMENTS_PATH]: () => page([]) });
      expect(await sync(t)).toBe("empty");
      expect(await stored(t)).toEqual(before);
    });

    test("an id that is not an id is refused before any request, and not echoed", async () => {
      const { t, before } = await afterGoodRun();
      const calls = stubVercel();
      vi.stubEnv("VERCEL_TEAM_ID", "team_x&projectId=someone-else");
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("VERCEL_TEAM_ID is not a Vercel id.");
      expect(calls).toEqual([]);
      expect(await stored(t)).toEqual(before);
    });
  });

  test("running twice writes nothing new", async () => {
    stubVercel();
    const t = configured();
    await sync(t);
    await sync(t);
    const [, second] = await runs(t);
    expect(second).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 8 });
  });
});
