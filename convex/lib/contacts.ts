// Business contacts of Startup and Globex. Pure: the page, the mutations and
// the owner's agent share these rules. A contact is a person the company works
// with. Nothing here is a patient, and nothing in this file writes a log.

import { ConvexError } from "convex/values";
import { COMPANIES, type CompanyId } from "./company";
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from "./limits";
import { cleanLink } from "./text";

export const CONTACT_CATEGORIES = [
  "investor",
  "partner",
  "customer",
  "advisor",
  "kz_clinic",
  "vendor",
  "other",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const CONTACT_CATEGORY_LABELS: Record<ContactCategory, string> = {
  investor: "Investor",
  partner: "Partner",
  customer: "Customer",
  advisor: "Advisor",
  kz_clinic: "Clinic",
  vendor: "Vendor",
  other: "Other",
};

/**
 * The categories that belong to one company only: a customer is Startup's, a
 * clinic is Globex's. Every other category belongs to both.
 */
const CATEGORY_COMPANY: Partial<Record<ContactCategory, CompanyId>> = {
  customer: "us",
  kz_clinic: "kz",
};

/** Whether a contact of `company` may carry `category`. */
export function categoryFits(category: ContactCategory, company: CompanyId): boolean {
  const only = CATEGORY_COMPANY[category];
  return only === undefined || only === company;
}

/** The categories a contact of `company` may carry, in the list's order. */
export function categoriesFor(company: CompanyId): ContactCategory[] {
  return CONTACT_CATEGORIES.filter((category) => categoryFits(category, company));
}

export const CONTACT_LINK_TYPES = ["investor", "partner", "deal"] as const;
export type ContactLinkType = (typeof CONTACT_LINK_TYPES)[number];

/**
 * The sources that push people into the book (convex/lib/contactPush.ts),
 * stored on a pushed row as `source` beside the source's own `externalId`.
 */
export const CONTACT_PUSH_SOURCES = [
  "visible",
  "apollo",
  "gmail",
  "google_calendar",
  "fireflies",
  "kz_crm",
] as const;
export type ContactPushSource = (typeof CONTACT_PUSH_SOURCES)[number];

export const MAX_CONTACT_EMAILS = 8;
export const MAX_CAN_INTRO = 20;
export const MAX_LINKED_RECORDS = 20;
export const MAX_PHONE = 40;
export const MAX_LINKEDIN = 200;
export const MAX_INTRO_ITEM = 80;
export const MAX_HOW_MET = 240;
export const MAX_ORG = 120;
export const MAX_CONTACT_TITLE = 80;
export const MAX_CONTACT_OWNER = 80;
export const MAX_INTERACTION = 100_000;
export const MAX_CONTACTS = 2_000;
export const LIST_DEFAULT = 25;
export const LIST_MAX = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Courtesy titles dropped from a person's name, as whole words, after folding. */
const NAME_TITLES = new Set(["dr", "md", "mr", "mrs", "ms", "prof", "phd"]);

const HIDDEN = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export const CONTACT_WORDS = {
  gone: "That contact is gone.",
  recordGone: "That record is gone.",
  emailInvalid: "That is not an email address.",
  emailTaken: "That email address is already on a contact of this company.",
  emailConflict: "Those emails are on more than one contact. Merge them first.",
  nameConflict: "More than one contact has that name at that organisation. Pass the contact's id.",
  needsName: "A new contact needs a name.",
  needsCompany: "A new contact needs a company.",
  sameCompanyIntro: "The person who made the introduction is a contact of the same company.",
  selfIntro: "A contact cannot be introduced by itself.",
  tooMany: `A company has ${MAX_CONTACTS} contacts at most.`,
  tooManyEmails: `A contact has ${MAX_CONTACT_EMAILS} email addresses at most.`,
  tooManyTags: `A contact can name ${MAX_CAN_INTRO} introductions at most.`,
  tagTooLong: `An introduction tag is at most ${MAX_INTRO_ITEM} characters.`,
  tooManyLinks: `A contact can be linked to ${MAX_LINKED_RECORDS} records at most.`,
  badCategory: "That is not a contact category.",
  categoryCompany: `Customer is for ${COMPANIES.us.name}'s contacts and Clinic for ${COMPANIES.kz.name}'s.`,
  badLink: "That is not a record a contact can be linked to.",
  needsRecord: "Name the record to filter by.",
  badPhone: "That is not a phone number.",
  badLinkedin: "That is not a LinkedIn address.",
  badDate: "That date is not one the OS can store.",
  future: "That date is too far in the future.",
  badCount: "That count is not a whole number the OS can store.",
  notesTooLong: "The notes together are too long to merge. Shorten one first.",
  noteEmpty: "Write the note first.",
  noteFull: `The notes are full (${MAX_NOTES_LENGTH} characters). Shorten the older ones first.`,
  mergeSame: "Pick two different contacts.",
  mergeNeeds: "Name the contact to keep and the contact to merge into it.",
  badPage: "That is not a page of this list.",
  stays: "A contact stays with its company.",
} as const;

export function isContactCategory(value: unknown): value is ContactCategory {
  return (CONTACT_CATEGORIES as readonly unknown[]).includes(value);
}

export function isContactLinkType(value: unknown): value is ContactLinkType {
  return (CONTACT_LINK_TYPES as readonly unknown[]).includes(value);
}

/** Letters and digits, lower case, accents and punctuation gone. Titles stay. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name contacts are matched on: folded, then courtesy titles dropped
 * (`Dr. Jane Smith, MD` is `jane smith`). An organisation keeps its words
 * (`normalizedOrg`): "MD Anderson" stays.
 */
export function normalizedName(name: string): string {
  return fold(name)
    .split(" ")
    .filter((word) => word !== "" && !NAME_TITLES.has(word))
    .join(" ");
}

export function normalizedOrg(org: string): string {
  return fold(org);
}

function plain(value: string): string {
  return value.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
}

/** One address, lower case. The refusal never repeats what was typed. */
export function cleanEmail(raw: string): string {
  const email = plain(raw).toLowerCase();
  const ok =
    email.length >= 3 &&
    email.length <= 254 &&
    email.includes("@") &&
    !email.includes(" ") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!ok) throw new ConvexError(CONTACT_WORDS.emailInvalid);
  return email;
}

/** The addresses a contact holds: lower case, unique, in the order given. */
export function cleanEmails(list: readonly string[]): string[] {
  if (list.length > MAX_CONTACT_EMAILS) throw new ConvexError(CONTACT_WORDS.tooManyEmails);
  const out: string[] = [];
  for (const raw of list) {
    const email = cleanEmail(raw);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

export function unionEmails(current: readonly string[], added: readonly string[]): string[] {
  const out = [...current];
  for (const email of added) {
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > MAX_CONTACT_EMAILS) throw new ConvexError(CONTACT_WORDS.tooManyEmails);
  return out;
}

/** A person's name, and the folded form it is stored under. */
export function cleanContactName(name: string): { name: string; normalizedName: string } {
  const cleaned = plain(name);
  if (cleaned === "") throw new ConvexError(CONTACT_WORDS.needsName);
  if (cleaned.length > MAX_NAME_LENGTH) {
    throw new ConvexError(`That name is too long (${MAX_NAME_LENGTH} characters at most).`);
  }
  const normalized = normalizedName(cleaned);
  if (normalized === "") throw new ConvexError(CONTACT_WORDS.needsName);
  return { name: cleaned, normalizedName: normalized };
}

function optionalText(value: string | null, max: number, what: string): string | undefined {
  if (value === null) return undefined;
  const cleaned = plain(value);
  if (cleaned.length > max) throw new ConvexError(`${what} is too long (${max} characters at most).`);
  return cleaned === "" ? undefined : cleaned;
}

export const cleanPhone = (value: string | null): string | undefined => {
  if (value === null) return undefined;
  const cleaned = plain(value);
  if (cleaned === "") return undefined;
  if (cleaned.length > MAX_PHONE || !/^[0-9+().\-\s]+$/.test(cleaned)) {
    throw new ConvexError(CONTACT_WORDS.badPhone);
  }
  return cleaned;
};

export function cleanLinkedin(value: string | null): string | undefined {
  if (value === null) return undefined;
  const cleaned = plain(value);
  if (cleaned === "") return undefined;
  if (cleaned.includes("://")) return cleanLink(cleaned, "A LinkedIn address");
  const handle = cleaned.replace(/^@/, "");
  if (handle.length > MAX_LINKEDIN || /\s/.test(handle)) throw new ConvexError(CONTACT_WORDS.badLinkedin);
  return handle;
}

export const cleanOrg = (value: string | null) => optionalText(value, MAX_ORG, "That organisation");
export const cleanContactTitle = (value: string | null) => optionalText(value, MAX_CONTACT_TITLE, "That title");
export const cleanHowMet = (value: string | null) => optionalText(value, MAX_HOW_MET, "How you met");
export const cleanContactOwner = (value: string | null) => optionalText(value, MAX_CONTACT_OWNER, "That owner");
/** Notes keep their line breaks (at most one blank line in a row); each line is tidied like any other text. */
export function cleanContactNotes(value: string | null): string | undefined {
  if (value === null) return undefined;
  const cleaned = value
    .replace(/\t/g, " ")
    .split(/\r\n|\r|\n/)
    .map(plain)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length > MAX_NOTES_LENGTH) {
    throw new ConvexError(`Those notes are too long (${MAX_NOTES_LENGTH} characters at most).`);
  }
  return cleaned === "" ? undefined : cleaned;
}

/**
 * The notes with `text` added on top, after the day it was written: the
 * newest first, each separated by a blank line.
 */
export function withNote(existing: string | undefined, text: string, day: string): string {
  const cleaned = cleanContactNotes(text);
  if (cleaned === undefined) throw new ConvexError(CONTACT_WORDS.noteEmpty);
  const entry = `${day} — ${cleaned}`;
  const notes = existing ? `${entry}\n\n${existing}` : entry;
  if (notes.length > MAX_NOTES_LENGTH) throw new ConvexError(CONTACT_WORDS.noteFull);
  return notes;
}

export function cleanCanIntroTo(list: readonly string[]): string[] {
  if (list.length > MAX_CAN_INTRO) throw new ConvexError(CONTACT_WORDS.tooManyTags);
  const out: string[] = [];
  for (const raw of list) {
    const item = plain(raw);
    if (item === "") continue;
    if (item.length > MAX_INTRO_ITEM) throw new ConvexError(CONTACT_WORDS.tagTooLong);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function checkLastContactAt(value: number, now: number): number {
  if (!Number.isFinite(value) || value < 0) throw new ConvexError(CONTACT_WORDS.badDate);
  if (value > now + DAY_MS) throw new ConvexError(CONTACT_WORDS.future);
  return value;
}

export function checkInteractionCount(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INTERACTION) {
    throw new ConvexError(CONTACT_WORDS.badCount);
  }
  return value;
}

export function checkCategory(value: string): ContactCategory {
  if (!isContactCategory(value)) throw new ConvexError(CONTACT_WORDS.badCategory);
  return value;
}

export type ContactLink = { type: ContactLinkType; id: string };

export function unionLinks(current: readonly ContactLink[], added: readonly ContactLink[]): ContactLink[] {
  const out = [...current];
  for (const link of added) {
    if (!out.some((held) => held.type === link.type && held.id === link.id)) out.push(link);
  }
  if (out.length > MAX_LINKED_RECORDS) throw new ConvexError(CONTACT_WORDS.tooManyLinks);
  return out;
}

/** A page offset, or the refusal for a cursor that is not one. */
export function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new ConvexError(CONTACT_WORDS.badPage);
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new ConvexError(CONTACT_WORDS.badPage);
  return offset;
}

export function listLimit(limit: number | undefined): number {
  if (limit === undefined) return LIST_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw new ConvexError(CONTACT_WORDS.badPage);
  return limit;
}

export type DuplicateReason = "email" | "name";

export type DuplicateCandidate = {
  reason: DuplicateReason;
  ids: string[];
};

/**
 * Contacts that share an email address, or the same normalized name, within
 * one company. A shared email cannot be stored (the mutation refuses it);
 * the grouping is still here so a dry run can say what it found.
 */
export function duplicateCandidates(
  rows: readonly { id: string; emails: readonly string[]; normalizedName: string }[],
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const seen = new Set<string>();
  const byEmail = new Map<string, string[]>();
  for (const row of rows) {
    for (const email of row.emails) {
      const ids = byEmail.get(email) ?? [];
      ids.push(row.id);
      byEmail.set(email, ids);
    }
  }
  for (const ids of byEmail.values()) {
    const unique = [...new Set(ids)].sort();
    if (unique.length < 2) continue;
    const key = `email:${unique.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ reason: "email", ids: unique });
  }
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    if (row.normalizedName === "") continue;
    const ids = byName.get(row.normalizedName) ?? [];
    ids.push(row.id);
    byName.set(row.normalizedName, ids);
  }
  for (const ids of byName.values()) {
    const unique = [...new Set(ids)].sort();
    if (unique.length < 2) continue;
    out.push({ reason: "name", ids: unique });
  }
  return out;
}

export type IntroRow = {
  id: string;
  name: string;
  org: string | null;
  canIntroTo: readonly string[];
  introducedBy: string | null;
  lastContactAt: number | null;
};

const sameFold = (left: string, right: string) => fold(left) !== "" && fold(left) === fold(right);

/**
 * Who can introduce the caller to a contact, an organisation or a tag.
 * `rows` are already the caller's company. A target that is not among them
 * is still matched as a tag or an organisation name. Ranked by the last
 * contact, newest first, and by name when that is missing.
 */
export function introPaths(rows: readonly IntroRow[], target: string): IntroRow[] {
  const needle = target.trim();
  if (needle === "") return [];
  const targetRow = rows.find((row) => row.id === needle) ?? null;
  const orgKeys = new Set<string>();
  if (targetRow?.org) orgKeys.add(normalizedOrg(targetRow.org));
  for (const row of rows) {
    if (row.org && (sameFold(row.org, needle) || normalizedOrg(row.org) === fold(needle))) {
      orgKeys.add(normalizedOrg(row.org));
    }
  }
  const atOrg = new Set(
    rows.filter((row) => row.org && orgKeys.has(normalizedOrg(row.org))).map((row) => row.id),
  );
  const introducers = new Set<string>();
  for (const row of rows) {
    if (atOrg.has(row.id) && row.introducedBy) introducers.add(row.introducedBy);
  }
  const tagMatches = (item: string) => {
    if (item === needle || sameFold(item, needle)) return true;
    if (targetRow && item === targetRow.id) return true;
    if (targetRow?.org && (item === targetRow.org || sameFold(item, targetRow.org))) return true;
    return false;
  };
  const hits = rows.filter((row) => {
    if (targetRow && row.id === targetRow.id) return false;
    return row.canIntroTo.some(tagMatches) || introducers.has(row.id);
  });
  return hits.sort((left, right) => {
    if (left.lastContactAt == null && right.lastContactAt == null) return left.name.localeCompare(right.name);
    if (left.lastContactAt == null) return 1;
    if (right.lastContactAt == null) return -1;
    if (left.lastContactAt !== right.lastContactAt) return right.lastContactAt - left.lastContactAt;
    return left.name.localeCompare(right.name);
  });
}

/**
 * Whether a free-text search hits a name, an organisation or an email. With
 * `byEmail` false (a caller who is not sent addresses), an address is never
 * matched, so a search cannot confirm one.
 */
export function matchesContactQuery(
  contact: { normalizedName: string; org?: string | null; emails: readonly string[] },
  query: string,
  byEmail = true,
): boolean {
  const folded = fold(query);
  const lower = query.trim().toLowerCase();
  if (folded !== "" && contact.normalizedName.includes(folded)) return true;
  if (folded !== "" && contact.org && fold(contact.org).includes(folded)) return true;
  if (byEmail && lower !== "" && contact.emails.some((email) => email.includes(lower))) return true;
  return false;
}

/** What a caller who may not be sent them never gets of a contact: how to reach the person. */
export const CONTACT_DETAIL_FIELDS = ["emails", "phone", "linkedin"] as const;

/** A contact without its email addresses, phone number and LinkedIn. */
export function withoutContactDetails<T extends { emails: unknown; phone: unknown; linkedin: unknown }>(
  card: T,
): Omit<T, (typeof CONTACT_DETAIL_FIELDS)[number]> {
  const { emails, phone, linkedin, ...rest } = card;
  void emails;
  void phone;
  void linkedin;
  return rest;
}

export type ContactCompany = CompanyId;
