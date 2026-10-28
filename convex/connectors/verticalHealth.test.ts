import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import { HEALTH, stubVertical, week } from "./verticalHealth.fixtures";

// Obviously not a real deployment or secret.
const URL_OK = "https://fake-vertical-123.convex.site/os/health";
const SECRET = "fake-vertical-health-secret-for-tests-only";

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // A Wednesday.
  vi.setSystemTime(new Date("2026-10-14T06:30:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A backend with the URL and secret set, as a configured deployment has. */
function configured(url = URL_OK, secret = SECRET) {
  vi.stubEnv("VERTICAL_HEALTH_URL", url);
  vi.stubEnv("VERTICAL_HEALTH_SECRET", secret);
  return convexTest(schema, modules);
}

const sync = (t: TestBackend, args: { months?: number } = {}) =>
  t.action(internal.connectors.verticalHealth.sync, args);

const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "vertical_startup"))
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

describe("verticalHealth.sync", () => {
  test("without its URL and secret it records 'not configured' and calls nothing", async () => {
    const calls = stubVertical();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(await status(t)).toMatchObject({
      state: "not_configured",
      message: "Set VERTICAL_HEALTH_URL, VERTICAL_HEALTH_SECRET on the Convex deployment.",
    });
  });

  test("writes today's practices and three figures for each closed week", async () => {
    stubVertical();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    const rows = await stored(t);
    expect(rows).toHaveLength(13);
    expect(rows).toContain("practices vertical_startup 2026-10-14 4 vertical_startup");
    expect(rows).toContain("weekly_active_users vertical_startup 2026-10-05 14 vertical_startup");
    expect(rows).toContain("practices_active vertical_startup 2026-09-14 2 vertical_startup");
    expect(rows).toContain("core_actions vertical_startup 2026-09-28 188 vertical_startup");
  });

  test("the secret goes to the one URL, as a bearer header, once, and nowhere else", async () => {
    const calls = stubVertical();
    const t = configured();
    await sync(t, { months: 13 });
    // A backfill asks nothing more: the endpoint always sends all it keeps.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(URL_OK);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.authorization).toBe(`Bearer ${SECRET}`);
    // A redirect is never followed, so the secret can only go where it was sent.
    expect(calls[0]!.redirect).toBe("manual");
    expect(await logged(t)).not.toContain(SECRET);
  });

  describe("where the secret may be sent", () => {
    test.each([
      ["plain http", "http://fake-vertical-123.convex.site/os/health"],
      ["another host", "https://vertical.example.test/os/health"],
      ["a look-alike host", "https://fake.convex.site.example.test/os/health"],
      ["another path", "https://fake-vertical-123.convex.site/os/health/extra"],
      ["a query string", "https://fake-vertical-123.convex.site/os/health?next=elsewhere"],
      ["a user and password", "https://user:pass@fake-vertical-123.convex.site/os/health"],
      ["a port", "https://fake-vertical-123.convex.site:8443/os/health"],
      ["something that is not a URL", "the vertical endpoint"],
    ])("%s is refused before any request, and not echoed", async (_name, url) => {
      const calls = stubVertical();
      const t = configured(url);
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "VERTICAL_HEALTH_URL must be https://<deployment>.convex.site/os/health.",
      );
      expect(calls).toEqual([]);
    });

    test("a secret too short to be one is refused before any request", async () => {
      const calls = stubVertical();
      const t = configured(URL_OK, "short");
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe("VERTICAL_HEALTH_SECRET must be 32 characters or more.");
      expect(calls).toEqual([]);
    });
  });

  describe("when something goes wrong, stored numbers stay and the log stays clean", () => {
    /** A good run first, so there is something to protect. */
    async function afterGoodRun() {
      stubVertical();
      const t = configured();
      await sync(t);
      return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
    }

    test("a refused request is reported by its status only", async () => {
      const { t, before, okAt } = await afterGoodRun();
      stubVertical(() => new Response("Smith Specialty: unauthorized", { status: 401 }));
      expect(await sync(t)).toBe("error");
      expect(await stored(t)).toEqual(before);
      expect(await status(t)).toMatchObject({
        state: "error",
        message: "Vertical Startup answered 401 for health.",
        lastOkAt: okAt,
      });
      expect(await logged(t)).not.toContain("Smith");
    });

    test("a week that has not ended fails the run: nothing of the answer is written", async () => {
      const { t, before } = await afterGoodRun();
      stubVertical(() => ({ ...HEALTH, weeks: [...HEALTH.weeks, week("2026-10-12", 99, 9, 999)] }));
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vertical Startup's health response includes a week that has not ended.",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("text where a week belongs never reaches the log or the store", async () => {
      const { t, before } = await afterGoodRun();
      stubVertical(() => ({ ...HEALTH, weeks: [week("Smith Specialty, Jane Doe", 1, 1, 1)] }));
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vertical Startup's health response has a week that does not start on a Monday.",
      );
      expect(await logged(t)).not.toContain("Smith");
      expect(await stored(t)).toEqual(before);
    });

    test("an answer made at another time is not written against today", async () => {
      const { t, before } = await afterGoodRun();
      stubVertical(() => ({ ...HEALTH, generatedAt: "2026-10-01T06:30:00.000Z" }));
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vertical Startup's health response was not made in the last hour.",
      );
      expect(await stored(t)).toEqual(before);
    });

    test("no closed week is an empty result", async () => {
      const { t, before } = await afterGoodRun();
      stubVertical(() => ({ ...HEALTH, weeks: [] }));
      expect(await sync(t)).toBe("empty");
      expect(await stored(t)).toEqual(before);
    });

    test("a version this code does not know fails the run instead of writing a guess", async () => {
      const { t, before } = await afterGoodRun();
      stubVertical(() => ({ ...HEALTH, version: 2 }));
      expect(await sync(t)).toBe("error");
      expect((await status(t))?.message).toBe(
        "Vertical Startup's health response is not in the expected shape (version).",
      );
      expect(await stored(t)).toEqual(before);
    });
  });

  test("running twice writes nothing new", async () => {
    stubVertical();
    const t = configured();
    await sync(t);
    await sync(t);
    const [, second] = await runs(t);
    expect(second).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 13 });
  });
});
