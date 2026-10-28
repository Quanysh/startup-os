import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { NOW, answer, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner, type TestBackend } from "./test.setup";

// A deal that reaches Won becomes a customer (convex/lib/wonCustomers.ts),
// whichever way it got there: the Sales page, `deal_update`, a deal made at
// Won, the Kazakhstan CRM's push. The client register stays the record of
// truth: a clinic it already carries is linked, never doubled, and a later
// push of the register supersedes the row Sales made. Every name is made up
// and holds "SECRET".

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const TODAY = "2026-10-14";

const rows = (t: TestBackend) => t.run((ctx) => ctx.db.query("customers").collect());
const live = async (t: TestBackend) => (await rows(t)).filter((row) => row.archivedAt === undefined);

async function usDeal(t: TestBackend, fields: { name?: string; stage?: string; amount?: number } = {}) {
  const owner = await signInAsOwner(t);
  const id = await owner.mutation(api.deals.create, {
    market: "us",
    name: fields.name ?? "SECRET Won Vertical",
    stage: fields.stage ?? "proposal",
    ...(fields.amount === undefined ? null : { amount: fields.amount }),
  });
  return { owner, id };
}

type Row = { name: string; market: "us" | "kz"; status: "active" | "paused" | "churned"; monthlyFee?: number };
const pushRegister = (t: TestBackend, register: Row[]) =>
  t.mutation(internal.customers.applyRegister, {
    source: "client_register",
    batchId: "register-test",
    startedAt: 1,
    rows: register,
    allowShrink: true,
  });

const crmPush = (
  t: TestBackend,
  deals: { externalId: string; name: string; stage: string; amount?: number; closedAt?: string }[],
) =>
  t.mutation(internal.snapshots.applySync, {
    source: "kz_crm",
    batchId: "kz-crm-test",
    startedAt: 1,
    rows: [],
    pipeline: {
      mode: "upsert",
      deals: deals.map(({ amount, ...deal }) => ({
        ...deal,
        ...(amount === undefined ? null : { amount, currency: "KZT" }),
      })),
    },
  });

describe("a deal moved to Won on the Sales page", () => {
  test("dragging it to Won adds the clinic to Customers, linked to the deal", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t, { amount: 2_400 });
    await owner.mutation(api.deals.move, { id, stage: "won", index: 0 });

    const [row, ...rest] = await rows(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      source: "deals",
      nameKey: "secret won vertical",
      name: "SECRET Won Vertical",
      market: "us",
      currency: "USD",
      status: "active",
      contractDate: TODAY,
      // A deal's amount is its expected monthly fee (schema.ts, docs/ingest.md).
      monthlyFee: 2_400,
      dealId: id,
    });
    expect(row!.archivedAt).toBeUndefined();

    const { customers } = await owner.query(api.customers.list, {});
    expect(customers).toEqual([
      expect.objectContaining({ name: "SECRET Won Vertical", fromSales: true, dealId: id, archived: false }),
    ]);
  });

  test("a deal with no amount has no monthly fee: not on record, never zero", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t);
    await owner.mutation(api.deals.move, { id, stage: "won", index: 0 });
    expect((await rows(t))[0]!.monthlyFee).toBeUndefined();
  });

  test("the editor's stage change does the same, and winning again adds nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t);
    await owner.mutation(api.deals.update, { id, stage: "won" });
    await owner.mutation(api.deals.move, { id, stage: "won", index: 0 });
    await owner.mutation(api.deals.update, { id, stage: "won", notes: "Signed" });
    expect(await rows(t)).toHaveLength(1);
  });

  test("a deal made at Won is a customer at once", async () => {
    const t = convexTest(schema, modules);
    const { id } = await usDeal(t, { stage: "won" });
    expect(await rows(t)).toEqual([expect.objectContaining({ source: "deals", dealId: id, contractDate: TODAY })]);
  });

  test("an open deal makes no customer", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t, { stage: "lead" });
    await owner.mutation(api.deals.move, { id, stage: "demo", index: 0 });
    await owner.mutation(api.deals.update, { id, stage: "lost" });
    expect(await rows(t)).toEqual([]);
  });
});

describe("a deal moved out of Won", () => {
  test("back to an open stage or to Lost, the row Sales made is archived; won again, it is restored", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t, { stage: "won" });
    const made = (await rows(t))[0]!._id;

    await owner.mutation(api.deals.move, { id, stage: "proposal", index: 0 });
    expect((await rows(t))[0]!.archivedAt).toBe(NOW);
    expect((await owner.query(api.customers.list, {})).customers).toEqual([]);

    await owner.mutation(api.deals.update, { id, stage: "won" });
    const [back, ...none] = await rows(t);
    expect(none).toEqual([]);
    expect(back!._id).toBe(made);
    expect(back!.archivedAt).toBeUndefined();

    await owner.mutation(api.deals.update, { id, stage: "lost" });
    expect((await rows(t))[0]!.archivedAt).toBe(NOW);
  });

  test("a register clinic linked to the deal is never archived by it", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Won Vertical", market: "us", status: "active" }]);
    const { owner, id } = await usDeal(t, { stage: "won" });
    await owner.mutation(api.deals.move, { id, stage: "lost", index: 0 });
    expect(await live(t)).toEqual([expect.objectContaining({ source: "client_register", dealId: id })]);
  });

  test("a deleted deal archives the row Sales made and leaves no link behind", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t, { stage: "won" });
    await owner.mutation(api.deals.remove, { id });
    const [row] = await rows(t);
    expect(row!.archivedAt).toBe(NOW);
    expect(row!.dealId).toBeUndefined();
  });
});

describe("no duplicate with the client register", () => {
  test("a clinic the register already carries is linked, not added again", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "Secret  WON vertical", market: "us", status: "active", monthlyFee: 900 }]);
    const { id } = await usDeal(t, { stage: "won", amount: 2_400 });
    expect(await rows(t)).toEqual([
      // The register's own figures are kept: Sales only adds the link.
      expect.objectContaining({ source: "client_register", dealId: id, monthlyFee: 900 }),
    ]);
  });

  test("a register clinic already linked to another deal keeps that link", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Won Vertical", market: "us", status: "active" }]);
    const first = await usDeal(t, { stage: "won" });
    await usDeal(t, { name: "SECRET WON VERTICAL", stage: "won" });
    expect(await rows(t)).toEqual([expect.objectContaining({ source: "client_register", dealId: first.id })]);
  });

  test("the same name in the other market is another clinic", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Won Vertical", market: "kz", status: "active" }]);
    await usDeal(t, { stage: "won" });
    expect((await live(t)).map((row) => [row.source, row.market])).toEqual([
      ["client_register", "kz"],
      ["deals", "us"],
    ]);
  });

  test("a later register push supersedes the row Sales made, and takes its link, note and next touch", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t, { stage: "won" });
    const made = (await rows(t))[0]!._id;
    await owner.mutation(api.customers.setOwnerFields, { id: made, note: "Kickoff booked", nextTouch: "2026-10-21" });

    await pushRegister(t, [{ name: "SECRET WON VERTICAL", market: "us", status: "active", monthlyFee: 1_000 }]);
    const after = await rows(t);
    expect(after.find((row) => row._id === made)!.archivedAt).toBe(NOW);
    expect(after.filter((row) => row.archivedAt === undefined)).toEqual([
      expect.objectContaining({
        source: "client_register",
        dealId: id,
        note: "Kickoff booked",
        nextTouch: "2026-10-21",
        monthlyFee: 1_000,
      }),
    ]);
    // On the page: one clinic, the register's.
    expect((await owner.query(api.customers.list, {})).customers).toEqual([
      expect.objectContaining({ fromSales: false, dealId: id }),
    ]);
  });

  test("the register's own note and next touch are not overwritten by the carried ones", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Other", market: "us", status: "active" }]);
    // The register drops the clinic for a while (archived), then Sales wins it.
    await pushRegister(t, [{ name: "SECRET Other", market: "us", status: "active" }, { name: "SECRET Won Vertical", market: "us", status: "churned" }]);
    const owner = await signInAsOwner(t);
    const register = (await rows(t)).find((row) => row.name === "SECRET Won Vertical")!;
    await owner.mutation(api.customers.setOwnerFields, { id: register._id, note: "Register note" });
    await pushRegister(t, [{ name: "SECRET Other", market: "us", status: "active" }]);
    const { id } = await usDeal(t, { stage: "won" });
    const made = (await rows(t)).find((row) => row.source === "deals")!;
    await owner.mutation(api.customers.setOwnerFields, { id: made._id, note: "Sales note", nextTouch: "2026-10-21" });

    await pushRegister(t, [{ name: "SECRET Other", market: "us", status: "active" }, { name: "SECRET Won Vertical", market: "us", status: "active" }]);
    expect((await live(t)).find((row) => row.name === "SECRET Won Vertical")).toMatchObject({
      source: "client_register",
      dealId: id,
      note: "Register note",
      nextTouch: "2026-10-21",
    });
  });

  test("a register push never archives or deletes a row Sales made that it does not mention", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Register One", market: "us", status: "active" }]);
    await usDeal(t, { stage: "won" });
    const result = await t.mutation(internal.customers.applyRegister, {
      source: "client_register",
      startedAt: 1,
      rows: [{ name: "SECRET Register One", market: "us", status: "active" }],
    });
    expect(result).toMatchObject({ ok: true, archived: 0 });
    expect((await live(t)).map((row) => row.source).sort()).toEqual(["client_register", "deals"]);
  });
});

describe("deal_update from the owner's agent", () => {
  test("moving a deal made here to won adds it to Customers", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { token } = await ownerWithToken(t, "act");
    await answer(t, token, "deal_update", { id: ids.usDeal, stage: "won" });
    expect((await live(t)).filter((row) => row.source === "deals")).toEqual([
      expect.objectContaining({ dealId: ids.usDeal, name: "Example US Deal", monthlyFee: 1_000, contractDate: TODAY }),
    ]);
  });
});

describe("the Kazakhstan CRM's push", () => {
  test("a deal new at Won is a customer, in tenge, contracted on the day the CRM closed it", async () => {
    const t = convexTest(schema, modules);
    await crmPush(t, [{ externalId: "crm-1", name: "SECRET Almaty Clinic", stage: "Closed Won", amount: 250_000, closedAt: "2026-10-10" }]);
    const deal = (await t.run((ctx) => ctx.db.query("deals").collect()))[0]!;
    expect(await rows(t)).toEqual([
      expect.objectContaining({
        source: "deals",
        market: "kz",
        currency: "KZT",
        monthlyFee: 250_000,
        contractDate: "2026-10-10",
        dealId: deal._id,
      }),
    ]);
  });

  test("a deal the push moves to Won becomes one; pushed again, nothing doubles; moved back, it is archived", async () => {
    const t = convexTest(schema, modules);
    await crmPush(t, [{ externalId: "crm-2", name: "SECRET Astana Clinic", stage: "Новая" }]);
    expect(await rows(t)).toEqual([]);
    await crmPush(t, [{ externalId: "crm-2", name: "SECRET Astana Clinic", stage: "Closed Won", closedAt: "2026-10-12" }]);
    await crmPush(t, [{ externalId: "crm-2", name: "SECRET Astana Clinic", stage: "Closed Won", closedAt: "2026-10-12" }]);
    expect(await live(t)).toEqual([expect.objectContaining({ source: "deals", contractDate: "2026-10-12" })]);
    await crmPush(t, [{ externalId: "crm-2", name: "SECRET Astana Clinic", stage: "Новая" }]);
    expect(await live(t)).toEqual([]);
  });

  test("a clinic the register already carries is linked, not doubled", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Almaty Clinic", market: "kz", status: "active" }]);
    await crmPush(t, [{ externalId: "crm-3", name: "SECRET Almaty Clinic", stage: "Closed Won", closedAt: "2026-10-10" }]);
    const deal = (await t.run((ctx) => ctx.db.query("deals").collect()))[0]!;
    expect(await rows(t)).toEqual([expect.objectContaining({ source: "client_register", dealId: deal._id })]);
  });
});

describe("customers.ofDeal", () => {
  test("says whether a deal is on Customers, and names no clinic", async () => {
    const t = convexTest(schema, modules);
    const { owner, id } = await usDeal(t);
    expect(await owner.query(api.customers.ofDeal, { dealId: id })).toEqual({ onCustomers: false });
    await owner.mutation(api.deals.move, { id, stage: "won", index: 0 });
    expect(await owner.query(api.customers.ofDeal, { dealId: id })).toEqual({ onCustomers: true });
    await owner.mutation(api.deals.move, { id, stage: "lost", index: 0 });
    expect(await owner.query(api.customers.ofDeal, { dealId: id })).toEqual({ onCustomers: false });
  });

  test("an address that holds no deal id is not on Customers, never an error", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.customers.ofDeal, { dealId: "not-a-deal" })).toEqual({ onCustomers: false });
  });

  test("a deal of a company the caller is not on is refused", async () => {
    const t = convexTest(schema, modules);
    const { id } = await usDeal(t, { stage: "won" });
    const kzSales = await signInAsMember(t, "sales", ["kz"]);
    await expect(kzSales.query(api.customers.ofDeal, { dealId: id })).rejects.toThrow("not_allowed");
  });
});

describe("customers.list for a teammate", () => {
  test("a clinic won on another company's board is never sent", async () => {
    const t = convexTest(schema, modules);
    await usDeal(t, { stage: "won" });
    const kz = await signInAsMember(t, "cofounder", ["kz"], undefined, ["customers"]);
    expect((await kz.query(api.customers.list, {})).customers).toEqual([]);
  });
});

describe("migrations:customersFromWonDeals", () => {
  test("applies the rule to deals already at Won, counts only, and a second run changes nothing", async () => {
    const t = convexTest(schema, modules);
    await pushRegister(t, [{ name: "SECRET Linked", market: "kz", status: "active" }]);
    // Deals as they stood before the rule: written straight in, no customer made.
    const insert = (name: string, market: "us" | "kz", stage: string, archivedAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert("deals", {
          source: market === "kz" ? "kz_crm" : "manual",
          externalId: `seed-${name}`,
          market,
          name,
          stage,
          order: 0,
          closedAt: stage === "won" ? Date.UTC(2026, 8, 30) : undefined,
          ...(archivedAt === undefined ? null : { archivedAt }),
        }),
      );
    await insert("SECRET New One", "us", "won");
    await insert("SECRET Linked", "kz", "won");
    await insert("SECRET Open", "us", "demo");
    await insert("SECRET Archived", "us", "won", NOW);

    const first = await t.mutation(internal.migrations.customersFromWonDeals, {});
    expect(first).toEqual({ won: 2, created: 1, linked: 1, unchanged: 0 });
    expect(JSON.stringify(first)).not.toContain("SECRET");
    expect((await live(t)).map((row) => [row.source, row.name, row.contractDate ?? null]).sort()).toEqual([
      ["client_register", "SECRET Linked", null],
      ["deals", "SECRET New One", "2026-09-30"],
    ]);

    expect(await t.mutation(internal.migrations.customersFromWonDeals, {})).toEqual({
      won: 2,
      created: 0,
      linked: 0,
      unchanged: 2,
    });
    expect(await rows(t)).toHaveLength(2);
  });
});
