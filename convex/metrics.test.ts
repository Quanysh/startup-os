import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { SCORECARD_SERIES_LENGTH } from "./metrics";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const using = (periodStart: string, value: number) => ({
  key: "clinics_using",
  scope: "kz_product",
  period: "month" as const,
  periodStart,
  value,
});

describe("metrics.scorecard", () => {
  test("returns one entry per metric and scope, empty when there is no data", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const { tiles } = await owner.query(api.metrics.scorecard, {});
    const mrrUs = tiles.find((x) => x.key === "mrr" && x.scope === "us");
    expect(mrrUs).toEqual({
      key: "mrr",
      scope: "us",
      latest: null,
      firstPeriodStart: null,
      series: [],
    });
    expect(tiles.some((x) => x.key === "mrr" && x.scope === "kz")).toBe(true);
  });

  test("latest is the most recent bucket and the series runs oldest to newest", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.mutation(internal.snapshots.applySync, {
      source: "cfo_workbook",
      startedAt: 1,
      rows: [using("2026-10-01", 12), using("2026-08-01", 9), using("2026-09-01", 11)],
    });
    const { tiles } = await owner.query(api.metrics.scorecard, {});
    const tile = tiles.find((x) => x.key === "clinics_using");
    expect(tile?.latest).toMatchObject({
      value: 12,
      periodStart: "2026-10-01",
      source: "cfo_workbook",
    });
    expect(tile?.series).toEqual([
      { periodStart: "2026-08-01", value: 9 },
      { periodStart: "2026-09-01", value: 11 },
      { periodStart: "2026-10-01", value: 12 },
    ]);
  });

  test("the series is capped at the most recent buckets", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const months = Array.from({ length: SCORECARD_SERIES_LENGTH + 5 }, (_, i) => {
      const d = new Date(Date.UTC(2024, i, 1));
      return using(d.toISOString().slice(0, 10), i);
    });
    await t.mutation(internal.snapshots.applySync, {
      source: "cfo_workbook",
      startedAt: 1,
      rows: months,
    });
    const { tiles } = await owner.query(api.metrics.scorecard, {});
    const tile = tiles.find((x) => x.key === "clinics_using");
    expect(tile?.series).toHaveLength(SCORECARD_SERIES_LENGTH);
    expect(tile?.series.at(-1)?.value).toBe(SCORECARD_SERIES_LENGTH + 4);
  });

  test("reports the first bucket ever recorded, even when the series no longer reaches it", async () => {
    // The UI needs this to tell "this market had not started yet" from
    // "this market's number is missing".
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const months = Array.from({ length: SCORECARD_SERIES_LENGTH + 5 }, (_, i) => {
      const d = new Date(Date.UTC(2024, i, 1));
      return using(d.toISOString().slice(0, 10), i);
    });
    await t.mutation(internal.snapshots.applySync, {
      source: "cfo_workbook",
      startedAt: 1,
      rows: months,
    });
    const { tiles } = await owner.query(api.metrics.scorecard, {});
    const tile = tiles.find((x) => x.key === "clinics_using");
    expect(tile?.firstPeriodStart).toBe("2024-01-01");
    expect(tile?.series[0]?.periodStart).not.toBe("2024-01-01");
  });

  test("reports each source's last successful run for freshness", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.mutation(internal.snapshots.applySync, {
      source: "cfo_workbook",
      startedAt: 1,
      rows: [using("2026-10-01", 12)],
    });
    const { sources } = await owner.query(api.metrics.scorecard, {});
    expect(sources.cfo_workbook).toMatchObject({ state: "ok" });
    expect(sources.cfo_workbook?.lastOkAt).toBeTypeOf("number");
  });
});

describe("metrics.series", () => {
  const push = (t: TestBackend, count: number) =>
    t.mutation(internal.snapshots.applySync, {
      source: "cfo_workbook",
      startedAt: 1,
      rows: Array.from({ length: count }, (_, i) =>
        using(new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10), i),
      ),
    });

  test("returns a metric's history oldest first, with where each value came from", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await push(t, 3);
    const rows = await owner.query(api.metrics.series, {
      key: "clinics_using",
      scope: "kz_product",
    });
    expect(rows.map((r) => r.periodStart)).toEqual(["2024-01-01", "2024-02-01", "2024-03-01"]);
    expect(rows[0]).toMatchObject({ value: 0, source: "cfo_workbook", currency: null });
  });

  test("keeps only the most recent values up to the limit", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await push(t, 6);
    const rows = await owner.query(api.metrics.series, {
      key: "clinics_using",
      scope: "kz_product",
      limit: 2,
    });
    expect(rows.map((r) => r.periodStart)).toEqual(["2024-05-01", "2024-06-01"]);
  });

  test("a limit that is not a whole positive number falls back to something sane", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await push(t, 4);
    const args = { key: "clinics_using", scope: "kz_product" };
    expect(await owner.query(api.metrics.series, { ...args, limit: Number.NaN })).toHaveLength(4);
    expect(await owner.query(api.metrics.series, { ...args, limit: 2.9 })).toHaveLength(2);
  });

  test("an unknown metric or a scope it lacks returns nothing rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.metrics.series, { key: "vibes", scope: "us" })).toEqual([]);
    expect(
      await owner.query(api.metrics.series, { key: "clinics_using", scope: "us" }),
    ).toEqual([]);
  });
});
