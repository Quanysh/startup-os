import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import { SEQUENCES, page, sequence, stubApollo } from "./apollo.fixtures";

// Obviously not a real key.
const KEY = "fake-apollo-key-for-tests-only";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T06:20:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configured() {
  vi.stubEnv("APOLLO_API_KEY", KEY);
  return convexTest(schema, modules);
}
const sync = (t: TestBackend) => t.action(internal.connectors.apollo.sync, {});
const status = (t: TestBackend) =>
  t.run((ctx) =>
    ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "apollo"))
      .unique(),
  );
const stored = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.scope} ${r.periodStart} ${r.value} ${r.source}`)
      .sort(),
  );
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
async function afterGoodRun() {
  stubApollo();
  const t = configured();
  expect(await sync(t)).toBe("ok");
  return { t, before: await stored(t), okAt: (await status(t))?.lastOkAt };
}

describe("apollo.sync", () => {
  test("without a key it records 'not configured' and calls nothing", async () => {
    const calls = stubApollo();
    const t = convexTest(schema, modules);
    expect(await sync(t)).toBe("not_configured");
    expect(calls).toEqual([]);
    expect((await status(t))?.message).toBe("Set APOLLO_API_KEY on the Convex deployment.");
  });

  test("writes the three totals into this week's bucket", async () => {
    stubApollo();
    const t = configured();
    expect(await sync(t)).toBe("ok");
    expect(await stored(t)).toEqual([
      "outbound_delivered us 2026-10-12 240 apollo",
      "outbound_opened us 2026-10-12 90 apollo",
      "outbound_replied us 2026-10-12 8 apollo",
    ]);
  });

  test("the next day's read overwrites the same week; the next week's starts a new bucket", async () => {
    const { t } = await afterGoodRun();
    stubApollo(() => page([...SEQUENCES, sequence("d", 10, 4, 1)], 1, 1, 4));
    vi.setSystemTime(new Date("2026-10-13T06:20:00Z"));
    await sync(t);
    expect(await stored(t)).toContain("outbound_delivered us 2026-10-12 250 apollo");
    expect(await stored(t)).toHaveLength(3);
    vi.setSystemTime(new Date("2026-10-19T06:20:00Z"));
    await sync(t);
    expect(await stored(t)).toHaveLength(6);
    expect(await stored(t)).toContain("outbound_delivered us 2026-10-19 250 apollo");
  });

  test("a failure leaves stored totals as they were, and logs neither the key nor a sequence's name", async () => {
    const { t, before, okAt } = await afterGoodRun();
    stubApollo(
      () =>
        new Response(`{"error":"key ${KEY} may not read Fixture Sequence a"}`, { status: 403 }),
    );
    expect(await sync(t)).toBe("error");
    expect(await stored(t)).toEqual(before);
    expect(await status(t)).toMatchObject({
      state: "error",
      message: "Apollo answered 403 for sequences.",
      lastOkAt: okAt,
    });
    const log = JSON.stringify([await runs(t), await status(t)]);
    expect(log).not.toContain(KEY);
    expect(log).not.toContain("Fixture");
  });

  test("a short list does not lower the stored totals", async () => {
    const { t, before } = await afterGoodRun();
    stubApollo(() => page([sequence("a", 120, 60, 5)], 1, 1, 3));
    expect(await sync(t)).toBe("error");
    expect((await status(t))?.message).toBe(
      "Apollo listed fewer sequences than it counted; the totals would be short.",
    );
    expect(await stored(t)).toEqual(before);
  });

  test("no sequence at all is an empty run, not three zeros", async () => {
    const { t, before } = await afterGoodRun();
    stubApollo(() => page([], 1, 0, 0));
    expect(await sync(t)).toBe("empty");
    expect(await stored(t)).toEqual(before);
  });
});
