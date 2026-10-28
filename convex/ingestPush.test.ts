import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules, type TestBackend } from "./test.setup";

// A pulled source (Mercury, PostHog, Apollo) fed by a connector run instead:
// its ingest token is set and its API variables are not.

// Obviously not real secrets.
const TOKEN = "fake-push-token-0123456789-abcdefghijkl";
const OTHER = "fake-other-token-0123456789-abcdefghijk";

beforeEach(() => {
  // Only the clock is faked: the action's own awaits must run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // A Wednesday. The week in progress began on Monday 2026-10-12.
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function post(t: TestBackend, body: unknown, token = TOKEN) {
  return t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const envelope = (source: string, snapshots: unknown[]) => ({
  version: 1,
  source,
  batchId: `${source}-2026-10-14`,
  observedAt: "2026-10-14T06:00:00Z",
  snapshots,
});

const week = (key: string, scope: string, periodStart: string, value = 7) => ({
  key,
  scope,
  period: "week",
  periodStart,
  value,
});
const usd = (key: string, period: string, periodStart: string, value: number) => ({
  key,
  scope: "us",
  period,
  periodStart,
  value,
  currency: "USD",
});

const stored = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.scope} ${r.periodStart} ${r.value} ${r.source}`)
      .sort(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const status = (t: TestBackend, source: string) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", source))
      .unique(),
  );

describe("POST /ingest/v1 as a pulled source", () => {
  test("PostHog's token writes PostHog's finished weeks", async () => {
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      envelope("posthog", [
        week("web_visitors", "startup_insights", "2026-10-05", 120),
        week("signups", "startup_insights", "2026-10-05", 9),
      ]),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, inserted: 2 });
    expect(await stored(t)).toEqual([
      "signups startup_insights 2026-10-05 9 posthog",
      "web_visitors startup_insights 2026-10-05 120 posthog",
    ]);
    expect(await status(t, "posthog")).toMatchObject({ state: "ok" });
  });

  test("PostHog's week in progress is refused whole, and the refusal is logged", async () => {
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      envelope("posthog", [
        week("signups", "startup_insights", "2026-10-05"),
        week("signups", "startup_insights", "2026-10-12"),
      ]),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_snapshots",
      issues: [
        {
          path: "snapshots.1.periodStart",
          message: "This week has not ended. Only finished weeks are stored.",
        },
      ],
    });
    expect(await stored(t)).toEqual([]);
    expect(await status(t, "posthog")).toMatchObject({
      state: "error",
      message:
        "invalid_snapshots: snapshots.1.periodStart — This week has not ended. Only finished weeks are stored.",
    });
  });

  test("Mercury's token writes today's cash and the month as it stands", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      envelope("mercury", [
        usd("cash", "day", "2026-10-14", 250000.5),
        usd("cash_in", "month", "2026-09-01", 40000),
        usd("cash_out", "month", "2026-09-01", 61000.25),
        usd("cash_in", "month", "2026-10-01", 1200),
        usd("cash_out", "month", "2026-10-01", 8000),
      ]),
    );
    expect(response.status).toBe(200);
    expect(await stored(t)).toHaveLength(5);
    expect((await status(t, "mercury"))?.lastOkAt).toBe(Date.now());
  });

  test("Apollo's token writes this week's totals, and not another week's", async () => {
    vi.stubEnv("INGEST_TOKEN_APOLLO", TOKEN);
    const t = convexTest(schema, modules);
    const good = await post(t, envelope("apollo", [week("outbound_delivered", "us", "2026-10-12", 300)]));
    expect(good.status).toBe(200);
    const stale = await post(t, envelope("apollo", [week("outbound_delivered", "us", "2026-10-05", 1)]));
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({
      error: "invalid_snapshots",
      issues: [
        {
          path: "snapshots.0.periodStart",
          message: "Totals to date belong to the week they are read in.",
        },
      ],
    });
    expect(await stored(t)).toEqual(["outbound_delivered us 2026-10-12 300 apollo"]);
  });

  test("a pushed source's token still writes only what the registry gives that source", async () => {
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("posthog", [usd("cash", "day", "2026-10-14", 1)]));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_snapshots" });
    expect(await stored(t)).toEqual([]);
  });

  test("it cannot write as another source", async () => {
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("mercury", [usd("cash", "day", "2026-10-14", 1)]));
    expect(response.status).toBe(403);
    expect(await stored(t)).toEqual([]);
  });

  test("with its API variables set the source is pulled, and a push is refused and logged", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", TOKEN);
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("mercury", [usd("cash", "day", "2026-10-14", 1)]));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "source_is_pulled",
      issues: [
        {
          path: "source",
          message:
            'The OS reads "mercury" itself with its API variables. Remove them to feed it by push.',
        },
      ],
    });
    expect(await stored(t)).toEqual([]);
    expect(await runs(t)).toHaveLength(1);
  });

  test("a pulled source that is not pushable has no token, whatever is set", async () => {
    vi.stubEnv("INGEST_TOKEN_VERCEL", TOKEN);
    const t = convexTest(schema, modules);
    const alone = await post(t, envelope("vercel", [week("deployments", "startup_insights", "2026-10-05")]));
    expect(alone.status).toBe(503);
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", OTHER);
    const beside = await post(t, envelope("vercel", [week("deployments", "startup_insights", "2026-10-05")]));
    expect(beside.status).toBe(401);
    expect(await runs(t)).toEqual([]);
  });

  test("two sources sharing one token authenticate neither, pulled or not", async () => {
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    vi.stubEnv("INGEST_TOKEN_APOLLO", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope("posthog", [week("signups", "startup_insights", "2026-10-05")]));
    expect(response.status).toBe(401);
    expect(await stored(t)).toEqual([]);
  });
});

describe("a pushed source's schedule", () => {
  test("the daily Mercury run does nothing and logs nothing when only the token is set", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", TOKEN);
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.connectors.mercury.sync, {})).toBe("not_configured");
    expect(fetched).not.toHaveBeenCalled();
    expect(await runs(t)).toEqual([]);
    expect(await status(t, "mercury")).toBeNull();
  });

  test("it leaves a push's good status alone", async () => {
    vi.stubEnv("INGEST_TOKEN_APOLLO", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, envelope("apollo", [week("outbound_delivered", "us", "2026-10-12", 300)]));
    const before = await status(t, "apollo");
    await t.action(internal.connectors.apollo.sync, {});
    await t.action(internal.connectors.posthog.sync, {});
    expect(await status(t, "apollo")).toEqual(before);
    expect((await runs(t)).filter((run) => run.source === "apollo")).toHaveLength(1);
    // PostHog has neither a key nor a token: that one is still said.
    expect(await status(t, "posthog")).toMatchObject({ state: "not_configured" });
  });

  test("the Linear and Gmail reads do nothing when only their token is set", async () => {
    vi.stubEnv("INGEST_TOKEN_LINEAR", TOKEN);
    vi.stubEnv("INGEST_TOKEN_GMAIL", OTHER);
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const t = convexTest(schema, modules);
    await t.action(internal.connectors.linear.sync, {});
    await t.action(internal.connectors.gmail.sync, {});
    expect(fetched).not.toHaveBeenCalled();
    expect(await runs(t)).toEqual([]);
    expect(await status(t, "linear")).toBeNull();
    expect(await status(t, "gmail")).toBeNull();
  });
});
