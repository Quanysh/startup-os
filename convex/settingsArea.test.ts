import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { SOURCES } from "./connectors/manifest";
import { GRANTABLE_AREAS } from "./lib/roles";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// The `settings` area: the sources page (the list, the run log, run-now),
// targets and typed-in numbers. The owner can tick it for a teammate, who then
// has it for their companies only. Each rule below is tried by a holder on one
// company reaching for the other's.
//
// The Telegram half of the area is in convex/telegramArea.test.ts.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Company = "us" | "kz";
const holderOn = (t: TestBackend, companies: Company[]) =>
  signInWithAreas(t, "engineer", ["settings"], companies);
const EVERY_OTHER = GRANTABLE_AREAS.filter((area) => area !== "settings");

/** The owner's four work tools: their state is the owner's own, like their records. */
const WORK_TOOLS = ["gmail", "google_calendar", "linear", "fireflies"];
const US_ONLY = ["mercury", "vercel", "vertical_startup", "apollo", "search_console", "visible", "financial_model"];
const KZ_ONLY = ["cfo_workbook", "client_register", "kz_crm"];

async function seedRuns(t: TestBackend) {
  await t.run(async (ctx) => {
    const run = (source: string, startedAt: number) =>
      ctx.db.insert("syncRuns", {
        source,
        startedAt,
        finishedAt: startedAt + 1,
        status: "error",
        message: `SECRET ${source} MESSAGE`,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      });
    // Oldest first. Startup's bank and the owner's mail ran most recently.
    await run("cfo_workbook", 10);
    await run("posthog", 20);
    await run("cfo_workbook", 30);
    await run("mercury", 40);
    await run("gmail", 50);
    await run("mercury", 60);
    await run("mercury", 70);
    for (const source of ["mercury", "cfo_workbook", "posthog", "gmail", "linear"]) {
      await ctx.db.insert("sourceStatus", {
        source,
        state: "error",
        message: `SECRET ${source} STATUS`,
        lastRunAt: 1,
      });
    }
  });
}

const scheduled = (t: TestBackend) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("sources.list", () => {
  test("a holder on Globex is sent its sources and the shared ones, none of Startup's", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const listed = await (await holderOn(t, ["kz"])).query(api.sources.list, {});
    const ids = listed.map((source) => source.id);
    for (const id of KZ_ONLY) expect(ids).toContain(id);
    expect(ids).toContain("manual");
    expect(ids).toContain("posthog");
    for (const id of US_ONLY) expect(ids).not.toContain(id);
    expect(JSON.stringify(listed)).not.toContain("SECRET mercury");
    expect(JSON.stringify(listed)).toContain("SECRET cfo_workbook STATUS");
  });

  test("a holder on Startup is sent none of Globex's", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const listed = await (await holderOn(t, ["us"])).query(api.sources.list, {});
    const ids = listed.map((source) => source.id);
    for (const id of US_ONLY) expect(ids).toContain(id);
    for (const id of KZ_ONLY) expect(ids).not.toContain(id);
    expect(JSON.stringify(listed)).not.toContain("SECRET cfo_workbook");
  });

  test("no holder is sent the owner's own work tools, on one company or both", async () => {
    for (const companies of [["us"], ["kz"], ["us", "kz"]] as Company[][]) {
      const t = convexTest(schema, modules);
      await seedRuns(t);
      const listed = await (await holderOn(t, companies)).query(api.sources.list, {});
      const ids = listed.map((source) => source.id);
      for (const id of WORK_TOOLS) expect(ids).not.toContain(id);
      expect(JSON.stringify(listed)).not.toContain("SECRET gmail");
      expect(JSON.stringify(listed)).not.toContain("SECRET linear");
    }
  });

  test("the owner is still sent every source", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const listed = await (await signInAsOwner(t)).query(api.sources.list, {});
    expect(listed.map((source) => source.id)).toEqual(SOURCES.map((source) => source.id));
    expect(JSON.stringify(listed)).toContain("SECRET gmail STATUS");
  });
});

describe("sources.recentRuns", () => {
  const sourcesOf = async (t: TestBackend, companies: Company[], limit?: number) =>
    (await (await holderOn(t, companies)).query(api.sources.recentRuns, { limit })).map(
      (run) => run.source,
    );

  test("only the runs of sources that serve the holder's companies, newest first", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    expect(await sourcesOf(t, ["kz"])).toEqual(["cfo_workbook", "posthog", "cfo_workbook"]);
    const t2 = convexTest(schema, modules);
    await seedRuns(t2);
    expect(await sourcesOf(t2, ["us"])).toEqual(["mercury", "mercury", "mercury", "posthog"]);
  });

  test("the limit counts the holder's own runs, not the ones left out", async () => {
    // The three newest runs are Startup's and the owner's: a limit of two
    // still finds Globex's two newest behind them.
    const t = convexTest(schema, modules);
    await seedRuns(t);
    expect(await sourcesOf(t, ["kz"], 2)).toEqual(["cfo_workbook", "posthog"]);
  });

  test("a run of the owner's work tools reaches no holder, and the owner still reads all", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const both = await (await holderOn(t, ["us", "kz"])).query(api.sources.recentRuns, {});
    expect(both.map((run) => run.source)).not.toContain("gmail");
    expect(both).toHaveLength(6);
    expect(JSON.stringify(both)).not.toContain("SECRET gmail");
    const owner = await (await signInAsOwner(t)).query(api.sources.recentRuns, {});
    expect(owner).toHaveLength(7);
  });
});

describe("sources.runNow", () => {
  /** Every pulled source configured, and the clock held so nothing scheduled ever runs. */
  function configured() {
    vi.useFakeTimers();
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token-for-tests-only");
    vi.stubEnv("LINEAR_API_KEY", "fake-linear-key-for-tests-only");
    return convexTest(schema, modules);
  }

  test("a holder on Globex cannot run Startup's bank, and nothing is scheduled", async () => {
    const t = configured();
    const holder = await holderOn(t, ["kz"]);
    await expect(holder.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(
      holder.mutation(api.sources.runNow, { source: "mercury", backfill: true }),
    ).rejects.toThrow("not_allowed");
    expect(await scheduled(t)).toEqual([]);
  });

  test("no holder can start a read of the owner's own work tools", async () => {
    const t = configured();
    const holder = await holderOn(t, ["us", "kz"]);
    await expect(holder.mutation(api.sources.runNow, { source: "linear" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(holder.mutation(api.sources.runNow, { source: "gmail" })).rejects.toThrow(
      "not_allowed",
    );
    expect(await scheduled(t)).toEqual([]);
  });

  // What a holder may run is shown by the refusal they meet next: the missing
  // key, which is said only to someone past the company rule. (The sync
  // itself is started in convex/sources.test.ts, with the bank faked.)
  test("a holder on Startup is past the rule for Startup's bank", async () => {
    const t = convexTest(schema, modules);
    const holder = await holderOn(t, ["us"]);
    await expect(holder.mutation(api.sources.runNow, { source: "mercury" })).rejects.toThrow(
      "Set MERCURY_API_TOKEN on the Convex deployment first.",
    );
  });

  test("a source that serves both is a holder's to run, on either company", async () => {
    const t = convexTest(schema, modules);
    const holder = await holderOn(t, ["kz"]);
    await expect(holder.mutation(api.sources.runNow, { source: "posthog" })).rejects.toThrow(
      "Set POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID on the Convex deployment first.",
    );
  });

  test("an unknown id is unknown to a holder as to the owner", async () => {
    const t = convexTest(schema, modules);
    const holder = await holderOn(t, ["kz"]);
    await expect(holder.mutation(api.sources.runNow, { source: "x" })).rejects.toThrow(
      'Unknown source "x".',
    );
  });
});

// ── Targets and typed-in numbers ────────────────────────────────────────────

async function seedFigures(t: TestBackend) {
  return await t.run(async (ctx) => {
    for (const [key, scope] of [
      ["cash_in", "us"],
      ["paying_clinics", "kz"],
      ["fx_usd_kzt", "company"],
    ] as const) {
      await ctx.db.insert("metricTargets", { key, scope, target: 100 });
    }
    const manual = (scope: string) =>
      ctx.db.insert("metricSnapshots", {
        key: "cash",
        scope,
        // A balance is a day's figure.
        period: "day",
        periodStart: "2026-09-01",
        value: 7,
        source: "manual",
        syncedAt: 1,
      });
    return { usCash: await manual("us"), kzCash: await manual("kz") };
  });
}
const targetOf = (t: TestBackend, key: string, scope: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query("metricTargets")
      .withIndex("by_key_and_scope", (q) => q.eq("key", key).eq("scope", scope))
      .unique();
    return row?.target ?? null;
  });

describe("targets", () => {
  test("a holder on Globex can neither set nor clear a target of Startup's figure", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const holder = await holderOn(t, ["kz"]);
    await expect(
      holder.mutation(api.targets.set, { key: "cash_in", scope: "us", target: 5 }),
    ).rejects.toThrow("not_allowed");
    await expect(
      holder.mutation(api.targets.clear, { key: "cash_in", scope: "us" }),
    ).rejects.toThrow("not_allowed");
    expect(await targetOf(t, "cash_in", "us")).toBe(100);
    // A figure that never had a target is refused the same way, not created.
    await expect(
      holder.mutation(api.targets.set, { key: "mrr", scope: "us", target: 5 }),
    ).rejects.toThrow("not_allowed");
    expect(await targetOf(t, "mrr", "us")).toBeNull();
  });

  test("and sets and clears its own company's, the exchange rate included", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const holder = await holderOn(t, ["kz"]);
    await holder.mutation(api.targets.set, { key: "paying_clinics", scope: "kz", target: 5 });
    expect(await targetOf(t, "paying_clinics", "kz")).toBe(5);
    await holder.mutation(api.targets.clear, { key: "paying_clinics", scope: "kz" });
    expect(await targetOf(t, "paying_clinics", "kz")).toBeNull();
    // The rate exists to convert tenge: it is Globex's, whatever its scope is called.
    await holder.mutation(api.targets.set, { key: "fx_usd_kzt", scope: "company", target: 5 });
    expect(await targetOf(t, "fx_usd_kzt", "company")).toBe(5);
  });

  test("a holder on Startup cannot touch Globex's, by either scope", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const holder = await holderOn(t, ["us"]);
    for (const [key, scope] of [
      ["paying_clinics", "kz"],
      ["fx_usd_kzt", "company"],
    ] as const) {
      await expect(holder.mutation(api.targets.set, { key, scope, target: 5 })).rejects.toThrow(
        "not_allowed",
      );
      await expect(holder.mutation(api.targets.clear, { key, scope })).rejects.toThrow(
        "not_allowed",
      );
      expect(await targetOf(t, key, scope)).toBe(100);
    }
    await holder.mutation(api.targets.set, { key: "cash_in", scope: "us", target: 5 });
    expect(await targetOf(t, "cash_in", "us")).toBe(5);
  });

  test("a holder who may not see a figure is told the same whether a value is there, and never where it came from", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    // The holder has Sources and Telegram and not Finance: cash is not theirs to read.
    const holder = await holderOn(t, ["kz"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("metricSnapshots", {
        key: "cash",
        scope: "kz",
        period: "day",
        periodStart: "2026-08-01",
        value: 5,
        source: "mercury",
        syncedAt: 1,
      });
    });
    const said = async (periodStart: string) => {
      try {
        await holder.mutation(api.snapshots.removeManual, { key: "cash", scope: "kz", periodStart });
      } catch (error) {
        return String((error as { data?: unknown }).data).replace(/^"|"$/g, "");
      }
      return "removed";
    };
    const NOTHING = "There is no typed-in value there to remove.";
    // A month a sync wrote, and a month with nothing at all.
    expect(await said("2026-08-01")).toBe(NOTHING);
    expect(await said("2026-07-01")).toBe(NOTHING);
    expect(await t.run((ctx) => ctx.db.query("metricSnapshots").collect())).toHaveLength(3);
  });

  test("someone who may see the figure is still told where a synced value comes from, and nothing for an empty month", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metricSnapshots", {
        key: "cash",
        scope: "kz",
        period: "day",
        periodStart: "2026-08-01",
        value: 5,
        source: "mercury",
        syncedAt: 1,
      });
    });
    await expect(
      owner.mutation(api.snapshots.removeManual, { key: "cash", scope: "kz", periodStart: "2026-08-01" }),
    ).rejects.toThrow("not manual entry");
    expect(
      await owner.mutation(api.snapshots.removeManual, { key: "cash", scope: "kz", periodStart: "2026-07-01" }),
    ).toBeNull();
  });

  test("an unknown figure is unknown to a holder as to the owner", async () => {
    const t = convexTest(schema, modules);
    const holder = await holderOn(t, ["kz"]);
    await expect(
      holder.mutation(api.targets.set, { key: "no_such_metric", scope: "us", target: 5 }),
    ).rejects.toThrow('Unknown metric "no_such_metric".');
  });

  test("a teammate with every other page can set no target", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const teammate = await signInWithAreas(t, "cofounder", EVERY_OTHER);
    await expect(
      teammate.mutation(api.targets.set, { key: "cash_in", scope: "us", target: 5 }),
    ).rejects.toThrow("not_allowed");
    expect(await targetOf(t, "cash_in", "us")).toBe(100);
  });
});

describe("targets.list, for a holder who sets them", () => {
  const keys = async (t: TestBackend, companies: Company[]) =>
    (await (await holderOn(t, companies)).query(api.targets.list, {}))
      .map((target) => `${target.key}:${target.scope}`)
      .sort();

  test("the targets of their companies' figures, with no other page ticked", async () => {
    // Without them the editor would show "no target" over one that is set.
    const t = convexTest(schema, modules);
    await seedFigures(t);
    expect(await keys(t, ["kz"])).toEqual(["fx_usd_kzt:company", "paying_clinics:kz"]);
    const t2 = convexTest(schema, modules);
    await seedFigures(t2);
    expect(await keys(t2, ["us"])).toEqual(["cash_in:us"]);
  });

  test("the area opens a target, never the figure: a series still answers as for an unknown one", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const holder = await holderOn(t, ["kz"]);
    expect(await holder.query(api.metrics.series, { key: "cash", scope: "kz" })).toEqual([]);
  });

  test("someone with the scorecard and not the area is sent what they were before", async () => {
    const t = convexTest(schema, modules);
    await seedFigures(t);
    const teammate = await signInWithAreas(t, "engineer", ["scorecard", "finance"], ["us"]);
    const list = await teammate.query(api.targets.list, {});
    expect(list.map((target) => `${target.key}:${target.scope}`)).toEqual(["cash_in:us"]);
    const none = await signInWithAreas(t, "sales", ["scorecard"], ["us", "kz"]);
    expect(await none.query(api.targets.list, {})).toEqual([]);
  });
});

describe("typed-in numbers", () => {
  const snapshots = (t: TestBackend) => t.run((ctx) => ctx.db.query("metricSnapshots").collect());

  test("a holder on Startup cannot type in, or remove, a figure of Globex's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedFigures(t);
    const holder = await holderOn(t, ["us"]);
    const before = await snapshots(t);
    await expect(
      holder.mutation(api.snapshots.setManual, {
        key: "cash",
        scope: "kz",
        date: "2026-10-01",
        value: 1,
      }),
    ).rejects.toThrow("not_allowed");
    // Over the top of the value already there, too.
    await expect(
      holder.mutation(api.snapshots.setManual, {
        key: "cash",
        scope: "kz",
        date: "2026-09-01",
        value: 1,
      }),
    ).rejects.toThrow("not_allowed");
    await expect(
      holder.mutation(api.snapshots.removeManual, {
        key: "cash",
        scope: "kz",
        periodStart: "2026-09-01",
      }),
    ).rejects.toThrow("not_allowed");
    expect(await snapshots(t)).toEqual(before);
    expect((await t.run((ctx) => ctx.db.get(ids.kzCash)))?.value).toBe(7);
  });

  test("a holder on Globex cannot touch Startup's, and types in and removes its own", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedFigures(t);
    const holder = await holderOn(t, ["kz"]);
    await expect(
      holder.mutation(api.snapshots.setManual, {
        key: "cash",
        scope: "us",
        date: "2026-10-01",
        value: 1,
      }),
    ).rejects.toThrow("not_allowed");
    await expect(
      holder.mutation(api.snapshots.removeManual, {
        key: "cash",
        scope: "us",
        periodStart: "2026-09-01",
      }),
    ).rejects.toThrow("not_allowed");
    expect((await t.run((ctx) => ctx.db.get(ids.usCash)))?.value).toBe(7);

    await holder.mutation(api.snapshots.setManual, {
      key: "cash",
      scope: "kz",
      date: "2026-09-01",
      value: 9,
    });
    expect((await t.run((ctx) => ctx.db.get(ids.kzCash)))?.value).toBe(9);
    await holder.mutation(api.snapshots.removeManual, {
      key: "cash",
      scope: "kz",
      periodStart: "2026-09-01",
    });
    expect(await t.run((ctx) => ctx.db.get(ids.kzCash))).toBeNull();
  });

  test("an unknown figure is unknown to a holder as to the owner", async () => {
    const t = convexTest(schema, modules);
    const holder = await holderOn(t, ["kz"]);
    await expect(
      holder.mutation(api.snapshots.setManual, {
        key: "no_such_metric",
        scope: "us",
        date: "2026-10-01",
        value: 1,
      }),
    ).rejects.toThrow('Unknown metric "no_such_metric".');
  });
});

describe("the scorecard's feeds, for a holder of the settings area", () => {
  test("they hear of every feed of their companies, and never of the owner's work tools", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const { tiles, sources } = await (await holderOn(t, ["kz"])).query(api.metrics.scorecard, {});
    // The area opens no figure: those still go by the page a figure is on.
    expect(tiles).toEqual([]);
    expect(Object.keys(sources).sort()).toEqual(["cfo_workbook", "posthog"]);
  });

  test("a teammate without it hears only of the feeds behind their own figures", async () => {
    const t = convexTest(schema, modules);
    await seedRuns(t);
    const teammate = await signInWithAreas(t, "engineer", ["board"], ["kz"]);
    expect((await teammate.query(api.metrics.scorecard, {})).sources).toEqual({});
  });
});
