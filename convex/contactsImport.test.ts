import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BOT_WORDS } from "./lib/botRules";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

// The two one-off migrations that fill the Contacts book: people read out of
// the deals' and investors' free-text `contact`, and the contacts area given
// to named bots. Every name, firm, clinic and address here is made up.

const NOW = Date.UTC(2026, 9, 27, 6);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Record = { name: string; contact?: string; archivedAt?: number };

const deal = (t: TestBackend, market: "us" | "kz", row: Record) =>
  t.run((ctx) =>
    ctx.db.insert("deals", {
      source: "manual",
      externalId: `deal-${row.name}`,
      stage: "lead",
      order: 0,
      market,
      ...row,
    }),
  );
const investor = (t: TestBackend, row: Record) =>
  t.run((ctx) =>
    ctx.db.insert("investors", {
      source: "visible",
      externalId: `inv-${row.name}`,
      stage: "contacted",
      order: 0,
      ...row,
    }),
  );
const contacts = (t: TestBackend) => t.run((ctx) => ctx.db.query("contacts").collect());
const run = (t: TestBackend, args: { batch?: number } = {}) =>
  t.mutation(internal.migrations.contactsFromRecords, args);

describe("migrations:contactsFromRecords", () => {
  test("reads each record's contact into the book, linked to it, in the record's company and category", async () => {
    const t = convexTest(schema, modules);
    const usDeal = await deal(t, "us", { name: "Example Vertical Group", contact: "Jane Example, Practice Manager" });
    const kzDeal = await deal(t, "kz", { name: "Example Clinic Almaty", contact: "Aigerim Sample — Chief physician" });
    const fund = await investor(t, { name: "Example Capital", contact: "Dana Sample (Partner)" });

    expect(await run(t)).toEqual({ read: 3, created: 3, linked: 3, skipped: 0, more: false });

    const rows = await contacts(t);
    const byName = (name: string) => rows.find((row) => row.name === name);
    expect(byName("Jane Example")).toMatchObject({
      company: "us",
      category: "customer",
      org: "Example Vertical Group",
      title: "Practice Manager",
      emails: [],
      linkedRecords: [{ type: "deal", id: usDeal }],
      interactionCount: 0,
      normalizedName: "jane example",
    });
    expect(byName("Aigerim Sample")).toMatchObject({
      company: "kz",
      category: "kz_clinic",
      org: "Example Clinic Almaty",
      title: "Chief physician",
      linkedRecords: [{ type: "deal", id: kzDeal }],
    });
    expect(byName("Dana Sample")).toMatchObject({
      company: "us",
      category: "investor",
      org: "Example Capital",
      title: "Partner",
      linkedRecords: [{ type: "investor", id: fund }],
    });
    // The records' own text is left as it was.
    const kept = await t.run(async (ctx) => (await ctx.db.get(usDeal))?.contact);
    expect(kept).toBe("Jane Example, Practice Manager");
  });

  test("a second run changes nothing: every record is skipped", async () => {
    const t = convexTest(schema, modules);
    await deal(t, "us", { name: "Example Vertical Group", contact: "Jane Example, Practice Manager" });
    await investor(t, { name: "Example Capital", contact: "Dana Sample" });
    await run(t);
    const before = await contacts(t);
    expect(await run(t)).toEqual({ read: 2, created: 0, linked: 0, skipped: 2, more: false });
    expect(await contacts(t)).toEqual(before);
  });

  test("archived records, records with no contact, and text naming nobody are skipped; no address is kept", async () => {
    const t = convexTest(schema, modules);
    await deal(t, "us", { name: "Archived Vertical", contact: "Jane Example", archivedAt: NOW - 1 });
    await deal(t, "us", { name: "No Contact Vertical" });
    await investor(t, { name: "Address Only Fund", contact: "secret.person@fund.test" });
    await investor(t, { name: "Phone Fund", contact: "Dana Sample, +1 555 010 0199" });

    expect(await run(t)).toEqual({ read: 4, created: 1, linked: 1, skipped: 3, more: false });
    const rows = await contacts(t);
    expect(rows.map((row) => row.name)).toEqual(["Dana Sample"]);
    expect(rows[0]?.title).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("555");
    expect(JSON.stringify(rows)).not.toContain("@");
  });

  test("a contact already in the book by name and organisation is linked and keeps what a person typed", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const made = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "Dr. Jane Example",
      org: "Example Capital",
      emails: ["jane@fund.test"],
      owner: "Founder",
      notes: "Met at a made-up dinner.",
      category: "advisor",
    });
    const fund = await investor(t, { name: "Example Capital", contact: "Jane Example, Partner" });

    expect(await run(t)).toEqual({ read: 1, created: 0, linked: 1, skipped: 0, more: false });
    const [row, ...rest] = await contacts(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      _id: made.id,
      name: "Dr. Jane Example",
      emails: ["jane@fund.test"],
      owner: "Founder",
      notes: "Met at a made-up dinner.",
      category: "advisor",
      title: "Partner",
      linkedRecords: [{ type: "investor", id: fund }],
    });
  });

  test("the same person at the same organisation on a deal and an investor is one contact with both links", async () => {
    const t = convexTest(schema, modules);
    const dealId = await deal(t, "us", { name: "Example Health", contact: "Jane Example" });
    const fundId = await investor(t, { name: "Example Health", contact: "Jane Example (Board member)" });
    expect(await run(t)).toEqual({ read: 2, created: 1, linked: 2, skipped: 0, more: false });
    const [row] = await contacts(t);
    expect(row?.linkedRecords).toEqual([
      { type: "deal", id: dealId },
      { type: "investor", id: fundId },
    ]);
    expect(row?.title).toBe("Board member");
  });

  test("two contacts with that name at that organisation are left alone, and a different organisation is a new contact", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i += 1) {
        await ctx.db.insert("contacts", {
          name: "Jane Example",
          emails: [],
          org: "Example Capital",
          company: "us",
          category: "investor",
          linkedRecords: [],
          canIntroTo: [],
          interactionCount: 0,
          normalizedName: "jane example",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    await investor(t, { name: "Example Capital", contact: "Jane Example" });
    await investor(t, { name: "Other Capital", contact: "Jane Example" });
    expect(await run(t)).toEqual({ read: 2, created: 1, linked: 1, skipped: 1, more: false });
    const linked = (await contacts(t)).filter((row) => row.linkedRecords.length > 0);
    expect(linked.map((row) => row.org)).toEqual(["Other Capital"]);
  });

  test("a full book takes no more", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2_000; i += 1) {
        await ctx.db.insert("contacts", {
          name: `Person ${i}`,
          emails: [],
          company: "us",
          category: "other",
          linkedRecords: [],
          canIntroTo: [],
          interactionCount: 0,
          normalizedName: `person ${i}`,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    await deal(t, "us", { name: "Example Vertical Group", contact: "Jane Example" });
    await deal(t, "kz", { name: "Example Clinic Almaty", contact: "Aigerim Sample" });
    expect(await run(t)).toEqual({ read: 2, created: 1, linked: 1, skipped: 1, more: false });
    expect((await contacts(t)).filter((row) => row.company === "kz")).toHaveLength(1);
  });

  test("a long list goes in batches, each scheduling the next, and ends with every record read", async () => {
    // Every timer, not only the clock: the next batch must run here.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    for (let i = 0; i < 3; i += 1) await deal(t, "us", { name: `Example Vertical ${i}`, contact: `Person ${i}` });
    for (let i = 0; i < 2; i += 1) await investor(t, { name: `Example Fund ${i}`, contact: `Partner ${i}` });

    expect(await run(t, { batch: 2 })).toEqual({ read: 2, created: 2, linked: 2, skipped: 0, more: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await contacts(t)).toHaveLength(5);
    expect(await run(t, { batch: 2 })).toMatchObject({ created: 0, linked: 0, more: true });
  });

  test("a batch size out of range is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(run(t, { batch: 0 })).rejects.toThrow("A batch is 1 to 500 records.");
    await expect(run(t, { batch: 501 })).rejects.toThrow("A batch is 1 to 500 records.");
  });
});

// ── migrations:grantContactsToBots ───────────────────────────────────────────

type BotSeed = { botId: string; enabled?: boolean; permissions?: { area: "board" | "contacts"; level: "read" | "write" }[] };

async function bots(t: TestBackend, seeds: BotSeed[], userId?: Id<"users">) {
  const owner = userId ?? (await t.run((ctx) => ctx.db.insert("users", { email: OWNER })));
  await t.run(async (ctx) => {
    for (const seed of seeds) {
      await ctx.db.insert("bots", {
        userId: owner,
        botId: seed.botId,
        name: `Made-up ${seed.botId}`,
        role: "Made-up",
        clients: "any",
        permissions: seed.permissions ?? [{ area: "board", level: "read" }],
        limits: { proposalsPerDay: 1, changesPer10Min: 1, callsPer10Min: 1 },
        enabled: seed.enabled ?? true,
        suggested: true,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
  return owner;
}
const permissionsOf = (t: TestBackend, botId: string) =>
  t.run(async (ctx) => (await ctx.db.query("bots").withIndex("by_botId", (q) => q.eq("botId", botId)).first())?.permissions);
const grant = (t: TestBackend, args: { bots: string[]; level: "read" | "write" }) =>
  t.mutation(internal.migrations.grantContactsToBots, args);

describe("migrations:grantContactsToBots", () => {
  test("gives the owner's named bots the contacts area at that level, and leaves the rest", async () => {
    const t = convexTest(schema, modules);
    await bots(t, [{ botId: "growth" }, { botId: "fundraising" }, { botId: "linkedin" }]);
    expect(await grant(t, { bots: ["growth", "fundraising"], level: "write" })).toEqual({
      granted: 2,
      unchanged: 0,
      off: 0,
      notFound: 0,
    });
    expect(await permissionsOf(t, "growth")).toEqual([
      { area: "contacts", level: "write" },
      { area: "board", level: "read" },
    ]);
    expect(await permissionsOf(t, "linkedin")).toEqual([{ area: "board", level: "read" }]);
  });

  test("a second run changes nothing, and write is never lowered to read", async () => {
    const t = convexTest(schema, modules);
    await bots(t, [{ botId: "growth", permissions: [{ area: "contacts", level: "write" }] }, { botId: "partnerships" }]);
    expect(await grant(t, { bots: ["growth", "partnerships"], level: "write" })).toMatchObject({ granted: 1, unchanged: 1 });
    expect(await grant(t, { bots: ["growth", "partnerships"], level: "write" })).toMatchObject({ granted: 0, unchanged: 2 });
    expect(await grant(t, { bots: ["growth"], level: "read" })).toMatchObject({ granted: 0, unchanged: 1 });
    expect(await permissionsOf(t, "growth")).toEqual([{ area: "contacts", level: "write" }]);
  });

  test("an unknown bot, another user's bot and a bot switched off are counted, not changed", async () => {
    const t = convexTest(schema, modules);
    const stranger = await t.run((ctx) => ctx.db.insert("users", { email: "someone@example.test" }));
    await bots(t, [{ botId: "outsider" }], stranger);
    await bots(t, [{ botId: "sleepy", enabled: false }]);
    expect(await grant(t, { bots: ["outsider", "sleepy", "no_such_bot"], level: "write" })).toEqual({
      granted: 0,
      unchanged: 0,
      off: 1,
      notFound: 2,
    });
    expect(await permissionsOf(t, "outsider")).toEqual([{ area: "board", level: "read" }]);
    expect(await permissionsOf(t, "sleepy")).toEqual([{ area: "board", level: "read" }]);
  });

  test("a name that is not a bot's id, or too many names, is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(grant(t, { bots: ["Not A Bot!"], level: "write" })).rejects.toThrow(BOT_WORDS.gone);
    const many = Array.from({ length: 51 }, (_, i) => `bot_${i}`);
    await expect(grant(t, { bots: many, level: "write" })).rejects.toThrow("At most 50 bots at once.");
  });
});
