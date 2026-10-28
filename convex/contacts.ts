// Business contacts. Every function is the `contacts` area, and every row is
// one company's: a caller on the other company is refused with the same words
// as a missing permission. The page and the owner's agent call the same
// functions. Nothing here logs an address.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { isOwnerEmail } from "./authOwner";
import { companyIds, type CompanyId } from "./lib/company";
import {
  CONTACT_PUSH_SCOPES,
  CONTACT_PUSH_WORDS,
  teamFilter,
  type ContactPushRow,
  type ContactPushScope,
  type ContactPushSource,
} from "./lib/contactPush";
import {
  CONTACT_WORDS,
  categoryFits,
  checkCategory,
  withNote,
  checkInteractionCount,
  checkLastContactAt,
  cleanCanIntroTo,
  cleanContactName,
  cleanContactNotes,
  cleanContactOwner,
  cleanContactTitle,
  cleanEmails,
  cleanHowMet,
  cleanLinkedin,
  cleanOrg,
  cleanPhone,
  duplicateCandidates,
  introPaths as rankIntroPaths,
  isContactLinkType,
  listLimit,
  matchesContactQuery,
  normalizedOrg,
  pageOffset,
  unionEmails,
  unionLinks,
  type ContactCategory,
  type ContactLink,
  type ContactLinkType,
  type DuplicateCandidate,
  MAX_CAN_INTRO,
  MAX_CONTACT_EMAILS,
  MAX_CONTACTS,
  MAX_INTERACTION,
  MAX_LINKED_RECORDS,
} from "./lib/contacts";
import { MAX_NOTES_LENGTH, MAX_RUN_MESSAGE_LENGTH } from "./lib/limits";
import { MIRROR_SOURCES } from "./lib/mirrorRules";
import { MAX_MEMBERS } from "./lib/roles";
import { memberMutation, memberQuery, NOT_ALLOWED, requireCompany, type Member } from "./lib/owner";
import { may, type Area } from "./lib/roles";
import {
  contactCategoryValidator,
  contactLinkTypeValidator,
  contactSourceValidator,
  marketValidator,
} from "./schema";
import { setSourceStatus } from "./snapshots";

/** A linked record as the page receives it: the name only when this caller may read that record. */
export type ResolvedLink = ContactLink & { name: string | null };

/** A contact as the page and the agent's tools both receive it. */
export type ContactCard = {
  id: Id<"contacts">;
  name: string;
  emails: string[];
  phone: string | null;
  linkedin: string | null;
  org: string | null;
  title: string | null;
  company: CompanyId;
  category: ContactCategory;
  linkedRecords: ResolvedLink[];
  howMet: string | null;
  introducedBy: Id<"contacts"> | null;
  /** The introducer's name, or null when that contact is not one this caller may read. */
  introducedByName: string | null;
  canIntroTo: string[];
  lastContactAt: number | null;
  interactionCount: number;
  owner: string | null;
  notes: string | null;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
};

// The page a linked record lives on. A name is sent only to someone who holds that page.
const LINK_AREA = {
  investor: "fundraising",
  partner: "partnerships",
  deal: "sales",
} as const satisfies Record<ContactLinkType, Area>;

const present = (
  row: Doc<"contacts">,
  resolved: { introducedByName: string | null; names: ReadonlyMap<string, string | null> },
): ContactCard => ({
  id: row._id,
  name: row.name,
  emails: row.emails,
  phone: row.phone ?? null,
  linkedin: row.linkedin ?? null,
  org: row.org ?? null,
  title: row.title ?? null,
  company: row.company,
  category: row.category,
  linkedRecords: row.linkedRecords.map((link) => ({
    type: link.type,
    id: link.id,
    name: resolved.names.get(linkKey(row.company, link)) ?? null,
  })),
  howMet: row.howMet ?? null,
  introducedBy: row.introducedBy ?? null,
  introducedByName: resolved.introducedByName,
  canIntroTo: row.canIntroTo,
  lastContactAt: row.lastContactAt ?? null,
  interactionCount: row.interactionCount,
  owner: row.owner ?? null,
  notes: row.notes ?? null,
  normalizedName: row.normalizedName,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const linkKey = (company: CompanyId, link: ContactLink) => `${company}:${link.type}:${link.id}`;

function rowId<T extends "contacts">(
  ctx: QueryCtx,
  table: T,
  id: string,
  gone: string,
): Id<T> {
  const found = ctx.db.normalizeId(table, id);
  if (found === null) throw new ConvexError(gone);
  return found;
}

/** A company's contacts: never more than the most a company may hold (`upsertContact` refuses the next). */
async function rowsOf(ctx: QueryCtx, company: CompanyId): Promise<Doc<"contacts">[]> {
  return await ctx.db
    .query("contacts")
    .withIndex("by_company", (q) => q.eq("company", company))
    .take(MAX_CONTACTS);
}

async function theirs(ctx: QueryCtx, member: Member, id: Id<"contacts">): Promise<Doc<"contacts">> {
  const row = await ctx.db.get(id);
  if (row === null) throw new ConvexError(CONTACT_WORDS.gone);
  requireCompany(member, row.company);
  return row;
}

async function emailOwner(
  ctx: QueryCtx,
  company: CompanyId,
  email: string,
): Promise<Id<"contacts"> | null> {
  const row = await ctx.db
    .query("contactEmails")
    .withIndex("by_company_and_email", (q) => q.eq("company", company).eq("email", email))
    .unique();
  return row?.contactId ?? null;
}

/** Replace a contact's address index. Refuses an address another contact of the company holds. */
async function writeEmails(
  ctx: MutationCtx,
  company: CompanyId,
  contactId: Id<"contacts">,
  emails: readonly string[],
) {
  for (const email of emails) {
    const owner = await emailOwner(ctx, company, email);
    if (owner !== null && owner !== contactId) throw new ConvexError(CONTACT_WORDS.emailTaken);
  }
  const existing = await ctx.db
    .query("contactEmails")
    .withIndex("by_contactId", (q) => q.eq("contactId", contactId))
    .collect();
  const next = new Set(emails);
  for (const row of existing) {
    if (!next.has(row.email)) await ctx.db.delete(row._id);
  }
  const held = new Set(existing.map((row) => row.email));
  for (const email of emails) {
    if (!held.has(email)) await ctx.db.insert("contactEmails", { company, email, contactId });
  }
}

async function contactsHolding(
  ctx: QueryCtx,
  company: CompanyId,
  emails: readonly string[],
): Promise<Id<"contacts">[]> {
  const ids = new Set<Id<"contacts">>();
  for (const email of emails) {
    const owner = await emailOwner(ctx, company, email);
    if (owner !== null) ids.add(owner);
  }
  return [...ids];
}

async function byNameAndOrg(
  ctx: QueryCtx,
  company: CompanyId,
  name: string,
  org: string | undefined,
): Promise<Doc<"contacts">[]> {
  const normalized = cleanContactName(name).normalizedName;
  const orgKey = normalizedOrg(org ?? "");
  const named = await ctx.db
    .query("contacts")
    .withIndex("by_company_and_normalizedName", (q) =>
      q.eq("company", company).eq("normalizedName", normalized),
    )
    .collect();
  return named.filter((row) => normalizedOrg(row.org ?? "") === orgKey);
}

/**
 * The company of a record a contact may be linked to, or null when there is
 * no such row. Investors are Startup's alone.
 */
async function companyOfRecord(ctx: QueryCtx, type: ContactLinkType, id: string): Promise<CompanyId | null> {
  if (type === "investor") {
    const found = ctx.db.normalizeId("investors", id);
    return found !== null && (await ctx.db.get(found)) !== null ? "us" : null;
  }
  if (type === "partner") {
    const found = ctx.db.normalizeId("partners", id);
    const row = found === null ? null : await ctx.db.get(found);
    return row?.company ?? null;
  }
  const found = ctx.db.normalizeId("deals", id);
  const row = found === null ? null : await ctx.db.get(found);
  return row?.market ?? null;
}

/**
 * Linking a contact to a record, or listing a record's contacts, is the work
 * of the page that record lives on (`LINK_AREA`): someone with Contacts alone
 * is refused, whatever the id, so an id is not a probe of a board they do not
 * hold.
 */
function requireLinkArea(member: Member, type: ContactLinkType) {
  if (!may(member, LINK_AREA[type])) throw new ConvexError(NOT_ALLOWED);
}

/**
 * The name of a linked investor, partner or deal, or null when this caller
 * may not read it. Missing, another company's, and a page they do not hold
 * are the same answer, so an id is not a probe. Nothing is thrown: a stale
 * link still unlinks.
 */
async function recordName(
  ctx: QueryCtx,
  member: Member,
  contactCompany: CompanyId,
  link: ContactLink,
): Promise<string | null> {
  if (!may(member, LINK_AREA[link.type]) || !member.companies.includes(contactCompany)) return null;
  if (link.type === "investor") {
    if (contactCompany !== "us" || !member.companies.includes("us")) return null;
    const id = ctx.db.normalizeId("investors", link.id);
    const row = id === null ? null : await ctx.db.get(id);
    return row?.name ?? null;
  }
  if (link.type === "partner") {
    const id = ctx.db.normalizeId("partners", link.id);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.company !== contactCompany || !member.companies.includes(row.company)) return null;
    return row.name;
  }
  const id = ctx.db.normalizeId("deals", link.id);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.market !== contactCompany || !member.companies.includes(row.market)) return null;
  return row.name;
}

/** Names for the introducer and each linked record, resolved once for the rows. */
async function cardsOf(ctx: QueryCtx, member: Member, rows: readonly Doc<"contacts">[]): Promise<ContactCard[]> {
  const names = new Map<string, string | null>();
  for (const row of rows) {
    for (const link of row.linkedRecords) {
      const key = linkKey(row.company, link);
      if (names.has(key)) continue;
      names.set(key, await recordName(ctx, member, row.company, link));
    }
  }
  const introducers = new Map<string, string | null>();
  for (const row of rows) {
    if (row.introducedBy === undefined) continue;
    const key = `${row.company}:${row.introducedBy}`;
    if (introducers.has(key)) continue;
    const intro = await ctx.db.get(row.introducedBy);
    const visible =
      intro !== null && intro.company === row.company && member.companies.includes(intro.company)
        ? intro.name
        : null;
    introducers.set(key, visible);
  }
  return rows.map((row) =>
    present(row, {
      introducedByName:
        row.introducedBy === undefined ? null : (introducers.get(`${row.company}:${row.introducedBy}`) ?? null),
      names,
    }),
  );
}

async function introducerOf(
  ctx: QueryCtx,
  company: CompanyId,
  value: string | null,
  self: Id<"contacts"> | null,
): Promise<Id<"contacts"> | undefined> {
  if (value === null) return undefined;
  const id = rowId(ctx, "contacts", value, CONTACT_WORDS.sameCompanyIntro);
  if (self !== null && id === self) throw new ConvexError(CONTACT_WORDS.selfIntro);
  const row = await ctx.db.get(id);
  // Missing and another company's contact are the same sentence, so an id is not a probe.
  if (row === null || row.company !== company) throw new ConvexError(CONTACT_WORDS.sameCompanyIntro);
  return id;
}

export type ContactWrite = {
  id?: Id<"contacts">;
  company?: CompanyId;
  name?: string;
  emails?: string[];
  phone?: string | null;
  linkedin?: string | null;
  org?: string | null;
  title?: string | null;
  category?: string;
  howMet?: string | null;
  introducedBy?: string | null;
  canIntroTo?: string[];
  lastContactAt?: number | null;
  interactionCount?: number;
  owner?: string | null;
  notes?: string | null;
};

type Stored = {
  name: string;
  normalizedName: string;
  emails: string[];
  phone?: string;
  linkedin?: string;
  org?: string;
  title?: string;
  category: ContactCategory;
  howMet?: string;
  introducedBy?: Id<"contacts">;
  canIntroTo: string[];
  lastContactAt?: number;
  interactionCount: number;
  owner?: string;
  notes?: string;
};

function edited(current: Doc<"contacts"> | null, input: ContactWrite, now: number): Stored {
  const base: Stored = current
    ? {
        name: current.name,
        normalizedName: current.normalizedName,
        emails: current.emails,
        phone: current.phone,
        linkedin: current.linkedin,
        org: current.org,
        title: current.title,
        category: current.category,
        howMet: current.howMet,
        introducedBy: current.introducedBy,
        canIntroTo: current.canIntroTo,
        lastContactAt: current.lastContactAt,
        interactionCount: current.interactionCount,
        owner: current.owner,
        notes: current.notes,
      }
    : {
        name: "",
        normalizedName: "",
        emails: [],
        category: "other",
        canIntroTo: [],
        interactionCount: 0,
      };
  if (input.name !== undefined) {
    const cleaned = cleanContactName(input.name);
    base.name = cleaned.name;
    base.normalizedName = cleaned.normalizedName;
  }
  if (input.emails !== undefined) base.emails = unionEmails(base.emails, cleanEmails(input.emails));
  if (input.phone !== undefined) base.phone = cleanPhone(input.phone);
  if (input.linkedin !== undefined) base.linkedin = cleanLinkedin(input.linkedin);
  if (input.org !== undefined) base.org = cleanOrg(input.org);
  if (input.title !== undefined) base.title = cleanContactTitle(input.title);
  if (input.category !== undefined) base.category = checkCategory(input.category);
  if (input.howMet !== undefined) base.howMet = cleanHowMet(input.howMet);
  if (input.canIntroTo !== undefined) base.canIntroTo = cleanCanIntroTo(input.canIntroTo);
  if (input.lastContactAt !== undefined) {
    base.lastContactAt = input.lastContactAt === null ? undefined : checkLastContactAt(input.lastContactAt, now);
  }
  if (input.interactionCount !== undefined) base.interactionCount = checkInteractionCount(input.interactionCount);
  if (input.owner !== undefined) base.owner = cleanContactOwner(input.owner);
  if (input.notes !== undefined) base.notes = cleanContactNotes(input.notes);
  return base;
}

/**
 * Create a contact, or change the one an address already belongs to, or the
 * one with the same normalized name and organisation, or the one `id` names.
 * Addresses are united, never replaced. An address on two contacts is refused.
 */
export async function upsertContact(
  ctx: MutationCtx,
  member: Member,
  input: ContactWrite,
  now: number,
): Promise<{ id: Id<"contacts">; created: boolean }> {
  const emails = input.emails === undefined ? undefined : cleanEmails(input.emails);
  let current: Doc<"contacts"> | null = null;
  if (input.id !== undefined) {
    current = await theirs(ctx, member, input.id);
    if (input.company !== undefined && input.company !== current.company) {
      throw new ConvexError(CONTACT_WORDS.stays);
    }
  } else {
    if (input.company === undefined) throw new ConvexError(CONTACT_WORDS.needsCompany);
    requireCompany(member, input.company);
    const company = input.company;
    if (emails !== undefined && emails.length > 0) {
      const holders = await contactsHolding(ctx, company, emails);
      if (holders.length > 1) throw new ConvexError(CONTACT_WORDS.emailConflict);
      if (holders.length === 1) current = await theirs(ctx, member, holders[0]!);
    }
    if (current === null) {
      if (input.name === undefined) throw new ConvexError(CONTACT_WORDS.needsName);
      const org = input.org === undefined || input.org === null ? undefined : cleanOrg(input.org);
      const matches = await byNameAndOrg(ctx, company, input.name, org);
      if (matches.length > 1) throw new ConvexError(CONTACT_WORDS.nameConflict);
      if (matches.length === 1) current = matches[0]!;
    }
  }

  if (current === null) {
    const company = input.company!;
    const count = (await rowsOf(ctx, company)).length;
    if (count >= MAX_CONTACTS) throw new ConvexError(CONTACT_WORDS.tooMany);
    const stored = edited(null, { ...input, emails }, now);
    if (stored.name === "") throw new ConvexError(CONTACT_WORDS.needsName);
    if (!categoryFits(stored.category, company)) throw new ConvexError(CONTACT_WORDS.categoryCompany);
    const introducedBy =
      input.introducedBy === undefined
        ? undefined
        : await introducerOf(ctx, company, input.introducedBy, null);
    const id = await ctx.db.insert("contacts", {
      name: stored.name,
      emails: stored.emails,
      phone: stored.phone,
      linkedin: stored.linkedin,
      org: stored.org,
      title: stored.title,
      company,
      category: stored.category,
      linkedRecords: [],
      howMet: stored.howMet,
      introducedBy,
      canIntroTo: stored.canIntroTo,
      lastContactAt: stored.lastContactAt,
      interactionCount: stored.interactionCount,
      owner: stored.owner,
      notes: stored.notes,
      normalizedName: stored.normalizedName,
      createdAt: now,
      updatedAt: now,
    });
    await writeEmails(ctx, company, id, stored.emails);
    return { id, created: true };
  }

  const stored = edited(current, { ...input, emails }, now);
  if (input.category !== undefined && !categoryFits(stored.category, current.company)) {
    throw new ConvexError(CONTACT_WORDS.categoryCompany);
  }
  const introducedBy =
    input.introducedBy === undefined
      ? current.introducedBy
      : await introducerOf(ctx, current.company, input.introducedBy, current._id);
  await ctx.db.patch(current._id, {
    name: stored.name,
    emails: stored.emails,
    phone: stored.phone,
    linkedin: stored.linkedin,
    org: stored.org,
    title: stored.title,
    category: stored.category,
    howMet: stored.howMet,
    introducedBy,
    canIntroTo: stored.canIntroTo,
    lastContactAt: stored.lastContactAt,
    interactionCount: stored.interactionCount,
    owner: stored.owner,
    notes: stored.notes,
    normalizedName: stored.normalizedName,
    updatedAt: now,
  });
  await writeEmails(ctx, current.company, current._id, stored.emails);
  return { id: current._id, created: false };
}

/** Add a dated note on top of a contact's notes. Nothing is logged. */
export async function addContactNote(
  ctx: MutationCtx,
  member: Member,
  args: { id: Id<"contacts">; text: string },
  now: number,
): Promise<{ id: Id<"contacts"> }> {
  const contact = await theirs(ctx, member, args.id);
  const notes = withNote(contact.notes, args.text, new Date(now).toISOString().slice(0, 10));
  await ctx.db.patch(contact._id, { notes, updatedAt: now });
  return { id: contact._id };
}

/** Link or unlink a contact and an investor, a partner or a deal of its company. */
export async function linkContact(
  ctx: MutationCtx,
  member: Member,
  args: { contactId: Id<"contacts">; type: string; id: string; linked: boolean },
  now: number,
): Promise<{ id: Id<"contacts">; linked: boolean }> {
  if (!isContactLinkType(args.type)) throw new ConvexError(CONTACT_WORDS.badLink);
  const contact = await theirs(ctx, member, args.contactId);
  requireLinkArea(member, args.type);
  const pair: ContactLink = { type: args.type, id: args.id };
  const has = contact.linkedRecords.some((link) => link.type === pair.type && link.id === pair.id);
  if (args.linked) {
    // Missing and another company's record are the same sentence, so an id is not a probe.
    if ((await companyOfRecord(ctx, args.type, args.id)) !== contact.company) {
      throw new ConvexError(CONTACT_WORDS.recordGone);
    }
    if (!has) {
      const linkedRecords = unionLinks(contact.linkedRecords, [pair]);
      await ctx.db.patch(contact._id, { linkedRecords, updatedAt: now });
    }
    return { id: contact._id, linked: true };
  }
  if (has) {
    await ctx.db.patch(contact._id, {
      linkedRecords: contact.linkedRecords.filter((link) => link.type !== pair.type || link.id !== pair.id),
      updatedAt: now,
    });
  }
  return { id: contact._id, linked: false };
}

function keepText(survivor: string | undefined, absorbed: string | undefined): string | undefined {
  return survivor !== undefined ? survivor : absorbed;
}

/**
 * Merge two contacts of one company, or, with `dryRun`, list duplicates and
 * write nothing. The one kept takes the union of addresses, links and
 * introduction tags, and the earlier `createdAt`.
 */
export async function mergeContacts(
  ctx: MutationCtx,
  member: Member,
  args: { dryRun?: boolean; company?: CompanyId; keepId?: Id<"contacts">; mergeId?: Id<"contacts"> },
  now: number,
): Promise<
  | { dryRun: true; candidates: (DuplicateCandidate & { company: CompanyId })[] }
  | { dryRun: false; id: Id<"contacts">; merged: Id<"contacts"> }
> {
  if (args.dryRun === true) {
    const companies = args.company === undefined ? member.companies : [args.company];
    if (args.company !== undefined) requireCompany(member, args.company);
    const candidates: (DuplicateCandidate & { company: CompanyId })[] = [];
    for (const company of companies) {
      const rows = await rowsOf(ctx, company);
      for (const candidate of duplicateCandidates(rows.map((row) => ({ ...row, id: row._id })))) {
        candidates.push({ ...candidate, company });
      }
    }
    return { dryRun: true, candidates };
  }
  if (args.keepId === undefined || args.mergeId === undefined) throw new ConvexError(CONTACT_WORDS.mergeNeeds);
  if (args.keepId === args.mergeId) throw new ConvexError(CONTACT_WORDS.mergeSame);
  const keep = await theirs(ctx, member, args.keepId);
  const absorbed = await theirs(ctx, member, args.mergeId);
  if (keep.company !== absorbed.company) throw new ConvexError(NOT_ALLOWED);
  const company = keep.company;
  const emails = unionEmails(keep.emails, absorbed.emails);
  const linkedRecords = unionLinks(keep.linkedRecords, absorbed.linkedRecords);
  const canIntroTo: string[] = [];
  for (const tag of [...keep.canIntroTo, ...absorbed.canIntroTo]) {
    const next = tag === absorbed._id ? keep._id : tag;
    if (next === keep._id || canIntroTo.includes(next)) continue;
    canIntroTo.push(next);
  }
  if (canIntroTo.length > MAX_CAN_INTRO) throw new ConvexError(CONTACT_WORDS.tooManyTags);
  let introducedBy = keep.introducedBy ?? absorbed.introducedBy;
  if (introducedBy === absorbed._id) introducedBy = absorbed.introducedBy;
  if (introducedBy === keep._id) introducedBy = undefined;
  const notes =
    keep.notes && absorbed.notes && keep.notes !== absorbed.notes
      ? `${keep.notes}\n\n${absorbed.notes}`
      : keepText(keep.notes, absorbed.notes);
  if (notes !== undefined && notes.length > MAX_NOTES_LENGTH) throw new ConvexError(CONTACT_WORDS.notesTooLong);
  const lastTimes = [keep.lastContactAt, absorbed.lastContactAt].filter((value): value is number => value !== undefined);
  await ctx.db.patch(keep._id, {
    emails,
    linkedRecords,
    canIntroTo,
    introducedBy,
    phone: keepText(keep.phone, absorbed.phone),
    linkedin: keepText(keep.linkedin, absorbed.linkedin),
    org: keepText(keep.org, absorbed.org),
    title: keepText(keep.title, absorbed.title),
    howMet: keepText(keep.howMet, absorbed.howMet),
    owner: keepText(keep.owner, absorbed.owner),
    notes,
    lastContactAt: lastTimes.length === 0 ? undefined : Math.max(...lastTimes),
    interactionCount: Math.min(MAX_INTERACTION, keep.interactionCount + absorbed.interactionCount),
    createdAt: Math.min(keep.createdAt, absorbed.createdAt),
    // A pushed person stays the source's: the one kept takes the other's id when it has none.
    ...(keep.source === undefined && absorbed.source !== undefined
      ? { source: absorbed.source, externalId: absorbed.externalId }
      : null),
    updatedAt: now,
  });
  const absorbedEmails = await ctx.db
    .query("contactEmails")
    .withIndex("by_contactId", (q) => q.eq("contactId", absorbed._id))
    .collect();
  for (const row of absorbedEmails) await ctx.db.delete(row._id);
  await writeEmails(ctx, company, keep._id, emails);
  const others = await rowsOf(ctx, company);
  for (const row of others) {
    if (row._id === keep._id || row._id === absorbed._id) continue;
    const tags = row.canIntroTo.includes(absorbed._id)
      ? [...new Set(row.canIntroTo.map((tag) => (tag === absorbed._id ? keep._id : tag)))]
      : row.canIntroTo;
    const intro = row.introducedBy === absorbed._id ? keep._id : row.introducedBy;
    if (tags !== row.canIntroTo || intro !== row.introducedBy) {
      await ctx.db.patch(row._id, { canIntroTo: tags, introducedBy: intro, updatedAt: now });
    }
  }
  await ctx.db.delete(absorbed._id);
  return { dryRun: false, id: keep._id, merged: absorbed._id };
}

export type ContactListArgs = {
  company?: CompanyId;
  query?: string;
  category?: string;
  owner?: string;
  linkedType?: string;
  linkedId?: string;
  cursor?: string;
  limit?: number;
};

/**
 * One page of contacts, and the owners the filter can offer. `byEmail` false
 * (a bot not sent addresses) searches names and organisations only.
 */
export async function contactsPage(ctx: QueryCtx, member: Member, args: ContactListArgs, byEmail = true) {
  const companies = args.company === undefined ? [...member.companies] : [args.company];
  if (args.company !== undefined) requireCompany(member, args.company);
  if ((args.linkedType === undefined) !== (args.linkedId === undefined)) {
    throw new ConvexError(CONTACT_WORDS.needsRecord);
  }
  if (args.linkedType !== undefined && !isContactLinkType(args.linkedType)) {
    throw new ConvexError(CONTACT_WORDS.badLink);
  }
  const category = args.category === undefined ? undefined : checkCategory(args.category);
  const rows: Doc<"contacts">[] = [];
  for (const company of companies) rows.push(...(await rowsOf(ctx, company)));
  const owners = [...new Set(rows.flatMap((row) => (row.owner ? [row.owner] : [])))].sort();
  const filtered = rows.filter((row) => {
    if (category !== undefined && row.category !== category) return false;
    if (args.owner !== undefined && row.owner !== args.owner) return false;
    if (args.query !== undefined && args.query.trim() !== "" && !matchesContactQuery(row, args.query, byEmail)) return false;
    if (args.linkedType !== undefined && args.linkedId !== undefined) {
      const hit = row.linkedRecords.some((link) => link.type === args.linkedType && link.id === args.linkedId);
      if (!hit) return false;
    }
    return true;
  });
  filtered.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName) || left.name.localeCompare(right.name));
  const offset = pageOffset(args.cursor);
  const limit = listLimit(args.limit);
  const page = filtered.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    contacts: await cardsOf(ctx, member, page),
    nextCursor: next < filtered.length ? String(next) : null,
    owners,
  };
}

export async function contactFor(ctx: QueryCtx, member: Member, id: Id<"contacts">): Promise<ContactCard> {
  const [card] = await cardsOf(ctx, member, [await theirs(ctx, member, id)]);
  return card!;
}

/** The contacts of a record's company that are linked to it. */
export async function contactsForRecord(
  ctx: QueryCtx,
  member: Member,
  args: { type: string; id: string },
): Promise<ContactCard[]> {
  if (!isContactLinkType(args.type)) throw new ConvexError(CONTACT_WORDS.badLink);
  requireLinkArea(member, args.type);
  // A record that is gone, or another company's, has no contacts this caller may see: the same empty list.
  const company = await companyOfRecord(ctx, args.type, args.id);
  if (company === null || !member.companies.includes(company)) return [];
  const rows = await rowsOf(ctx, company);
  return cardsOf(
    ctx,
    member,
    rows
      .filter((row) => row.linkedRecords.some((link) => link.type === args.type && link.id === args.id))
      .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName)),
  );
}

export async function introPathsFor(
  ctx: QueryCtx,
  member: Member,
  args: { target?: string; company?: CompanyId },
): Promise<ContactCard[]> {
  const target = args.target?.trim() ?? "";
  // A missing target is an empty list, the same as a target nobody matches, so a
  // read with no arguments still answers (and can be scanned) instead of erroring.
  if (target === "") return [];
  const companies = args.company === undefined ? [...member.companies] : [args.company];
  if (args.company !== undefined) requireCompany(member, args.company);
  const rows: Doc<"contacts">[] = [];
  for (const company of companies) rows.push(...(await rowsOf(ctx, company)));
  const ranked = rankIntroPaths(
    rows.map((row) => ({
      id: row._id,
      name: row.name,
      org: row.org ?? null,
      canIntroTo: row.canIntroTo,
      introducedBy: row.introducedBy ?? null,
      lastContactAt: row.lastContactAt ?? null,
    })),
    target,
  );
  const byId = new Map(rows.map((row) => [row._id as string, row]));
  return cardsOf(
    ctx,
    member,
    ranked.flatMap((row) => {
      const found = byId.get(row.id);
      return found ? [found] : [];
    }),
  );
}

/** How many contacts a company holds: never more than `MAX_CONTACTS`, which `upsertContact` keeps. */
export async function contactCount(ctx: QueryCtx, company: CompanyId): Promise<number> {
  return (await rowsOf(ctx, company)).length;
}

/** A person read out of a deal's or an investor's free-text contact (`migrations:contactsFromRecords`). */
export type RecordContact = {
  company: CompanyId;
  category: ContactCategory;
  name: string;
  title?: string;
  /** The record's own name: the organisation the person is at. */
  org: string;
  link: ContactLink;
};

/**
 * Put a record's contact in the book, the system's own write (no caller to
 * hold to an area: the record was read by the migration itself). Matched by
 * the module's own rule for a person with no address, the same normalized
 * name at the same organisation (`byNameAndOrg`): one match is linked to the
 * record, given the title when it has none, and keeps everything a person
 * typed; none is made, linked; two or more are left alone (`skipped`), as
 * `upsertContact` refuses them. `room` is what is left under `MAX_CONTACTS`
 * per company, counted once by the caller and spent here. Nothing is logged.
 */
export async function importRecordContact(
  ctx: MutationCtx,
  input: RecordContact,
  now: number,
  room: Map<CompanyId, number>,
): Promise<"created" | "linked" | "skipped"> {
  let cleaned: { name: string; normalizedName: string };
  let org: string | undefined;
  let title: string | undefined;
  try {
    cleaned = cleanContactName(input.name);
    org = cleanOrg(input.org);
    title = input.title === undefined ? undefined : cleanContactTitle(input.title);
  } catch {
    return "skipped";
  }
  const matches = await byNameAndOrg(ctx, input.company, cleaned.name, org);
  if (matches.length > 1) return "skipped";
  const found = matches[0];
  if (found !== undefined) {
    const held = found.linkedRecords.some((link) => link.type === input.link.type && link.id === input.link.id);
    if (held || found.linkedRecords.length >= MAX_LINKED_RECORDS) return "skipped";
    await ctx.db.patch(found._id, {
      linkedRecords: [...found.linkedRecords, input.link],
      ...(found.title === undefined && title !== undefined ? { title } : null),
      updatedAt: now,
    });
    return "linked";
  }
  const left = room.get(input.company) ?? 0;
  if (left <= 0) return "skipped";
  room.set(input.company, left - 1);
  await ctx.db.insert("contacts", {
    name: cleaned.name,
    emails: [],
    org,
    title,
    company: input.company,
    category: input.category,
    linkedRecords: [input.link],
    canIntroTo: [],
    interactionCount: 0,
    normalizedName: cleaned.normalizedName,
    createdAt: now,
    updatedAt: now,
  });
  return "created";
}

// ── Pushed people (POST /ingest/v1, `contacts`; convex/lib/contactPush.ts) ──

/** What one push did, in counts: never a name, an address or an id. */
export type ContactPushCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Links to a record added (an investor, a deal). */
  linked: number;
  /** Rows that matched more than one contact, held an address another contact holds, or met a full book. */
  skipped: number;
  /** People from mail or meetings left out because every address was the team's. */
  excluded: number;
};

const NO_COUNTS: ContactPushCounts = { inserted: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, excluded: 0 };

/** The record a pushed person is linked to, by that record's source id, or null when the OS has none of the company's. */
async function pushedLink(
  ctx: QueryCtx,
  scope: ContactPushScope,
  source: ContactPushSource,
  company: CompanyId,
  externalId: string | undefined,
): Promise<ContactLink | null> {
  if (scope.link === null || externalId === undefined) return null;
  if (scope.link === "investor") {
    if (company !== "us") return null;
    const row = await ctx.db
      .query("investors")
      .withIndex("by_source_and_externalId", (q) => q.eq("source", source).eq("externalId", externalId))
      .first();
    return row === null ? null : { type: "investor", id: row._id };
  }
  if (scope.link === "deal") {
    const row = await ctx.db
      .query("deals")
      .withIndex("by_source_and_externalId", (q) => q.eq("source", source).eq("externalId", externalId))
      .first();
    return row === null || row.market !== company ? null : { type: "deal", id: row._id };
  }
  return null;
}

const later = (current: number | undefined, pushed: number | undefined) =>
  pushed === undefined ? current : current === undefined ? pushed : Math.max(current, pushed);

/**
 * One pushed person into the book. Matched by the source's own id first (the
 * row a push of this source made or claimed), then by any address, then by
 * the same normalized name at the same organisation: the module's own order.
 * Addresses are united. On the source's own row the source's fields win
 * (name, title, organisation, LinkedIn, phone, the count); on any other the
 * push only fills what is empty and claims the row for the source when no
 * source holds it. Never the notes, owner, how-you-met, introducer,
 * introductions or category a person set. Nothing is logged or thrown with
 * a value: a conflict is a count.
 */
async function upsertPushedContact(
  ctx: MutationCtx,
  source: ContactPushSource,
  row: ContactPushRow,
  now: number,
  room: Map<CompanyId, number>,
): Promise<{ outcome: "inserted" | "updated" | "unchanged" | "skipped"; linked: boolean }> {
  const scope = CONTACT_PUSH_SCOPES[source];
  const company = row.company;
  const skipped = { outcome: "skipped" as const, linked: false };
  const holders = await contactsHolding(ctx, company, row.emails);

  let current: Doc<"contacts"> | null = await ctx.db
    .query("contacts")
    .withIndex("by_company_and_source_and_externalId", (q) =>
      q.eq("company", company).eq("source", source).eq("externalId", row.externalId),
    )
    .first();
  if (current !== null) {
    const own = current._id;
    if (holders.some((id) => id !== own)) return skipped;
  } else if (holders.length > 1) {
    return skipped;
  } else if (holders.length === 1) {
    current = await ctx.db.get(holders[0]!);
  } else {
    const matches = await byNameAndOrg(ctx, company, row.name, row.org);
    if (matches.length > 1) return skipped;
    current = matches[0] ?? null;
  }

  const link = await pushedLink(ctx, scope, source, company, row.linkedExternalId);
  const normalized = cleanContactName(row.name).normalizedName;

  if (current === null) {
    const left = room.get(company) ?? 0;
    if (left <= 0) return skipped;
    room.set(company, left - 1);
    const id = await ctx.db.insert("contacts", {
      name: row.name,
      emails: row.emails,
      phone: row.phone,
      linkedin: row.linkedin,
      org: row.org,
      title: row.title,
      company,
      category: scope.category,
      linkedRecords: link === null ? [] : [link],
      canIntroTo: [],
      lastContactAt: row.lastContactAt,
      interactionCount: row.interactionCount ?? 0,
      normalizedName: normalized,
      source,
      externalId: row.externalId,
      createdAt: now,
      updatedAt: now,
    });
    await writeEmails(ctx, company, id, row.emails);
    return { outcome: "inserted", linked: link !== null };
  }

  const emails = [...current.emails];
  for (const email of row.emails) if (!emails.includes(email)) emails.push(email);
  if (emails.length > MAX_CONTACT_EMAILS) return skipped;
  const owned = current.source === source && current.externalId === row.externalId;
  const pick = <T,>(held: T | undefined, pushed: T | undefined): T | undefined =>
    pushed === undefined ? held : owned || held === undefined ? pushed : held;
  const heldLink = link !== null && current.linkedRecords.some((l) => l.type === link.type && l.id === link.id);
  const addLink = link !== null && !heldLink && current.linkedRecords.length < MAX_LINKED_RECORDS;
  const next = {
    name: owned ? row.name : current.name,
    normalizedName: owned ? normalized : current.normalizedName,
    emails,
    title: pick(current.title, row.title),
    org: pick(current.org, row.org),
    linkedin: pick(current.linkedin, row.linkedin),
    phone: pick(current.phone, row.phone),
    lastContactAt: later(current.lastContactAt, row.lastContactAt),
    interactionCount:
      row.interactionCount === undefined
        ? current.interactionCount
        : owned
          ? row.interactionCount
          : Math.max(current.interactionCount, row.interactionCount),
    linkedRecords: addLink ? [...current.linkedRecords, link] : current.linkedRecords,
    source: current.source ?? source,
    externalId: current.source === undefined ? row.externalId : current.externalId,
  };
  const same =
    next.name === current.name &&
    next.emails.length === current.emails.length &&
    next.title === current.title &&
    next.org === current.org &&
    next.linkedin === current.linkedin &&
    next.phone === current.phone &&
    next.lastContactAt === current.lastContactAt &&
    next.interactionCount === current.interactionCount &&
    !addLink &&
    next.source === current.source &&
    next.externalId === current.externalId;
  if (same) return { outcome: "unchanged", linked: false };
  await ctx.db.patch(current._id, { ...next, updatedAt: now });
  if (next.emails.length !== current.emails.length) await writeEmails(ctx, company, current._id, next.emails);
  return { outcome: "updated", linked: addLink };
}


const pushedRowValidator = v.object({
  externalId: v.string(),
  name: v.string(),
  emails: v.array(v.string()),
  company: marketValidator,
  title: v.optional(v.string()),
  org: v.optional(v.string()),
  linkedin: v.optional(v.string()),
  phone: v.optional(v.string()),
  lastContactAt: v.optional(v.number()),
  linkedExternalId: v.optional(v.string()),
  interactionCount: v.optional(v.number()),
});

/** Whether a row is one this source may send: what the endpoint checked, asked again by the writer. */
function fitsScope(scope: ContactPushScope, row: ContactPushRow): boolean {
  if (!companyIds().includes(row.company)) return false;
  if (scope.company !== "by_address" && row.company !== scope.company) return false;
  if (!categoryFits(scope.category, row.company)) return false;
  if (row.phone !== undefined && !scope.phone) return false;
  if (row.linkedExternalId !== undefined && scope.link === null) return false;
  if (scope.mail && (row.emails.length === 0 || row.interactionCount === undefined)) return false;
  for (const field of ["title", "org", "linkedin", "phone", "lastContactAt", "linkedExternalId", "interactionCount"] as const) {
    if (row[field] !== undefined && !scope.fields.includes(field)) return false;
  }
  return row.emails.length <= MAX_CONTACT_EMAILS && row.emails.every((email) => email === email.toLowerCase());
}

/**
 * One slice of a contacts push (the endpoint sends at most
 * `CONTACT_PUSH_SLICE` in convex/ingest.ts rows a call, so no call outgrows a transaction).
 * Null when the owner switched the work tool off under Settings › Work
 * tools: nothing is written. People from mail or meetings lose the team's
 * own addresses here (each teammate's and owner's, and a teammate's firm's
 * domain); one left with none is `excluded`. Counts only.
 */
export const applyPush = internalMutation({
  args: { source: contactSourceValidator, now: v.number(), rows: v.array(pushedRowValidator) },
  handler: async (ctx, { source, now, rows }): Promise<ContactPushCounts | null> => {
    const scope = CONTACT_PUSH_SCOPES[source];
    if (rows.some((row) => !fitsScope(scope, row))) throw new ConvexError(CONTACT_PUSH_WORDS.wrongScope);
    if ((MIRROR_SOURCES as readonly string[]).includes(source)) {
      const settings = await ctx.db.query("workToolSettings").first();
      if (settings !== null && (settings.off as readonly string[]).includes(source)) return null;
    }
    let isTeam: (email: string) => boolean = () => false;
    if (scope.mail) {
      const members = await ctx.db.query("members").take(MAX_MEMBERS * 2);
      const filter = teamFilter(members.map((member) => member.email));
      isTeam = (email) => isOwnerEmail(email) || filter(email);
    }
    const room = new Map<CompanyId, number>();
    for (const company of companyIds()) room.set(company, MAX_CONTACTS - (await contactCount(ctx, company)));
    const counts: ContactPushCounts = { ...NO_COUNTS };
    for (const pushed of rows) {
      const emails = pushed.emails.filter((email) => !isTeam(email));
      if (scope.mail && emails.length === 0) {
        counts.excluded += 1;
        continue;
      }
      const { outcome, linked } = await upsertPushedContact(ctx, source, { ...pushed, emails }, now, room);
      counts[outcome === "inserted" ? "inserted" : outcome] += 1;
      if (linked) counts.linked += 1;
    }
    return counts;
  },
});

/**
 * The run row and status of a contacts push that was written whole: counts
 * only, under the push's own status source (`visible_contacts` and the rest),
 * so the carrier's board never reads a contacts push as its own.
 */
export const recordPush = internalMutation({
  args: {
    source: contactSourceValidator,
    startedAt: v.number(),
    counts: v.object({
      inserted: v.number(),
      updated: v.number(),
      unchanged: v.number(),
      linked: v.number(),
      skipped: v.number(),
      excluded: v.number(),
      dropped: v.number(),
    }),
  },
  handler: async (ctx, { source, startedAt, counts }) => {
    const status = CONTACT_PUSH_SCOPES[source].status;
    const now = Date.now();
    const notes = [
      counts.linked > 0 ? `${counts.linked} linked` : null,
      counts.skipped > 0 ? `${counts.skipped} skipped (more than one match, an address on another contact, or a full book)` : null,
      counts.excluded > 0 ? `${counts.excluded} left out (no-reply, the team's own, or too few exchanges)` : null,
      counts.dropped > 0 ? `${counts.dropped} dropped (looked like a patient's record)` : null,
    ].filter((note): note is string => note !== null);
    const message = notes.length === 0 ? undefined : `${notes.join("; ")}.`.slice(0, MAX_RUN_MESSAGE_LENGTH);
    await ctx.db.insert("syncRuns", {
      source: status,
      startedAt,
      finishedAt: now,
      status: "ok",
      message,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: counts.unchanged,
    });
    await setSourceStatus(ctx, status, { state: "ok", message, at: now });
    return null;
  },
});

const nullable = <T extends Parameters<typeof v.union>[0]>(validator: T) => v.optional(v.union(validator, v.null()));

export const list = memberQuery("contacts")({
  args: {
    company: v.optional(marketValidator),
    query: v.optional(v.string()),
    category: v.optional(v.string()),
    owner: v.optional(v.string()),
    linkedType: v.optional(v.string()),
    linkedId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => contactsPage(ctx, ctx.member, args),
});

export const get = memberQuery("contacts")({
  args: { id: v.id("contacts") },
  handler: (ctx, args) => contactFor(ctx, ctx.member, args.id),
});

export const forRecord = memberQuery("contacts")({
  args: { type: v.string(), id: v.string() },
  handler: (ctx, args) => contactsForRecord(ctx, ctx.member, args),
});

export const introPaths = memberQuery("contacts")({
  args: { target: v.optional(v.string()), company: v.optional(marketValidator) },
  handler: (ctx, args) => introPathsFor(ctx, ctx.member, args),
});

export const upsert = memberMutation("contacts")({
  args: {
    id: v.optional(v.id("contacts")),
    company: v.optional(marketValidator),
    name: v.optional(v.string()),
    emails: v.optional(v.array(v.string())),
    phone: nullable(v.string()),
    linkedin: nullable(v.string()),
    org: nullable(v.string()),
    title: nullable(v.string()),
    category: v.optional(contactCategoryValidator),
    howMet: nullable(v.string()),
    introducedBy: nullable(v.string()),
    canIntroTo: v.optional(v.array(v.string())),
    lastContactAt: nullable(v.number()),
    interactionCount: v.optional(v.number()),
    owner: nullable(v.string()),
    notes: nullable(v.string()),
  },
  handler: (ctx, args) => upsertContact(ctx, ctx.member, args, Date.now()),
});

export const addNote = memberMutation("contacts")({
  args: { id: v.id("contacts"), text: v.string() },
  handler: (ctx, args) => addContactNote(ctx, ctx.member, args, Date.now()),
});

export const link = memberMutation("contacts")({
  args: {
    contactId: v.id("contacts"),
    type: contactLinkTypeValidator,
    id: v.string(),
    linked: v.boolean(),
  },
  handler: (ctx, args) => linkContact(ctx, ctx.member, args, Date.now()),
});

export const merge = memberMutation("contacts")({
  args: {
    dryRun: v.optional(v.boolean()),
    company: v.optional(marketValidator),
    keepId: v.optional(v.id("contacts")),
    mergeId: v.optional(v.id("contacts")),
  },
  handler: (ctx, args) => mergeContacts(ctx, ctx.member, args, Date.now()),
});
