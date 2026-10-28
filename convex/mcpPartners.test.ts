import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { AGENT_WORDS } from "./lib/agentRules";
import { TOOLS } from "./lib/mcpTools";
import { NO_PARTNER_CONTACT_DETAILS, PARTNER_GONE } from "./lib/partnerFields";
import { MAC_CLIENT, NOW, TODAY, answer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";

// The owner's Claude and the partnerships pipeline: `partners` reads what the
// page reads, and `partner_upsert` / `partner_move` write through the page's own
// functions, saying which client made the change.

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world(scope: "read" | "act" = "act") {
  const t = convexTest(schema, modules);
  const { owner, token } = await ownerWithToken(t, scope);
  return { t, owner, token };
}

const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the registry", () => {
  test("partners reads; partner_upsert and partner_move act", () => {
    const kinds = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.kind]));
    expect(kinds).toMatchObject({ partners: "read", partner_upsert: "act", partner_move: "act" });
  });
});

describe("partners", () => {
  test("is each company's board as the page reads it, and one company by `company`", async () => {
    const { t, owner, token } = await world("read");
    await owner.mutation(api.partnerships.create, { company: "us", name: "Startup Reseller", type: "channel" });
    await owner.mutation(api.partnerships.create, { company: "kz", name: "Globex Referrer", type: "referral" });
    const us = asJson(await owner.query(api.partnerships.board, { company: "us" }));
    const kz = asJson(await owner.query(api.partnerships.board, { company: "kz" }));
    expect(await answer(t, token, "partners")).toEqual({ truncated: false, us, kz });
    expect(await answer(t, token, "partners", { company: "kz" })).toEqual({ truncated: false, kz });
  });

  test("a full board stays within the tool's caps", async () => {
    const { t, token } = await world("read");
    const { caps } = TOOLS.find((tool) => tool.name === "partners")!;
    await t.run(async (ctx) => {
      for (let n = 0; n < 500; n++) {
        await ctx.db.insert("partners", {
          company: "us",
          name: `Made-up partner ${n}`,
          type: "channel",
          stage: "in_talks",
          order: n,
          notes: "n".repeat(5_000),
          nextStep: "s".repeat(300),
        });
      }
    });
    const reply = await call(t, token, "partners", { company: "us" });
    expect(reply.isError).toBe(false);
    expect(reply.textOutput!.length).toBeLessThanOrEqual(caps.bytes);
  });
});

describe("partner_upsert", () => {
  test("adds a partner and says which client did", async () => {
    const { t, owner, token } = await world();
    const out = await answer(t, token, "partner_upsert", {
      company: "us",
      name: " Example Billing Co ",
      type: "channel",
      stage: "contacted",
      owner: "Ada",
      contact: "Dana Example",
      contactRole: "Head of partnerships",
      value: 8,
      valueKind: "referrals",
      nextStep: "Send the one-pager",
      nextStepOn: "2026-10-20",
      links: [{ label: "Site", url: "https://example.com" }],
    });
    expect(out).toMatchObject({ created: true });
    const [card] = (await owner.query(api.partnerships.board, { company: "us" })).contacted;
    expect(card).toMatchObject({
      id: out.id,
      name: "Example Billing Co",
      type: "channel",
      owner: "Ada",
      contact: "Dana Example",
      value: 8,
      valueKind: "referrals",
      nextStepOn: "2026-10-20",
      editedBy: MAC_CLIENT,
      lastActivityAt: NOW,
    });
  });

  test("the same name again changes that partner instead of adding a second", async () => {
    const { t, owner, token } = await world();
    const first = await answer(t, token, "partner_upsert", { company: "us", name: "Example Co", type: "referral" });
    const second = await answer(t, token, "partner_upsert", {
      company: "us",
      name: "EXAMPLE co",
      notes: "Replied to the intro",
    });
    expect(second).toMatchObject({ id: first.id, created: false });
    const board = await owner.query(api.partnerships.board, { company: "us" });
    expect(Object.values(board).flat()).toHaveLength(1);
    expect(board.identified[0]).toMatchObject({ notes: "Replied to the intro", type: "referral" });
    // The same name on the other company is a different partner.
    expect(
      (await answer(t, token, "partner_upsert", { company: "kz", name: "Example Co", type: "referral" })).created,
    ).toBe(true);
  });

  test("an id changes that partner, and null clears a field", async () => {
    const { t, owner, token } = await world();
    const { id } = await answer(t, token, "partner_upsert", {
      company: "us",
      name: "Example Co",
      type: "referral",
      contact: "Dana",
    });
    await answer(t, token, "partner_upsert", { id, contact: null, name: "Example Co Ltd" });
    expect((await owner.query(api.partnerships.board, { company: "us" })).identified[0]).toMatchObject({
      name: "Example Co Ltd",
      contact: null,
    });
  });

  test("a new partner needs a company, a name and a type, in words", async () => {
    const { t, token } = await world();
    expect((await call(t, token, "partner_upsert", { name: "No company", type: "referral" })).said).toBe(
      "A new partner needs a company and a name.",
    );
    expect((await call(t, token, "partner_upsert", { company: "us", type: "referral" })).said).toBe(
      "A new partner needs a company and a name.",
    );
    expect((await call(t, token, "partner_upsert", { company: "us", name: "No type" })).said).toBe(
      "A new partner needs a type.",
    );
  });

  test("an email address or phone number is refused, and nothing is stored", async () => {
    const { t, token } = await world();
    const reply = await call(t, token, "partner_upsert", {
      company: "us",
      name: "Example Co",
      type: "referral",
      contact: "dana@example.com",
    });
    expect(reply.said).toBe(NO_PARTNER_CONTACT_DETAILS);
    expect(await t.run((ctx) => ctx.db.query("partners").collect())).toEqual([]);
  });

  test("an unknown field or type is refused by the schema, not ignored", async () => {
    const { t, token } = await world();
    expect((await call(t, token, "partner_upsert", { company: "us", name: "X", type: "vendor" })).isError).toBe(true);
    expect(
      (await call(t, token, "partner_upsert", { company: "us", name: "X", type: "referral", email: "a@b.co" })).isError,
    ).toBe(true);
  });

  test("a partner that is gone is refused in the page's words", async () => {
    const { t, owner, token } = await world();
    const id = await owner.mutation(api.partnerships.create, { company: "us", name: "Gone", type: "referral" });
    await owner.mutation(api.partnerships.remove, { id });
    expect((await call(t, token, "partner_upsert", { id, notes: "x" })).said).toBe(PARTNER_GONE);
    expect((await call(t, token, "partner_upsert", { id: "not-an-id", notes: "x" })).said).toBe(PARTNER_GONE);
  });

  test("a read-only token changes nothing", async () => {
    const { t, token } = await world("read");
    const reply = await call(t, token, "partner_upsert", { company: "us", name: "X", type: "referral" });
    expect(reply.said).toBe(AGENT_WORDS.readOnly);
    expect(await t.run((ctx) => ctx.db.query("partners").collect())).toEqual([]);
  });
});

describe("partner_move", () => {
  test("moves to a stage, at the bottom unless an index is given, and says which client", async () => {
    const { t, owner, token } = await world();
    const a = await owner.mutation(api.partnerships.create, { company: "us", name: "A", type: "referral", stage: "live" });
    const b = await owner.mutation(api.partnerships.create, { company: "us", name: "B", type: "referral" });
    const c = await owner.mutation(api.partnerships.create, { company: "us", name: "C", type: "referral" });
    expect(await answer(t, token, "partner_move", { id: b, stage: "live" })).toMatchObject({ moved: true });
    await answer(t, token, "partner_move", { id: c, stage: "live", index: 0 });
    const live = (await owner.query(api.partnerships.board, { company: "us" })).live;
    expect(live.map((card) => card.name)).toEqual(["C", "A", "B"]);
    expect(live.find((card) => card.id === a)!.editedBy).toBeNull();
    expect(live.find((card) => card.id === b)).toMatchObject({ editedBy: MAC_CLIENT, lastActivityAt: NOW });
  });

  test("an unknown stage and a gone partner are refused in words", async () => {
    const { t, owner, token } = await world();
    const id = await owner.mutation(api.partnerships.create, { company: "us", name: "A", type: "referral" });
    expect((await call(t, token, "partner_move", { id, stage: "won" })).isError).toBe(true);
    await owner.mutation(api.partnerships.remove, { id });
    expect((await call(t, token, "partner_move", { id, stage: "live" })).said).toBe(PARTNER_GONE);
  });

  test("a read-only token moves nothing", async () => {
    const { t, owner, token } = await world("read");
    const id = await owner.mutation(api.partnerships.create, { company: "us", name: "A", type: "referral" });
    expect((await call(t, token, "partner_move", { id, stage: "live" })).said).toBe(AGENT_WORDS.readOnly);
  });
});

describe("overview", () => {
  test("lists partners gone quiet with a next step overdue, by count and never by name", async () => {
    const { t, token } = await world("read");
    await t.run(async (ctx) => {
      await ctx.db.insert("partners", {
        company: "us",
        name: "NEVER NAMED PARTNER",
        type: "channel",
        stage: "in_talks",
        order: 0,
        lastActivityAt: NOW - 30 * DAY,
        nextStepOn: "2026-10-01",
      });
    });
    const out = await answer(t, token, "overview", { company: "us", today: TODAY });
    const items = out.items as { id: string; title: string; href: string }[];
    expect(items.find((item) => item.id === "quiet-partners:us")).toMatchObject({
      title: "1 Startup partner has gone quiet with a next step overdue",
      href: "/partnerships",
    });
    expect(JSON.stringify(out)).not.toContain("NEVER NAMED");
  });
});
