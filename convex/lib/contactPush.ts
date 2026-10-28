// Contacts pushed through POST /ingest/v1 (`contacts`, docs/ingest.md
// "Contacts"). Pure: the endpoint, `contacts.applyPush` and `pnpm
// push:envelope` share these rules. A push only ever upserts: a person the
// source no longer lists stays in the book.
//
// What a token may send is fixed here, outside the request, as
// `PIPELINE_OWNERS` fixes the pipelines: which company and category its
// people land in, which fields a row may carry, what they may be linked to,
// and whether a phone number may come with them (the Kazakhstan CRM's alone).
// Every issue is a path and words written here: a row holds a person's name
// and addresses, and an issue is logged and returned. What is left out (a
// no-reply sender, a teammate's address, a row that looks like a patient's)
// is counted, never named.

import { z } from "zod";
import { ConvexError } from "convex/values";
import { companyIds, type CompanyId } from "./company";
import {
  CONTACT_PUSH_SOURCES,
  MAX_CONTACT_EMAILS,
  MAX_CONTACT_TITLE,
  MAX_INTERACTION,
  MAX_LINKEDIN,
  MAX_ORG,
  MAX_PHONE,
  checkLastContactAt,
  cleanContactName,
  cleanEmail,
  cleanPhone,
  type ContactCategory,
  type ContactLinkType,
  type ContactPushSource,
} from "./contacts";
import { looksLikeContactDetail } from "./dealDetails";
import { OWN_EMAIL_DOMAINS } from "./features";
import { fixedWords, type IngestIssue } from "./ingestSchema";
import { MAX_CONTACT_PUSH_ROWS, MAX_EXTERNAL_ID_LENGTH, MAX_NAME_LENGTH } from "./limits";
import { isCanonicalPeriodStart } from "./periods";

export { CONTACT_PUSH_SOURCES, type ContactPushSource };

export const isContactPushSource = (value: string): value is ContactPushSource =>
  (CONTACT_PUSH_SOURCES as readonly string[]).includes(value);

/** The fields a row may carry beside `externalId`, `name` and `emails`, by source. */
export type OptionalField =
  | "title"
  | "org"
  | "linkedin"
  | "phone"
  | "lastContactAt"
  | "linkedExternalId"
  | "interactionCount"
  | "company";

export type ContactStatusSource =
  | "visible_contacts"
  | "apollo_contacts"
  | "gmail_contacts"
  | "google_calendar_contacts"
  | "fireflies_contacts"
  | "kz_crm_contacts";

/** Where a token's people land, what a row of it may say, and the status row its pushes are read on. */
export type ContactPushScope = {
  /** The company its people are on; "by_address" (mail and meetings): `companyOfRow`. */
  company: CompanyId | "by_address";
  /** A new contact's category. One already in the book keeps its own. */
  category: ContactCategory;
  /** The record `linkedExternalId` names, by that record's own source id; null: no link is taken. */
  link: ContactLinkType | null;
  fields: readonly OptionalField[];
  /** Whether a phone number may come with a person: the Kazakhstan CRM's clinic staff only. */
  phone: boolean;
  /** People from mail or meetings: an address and a count are needed, and no-reply and own addresses are left out. */
  mail: boolean;
  /** Fewer exchanges or meetings than this and the person is left out (counted). */
  minInteractions: number;
  /** The source id of the push's run and status rows (Settings › Sources). */
  status: ContactStatusSource;
};

const MAIL_FIELDS: readonly OptionalField[] = ["lastContactAt", "interactionCount", "company"];

export const CONTACT_PUSH_SCOPES: Record<ContactPushSource, ContactPushScope> = {
  // Visible's investors' people, linked to the investor Visible's own push made.
  visible: {
    company: "us",
    category: "investor",
    link: "investor",
    fields: ["title", "org", "linkedin", "lastContactAt", "linkedExternalId"],
    phone: false,
    mail: false,
    minInteractions: 0,
    status: "visible_contacts",
  },
  // The owner's saved Apollo contacts. No Apollo deal or account is in the OS, so they link to nothing.
  apollo: {
    company: "us",
    category: "customer",
    link: null,
    fields: ["title", "org", "linkedin", "lastContactAt"],
    phone: false,
    mail: false,
    minInteractions: 0,
    status: "apollo_contacts",
  },
  // People the owner exchanged mail with: two exchanges or more in twelve months.
  gmail: {
    company: "by_address",
    category: "other",
    link: null,
    fields: MAIL_FIELDS,
    phone: false,
    mail: true,
    minInteractions: 2,
    status: "gmail_contacts",
  },
  // People outside the companies at the owner's meetings in twelve months.
  google_calendar: {
    company: "by_address",
    category: "other",
    link: null,
    fields: MAIL_FIELDS,
    phone: false,
    mail: true,
    minInteractions: 1,
    status: "google_calendar_contacts",
  },
  fireflies: {
    company: "by_address",
    category: "other",
    link: null,
    fields: MAIL_FIELDS,
    phone: false,
    mail: true,
    minInteractions: 1,
    status: "fireflies_contacts",
  },
  // A clinic's staff, from the Kazakhstan CRM, linked to the clinic's deal. Never a patient.
  kz_crm: {
    company: "kz",
    category: "kz_clinic",
    link: "deal",
    fields: ["title", "org", "phone", "lastContactAt", "linkedExternalId"],
    phone: true,
    mail: false,
    minInteractions: 0,
    status: "kz_crm_contacts",
  },
};

export const CONTACT_PUSH_WORDS = {
  notAccepted: "This token does not carry contacts.",
  noPhone: "This token may not send a phone number.",
  noLink: "This source's contacts are not linked to a record in the OS.",
  notThisSource: "This source does not send that field.",
  needsEmail: "A person from mail or meetings needs an email address.",
  needsCount: "A person from mail or meetings needs how many exchanges or meetings there were.",
  companyOff: "This OS is run for one company.",
  badEmail: "Is not an email address.",
  detail: "Looks like an email address or a phone number. Send the person's name, title and organisation as words.",
  badName: "Is not a person's name.",
  badLinkedin: "Is not a LinkedIn address or handle.",
  badPhone: "Is not a phone number.",
  repeatedId: "This id is on an earlier row of the push.",
  repeatedEmail: "This address is on an earlier row of the push.",
  idSpaces: "An id has no spaces.",
  badDate: "Is not a real date (YYYY-MM-DD).",
  future: "Is in the future.",
  wrongScope: "This row is not one this source may send.",
  conflict: "Rows matched more than one contact, or the book was full, and were left out.",
} as const;

const row = z.strictObject({
  /** The source's own id for the person. The key a later push matches on. */
  externalId: z.string().min(1).max(MAX_EXTERNAL_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  emails: z.array(z.string().max(254)).max(MAX_CONTACT_EMAILS),
  title: z.string().max(MAX_CONTACT_TITLE).optional(),
  org: z.string().max(MAX_ORG).optional(),
  linkedin: z.string().max(MAX_LINKEDIN).optional(),
  phone: z.string().max(MAX_PHONE).optional(),
  /** "YYYY-MM-DD": the last time the source records a conversation or a meeting. */
  lastContactAt: z.string().max(10).optional(),
  /** The source's own id for the record this person is at (Visible's investor, the CRM's deal). */
  linkedExternalId: z.string().min(1).max(MAX_EXTERNAL_ID_LENGTH).optional(),
  /** Exchanges or meetings in the twelve months read. */
  interactionCount: z.number().int().min(0).max(MAX_INTERACTION).optional(),
  /** Mail and meetings only: the company the run placed the person at. */
  company: z.enum(["us", "kz"]).optional(),
});

/** A person as the writer receives it: cleaned, addresses lower case, the day as a UTC time, the company decided. */
export type ContactPushRow = {
  externalId: string;
  name: string;
  emails: string[];
  company: CompanyId;
  title?: string;
  org?: string;
  linkedin?: string;
  phone?: string;
  lastContactAt?: number;
  linkedExternalId?: string;
  interactionCount?: number;
};

const HIDDEN = /[\u0000-\u001F\u007F​-‏‪-‮⁠-⁯﻿]/g;
const plain = (value: string) => value.replace(HIDDEN, "").replace(/\s+/g, " ").trim();

const LINKEDIN_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.%-]{0,99}$/;

/** A LinkedIn address on linkedin.com over https, or a bare handle; null for anything else. */
export function pushedLinkedin(value: string): string | null {
  const cleaned = plain(value);
  if (cleaned.includes("://")) {
    try {
      const url = new URL(cleaned);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      return cleaned;
    } catch {
      return null;
    }
  }
  const handle = cleaned.replace(/^@/, "");
  return LINKEDIN_HANDLE.test(handle) ? handle : null;
}

// ── What is left out ────────────────────────────────────────────────────────

/** The part before the @ of an address that never answers: no-reply, notifications, bounces, lists. */
const AUTOMATED_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|news|digest|alerts?|updates|marketing|unsubscribe|calendar-notification)(?:[-+_.].*)?$/i;

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const inDomain = (domain: string, of: string) => domain === of || domain.endsWith(`.${of}`);

/** An address no person answers from (no-reply, notifications, mailer-daemon, a newsletter). */
export const isAutomatedAddress = (email: string): boolean =>
  AUTOMATED_LOCAL.test(email.slice(0, email.lastIndexOf("@")));

/** An address at one of the companies' own domains (`OWN_EMAIL_DOMAINS`): a teammate's. */
export const isOwnAddress = (email: string): boolean =>
  OWN_EMAIL_DOMAINS.some((own) => inDomain(domainOf(email), own));

/** Mail providers anyone may use: a teammate's address there says nothing about anyone else's. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "mail.ru",
  "yandex.ru",
  "yandex.kz",
  "inbox.ru",
  "bk.ru",
  "list.ru",
]);

/**
 * The team's addresses as a contacts push leaves them out: each teammate's
 * and owner's own address, and the domain of each one that is not a public
 * provider's (a teammate at a firm's domain makes that firm the team's).
 */
export function teamFilter(addresses: readonly string[]): (email: string) => boolean {
  const exact = new Set(addresses.map((address) => address.trim().toLowerCase()));
  const domains = [...exact].map(domainOf).filter((domain) => domain !== "" && !PUBLIC_MAIL_DOMAINS.has(domain));
  return (email) => exact.has(email) || domains.some((domain) => inDomain(domainOf(email), domain));
}

/**
 * Words that say a row is about a patient, not a clinic's staff: a patient,
 * a diagnosis, a medical record, a date of birth, a national id (ИИН/IIN, or
 * its twelve digits), in Russian, Kazakh or English.
 */
const PATIENT_WORDS =
  /пациент|науқас|patient|диагноз|diagnos|анамнез|истори[яи] болезни|medical record|medical history|дата рождения|туған күні|date of birth|\bdob\b|\bиин\b|\bжсн\b|\biin\b|полис|insurance policy/i;
const NATIONAL_ID = /(?<!\d)\d{12}(?!\d)/;
const PATIENT_KEYS = /iin|иин|birth|dob|diagnos|patient|пациент|medical|polic|passport|snils|gender|sex$|^age$/i;

/** Whether a raw row looks like a patient's record: such a row is dropped and counted, never stored or quoted. */
export function looksLikePatientRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (PATIENT_KEYS.test(key)) return true;
    if (key === "phone" || key === "emails" || key === "externalId" || key === "linkedExternalId") continue;
    if (typeof field === "string" && (PATIENT_WORDS.test(field) || NATIONAL_ID.test(field))) return true;
  }
  return false;
}

/**
 * A person's company from mail or meetings: Globex's when any address is
 * in `.kz` (and the OS is run for it), else the company the run sent, Startup
 * by default.
 */
function companyOfRow(emails: readonly string[], sent: CompanyId | undefined): CompanyId | "off" {
  const second = companyIds().includes("kz");
  if (second && emails.some((email) => domainOf(email).endsWith(".kz"))) return "kz";
  if (sent === "kz" && !second) return "off";
  return sent ?? "us";
}

// ── One row ─────────────────────────────────────────────────────────────────

/** Optional words that must not be an address or a number; undefined when blank. */
function words(value: string | undefined): string | undefined | "detail" {
  if (value === undefined) return undefined;
  const cleaned = plain(value);
  if (cleaned === "") return undefined;
  return looksLikeContactDetail(cleaned) ? "detail" : cleaned;
}

type RowResult =
  | { ok: true; row: ContactPushRow }
  | { ok: false; issue: IngestIssue }
  | { ok: "excluded" };

function cleanRow(
  scope: ContactPushScope,
  raw: z.infer<typeof row>,
  at: string,
  now: number,
  seen: { ids: Set<string>; emails: Set<string> },
): RowResult {
  const fail = (field: string, message: string): RowResult => ({ ok: false, issue: { path: `${at}.${field}`, message } });

  for (const field of ["title", "org", "linkedin", "phone", "lastContactAt", "linkedExternalId", "interactionCount", "company"] as const) {
    if (raw[field] === undefined || scope.fields.includes(field)) continue;
    if (field === "phone") return fail(field, CONTACT_PUSH_WORDS.noPhone);
    if (field === "linkedExternalId") return fail(field, CONTACT_PUSH_WORDS.noLink);
    return fail(field, CONTACT_PUSH_WORDS.notThisSource);
  }

  if (/\s/.test(raw.externalId)) return fail("externalId", CONTACT_PUSH_WORDS.idSpaces);
  if (seen.ids.has(raw.externalId)) return fail("externalId", CONTACT_PUSH_WORDS.repeatedId);

  if (looksLikeContactDetail(raw.name)) return fail("name", CONTACT_PUSH_WORDS.detail);
  let name: string;
  try {
    name = cleanContactName(raw.name).name;
  } catch {
    return fail("name", CONTACT_PUSH_WORDS.badName);
  }

  if (scope.mail && raw.emails.length === 0) return fail("emails", CONTACT_PUSH_WORDS.needsEmail);
  if (scope.mail && raw.interactionCount === undefined) return fail("interactionCount", CONTACT_PUSH_WORDS.needsCount);

  const emails: string[] = [];
  for (const [index, value] of raw.emails.entries()) {
    let email: string;
    try {
      email = cleanEmail(value);
    } catch {
      return fail(`emails.${index}`, CONTACT_PUSH_WORDS.badEmail);
    }
    if (emails.includes(email)) continue;
    if (seen.emails.has(email)) return fail(`emails.${index}`, CONTACT_PUSH_WORDS.repeatedEmail);
    emails.push(email);
  }

  const title = words(raw.title);
  if (title === "detail") return fail("title", CONTACT_PUSH_WORDS.detail);
  const org = words(raw.org);
  if (org === "detail") return fail("org", CONTACT_PUSH_WORDS.detail);

  let linkedin: string | undefined;
  if (raw.linkedin !== undefined && plain(raw.linkedin) !== "") {
    const cleaned = pushedLinkedin(raw.linkedin);
    if (cleaned === null) return fail("linkedin", CONTACT_PUSH_WORDS.badLinkedin);
    linkedin = cleaned;
  }

  let phone: string | undefined;
  if (raw.phone !== undefined) {
    try {
      phone = cleanPhone(raw.phone);
    } catch {
      return fail("phone", CONTACT_PUSH_WORDS.badPhone);
    }
  }

  let lastContactAt: number | undefined;
  if (raw.lastContactAt !== undefined) {
    if (!isCanonicalPeriodStart("day", raw.lastContactAt)) return fail("lastContactAt", CONTACT_PUSH_WORDS.badDate);
    const [year, month, day] = raw.lastContactAt.split("-").map(Number) as [number, number, number];
    try {
      lastContactAt = checkLastContactAt(Date.UTC(year, month - 1, day), now);
    } catch (error) {
      const future = error instanceof ConvexError && String(error.data).includes("future");
      return fail("lastContactAt", future ? CONTACT_PUSH_WORDS.future : CONTACT_PUSH_WORDS.badDate);
    }
  }

  if (raw.linkedExternalId !== undefined && /\s/.test(raw.linkedExternalId)) {
    return fail("linkedExternalId", CONTACT_PUSH_WORDS.idSpaces);
  }

  let company: CompanyId;
  if (scope.company === "by_address") {
    const decided = companyOfRow(emails, raw.company);
    if (decided === "off") return fail("company", CONTACT_PUSH_WORDS.companyOff);
    company = decided;
  } else {
    company = scope.company;
  }

  seen.ids.add(raw.externalId);
  for (const email of emails) seen.emails.add(email);

  // Mail and meetings: an address no person answers from, or a teammate's, is
  // not a contact's. A person left with none, or with too few exchanges, is
  // left out and counted.
  const kept = scope.mail ? emails.filter((email) => !isAutomatedAddress(email) && !isOwnAddress(email)) : emails;
  if (scope.mail && (kept.length === 0 || (raw.interactionCount ?? 0) < scope.minInteractions)) {
    return { ok: "excluded" };
  }

  return {
    ok: true,
    row: {
      externalId: raw.externalId,
      name,
      emails: kept,
      ...(title === undefined ? null : { title }),
      ...(org === undefined ? null : { org }),
      ...(linkedin === undefined ? null : { linkedin }),
      ...(phone === undefined ? null : { phone }),
      ...(lastContactAt === undefined ? null : { lastContactAt }),
      ...(raw.linkedExternalId === undefined ? null : { linkedExternalId: raw.linkedExternalId }),
      ...(raw.interactionCount === undefined ? null : { interactionCount: raw.interactionCount }),
      company,
    },
  };
}

export type ParsedContactPush =
  | { ok: true; rows: ContactPushRow[]; excluded: number; dropped: number }
  | { ok: false; issues: IngestIssue[] };

/**
 * A push's people, whole or refused: every row is checked and every issue
 * returned, one a row, by path and fixed words. Never a value: not a name,
 * an address, an id or the name of a field the OS does not take. A row that
 * looks like a patient's record is `dropped`; a person from mail or meetings
 * the rules leave out (no-reply, the team's own, too few exchanges) is
 * `excluded`. Both are counts, and neither refuses the push.
 */
export function parseContactPush(source: ContactPushSource, rows: readonly unknown[], now: number): ParsedContactPush {
  if (rows.length === 0) return { ok: false, issues: [{ path: "contacts", message: "An empty list is a failed read." }] };
  if (rows.length > MAX_CONTACT_PUSH_ROWS) {
    return { ok: false, issues: [{ path: "contacts", message: `At most ${MAX_CONTACT_PUSH_ROWS} contacts in one push.` }] };
  }
  const scope = CONTACT_PUSH_SCOPES[source];
  const seen = { ids: new Set<string>(), emails: new Set<string>() };
  const issues: IngestIssue[] = [];
  const out: ContactPushRow[] = [];
  let excluded = 0;
  let dropped = 0;
  for (const [index, value] of rows.entries()) {
    const at = `contacts.${index}`;
    if (looksLikePatientRow(value)) {
      dropped += 1;
      continue;
    }
    const parsed = row.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: [at, ...issue.path].join("."), message: fixedWords(issue) });
      }
      continue;
    }
    const cleaned = cleanRow(scope, parsed.data, at, now, seen);
    if (cleaned.ok === true) out.push(cleaned.row);
    else if (cleaned.ok === "excluded") excluded += 1;
    else issues.push(cleaned.issue);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, rows: out, excluded, dropped };
}
