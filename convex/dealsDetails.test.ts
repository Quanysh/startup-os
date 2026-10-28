import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

// A US deal's details (priority, region, size, sources), and archiving a deal
// made here. The table on /sales is built on both; the rules are proved here.

const seedMirrored = (t: TestBackend, fields: Record<string, unknown> = {}) =>
  t.run(
    (ctx) =>
      ctx.db.insert("deals", {
        source: "kz_crm",
        externalId: `crm-${Math.random()}`,
        market: "kz",
        name: "Mirrored Co",
        stage: "lead",
        sourceStage: "Новая",
        order: 0,
        ...fields,
      }) as Promise<Id<"deals">>,
  );

const DETAIL_KEYS = ["priority", "region", "physicians", "locations", "sources"];
const NO_DETAILS = { priority: null, region: null, physicians: null, locations: null, sources: [] };
const NO_CONTACT =
  "Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.";
const MIRRORED =
  "This deal is mirrored from the Kazakhstan CRM. Change it there: here you can edit only its next step and notes.";

describe("deals: details", () => {
  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a deal made here carries its details on the board, none until given", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    const [card] = (await owner.query(api.deals.board, { market: "us" })).lead;
    expect(card).toMatchObject(NO_DETAILS);
  });

  test("update sets, cleans and clears them, and none of it counts as activity", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    const before = await t.run((ctx) => ctx.db.get(id));
    await owner.mutation(api.deals.update, {
      id,
      priority: "high",
      region: " TX ",
      physicians: 59,
      locations: 29,
      sources: ["Made-up market scan", " ", "Sample list"],
    });
    const [card] = (await owner.query(api.deals.board, { market: "us" })).lead;
    expect(card).toMatchObject({
      priority: "high",
      region: "TX",
      physicians: 59,
      locations: 29,
      sources: ["Made-up market scan", "Sample list"],
      lastActivityAt: before!.lastActivityAt,
    });

    await owner.mutation(api.deals.update, { id, priority: null, sources: null, region: null });
    const [cleared] = (await owner.query(api.deals.board, { market: "us" })).lead;
    expect(cleared).toMatchObject({ priority: null, region: null, sources: [], physicians: 59 });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored).not.toHaveProperty("priority");
    expect(stored).not.toHaveProperty("sources");
  });

  test("a refused detail writes nothing, not even the other fields of the same save", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    await expect(
      owner.mutation(api.deals.update, { id, notes: "Kept?", physicians: 2.5 }),
    ).rejects.toThrow("The number of physicians must be a whole number the OS can store.");
    await expect(owner.mutation(api.deals.update, { id, region: "jo@example.test" })).rejects.toThrow(
      NO_CONTACT,
    );
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.notes).toBeUndefined();
    expect(stored).not.toHaveProperty("region");
  });

  test("a mirrored deal is given none: setting one is refused, and its card has no such fields", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await seedMirrored(t, { name: "Almaty Dental" });
    for (const edit of [
      { priority: "low" as const },
      { region: "KZ" },
      { physicians: 3 },
      { locations: 1 },
      { sources: ["A made-up scan"] },
      { priority: null },
    ]) {
      await expect(owner.mutation(api.deals.update, { id, ...edit })).rejects.toThrow(MIRRORED);
    }
    const [card] = (await owner.query(api.deals.board, { market: "kz" })).lead;
    expect(Object.keys(card!).filter((key) => DETAIL_KEYS.includes(key))).toEqual([]);
    // Its next step and notes are still the owner's to write.
    await owner.mutation(api.deals.update, { id, nextStep: "Call back" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.nextStep).toBe("Call back");
  });

  test("nor does a deal on Kazakhstan's board that was somehow made by hand", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await seedMirrored(t, { source: "manual", externalId: "x" });
    await expect(owner.mutation(api.deals.update, { id, priority: "high" })).rejects.toThrow(
      "Only a US deal made here has a priority, region, size and sources.",
    );
    const [card] = (await owner.query(api.deals.board, { market: "kz" })).lead;
    expect(Object.keys(card!).filter((key) => DETAIL_KEYS.includes(key))).toEqual([]);
  });

  test("the Kazakhstan board's cards keep exactly the fields they had", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seedMirrored(t, { name: "Almaty Dental" });
    const [card] = (await owner.query(api.deals.board, { market: "kz" })).lead;
    expect(Object.keys(card!).sort()).toEqual(
      [
        "id",
        "mirrored",
        "source",
        "name",
        "contact",
        "stage",
        "sourceStage",
        "amount",
        "lastActivityAt",
        "closedAt",
        "nextStep",
        "notes",
        "market",
      ].sort(),
    );
  });
});

describe("deals: archive and restore", () => {
  const AT = Date.parse("2026-10-15T09:00:00Z");

  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
    vi.useFakeTimers();
    vi.setSystemTime(AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("an archived deal leaves the board, keeps what it holds, and is listed with the archived", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    const b = await owner.mutation(api.deals.create, {
      market: "us",
      name: "Boise Vertical",
      notes: "Research says yes",
    });
    await owner.mutation(api.deals.update, { id: b, priority: "low" });
    await owner.mutation(api.deals.archive, { id: b });

    const board = await owner.query(api.deals.board, { market: "us" });
    expect(board.lead.map((d) => d.name)).toEqual(["Austin Vertical"]);
    const archived = await owner.query(api.deals.archived, { market: "us" });
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: b,
      name: "Boise Vertical",
      stage: "lead",
      notes: "Research says yes",
      priority: "low",
      archivedAt: AT,
    });
    // Nothing on the board answers for it now.
    await expect(owner.mutation(api.deals.update, { id: b, notes: "x" })).rejects.toThrow(
      "That deal is no longer on the board.",
    );
    expect(await t.run((ctx) => ctx.db.get(a))).not.toHaveProperty("archivedAt");
  });

  test("a restored deal is back on the board at the bottom of its stage", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    await owner.mutation(api.deals.create, { market: "us", name: "Boise Vertical" });
    await owner.mutation(api.deals.archive, { id: a });
    await owner.mutation(api.deals.create, { market: "us", name: "Cleveland Vertical" });
    await owner.mutation(api.deals.restore, { id: a });

    const lead = (await owner.query(api.deals.board, { market: "us" })).lead;
    expect(lead.map((d) => d.name)).toEqual(["Boise Vertical", "Cleveland Vertical", "Austin Vertical"]);
    expect(await owner.query(api.deals.archived, { market: "us" })).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(a))).not.toHaveProperty("archivedAt");
  });

  test("archive and restore say so when there is nothing to do", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    await expect(owner.mutation(api.deals.restore, { id: a })).rejects.toThrow(
      "That deal is not archived.",
    );
    await owner.mutation(api.deals.archive, { id: a });
    await expect(owner.mutation(api.deals.archive, { id: a })).rejects.toThrow(
      "That deal is no longer on the board.",
    );
  });

  test("a mirrored deal is archived only by its source", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await seedMirrored(t);
    await expect(owner.mutation(api.deals.archive, { id })).rejects.toThrow(MIRRORED);
    const gone = await seedMirrored(t, { archivedAt: 5 });
    await expect(owner.mutation(api.deals.restore, { id: gone })).rejects.toThrow(MIRRORED);
    // The archived list holds deals made here, so a push's archive is not in it.
    expect(await owner.query(api.deals.archived, { market: "kz" })).toEqual([]);
  });

  test("the archived are listed newest first", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    const b = await owner.mutation(api.deals.create, {
      market: "us",
      name: "Boise Vertical",
      stage: "won",
    });
    await owner.mutation(api.deals.archive, { id: a });
    vi.setSystemTime(AT + 60_000);
    await owner.mutation(api.deals.archive, { id: b });
    const names = (await owner.query(api.deals.archived, { market: "us" })).map((d) => d.name);
    expect(names).toEqual(["Boise Vertical", "Austin Vertical"]);
  });
});
