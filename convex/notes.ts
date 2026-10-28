// General notes on /memory (the `memory` area): a note the company keeps that
// is not the notes of a meeting. Each row is one company's, sent only to
// people on it. Text is data: cleaned, bounded, stored as plain text and
// rendered as text. No address goes in a log or a thrown error.

import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { MAX_TITLE_LENGTH } from "./lib/limits";
import { MAX_NOTE_BODY, MEMORY_LIST_ROWS, NOTE_WORDS, cleanMemoryLine, cleanMemoryLines } from "./lib/memory";
import { memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { companyValidator } from "./schema";

export type NoteInput = { company: CompanyId; title: string; body: string };

/**
 * Add a note. What `notes.create` runs and what the MCP `note_write` tool
 * runs, and what approving a `memory_note` proposal runs.
 * `by` is a bot or agent slug when one wrote it, never an address.
 */
export async function createNote(
  ctx: MutationCtx,
  member: Member,
  input: NoteInput,
  options?: { now?: number; by?: string },
): Promise<Id<"memoryNotes">> {
  requireCompany(member, input.company);
  const title = cleanMemoryLine(input.title, MAX_TITLE_LENGTH, "A title");
  if (title === "") throw new ConvexError(NOTE_WORDS.title);
  const body = cleanMemoryLines(input.body, MAX_NOTE_BODY, "A note");
  if (body === "") throw new ConvexError(NOTE_WORDS.body);
  const now = options?.now ?? Date.now();
  return await ctx.db.insert("memoryNotes", {
    company: input.company,
    title,
    body,
    createdBy: member.user._id,
    ...(options?.by === undefined ? null : { origin: { source: "agent" as const, by: options.by } }),
    createdAt: now,
    updatedAt: now,
  });
}

/** Notes of these companies, newest first, for the page and the read tool. */
export async function notesFor(ctx: QueryCtx, member: Member, companies: readonly CompanyId[]) {
  const rows = [];
  for (const company of companies) {
    if (!member.companies.includes(company)) continue;
    rows.push(
      ...(await ctx.db
        .query("memoryNotes")
        .withIndex("by_company_and_createdAt", (q) => q.eq("company", company))
        .order("desc")
        .take(MEMORY_LIST_ROWS)),
    );
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows.slice(0, MEMORY_LIST_ROWS).map((row) => ({
    id: row._id,
    company: row.company,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    /** A bot or agent slug when one wrote it. Never an address. */
    by: row.origin?.by ?? null,
  }));
}

export const list = memberQuery("memory")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    if (args.company !== undefined) requireCompany(ctx.member, args.company);
    return notesFor(ctx, ctx.member, args.company === undefined ? ctx.member.companies : [args.company]);
  },
});

export const create = memberMutation("memory")({
  args: { company: companyValidator, title: v.string(), body: v.string() },
  handler: (ctx, args) => createNote(ctx, ctx.member, args),
});
