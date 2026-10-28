import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { PLAN_KEYS, PLAN_SCENARIOS, type PlanScenario } from "./lib/planShape";
import { GRANTABLE_AREAS } from "./lib/roles";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Row = { scenario: PlanScenario; year: number; key: string; value: number };

/** Every scenario, year and figure: 21 rows a year, in the order the plan is read back. */
const whole = (years: number[], value = 1): Row[] =>
  PLAN_SCENARIOS.flatMap((scenario) =>
    years.flatMap((year) => PLAN_KEYS.map((key) => ({ scenario, year, key, value }))),
  );

// Made-up model versions: any short hex string.
const V1 = "a1b2c3d";
const V2 = "e4f5a6b";

const push = (t: TestBackend, rows: Row[], modelVersion = V1) =>
  t.mutation(internal.plan.apply, {
    source: "financial_model",
    batchId: "financial_model-2026-10-13",
    observedAt: "2026-10-13T09:30:00Z",
    startedAt: 1,
    modelVersion,
    rows,
  });

const stored = (t: TestBackend) => t.run((ctx) => ctx.db.query("planFigures").collect());

describe("plan.apply", () => {
  test("a first push stores every row, logs one run and marks the source ok", async () => {
    const t = convexTest(schema, modules);
    expect(await push(t, whole([2026, 2027]))).toEqual({ inserted: 42, updated: 0, unchanged: 0 });

    const rows = await stored(t);
    expect(rows).toHaveLength(42);
    expect(rows.every((row) => row.modelVersion === V1)).toBe(true);

    const log = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]).toMatchObject({
      source: "financial_model",
      batchId: "financial_model-2026-10-13",
      observedAt: "2026-10-13T09:30:00Z",
      startedAt: 1,
      status: "ok",
      inserted: 42,
      updated: 0,
      unchanged: 0,
    });
    expect(log.status).toMatchObject([{ source: "financial_model", state: "ok" }]);
    // The run and the rows are one write: they carry the same moment.
    expect(log.status[0]?.lastOkAt).toBe(rows[0]?.syncedAt);
  });

  test("pushing the same plan again changes nothing", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]));
    expect(await push(t, whole([2026, 2027]))).toEqual({ inserted: 0, updated: 0, unchanged: 42 });
    expect(await stored(t)).toHaveLength(42);
  });

  test("one changed value is one update", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]));
    const changed = whole([2026, 2027]).map((row) =>
      row.scenario === "base" && row.year === 2027 && row.key === "arr"
        ? { ...row, value: 2_000_000 }
        : row,
    );
    expect(await push(t, changed)).toEqual({ inserted: 0, updated: 1, unchanged: 41 });
    const rows = await stored(t);
    expect(rows).toHaveLength(42);
    expect(rows.filter((row) => row.value !== 1)).toMatchObject([
      { scenario: "base", year: 2027, key: "arr", value: 2_000_000 },
    ]);
  });

  test("a new model version with the same values changes no figure, and every row carries it", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]), V1);
    expect(await push(t, whole([2026, 2027]), V2)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 42,
    });
    const rows = await stored(t);
    expect(rows).toHaveLength(42);
    expect(rows.every((row) => row.modelVersion === V2)).toBe(true);
  });

  test("every row is stamped with the latest push, changed or not", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    await push(t, whole([2026]));
    const later = new Date("2026-10-14T09:00:00Z");
    vi.setSystemTime(later);
    await push(t, whole([2026]));
    expect((await stored(t)).every((row) => row.syncedAt === later.getTime())).toBe(true);
  });

  test("a push replaces the plan: a year it no longer names is removed", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]));
    // The 21 rows that stay are unchanged; the 21 that go are counted as updates.
    expect(await push(t, whole([2026]))).toEqual({ inserted: 0, updated: 21, unchanged: 21 });
    const rows = await stored(t);
    expect(rows).toHaveLength(21);
    expect(rows.every((row) => row.year === 2026)).toBe(true);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs.at(-1)).toMatchObject({ inserted: 0, updated: 21, unchanged: 21 });
  });

  test("a figure the OS does not keep is refused, in fixed words, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const refused = push(t, [...whole([2026]), { scenario: "base", year: 2026, key: "mrr", value: 1 }]);
    await expect(refused).rejects.toThrow("A plan row has a figure the OS does not keep.");
    await expect(refused).rejects.not.toThrow(/mrr/);
    const written = await t.run(async (ctx) => ({
      figures: await ctx.db.query("planFigures").collect(),
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(written).toEqual({ figures: [], runs: [], status: [] });
  });

  test("a refused push leaves the stored plan as it was", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]));
    await expect(
      push(t, [...whole([2026], 5), { scenario: "bull", year: 2026, key: "mrr", value: 1 }], V2),
    ).rejects.toThrow("A plan row has a figure the OS does not keep.");
    const rows = await stored(t);
    expect(rows).toHaveLength(42);
    expect(rows.every((row) => row.value === 1 && row.modelVersion === V1)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toHaveLength(1);
  });

  // The endpoint refuses these first, by row; the writer does not take its word for it.
  test.each([
    ["a repeated row", [...whole([2026]), whole([2026])[0]!]],
    ["an incomplete plan", whole([2026]).slice(1)],
    ["a value a figure cannot have", [{ ...whole([2026])[0]!, value: -1 }, ...whole([2026]).slice(1)]],
  ])("%s is refused, in fixed words, and nothing is written", async (_what, rows) => {
    const t = convexTest(schema, modules);
    await expect(push(t, rows)).rejects.toThrow("The plan is not whole.");
    const written = await t.run(async (ctx) => ({
      figures: await ctx.db.query("planFigures").collect(),
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(written).toEqual({ figures: [], runs: [], status: [] });
  });

  test("a plan that is not whole leaves the stored plan as it was", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026, 2027]));
    await expect(push(t, whole([2026], 5).slice(1), V2)).rejects.toThrow("The plan is not whole.");
    const rows = await stored(t);
    expect(rows).toHaveLength(42);
    expect(rows.every((row) => row.value === 1 && row.modelVersion === V1)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toHaveLength(1);
  });

  test("the plan is not a metric: no snapshot is written", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026]));
    expect(await t.run((ctx) => ctx.db.query("metricSnapshots").collect())).toEqual([]);
  });
});

describe("plan.get", () => {
  const read = async (t: TestBackend) => (await signInAsOwner(t)).query(api.plan.get, {});

  test("nothing stored is null, not an empty plan", async () => {
    const t = convexTest(schema, modules);
    expect(await read(t)).toBeNull();
  });

  test("the rows come back by scenario (bear, base, bull), then year, then figure", async () => {
    const t = convexTest(schema, modules);
    // Each row's value is its place in the order it should be read back in.
    const inOrder = whole([2026, 2027]).map((row, index) => ({ ...row, value: index }));
    await push(t, [...inOrder].reverse());
    const plan = await read(t);
    expect(plan?.rows).toEqual(inOrder);
    expect(plan?.rows.slice(0, 3)).toEqual([
      { scenario: "bear", year: 2026, key: "arr", value: 0 },
      { scenario: "bear", year: 2026, key: "revenue", value: 1 },
      { scenario: "bear", year: 2026, key: "net_burn", value: 2 },
    ]);
    expect(plan?.rows.at(-1)).toEqual({
      scenario: "bull",
      year: 2027,
      key: "capital_raised",
      value: 41,
    });
  });

  test("it says which model version the plan is and when it was pushed", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    await push(t, whole([2026]), V1);
    const later = new Date("2026-10-14T09:00:00Z");
    vi.setSystemTime(later);
    await push(t, whole([2026]), V2);
    const plan = await read(t);
    expect(plan).toEqual({ modelVersion: V2, syncedAt: later.getTime(), rows: whole([2026]) });
  });

  test("the version and the time are the most recently synced row's", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const row = { scenario: "base" as const, year: 2026, value: 1 };
      await ctx.db.insert("planFigures", { ...row, key: "arr", modelVersion: V1, syncedAt: 5 });
      await ctx.db.insert("planFigures", { ...row, key: "revenue", modelVersion: V2, syncedAt: 9 });
      await ctx.db.insert("planFigures", { ...row, key: "net_burn", modelVersion: V1, syncedAt: 5 });
    });
    expect(await read(t)).toMatchObject({ modelVersion: V2, syncedAt: 9 });
  });

  test("a stored row whose figure the OS no longer keeps is left out", async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026]));
    await t.run((ctx) =>
      ctx.db.insert("planFigures", {
        scenario: "base",
        year: 2026,
        key: "a_figure_since_dropped",
        value: 9,
        modelVersion: V1,
        syncedAt: 1,
      }),
    );
    expect((await read(t))?.rows).toEqual(whole([2026]));
  });
});

describe("plan.get: who may read it", () => {
  /** A backend with a plan stored, so a refusal is not just "nothing there". */
  const withPlan = async () => {
    const t = convexTest(schema, modules);
    await push(t, whole([2026]));
    return t;
  };

  test("a signed-out caller is refused", async () => {
    const t = await withPlan();
    await expect(t.query(api.plan.get, {})).rejects.toThrow("not_allowed");
  });

  test("a teammate with every page but finance is refused", async () => {
    const t = await withPlan();
    const others = GRANTABLE_AREAS.filter((area) => area !== "finance");
    const teammate = await signInWithAreas(t, "cofounder", others);
    await expect(teammate.query(api.plan.get, {})).rejects.toThrow("not_allowed");
  });

  test("a teammate with finance on Globex only is refused: the plan is Startup's", async () => {
    const t = await withPlan();
    const teammate = await signInWithAreas(t, "cofounder", ["finance"], ["kz"]);
    await expect(teammate.query(api.plan.get, {})).rejects.toThrow("not_allowed");
  });

  test("a teammate with finance on Startup only reads it", async () => {
    const t = await withPlan();
    const teammate = await signInWithAreas(t, "engineer", ["finance"], ["us"]);
    expect(await teammate.query(api.plan.get, {})).toMatchObject({
      modelVersion: V1,
      rows: whole([2026]),
    });
  });
});
