import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MAX_PARTNER_LINKS, PARTNER_STAGES } from "./lib/partnerStages";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};
type Owner = Awaited<ReturnType<typeof start>>["owner"];

const add = (owner: Owner, over: Record<string, unknown> = {}) =>
  owner.mutation(api.partnerships.create, {
    company: "us",
    name: "Made-up Reseller",
    type: "channel",
    ...over,
  });
const board = (owner: Owner, company: "us" | "kz" = "us") =>
  owner.query(api.partnerships.board, { company });
const names = async (owner: Owner, stage: string, company: "us" | "kz" = "us") =>
  ((await board(owner, company))[stage as never] as { name: string }[]).map((c) => c.name);

describe("partnerships: the board", () => {
  test("has every stage, empty", async () => {
    const { owner } = await start();
    const empty = await board(owner);
    // Convex returns an object's keys sorted: the page draws the stages in its own order.
    expect(Object.keys(empty).sort()).toEqual([...PARTNER_STAGES].sort());
    expect(Object.values(empty).flat()).toEqual([]);
  });

  test("a new partner starts as identified, with an activity date and no one's address", async () => {
    const { owner } = await start();
    await add(owner, { owner: "Ada", contact: "Dana", contactRole: "Head of partnerships" });
    const [card] = (await board(owner)).identified;
    expect(card).toMatchObject({
      company: "us",
      name: "Made-up Reseller",
      type: "channel",
      stage: "identified",
      owner: "Ada",
      contact: "Dana",
      contactRole: "Head of partnerships",
      value: null,
      links: [],
      editedBy: null,
    });
    expect(card!.lastActivityAt).toEqual(expect.any(Number));
  });

  test("each company has its own board", async () => {
    const { owner } = await start();
    await add(owner, { name: "Startup partner" });
    await add(owner, { company: "kz", name: "Globex partner" });
    expect(await names(owner, "identified", "us")).toEqual(["Startup partner"]);
    expect(await names(owner, "identified", "kz")).toEqual(["Globex partner"]);
  });

  test("the same name twice on one board is refused, whatever its capitals", async () => {
    const { owner } = await start();
    await add(owner);
    await expect(add(owner, { name: "  made-up   RESELLER " })).rejects.toThrow(
      "That partner is already on the board.",
    );
    await add(owner, { company: "kz" });
  });
});

describe("partnerships: what is stored", () => {
  test("a blank name, a long name and an unknown type or stage are refused in words", async () => {
    const { owner } = await start();
    await expect(add(owner, { name: "  " })).rejects.toThrow("A partner needs a name.");
    await expect(add(owner, { name: "x".repeat(121) })).rejects.toThrow(
      "That name is too long (120 characters at most).",
    );
    await expect(add(owner, { type: "vendor" })).rejects.toThrow();
    await expect(add(owner, { stage: "won" })).rejects.toThrow("That is not a stage a partner can be moved to.");
  });

  test("no email address or phone number in the contact, role, owner, next step or notes", async () => {
    const { owner } = await start();
    const NO = "Leave email addresses and phone numbers out: a partner names its contact by name and role only.";
    for (const field of ["contact", "contactRole", "owner", "nextStep", "notes"]) {
      await expect(add(owner, { [field]: "dana@example.com" })).rejects.toThrow(NO);
      await expect(add(owner, { [field]: "call +1 415 555 0132" })).rejects.toThrow(NO);
    }
    expect(Object.values(await board(owner)).flat()).toEqual([]);
  });

  test("a value needs to say what it counts, and is bounded", async () => {
    const { owner } = await start();
    await expect(add(owner, { value: 5 })).rejects.toThrow(
      "Say whether the value counts referrals or revenue.",
    );
    await expect(add(owner, { value: 100_001, valueKind: "referrals" })).rejects.toThrow(
      "That value is not a number the OS can store.",
    );
    await expect(add(owner, { value: 1.5, valueKind: "referrals" })).rejects.toThrow(
      "That value is not a number the OS can store.",
    );
    await expect(add(owner, { value: -1, valueKind: "revenue" })).rejects.toThrow(
      "That value is not a number the OS can store.",
    );
    await add(owner, { value: 12, valueKind: "referrals" });
    expect((await board(owner)).identified[0]).toMatchObject({ value: 12, valueKind: "referrals" });
  });

  test("the next step's date is a real calendar day", async () => {
    const { owner } = await start();
    for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "2026-1-1"]) {
      await expect(add(owner, { nextStepOn: bad })).rejects.toThrow("A date is written like 2026-10-18.");
    }
    await add(owner, { nextStepOn: "2026-10-20" });
    expect((await board(owner)).identified[0]!.nextStepOn).toBe("2026-10-20");
  });

  test("links are https addresses with a label, a few at most", async () => {
    const { owner } = await start();
    await expect(add(owner, { links: [{ label: "Site", url: "http://example.com" }] })).rejects.toThrow(
      "A link must be a full https:// address.",
    );
    await expect(add(owner, { links: [{ label: "Site", url: "javascript:alert(1)" }] })).rejects.toThrow(
      "A link must be a full https:// address.",
    );
    const many = Array.from({ length: MAX_PARTNER_LINKS + 1 }, (_, i) => ({
      label: `L${i}`,
      url: `https://example.com/${i}`,
    }));
    await expect(add(owner, { links: many })).rejects.toThrow(
      `A partner has ${MAX_PARTNER_LINKS} links at most.`,
    );
    await add(owner, { links: [{ label: "Site", url: "https://example.com/p" }] });
    expect((await board(owner)).identified[0]!.links).toEqual([
      { label: "Site", url: "https://example.com/p" },
    ]);
  });
});

describe("partnerships: moving and editing", () => {
  test("a move to a stage puts the card there and counts as activity", async () => {
    const { t, owner } = await start();
    const id = await add(owner);
    await t.run((ctx) => ctx.db.patch(id, { lastActivityAt: 1 }));
    await owner.mutation(api.partnerships.move, { id, stage: "in_talks", index: 0 });
    const [card] = (await board(owner)).in_talks;
    expect(card!.name).toBe("Made-up Reseller");
    expect(card!.lastActivityAt).toBeGreaterThan(1);
    expect((await board(owner)).identified).toEqual([]);
  });

  test("a move within a stage reorders and is not activity", async () => {
    const { t, owner } = await start();
    const a = await add(owner, { name: "A" });
    await add(owner, { name: "B" });
    await add(owner, { name: "C" });
    await t.run((ctx) => ctx.db.patch(a, { lastActivityAt: 1 }));
    await owner.mutation(api.partnerships.move, { id: a, stage: "identified", index: 2 });
    expect(await names(owner, "identified")).toEqual(["B", "C", "A"]);
    expect((await board(owner)).identified[2]!.lastActivityAt).toBe(1);
  });

  test("moving closes the gap it leaves and numbers the cards from nothing", async () => {
    const { t, owner } = await start();
    const a = await add(owner, { name: "A" });
    await add(owner, { name: "B" });
    await owner.mutation(api.partnerships.move, { id: a, stage: "live", index: 0 });
    const orders = await t.run(async (ctx) => (await ctx.db.query("partners").collect()).map((p) => [p.name, p.order]));
    expect(Object.fromEntries(orders)).toEqual({ A: 0, B: 0 });
  });

  test("an unknown stage is refused", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await expect(owner.mutation(api.partnerships.move, { id, stage: "won", index: 0 })).rejects.toThrow(
      "That is not a stage a partner can be moved to.",
    );
  });

  test("a changed next step, date or note is activity; a changed owner is not", async () => {
    const { t, owner } = await start();
    const id = await add(owner);
    const reset = () => t.run((ctx) => ctx.db.patch(id, { lastActivityAt: 1 }));
    const activity = async () => (await board(owner)).identified[0]!.lastActivityAt;
    await reset();
    await owner.mutation(api.partnerships.update, { id, owner: "Ada" });
    expect(await activity()).toBe(1);
    for (const edit of [{ nextStep: "Send the deck" }, { nextStepOn: "2026-10-30" }, { notes: "Met at a conference" }]) {
      await reset();
      await owner.mutation(api.partnerships.update, { id, ...edit });
      expect(await activity()).toBeGreaterThan(1);
    }
  });

  test("null clears a field and leaving it out keeps it; clearing the value clears its kind", async () => {
    const { owner } = await start();
    const id = await add(owner, { contact: "Dana", nextStep: "Call", value: 4, valueKind: "revenue" });
    await owner.mutation(api.partnerships.update, { id, contact: null, value: null });
    expect((await board(owner)).identified[0]).toMatchObject({
      contact: null,
      nextStep: "Call",
      value: null,
      valueKind: null,
    });
  });

  test("a change of stage in an edit moves the card to the top of that stage", async () => {
    const { owner } = await start();
    await add(owner, { name: "First", stage: "live" });
    const id = await add(owner, { name: "Second" });
    await owner.mutation(api.partnerships.update, { id, stage: "live" });
    expect(await names(owner, "live")).toEqual(["Second", "First"]);
  });

  test("renaming onto another partner's name is refused", async () => {
    const { owner } = await start();
    await add(owner, { name: "One" });
    const id = await add(owner, { name: "Two" });
    await expect(owner.mutation(api.partnerships.update, { id, name: "one" })).rejects.toThrow(
      "That partner is already on the board.",
    );
  });

  test("a partner can be removed, and a gone one says so", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await owner.mutation(api.partnerships.remove, { id });
    expect(Object.values(await board(owner)).flat()).toEqual([]);
    await expect(owner.mutation(api.partnerships.update, { id, notes: "x" })).rejects.toThrow(
      "That partner is no longer on the board.",
    );
  });
});

describe("partnerships: who may", () => {
  test("a teammate without the area is refused", async () => {
    const t = convexTest(schema, modules);
    const sales = await signInWithAreas(t, "sales", ["sales"], ["us"]);
    await expect(sales.query(api.partnerships.board, { company: "us" })).rejects.toThrow("not_allowed");
  });

  test("a teammate on Startup alone reads and writes Startup's partners and none of Globex's", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const other = await add(owner, { company: "kz", name: "Globex partner" });
    const mine = await signInWithAreas(t, "sales", ["partnerships"], ["us"]);
    await mine.mutation(api.partnerships.create, { company: "us", name: "Ours", type: "referral" });
    expect(Object.values(await mine.query(api.partnerships.board, { company: "us" })).flat()).toHaveLength(1);
    await expect(mine.query(api.partnerships.board, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(
      mine.mutation(api.partnerships.create, { company: "kz", name: "Sneaked", type: "referral" }),
    ).rejects.toThrow("not_allowed");
    await expect(mine.mutation(api.partnerships.update, { id: other, notes: "x" })).rejects.toThrow("not_allowed");
    await expect(mine.mutation(api.partnerships.move, { id: other, stage: "live", index: 0 })).rejects.toThrow("not_allowed");
    await expect(mine.mutation(api.partnerships.remove, { id: other })).rejects.toThrow("not_allowed");
    expect(await names(owner, "identified", "kz")).toEqual(["Globex partner"]);
  });
});
