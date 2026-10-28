import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_WORDS } from "./lib/contacts";
import { MAX_NOTES_LENGTH } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

const NOW = Date.UTC(2026, 9, 14, 6);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};
type Owner = Awaited<ReturnType<typeof start>>["owner"];

const add = (
  owner: Owner,
  over: {
    id?: Id<"contacts">;
    company?: "us" | "kz";
    name?: string;
    emails?: string[];
    org?: string | null;
    category?: "investor" | "partner" | "customer" | "advisor" | "kz_clinic" | "vendor" | "other";
    owner?: string | null;
    notes?: string | null;
    canIntroTo?: string[];
    introducedBy?: string | null;
    lastContactAt?: number | null;
    interactionCount?: number;
  } = {},
) =>
  owner.mutation(api.contacts.upsert, {
    company: "us",
    name: "Jane Example",
    ...over,
  });

const messageOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected a refusal");
};

describe("contacts: company and email", () => {
  test("an address is unique inside a company and may exist on the other", async () => {
    const { owner } = await start();
    const first = await add(owner, { emails: ["Dana.Example@clinic.test"], name: "Dana Example" });
    const again = await add(owner, { emails: ["dana.example@clinic.test"], name: "Someone Else" });
    expect(again).toMatchObject({ id: first.id, created: false });
    const other = await add(owner, { company: "kz", emails: ["dana.example@clinic.test"], name: "Dana Example" });
    expect(other.created).toBe(true);
    const us = await owner.query(api.contacts.list, { company: "us" });
    expect(us.contacts).toHaveLength(1);
    expect(us.contacts[0]).toMatchObject({
      name: "Someone Else",
      emails: ["dana.example@clinic.test"],
      normalizedName: "someone else",
    });
  });

  test("a person on Startup alone is refused Globex's contacts", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const made = await add(owner, { company: "kz", name: "Globex Person" });
    const us = await signInWithAreas(t, "sales", ["contacts"], ["us"]);
    await expect(us.query(api.contacts.list, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(us.query(api.contacts.get, { id: made.id })).rejects.toThrow("not_allowed");
    await expect(us.mutation(api.contacts.upsert, { company: "kz", name: "Sneak" })).rejects.toThrow("not_allowed");
    await expect(us.mutation(api.contacts.addNote, { id: made.id, text: "Sneak" })).rejects.toThrow("not_allowed");
    expect(await us.query(api.contacts.list, {})).toMatchObject({ contacts: [] });
  });

  test("giving another contact an address already held is refused, and the address is not in the error", async () => {
    const { owner } = await start();
    const probe = "probe-address@example.test";
    await add(owner, { emails: [probe], name: "First Person" });
    const second = await add(owner, { emails: ["second@example.test"], name: "Second Person" });
    const said = await messageOf(add(owner, { id: second.id, emails: [probe] }));
    expect(said).toContain(CONTACT_WORDS.emailTaken);
    expect(said).not.toContain(probe);
  });
});

describe("contacts: matching", () => {
  test("an address matches before the name, and addresses are united", async () => {
    const { owner } = await start();
    const first = await add(owner, {
      name: "Dr. Jane Smith, MD",
      org: "Initech Health",
      emails: ["jane@initech.test"],
    });
    expect(first.created).toBe(true);
    const byName = await add(owner, { name: "Jane Smith", org: "Initech Health", emails: ["also@initech.test"] });
    expect(byName).toMatchObject({ id: first.id, created: false });
    const byEmail = await add(owner, {
      name: "Different Name",
      org: "Other Org",
      emails: ["jane@initech.test", "third@initech.test"],
    });
    expect(byEmail.id).toBe(first.id);
    const card = await owner.query(api.contacts.get, { id: first.id });
    expect(card).toMatchObject({
      name: "Different Name",
      org: "Other Org",
      normalizedName: "different name",
      emails: ["jane@initech.test", "also@initech.test", "third@initech.test"],
    });
  });

  test("addresses on two contacts are refused, and two people with the same name need an id", async () => {
    const { t, owner } = await start();
    const a = await add(owner, { name: "Ann One", emails: ["ann@one.test"] });
    const b = await add(owner, { name: "Bea Two", emails: ["bea@two.test"] });
    await expect(
      add(owner, { name: "Either", emails: ["ann@one.test", "bea@two.test"] }),
    ).rejects.toThrow(CONTACT_WORDS.emailConflict);
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", {
        name: "Ann One",
        emails: [],
        company: "us",
        category: "other",
        linkedRecords: [],
        canIntroTo: [],
        interactionCount: 0,
        normalizedName: "ann one",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    await expect(add(owner, { name: "Ann One" })).rejects.toThrow(CONTACT_WORDS.nameConflict);
    const ids = (await owner.query(api.contacts.list, { company: "us" })).contacts.map((row) => row.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  test("a contact stays with its company, and an introduction is a contact of that company", async () => {
    const { owner } = await start();
    const us = await add(owner, { name: "Us Person" });
    const kz = await add(owner, { company: "kz", name: "Kz Person" });
    await expect(owner.mutation(api.contacts.upsert, { id: us.id, company: "kz" })).rejects.toThrow(
      CONTACT_WORDS.stays,
    );
    await expect(
      owner.mutation(api.contacts.upsert, { id: us.id, introducedBy: kz.id }),
    ).rejects.toThrow(CONTACT_WORDS.sameCompanyIntro);
    await expect(
      owner.mutation(api.contacts.upsert, { id: us.id, introducedBy: us.id }),
    ).rejects.toThrow(CONTACT_WORDS.selfIntro);
  });
});

describe("contacts: categories by company", () => {
  test("Customer is refused on Globex and Clinic on Startup, new or edited", async () => {
    const { owner } = await start();
    await expect(add(owner, { company: "kz", name: "Kz Buyer", category: "customer" })).rejects.toThrow(
      CONTACT_WORDS.categoryCompany,
    );
    await expect(add(owner, { name: "Us Doctor", category: "kz_clinic" })).rejects.toThrow(
      CONTACT_WORDS.categoryCompany,
    );
    const us = await add(owner, { name: "Us Buyer", category: "customer" });
    const kz = await add(owner, { company: "kz", name: "Kz Doctor", category: "kz_clinic" });
    await expect(owner.mutation(api.contacts.upsert, { id: us.id, category: "kz_clinic" })).rejects.toThrow(
      CONTACT_WORDS.categoryCompany,
    );
    await expect(owner.mutation(api.contacts.upsert, { id: kz.id, category: "customer" })).rejects.toThrow(
      CONTACT_WORDS.categoryCompany,
    );
  });
});

describe("contacts: notes", () => {
  test("a note is added on top of what is there, and only to a contact of the caller's company", async () => {
    const { t, owner } = await start();
    const made = await add(owner, { name: "Noted Person", notes: "Earlier words" });
    await owner.mutation(api.contacts.addNote, { id: made.id, text: "Asked for pricing" });
    const row = await t.run((ctx) => ctx.db.get(made.id));
    expect(row?.notes).toMatch(/^\d{4}-\d{2}-\d{2} — Asked for pricing\n\nEarlier words$/);
    await expect(owner.mutation(api.contacts.addNote, { id: made.id, text: " " })).rejects.toThrow(
      CONTACT_WORDS.noteEmpty,
    );
  });
});

describe("contacts: links", () => {
  test("links a record of the same company and leaves its free-text contact alone", async () => {
    const { t, owner } = await start();
    const investor = await owner.mutation(api.investors.create, { name: "Made-up Fund", contact: "Free text person" });
    const deal = await owner.mutation(api.deals.create, { market: "us", name: "Made-up Clinic", contact: "Deal person" });
    const partner = await owner.mutation(api.partnerships.create, {
      company: "us",
      name: "Made-up Partner",
      type: "channel",
      contact: "Partner person",
      contactRole: "Buyer",
    });
    const contact = await add(owner, { name: "Linked Person", category: "investor" });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "investor", id: investor, linked: true });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: deal, linked: true });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "partner", id: partner, linked: true });
    const linked = await owner.query(api.contacts.forRecord, { type: "investor", id: investor });
    expect(linked.map((row) => row.name)).toEqual(["Linked Person"]);
    const stored = await t.run(async (ctx) => ({
      investor: await ctx.db.get(investor),
      deal: await ctx.db.get(deal),
      partner: await ctx.db.get(partner),
    }));
    expect(stored.investor?.contact).toBe("Free text person");
    expect(stored.deal?.contact).toBe("Deal person");
    expect(stored.partner).toMatchObject({ contact: "Partner person", contactRole: "Buyer" });

    // Investors are Startup's: to a Globex contact one is as good as missing.
    const kz = await add(owner, { company: "kz", name: "Kz Person" });
    await expect(
      owner.mutation(api.contacts.link, { contactId: kz.id, type: "investor", id: investor, linked: true }),
    ).rejects.toThrow(CONTACT_WORDS.recordGone);
    await expect(
      owner.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: "missing-deal", linked: true }),
    ).rejects.toThrow(CONTACT_WORDS.recordGone);

    await t.run(async (ctx) => {
      await ctx.db.patch(contact.id, { linkedRecords: [{ type: "deal", id: "gone-deal" }] });
    });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: "gone-deal", linked: false });
    expect((await owner.query(api.contacts.get, { id: contact.id })).linkedRecords).toEqual([]);
  });

  test("an introduction and a linked record are named, and only for a page the caller holds", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const deal = await owner.mutation(api.deals.create, { market: "us", name: "Example Specialty Group" });
    const investor = await owner.mutation(api.investors.create, { name: "Example Ventures" });
    const introducer = await add(owner, { name: "Example Partner B" });
    const contact = await add(owner, { name: "Example Customer C", introducedBy: introducer.id });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: deal, linked: true });
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "investor", id: investor, linked: true });

    const full = await owner.query(api.contacts.get, { id: contact.id });
    expect(full).toMatchObject({ introducedBy: introducer.id, introducedByName: "Example Partner B" });
    expect(full.linkedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "deal", id: deal, name: "Example Specialty Group" }),
        expect.objectContaining({ type: "investor", id: investor, name: "Example Ventures" }),
      ]),
    );
    const listed = await owner.query(api.contacts.list, { company: "us" });
    expect(listed.contacts.find((row) => row.id === contact.id)?.introducedByName).toBe("Example Partner B");

    const contactsOnly = await signInWithAreas(t, "sales", ["contacts"], ["us"]);
    const hidden = await contactsOnly.query(api.contacts.get, { id: contact.id });
    expect(hidden.introducedByName).toBe("Example Partner B");
    expect(hidden.linkedRecords.map((link) => link.name)).toEqual([null, null]);
    expect(JSON.stringify(hidden)).not.toContain("Example Ventures");
    expect(JSON.stringify(hidden)).not.toContain("Example Specialty Group");

    const sales = await signInWithAreas(t, "engineer", ["contacts", "sales"], ["us"]);
    const dealsOnly = await sales.query(api.contacts.get, { id: contact.id });
    expect(dealsOnly.linkedRecords.find((link) => link.type === "deal")?.name).toBe("Example Specialty Group");
    expect(dealsOnly.linkedRecords.find((link) => link.type === "investor")?.name).toBeNull();

    const kz = await add(owner, { company: "kz", name: "Secret Introducer" });
    await t.run(async (ctx) => {
      await ctx.db.patch(contact.id, { introducedBy: kz.id });
    });
    const blocked = await contactsOnly.query(api.contacts.get, { id: contact.id });
    expect(blocked.introducedByName).toBeNull();
    expect(JSON.stringify(blocked)).not.toContain("Secret Introducer");
  });
});

describe("contacts: a linked record is the page's it lives on", () => {
  const records = async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const investor = await owner.mutation(api.investors.create, { name: "SECRET Fund" });
    const usDeal = await owner.mutation(api.deals.create, { market: "us", name: "SECRET US Clinic" });
    // Kazakhstan's deals come from its CRM: one written as the mirror would.
    const kzDeal = await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(usDeal))!;
      void _id;
      void _creationTime;
      return await ctx.db.insert("deals", { ...row, market: "kz", name: "SECRET KZ Clinic" });
    });
    const partner = await owner.mutation(api.partnerships.create, { company: "us", name: "SECRET Partner", type: "channel" });
    const contact = await add(owner, { name: "Linked Person" });
    // A deal id that is no row at all, of the right shape.
    const missingDeal = await owner.mutation(api.deals.create, { market: "us", name: "Gone Clinic" });
    await t.run((ctx) => ctx.db.delete(missingDeal));
    return { t, owner, investor, usDeal, kzDeal, partner, contact, missingDeal };
  };

  test("someone with Contacts alone links nothing and reads no record's contacts, whatever the id", async () => {
    const { t, owner, investor, usDeal, partner, contact, missingDeal } = await records();
    await owner.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: usDeal, linked: true });
    const only = await signInWithAreas(t, "engineer", ["contacts"], ["us"]);
    const tries: [string, string][] = [
      ["investor", investor],
      ["partner", partner],
      ["deal", usDeal],
      ["deal", missingDeal],
      ["deal", "not-an-id"],
    ];
    for (const [type, id] of tries) {
      for (const linked of [true, false]) {
        const said = await messageOf(
          only.mutation(api.contacts.link, { contactId: contact.id, type: type as "deal", id, linked }),
        );
            expect([type, id, linked, said.includes("not_allowed")]).toEqual([type, id, linked, true]);
      }
      expect(await messageOf(only.query(api.contacts.forRecord, { type, id }))).toContain("not_allowed");
    }
    expect((await owner.query(api.contacts.get, { id: contact.id })).linkedRecords).toEqual([
      { type: "deal", id: usDeal, name: "SECRET US Clinic" },
    ]);
  });

  test("with the record's page on one company, another company's record is the same as a missing one", async () => {
    const { t, owner, kzDeal, usDeal, contact, missingDeal } = await records();
    const sales = await signInWithAreas(t, "sales", ["contacts", "sales"], ["us"]);
    const otherCompany = await messageOf(
      sales.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: kzDeal, linked: true }),
    );
    const missing = await messageOf(
      sales.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: missingDeal, linked: true }),
    );
    expect(otherCompany).toContain(CONTACT_WORDS.recordGone);
    expect(missing).toContain(CONTACT_WORDS.recordGone);
    expect(otherCompany).not.toContain("SECRET");
    // Reading who is linked: an empty list for both, never a refusal that tells them apart.
    expect(await sales.query(api.contacts.forRecord, { type: "deal", id: kzDeal })).toEqual([]);
    expect(await sales.query(api.contacts.forRecord, { type: "deal", id: missingDeal })).toEqual([]);
    expect(await sales.query(api.contacts.forRecord, { type: "deal", id: "not-an-id" })).toEqual([]);
    // Their own company's deal links, and is listed.
    await sales.mutation(api.contacts.link, { contactId: contact.id, type: "deal", id: usDeal, linked: true });
    expect((await sales.query(api.contacts.forRecord, { type: "deal", id: usDeal })).map((row) => row.id)).toEqual([
      contact.id,
    ]);
    void owner;
  });

  test("fundraising opens investors and partnerships opens partners, each on its own", async () => {
    const { t, investor, partner, contact } = await records();
    const fundraising = await signInWithAreas(t, "sales", ["contacts", "fundraising"], ["us"]);
    await fundraising.mutation(api.contacts.link, { contactId: contact.id, type: "investor", id: investor, linked: true });
    expect(
      await messageOf(
        fundraising.mutation(api.contacts.link, { contactId: contact.id, type: "partner", id: partner, linked: true }),
      ),
    ).toContain("not_allowed");
    const partnerships = await signInWithAreas(t, "engineer", ["contacts", "partnerships"], ["us"]);
    await partnerships.mutation(api.contacts.link, { contactId: contact.id, type: "partner", id: partner, linked: true });
    expect((await partnerships.query(api.contacts.forRecord, { type: "partner", id: partner })).length).toBe(1);
  });
});

describe("contacts: merge and introductions", () => {
  test("a merge unions the two, keeps the earlier date, and repoints introductions", async () => {
    const { t, owner } = await start();
    vi.setSystemTime(NOW);
    const keep = await add(owner, {
      name: "Keep Person",
      emails: ["keep@x.test"],
      notes: "Kept.",
      canIntroTo: ["board"],
      interactionCount: 2,
      lastContactAt: 1_000,
    });
    vi.setSystemTime(NOW + 5_000);
    const absorbed = await add(owner, {
      name: "Absorbed Person",
      emails: ["absorbed@x.test"],
      org: "Initech",
      notes: "Absorbed.",
      canIntroTo: [keep.id, "clinic"],
      interactionCount: 3,
      lastContactAt: 9_000,
    });
    const introduced = await add(owner, { name: "Introduced Person", introducedBy: absorbed.id, canIntroTo: [absorbed.id] });
    await owner.mutation(api.contacts.upsert, { id: keep.id, introducedBy: absorbed.id });
    const merged = await owner.mutation(api.contacts.merge, { keepId: keep.id, mergeId: absorbed.id });
    expect(merged).toMatchObject({ dryRun: false, id: keep.id, merged: absorbed.id });
    const card = await owner.query(api.contacts.get, { id: keep.id });
    expect(card).toMatchObject({
      emails: ["keep@x.test", "absorbed@x.test"],
      org: "Initech",
      notes: "Kept.\n\nAbsorbed.",
      canIntroTo: ["board", "clinic"],
      introducedBy: null,
      interactionCount: 5,
      lastContactAt: 9_000,
      createdAt: NOW,
    });
    expect(await owner.query(api.contacts.get, { id: introduced.id })).toMatchObject({
      introducedBy: keep.id,
      canIntroTo: [keep.id],
    });
    await expect(owner.query(api.contacts.get, { id: absorbed.id })).rejects.toThrow(CONTACT_WORDS.gone);
    expect(await t.run((ctx) => ctx.db.query("contactEmails").collect())).toHaveLength(2);
  });

  test("a dry run lists a shared name and a shared address, and writes nothing", async () => {
    const { t, owner } = await start();
    await add(owner, { name: "Dr. Jane Smith", org: "One" });
    await add(owner, { name: "Jane Smith, MD", org: "Two" });
    await t.run(async (ctx) => {
      const base = {
        company: "us" as const,
        category: "other" as const,
        linkedRecords: [],
        canIntroTo: [],
        interactionCount: 0,
        normalizedName: "shared email",
        createdAt: NOW,
        updatedAt: NOW,
      };
      await ctx.db.insert("contacts", { ...base, name: "Left", emails: ["shared@x.test"] });
      await ctx.db.insert("contacts", { ...base, name: "Right", emails: ["shared@x.test"] });
    });
    const before = await t.run((ctx) => ctx.db.query("contacts").collect());
    const dry = await owner.mutation(api.contacts.merge, { dryRun: true, company: "us" });
    expect(dry.dryRun).toBe(true);
    if (!dry.dryRun) throw new Error("expected a dry run");
    expect(dry.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "name", company: "us" }),
        expect.objectContaining({ reason: "email", company: "us" }),
      ]),
    );
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(before.length);
  });

  test("notes that will not fit are refused, and two companies are not merged", async () => {
    const { owner } = await start();
    const keep = await add(owner, { name: "Keep", notes: "k".repeat(3_000) });
    const absorbed = await add(owner, { name: "Other", notes: "a".repeat(MAX_NOTES_LENGTH) });
    await expect(owner.mutation(api.contacts.merge, { keepId: keep.id, mergeId: absorbed.id })).rejects.toThrow(
      CONTACT_WORDS.notesTooLong,
    );
    const kz = await add(owner, { company: "kz", name: "Kz" });
    await expect(owner.mutation(api.contacts.merge, { keepId: keep.id, mergeId: kz.id })).rejects.toThrow(
      "not_allowed",
    );
    expect(await owner.query(api.contacts.get, { id: absorbed.id })).toMatchObject({ name: "Other" });
  });

  test("who can introduce is ranked by the last conversation, and another company's id is an empty list", async () => {
    const { owner } = await start();
    const ada = await add(owner, {
      name: "Ada Introducer",
      canIntroTo: ["initech"],
      lastContactAt: 500,
    });
    const target = await add(owner, { name: "Cara Target", org: "Initech Health", introducedBy: ada.id, lastContactAt: 100 });
    await add(owner, { name: "Bea Quiet", canIntroTo: ["Initech Health"] });
    const paths = await owner.query(api.contacts.introPaths, { target: target.id, company: "us" });
    expect(paths.map((row) => row.name)).toEqual(["Ada Introducer", "Bea Quiet"]);
    const t = convexTest(schema, modules);
    const usOwner = await signInAsOwner(t);
    const kz = await add(usOwner, { company: "kz", name: "Kz Only" });
    const us = await signInWithAreas(t, "sales", ["contacts"], ["us"]);
    expect(await us.query(api.contacts.introPaths, { target: kz.id })).toEqual([]);
  });
});

describe("contacts: the list", () => {
  test("searches and filters, and pages in name order", async () => {
    const { owner } = await start();
    await add(owner, { name: "Cara", org: "Initech", category: "advisor", owner: "Dana", emails: ["cara@initech.test"] });
    await add(owner, { name: "Ann", category: "vendor", owner: "Sam" });
    await add(owner, { name: "Bea", company: "kz", category: "advisor" });
    const searched = await owner.query(api.contacts.list, { query: "cara@initech.test" });
    expect(searched.contacts.map((row) => row.name)).toEqual(["Cara"]);
    const advisors = await owner.query(api.contacts.list, { company: "us", category: "advisor", owner: "Dana" });
    expect(advisors.contacts.map((row) => row.name)).toEqual(["Cara"]);
    expect(advisors.owners.sort()).toEqual(["Dana", "Sam"]);
    const page = await owner.query(api.contacts.list, { company: "us", limit: 1 });
    expect(page.contacts.map((row) => row.name)).toEqual(["Ann"]);
    expect(page.nextCursor).toBe("1");
    const next = await owner.query(api.contacts.list, { company: "us", limit: 1, cursor: page.nextCursor! });
    expect(next.contacts.map((row) => row.name)).toEqual(["Cara"]);
  });
});
