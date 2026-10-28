import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NO_LINKS_OR_CONTACTS } from "./lib/dealIntel";
import { MAX_IMPORT_ROWS } from "./lib/limits";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAsOwner,
  signInAsSales,
  type TestBackend,
} from "./test.setup";

// A US deal's sales intelligence (convex/dealIntel.ts): read on the deal's
// page and in the table's columns, edited by whoever has Sales on Startup, and
// imported from research by `pnpm import:intel`. Only a native US deal has
// it: never a Kazakhstan or mirrored deal, never an investor.

const AT = Date.parse("2026-10-15T09:00:00Z");
const ARTIFACT = "https://claude.ai/artifact/made-up-0001";
const NO_INTEL_HERE = "Only a US deal made here has sales intelligence.";

const FULL = {
  summary: "Made-up: a 59-physician specialty group.",
  ownership: "Physician-owned",
  ehr: "athenahealth",
  pm: "athenaCollector",
  billingModel: "outsourced",
  rcmVendor: "Example RCM Co",
  specialties: ["Spine", "Sports medicine"],
  ancillaries: ["MRI", "Physical therapy"],
  workersComp: "Made-up: about a fifth of visits.",
  competitors: [{ name: "Example RCM Co", note: "The incumbent" }],
  signals: [
    { date: "2026-03", kind: "hiring", text: "Hiring a billing manager", source: "Made-up job board" },
    { date: "2026-08-01", kind: "growth", text: "Opened a seventh site", source: "Made-up paper" },
  ],
  people: [{ name: "Dr. Casey Placeholder", role: "Managing partner" }],
  painPoints: ["Prior authorizations"],
  talkingPoints: ["Denials on MRI"],
  risks: ["Locked into a vendor until 2027"],
  angle: "Made-up angle: lead with prior authorizations.",
  nextBestAction: "Ask for twenty minutes with the billing lead",
  fit: { score: 82, reasons: ["Large group"] },
  sources: [{ title: "Made-up market scan", url: ARTIFACT }],
  researchedAt: "2026-10-01",
};

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const deal = await owner.mutation(api.deals.create, { market: "us", name: "Example Vertical" });
  const kzDeal = await t.run(
    (ctx) =>
      ctx.db.insert("deals", {
        source: "kz_crm",
        externalId: "crm-1",
        market: "kz",
        name: "Example Vertical",
        stage: "lead",
        order: 0,
      }) as Promise<Id<"deals">>,
  );
  return { t, owner, deal, kzDeal };
}

const rowsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("dealIntel").collect());

describe("dealIntel.update and get", () => {
  test("the owner sets every field; get sends it, null or [] where unset", async () => {
    const { owner, deal } = await world();
    expect(await owner.query(api.dealIntel.get, { dealId: deal })).toBeNull();
    await owner.mutation(api.dealIntel.update, { dealId: deal, ...FULL });
    expect(await owner.query(api.dealIntel.get, { dealId: deal })).toEqual({
      ...FULL,
      competitors: [{ name: "Example RCM Co", note: "The incumbent" }],
      people: [{ name: "Dr. Casey Placeholder", role: "Managing partner" }],
      updatedAt: AT,
    });
  });

  test("leaving a field out keeps it, null clears it, and the deal's activity is untouched", async () => {
    const { t, owner, deal } = await world();
    await owner.mutation(api.dealIntel.update, { dealId: deal, ...FULL });
    const before = await t.run((ctx) => ctx.db.get(deal));
    vi.setSystemTime(AT + 60_000);
    await owner.mutation(api.dealIntel.update, { dealId: deal, summary: null, signals: [], ehr: "Epic" });
    const intel = (await owner.query(api.dealIntel.get, { dealId: deal }))!;
    expect(intel).toMatchObject({ summary: null, signals: [], ehr: "Epic", angle: FULL.angle, updatedAt: AT + 60_000 });
    expect((await t.run((ctx) => ctx.db.get(deal)))!.lastActivityAt).toBe(before!.lastActivityAt);
    expect(await rowsOf(t)).toHaveLength(1);
  });

  test("a sales teammate on Startup may edit any field", async () => {
    const { t, deal } = await world();
    const sales = await signInAsSales(t, ["us"]);
    await sales.mutation(api.dealIntel.update, { dealId: deal, ...FULL });
    expect((await sales.query(api.dealIntel.get, { dealId: deal }))!.fit).toEqual(FULL.fit);
  });

  test("a refusal is a fixed sentence and writes nothing", async () => {
    const { t, owner, deal } = await world();
    await expect(
      owner.mutation(api.dealIntel.update, { dealId: deal, summary: "mail SECRET@example.test" }),
    ).rejects.toThrow(NO_LINKS_OR_CONTACTS);
    await expect(
      owner.mutation(api.dealIntel.update, { dealId: deal, ehr: "Epic", billingModel: "SECRET" }),
    ).rejects.toThrow("A billing model is in-house, outsourced or hybrid.");
    await expect(
      owner.mutation(api.dealIntel.update, {
        dealId: deal,
        sources: [{ title: "Made-up", url: "https://example.test/SECRET" }],
      }),
    ).rejects.toThrow("A source links to a claude.ai artifact");
    expect(await rowsOf(t)).toEqual([]);
  });

  test("a Kazakhstan, mirrored or archived deal takes none", async () => {
    const { t, owner, deal, kzDeal } = await world();
    await expect(owner.mutation(api.dealIntel.update, { dealId: kzDeal, ehr: "Epic" })).rejects.toThrow(
      NO_INTEL_HERE,
    );
    const mirroredUs = await t.run(
      (ctx) =>
        ctx.db.insert("deals", {
          source: "kz_crm",
          externalId: "crm-2",
          market: "us",
          name: "Mirrored Co",
          stage: "lead",
          order: 1,
        }) as Promise<Id<"deals">>,
    );
    await expect(
      owner.mutation(api.dealIntel.update, { dealId: mirroredUs, ehr: "Epic" }),
    ).rejects.toThrow(NO_INTEL_HERE);
    await owner.mutation(api.deals.archive, { id: deal });
    await expect(owner.mutation(api.dealIntel.update, { dealId: deal, ehr: "Epic" })).rejects.toThrow(
      "That deal is no longer on the board.",
    );
    expect(await rowsOf(t)).toEqual([]);
  });

  test("get answers null for an id that is not a deal, a Kazakhstan deal or a deal gone", async () => {
    const { t, owner, deal, kzDeal } = await world();
    await t.run((ctx) => ctx.db.insert("dealIntel", { dealId: kzDeal, ehr: "SECRET", updatedAt: 1 }));
    expect(await owner.query(api.dealIntel.get, { dealId: "not-an-id" })).toBeNull();
    expect(await owner.query(api.dealIntel.get, { dealId: kzDeal })).toBeNull();
    await owner.mutation(api.dealIntel.update, { dealId: deal, ehr: "Epic" });
    await owner.mutation(api.deals.remove, { id: deal });
    expect(await owner.query(api.dealIntel.get, { dealId: deal })).toBeNull();
  });

  test("deleting a deal deletes its intelligence", async () => {
    const { t, owner, deal } = await world();
    await owner.mutation(api.dealIntel.update, { dealId: deal, ...FULL });
    await owner.mutation(api.deals.remove, { id: deal });
    expect(await rowsOf(t)).toEqual([]);
  });
});

describe("dealIntel.list", () => {
  test("what the table's columns need, for the US deals on the board only", async () => {
    const { t, owner, deal, kzDeal } = await world();
    const other = await owner.mutation(api.deals.create, { market: "us", name: "Archived Vertical" });
    await owner.mutation(api.dealIntel.update, { dealId: deal, ...FULL });
    await owner.mutation(api.dealIntel.update, { dealId: other, ehr: "Epic" });
    await owner.mutation(api.deals.archive, { id: other });
    // A row that should not exist is still never sent.
    await t.run((ctx) => ctx.db.insert("dealIntel", { dealId: kzDeal, ehr: "SECRET", updatedAt: 1 }));
    expect(await owner.query(api.dealIntel.list, {})).toEqual([
      {
        dealId: deal,
        fit: 82,
        ehr: "athenahealth",
        billingModel: "outsourced",
        ownership: "Physician-owned",
        signals: 2,
        newestSignal: "2026-08-01",
        competitors: 1,
      },
    ]);
  });
});

describe("dealIntel.importIntel", () => {
  const run = (t: TestBackend, rows: Record<string, unknown>[]) =>
    t.mutation(internal.dealIntel.importIntel, { rows: rows as never });

  test("matches US deals made here by name, whatever the capitals, and upserts", async () => {
    const { t, owner, deal } = await world();
    const second = await owner.mutation(api.deals.create, { market: "us", name: "Boise Bone" });
    await owner.mutation(api.dealIntel.update, { dealId: second, angle: "An old angle", ehr: "Epic" });

    expect(
      await run(t, [
        { dealName: "  example   VERTICAL ", ...FULL },
        { dealName: "boise bone", ehr: "athenahealth" },
        { dealName: "Nowhere Clinic", ehr: "Epic" },
      ]),
    ).toEqual({ matched: 2, unmatched: 1, updated: 1, unmatchedRows: [3] });

    expect((await owner.query(api.dealIntel.get, { dealId: deal }))!.fit).toEqual(FULL.fit);
    // An import replaces a deal's intelligence whole.
    expect(await owner.query(api.dealIntel.get, { dealId: second })).toMatchObject({
      ehr: "athenahealth",
      angle: null,
    });
    expect(await rowsOf(t)).toHaveLength(2);
  });

  test("never a Kazakhstan or mirrored deal of the same name; an archived one is matched", async () => {
    const { t, owner, deal } = await world();
    await t.run((ctx) =>
      ctx.db.insert("deals", {
        source: "kz_crm",
        externalId: "crm-3",
        market: "us",
        name: "Mirrored Co",
        stage: "lead",
        order: 3,
      }),
    );
    await owner.mutation(api.deals.archive, { id: deal });
    expect(
      await run(t, [
        { dealName: "Mirrored Co", ehr: "Epic" },
        { dealName: "Example Vertical", ehr: "Epic" },
      ]),
    ).toEqual({ matched: 1, unmatched: 1, updated: 0, unmatchedRows: [1] });
    const rows = await rowsOf(t);
    expect(rows.map((row) => row.dealId)).toEqual([deal]);
  });

  test("a refusal names the row and writes nothing; too many rows are refused", async () => {
    const { t } = await world();
    await expect(
      run(t, [{ dealName: "Example Vertical", ehr: "Epic" }, { dealName: "SECRET Co", risks: ["SECRET www.example.test"] }]),
    ).rejects.toThrow(`Row 2: ${NO_LINKS_OR_CONTACTS}`);
    expect(await rowsOf(t)).toEqual([]);
    await expect(
      run(t, Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ dealName: `Made-up ${i}` }))),
    ).rejects.toThrow(`At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
  });
});
