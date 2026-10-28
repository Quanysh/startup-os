import { describe, expect, test } from "vitest";
import {
  CONTACT_PUSH_SCOPES,
  CONTACT_PUSH_WORDS,
  isAutomatedAddress,
  isContactPushSource,
  isOwnAddress,
  looksLikePatientRow,
  parseContactPush,
  teamFilter,
} from "./contactPush";
import { MAX_CONTACT_PUSH_ROWS } from "./limits";

// Every person, address and id here is made up. A value that must never be
// echoed in an issue carries SECRET.

const NOW = Date.UTC(2026, 9, 14, 6);

const person = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  name: "Jane Example",
  emails: ["Jane.Example@Fund.TEST"],
  ...over,
});

const issuesOf = (result: ReturnType<typeof parseContactPush>) => (result.ok ? [] : result.issues);

describe("contact push scopes", () => {
  test("Visible and Apollo carry contacts on Startup, and neither may send a phone number", () => {
    expect(isContactPushSource("visible")).toBe(true);
    expect(isContactPushSource("apollo")).toBe(true);
    expect(isContactPushSource("mercury")).toBe(false);
    expect(isContactPushSource("client_register")).toBe(false);
    expect(CONTACT_PUSH_SCOPES.visible).toMatchObject({
      company: "us",
      category: "investor",
      link: "investor",
      phone: false,
      status: "visible_contacts",
    });
    expect(CONTACT_PUSH_SCOPES.apollo).toMatchObject({
      company: "us",
      category: "customer",
      link: null,
      phone: false,
      status: "apollo_contacts",
    });
  });
});

describe("parseContactPush", () => {
  test("cleans a whole row: addresses lower case and unique, the day as a UTC time", () => {
    const result = parseContactPush(
      "visible",
      [
        person("v-1", {
          emails: ["Jane.Example@Fund.TEST", "jane.example@fund.test", "jane@other.test"],
          title: " Partner ",
          org: "Example Capital",
          linkedin: "https://www.linkedin.com/in/jane-example",
          lastContactAt: "2026-10-01",
          linkedExternalId: "inv-1",
        }),
        person("v-2", { name: "Dana Sample", emails: [] }),
      ],
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          externalId: "v-1",
          name: "Jane Example",
          emails: ["jane.example@fund.test", "jane@other.test"],
          title: "Partner",
          org: "Example Capital",
          linkedin: "https://www.linkedin.com/in/jane-example",
          lastContactAt: Date.UTC(2026, 9, 1),
          linkedExternalId: "inv-1",
          company: "us",
        },
        { externalId: "v-2", name: "Dana Sample", emails: [], company: "us" },
      ],
      excluded: 0,
      dropped: 0,
    });
  });

  test("a field the OS does not take, or a missing one, refuses the row in fixed words", () => {
    const result = parseContactPush(
      "apollo",
      [person("a-1", { notes: "SECRET note" }), { externalId: "a-2", name: "Dana Sample" }],
      NOW,
    );
    const issues = issuesOf(result);
    expect(issues).toEqual([
      { path: "contacts.0", message: "has a field the OS does not accept" },
      { path: "contacts.1.emails", message: "is missing or of the wrong type" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
    expect(JSON.stringify(issues)).not.toContain("notes");
  });

  test("a phone number is refused from every token but the Kazakhstan CRM's", () => {
    for (const source of ["visible", "apollo", "gmail", "google_calendar", "fireflies"] as const) {
      const issues = issuesOf(parseContactPush(source, [person("p-1", { phone: "+1 555 010 0199" })], NOW));
      expect(issues).toEqual([{ path: "contacts.0.phone", message: CONTACT_PUSH_WORDS.noPhone }]);
    }
  });

  test("Apollo's contacts link to nothing: a linked id is refused", () => {
    const issues = issuesOf(parseContactPush("apollo", [person("a-1", { linkedExternalId: "acct-1" })], NOW));
    expect(issues).toEqual([{ path: "contacts.0.linkedExternalId", message: CONTACT_PUSH_WORDS.noLink }]);
  });

  test("a bad address, a name or title that is an address, and a bad LinkedIn are refused without the value", () => {
    const issues = issuesOf(
      parseContactPush(
        "visible",
        [
          person("v-1", { emails: ["SECRET-not-an-address"] }),
          person("v-2", { name: "secret.person@fund.test", emails: [] }),
          person("v-3", { title: "Call 555-010-0199", emails: [] }),
          person("v-4", { org: "SECRET@fund.test", emails: [] }),
          person("v-5", { linkedin: "javascript:SECRET", emails: [] }),
          person("v-6", { name: "  ", emails: [] }),
        ],
        NOW,
      ),
    );
    expect(issues).toEqual([
      { path: "contacts.0.emails.0", message: CONTACT_PUSH_WORDS.badEmail },
      { path: "contacts.1.name", message: CONTACT_PUSH_WORDS.detail },
      { path: "contacts.2.title", message: CONTACT_PUSH_WORDS.detail },
      { path: "contacts.3.org", message: CONTACT_PUSH_WORDS.detail },
      { path: "contacts.4.linkedin", message: CONTACT_PUSH_WORDS.badLinkedin },
      { path: "contacts.5.name", message: CONTACT_PUSH_WORDS.badName },
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  test("more than eight addresses on one person is refused", () => {
    const emails = Array.from({ length: 9 }, (_, i) => `p${i}@fund.test`);
    const issues = issuesOf(parseContactPush("visible", [person("v-1", { emails })], NOW));
    expect(issues).toEqual([{ path: "contacts.0.emails", message: "is too long or too large" }]);
  });

  test("an id or an address twice in one push, an id with a space, a date that is not one or is ahead", () => {
    const issues = issuesOf(
      parseContactPush(
        "visible",
        [
          person("v-1"),
          person("v-1", { name: "Dana Sample", emails: [] }),
          person("v-3", { name: "Dana Sample", emails: ["JANE.example@fund.test"] }),
          person("v 4", { emails: [] }),
          person("v-5", { emails: [], lastContactAt: "2026-02-30" }),
          person("v-6", { emails: [], lastContactAt: "2026-10-20" }),
        ],
        NOW,
      ),
    );
    expect(issues).toEqual([
      { path: "contacts.1.externalId", message: CONTACT_PUSH_WORDS.repeatedId },
      { path: "contacts.2.emails.0", message: CONTACT_PUSH_WORDS.repeatedEmail },
      { path: "contacts.3.externalId", message: CONTACT_PUSH_WORDS.idSpaces },
      { path: "contacts.4.lastContactAt", message: CONTACT_PUSH_WORDS.badDate },
      { path: "contacts.5.lastContactAt", message: CONTACT_PUSH_WORDS.future },
    ]);
  });

  test("today is not in the future", () => {
    expect(parseContactPush("visible", [person("v-1", { lastContactAt: "2026-10-14" })], NOW).ok).toBe(true);
  });

  test("the row cap is the envelope's", () => {
    expect(MAX_CONTACT_PUSH_ROWS).toBe(2_000);
  });
});

// ── The work tools: people the owner has exchanged mail or held meetings with ──

const mailPerson = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  name: "Dana Sample",
  emails: ["dana@clinic-example.test"],
  lastContactAt: "2026-10-01",
  interactionCount: 3,
  ...over,
});

describe("contact push scopes: the work tools and the Kazakhstan CRM", () => {
  test("Gmail, Calendar and Fireflies carry contacts with no link and no phone; the CRM links its deals", () => {
    for (const source of ["gmail", "google_calendar", "fireflies", "kz_crm"]) {
      expect(isContactPushSource(source)).toBe(true);
    }
    expect(isContactPushSource("linear")).toBe(false);
    expect(CONTACT_PUSH_SCOPES.gmail).toMatchObject({ category: "other", link: null, phone: false, minInteractions: 2, status: "gmail_contacts" });
    expect(CONTACT_PUSH_SCOPES.google_calendar).toMatchObject({ link: null, phone: false, minInteractions: 1, status: "google_calendar_contacts" });
    expect(CONTACT_PUSH_SCOPES.fireflies).toMatchObject({ link: null, phone: false, minInteractions: 1, status: "fireflies_contacts" });
    expect(CONTACT_PUSH_SCOPES.kz_crm).toMatchObject({
      company: "kz",
      category: "kz_clinic",
      link: "deal",
      phone: true,
      status: "kz_crm_contacts",
    });
  });
});

describe("parseContactPush: mail and meetings", () => {
  test("a person the owner wrote to: name, addresses, the last exchange and how many", () => {
    expect(parseContactPush("gmail", [mailPerson("g-1")], NOW)).toEqual({
      ok: true,
      rows: [
        {
          externalId: "g-1",
          name: "Dana Sample",
          emails: ["dana@clinic-example.test"],
          lastContactAt: Date.UTC(2026, 9, 1),
          interactionCount: 3,
          company: "us",
        },
      ],
      excluded: 0,
      dropped: 0,
    });
  });

  test("a title, an organisation, a LinkedIn or a link is not the mail's to send", () => {
    const issues = issuesOf(
      parseContactPush(
        "gmail",
        [
          mailPerson("g-1", { title: "Partner" }),
          mailPerson("g-2", { org: "Example Clinic" }),
          mailPerson("g-3", { linkedin: "jane-example" }),
          mailPerson("g-4", { linkedExternalId: "deal-1" }),
        ],
        NOW,
      ),
    );
    expect(issues).toEqual([
      { path: "contacts.0.title", message: CONTACT_PUSH_WORDS.notThisSource },
      { path: "contacts.1.org", message: CONTACT_PUSH_WORDS.notThisSource },
      { path: "contacts.2.linkedin", message: CONTACT_PUSH_WORDS.notThisSource },
      { path: "contacts.3.linkedExternalId", message: CONTACT_PUSH_WORDS.noLink },
    ]);
  });

  test("a person from mail needs an address and a count; Visible may send neither count nor company", () => {
    const issues = issuesOf(
      parseContactPush("google_calendar", [mailPerson("c-1", { emails: [] }), mailPerson("c-2", { interactionCount: undefined })], NOW),
    );
    expect(issues).toEqual([
      { path: "contacts.0.emails", message: CONTACT_PUSH_WORDS.needsEmail },
      { path: "contacts.1.interactionCount", message: CONTACT_PUSH_WORDS.needsCount },
    ]);
    const visible = issuesOf(
      parseContactPush("visible", [person("v-1", { interactionCount: 2 }), person("v-2", { emails: [], company: "kz" })], NOW),
    );
    expect(visible).toEqual([
      { path: "contacts.0.interactionCount", message: CONTACT_PUSH_WORDS.notThisSource },
      { path: "contacts.1.company", message: CONTACT_PUSH_WORDS.notThisSource },
    ]);
  });

  test("no-reply and notification senders, and the companies' own domains, are left out and counted", () => {
    const result = parseContactPush(
      "gmail",
      [
        mailPerson("g-1", { emails: ["no-reply@service.test"] }),
        mailPerson("g-2", { emails: ["noreply@service.test"] }),
        mailPerson("g-3", { emails: ["notifications@service.test"] }),
        mailPerson("g-4", { emails: ["MAILER-DAEMON@service.test"] }),
        mailPerson("g-5", { emails: ["teammate@team.example.test"] }),
        mailPerson("g-6", { emails: ["teammate@second.example.test"] }),
        mailPerson("g-7", { emails: ["dana@clinic-example.test", "noreply@clinic-example.test"] }),
      ],
      NOW,
    );
    expect(result).toMatchObject({ ok: true, excluded: 6 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.rows.map((row) => [row.externalId, row.emails])).toEqual([["g-7", ["dana@clinic-example.test"]]]);
  });

  test("Gmail needs two exchanges, a meeting one: fewer is left out and counted", () => {
    const gmail = parseContactPush("gmail", [mailPerson("g-1", { interactionCount: 1 }), mailPerson("g-2", { emails: ["b@example.test"] })], NOW);
    expect(gmail).toMatchObject({ ok: true, excluded: 1 });
    const meetings = parseContactPush("fireflies", [mailPerson("f-1", { interactionCount: 1 })], NOW);
    expect(meetings).toMatchObject({ ok: true, excluded: 0 });
    const none = parseContactPush("fireflies", [mailPerson("f-1", { interactionCount: 0 })], NOW);
    expect(none).toMatchObject({ ok: true, excluded: 1, rows: [] });
  });

  test("an address in .kz is Globex's whatever the row says; otherwise the row's company, Startup by default", () => {
    const result = parseContactPush(
      "gmail",
      [
        mailPerson("g-1", { emails: ["a@clinic-example.kz"] }),
        mailPerson("g-2", { emails: ["b@clinic-example.kz"], company: "us" }),
        mailPerson("g-3", { emails: ["c@clinic-example.test"], company: "kz" }),
        mailPerson("g-4", { emails: ["d@clinic-example.test"] }),
      ],
      NOW,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.rows.map((row) => row.company)).toEqual(["kz", "kz", "kz", "us"]);
  });
});

describe("parseContactPush: the Kazakhstan CRM's clinic staff", () => {
  const staff = (externalId: string, over: Record<string, unknown> = {}) => ({
    externalId,
    name: "Aigerim Sample",
    title: "Chief physician",
    emails: ["staff@clinic-example.kz"],
    phone: "+7 701 000 0000",
    linkedExternalId: "crm-deal-1",
    ...over,
  });

  test("a clinic's staff member with a role, an address, a phone and the deal's id", () => {
    expect(parseContactPush("kz_crm", [staff("k-1")], NOW)).toEqual({
      ok: true,
      rows: [
        {
          externalId: "k-1",
          name: "Aigerim Sample",
          title: "Chief physician",
          emails: ["staff@clinic-example.kz"],
          phone: "+7 701 000 0000",
          linkedExternalId: "crm-deal-1",
          company: "kz",
        },
      ],
      excluded: 0,
      dropped: 0,
    });
  });

  test("a row that looks like a patient's record is dropped and counted, never stored and never quoted", () => {
    const result = parseContactPush(
      "kz_crm",
      [
        staff("k-1", { title: "Пациент SECRET" }),
        staff("k-2", { title: "patient" }),
        { ...staff("k-3"), iin: "SECRET" },
        { ...staff("k-4"), birthDate: "1990-01-01" },
        staff("k-5", { name: "Aigerim Sample 900101300123" }),
        staff("k-6", { title: "Diagnosis follow-up" }),
        staff("k-7"),
      ],
      NOW,
    );
    expect(result).toMatchObject({ ok: true, dropped: 6 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.rows.map((row) => row.externalId)).toEqual(["k-7"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("a bad phone number is refused without the value", () => {
    const issues = issuesOf(parseContactPush("kz_crm", [staff("k-1", { phone: "call SECRET" })], NOW));
    expect(issues).toEqual([{ path: "contacts.0.phone", message: CONTACT_PUSH_WORDS.badPhone }]);
  });
});

describe("what a contacts push leaves out", () => {
  test("automated senders by the part before the @, and the companies' own domains and subdomains", () => {
    for (const email of ["no-reply@x.test", "no_reply+42@x.test", "donotreply@x.test", "bounces@x.test", "newsletter@x.test", "calendar-notification@x.test"]) {
      expect(isAutomatedAddress(email)).toBe(true);
    }
    for (const email of ["noreen@x.test", "news.anchor@x.test".replace("news.anchor", "anchor"), "dana@x.test"]) {
      expect(isAutomatedAddress(email)).toBe(false);
    }
    expect(isOwnAddress("someone@team.example.test")).toBe(true);
    expect(isOwnAddress("someone@mail.second.example.test")).toBe(true);
    expect(isOwnAddress("someone@notteam.example.test")).toBe(false);
  });

  test("the team's own addresses, and their firms' domains but never a public provider's", () => {
    const team = teamFilter(["Teammate.One@Gmail.com", "teammate.two@partner-firm.test"]);
    expect(team("teammate.one@gmail.com")).toBe(true);
    expect(team("stranger@gmail.com")).toBe(false);
    expect(team("anyone@partner-firm.test")).toBe(true);
    expect(team("anyone@eu.partner-firm.test")).toBe(true);
    expect(team("anyone@clinic-example.test")).toBe(false);
  });

  test("a patient's record by its words, its national id, or a field named for one", () => {
    expect(looksLikePatientRow({ name: "Aigerim Sample", title: "Пациентка" })).toBe(true);
    expect(looksLikePatientRow({ name: "Aigerim Sample", dateOfBirth: "1990-01-01" })).toBe(true);
    expect(looksLikePatientRow({ name: "Aigerim Sample", title: "Chief physician", phone: "+7 701 000 0000" })).toBe(false);
    expect(looksLikePatientRow({ name: "Aigerim Sample", externalId: "123456789012" })).toBe(false);
    expect(looksLikePatientRow("not a row")).toBe(false);
  });
});

describe("one-company mode", () => {
  test("a person from mail is Startup's, and one placed at the second company is refused", async () => {
    const features = await import("./features");
    const saved = features.FEATURES.secondCompany;
    (features.FEATURES as Record<string, boolean>).secondCompany = false;
    try {
      const result = parseContactPush("gmail", [mailPerson("g-1", { emails: ["a@clinic-example.kz"] })], NOW);
      expect(result.ok && result.rows[0]?.company).toBe("us");
      expect(issuesOf(parseContactPush("gmail", [mailPerson("g-2", { company: "kz" })], NOW))).toEqual([
        { path: "contacts.0.company", message: CONTACT_PUSH_WORDS.companyOff },
      ]);
    } finally {
      (features.FEATURES as Record<string, boolean>).secondCompany = saved;
    }
  });
});
