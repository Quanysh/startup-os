import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// `clinics_using` (kz_product) is owned by the CFO workbook source.
const using = (periodStart: string, value: number) => ({
  key: "clinics_using",
  scope: "kz_product",
  period: "month" as const,
  periodStart,
  value,
});

const batch = {
  source: "cfo_workbook",
  batchId: "test-batch",
  startedAt: 1_000,
  rows: [using("2026-09-01", 11), using("2026-10-01", 12)],
};

const allRows = (t: TestBackend) =>
  t.run((ctx) => ctx.db.query("metricSnapshots").collect());

describe("snapshots.applySync", () => {
  test("stores new rows and counts them", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.snapshots.applySync, batch);
    expect(result).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(await allRows(t)).toHaveLength(2);
  });

  test("re-applying the same batch adds and changes nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.snapshots.applySync, batch);
    const again = await t.mutation(internal.snapshots.applySync, batch);
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await allRows(t)).toHaveLength(2);
  });

  test("a corrected value overwrites its bucket instead of adding a row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.snapshots.applySync, batch);
    const result = await t.mutation(internal.snapshots.applySync, {
      ...batch,
      rows: [using("2026-10-01", 14)],
    });
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const rows = await allRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.periodStart === "2026-10-01")?.value).toBe(14);
  });

  test("one bad row rejects the whole batch", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.snapshots.applySync, {
        ...batch,
        rows: [using("2026-10-01", 12), { ...using("2026-10-15", 12) }],
      }),
    ).rejects.toThrow("invalid_snapshots");
    expect(await allRows(t)).toEqual([]);
  });

  test("a source cannot write a metric it does not own", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.snapshots.applySync, { ...batch, source: "posthog" }),
    ).rejects.toThrow("invalid_snapshots");
    expect(await allRows(t)).toEqual([]);
  });

  test("records the run and marks the source ok", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.snapshots.applySync, batch);
    const { status, runs } = await t.run(async (ctx) => ({
      status: await ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "cfo_workbook"))
        .unique(),
      runs: await ctx.db.query("syncRuns").collect(),
    }));
    expect(status?.state).toBe("ok");
    expect(status?.lastOkAt).toBeTypeOf("number");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok", inserted: 2, batchId: "test-batch" });
  });
});

describe("snapshots.recordFailure", () => {
  test("a failed run leaves the last good numbers and last-ok time in place", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.snapshots.applySync, batch);
    const before = await t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "cfo_workbook"))
        .unique(),
    );

    await t.mutation(internal.snapshots.recordFailure, {
      source: "cfo_workbook",
      startedAt: 2_000,
      status: "error",
      message: "upstream returned 500",
    });

    const after = await t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "cfo_workbook"))
        .unique(),
    );
    expect(after?.state).toBe("error");
    expect(after?.message).toBe("upstream returned 500");
    expect(after?.lastOkAt).toBe(before?.lastOkAt);
    expect(await allRows(t)).toHaveLength(2);
  });
});

describe("snapshots.setManual", () => {
  test("stores the value in the bucket containing the given date", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    // MRR is stored per month: a date mid-month lands on the 1st.
    await owner.mutation(api.snapshots.setManual, {
      key: "mrr",
      scope: "us",
      date: "2026-10-12",
      value: 3_400,
      currency: "USD",
    });
    const rows = await allRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "mrr",
      scope: "us",
      period: "month",
      periodStart: "2026-10-01",
      value: 3_400,
      currency: "USD",
      source: "manual",
    });
  });

  test("money takes its market's currency when none is given", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    // Kazakhstan cash is still typed in (the workbook owns Kazakhstan MRR).
    await owner.mutation(api.snapshots.setManual, {
      key: "cash",
      scope: "kz",
      date: "2026-10-01",
      value: 4_200_000,
    });
    expect((await allRows(t))[0]).toMatchObject({ scope: "kz", currency: "KZT" });
  });

  test("entering the same bucket again replaces the value", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const entry = { key: "mrr", scope: "us", date: "2026-10-12", currency: "USD" };
    await owner.mutation(api.snapshots.setManual, { ...entry, value: 3_400 });
    await owner.mutation(api.snapshots.setManual, { ...entry, date: "2026-10-28", value: 3_900 });
    const rows = await allRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(3_900);
  });

  test("refuses a metric that a sync owns", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.snapshots.setManual, {
        key: "clinics_using",
        scope: "kz_product",
        date: "2026-10-12",
        value: 99,
      }),
    ).rejects.toThrow("invalid_snapshots");
    expect(await allRows(t)).toEqual([]);
  });

  test("a figure the workbook owns cannot be typed in", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const error = await owner
      .mutation(api.snapshots.setManual, {
        key: "mrr",
        scope: "kz",
        date: "2026-10-15",
        value: 1_650_000,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConvexError);
    // convex-test hands a ConvexError's data back as JSON text.
    expect(JSON.parse(error.data).issues[0].message).toBe(
      '"mrr" (kz) is written by "cfo_workbook", not "manual".',
    );
    expect(await allRows(t)).toEqual([]);
  });

  test("refuses a date that does not exist", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.snapshots.setManual, {
        key: "mrr",
        scope: "us",
        date: "2026-02-30",
        value: 1,
        currency: "USD",
      }),
    ).rejects.toThrow("is not a date");
  });
});

describe("snapshots.removeManual", () => {
  test("deletes a manual entry", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.snapshots.setManual, {
      key: "mrr",
      scope: "us",
      date: "2026-10-01",
      value: 3_400,
      currency: "USD",
    });
    await owner.mutation(api.snapshots.removeManual, {
      key: "mrr",
      scope: "us",
      periodStart: "2026-10-01",
    });
    expect(await allRows(t)).toEqual([]);
  });

  test("will not delete a value written by a sync", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.mutation(internal.snapshots.applySync, batch);
    await expect(
      owner.mutation(api.snapshots.removeManual, {
        key: "clinics_using",
        scope: "kz_product",
        periodStart: "2026-10-01",
      }),
    ).rejects.toThrow("not manual entry");
    expect(await allRows(t)).toHaveLength(2);
  });
});
