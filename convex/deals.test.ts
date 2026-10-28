import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { describeCards } from "./pipelineCards.kit";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

// A mirrored deal as a push from the Kazakhstan CRM would have left it. The
// shared suite puts it on the US board, beside the native cards, to test how
// the two kinds sit together; in production the CRM's deals are all "kz".
const seedMirrored = (t: TestBackend, fields: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("deals", {
      source: "kz_crm",
      externalId: `crm-${Math.random()}`,
      market: "us",
      name: "Mirrored Co",
      stage: "lead",
      sourceStage: "Новая",
      order: 0,
      ...fields,
    }),
  );

describeCards({
  table: "deals",
  noun: "deal",
  blankName: "A deal needs a company name.",
  stages: { first: "lead", second: "qualified", third: "demo", closed: "won", foreign: "diligence" },
  mirror: { source: "kz_crm", named: "the Kazakhstan CRM" },
  refs: api.deals,
  boardArgs: { market: "us" },
  seedMirrored,
});

describe("deals: markets", () => {
  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a deal cannot be made by hand in Kazakhstan, whose deals come from the CRM", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.deals.create, { market: "kz", name: "Almaty Dental" }),
    ).rejects.toThrow("Kazakhstan deals come from the Kazakhstan CRM and cannot be added here.");
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
  });

  test("each market has its own board", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    await seedMirrored(t, { market: "kz", name: "Almaty Dental" });
    const us = await owner.query(api.deals.board, { market: "us" });
    const kz = await owner.query(api.deals.board, { market: "kz" });
    expect(us.lead.map((d) => d.name)).toEqual(["Austin Vertical"]);
    expect(kz.lead.map((d) => d.name)).toEqual(["Almaty Dental"]);
    expect(kz.lead[0]?.market).toBe("kz");
  });

  test("the board has every stage, and unmapped, even when empty", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.deals.board, { market: "us" })).toEqual({
      lead: [],
      qualified: [],
      demo: [],
      proposal: [],
      won: [],
      lost: [],
      unmapped: [],
    });
  });
});

// Not in the Phase 4 plan: added for the GTM page (another phase), which needs
// "deals created since the week began" per market. Counts only, never a name.
describe("deals.createdSince", () => {
  const T0 = Date.parse("2026-10-05T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("with no deals, every count is zero for both markets", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.deals.createdSince, { since: 0 })).toEqual({
      us: { native: 0, mirrored: 0 },
      kz: { native: 0, mirrored: 0 },
    });
  });

  test("counts native and mirrored deals per market, created at or after `since`", async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(T0 - DAY);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, { market: "us", name: "Too Early Vertical" });
    await seedMirrored(t, { market: "kz", name: "Too Early Dental" });

    // Exactly at `since` counts.
    vi.setSystemTime(T0);
    await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    vi.setSystemTime(T0 + DAY);
    // A closed deal and one in an unknown stage were still created.
    await owner.mutation(api.deals.create, { market: "us", name: "Dallas Vertical", stage: "won" });
    await seedMirrored(t, { market: "kz", name: "Almaty Dental" });
    await seedMirrored(t, { market: "kz", name: "Astana Dental", stage: "unmapped" });
    await seedMirrored(t, { market: "us", name: "Mirrored US Co" });

    expect(await owner.query(api.deals.createdSince, { since: T0 })).toEqual({
      us: { native: 2, mirrored: 1 },
      kz: { native: 0, mirrored: 2 },
    });
    expect(await owner.query(api.deals.createdSince, { since: T0 + 2 * DAY })).toEqual({
      us: { native: 0, mirrored: 0 },
      kz: { native: 0, mirrored: 0 },
    });
  });

  test("an archived deal is out of this number, as it is out of every other", async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(T0);
    const owner = await signInAsOwner(t);
    await seedMirrored(t, { market: "kz", name: "Almaty Dental" });
    await seedMirrored(t, { market: "kz", name: "Dropped Dental", archivedAt: T0 });
    expect((await owner.query(api.deals.createdSince, { since: T0 })).kz).toEqual({
      native: 0,
      mirrored: 1,
    });
  });

  test("the answer holds counts only: no name, contact or next step leaves the table", async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(T0);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, {
      market: "us",
      name: "Zzyzx Vertical",
      contact: "Quentin Zzyzx",
      nextStep: "Call Quentin",
    });
    const answer = await owner.query(api.deals.createdSince, { since: 0 });
    // toEqual is exact about keys: nothing beyond the four counts.
    expect(answer).toEqual({ us: { native: 1, mirrored: 0 }, kz: { native: 0, mirrored: 0 } });
    expect(JSON.stringify(answer)).not.toMatch(/Zzyzx|Quentin/);
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.deals.createdSince, { since: 0 })).rejects.toThrow("not_allowed");
  });
});
