import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Made-up clinics and doctors: every name holds "SECRET", every id is invented.
const push = (t: TestBackend, names: string[]) =>
  t.mutation(internal.customers.applyRegister, {
    source: "client_register",
    startedAt: 1,
    rows: names.map((name) => ({ name, market: "kz" as const, status: "active" as const })),
  });
const clinicIds = async (t: TestBackend) =>
  Object.fromEntries(await t.run(async (ctx) => (await ctx.db.query("customers").collect()).map((c) => [c.name, c._id] as const)));
const appClinic = (org: string, name: string) => ({ org, name, weeks: 3, actions: 12, doctors: 2, lastActiveOn: "2026-10-17" });
const week = (weekStart: string, actions: number) => ({
  weekStart,
  checks: actions,
  actions,
  doctors: 1,
  activeDays: 2,
  failures: 0,
  modules: { intake: actions },
});
const doctor = (org: string, doctorId: string, name: string) => ({
  org,
  doctorId,
  name,
  weekStart: "2026-10-12",
  week: "usual" as const,
  actions: 4,
  activeDays: 2,
  modules: { intake: 4 },
  history: [{ weekStart: "2026-10-12", actions: 4, days: 2, modules: { intake: 4 } }],
});

describe("linking the app's clinics to Customers", () => {
  test("a name that matches one clinic links it; two of a name, or none, stay unlinked; no name is stored", async () => {
    const t = convexTest(schema, modules);
    await push(t, ["ТОО «SECRET Alpha»", "SECRET Twin", "ТОО SECRET Twin"]);
    const result = await t.mutation(internal.kzAppSync.linkClinics, {
      syncedAt: 1,
      clinics: [appClinic("org_alpha", "SECRET alpha"), appClinic("org_twin", "SECRET Twin"), appClinic("org_new", "SECRET Gamma")],
    });
    expect(result).toEqual({ clinics: 3, linkedNow: 1 });
    const ids = await clinicIds(t);
    const rows = await t.run((ctx) => ctx.db.query("kzAppClinics").collect());
    expect(rows.map((r) => [r.org, r.customerId ?? null])).toEqual([
      ["org_alpha", ids["ТОО «SECRET Alpha»"]],
      ["org_twin", null],
      ["org_new", null],
    ]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  test("usage and doctors are written only under a linked clinic, and a doctor who left its roster is removed", async () => {
    const t = convexTest(schema, modules);
    await push(t, ["SECRET Alpha"]);
    await t.mutation(internal.kzAppSync.linkClinics, {
      syncedAt: 1,
      clinics: [appClinic("org_alpha", "SECRET Alpha"), appClinic("org_other", "SECRET Unknown")],
    });
    const run = (doctors: ReturnType<typeof doctor>[]) =>
      t.mutation(internal.kzAppSync.applyClinics, {
        syncedAt: 2,
        clinics: [
          { org: "org_alpha", weeks: [week("2026-10-05", 3), week("2026-10-12", 5)] },
          { org: "org_other", weeks: [week("2026-10-12", 9)] },
        ],
        doctors,
      });
    await run([doctor("org_alpha", "d1", "SECRET Doctor One"), doctor("org_alpha", "d2", "SECRET Doctor Two"), doctor("org_other", "d3", "SECRET Three")]);
    await run([doctor("org_alpha", "d1", "SECRET Doctor One")]);
    const { usage, doctors } = await t.run(async (ctx) => ({
      usage: await ctx.db.query("customerUsage").collect(),
      doctors: await ctx.db.query("customerDoctors").collect(),
    }));
    expect(usage.map((u) => [u.weekStart, u.actions])).toEqual([
      ["2026-10-05", 3],
      ["2026-10-12", 5],
    ]);
    expect(doctors.map((d) => d.name)).toEqual(["SECRET Doctor One"]);
  });

  test("breakdowns: each week kept is replaced whole", async () => {
    const t = convexTest(schema, modules);
    const apply = (rows: { weekStart: string; key: string; values: Record<string, number> }[]) =>
      t.mutation(internal.kzAppSync.applyBreakdowns, { syncedAt: 1, kind: "event", weeks: ["2026-10-12"], rows });
    await apply([{ weekStart: "2026-10-12", key: "old_event", values: { count: 1, users: 1 } }]);
    await apply([{ weekStart: "2026-10-12", key: "new_event", values: { count: 2, users: 1 } }]);
    const rows = await t.run((ctx) => ctx.db.query("kzBreakdowns").collect());
    expect(rows.map((r) => r.key)).toEqual(["new_event"]);
  });
});

describe("customers.setAppClinic", () => {
  const setUp = async () => {
    const t = convexTest(schema, modules);
    await push(t, ["SECRET Alpha", "SECRET Beta"]);
    await t.mutation(internal.kzAppSync.linkClinics, {
      syncedAt: 1,
      clinics: [appClinic("org_alpha", "SECRET Alpha"), appClinic("org_loose", "SECRET Renamed")],
    });
    return { t, ids: (await clinicIds(t)) as Record<string, Id<"customers">> };
  };

  test("links by hand a clinic the name did not match, and refuses an id taken or unknown", async () => {
    const { t, ids } = await setUp();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.customers.setAppClinic, { id: ids["SECRET Beta"]!, org: "org_loose" });
    expect((await owner.query(api.kzProduct.appClinics, {})).map((c) => [c.org, c.customerId])).toEqual([
      ["org_alpha", ids["SECRET Alpha"]],
      ["org_loose", ids["SECRET Beta"]],
    ]);
    await expect(owner.mutation(api.customers.setAppClinic, { id: ids["SECRET Beta"]!, org: "org_alpha" })).rejects.toThrow(
      "That app clinic is linked to another clinic.",
    );
    await expect(owner.mutation(api.customers.setAppClinic, { id: ids["SECRET Beta"]!, org: "org_nowhere" })).rejects.toThrow(
      "The app has no clinic with that id.",
    );
  });

  test("unlinking deletes every usage and doctor row of the old link, past one read, and keeps a row written later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T06:30:00Z"));
    const { t, ids } = await setUp();
    const customerId = ids["SECRET Alpha"]!;
    await t.mutation(internal.kzAppSync.applyClinics, {
      syncedAt: 2,
      clinics: [{ org: "org_alpha", weeks: [week("2026-10-12", 5)] }],
      doctors: [doctor("org_alpha", "d1", "SECRET Doctor One")],
    });
    // More than the old caps (200 usage rows, 1000 doctors), plus one of each
    // written after the unlink's clock so a later run's row stays.
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("customerUsage", {
          customerId,
          weekStart: `2020-${String(i).padStart(4, "0")}`,
          checks: 1,
          actions: 1,
          doctors: 1,
          failures: 0,
          modules: { intake: 1 },
          syncedAt: 2,
        });
      }
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert("customerDoctors", {
          customerId,
          doctorId: `d${String(i).padStart(4, "0")}`,
          name: "SECRET Doctor",
          weekStart: "2026-10-12",
          week: "usual",
          actions: 1,
          modules: { intake: 1 },
          syncedAt: 2,
        });
      }
      await ctx.db.insert("customerUsage", {
        customerId,
        weekStart: "zzzz-later",
        checks: 1,
        actions: 7,
        doctors: 1,
        failures: 0,
        modules: { intake: 7 },
        syncedAt: Number.MAX_SAFE_INTEGER,
      });
      await ctx.db.insert("customerDoctors", {
        customerId,
        doctorId: "zzzz-later",
        name: "SECRET Later",
        weekStart: "2026-10-12",
        week: "usual",
        actions: 7,
        modules: { intake: 7 },
        syncedAt: Number.MAX_SAFE_INTEGER,
      });
    });
    const owner = await signInAsOwner(t);
    await owner.mutation(api.customers.setAppClinic, { id: customerId, org: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      usage: await ctx.db.query("customerUsage").collect(),
      doctors: await ctx.db.query("customerDoctors").collect(),
      clinic: await ctx.db.get(customerId),
    }));
    expect(left.usage.map((u) => [u.weekStart, u.actions])).toEqual([["zzzz-later", 7]]);
    expect(left.doctors.map((d) => [d.doctorId, d.name])).toEqual([["zzzz-later", "SECRET Later"]]);
    expect(left.clinic?.appOrgId).toBeUndefined();
  });

  test("unlinking removes what was written under the link", async () => {
    const { t, ids } = await setUp();
    await t.mutation(internal.kzAppSync.applyClinics, {
      syncedAt: 2,
      clinics: [{ org: "org_alpha", weeks: [week("2026-10-12", 5)] }],
      doctors: [doctor("org_alpha", "d1", "SECRET Doctor One")],
    });
    const owner = await signInAsOwner(t);
    await owner.mutation(api.customers.setAppClinic, { id: ids["SECRET Alpha"]!, org: null });
    const left = await t.run(async (ctx) => [
      ...(await ctx.db.query("customerUsage").collect()),
      ...(await ctx.db.query("customerDoctors").collect()),
    ]);
    expect(left).toEqual([]);
  });

  test("a hand unlink sticks: the next run does not link the same app clinic again by name, and relinking by hand clears it", async () => {
    const { t, ids } = await setUp();
    const alpha = ids["SECRET Alpha"]!;
    const owner = await signInAsOwner(t);
    await owner.mutation(api.customers.setAppClinic, { id: alpha, org: null });
    const run = () =>
      t.mutation(internal.kzAppSync.linkClinics, {
        syncedAt: 3,
        clinics: [appClinic("org_alpha", "SECRET Alpha"), appClinic("org_loose", "SECRET Renamed")],
      });
    expect(await run()).toEqual({ clinics: 2, linkedNow: 0 });
    expect((await t.run((ctx) => ctx.db.get(alpha)))?.appOrgId).toBeUndefined();
    expect((await owner.query(api.kzProduct.appClinics, {})).map((c) => [c.org, c.customerId])).toEqual([
      ["org_alpha", null],
      ["org_loose", null],
    ]);
    // Linked again by hand, it is a link like any other, and the unlink is forgotten.
    await owner.mutation(api.customers.setAppClinic, { id: alpha, org: "org_alpha" });
    await run();
    const clinic = await t.run((ctx) => ctx.db.get(alpha));
    expect(clinic?.appOrgId).toBe("org_alpha");
    expect(clinic?.appOrgUnlinked ?? []).not.toContain("org_alpha");
  });

  test("an app clinic an archived clinic holds is never given to a second clinic", async () => {
    const t = convexTest(schema, modules);
    await push(t, ["SECRET Alpha"]);
    const live = (await clinicIds(t))["SECRET Alpha"] as Id<"customers">;
    const archived = await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(live))!;
      return ctx.db.insert("customers", { ...row, archivedAt: 1, appOrgId: "org_alpha" });
    });
    const result = await t.mutation(internal.kzAppSync.linkClinics, {
      syncedAt: 2,
      clinics: [appClinic("org_alpha", "SECRET Alpha")],
    });
    expect(result).toEqual({ clinics: 1, linkedNow: 0 });
    expect((await t.run((ctx) => ctx.db.get(live)))?.appOrgId).toBeUndefined();
    const rows = await t.run((ctx) => ctx.db.query("kzAppClinics").collect());
    expect(rows.map((r) => [r.org, r.customerId ?? null])).toEqual([["org_alpha", archived]]);
  });

  test("is the Customers page's, on Globex: a teammate with Product alone cannot link", async () => {
    const { t, ids } = await setUp();
    const product = await signInWithAreas(t, "engineer", ["product"]);
    await expect(product.mutation(api.customers.setAppClinic, { id: ids["SECRET Beta"]!, org: "org_loose" })).rejects.toThrow();
    // …and is sent the app's clinics by id and counts, never a name.
    expect(JSON.stringify(await product.query(api.kzProduct.appClinics, {}))).not.toContain("SECRET");
  });
});
