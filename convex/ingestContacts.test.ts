import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_PUSH_WORDS } from "./lib/contactPush";
import schema from "./schema";
import { OWNER, addMember, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// People pushed into the Contacts book on six sources' own tokens
// (`contacts`, convex/lib/contactPush.ts). Every person, address, phone,
// clinic and id here is made up. What must never be echoed or logged
// carries SECRET, or is an address or a phone number.

// Obviously not real secrets.
const TOKENS = {
  visible: "fake-visible-push-token-0123456789-abcdef",
  apollo: "fake-apollo-push-token-0123456789-abcdefg",
  gmail: "fake-gmail-push-token-0123456789-abcdefgh",
  google_calendar: "fake-calendar-push-token-0123456789-abcd",
  fireflies: "fake-fireflies-push-token-0123456789-abcd",
  kz_crm: "fake-kzcrm-push-token-0123456789-abcdefgh",
  linear: "fake-linear-push-token-0123456789-abcdefg",
} as const;
type Source = keyof typeof TOKENS;

const NOW = Date.UTC(2026, 9, 28, 6);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  for (const [source, token] of Object.entries(TOKENS)) vi.stubEnv(`INGEST_TOKEN_${source.toUpperCase()}`, token);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Reply = { status: number; text: string; body: Record<string, unknown> };
async function push(t: TestBackend, source: Source, contacts: unknown[], extra: Record<string, unknown> = {}): Promise<Reply> {
  const response = await t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKENS[source]}` },
    body: JSON.stringify({
      version: 1,
      source,
      batchId: `${source}-SECRET-batch`,
      observedAt: "2026-10-28T06:00:00Z",
      contacts,
      ...extra,
    }),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const contacts = (t: TestBackend) => t.run((ctx) => ctx.db.query("contacts").collect());
const emailRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("contactEmails").collect());
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const status = (t: TestBackend, source: string) =>
  t.run((ctx) => ctx.db.query("sourceStatus").withIndex("by_source", (q) => q.eq("source", source)).unique());
const logged = async (t: TestBackend) => JSON.stringify([await runs(t), await t.run((ctx) => ctx.db.query("sourceStatus").collect())]);

const investor = (t: TestBackend, externalId: string) =>
  t.run((ctx) =>
    ctx.db.insert("investors", { source: "visible", externalId, name: "Example Capital", stage: "contacted", order: 0 }),
  );
const crmDeal = (t: TestBackend, externalId: string) =>
  t.run((ctx) =>
    ctx.db.insert("deals", { source: "kz_crm", externalId, name: "Example Clinic Almaty", stage: "lead", order: 0, market: "kz" }),
  );

const visiblePerson = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  name: "Jane Example",
  emails: ["jane@fund-example.test"],
  title: "Partner",
  linkedExternalId: "inv-1",
  ...over,
});
const mailPerson = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  name: "Dana Sample",
  emails: ["dana@clinic-example.test"],
  lastContactAt: "2026-10-20",
  interactionCount: 4,
  ...over,
});

describe("contacts from Visible", () => {
  test("lands on Startup as investors, linked to the investor Visible's push made, with counts only in the log", async () => {
    const t = convexTest(schema, modules);
    const fund = await investor(t, "inv-1");
    const reply = await push(t, "visible", [visiblePerson("vc-1"), visiblePerson("vc-2", { name: "Sam Sample", emails: [], linkedExternalId: "inv-unknown" })]);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0, linked: 1, skipped: 0, excluded: 0, dropped: 0 });

    const rows = await contacts(t);
    expect(rows.find((row) => row.externalId === "vc-1")).toMatchObject({
      company: "us",
      category: "investor",
      name: "Jane Example",
      emails: ["jane@fund-example.test"],
      title: "Partner",
      source: "visible",
      linkedRecords: [{ type: "investor", id: fund }],
    });
    expect(rows.find((row) => row.externalId === "vc-2")?.linkedRecords).toEqual([]);
    expect(await emailRows(t)).toHaveLength(1);

    expect(await status(t, "visible_contacts")).toMatchObject({ state: "ok", lastOkAt: NOW });
    // The investor board's own source is not touched by a contacts push.
    expect(await status(t, "visible")).toBeNull();
    const run = (await runs(t)).find((row) => row.source === "visible_contacts");
    expect(run).toMatchObject({ status: "ok", inserted: 2, updated: 0, unchanged: 0, message: "1 linked." });
    expect(run?.batchId).toBeUndefined();
    const log = await logged(t);
    for (const secret of ["SECRET", "@", "Jane", "vc-1", "inv-1"]) expect(log).not.toContain(secret);
  });

  test("a second push of the same people changes nothing; a new address is added to the same row", async () => {
    const t = convexTest(schema, modules);
    await investor(t, "inv-1");
    await push(t, "visible", [visiblePerson("vc-1")]);
    const again = await push(t, "visible", [visiblePerson("vc-1")]);
    expect(again.body).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, linked: 0 });
    const more = await push(t, "visible", [visiblePerson("vc-1", { emails: ["jane.second@fund-example.test"], title: "Managing Partner" })]);
    expect(more.body).toMatchObject({ inserted: 0, updated: 1 });
    const [row, ...rest] = await contacts(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      emails: ["jane@fund-example.test", "jane.second@fund-example.test"],
      title: "Managing Partner",
    });
    expect(await emailRows(t)).toHaveLength(2);
  });

  test("what a person typed is never overwritten, and someone missing from a later push stays", async () => {
    const t = convexTest(schema, modules);
    await investor(t, "inv-1");
    await push(t, "visible", [visiblePerson("vc-1"), visiblePerson("vc-2", { name: "Sam Sample", emails: [] })]);
    const owner = await signInAsOwner(t);
    const id = (await contacts(t)).find((row) => row.externalId === "vc-1")!._id;
    await owner.mutation(api.contacts.upsert, {
      id,
      notes: "Made-up note.",
      owner: "Founder",
      howMet: "A made-up dinner",
      canIntroTo: ["Example Health"],
      category: "advisor",
    });
    await push(t, "visible", [visiblePerson("vc-1", { title: "General Partner" })]);
    const rows = await contacts(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row._id === id)).toMatchObject({
      notes: "Made-up note.",
      owner: "Founder",
      howMet: "A made-up dinner",
      canIntroTo: ["Example Health"],
      category: "advisor",
      title: "General Partner",
    });
  });

  test("a contact typed in by hand is found by its address, filled where empty and claimed, never renamed", async () => {
    const t = convexTest(schema, modules);
    await investor(t, "inv-1");
    const owner = await signInAsOwner(t);
    const made = await owner.mutation(api.contacts.upsert, {
      company: "us",
      name: "J. Example",
      emails: ["JANE@fund-example.test"],
      org: "Typed Capital",
      category: "investor",
    });
    const reply = await push(t, "visible", [visiblePerson("vc-1", { org: "Example Capital" })]);
    expect(reply.body).toMatchObject({ inserted: 0, updated: 1, linked: 1 });
    const [row, ...rest] = await contacts(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      _id: made.id,
      name: "J. Example",
      org: "Typed Capital",
      title: "Partner",
      source: "visible",
      externalId: "vc-1",
    });
  });

  test("one bad row writes nothing, and the issue names a path and fixed words, logged under the contacts source", async () => {
    const t = convexTest(schema, modules);
    const reply = await push(t, "visible", [visiblePerson("vc-1"), visiblePerson("vc-2", { emails: ["SECRET-not-an-address"] })]);
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      ok: false,
      error: "invalid_contacts",
      issues: [{ path: "contacts.1.emails.0", message: CONTACT_PUSH_WORDS.badEmail }],
    });
    expect(await contacts(t)).toEqual([]);
    expect(await status(t, "visible_contacts")).toMatchObject({ state: "error" });
    expect(await status(t, "visible")).toBeNull();
    expect(await logged(t)).not.toContain("SECRET");
  });

  test("replace is refused: a contacts push never removes anyone", async () => {
    const t = convexTest(schema, modules);
    const reply = await push(t, "visible", [visiblePerson("vc-1")], { mode: "replace" });
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ error: "invalid_envelope", issues: [{ path: "mode" }] });
    expect(await contacts(t)).toEqual([]);
  });

  test("addresses that two contacts already hold leave the row out, counted", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.contacts.upsert, { company: "us", name: "One Example", emails: ["one@fund-example.test"] });
    await owner.mutation(api.contacts.upsert, { company: "us", name: "Two Example", emails: ["two@fund-example.test"] });
    const reply = await push(t, "visible", [
      visiblePerson("vc-1", { emails: ["one@fund-example.test", "two@fund-example.test"], linkedExternalId: undefined }),
    ]);
    expect(reply.body).toMatchObject({ ok: true, inserted: 0, updated: 0, skipped: 1 });
    expect((await runs(t)).find((row) => row.source === "visible_contacts")?.message).toContain("1 skipped");
  });
});

describe("contacts from Apollo", () => {
  test("saved contacts are Startup's customers, linked to nothing; a phone number is refused", async () => {
    const t = convexTest(schema, modules);
    const ok = await push(t, "apollo", [
      { externalId: "ap-1", name: "Rae Sample", emails: ["rae@vertical-example.test"], title: "Practice Manager", org: "Example Vertical", linkedin: "rae-sample" },
    ]);
    expect(ok.body).toMatchObject({ ok: true, inserted: 1 });
    expect((await contacts(t))[0]).toMatchObject({ company: "us", category: "customer", source: "apollo", linkedRecords: [], linkedin: "rae-sample" });

    const phone = await push(t, "apollo", [{ externalId: "ap-2", name: "Lee Sample", emails: [], phone: "+1 555 010 0199" }]);
    expect(phone.status).toBe(422);
    expect(phone.body).toMatchObject({ error: "invalid_contacts", issues: [{ path: "contacts.0.phone", message: CONTACT_PUSH_WORDS.noPhone }] });
    expect(await contacts(t)).toHaveLength(1);
    expect(await logged(t)).not.toContain("555");
  });

  test("taken even while the OS reads Apollo with its own key; anything else on the token is refused then", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("APOLLO_API_KEY", "fake-apollo-key");
    const ok = await push(t, "apollo", [{ externalId: "ap-1", name: "Rae Sample", emails: ["rae@vertical-example.test"] }]);
    expect(ok.status).toBe(200);
    const response = await t.fetch("/ingest/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKENS.apollo}` },
      body: JSON.stringify({
        version: 1,
        source: "apollo",
        batchId: "apollo-test",
        observedAt: "2026-10-28T06:00:00Z",
        snapshots: [{ key: "apollo_contacts", scope: "us", period: "week", periodStart: "2026-10-26", value: 1 }],
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "source_is_pulled" });
  });
});

describe("contacts from mail and meetings", () => {
  test("Gmail: the team's own addresses go, a .kz address is Globex's, and no subject could arrive", async () => {
    const t = convexTest(schema, modules);
    await addMember(t, { email: "teammate@partner-firm.test", role: "sales" });
    const reply = await push(t, "gmail", [
      mailPerson("g-1"),
      mailPerson("g-2", { name: "Aigerim Sample", emails: ["aigerim@clinic-example.kz"] }),
      mailPerson("g-3", { name: "Partner Firm Person", emails: ["someone@partner-firm.test"] }),
      mailPerson("g-4", { name: "Robot Sample", emails: ["no-reply@service.test"] }),
      mailPerson("g-5", { name: "One Exchange", emails: ["once@example.test"], interactionCount: 1 }),
    ]);
    expect(reply.body).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0, linked: 0, skipped: 0, excluded: 3, dropped: 0 });
    const rows = await contacts(t);
    expect(rows.map((row) => [row.name, row.company, row.category, row.interactionCount, row.lastContactAt])).toEqual([
      ["Dana Sample", "us", "other", 4, Date.UTC(2026, 9, 20)],
      ["Aigerim Sample", "kz", "other", 4, Date.UTC(2026, 9, 20)],
    ]);
    expect(await status(t, "gmail_contacts")).toMatchObject({ state: "ok" });
    expect(await status(t, "gmail")).toBeNull();

    const subject = await push(t, "gmail", [mailPerson("g-6", { subject: "SECRET subject" })]);
    expect(subject.status).toBe(422);
    expect(subject.text).not.toContain("SECRET");
    expect(subject.text).not.toContain("subject");
  });

  test("Calendar and Fireflies: one meeting is enough, and a later push keeps the newest meeting and the larger count", async () => {
    const t = convexTest(schema, modules);
    await push(t, "google_calendar", [mailPerson("cal-1", { interactionCount: 1, lastContactAt: "2026-10-01" })]);
    const second = await push(t, "fireflies", [mailPerson("ff-1", { interactionCount: 3, lastContactAt: "2026-10-15" })]);
    expect(second.body).toMatchObject({ inserted: 0, updated: 1 });
    const [row, ...rest] = await contacts(t);
    expect(rest).toEqual([]);
    // Calendar made it, so it stays Calendar's; Fireflies only raised what it knows more of.
    expect(row).toMatchObject({ source: "google_calendar", externalId: "cal-1", interactionCount: 3, lastContactAt: Date.UTC(2026, 9, 15) });
    const older = await push(t, "google_calendar", [mailPerson("cal-1", { interactionCount: 2, lastContactAt: "2026-09-01" })]);
    expect(older.body).toMatchObject({ updated: 1 });
    expect((await contacts(t))[0]).toMatchObject({ interactionCount: 2, lastContactAt: Date.UTC(2026, 9, 15) });
  });

  test("a work tool switched off takes no contacts either", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.workTools.turnOff, { source: "fireflies" });
    const reply = await push(t, "fireflies", [mailPerson("ff-1")]);
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ ok: false, error: "source_turned_off" });
    expect(await contacts(t)).toEqual([]);
  });
});

describe("contacts from the Kazakhstan CRM", () => {
  test("a clinic's staff on Globex with a phone, linked to the clinic's deal; a patient's row is dropped and counted", async () => {
    const t = convexTest(schema, modules);
    const dealId: Id<"deals"> = await crmDeal(t, "crm-deal-1");
    const reply = await push(t, "kz_crm", [
      { externalId: "crm-p-1", name: "Aigerim Sample", title: "Chief physician", emails: ["staff@clinic-example.kz"], phone: "+7 701 000 0000", linkedExternalId: "crm-deal-1" },
      { externalId: "crm-p-2", name: "SECRET Patient Sample", title: "Пациент", emails: [] },
      { externalId: "crm-p-3", name: "Someone Sample", iin: "SECRET", emails: [] },
    ]);
    expect(reply.body).toEqual({ ok: true, inserted: 1, updated: 0, unchanged: 0, linked: 1, skipped: 0, excluded: 0, dropped: 2 });
    const [row, ...rest] = await contacts(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      company: "kz",
      category: "kz_clinic",
      title: "Chief physician",
      phone: "+7 701 000 0000",
      linkedRecords: [{ type: "deal", id: dealId }],
      source: "kz_crm",
    });
    const run = (await runs(t)).find((r) => r.source === "kz_crm_contacts");
    expect(run?.message).toBe("1 linked; 2 dropped (looked like a patient's record).");
    const log = await logged(t);
    for (const secret of ["SECRET", "701", "Patient Sample"]) expect(log).not.toContain(secret);
  });
});

describe("who may push contacts", () => {
  test("contacts from a token that carries none are refused", async () => {
    const t = convexTest(schema, modules);
    const reply = await push(t, "linear", [mailPerson("l-1")]);
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      ok: false,
      error: "contacts_not_accepted",
      issues: [{ path: "contacts", message: CONTACT_PUSH_WORDS.notAccepted }],
    });
    expect(await contacts(t)).toEqual([]);
  });

  test("a body naming another source is a mismatch", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/ingest/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKENS.gmail}` },
      body: JSON.stringify({ version: 1, source: "kz_crm", batchId: "x", observedAt: "2026-10-28T06:00:00Z", contacts: [mailPerson("g-1")] }),
    });
    expect(response.status).toBe(403);
    expect(await contacts(t)).toEqual([]);
  });
});

describe("Settings › Sources", () => {
  test("lists the contacts sources; the owner's mail and meetings' are the owner's alone, as the tools themselves are", async () => {
    const t = convexTest(schema, modules);
    await push(t, "visible", [visiblePerson("vc-1", { linkedExternalId: undefined })]);
    await push(t, "gmail", [mailPerson("g-1")]);
    const owner = await signInAsOwner(t);
    const all = (await owner.query(api.sources.list, {})).map((row) => row.id);
    expect(all).toEqual(expect.arrayContaining(["visible_contacts", "gmail_contacts", "kz_crm_contacts"]));
    const holder = await signInWithAreas(t, "engineer", ["settings"]);
    const theirs = (await holder.query(api.sources.list, {})).map((row) => row.id);
    expect(theirs).toContain("visible_contacts");
    expect(theirs).not.toContain("gmail");
    expect(theirs).not.toContain("gmail_contacts");
    expect(theirs).not.toContain("google_calendar_contacts");
    expect(theirs).not.toContain("fireflies_contacts");
    const visible = (await owner.query(api.sources.list, {})).find((row) => row.id === "visible_contacts");
    expect(visible).toMatchObject({ configured: true, fedBy: "push", status: { state: "ok" } });
  });
});
