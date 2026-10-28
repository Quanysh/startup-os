import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules, type TestBackend } from "./test.setup";

// Long enough to count as real secrets (see MIN_INGEST_TOKEN_LENGTH).
const VISIBLE = "test-visible-token-0123456789-abcdefghij";
const CRM = "test-kz-crm-token-0123456789-abcdefghijk";
const WORKBOOK = "test-workbook-token-0123456789-abcdefgh";

const NOW = new Date("2026-10-12T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("INGEST_TOKEN_VISIBLE", VISIBLE);
  vi.stubEnv("INGEST_TOKEN_KZ_CRM", CRM);
  vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Row = Record<string, unknown>;

const investor = (id: string, extra: Row = {}): Row => ({
  externalId: id,
  name: `Fund ${id}`,
  stage: "Contacted",
  ...extra,
});
const deal = (id: string, extra: Row = {}): Row => ({
  externalId: id,
  name: `Clinic ${id}`,
  stage: "Переговоры",
  ...extra,
});

const head = (source: string) => ({
  version: 1,
  source,
  batchId: `${source}-2026-10-12`,
  observedAt: "2026-10-12T11:59:00Z",
});
const investors = (rows: Row[], extra: Row = {}) => ({ ...head("visible"), investors: rows, ...extra });
const deals = (rows: Row[], extra: Row = {}) => ({ ...head("kz_crm"), deals: rows, ...extra });

function post(t: TestBackend, body: unknown, token: string) {
  return t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const dealRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("deals").collect());
const investorRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("investors").collect());
const investorById = async (t: TestBackend, externalId: string) =>
  (await investorRows(t)).find((row) => row.externalId === externalId);
const logged = async (t: TestBackend) =>
  JSON.stringify(
    await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    })),
  );

describe("POST /ingest/v1: investors and deals", () => {
  test("a push of investors stores them, mirrored, with the stage mapped", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      investors([
        investor("a", {
          contact: "Dana Lee",
          stage: "Reached out",
          amount: 250_000,
          currency: "USD",
          lastActivityAt: "2026-10-09",
        }),
      ]),
      VISIBLE,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      archived: 0,
    });
    const rows = await investorRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "visible",
      externalId: "a",
      name: "Fund a",
      contact: "Dana Lee",
      stage: "contacted",
      sourceStage: "Reached out",
      amount: 250_000,
      lastActivityAt: Date.UTC(2026, 9, 9),
      order: 0,
    });
  });

  test("deals from the Kazakhstan CRM land on the Kazakhstan board, whatever the push says", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t, deals([deal("1"), deal("2")]), CRM)).status).toBe(200);
    const rows = await dealRows(t);
    expect(rows.map((r) => [r.market, r.source, r.stage, r.order])).toEqual([
      ["kz", "kz_crm", "qualified", 0],
      ["kz", "kz_crm", "qualified", 1],
    ]);
    // There is no field to say otherwise.
    expect((await post(t, deals([deal("3", { market: "us" })]), CRM)).status).toBe(422);
  });

  test("replaying the same push changes nothing", async () => {
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    const before = await investorRows(t);
    const replay = await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    expect(await replay.json()).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 2,
      archived: 0,
    });
    expect(await investorRows(t)).toEqual(before);
  });

  test("the run log counts what the push did", async () => {
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    await post(t, investors([investor("a", { stage: "Meeting" })], { mode: "replace" }), VISIBLE);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs.map(({ status, inserted, updated, unchanged, archived }) => ({
      status,
      inserted,
      updated,
      unchanged,
      archived,
    }))).toEqual([
      { status: "ok", inserted: 2, updated: 0, unchanged: 0, archived: 0 },
      { status: "ok", inserted: 0, updated: 1, unchanged: 0, archived: 1 },
    ]);
  });

  test("a push never touches the owner's next step or notes", async () => {
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a")]), VISIBLE);
    const { _id } = (await investorById(t, "a"))!;
    await t.run((ctx) => ctx.db.patch(_id, { nextStep: "Send the deck", notes: "Warm intro" }));

    const response = await post(
      t,
      investors([investor("a", { name: "Renamed Fund", stage: "Meeting" })]),
      VISIBLE,
    );
    expect(await response.json()).toMatchObject({ updated: 1 });
    expect(await investorById(t, "a")).toMatchObject({
      name: "Renamed Fund",
      stage: "meeting",
      nextStep: "Send the deck",
      notes: "Warm intro",
    });
  });

  test("a stage name the OS does not know is accepted and stored as unmapped", async () => {
    // Refusing it would freeze the whole board on one renamed CRM stage.
    const t = convexTest(schema, modules);
    expect((await post(t, deals([deal("1", { stage: "Ждём бюджет" })]), CRM)).status).toBe(200);
    expect(await dealRows(t)).toMatchObject([{ stage: "unmapped", sourceStage: "Ждём бюджет" }]);
  });

  test("replace archives the rows the push does not name and reports how many", async () => {
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    const response = await post(t, investors([investor("a")], { mode: "replace" }), VISIBLE);
    expect(await response.json()).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 1,
      archived: 1,
    });
    expect((await investorById(t, "b"))?.archivedAt).toBe(NOW.getTime());
    expect((await investorById(t, "a"))?.archivedAt).toBeUndefined();
  });

  test("without a mode a push is an upsert and archives nothing", async () => {
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    const response = await post(t, investors([investor("a")]), VISIBLE);
    expect(await response.json()).toMatchObject({ unchanged: 1, archived: 0 });
    expect((await investorById(t, "b"))?.archivedAt).toBeUndefined();
  });

  test("a replace with an empty list is refused and archives nothing", async () => {
    // An empty read is far more likely a failed read than an empty pipeline.
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a"), investor("b")]), VISIBLE);
    const response = await post(t, { ...head("visible"), mode: "replace", investors: [] }, VISIBLE);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { issues: unknown[] }).issues).toEqual([
      {
        path: "investors",
        message: "An empty list is a failed read, not an empty pipeline. Leave the field out.",
      },
    ]);
    expect((await investorRows(t)).filter((r) => r.archivedAt !== undefined)).toEqual([]);
  });

  test("the write itself refuses an empty replace, whoever calls it", async () => {
    // The endpoint's schema is one guard; this is the one a future connector
    // calling the write directly would meet.
    const t = convexTest(schema, modules);
    await post(t, investors([investor("a")]), VISIBLE);
    await expect(
      t.mutation(internal.snapshots.applySync, {
        source: "visible",
        startedAt: NOW.getTime(),
        rows: [],
        pipeline: { mode: "replace", investors: [] },
      }),
    ).rejects.toThrow("A replace push cannot be empty: it would archive every row.");
    expect((await investorById(t, "a"))?.archivedAt).toBeUndefined();
  });

  test("the write itself checks the rows again, whoever calls it", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.snapshots.applySync, {
        source: "cfo_workbook",
        startedAt: NOW.getTime(),
        rows: [],
        pipeline: { mode: "upsert", investors: [{ externalId: "a", name: "n", stage: "s" }] },
      }),
    ).rejects.toThrow("This source does not own investors.");
    expect(await investorRows(t)).toEqual([]);
  });

  test("one bad row refuses the whole push", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      investors([investor("a"), investor("b", { amount: 5, currency: "KZT" })]),
      VISIBLE,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_rows",
      issues: [{ path: "investors.1.currency", message: "Amounts from this source are in USD." }],
    });
    expect(await investorRows(t)).toEqual([]);
  });

  test("a row with a field the OS never asked for refuses the whole push", async () => {
    const t = convexTest(schema, modules);
    for (const extra of ["email", "phone", "patientName"]) {
      const response = await post(t, deals([deal("1", { [extra]: "x" })]), CRM);
      expect(response.status, extra).toBe(422);
    }
    expect(await dealRows(t)).toEqual([]);
  });

  test("a source cannot push a pipeline it does not own", async () => {
    const t = convexTest(schema, modules);
    const attempts: [unknown, string, string][] = [
      [{ ...head("visible"), deals: [deal("1")] }, VISIBLE, "deals"],
      [{ ...head("kz_crm"), investors: [investor("a")] }, CRM, "investors"],
      [{ ...head("cfo_workbook"), deals: [deal("1")] }, WORKBOOK, "deals"],
      [{ ...head("cfo_workbook"), investors: [investor("a")] }, WORKBOOK, "investors"],
    ];
    for (const [body, token, pipeline] of attempts) {
      const response = await post(t, body, token);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "invalid_rows",
        issues: [{ path: pipeline, message: `This source does not own ${pipeline}.` }],
      });
    }
    expect(await dealRows(t)).toEqual([]);
    expect(await investorRows(t)).toEqual([]);
  });

  test("a token writes only as its own source", async () => {
    // Two ingest tokens are configured: each must fix its own source.
    const t = convexTest(schema, modules);
    expect((await post(t, investors([investor("a")]), CRM)).status).toBe(403);
    expect((await post(t, deals([deal("1")]), VISIBLE)).status).toBe(403);
    expect(await dealRows(t)).toEqual([]);
    expect(await investorRows(t)).toEqual([]);
    // The refusal is logged against the token's source, not the one it claimed.
    const status = await t.run((ctx) => ctx.db.query("sourceStatus").collect());
    expect(status.map((s) => [s.source, s.state]).sort()).toEqual([
      ["kz_crm", "error"],
      ["visible", "error"],
    ]);
  });

  test("two sources given the same token are both locked out", async () => {
    vi.stubEnv("INGEST_TOKEN_KZ_CRM", VISIBLE);
    const t = convexTest(schema, modules);
    expect((await post(t, investors([investor("a")]), VISIBLE)).status).toBe(401);
    expect(await investorRows(t)).toEqual([]);
  });

  test("a refused push is logged against the source with the row and the field, and no value", async () => {
    const t = convexTest(schema, modules);
    await post(t, deals([deal("1"), deal("2", { closedAt: "2026-10-01" })]), CRM);
    const status = await t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "kz_crm"))
        .unique(),
    );
    expect(status).toMatchObject({
      state: "error",
      message: "invalid_rows: deals.1.closedAt — Only a won or lost deal has a close date.",
    });
  });

  test("no company or person name ever reaches the run log", async () => {
    // syncRuns and sourceStatus are read by every scorecard subscription and
    // kept for 30 days. Names belong in the deals and investors tables only.
    const t = convexTest(schema, modules);
    const secret = { name: "Zzyzx Dental", contact: "Zzyzx Person" };
    const bodies = [
      deals([deal("ok", secret)]),
      deals([deal("ok", secret)], { mode: "replace" }),
      deals([deal("1", { ...secret, amount: -5, currency: "KZT" })]),
      deals([deal("1", { ...secret, amount: 5, currency: "USD" })]),
      deals([deal("1", { ...secret, lastActivityAt: "2027-01-01" })]),
      deals([deal("1", { ...secret, stage: "Zzyzx stage", closedAt: "not-a-date" })]),
      deals([deal("1", secret), deal("1", secret)]),
      deals([deal("1", { ...secret, name: "Zzyzx ".repeat(40) })]),
      deals([deal("1", { ...secret, amount: "Zzyzx" })]),
      deals([deal("1", { ...secret, email: "zzyzx@example.com" })]),
      { ...head("kz_crm"), investors: [investor("a", secret)] },
      { ...deals([deal("1", secret)]), source: "visible" },
    ];
    for (const body of bodies) await post(t, body, CRM);
    const log = await logged(t);
    expect(JSON.parse(log).runs).toHaveLength(bodies.length);
    expect(log).not.toMatch(/zzyzx/i);
    // The rows themselves do hold the names: that is what they are for.
    expect((await dealRows(t)).map((d) => d.name)).toEqual(["Zzyzx Dental"]);
  });

  test("a rejected push leaves the board exactly as it was", async () => {
    const t = convexTest(schema, modules);
    await post(t, deals([deal("1"), deal("2")]), CRM);
    const before = await dealRows(t);
    await post(t, deals([deal("1", { name: "Changed" }), deal("3", { amount: -1, currency: "KZT" })], { mode: "replace" }), CRM);
    expect(await dealRows(t)).toEqual(before);
  });
});
