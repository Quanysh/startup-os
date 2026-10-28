import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS } from "./lib/agentRules";
import type { BotPermission } from "./lib/botRules";
import { CONTACT_WORDS } from "./lib/contacts";
import { TOOLS } from "./lib/mcpTools";
import { ENTROPY, NOW, answer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";

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
  test("contacts and contact_intro_paths read; the three contact changes act", () => {
    const kinds = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.kind]));
    expect(kinds).toMatchObject({
      contacts: "read",
      contact_intro_paths: "read",
      contact_upsert: "act",
      contact_link: "act",
      contact_merge: "act",
    });
  });
});

describe("contacts", () => {
  test("is the page's list for one company or both", async () => {
    const { t, owner, token } = await world("read");
    await owner.mutation(api.contacts.upsert, { company: "us", name: "Startup Person", emails: ["startup@example.test"] });
    await owner.mutation(api.contacts.upsert, { company: "kz", name: "Globex Person", category: "kz_clinic" });
    const us = await owner.query(api.contacts.list, { company: "us" });
    const both = await owner.query(api.contacts.list, {});
    expect(await answer(t, token, "contacts", { company: "us" })).toEqual({
      truncated: false,
      contacts: asJson(us.contacts),
      nextCursor: us.nextCursor,
      withheld: [],
    });
    expect(await answer(t, token, "contacts")).toMatchObject({
      truncated: false,
      contacts: asJson(both.contacts),
    });
  });

  test("a read-only client cannot change a contact", async () => {
    const { t, token } = await world("read");
    expect((await call(t, token, "contact_upsert", { company: "us", name: "No" })).said).toBe(AGENT_WORDS.readOnly);
    expect((await call(t, token, "contact_link", { contactId: "x", type: "deal", id: "y", linked: true })).said).toBe(
      AGENT_WORDS.readOnly,
    );
    expect((await call(t, token, "contact_merge", { dryRun: true })).said).toBe(AGENT_WORDS.readOnly);
  });
});

describe("contact_upsert, contact_link, contact_merge, contact_intro_paths", () => {
  test("adds by email, links a deal, and says who can introduce", async () => {
    const { t, owner, token } = await world();
    const made = await answer(t, token, "contact_upsert", {
      company: "us",
      name: "Dr. Jane Smith, MD",
      emails: ["Jane@initech.test"],
      org: "Initech Health",
      category: "advisor",
      canIntroTo: ["board"],
      lastContactAt: NOW,
    });
    expect(made).toMatchObject({ created: true, updated: false });
    const again = await answer(t, token, "contact_upsert", {
      company: "us",
      name: "Jane Smith",
      org: "Initech Health",
      emails: ["also@initech.test"],
    });
    expect(again).toMatchObject({ id: made.id, created: false, updated: true });
    const deal = await owner.mutation(api.deals.create, { market: "us", name: "Made-up Clinic" });
    expect(await answer(t, token, "contact_link", { contactId: made.id, type: "deal", id: deal, linked: true })).toMatchObject({
      id: made.id,
      linked: true,
    });
    const linked = await owner.query(api.contacts.forRecord, { type: "deal", id: deal });
    expect(linked.map((row) => row.emails)).toEqual([["jane@initech.test", "also@initech.test"]]);
    const target = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "Cara Target",
      org: "Board Co",
      introducedBy: made.id as string,
    });
    const idsOf = (contacts: unknown) => (contacts as { id: string }[]).map((row) => row.id);
    const paths = await answer(t, token, "contact_intro_paths", { target: "board", company: "us" });
    expect(idsOf(paths.contacts)).toEqual([made.id]);
    expect(idsOf((await answer(t, token, "contact_intro_paths", { target: target.id, company: "us" })).contacts)).toEqual([
      made.id,
    ]);
    expect((await answer(t, token, "contact_intro_paths", { target: "nobody", company: "us" })).contacts).toEqual([]);
    expect((await answer(t, token, "contact_intro_paths", { company: "us" })).contacts).toEqual([]);
  });

  test("a dry run lists the same name and writes nothing", async () => {
    const { t, owner, token } = await world();
    await owner.mutation(api.contacts.upsert, { company: "us", name: "Dr. Jane Smith", org: "One" });
    await owner.mutation(api.contacts.upsert, { company: "us", name: "Jane Smith, MD", org: "Two" });
    const dry = await answer(t, token, "contact_merge", { dryRun: true, company: "us" });
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates).toEqual([
      expect.objectContaining({ reason: "name", company: "us" }),
    ]);
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(2);
  });

  test("merges two contacts", async () => {
    const { t, owner, token } = await world();
    const keep = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "Keep Person",
      emails: ["keep@x.test"],
    });
    const absorbed = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "Absorbed Person",
      emails: ["absorbed@x.test"],
      org: "Initech",
    });
    expect(
      await answer(t, token, "contact_merge", { keepId: keep.id, mergeId: absorbed.id }),
    ).toMatchObject({ dryRun: false, id: keep.id, merged: absorbed.id });
    expect(await owner.query(api.contacts.get, { id: keep.id })).toMatchObject({
      emails: ["keep@x.test", "absorbed@x.test"],
      org: "Initech",
    });
    await expect(owner.query(api.contacts.get, { id: absorbed.id })).rejects.toThrow(CONTACT_WORDS.gone);
  });
});

// A bot computes as a teammate holding its own areas (`memberAsBot`): it reads
// contacts only with Contacts, a linked record's name only with that record's
// page, and an email address, a phone number or a LinkedIn only with write on
// Contacts. Made-up people and addresses.
describe("a bot reads contacts as its own permissions allow", () => {
  async function bots() {
    const { t, owner, token: mac } = await world();
    const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
    await owner.mutation(api.bots.addSuggested, {});
    const give = async (botId: string, permissions: BotPermission[]) => {
      const bot = (await t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === botId)!;
      await owner.mutation(api.bots.update, { id: bot._id as Id<"bots">, permissions });
    };
    const deal = await owner.mutation(api.deals.create, { market: "us", name: "SECRET Deal Clinic" });
    const introducer = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "Made-up Introducer",
      org: "Example Org",
      canIntroTo: ["example board"],
      emails: ["secret.introducer@example.test"],
      phone: "+1 555 0100",
      linkedin: "made-up-introducer",
    });
    await owner.mutation(api.contacts.link, { contactId: introducer.id, type: "deal", id: deal, linked: true });
    return { t, owner, mac, grok: grok.token, give, deal, introducer };
  }
  const SECRETS = /secret\.introducer@example\.test|555 0100|made-up-introducer/;

  test("with read on Contacts: names, organisation and links, never an address, a number or a LinkedIn", async () => {
    const { t, grok, give } = await bots();
    await give("research", [{ area: "contacts", level: "read" }]);
    const list = await call(t, grok, "contacts", { agent: "research", company: "us" });
    expect(list.output.contacts).toHaveLength(1);
    expect(list.output.contacts[0]).toMatchObject({
      name: "Made-up Introducer",
      org: "Example Org",
      category: "other",
      linkedRecords: [expect.objectContaining({ type: "deal", name: null })],
    });
    for (const key of ["emails", "phone", "linkedin"]) expect(list.output.contacts[0]).not.toHaveProperty(key);
    expect(list.output.withheld).toEqual(["emails", "phone", "linkedin"]);
    expect(JSON.stringify(list.output)).not.toMatch(SECRETS);
    expect(JSON.stringify(list.output)).not.toContain("SECRET Deal Clinic");
    // Nor can it confirm an address by searching for it.
    const probe = await call(t, grok, "contacts", { agent: "research", query: "secret.introducer@example.test" });
    expect(probe.output.contacts).toEqual([]);
    const paths = await call(t, grok, "contact_intro_paths", { agent: "research", target: "example board" });
    expect(paths.output.contacts.map((row: { name: string }) => row.name)).toEqual(["Made-up Introducer"]);
    expect(JSON.stringify(paths.output)).not.toMatch(SECRETS);
  });

  test("with the deal's page too, the linked deal is named", async () => {
    const { t, grok, give } = await bots();
    await give("research", [
      { area: "contacts", level: "read" },
      { area: "sales", level: "read" },
    ]);
    const list = await call(t, grok, "contacts", { agent: "research", company: "us" });
    expect(list.output.contacts[0].linkedRecords).toEqual([expect.objectContaining({ name: "SECRET Deal Clinic" })]);
  });

  test("with write on Contacts: the addresses, the number and the LinkedIn", async () => {
    const { t, grok, give } = await bots();
    await give("research", [{ area: "contacts", level: "write" }]);
    const list = await call(t, grok, "contacts", { agent: "research", company: "us" });
    expect(list.output.contacts[0]).toMatchObject({
      emails: ["secret.introducer@example.test"],
      phone: "+1 555 0100",
      linkedin: "made-up-introducer",
    });
    expect(list.output.withheld).toEqual([]);
  });

  test("without Contacts: refused, and nothing of a contact in the refusal", async () => {
    const { t, grok, give } = await bots();
    await give("research", [{ area: "sales", level: "write" }]);
    for (const tool of ["contacts", "contact_intro_paths"]) {
      const got = await call(t, grok, tool, { agent: "research", target: "example board" });
      expect(got.output).toBeNull();
      expect(got.refusal).toMatchObject({ code: "not_permitted", area: "contacts" });
      expect(got.text).not.toMatch(SECRETS);
      expect(got.text).not.toContain("Made-up Introducer");
    }
    const write = await call(t, grok, "contact_upsert", { agent: "research", company: "us", name: "Nope" });
    expect(write.refusal).toMatchObject({ code: "not_permitted", area: "contacts", need: "write" });
  });

  test("a bot with Contacts but not the deal's page cannot link one", async () => {
    const { t, grok, give, introducer, deal } = await bots();
    await give("research", [{ area: "contacts", level: "write" }]);
    const got = await call(t, grok, "contact_link", { agent: "research", contactId: introducer.id, type: "deal", id: deal, linked: false });
    expect(got.isError).toBe(true);
    expect(got.said).not.toMatch(SECRETS);
  });

  test("the owner's own client, naming no bot, is sent everything", async () => {
    const { t, mac } = await bots();
    const list = await answer(t, mac, "contacts", { company: "us" });
    expect(JSON.stringify(list)).toMatch(SECRETS);
    expect(list.withheld).toEqual([]);
  });
});
