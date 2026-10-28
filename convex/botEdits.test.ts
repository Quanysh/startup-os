import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CUSTOMER_WORDS } from "./lib/customerRules";
import { INVESTOR_TOOL_WORDS } from "./lib/pipelineCards";
import { ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Two direct edits a bot makes with write on the page's area, as `deal_update`
// does on sales: `investor_update` (fundraising, Startup only) and
// `customer_update` (customers: the owner's note and next touch, both markets).
// No approval: they are gated by write on the area. Every name is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  const clinics = await t.run((ctx) => ctx.db.query("customers").collect());
  const usClinic = clinics.find((c) => c.market === "us")!._id;
  const kzClinic = clinics.find((c) => c.market === "kz")!._id;
  return { t, ids, owner, mac, grok: grok.token, usClinic, kzClinic };
}

/** Gives a suggested bot write on the customers area, as the owner would on Agents › Bots. */
async function customersWriter(t: TestBackend, botId: string) {
  await t.run(async (ctx) => {
    const bot = (await ctx.db.query("bots").collect()).find((b) => b.botId === botId)!;
    await ctx.db.patch(bot._id, {
      permissions: [...bot.permissions.filter((p) => p.area !== "customers"), { area: "customers", level: "write" }],
    });
  });
}

const investorRow = (t: TestBackend, id: Id<"investors">) => t.run((ctx) => ctx.db.get(id));
const clinicRow = (t: TestBackend, id: Id<"customers">) => t.run((ctx) => ctx.db.get(id));

describe("investor_update", () => {
  test("a bot with write on fundraising sets an investor's next step, and the call is written down", async () => {
    const { t, ids, owner, grok } = await setUp();
    const reply = await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, nextStep: "Send the deck" });
    expect(reply.output).toMatchObject({ id: ids.investor, updated: true });
    const board = await owner.query(api.investors.board, {});
    expect(board.meeting[0]).toMatchObject({ id: ids.investor, nextStep: "Send the deck" });
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.find((row) => row.tool === "investor_update")).toMatchObject({ bot: "fundraising", kind: "act", outcome: "ok" });
    expect(JSON.stringify(rows)).not.toContain("Send the deck");
  });

  test("null clears the next step and the notes", async () => {
    const { t, ids, grok } = await setUp();
    await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, nextStep: "x", notes: "A note" });
    await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, nextStep: null, notes: null });
    const row = await investorRow(t, ids.investor);
    expect(row!.nextStep).toBeUndefined();
    expect(row!.notes).toBeUndefined();
  });

  test("a bot without write on fundraising is refused, and nothing is changed", async () => {
    const { t, ids, grok } = await setUp();
    const reply = await call(t, grok, "investor_update", { agent: "growth", id: ids.investor, nextStep: "Made-up" });
    expect(reply.refusal).toEqual({ code: "not_permitted", tool: "investor_update", area: "fundraising", need: "write" });
    expect((await investorRow(t, ids.investor))!.nextStep).toBeUndefined();
  });

  test("an investor made here takes its stage, amount and contact; a new stage moves the card as the page does", async () => {
    const { t, ids, owner, grok } = await setUp();
    await call(t, grok, "investor_update", {
      agent: "fundraising",
      id: ids.investor,
      stage: "diligence",
      amount: 250_000,
      contact: "Made-up Partner, General Partner",
    });
    const board = await owner.query(api.investors.board, {});
    expect(board.meeting).toHaveLength(0);
    expect(board.diligence[0]).toMatchObject({ id: ids.investor, amount: 250_000, contact: "Made-up Partner, General Partner" });
  });

  test("a Visible investor's contact is refused, and nothing is changed", async () => {
    const { t, ids, grok } = await setUp();
    await t.run((ctx) => ctx.db.patch(ids.investor, { source: "visible" }));
    const was = JSON.stringify(await investorRow(t, ids.investor));
    const reply = await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, nextStep: "x", contact: "Somebody" });
    expect(reply.isError).toBe(true);
    expect(reply.said).toMatch(/^This investor's contact comes from Visible\. Change it there: here you can edit its name, amount, stage, next step and notes\.$/);
    expect(JSON.stringify(await investorRow(t, ids.investor))).toBe(was);
  });

  test("a Visible investor takes a stage, an amount and a name, queued for Visible with the bot as who did it", async () => {
    const { t, ids, grok, owner } = await setUp();
    await t.run((ctx) => ctx.db.patch(ids.investor, { source: "visible", externalId: "inv_made_up" }));
    await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, stage: "committed", amount: 5, name: "Renamed Fund" });
    expect((await owner.query(api.investors.board, {})).committed[0]).toMatchObject({
      id: ids.investor,
      name: "Renamed Fund",
      amount: 5,
      sync: { status: "pending", errorCode: null },
    });
    const [row] = await t.run((ctx) => ctx.db.query("investorSync").collect());
    expect(row).toMatchObject({ kind: "update", fields: { stage: "committed", amount: 5, name: "Renamed Fund" }, by: "fundraising" });
  });

  test("a mirrored investor still takes a next step", async () => {
    const { t, ids, grok } = await setUp();
    await t.run((ctx) => ctx.db.patch(ids.investor, { source: "visible" }));
    await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, nextStep: "Follow up" });
    expect((await investorRow(t, ids.investor))!.nextStep).toBe("Follow up");
  });

  test.each(["made-up.person@example.test", "+1 (415) 555-0100"])(
    "a contact that holds an email address or a phone number is refused as contact_detail: %s",
    async (detail) => {
      const { t, ids, grok } = await setUp();
      const reply = await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, contact: `Made-up ${detail}` });
      expect(reply.said).toBe(INVESTOR_TOOL_WORDS.contact);
      expect(reply.refusal).toEqual({ code: "contact_detail" });
      expect((await investorRow(t, ids.investor))!.contact).toBeUndefined();
    },
  );

  test("a stage that is not an investor stage is refused before anything runs", async () => {
    const { t, ids, grok } = await setUp();
    const reply = await call(t, grok, "investor_update", { agent: "fundraising", id: ids.investor, stage: "won" });
    expect(reply.said).toMatch(/^The arguments are not valid\. stage:/);
    expect((await investorRow(t, ids.investor))!.stage).toBe("meeting");
  });

  test("an id that is no investor is refused in the board's words", async () => {
    const { t, ids, grok } = await setUp();
    for (const id of ["not-an-id", ids.usDeal]) {
      expect((await call(t, grok, "investor_update", { agent: "fundraising", id, notes: "x" })).said).toBe(INVESTOR_TOOL_WORDS.gone);
    }
  });
});

describe("customer_update", () => {
  test("a bot with write on customers sets a clinic's note and next touch", async () => {
    const { t, owner, grok, usClinic } = await setUp();
    await customersWriter(t, "customer_success");
    const reply = await call(t, grok, "customer_update", {
      agent: "customer_success",
      id: usClinic,
      note: " Renewal talk in November ",
      nextTouch: "2026-11-02",
    });
    expect(reply.output).toMatchObject({ id: usClinic, updated: true });
    const list = await owner.query(api.customers.list, {});
    expect(list.customers.find((c) => c.id === usClinic)).toMatchObject({ note: "Renewal talk in November", nextTouch: "2026-11-02" });
    const rows = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(rows.find((row) => row.tool === "customer_update")).toMatchObject({ bot: "customer_success", outcome: "ok" });
  });

  test("a bot that only reads customers is refused, and nothing is changed", async () => {
    const { t, grok, usClinic } = await setUp();
    const reply = await call(t, grok, "customer_update", { agent: "customer_success", id: usClinic, note: "Made-up" });
    expect(reply.refusal).toEqual({ code: "not_permitted", tool: "customer_update", area: "customers", need: "write" });
    expect((await clinicRow(t, usClinic))!.note).toBeUndefined();
  });

  test("a Kazakhstan clinic takes them too, and null clears them", async () => {
    const { t, grok, kzClinic } = await setUp();
    await customersWriter(t, "customer_success");
    await call(t, grok, "customer_update", { agent: "customer_success", id: kzClinic, note: "Made-up", nextTouch: "2026-10-30" });
    expect(await clinicRow(t, kzClinic)).toMatchObject({ note: "Made-up", nextTouch: "2026-10-30" });
    await call(t, grok, "customer_update", { agent: "customer_success", id: kzClinic, note: null, nextTouch: null });
    const row = await clinicRow(t, kzClinic);
    expect(row!.note).toBeUndefined();
    expect(row!.nextTouch).toBeUndefined();
  });

  test.each(["2026-13-45", "2026-02-30"])("a next touch that is no day (%s) is refused in the page's words", async (bad) => {
    const { t, grok, usClinic } = await setUp();
    await customersWriter(t, "customer_success");
    const reply = await call(t, grok, "customer_update", { agent: "customer_success", id: usClinic, note: "Kept out", nextTouch: bad });
    expect(reply.said).toBe(CUSTOMER_WORDS.notADate);
    const row = await clinicRow(t, usClinic);
    expect([row!.note, row!.nextTouch]).toEqual([undefined, undefined]);
  });

  test("a next touch not written as a day is refused before anything runs", async () => {
    const { t, grok, usClinic } = await setUp();
    await customersWriter(t, "customer_success");
    const reply = await call(t, grok, "customer_update", { agent: "customer_success", id: usClinic, nextTouch: "next week" });
    expect(reply.said).toMatch(/^The arguments are not valid\. nextTouch:/);
  });

  test.each(["made-up.person@example.test", "+7 701 555 0100"])(
    "a note that holds an email address or a phone number is refused as contact_detail: %s",
    async (detail) => {
      const { t, grok, usClinic } = await setUp();
      await customersWriter(t, "customer_success");
      const reply = await call(t, grok, "customer_update", { agent: "customer_success", id: usClinic, note: `Call ${detail}` });
      expect(reply.said).toBe(CUSTOMER_WORDS.contact);
      expect(reply.refusal).toEqual({ code: "contact_detail" });
      expect((await clinicRow(t, usClinic))!.note).toBeUndefined();
    },
  );

  test("an id that is no clinic is refused in the page's words", async () => {
    const { t, ids, grok } = await setUp();
    await customersWriter(t, "customer_success");
    for (const id of ["not-an-id", ids.usDeal]) {
      expect((await call(t, grok, "customer_update", { agent: "customer_success", id, note: "x" })).said).toBe(CUSTOMER_WORDS.gone);
    }
  });

  test("nothing else about a clinic can be sent: the client register owns it", async () => {
    const { t, grok, usClinic } = await setUp();
    await customersWriter(t, "customer_success");
    const reply = await call(t, grok, "customer_update", { agent: "customer_success", id: usClinic, status: "churned" });
    expect(reply.said).toMatch(/^The arguments are not valid\./);
    expect((await clinicRow(t, usClinic))!.status).toBe("active");
  });

  test("the owner's own client sets them with no bot named", async () => {
    const { t, mac, usClinic } = await setUp();
    await call(t, mac, "customer_update", { id: usClinic, nextTouch: "2026-10-20" });
    expect((await clinicRow(t, usClinic))!.nextTouch).toBe("2026-10-20");
  });
});
