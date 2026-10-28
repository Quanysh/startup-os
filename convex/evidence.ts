import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { categoryServesAny } from "./lib/company";
import {
  MAX_ANSWER_LENGTH,
  MAX_ANSWER_TAGS,
  MAX_ANSWER_TAG_LENGTH,
  MAX_CONTROL_ID_LENGTH,
  type AgreementRow,
  type AnswerRow,
  type ControlRow,
  type EvidenceFramework,
  type EvidenceItemRow,
  type QuestionnaireRow,
} from "./lib/evidence";
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from "./lib/limits";
import { NOT_ALLOWED, memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { cleanLink, cleanText, cleanTitle } from "./lib/text";
import { companyValidator } from "./schema";

// Security questionnaires, the answer bank, vendor agreements and HIPAA / SOC 2
// evidence: working records beside /compliance's dates. The page and the
// owner's agent (convex/lib/mcpTools.ts) write through the same functions
// below, so one set of checks holds for both, and `changedBy` says who wrote
// last. Links only (https): no document and no secret is stored here.

const questionnaireStatus = v.union(
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("sent"),
  v.literal("accepted"),
);
const agreementType = v.union(
  v.literal("baa"),
  v.literal("dpa"),
  v.literal("msa"),
  v.literal("nda"),
  v.literal("subscription"),
);
const agreementStatus = v.union(
  v.literal("draft"),
  v.literal("out_for_signature"),
  v.literal("active"),
  v.literal("ended"),
);
const framework = v.union(v.literal("hipaa"), v.literal("soc2"), v.literal("iso27001"));
const evidenceStatus = v.union(
  v.literal("missing"),
  v.literal("collected"),
  v.literal("expired"),
  v.literal("accepted"),
);
const text = v.union(v.string(), v.null());

export const GONE = "That record no longer exists.";
export const NEEDS = (what: string) => `A new record needs ${what}.`;

// ── Cleaning ────────────────────────────────────────────────────────────────

function day(value: string, what: string): string {
  if (!isCanonicalPeriodStart("day", value)) throw new ConvexError(`${what} is not a date.`);
  return value;
}
const note = (value: string) => cleanText(value, MAX_NOTES_LENGTH, "That note") || undefined;
const name = (value: string, what: string) => cleanText(value, MAX_NAME_LENGTH, what) || undefined;
const link = (value: string) => cleanLink(value, "A document link");

/**
 * The patch for an optional, clearable field: left out keeps it, null clears
 * it (an undefined patch value removes the field), a value is cleaned.
 */
function field<T, K extends string>(key: K, given: T | null | undefined, clean: (value: T) => unknown) {
  return given === undefined ? {} : { [key]: given === null ? undefined : clean(given) };
}

/** Who wrote: a person's name, else their address. */
export const personOf = (member: Member): string =>
  member.user.name?.trim() || member.user.email || "A teammate";

/** The row, or the refusal the app gives for one that is gone. */
function existing<T>(found: T | null): T {
  if (found === null) throw new ConvexError(GONE);
  return found;
}

// ── Presenting ──────────────────────────────────────────────────────────────

const changed = (row: { changedBy?: string; updatedAt: number }) => ({
  changedBy: row.changedBy ?? null,
  changedAt: row.updatedAt,
});

const presentQuestionnaire = (q: Doc<"securityQuestionnaires">): QuestionnaireRow => ({
  id: q._id,
  requester: q.requester,
  company: q.company,
  receivedOn: q.receivedOn ?? null,
  dueOn: q.dueOn ?? null,
  status: q.status,
  owner: q.owner ?? null,
  link: q.link ?? null,
  notes: q.notes ?? null,
  ...changed(q),
});

const presentAnswer = (a: Doc<"answerBank">): AnswerRow => ({
  id: a._id,
  question: a.question,
  answer: a.answer,
  tags: a.tags,
  company: a.company ?? null,
  lastReviewedOn: a.lastReviewedOn ?? null,
  ...changed(a),
});

const presentAgreement = (a: Doc<"vendorAgreements">): AgreementRow => ({
  id: a._id,
  vendor: a.vendor,
  type: a.type,
  company: a.company,
  signedOn: a.signedOn ?? null,
  expiresOn: a.expiresOn ?? null,
  status: a.status,
  link: a.link ?? null,
  notes: a.notes ?? null,
  ...changed(a),
});

const presentItem = (i: Doc<"evidenceItems">): EvidenceItemRow => ({
  id: i._id,
  title: i.title,
  link: i.link ?? null,
  owner: i.owner ?? null,
  collectedOn: i.collectedOn ?? null,
  validUntil: i.validUntil ?? null,
  status: i.status,
  ...changed(i),
});

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byDueThenName = (a: { date: string | null; name: string }, b: { date: string | null; name: string }) =>
  a.date !== b.date
    ? a.date === null
      ? 1
      : b.date === null
        ? -1
        : byText(a.date, b.date)
    : byText(a.name, b.name);

/**
 * Reads. What the queries return and what the owner's agent reads
 * (`compliance_evidence`): one function each, so the two cannot drift. A row
 * is sent only for a company the caller is on. Which are due or expired
 * depends on today's date, which a query must not read (convex/lib/evidence.ts).
 */
export async function questionnairesFor(ctx: QueryCtx, member: Member): Promise<QuestionnaireRow[]> {
  const rows = (await ctx.db.query("securityQuestionnaires").collect())
    .filter((q) => member.companies.includes(q.company))
    .map(presentQuestionnaire);
  return rows.sort((a, b) =>
    byDueThenName({ date: a.dueOn, name: a.requester }, { date: b.dueOn, name: b.requester }),
  );
}

export async function answersFor(ctx: QueryCtx, member: Member): Promise<AnswerRow[]> {
  const rows = (await ctx.db.query("answerBank").collect())
    .filter((a) => a.company === undefined || member.companies.includes(a.company))
    .map(presentAnswer);
  return rows.sort((a, b) => byText(a.question.toLowerCase(), b.question.toLowerCase()));
}

export async function agreementsFor(ctx: QueryCtx, member: Member): Promise<AgreementRow[]> {
  const rows = (await ctx.db.query("vendorAgreements").collect())
    .filter((a) => member.companies.includes(a.company))
    .map(presentAgreement);
  return rows.sort((a, b) =>
    byDueThenName({ date: a.expiresOn, name: a.vendor }, { date: b.expiresOn, name: b.vendor }),
  );
}

export async function controlsFor(ctx: QueryCtx, member: Member): Promise<ControlRow[]> {
  const controls = (await ctx.db.query("complianceControls").collect()).filter((c) =>
    categoryServesAny(member.companies, c.framework),
  );
  const rows: ControlRow[] = [];
  for (const c of controls) {
    const items = await ctx.db
      .query("evidenceItems")
      .withIndex("by_controlId", (q) => q.eq("controlId", c._id))
      .collect();
    rows.push({
      id: c._id,
      framework: c.framework,
      controlId: c.controlId,
      title: c.title,
      items: items.map(presentItem).sort((a, b) => byText(a.title, b.title)),
      ...changed(c),
    });
  }
  return rows.sort((a, b) =>
    a.framework !== b.framework
      ? byText(a.framework, b.framework)
      : a.controlId.localeCompare(b.controlId, "en", { numeric: true }),
  );
}

export const questionnaires = memberQuery("compliance")({
  args: {},
  handler: (ctx) => questionnairesFor(ctx, ctx.member),
});
export const answers = memberQuery("compliance")({
  args: {},
  handler: (ctx) => answersFor(ctx, ctx.member),
});
export const agreements = memberQuery("compliance")({
  args: {},
  handler: (ctx) => agreementsFor(ctx, ctx.member),
});
export const controls = memberQuery("compliance")({
  args: {},
  handler: (ctx) => controlsFor(ctx, ctx.member),
});

// ── Writing ─────────────────────────────────────────────────────────────────

export const questionnaireFields = {
  id: v.optional(v.id("securityQuestionnaires")),
  requester: v.optional(v.string()),
  company: v.optional(companyValidator),
  receivedOn: v.optional(text),
  dueOn: v.optional(text),
  status: v.optional(questionnaireStatus),
  owner: v.optional(text),
  link: v.optional(text),
  notes: v.optional(text),
};
export type QuestionnaireInput = Infer<ReturnType<typeof v.object<typeof questionnaireFields>>>;

/** Add a questionnaire (no `id`), or change one: only what is sent changes, null clears. */
export async function upsertQuestionnaire(
  ctx: MutationCtx,
  member: Member,
  a: QuestionnaireInput,
  by: string,
): Promise<Id<"securityQuestionnaires">> {
  const current = a.id === undefined ? null : existing(await ctx.db.get(a.id));
  if (current !== null) requireCompany(member, current.company);
  if (a.company !== undefined) requireCompany(member, a.company);
  if (current === null && (a.requester === undefined || a.company === undefined)) {
    throw new ConvexError(NEEDS("a requester and a company"));
  }
  const patch = {
    ...(a.requester === undefined ? {} : { requester: cleanTitle(a.requester, "questionnaire") }),
    ...(a.company === undefined ? {} : { company: a.company }),
    ...(a.status === undefined ? {} : { status: a.status }),
    ...field("receivedOn", a.receivedOn, (d) => day(d, "The received date")),
    ...field("dueOn", a.dueOn, (d) => day(d, "The due date")),
    ...field("owner", a.owner, (o) => name(o, "That owner")),
    ...field("link", a.link, link),
    ...field("notes", a.notes, note),
    changedBy: by,
    updatedAt: Date.now(),
  };
  if (current !== null) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }
  return await ctx.db.insert("securityQuestionnaires", {
    requester: patch.requester!,
    company: a.company!,
    status: "todo",
    ...patch,
  });
}

export const answerFields = {
  id: v.optional(v.id("answerBank")),
  question: v.optional(v.string()),
  answer: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  company: v.optional(v.union(companyValidator, v.null())),
  lastReviewedOn: v.optional(text),
};
export type AnswerInput = Infer<ReturnType<typeof v.object<typeof answerFields>>>;

function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag === "" || out.includes(tag)) continue;
    if (tag.length > MAX_ANSWER_TAG_LENGTH) {
      throw new ConvexError(`A tag may be at most ${MAX_ANSWER_TAG_LENGTH} characters.`);
    }
    out.push(tag);
  }
  if (out.length > MAX_ANSWER_TAGS) throw new ConvexError(`An answer may have at most ${MAX_ANSWER_TAGS} tags.`);
  return out;
}

/** Add an answer to the bank (no `id`), or change one. Everything in the bank is approved: it is what a bot may draft from. */
export async function upsertAnswer(
  ctx: MutationCtx,
  member: Member,
  a: AnswerInput,
  by: string,
): Promise<Id<"answerBank">> {
  const current = a.id === undefined ? null : existing(await ctx.db.get(a.id));
  if (current?.company !== undefined) requireCompany(member, current.company);
  if (a.company) requireCompany(member, a.company);
  if (current === null && (a.question === undefined || a.answer === undefined)) {
    throw new ConvexError(NEEDS("a question and an answer"));
  }
  const question = a.question === undefined ? undefined : cleanTitle(a.question, "question");
  const answer =
    a.answer === undefined ? undefined : cleanText(a.answer, MAX_ANSWER_LENGTH, "That answer");
  if (answer === "") throw new ConvexError("An answer cannot be empty.");
  const patch = {
    ...(question === undefined ? {} : { question }),
    ...(answer === undefined ? {} : { answer }),
    ...(a.tags === undefined ? {} : { tags: cleanTags(a.tags) }),
    ...field("company", a.company, (c) => c),
    ...field("lastReviewedOn", a.lastReviewedOn, (d) => day(d, "The review date")),
    changedBy: by,
    updatedAt: Date.now(),
  };
  if (current !== null) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }
  return await ctx.db.insert("answerBank", { question: question!, answer: answer!, tags: [], ...patch });
}

export const agreementFields = {
  id: v.optional(v.id("vendorAgreements")),
  vendor: v.optional(v.string()),
  type: v.optional(agreementType),
  company: v.optional(companyValidator),
  signedOn: v.optional(text),
  expiresOn: v.optional(text),
  status: v.optional(agreementStatus),
  link: v.optional(text),
  notes: v.optional(text),
};
export type AgreementInput = Infer<ReturnType<typeof v.object<typeof agreementFields>>>;

export async function upsertAgreement(
  ctx: MutationCtx,
  member: Member,
  a: AgreementInput,
  by: string,
): Promise<Id<"vendorAgreements">> {
  const current = a.id === undefined ? null : existing(await ctx.db.get(a.id));
  if (current !== null) requireCompany(member, current.company);
  if (a.company !== undefined) requireCompany(member, a.company);
  if (current === null && (a.vendor === undefined || a.type === undefined || a.company === undefined)) {
    throw new ConvexError(NEEDS("a vendor, a type and a company"));
  }
  const signedOn = a.signedOn === undefined ? current?.signedOn : (a.signedOn ?? undefined);
  const expiresOn = a.expiresOn === undefined ? current?.expiresOn : (a.expiresOn ?? undefined);
  if (signedOn !== undefined && expiresOn !== undefined && expiresOn < signedOn) {
    throw new ConvexError("An agreement cannot expire before it was signed.");
  }
  const patch = {
    ...(a.vendor === undefined ? {} : { vendor: cleanTitle(a.vendor, "vendor") }),
    ...(a.type === undefined ? {} : { type: a.type }),
    ...(a.company === undefined ? {} : { company: a.company }),
    ...(a.status === undefined ? {} : { status: a.status }),
    ...field("signedOn", a.signedOn, (d) => day(d, "The signed date")),
    ...field("expiresOn", a.expiresOn, (d) => day(d, "The expiry date")),
    ...field("link", a.link, link),
    ...field("notes", a.notes, note),
    changedBy: by,
    updatedAt: Date.now(),
  };
  if (current !== null) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }
  return await ctx.db.insert("vendorAgreements", {
    vendor: patch.vendor!,
    type: a.type!,
    company: a.company!,
    status: "draft",
    ...patch,
  });
}

export const controlFields = {
  id: v.optional(v.id("complianceControls")),
  framework: v.optional(framework),
  controlId: v.optional(v.string()),
  title: v.optional(v.string()),
};
export type ControlInput = Infer<ReturnType<typeof v.object<typeof controlFields>>>;

function requireFramework(member: Member, framework: EvidenceFramework) {
  if (!categoryServesAny(member.companies, framework)) throw new ConvexError(NOT_ALLOWED);
}

const cleanControlId = (id: string) => {
  const trimmed = cleanText(id, MAX_CONTROL_ID_LENGTH, "A control id");
  if (trimmed === "") throw new ConvexError("A control needs an id, such as CC6.1.");
  return trimmed;
};

/** Add a control (no `id`), or change one. A control is one per framework and id. */
export async function upsertControl(
  ctx: MutationCtx,
  member: Member,
  a: ControlInput,
  by: string,
): Promise<Id<"complianceControls">> {
  const current = a.id === undefined ? null : existing(await ctx.db.get(a.id));
  if (current !== null) requireFramework(member, current.framework);
  if (a.framework !== undefined) requireFramework(member, a.framework);
  if (current === null && (a.framework === undefined || a.controlId === undefined || a.title === undefined)) {
    throw new ConvexError(NEEDS("a framework, an id and a title"));
  }
  const nextFramework = a.framework ?? current!.framework;
  const nextControlId = a.controlId === undefined ? current!.controlId : cleanControlId(a.controlId);
  const twin = await ctx.db
    .query("complianceControls")
    .withIndex("by_framework_and_controlId", (q) => q.eq("framework", nextFramework).eq("controlId", nextControlId))
    .first();
  if (twin !== null && twin._id !== current?._id) {
    throw new ConvexError("That control is already listed for that framework.");
  }
  const patch = {
    framework: nextFramework,
    controlId: nextControlId,
    ...(a.title === undefined ? {} : { title: cleanTitle(a.title, "control") }),
    changedBy: by,
    updatedAt: Date.now(),
  };
  if (current !== null) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }
  return await ctx.db.insert("complianceControls", { ...patch, title: patch.title! });
}

export const itemFields = {
  id: v.optional(v.id("evidenceItems")),
  controlId: v.optional(v.id("complianceControls")),
  title: v.optional(v.string()),
  link: v.optional(text),
  owner: v.optional(text),
  collectedOn: v.optional(text),
  validUntil: v.optional(text),
  status: v.optional(evidenceStatus),
};
export type ItemInput = Infer<ReturnType<typeof v.object<typeof itemFields>>>;

/** Add an evidence item to a control (no `id`), or change one. */
export async function upsertEvidenceItem(
  ctx: MutationCtx,
  member: Member,
  a: ItemInput,
  by: string,
): Promise<Id<"evidenceItems">> {
  const current = a.id === undefined ? null : existing(await ctx.db.get(a.id));
  const controlId = a.controlId ?? current?.controlId;
  if (controlId === undefined) throw new ConvexError(NEEDS("a control"));
  const control = existing(await ctx.db.get(controlId));
  requireFramework(member, control.framework);
  if (a.controlId !== undefined && current !== null && current.controlId !== a.controlId) {
    throw new ConvexError("Evidence cannot be moved to another control.");
  }
  if (current === null && a.title === undefined) throw new ConvexError(NEEDS("a title"));
  const collectedOn = a.collectedOn === undefined ? current?.collectedOn : (a.collectedOn ?? undefined);
  const validUntil = a.validUntil === undefined ? current?.validUntil : (a.validUntil ?? undefined);
  if (collectedOn !== undefined && validUntil !== undefined && validUntil < collectedOn) {
    throw new ConvexError("Evidence cannot be valid until before it was collected.");
  }
  const patch = {
    ...(a.title === undefined ? {} : { title: cleanTitle(a.title, "evidence item") }),
    ...(a.status === undefined ? {} : { status: a.status }),
    ...field("link", a.link, link),
    ...field("owner", a.owner, (o) => name(o, "That owner")),
    ...field("collectedOn", a.collectedOn, (d) => day(d, "The collected date")),
    ...field("validUntil", a.validUntil, (d) => day(d, "The valid-until date")),
    changedBy: by,
    updatedAt: Date.now(),
  };
  if (current !== null) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }
  return await ctx.db.insert("evidenceItems", {
    controlId: control._id,
    title: patch.title!,
    // Evidence with a link is collected; without one, still to find.
    status: typeof a.link === "string" ? "collected" : "missing",
    ...patch,
  });
}

export const questionnaireUpsert = memberMutation("compliance")({
  args: questionnaireFields,
  handler: (ctx, args) => upsertQuestionnaire(ctx, ctx.member, args, personOf(ctx.member)),
});
export const answerUpsert = memberMutation("compliance")({
  args: answerFields,
  handler: (ctx, args) => upsertAnswer(ctx, ctx.member, args, personOf(ctx.member)),
});
export const agreementUpsert = memberMutation("compliance")({
  args: agreementFields,
  handler: (ctx, args) => upsertAgreement(ctx, ctx.member, args, personOf(ctx.member)),
});
export const controlUpsert = memberMutation("compliance")({
  args: controlFields,
  handler: (ctx, args) => upsertControl(ctx, ctx.member, args, personOf(ctx.member)),
});
export const evidenceItemUpsert = memberMutation("compliance")({
  args: itemFields,
  handler: (ctx, args) => upsertEvidenceItem(ctx, ctx.member, args, personOf(ctx.member)),
});

// Removing one that is already gone does nothing.

export const questionnaireRemove = memberMutation("compliance")({
  args: { id: v.id("securityQuestionnaires") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    requireCompany(ctx.member, row.company);
    await ctx.db.delete(id);
    return null;
  },
});
export const answerRemove = memberMutation("compliance")({
  args: { id: v.id("answerBank") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    if (row.company !== undefined) requireCompany(ctx.member, row.company);
    await ctx.db.delete(id);
    return null;
  },
});
export const agreementRemove = memberMutation("compliance")({
  args: { id: v.id("vendorAgreements") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    requireCompany(ctx.member, row.company);
    await ctx.db.delete(id);
    return null;
  },
});
/** Removing a control removes its evidence with it. */
export const controlRemove = memberMutation("compliance")({
  args: { id: v.id("complianceControls") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    requireFramework(ctx.member, row.framework);
    const items = await ctx.db
      .query("evidenceItems")
      .withIndex("by_controlId", (q) => q.eq("controlId", id))
      .collect();
    for (const item of items) await ctx.db.delete(item._id);
    await ctx.db.delete(id);
    return null;
  },
});
export const evidenceItemRemove = memberMutation("compliance")({
  args: { id: v.id("evidenceItems") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    const control = await ctx.db.get(row.controlId);
    if (control !== null) requireFramework(ctx.member, control.framework);
    await ctx.db.delete(id);
    return null;
  },
});
