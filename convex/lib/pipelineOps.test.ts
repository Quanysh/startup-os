import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import { applyPipelinePush, dealOps, investorOps, type PipelinePush } from "./pipelineOps";
import type { PipelineRowInput } from "./pipelineRules";
import { placeRow } from "./pipelineWriter";

const NOW = Date.UTC(2026, 9, 12, 12);

const investor = (id: string, extra: Partial<PipelineRowInput> = {}): PipelineRowInput => ({
  externalId: id,
  name: `Fund ${id}`,
  stage: "Contacted",
  ...extra,
});

const push = (
  t: TestBackend,
  rows: PipelineRowInput[],
  mode: PipelinePush["mode"] = "upsert",
  now = NOW,
) => t.run((ctx) => applyPipelinePush(ctx, "visible", { mode, investors: rows }, now));

const all = (t: TestBackend) => t.run((ctx) => ctx.db.query("investors").collect());
const one = async (t: TestBackend, externalId: string) =>
  (await all(t)).find((row) => row.externalId === externalId)!;
/** Names on the board in one stage, top to bottom. */
const column = async (t: TestBackend, stage: string) =>
  (await all(t))
    .filter((row) => row.stage === stage && row.archivedAt === undefined)
    .sort((a, b) => a.order - b.order)
    .map((row) => row.name);

describe("applyPipelinePush", () => {
  test("new rows are inserted at the bottom of their stage, with the stage mapped", async () => {
    const t = convexTest(schema, modules);
    const counts = await push(t, [
      investor("a", { stage: "Reached out", contact: "Dana Lee", lastActivityAt: "2026-10-09" }),
      investor("b"),
      investor("c", { stage: "Invested", closedAt: "2026-10-01" }),
    ]);
    expect(counts).toEqual({ inserted: 3, updated: 0, unchanged: 0, archived: 0 });
    expect(await one(t, "a")).toMatchObject({
      source: "visible",
      name: "Fund a",
      contact: "Dana Lee",
      stage: "contacted",
      sourceStage: "Reached out",
      lastActivityAt: Date.UTC(2026, 9, 9),
      order: 0,
    });
    expect(await one(t, "b")).toMatchObject({ stage: "contacted", order: 1 });
    expect(await one(t, "c")).toMatchObject({ stage: "committed", closedAt: Date.UTC(2026, 9, 1) });
  });

  test("deals from the Kazakhstan CRM go to the Kazakhstan board", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      applyPipelinePush(
        ctx,
        "kz_crm",
        { mode: "upsert", deals: [{ externalId: "1", name: "Almaty Dental", stage: "Новая" }] },
        NOW,
      ),
    );
    const deals = await t.run((ctx) => ctx.db.query("deals").collect());
    expect(deals).toMatchObject([{ market: "kz", source: "kz_crm", stage: "lead" }]);
  });

  test("an identical push writes nothing", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a"), investor("b")]);
    const before = await all(t);
    expect(await push(t, [investor("a"), investor("b")])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      archived: 0,
    });
    expect(await all(t)).toEqual(before);
  });

  test("a push rewrites what the source owns and never the owner's next step, notes or place", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a"), investor("b")]);
    const { _id } = await one(t, "b");
    await t.run((ctx) =>
      ctx.db.patch(_id, { nextStep: "Send the deck", notes: "Warm intro from Dana" }),
    );

    const counts = await push(t, [
      investor("a"),
      investor("b", {
        name: "Renamed Fund",
        contact: "New Partner",
        amount: 500_000,
        currency: "USD",
        lastActivityAt: "2026-10-11",
      }),
    ]);
    expect(counts).toMatchObject({ updated: 1, unchanged: 1 });
    expect(await one(t, "b")).toMatchObject({
      name: "Renamed Fund",
      contact: "New Partner",
      amount: 500_000,
      lastActivityAt: Date.UTC(2026, 9, 11),
      nextStep: "Send the deck",
      notes: "Warm intro from Dana",
      order: 1,
    });
  });

  test("a field the source stops sending is cleared, not kept", async () => {
    const t = convexTest(schema, modules);
    await push(t, [
      investor("a", { contact: "Dana Lee", amount: 1, currency: "USD", lastActivityAt: "2026-10-01" }),
    ]);
    await push(t, [investor("a")]);
    const row = await one(t, "a");
    expect(row.contact).toBeUndefined();
    expect(row.amount).toBeUndefined();
    expect(row.lastActivityAt).toBeUndefined();
  });

  test("a card whose stage changes at the source joins the bottom of its new column", async () => {
    const t = convexTest(schema, modules);
    await push(t, [
      investor("a"),
      investor("b", { stage: "Meeting" }),
      investor("c", { stage: "Meeting" }),
    ]);
    await push(t, [investor("a", { stage: "Meeting" })]);
    expect(await column(t, "meeting")).toEqual(["Fund b", "Fund c", "Fund a"]);
  });

  test("a stage name the OS does not know is stored as unmapped with the source's word for it", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a", { stage: "Warm" })]);
    expect(await one(t, "a")).toMatchObject({ stage: "unmapped", sourceStage: "Warm" });
  });

  test("upsert leaves rows the push does not name where they are", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a"), investor("b")]);
    expect(await push(t, [investor("a")])).toMatchObject({ unchanged: 1, archived: 0 });
    expect((await one(t, "b")).archivedAt).toBeUndefined();
  });

  test("replace archives rows the push does not name, once, and keeps their notes", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a"), investor("b")]);
    const { _id } = await one(t, "b");
    await t.run((ctx) => ctx.db.patch(_id, { notes: "Passed for now" }));

    expect(await push(t, [investor("a")], "replace")).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      archived: 1,
    });
    expect(await one(t, "b")).toMatchObject({ archivedAt: NOW, notes: "Passed for now" });
    expect(await column(t, "contacted")).toEqual(["Fund a"]);
    // Already archived: not counted, and its archive time is not moved.
    expect(await push(t, [investor("a")], "replace", NOW + 1_000)).toMatchObject({ archived: 0 });
    expect((await one(t, "b")).archivedAt).toBe(NOW);
  });

  test("an archived row the source lists again comes back at the bottom, with its notes", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a"), investor("b")]);
    const { _id } = await one(t, "a");
    await t.run((ctx) => ctx.db.patch(_id, { notes: "Keep warm" }));
    await push(t, [investor("b")], "replace");

    expect(await push(t, [investor("a"), investor("b")], "replace")).toMatchObject({
      updated: 1,
      unchanged: 1,
      archived: 0,
    });
    expect(await column(t, "contacted")).toEqual(["Fund b", "Fund a"]);
    expect(await one(t, "a")).toMatchObject({ notes: "Keep warm" });
    expect((await one(t, "a")).archivedAt).toBeUndefined();
  });

  test("replace never archives a card made here, or another source's", async () => {
    const t = convexTest(schema, modules);
    const native = await t.run((ctx) =>
      ctx.db.insert("investors", {
        source: "manual",
        externalId: "made-here",
        name: "Added by hand",
        stage: "target",
        order: 0,
      }),
    );
    await push(t, [investor("a")], "replace");
    await push(t, [investor("z")], "replace");
    expect((await t.run((ctx) => ctx.db.get(native)))?.archivedAt).toBeUndefined();
    expect((await one(t, "a")).archivedAt).toBe(NOW);
  });

  test("an empty push is refused: a replace would archive every row", async () => {
    const t = convexTest(schema, modules);
    await push(t, [investor("a")]);
    await expect(push(t, [], "replace")).rejects.toThrow(
      "A replace push cannot be empty: it would archive every row.",
    );
    await expect(push(t, [], "upsert")).rejects.toThrow("A push cannot be empty.");
    expect((await one(t, "a")).archivedAt).toBeUndefined();
  });

  test("rows are checked here too, and a bad one stops the whole push", async () => {
    const t = convexTest(schema, modules);
    await expect(
      push(t, [investor("a"), investor("b", { amount: 5, currency: "KZT" })]),
    ).rejects.toThrow("Amounts from this source are in USD.");
    await expect(
      t.run((ctx) =>
        applyPipelinePush(ctx, "cfo_workbook", { mode: "upsert", investors: [investor("a")] }, NOW),
      ),
    ).rejects.toThrow("This source does not own investors.");
    expect(await all(t)).toEqual([]);
  });
});

describe("placeRow", () => {
  const seed = (t: TestBackend, name: string, stage: string, order: number, market: "us" | "kz" = "us") =>
    t.run((ctx) =>
      ctx.db.insert("deals", { source: "manual", externalId: name, market, name, stage, order }),
    );
  const place = (t: TestBackend, id: Awaited<ReturnType<typeof seed>>, stage: string, index: number, now = NOW) =>
    t.run(async (ctx) => placeRow(dealOps(ctx), (await ctx.db.get(id))!, stage, index, now));
  const deals = async (t: TestBackend, stage: string, market = "us") =>
    (await t.run((ctx) => ctx.db.query("deals").collect()))
      .filter((d) => d.stage === stage && d.market === market)
      .sort((a, b) => a.order - b.order)
      .map((d) => d.name);

  test("moves a card to a position in another stage and closes the gap behind it", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "A", "lead", 0);
    await seed(t, "B", "lead", 1);
    await seed(t, "X", "demo", 0);
    await seed(t, "Y", "demo", 1);
    await place(t, a, "demo", 1);
    expect(await deals(t, "lead")).toEqual(["B"]);
    expect(await deals(t, "demo")).toEqual(["X", "A", "Y"]);
    expect((await t.run((ctx) => ctx.db.query("deals").collect())).map((d) => d.order).sort()).toEqual([0, 0, 1, 2]);
  });

  test("only the card's own board is renumbered", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "A", "lead", 0);
    await seed(t, "KZ1", "demo", 0, "kz");
    await seed(t, "KZ2", "demo", 1, "kz");
    await place(t, a, "demo", 0);
    expect(await deals(t, "demo", "kz")).toEqual(["KZ1", "KZ2"]);
    expect(await deals(t, "demo")).toEqual(["A"]);
  });

  test("entering a closed stage stamps the close date and activity; leaving clears the date", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "A", "proposal", 0);
    await place(t, a, "won", 0, NOW);
    expect(await t.run((ctx) => ctx.db.get(a))).toMatchObject({
      stage: "won",
      closedAt: NOW,
      lastActivityAt: NOW,
    });
    await place(t, a, "proposal", 0, NOW + 5);
    const reopened = await t.run((ctx) => ctx.db.get(a));
    expect(reopened?.closedAt).toBeUndefined();
    expect(reopened?.lastActivityAt).toBe(NOW + 5);
  });

  test("a reorder within a stage is not activity", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "A", "lead", 0);
    await seed(t, "B", "lead", 1);
    await place(t, a, "lead", 1);
    expect(await deals(t, "lead")).toEqual(["B", "A"]);
    expect((await t.run((ctx) => ctx.db.get(a)))?.lastActivityAt).toBeUndefined();
  });

  test("archived rows are not part of a column", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "A", "lead", 0);
    const gone = await seed(t, "Gone", "demo", 0);
    await t.run((ctx) => ctx.db.patch(gone, { archivedAt: 1 }));
    await place(t, a, "demo", 5);
    expect((await t.run((ctx) => ctx.db.get(a)))?.order).toBe(0);
  });

  test("investors have one board", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("investors", { source: "manual", externalId: "i", name: "I", stage: "target", order: 0 }),
    );
    await t.run(async (ctx) =>
      placeRow(investorOps(ctx), (await ctx.db.get(id))!, "passed", 0, NOW),
    );
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ stage: "passed", closedAt: NOW });
  });
});
