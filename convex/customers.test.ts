import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_NOTES_LENGTH } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAs, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Made-up clinics. Every name contains "SECRET" so one assertion can prove a
// surface holds none of them.
type Row = {
  name: string;
  market: "us" | "kz";
  status: "active" | "paused" | "churned";
  monthlyFee?: number;
  lastPaymentDate?: string;
  amountOwed?: number;
  lastUsageDate?: string;
  contractDate?: string;
  baaDate?: string;
};
const ALPHA: Row = {
  name: "SECRET CLINIC ALPHA",
  market: "kz",
  status: "active",
  monthlyFee: 200_000,
  lastPaymentDate: "2026-10-01",
  amountOwed: 0,
};
const BETA: Row = { name: "SECRET CLINIC BETA", market: "us", status: "active" };
const named = (letter: string): Row => ({ ...BETA, name: `SECRET CLINIC ${letter}` });

const push = (t: TestBackend, rows: Row[], extra: { allowShrink?: boolean } = {}) =>
  t.mutation(internal.customers.applyRegister, {
    source: "client_register",
    batchId: "register-test",
    observedAt: "2026-10-12T09:30:00Z",
    startedAt: 1,
    rows,
    ...extra,
  });

const listed = async (t: TestBackend) => {
  const owner = await signInAsOwner(t);
  return owner.query(api.customers.list, {});
};

describe("customers.applyRegister", () => {
  test("a first push stores each clinic, and what was not sent stays unknown", async () => {
    const t = convexTest(schema, modules);
    expect(await push(t, [BETA, ALPHA])).toEqual({
      ok: true,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      archived: 0,
    });
    const { customers } = await listed(t);
    // In name order, whatever order they were sent in.
    expect(customers.map((c) => c.name)).toEqual(["SECRET CLINIC ALPHA", "SECRET CLINIC BETA"]);
    expect(customers[0]).toMatchObject({
      market: "kz",
      status: "active",
      currency: "KZT",
      monthlyFee: 200_000,
      lastPaymentDate: "2026-10-01",
      amountOwed: 0,
      lastUsageDate: null,
      archived: false,
    });
    // Not on record is null. It is never zero.
    expect(customers[1]).toMatchObject({
      currency: "USD",
      monthlyFee: null,
      amountOwed: null,
      lastPaymentDate: null,
      baaDate: null,
      note: null,
      nextTouch: null,
    });
  });

  test("pushing the same register again changes nothing", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA]);
    expect(await push(t, [ALPHA, BETA])).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 2,
      archived: 0,
    });
    expect((await listed(t)).customers).toHaveLength(2);
  });

  test("a changed figure is updated, and one that disappears becomes unknown", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    const { monthlyFee: _gone, ...withoutFee } = ALPHA;
    expect(await push(t, [{ ...withoutFee, amountOwed: 400_000 }])).toMatchObject({ updated: 1 });
    const [clinic] = (await listed(t)).customers;
    expect(clinic).toMatchObject({ amountOwed: 400_000, monthlyFee: null });
  });

  test("the same clinic respelled is still one clinic", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    expect(await push(t, [{ ...ALPHA, name: "Secret  Clinic alpha" }])).toMatchObject({
      inserted: 0,
      updated: 1,
    });
    const { customers } = await listed(t);
    expect(customers.map((c) => c.name)).toEqual(["Secret  Clinic alpha"]);
  });

  test("the owner's note and next touch survive a push", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    const owner = await signInAsOwner(t);
    const [before] = (await owner.query(api.customers.list, {})).customers;
    await owner.mutation(api.customers.setOwnerFields, {
      id: before!.id,
      note: "Call the director about the unpaid quarter",
      nextTouch: "2026-10-20",
    });
    await push(t, [{ ...ALPHA, amountOwed: 600_000 }]);
    const [after] = (await owner.query(api.customers.list, {})).customers;
    expect(after).toMatchObject({
      amountOwed: 600_000,
      note: "Call the director about the unpaid quarter",
      nextTouch: "2026-10-20",
    });
  });

  test("a clinic missing from a push is archived with its note, never deleted", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA, named("GAMMA")]);
    const owner = await signInAsOwner(t);
    const beta = (await owner.query(api.customers.list, {})).customers[1]!;
    await owner.mutation(api.customers.setOwnerFields, { id: beta.id, note: "Left in September" });

    expect(await push(t, [ALPHA, named("GAMMA")])).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 2,
      archived: 1,
    });
    const after = (await owner.query(api.customers.list, {})).customers;
    expect(after).toHaveLength(3);
    expect(after[1]).toMatchObject({
      name: "SECRET CLINIC BETA",
      archived: true,
      note: "Left in September",
    });
  });

  test("a clinic that comes back is restored, and an archived one is not archived twice", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA, named("GAMMA")]);
    await push(t, [ALPHA, named("GAMMA")]);
    // BETA is already archived: a second push without it archives nothing more.
    expect(await push(t, [ALPHA, named("GAMMA")])).toMatchObject({ archived: 0, unchanged: 2 });
    expect(await push(t, [ALPHA, BETA, named("GAMMA")])).toMatchObject({ updated: 1, unchanged: 2 });
    expect((await listed(t)).customers.every((c) => !c.archived)).toBe(true);
  });

  const LETTERS = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON", "ZETA", "ETA", "THETA", "IOTA", "KAPPA", "LAMBDA", "MU"];
  const list = (n: number) => LETTERS.slice(0, n).map(named);

  test("a push that would archive too much of the list is refused and changes nothing", async () => {
    const t = convexTest(schema, modules);
    await push(t, list(4));
    expect(await push(t, list(1))).toEqual({ ok: false, leaving: 3, of: 4 });
    expect((await listed(t)).customers.filter((c) => c.archived)).toEqual([]);
    // The refusal is the endpoint's to log; the mutation wrote no run.
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toHaveLength(1);
  });

  // The rule was "more than half of four or more". A sheet cut at a blank row
  // could lose half the list under it, so it is now a quarter, and two clinics
  // at most from a list under eight.
  test.each([
    // live, kept, refused
    [3, 1, false],
    [3, 0 + 1, false],
    [4, 2, false],
    [4, 1, true],
    [7, 5, false],
    [7, 4, true],
    [8, 6, false],
    [8, 5, true],
    [12, 9, false],
    [12, 8, true],
  ])("from %i live clinics, a push of %i: refused %s", async (live, kept, refused) => {
    const t = convexTest(schema, modules);
    await push(t, list(live));
    const result = await push(t, list(kept));
    if (refused) expect(result).toEqual({ ok: false, leaving: live - kept, of: live });
    else expect(result).toMatchObject({ ok: true, archived: live - kept });
  });

  test("a list of three cannot be emptied to nothing by losing all three", async () => {
    const t = convexTest(schema, modules);
    await push(t, list(3));
    // Three would go, and a push must carry at least one clinic: a different one.
    expect(await push(t, [named("OMEGA")])).toEqual({ ok: false, leaving: 3, of: 3 });
  });

  test("allowShrink lets a real mass change through", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA, named("GAMMA"), named("DELTA")]);
    expect(await push(t, [ALPHA], { allowShrink: true })).toMatchObject({ ok: true, archived: 3 });
  });

  test("the same clinic twice in one push is refused, in words that name no clinic", async () => {
    const t = convexTest(schema, modules);
    const twice = push(t, [ALPHA, { ...ALPHA, name: "secret clinic alpha" }]);
    await expect(twice).rejects.toThrow("The same clinic appears twice in one push.");
    await expect(twice).rejects.not.toThrow(/SECRET/i);
    expect(await t.run((ctx) => ctx.db.query("customers").collect())).toEqual([]);
  });

  test("the run is logged with counts, and no name reaches the log", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA, named("GAMMA")]);
    await push(t, [{ ...ALPHA, amountOwed: 5 }, named("GAMMA")]);
    const log = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
      snapshots: await ctx.db.query("metricSnapshots").collect(),
    }));
    // An archived clinic counts as an update in the three-column run log.
    expect(log.runs.at(-1)).toMatchObject({
      source: "client_register",
      batchId: "register-test",
      status: "ok",
      inserted: 0,
      updated: 2,
      unchanged: 1,
    });
    expect(log.status).toMatchObject([{ source: "client_register", state: "ok" }]);
    expect(log.snapshots).toEqual([]);
    expect(JSON.stringify(log)).not.toContain("SECRET");
  });

  test("a name is stored in the customers table and in no other", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA, BETA]);
    const owner = await signInAsOwner(t);
    const first = (await owner.query(api.customers.list, {})).customers[0]!;
    await owner.mutation(api.customers.setOwnerFields, { id: first.id, nextTouch: "2026-10-20" });
    const others = await t.run(async (ctx) => ({
      syncRuns: await ctx.db.query("syncRuns").collect(),
      sourceStatus: await ctx.db.query("sourceStatus").collect(),
      metricSnapshots: await ctx.db.query("metricSnapshots").collect(),
      obligations: await ctx.db.query("obligations").collect(),
      tasks: await ctx.db.query("tasks").collect(),
      goals: await ctx.db.query("goals").collect(),
      weeklyReviews: await ctx.db.query("weeklyReviews").collect(),
      metricTargets: await ctx.db.query("metricTargets").collect(),
    }));
    expect(JSON.stringify(others)).not.toMatch(/SECRET/i);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("customers").collect()))).toContain(
      "SECRET CLINIC ALPHA",
    );
  });
});

describe("customers.list", () => {
  test("says when the register was last pushed", async () => {
    const t = convexTest(schema, modules);
    expect((await listed(t)).lastPushAt).toBeNull();
    await push(t, [ALPHA]);
    const status = await t.run((ctx) => ctx.db.query("sourceStatus").first());
    expect((await listed(t)).lastPushAt).toBe(status?.lastOkAt);
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    await expect(t.query(api.customers.list, {})).rejects.toThrow("not_allowed");
  });

  test("a signed-in account that is not the owner is refused", async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    const stranger = await signInAs(t, { email: "someone@example.com", emailVerificationTime: 1 });
    await expect(stranger.query(api.customers.list, {})).rejects.toThrow("not_allowed");
  });
});

describe("customers.usage", () => {
  const week = (weekStart: string, checks: number) => ({
    weekStart,
    checks,
    actions: checks * 2,
    doctors: 3,
    failures: 1,
    modules: { intake: checks },
    syncedAt: 1,
  });
  const withUsage = async (t: TestBackend) => {
    await push(t, [ALPHA, BETA]);
    await t.run(async (ctx) => {
      for (const clinic of await ctx.db.query("customers").collect()) {
        for (const [i, start] of ["2026-09-28", "2026-10-05", "2026-09-21"].entries()) {
          await ctx.db.insert("customerUsage", { customerId: clinic._id, ...week(start, 10 + i) });
        }
      }
    });
  };

  test("sends each clinic's weeks, oldest first, by id and with no name", async () => {
    const t = convexTest(schema, modules);
    await withUsage(t);
    const owner = await signInAsOwner(t);
    const usage = await owner.query(api.customers.usage, {});
    expect(usage).toHaveLength(2);
    expect(usage[0]!.weeks.map((w) => w.weekStart)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(JSON.stringify(usage)).not.toContain("SECRET");
  });

  test("a teammate on Globex alone is sent Kazakhstan's clinics only", async () => {
    const t = convexTest(schema, modules);
    await withUsage(t);
    const { customers } = await (await signInAsOwner(t)).query(api.customers.list, {});
    const kz = customers.find((c) => c.market === "kz")!.id;
    const teammate = await signInWithAreas(t, "sales", ["customers"], ["kz"]);
    const usage = await teammate.query(api.customers.usage, {});
    expect(usage.map((u) => u.customerId)).toEqual([kz]);
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.customers.usage, {})).rejects.toThrow("not_allowed");
  });
});

describe("customers.doctors", () => {
  const withDoctors = async (t: TestBackend) => {
    await push(t, [ALPHA, BETA]);
    await t.run(async (ctx) => {
      for (const clinic of await ctx.db.query("customers").collect()) {
        await ctx.db.insert("customerDoctors", {
          customerId: clinic._id,
          doctorId: `d-${clinic.market}`,
          name: `SECRET DOCTOR ${clinic.market}`,
          weekStart: "2026-10-05",
          week: "less",
          actions: 4,
          previous: 20,
          modules: { intake: 4 },
          syncedAt: 1,
        });
      }
    });
    const { customers } = await (await signInAsOwner(t)).query(api.customers.list, {});
    return {
      kz: customers.find((c) => c.market === "kz")!.id,
      us: customers.find((c) => c.market === "us")!.id,
    };
  };

  test("sends a clinic's doctors with their week, and what is not known as null", async () => {
    const t = convexTest(schema, modules);
    const { kz } = await withDoctors(t);
    const doctors = await (await signInAsOwner(t)).query(api.customers.doctors, { customerId: kz });
    expect(doctors).toEqual([
      expect.objectContaining({ name: "SECRET DOCTOR kz", week: "less", actions: 4, previous: 20, usual: null, trialOutcome: null }),
    ]);
  });

  test("another market's clinic is refused in the words of one that is gone, naming nobody", async () => {
    const t = convexTest(schema, modules);
    const { kz, us } = await withDoctors(t);
    const teammate = await signInWithAreas(t, "sales", ["customers"], ["kz"]);
    expect(await teammate.query(api.customers.doctors, { customerId: kz })).toHaveLength(1);
    const refused = teammate.query(api.customers.doctors, { customerId: us });
    await expect(refused).rejects.toThrow("That clinic is no longer in the list.");
    await expect(refused).rejects.not.toThrow(/SECRET/);
  });

  test("the whole list is the caller's markets' clinics only", async () => {
    const t = convexTest(schema, modules);
    const { kz } = await withDoctors(t);
    const owner = await (await signInAsOwner(t)).query(api.customers.doctorRoster, {});
    expect(owner.map((d) => d.name).sort()).toEqual(["SECRET DOCTOR kz", "SECRET DOCTOR us"]);
    const teammate = await signInWithAreas(t, "sales", ["customers"], ["kz"]);
    const theirs = await teammate.query(api.customers.doctorRoster, {});
    expect(theirs.map((d) => [d.customerId, d.name])).toEqual([[kz, "SECRET DOCTOR kz"]]);
    await expect(t.query(api.customers.doctorRoster, {})).rejects.toThrow("not_allowed");
  });

  test("no Customers page, no doctors", async () => {
    const t = convexTest(schema, modules);
    const { kz } = await withDoctors(t);
    const teammate = await signInWithAreas(t, "sales", ["sales"], ["kz"]);
    await expect(teammate.query(api.customers.doctors, { customerId: kz })).rejects.toThrow("not_allowed");
    await expect(t.query(api.customers.doctors, { customerId: kz })).rejects.toThrow("not_allowed");
  });
});

describe("customers.setOwnerFields", () => {
  const one = async () => {
    const t = convexTest(schema, modules);
    await push(t, [ALPHA]);
    const owner = await signInAsOwner(t);
    const id = (await owner.query(api.customers.list, {})).customers[0]!.id;
    const read = async () => (await owner.query(api.customers.list, {})).customers[0]!;
    return { t, owner, id, read };
  };

  test("a note is trimmed; null or blank clears it; a field left out is kept", async () => {
    const { owner, id, read } = await one();
    await owner.mutation(api.customers.setOwnerFields, { id, note: "  Paying late  ", nextTouch: "2026-10-20" });
    expect(await read()).toMatchObject({ note: "Paying late", nextTouch: "2026-10-20" });
    await owner.mutation(api.customers.setOwnerFields, { id, note: null });
    expect(await read()).toMatchObject({ note: null, nextTouch: "2026-10-20" });
    await owner.mutation(api.customers.setOwnerFields, { id, note: "x", nextTouch: null });
    await owner.mutation(api.customers.setOwnerFields, { id, note: "   " });
    expect(await read()).toMatchObject({ note: null, nextTouch: null });
  });

  test("it cannot change what the register owns", async () => {
    const { owner, id } = await one();
    await expect(
      owner.mutation(api.customers.setOwnerFields, {
        id,
        // @ts-expect-error not an argument: the register owns the fee
        monthlyFee: 1,
      }),
    ).rejects.toThrow(/monthlyFee/);
  });

  test("a note longer than anyone would type is refused", async () => {
    const { owner, id } = await one();
    await expect(
      owner.mutation(api.customers.setOwnerFields, { id, note: "x".repeat(MAX_NOTES_LENGTH + 1) }),
    ).rejects.toThrow("That note is too long");
  });

  test("a next touch that is not a date is refused, without echoing it", async () => {
    const { owner, id } = await one();
    const refused = owner.mutation(api.customers.setOwnerFields, { id, nextTouch: "2026-02-30" });
    await expect(refused).rejects.toThrow("The next touch is not a date.");
    await expect(refused).rejects.not.toThrow(/2026-02-30/);
  });

  test("a clinic that is gone says so, without naming it", async () => {
    const { t, owner, id } = await one();
    await t.run((ctx) => ctx.db.delete(id));
    const refused = owner.mutation(api.customers.setOwnerFields, { id, note: "x" });
    await expect(refused).rejects.toThrow("That clinic is no longer in the list.");
    await expect(refused).rejects.not.toThrow(/SECRET/i);
  });

  test("a signed-out caller is refused", async () => {
    const { t, id } = await one();
    await expect(t.mutation(api.customers.setOwnerFields, { id, note: "x" })).rejects.toThrow(
      "not_allowed",
    );
  });
});
