import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { msOfDay } from "../lib/weeks";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import { SIGNUPS, VISITS, W, reply, stubPostHog } from "./posthog.fixtures";

// Obviously not a real key.
const KEY = "phx_fake-posthog-key-for-tests-only";

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // A Wednesday.
  vi.setSystemTime(new Date("2026-10-14T06:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend with the key and project set, as a configured deployment has. */
function configured() {
  vi.stubEnv("POSTHOG_PERSONAL_API_KEY", KEY);
  vi.stubEnv("POSTHOG_PROJECT_ID", "12345");
  return convexTest(schema, modules);
}

const sync = (t: TestBackend, args: { months?: number } = {}) =>
  t.action(internal.connectors.posthog.sync, args);

const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "posthog"))
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

describe("posthog.sync", () => {
  test("without its key it records 'not configured' and calls nothing", async () => {
    const calls = stubPostHog();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID on the Convex deployment.",
    });
    expect(await stored(t)).toEqual([]);
  });

  test("writes five figures for each closed week since the first sign of life", async () => {
    stubPostHog();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await stored(t)).toEqual([
      "searches startup_insights 2026-09-21 300 posthog",
      "searches startup_insights 2026-09-28 410 posthog",
      "searches startup_insights 2026-10-05 380 posthog",
      "signups startup_insights 2026-09-21 10 posthog",
      "signups startup_insights 2026-09-28 12 posthog",
      "signups startup_insights 2026-10-05 0 posthog",
      "signups_activated startup_insights 2026-09-21 4 posthog",
      "signups_activated startup_insights 2026-09-28 6 posthog",
      "signups_activated startup_insights 2026-10-05 0 posthog",
      "web_visitors startup_insights 2026-09-21 120 posthog",
      "web_visitors startup_insights 2026-09-28 150 posthog",
      "web_visitors startup_insights 2026-10-05 90 posthog",
      "weekly_active_users startup_insights 2026-09-21 40 posthog",
      "weekly_active_users startup_insights 2026-09-28 55 posthog",
      "weekly_active_users startup_insights 2026-10-05 50 posthog",
    ]);
    expect(await status(t)).toMatchObject({ state: "ok" });
  });

  test("the key goes to PostHog's query endpoint, as a bearer header, and nowhere else", async () => {
    const calls = stubPostHog();
    const t = configured();
    await sync(t);
    expect(calls.map((c) => c.question)).toEqual(["visits", "searches", "signups"]);
    for (const call of calls) {
      expect(call.url.href).toBe("https://us.posthog.com/api/projects/12345/query/");
      expect(call.method).toBe("POST");
      expect(call.kind).toBe("HogQLQuery");
      expect(call.authorization).toBe(`Bearer ${KEY}`);
      // A redirect is never followed, so the key can only go where it was sent.
      expect(call.redirect).toBe("manual");
      expect(call.query).not.toContain(KEY);
    }
    expect(await logged(t)).not.toContain(KEY);
  });

  test("asks for eight closed weeks and never for the week in progress", async () => {
    const calls = stubPostHog();
    const t = configured();
    await sync(t);
    const from = msOfDay("2026-08-17") / 1000;
    const to = msOfDay("2026-10-12") / 1000;
    expect(calls[0]!.query).toContain(`timestamp >= toDateTime(${from})`);
    expect(calls[0]!.query).toContain(`timestamp < toDateTime(${to})`);
  });

  test("a backfill reaches fifty-seven weeks back", async () => {
    const calls = stubPostHog();
    const t = configured();
    await sync(t, { months: 13 });
    expect(calls[0]!.query).toContain(`toDateTime(${msOfDay("2025-09-08") / 1000})`);
  });

  describe("where the key may be sent", () => {
    test("EU Cloud, when the owner says the project lives there", async () => {
      const calls = stubPostHog();
      vi.stubEnv("POSTHOG_HOST", "https://eu.posthog.com");
      const t = configured();
      expect(await sync(t)).toBe("ok");
      expect(calls.every((c) => c.url.origin === "https://eu.posthog.com")).toBe(true);
    });

    test("no other host: the run fails before any request is made", async () => {
      const calls = stubPostHog();
      vi.stubEnv("POSTHOG_HOST", "https://posthog.example.test");
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "POSTHOG_HOST must be https://us.posthog.com or https://eu.posthog.com.",
      );
      expect(calls).toEqual([]);
    });

    test("a project id that is not a number is refused before any request, and not echoed", async () => {
      const calls = stubPostHog();
      const t = configured();
      vi.stubEnv("POSTHOG_PROJECT_ID", "12345/../../other");
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("POSTHOG_PROJECT_ID must be the project's number.");
      expect(calls).toEqual([]);
    });
  });

  describe("when something goes wrong, stored numbers stay and the log stays clean", () => {
    /** A good run first, so there is something to protect. */
    async function afterGoodRun() {
      stubPostHog();
      const t = configured();
      await sync(t);
      return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
    }

    test("a failed request says which question failed, by status only", async () => {
      const { t, before, okAt } = await afterGoodRun();
      stubPostHog({
        visits: () => new Response('{"detail":"person dump: jane@example.test"}', { status: 500 }),
      });
      expect(await sync(t)).toBe("error");
      expect(await stored(t)).toEqual(before);
      expect(await status(t)).toMatchObject({
        state: "error",
        message: "PostHog answered 500 for visits.",
        lastOkAt: okAt,
      });
      expect(await logged(t)).not.toContain("jane@example.test");
    });

    test("one question of three failing writes nothing at all", async () => {
      // The other two answered. A part of the read is not written.
      stubPostHog({ signups: () => new Response("no", { status: 403 }) });
      const t = configured();
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("PostHog answered 403 for signups.");
      expect(await stored(t)).toEqual([]);
    });

    test("an error inside a 200 is not quoted", async () => {
      const { t, before } = await afterGoodRun();
      stubPostHog({
        searches: () => ({ ...reply([]), error: "Unknown property $internal_plan_name" }),
      });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("PostHog reported an error for searches.");
      expect(await logged(t)).not.toContain("internal_plan_name");
      expect(await stored(t)).toEqual(before);
    });

    test("a result cut short is not written", async () => {
      const { t, before } = await afterGoodRun();
      stubPostHog({ visits: () => ({ ...VISITS, hasMore: true }) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("PostHog's visits result was cut short.");
      expect(await stored(t)).toEqual(before);
    });

    test("an event or property name in a row never reaches the log or the store", async () => {
      const { t, before } = await afterGoodRun();
      stubPostHog({ visits: () => reply([["$pageview_secret_property", 5]]) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "PostHog's visits result has a row that is not whole numbers.",
      );
      expect(await logged(t)).not.toContain("secret_property");
      expect(await stored(t)).toEqual(before);
    });

    test("the week in progress is refused even when PostHog sends it", async () => {
      const { t, before } = await afterGoodRun();
      stubPostHog({ visits: () => reply([...VISITS.results, [W("2026-10-12"), 7]]) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "PostHog's visits result has a week that was not asked for.",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("three empty answers are an empty result, not eight weeks of zeros", async () => {
      // An answer like this once would otherwise overwrite every week.
      const { t, before } = await afterGoodRun();
      const nothing = () => reply([]);
      stubPostHog({ visits: nothing, searches: nothing, signups: nothing });
      expect(await sync(t)).toBe("empty");
      expect((await status(t))?.message).toBe("The source returned nothing.");
      expect(await stored(t)).toEqual(before);
    });

    test("figures that cannot be true are not written", async () => {
      const { t, before } = await afterGoodRun();
      stubPostHog({ signups: () => reply([...SIGNUPS.results, [W("2026-10-05"), 3, 4]]) });
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "PostHog reports more activated signups than signups in a week.",
      );
      expect(await stored(t)).toEqual(before);
    });
  });

  test("running twice writes nothing new", async () => {
    stubPostHog();
    const t = configured();
    await sync(t);
    await sync(t);
    const [, second] = await runs(t);
    expect(second).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 15 });
  });
});
