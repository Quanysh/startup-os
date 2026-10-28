import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { SOURCES } from "./connectors/manifest";
import { stubMercury } from "./connectors/mercury.fixtures";
import { SYNC_ACTIONS } from "./sources";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const run = (source: string, startedAt: number) => ({
  source,
  startedAt,
  finishedAt: startedAt + 5,
  status: "ok" as const,
  inserted: 0,
  updated: 0,
  unchanged: 0,
});

describe("sources.list", () => {
  test("names the missing env var for an unconfigured source", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    const workbook = sources.find((s) => s.id === "cfo_workbook");
    expect(workbook?.configured).toBe(false);
    expect(workbook?.missingEnv).toEqual(["INGEST_TOKEN_CFO_WORKBOOK"]);
    expect(workbook?.status).toBeNull();
  });

  test("the client register is listed, with the token variable it needs", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "client_register")).toMatchObject({
      kind: "ingest",
      configured: false,
      missingEnv: ["INGEST_TOKEN_CLIENT_REGISTER"],
    });
  });

  test("the financial model is listed, with the token variable it needs", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "financial_model")).toMatchObject({
      label: "Financial model",
      kind: "ingest",
      configured: false,
      fedBy: null,
      canBackfill: false,
      missingEnv: ["INGEST_TOKEN_FINANCIAL_MODEL"],
      pushEnv: null,
    });
  });

  test("a source with its env set is configured", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", "a-long-enough-ingest-token-0123456789");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "cfo_workbook")).toMatchObject({
      configured: true,
      missingEnv: [],
    });
  });

  test("a token too short to be a secret counts as missing", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", "short");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "cfo_workbook")).toMatchObject({
      configured: false,
      missingEnv: ["INGEST_TOKEN_CFO_WORKBOOK"],
    });
  });

  test("manual entry needs no configuration", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "manual")?.configured).toBe(true);
  });

  test("never returns a secret's value", async () => {
    const secret = "super-secret-value-0123456789-abcdefghij";
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", secret);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    expect(JSON.stringify(sources)).not.toContain(secret);
  });

  test("shows the outcome of the last run", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.mutation(internal.snapshots.recordFailure, {
      source: "cfo_workbook",
      startedAt: 1,
      status: "error",
      message: "boom",
    });
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "cfo_workbook")?.status).toMatchObject({
      state: "error",
      message: "boom",
    });
  });

  test("says which pulled sources have a longer history to ask for", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const sources = await owner.query(api.sources.list, {});
    const canBackfill = Object.fromEntries(sources.map((s) => [s.id, s.canBackfill]));
    // Not the whole map: other sources are added beside these.
    expect(canBackfill).toMatchObject({
      manual: false,
      cfo_workbook: false,
      mercury: true,
      posthog: true,
      vercel: true,
      vertical_startup: false,
    });
  });
});

describe("sources.list: how a source is fed", () => {
  const PUSH = "fake-push-token-0123456789-abcdefghijkl";
  const listed = async (id: string) => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    return (await owner.query(api.sources.list, {})).find((s) => s.id === id);
  };

  test("a pulled source with neither its key nor a token: not configured, naming both ways in", async () => {
    expect(await listed("mercury")).toMatchObject({
      configured: false,
      fedBy: null,
      missingEnv: ["MERCURY_API_TOKEN"],
      pushEnv: "INGEST_TOKEN_MERCURY",
    });
  });

  test("with its key it is pulled", async () => {
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    expect(await listed("mercury")).toMatchObject({
      configured: true,
      fedBy: "pull",
      missingEnv: [],
    });
  });

  test("with only its ingest token it is configured, and fed by push", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", PUSH);
    expect(await listed("mercury")).toMatchObject({
      kind: "api",
      configured: true,
      fedBy: "push",
      missingEnv: [],
    });
  });

  test("with both it stays pulled", async () => {
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    vi.stubEnv("INGEST_TOKEN_MERCURY", PUSH);
    expect(await listed("mercury")).toMatchObject({ configured: true, fedBy: "pull" });
  });

  test("a work tool with only its token is fed by push too", async () => {
    vi.stubEnv("INGEST_TOKEN_GMAIL", PUSH);
    expect(await listed("gmail")).toMatchObject({ configured: true, fedBy: "push", missingEnv: [] });
  });

  test("a pulled source that cannot be pushed offers no token", async () => {
    vi.stubEnv("INGEST_TOKEN_VERCEL", PUSH);
    expect(await listed("vercel")).toMatchObject({
      configured: false,
      fedBy: null,
      pushEnv: null,
    });
  });

  test("an ingest source and manual entry say how they are fed", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", PUSH);
    expect(await listed("cfo_workbook")).toMatchObject({ fedBy: "push", pushEnv: null });
    expect(await listed("manual")).toMatchObject({ fedBy: "manual" });
  });

  test("never returns the token's value", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", PUSH);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(JSON.stringify(await owner.query(api.sources.list, {}))).not.toContain(PUSH);
  });
});

describe("sources.runNow on a source fed by push", () => {
  test("there is nothing to run, in words that say why, and nothing is scheduled", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", "fake-push-token-0123456789-abcdefghijkl");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(
      '"mercury" is pushed by a connector run, so there is nothing to run here.',
    );
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
  });
});

describe("sources.recentRuns", () => {
  test("returns runs newest first", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("syncRuns", run("cfo_workbook", 100));
      await ctx.db.insert("syncRuns", run("cfo_workbook", 300));
      await ctx.db.insert("syncRuns", run("cfo_workbook", 200));
    });
    const runs = await owner.query(api.sources.recentRuns, {});
    expect(runs.map((r) => r.startedAt)).toEqual([300, 200, 100]);
  });
});

describe("sources.recentRuns limit", () => {
  test("a limit that is not a whole positive number falls back to something sane", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.db.insert("syncRuns", run("cfo_workbook", 100 + i));
    });
    expect(await owner.query(api.sources.recentRuns, { limit: Number.NaN })).toHaveLength(5);
    expect(await owner.query(api.sources.recentRuns, { limit: 2.7 })).toHaveLength(2);
    expect(await owner.query(api.sources.recentRuns, { limit: -4 })).toHaveLength(1);
  });
});

describe("sources.pruneRuns", () => {
  test("keeps going until every old run is gone, not just the first batch", async () => {
    // Hourly connectors write more runs in a week than one batch removes.
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 620; i++) await ctx.db.insert("syncRuns", run("cfo_workbook", old + i));
    });
    await t.mutation(internal.sources.pruneRuns, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
  });

  test("deletes runs older than the retention window and keeps recent ones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("syncRuns", run("cfo_workbook", now - 90 * DAY));
      await ctx.db.insert("syncRuns", run("cfo_workbook", now - 31 * DAY));
      await ctx.db.insert("syncRuns", run("cfo_workbook", now - 2 * DAY));
    });
    await t.mutation(internal.sources.pruneRuns, {});
    const left = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(left).toHaveLength(1);
    expect(left[0]?.startedAt).toBe(now - 2 * DAY);
  });
});

describe("sources.runNow", () => {
  /** The owner's client, with Mercury configured and faked. */
  async function ownerWithMercury() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T06:00:00Z"));
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    const calls = stubMercury();
    const t = convexTest(schema, modules);
    return { t, calls, owner: await signInAsOwner(t) };
  }

  test("starts the Mercury sync for the owner", async () => {
    const { t, calls, owner } = await ownerWithMercury();
    await owner.mutation(api.sources.runNow, { source: "mercury" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sources = await owner.query(api.sources.list, {});
    expect(sources.find((s) => s.id === "mercury")?.status?.state).toBe("ok");
    // A plain run reads the three-month window, not the backfill's thirteen.
    const listing = calls.find((c) => c.url.pathname.endsWith("/transactions"));
    expect(listing?.url.searchParams.get("start")).toBe("2026-06-02");
  });

  test("a source is started at most once a minute, by anyone, and is said in fixed words", async () => {
    const { t, calls, owner } = await ownerWithMercury();
    const TOO_SOON = "That source was started less than a minute ago. Try again in a minute.";
    await owner.mutation(api.sources.runNow, { source: "mercury" });
    await expect(owner.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(TOO_SOON);
    await expect(
      owner.mutation(api.sources.runNow, { source: "mercury", backfill: true }),
    ).rejects.toThrow(TOO_SOON);
    // Someone else with the page is held to the same minute.
    const holder = await signInWithAreas(t, "engineer", ["settings"]);
    await expect(holder.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(TOO_SOON);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const listings = () => calls.filter((c) => c.url.pathname.endsWith("/transactions")).length;
    const once = listings();
    // A minute later it runs again.
    vi.setSystemTime(new Date("2026-10-12T06:01:01Z"));
    await holder.mutation(api.sources.runNow, { source: "mercury" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(listings()).toBeGreaterThan(once);
  });

  test("a start that is refused for another reason does not use up the minute", async () => {
    const { owner } = await ownerWithMercury();
    vi.stubEnv("MERCURY_API_TOKEN", "");
    await expect(owner.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(/Set .* first/);
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    await owner.mutation(api.sources.runNow, { source: "mercury" });
  });

  test("a backfill reaches thirteen months back", async () => {
    const { t, calls, owner } = await ownerWithMercury();
    await owner.mutation(api.sources.runNow, { source: "mercury", backfill: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const listing = calls.find((c) => c.url.pathname.endsWith("/transactions"));
    // Sixty days before October 2025, the thirteenth month back.
    expect(listing?.url.searchParams.get("start")).toBe("2025-08-02");
  });

  test("a pushed or typed-in source has nothing to run", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.sources.runNow, { source: "cfo_workbook" }),
    ).rejects.toThrow('"cfo_workbook" is not pulled by the OS, so there is nothing to run.');
    await expect(owner.mutation(api.sources.runNow, { source: "manual" })).rejects.toThrow(
      '"manual" is not pulled by the OS, so there is nothing to run.',
    );
  });

  test("an id that is not in the manifest is unknown, not 'nothing to run'", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.sources.runNow, { source: "x" })).rejects.toThrow(
      'Unknown source "x".',
    );
  });

  test("a pulled source with no token is refused, naming it, and nothing is scheduled", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(
      "Set MERCURY_API_TOKEN on the Convex deployment first.",
    );
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
  });

  test("a source with no backfill refuses one, and schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.sources.runNow, { source: "vertical_startup", backfill: true }),
    ).rejects.toThrow('"vertical_startup" has no backfill: every run reads all the source keeps.');
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
  });

  test("every pulled source in the manifest has a sync to run", () => {
    // The next connector cannot ship buttons that answer "nothing to run".
    const pulled = SOURCES.filter((s) => s.kind === "api").map((s) => s.id);
    expect(pulled.length).toBeGreaterThan(0);
    for (const id of pulled) expect(SYNC_ACTIONS[id], id).toBeDefined();
  });
});
