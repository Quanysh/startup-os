// Visible write-back, end to end: an edit here queues a row, the daily run
// reads the outbox and acks it, and the next pull from Visible neither undoes
// a queued edit nor duplicates an investor made here.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_BULK_INVESTORS } from "./lib/investorSync";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

// Long enough to count as real secrets (MIN_INGEST_TOKEN_LENGTH).
const VISIBLE = "test-visible-token-0123456789-abcdefghij";
const CRM = "test-kz-crm-token-0123456789-abcdefghijk";
const STANDUP = "test-standup-token-0123456789-abcdefghi";

const NOW = new Date("2026-10-12T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_VISIBLE", VISIBLE);
  vi.stubEnv("INGEST_TOKEN_KZ_CRM", CRM);
  vi.stubEnv("INGEST_TOKEN_STANDUP", STANDUP);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;
type Row = Record<string, unknown>;

async function start() {
  const t = convexTest(schema, modules);
  return { t, owner: await signInAsOwner(t) };
}

/** A Visible investor as a pull would have left it. */
const seedVisible = (t: TestBackend, externalId: string, fields: Row = {}) =>
  t.run((ctx) =>
    ctx.db.insert("investors", {
      source: "visible",
      externalId,
      name: `Fund ${externalId}`,
      stage: "contacted",
      sourceStage: "Contacted",
      order: 0,
      ...fields,
    }),
  );

const syncRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("investorSync").collect());
const investorRow = (t: TestBackend, id: Id<"investors">) => t.run((ctx) => ctx.db.get(id));
const investorRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("investors").collect());
const card = async (owner: Owner, id: Id<"investors">) =>
  Object.values(await owner.query(api.investors.board, {}))
    .flat()
    .find((c) => c.id === id);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const outbox = (t: TestBackend, token = VISIBLE) =>
  t.fetch("/ingest/v1/visible/outbox", { method: "GET", headers: auth(token) });
const ack = (t: TestBackend, body: unknown, token = VISIBLE) =>
  t.fetch("/ingest/v1/visible/outbox/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(token) },
    body: JSON.stringify(body),
  });
const items = async (t: TestBackend) => {
  const response = await outbox(t);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Row[] }).items;
};

/** A replace pull from Visible, as the daily run sends it. */
const pull = (t: TestBackend, rows: Row[]) =>
  t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(VISIBLE) },
    body: JSON.stringify({
      version: 1,
      source: "visible",
      batchId: "visible-2026-10-12",
      observedAt: "2026-10-12T11:59:00Z",
      mode: "replace",
      investors: rows,
    }),
  });

describe("an edit here queues one row per investor", () => {
  test("moving and editing a Visible investor queues one coalesced row, the latest value winning", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a", { amount: 100 });
    await owner.mutation(api.investors.move, { id, stage: "meeting", index: 0 });
    await owner.mutation(api.investors.update, { id, amount: 250, name: "Renamed Fund" });
    await owner.mutation(api.investors.move, { id, stage: "diligence", index: 0 });

    const rows = await syncRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      investorId: id,
      kind: "update",
      fields: { stage: "diligence", amount: 250, name: "Renamed Fund" },
      status: "pending",
      revision: 2,
      attempts: 0,
    });
    expect(await card(owner, id)).toMatchObject({
      stage: "diligence",
      sync: { status: "pending", errorCode: null, queuedAt: NOW.getTime() },
      changedInVisible: false,
    });
  });

  test("a reorder within a stage, and a save that changes nothing, queue nothing", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a", { name: "Same Fund" });
    await seedVisible(t, "inv_b", { order: 1 });
    await owner.mutation(api.investors.move, { id, stage: "contacted", index: 1 });
    await owner.mutation(api.investors.update, { id, name: "Same Fund" });
    expect(await syncRows(t)).toEqual([]);
    expect((await card(owner, id))?.sync).toBeNull();
  });

  test("a next step or notes change of a Visible investor queues a note", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a", { notes: "Old" });
    await owner.mutation(api.investors.update, { id, nextStep: "Send the deck", notes: null });
    const [item] = await items(t);
    expect(item).toEqual({
      id: (await syncRows(t))[0]!._id,
      revision: 0,
      kind: "update",
      investor: { externalId: "inv_a", name: "Fund inv_a" },
      fields: {},
      osStage: "contacted",
      note: "Next step: Send the deck\nNotes: (cleared)",
    });
  });

  test("an investor made here queues a create, whole, and later edits merge into it", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.investors.create, { name: "Made-up Angel", amount: 50_000, nextStep: "Intro call" });
    await owner.mutation(api.investors.move, { id, stage: "meeting", index: 0 });
    const rows = await syncRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "create",
      fields: { stage: "meeting", name: "Made-up Angel", amount: 50_000 },
      note: { nextStep: "Intro call" },
      revision: 1,
    });
    const [item] = await items(t);
    expect(item).toMatchObject({ kind: "create", investor: { name: "Made-up Angel" }, osStage: "meeting", note: "Next step: Intro call" });
    expect((item!.investor as Row).externalId).toBeUndefined();
  });

  test("a Kazakhstan deal stays locked and queues nothing", async () => {
    const { t, owner } = await start();
    const deal = await t.run((ctx) =>
      ctx.db.insert("deals", { market: "kz", source: "kz_crm", externalId: "d1", name: "Made-up Clinic", stage: "lead", order: 0 }),
    );
    await expect(owner.mutation(api.deals.move, { id: deal, stage: "demo", index: 0 })).rejects.toThrow(
      "This deal is mirrored from the Kazakhstan CRM",
    );
    await expect(owner.mutation(api.deals.update, { id: deal, amount: 5 })).rejects.toThrow(
      "This deal is mirrored from the Kazakhstan CRM",
    );
    expect(await syncRows(t)).toEqual([]);
  });
});

describe("the outbox and its ack", () => {
  test("only Visible's token reads or acks the outbox", async () => {
    const { t } = await start();
    for (const token of [CRM, STANDUP, "", "sosa_not-a-source-token-0123456789abcdef"]) {
      expect((await outbox(t, token)).status, token).toBe(401);
      expect((await ack(t, { results: [{ id: "x", revision: 0, ok: true }] }, token)).status, token).toBe(401);
    }
    vi.stubEnv("INGEST_TOKEN_VISIBLE", "");
    expect((await outbox(t, VISIBLE)).status).toBe(503);
  });

  test("a token two sources share opens neither", async () => {
    const { t } = await start();
    vi.stubEnv("INGEST_TOKEN_KZ_CRM", VISIBLE);
    expect((await outbox(t)).status).toBe(401);
  });

  test("an update acked is sent; failed is failed with its code, and Retry puts it back", async () => {
    const { t, owner } = await start();
    const a = await seedVisible(t, "inv_a");
    const b = await seedVisible(t, "inv_b", { order: 1 });
    await owner.mutation(api.investors.move, { id: a, stage: "meeting", index: 0 });
    await owner.mutation(api.investors.move, { id: b, stage: "meeting", index: 0 });
    const [first, second] = await items(t);

    const response = await ack(t, {
      results: [
        { id: first!.id, revision: 0, ok: true },
        { id: second!.id, revision: 0, ok: false, errorCode: "unmapped_stage" },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sent: 1, confirmed: 0, failed: 1, stale: 0, unknown: 0 });
    expect(await items(t)).toEqual([]);

    const failed = first!.investor as Row;
    const failedId = failed.externalId === "inv_a" ? b : a;
    const sentId = failedId === a ? b : a;
    expect(await card(owner, sentId)).toMatchObject({ sync: { status: "sent", errorCode: null } });
    expect(await card(owner, failedId)).toMatchObject({ sync: { status: "failed", errorCode: "unmapped_stage" } });

    await owner.mutation(api.investors.retrySync, { id: failedId });
    expect(await card(owner, failedId)).toMatchObject({ sync: { status: "pending", errorCode: null } });
    await expect(owner.mutation(api.investors.retrySync, { id: failedId })).rejects.toThrow(
      "Nothing failed to sync for that investor.",
    );
    expect(await items(t)).toHaveLength(1);
  });

  test("a note-only change is confirmed when acked: a pull cannot see notes", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await owner.mutation(api.investors.update, { id, nextStep: "Call" });
    const [item] = await items(t);
    expect(await (await ack(t, { results: [{ id: item!.id, revision: 0, ok: true }] })).json()).toMatchObject({ confirmed: 1 });
    expect((await card(owner, id))?.sync).toBeNull();
  });

  test("an ack for an older revision leaves the newer values pending", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await owner.mutation(api.investors.move, { id, stage: "meeting", index: 0 });
    const [item] = await items(t);
    await owner.mutation(api.investors.update, { id, amount: 7 });
    expect(await (await ack(t, { results: [{ id: item!.id, revision: 0, ok: true }] })).json()).toMatchObject({ stale: 1, sent: 0 });
    const [again] = await items(t);
    expect(again).toMatchObject({ revision: 1, fields: { stage: "meeting", amount: 7 } });
  });

  test("an id that is not pending is unknown and changes nothing; a bad ack is refused in fixed words", async () => {
    const { t } = await start();
    expect(await (await ack(t, { results: [{ id: "nosuchrow", revision: 0, ok: true }] })).json()).toMatchObject({ unknown: 1 });
    const refused = await ack(t, { results: [{ id: "x", revision: 0, ok: false, errorCode: "Visible said Made-up Fund" }] });
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.error).toBe("invalid_ack");
    expect(JSON.stringify(body)).not.toContain("Made-up");
    const logged = JSON.stringify(await t.run((ctx) => ctx.db.query("syncRuns").collect()));
    expect(logged).toContain("invalid_ack");
    expect(logged).not.toContain("Made-up");
  });

  test("a create for an archived investor waits: archiving is local", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.investors.create, { name: "Made-up Angel" });
    await owner.mutation(api.investors.archive, { id });
    expect(await items(t)).toEqual([]);
    await owner.mutation(api.investors.restore, { id });
    expect(await items(t)).toHaveLength(1);
  });
});

describe("a create acked links the investor, and the next pull matches it", () => {
  test("no duplicate, no archive", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.investors.create, { name: "Made-up Angel", stage: "meeting", amount: 50_000 });
    const [item] = await items(t);
    const acked = await ack(t, { results: [{ id: item!.id, revision: 0, ok: true, visibleId: "inv_new" }] });
    expect(await acked.json()).toMatchObject({ sent: 1 });
    expect(await investorRow(t, id)).toMatchObject({ source: "visible", externalId: "inv_new" });

    const pulled = await pull(t, [
      { externalId: "inv_new", name: "Made-up Angel", stage: "First meeting", amount: 50_000, currency: "USD" },
    ]);
    expect(pulled.status).toBe(200);
    const rows = await investorRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: id, stage: "meeting" });
    expect(rows[0]!.archivedAt).toBeUndefined();
    // The pull confirmed what was sent.
    expect((await card(owner, id))?.sync).toBeNull();
    expect((await syncRows(t))[0]).toMatchObject({ status: "confirmed", confirmedAt: NOW.getTime() });
  });

  test("a create acked without a Visible id, or with one another investor here has, fails", async () => {
    const { t, owner } = await start();
    await seedVisible(t, "inv_taken");
    const a = await owner.mutation(api.investors.create, { name: "Made-up A" });
    const b = await owner.mutation(api.investors.create, { name: "Made-up B" });
    const [first, second] = await items(t);
    await ack(t, {
      results: [
        { id: first!.id, revision: 0, ok: true },
        { id: second!.id, revision: 0, ok: true, visibleId: "inv_taken" },
      ],
    });
    const codes = [(await card(owner, a))?.sync?.errorCode, (await card(owner, b))?.sync?.errorCode].sort();
    expect(codes).toEqual(["already_in_os", "missing_visible_id"]);
    expect((await investorRow(t, a))?.source).toBe("manual");
    expect((await investorRow(t, b))?.source).toBe("manual");
  });
});

describe("the pull keeps queued edits", () => {
  test("a pending field keeps the OS value; one Visible already holds is done", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a", { amount: 100 });
    await owner.mutation(api.investors.update, { id, stage: "diligence", amount: 300 });

    // Visible still says Contacted, and already shows the new amount.
    await pull(t, [{ externalId: "inv_a", name: "Fund inv_a", stage: "Contacted", amount: 300, currency: "USD" }]);
    expect(await investorRow(t, id)).toMatchObject({ stage: "diligence", amount: 300 });
    const [row] = await syncRows(t);
    expect(row).toMatchObject({ status: "pending", fields: { stage: "diligence" } });
    expect(row!.fields.amount).toBeUndefined();

    // Visible catches up on the stage: nothing left to send.
    await pull(t, [{ externalId: "inv_a", name: "Fund inv_a", stage: "Due diligence", amount: 300, currency: "USD" }]);
    expect((await syncRows(t))[0]).toMatchObject({ status: "confirmed" });
  });

  test("after a send, a different value in Visible wins and the card says so for seven days", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await owner.mutation(api.investors.move, { id, stage: "meeting", index: 0 });
    const [item] = await items(t);
    await ack(t, { results: [{ id: item!.id, revision: 0, ok: true }] });

    // Someone moved it in Visible after the run wrote it.
    await pull(t, [{ externalId: "inv_a", name: "Fund inv_a", stage: "Passed" }]);
    expect(await investorRow(t, id)).toMatchObject({ stage: "passed", changedInVisibleAt: NOW.getTime() });
    expect(await card(owner, id)).toMatchObject({ changedInVisible: true, sync: null });

    vi.setSystemTime(new Date(NOW.getTime() + 7 * DAY));
    await pull(t, [{ externalId: "inv_a", name: "Fund inv_a", stage: "Passed" }]);
    expect(await card(owner, id)).toMatchObject({ changedInVisible: false });
  });

  test("an investor the owner archived stays archived on a replace pull; one Visible dropped comes back when listed", async () => {
    const { t, owner } = await start();
    const mine = await seedVisible(t, "inv_mine");
    const dropped = await seedVisible(t, "inv_dropped", { archivedAt: 1_000 });
    await owner.mutation(api.investors.archive, { id: mine });
    await pull(t, [
      { externalId: "inv_mine", name: "Fund inv_mine renamed", stage: "Contacted" },
      { externalId: "inv_dropped", name: "Fund inv_dropped", stage: "Contacted" },
    ]);
    expect(await investorRow(t, mine)).toMatchObject({ archivedBy: "owner", name: "Fund inv_mine renamed" });
    expect((await investorRow(t, mine))?.archivedAt).toBe(NOW.getTime());
    expect((await investorRow(t, dropped))?.archivedAt).toBeUndefined();
  });
});

describe("archive, restore and the archived list", () => {
  test("a Visible investor and one made here can be archived and restored; Visible's own archive cannot be undone here", async () => {
    const { t, owner } = await start();
    const visible = await seedVisible(t, "inv_a");
    const native = await owner.mutation(api.investors.create, { name: "Made-up Angel" });
    const byVisible = await seedVisible(t, "inv_gone", { archivedAt: 1_000 });
    await owner.mutation(api.investors.archive, { id: visible });
    vi.setSystemTime(new Date(NOW.getTime() + 1_000));
    await owner.mutation(api.investors.archive, { id: native });

    expect((await owner.query(api.investors.archived, {})).map((c) => c.id)).toEqual([native, visible]);
    expect(await card(owner, visible)).toBeUndefined();
    await expect(owner.mutation(api.investors.restore, { id: byVisible })).rejects.toThrow(
      "Visible took this investor off its pipeline.",
    );
    await owner.mutation(api.investors.restore, { id: visible });
    expect(await card(owner, visible)).toBeDefined();
    const restored = await investorRow(t, visible);
    expect([restored?.archivedAt, restored?.archivedBy]).toEqual([undefined, undefined]);
    await expect(owner.mutation(api.investors.restore, { id: visible })).rejects.toThrow("That investor is not archived.");
    // Archiving is local: nothing queued for the Visible investor.
    expect((await syncRows(t)).filter((row) => row.investorId === visible)).toEqual([]);
  });
});

describe("bulk", () => {
  test("move, archive and next step, one result per investor; a refusal does not stop the rest", async () => {
    const { t, owner } = await start();
    const a = await seedVisible(t, "inv_a");
    const b = await seedVisible(t, "inv_b", { order: 1 });
    const gone = await seedVisible(t, "inv_c", { archivedAt: 5 });

    const moved = await owner.mutation(api.investors.bulk, { ids: [a, b, gone], action: { kind: "move", stage: "meeting" } });
    expect(moved.results).toEqual([
      { id: a, ok: true },
      { id: b, ok: true },
      { id: gone, ok: false, error: "That investor is no longer on the board." },
    ]);
    expect((await owner.query(api.investors.board, {})).meeting.map((c) => c.id)).toEqual([a, b]);
    expect((await syncRows(t)).map((row) => row.fields.stage)).toEqual(["meeting", "meeting"]);

    await owner.mutation(api.investors.bulk, { ids: [a], action: { kind: "nextStep", text: "Follow up" } });
    expect((await syncRows(t)).find((row) => row.investorId === a)).toMatchObject({ note: { nextStep: "Follow up" } });

    await owner.mutation(api.investors.bulk, { ids: [a, b], action: { kind: "archive" } });
    expect((await owner.query(api.investors.archived, {})).map((c) => c.id).sort()).toEqual([a, b].sort());
  });

  test("at most a hundred at once, and at least one", async () => {
    const { t, owner } = await start();
    const ids: Id<"investors">[] = [];
    for (let i = 0; i <= MAX_BULK_INVESTORS; i++) ids.push(await seedVisible(t, `inv_${i}`, { order: i }));
    await expect(owner.mutation(api.investors.bulk, { ids, action: { kind: "archive" } })).rejects.toThrow(
      "Pick at most 100 investors at once.",
    );
    await expect(owner.mutation(api.investors.bulk, { ids: [], action: { kind: "archive" } })).rejects.toThrow(
      "Pick at least one investor.",
    );
    expect(await syncRows(t)).toEqual([]);
  });
});

describe("one investor's page", () => {
  test("get carries the card, its sync and whether it is archived; the history carries no values", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await owner.mutation(api.investors.update, { id, amount: 900, notes: "Private words" });
    expect(await owner.query(api.investors.get, { id })).toMatchObject({
      id,
      amount: 900,
      editable: true,
      draggable: true,
      sync: { status: "pending", errorCode: null, queuedAt: NOW.getTime() },
      changedInVisible: false,
      archived: false,
      archivedAt: null,
      restorable: false,
    });
    const history = await owner.query(api.investors.syncHistory, { id });
    expect(history).toEqual([
      {
        id: expect.any(String),
        kind: "update",
        status: "pending",
        attempts: 0,
        errorCode: null,
        queuedAt: NOW.getTime(),
        sentAt: null,
        confirmedAt: null,
        fields: ["amount"],
        note: true,
      },
    ]);
    expect(JSON.stringify(history)).not.toMatch(/900|Private/);
  });

  test("get answers null for an investor that is gone, a malformed id or another table's id", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await t.run((ctx) => ctx.db.delete(id));
    expect(await owner.query(api.investors.get, { id })).toBeNull();
    expect(await owner.query(api.investors.get, { id: "not-an-id" })).toBeNull();
    const deal = await t.run((ctx) =>
      ctx.db.insert("deals", { market: "us", source: "manual", externalId: "x", name: "Made-up", stage: "lead", order: 0 }),
    );
    expect(await owner.query(api.investors.get, { id: deal })).toBeNull();
  });

  test("the archived list carries each investor's id, name, stage and when it was archived", async () => {
    const { t, owner } = await start();
    const id = await seedVisible(t, "inv_a");
    await owner.mutation(api.investors.archive, { id });
    expect((await owner.query(api.investors.archived, {}))[0]).toMatchObject({
      id,
      name: "Fund inv_a",
      stage: "contacted",
      archivedAt: NOW.getTime(),
    });
  });
});
