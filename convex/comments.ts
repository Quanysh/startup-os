// Comments on a task, a deal or a handoff (the board, or sales for a deal).
// The page, the MCP `comment_create` tool and an approved `comment` proposal
// all write through `addComment`. Text is data: cleaned, bounded, stored as
// plain text. `by` is a bot or agent slug, never an address.

import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import {
  COMMENT_ROWS,
  COMMENT_SUBJECTS,
  COMMENT_WORDS,
  MAX_COMMENT_BODY,
  commentArea,
  isCommentSubject,
  type CommentSubjectKind,
} from "./lib/comments";
import { cleanMemoryLines } from "./lib/memory";
import { NOT_ALLOWED, memberMutation, memberQuery, type Member } from "./lib/owner";
import { may, type Area } from "./lib/roles";

const subjectKindValidator = v.union(...COMMENT_SUBJECTS.map((kind) => v.literal(kind)));

type Subject = { kind: CommentSubjectKind; id: string; company: CompanyId | undefined; title: string };

async function subjectOf(
  ctx: QueryCtx,
  member: Member,
  kind: CommentSubjectKind,
  rawId: string,
  writing: boolean,
): Promise<Subject | null> {
  const elsewhere = () => {
    if (writing) throw new ConvexError(NOT_ALLOWED);
    return null;
  };
  if (kind === "task") {
    const id = ctx.db.normalizeId("tasks", rawId);
    const task = id === null ? null : await ctx.db.get(id);
    if (task === null || task.archivedAt !== undefined) return null;
    if (task.company !== undefined && !member.companies.includes(task.company)) return elsewhere();
    return { kind, id: task._id, company: task.company, title: task.title };
  }
  if (kind === "deal") {
    const id = ctx.db.normalizeId("deals", rawId);
    const deal = id === null ? null : await ctx.db.get(id);
    if (deal === null || deal.archivedAt !== undefined) return null;
    if (!member.companies.includes(deal.market)) return elsewhere();
    return { kind, id: deal._id, company: deal.market, title: deal.name };
  }
  const id = ctx.db.normalizeId("handoffs", rawId);
  const handoff = id === null ? null : await ctx.db.get(id);
  if (handoff === null) return null;
  if (!member.companies.includes(handoff.company)) return elsewhere();
  return { kind, id: handoff._id, company: handoff.company, title: handoff.title };
}

const holds = (areas: readonly Area[], area: Area) => may({ areas }, area);

export type CommentInput = { subjectKind: CommentSubjectKind; subjectId: string; body: string };

/**
 * Add a comment. `areas` is what the caller may write: the person's own, or
 * a bot's write areas when the tool runs as the owner. Lacking the subject's
 * area is a fixed sentence, never `not_allowed` (the gate already let them
 * in on the other of the two).
 */
export async function addComment(
  ctx: MutationCtx,
  member: Member,
  input: CommentInput,
  options?: { now?: number; by?: string; areas?: readonly Area[] },
): Promise<{ commentId: Id<"comments"> }> {
  if (!isCommentSubject(input.subjectKind)) throw new ConvexError(COMMENT_WORDS.gone);
  const subject = await subjectOf(ctx, member, input.subjectKind, input.subjectId, true);
  if (subject === null) throw new ConvexError(COMMENT_WORDS.gone);
  const areas = options?.areas ?? member.areas;
  if (!holds(areas, commentArea(subject.kind))) throw new ConvexError(COMMENT_WORDS.needsArea);
  const body = cleanMemoryLines(input.body, MAX_COMMENT_BODY, "A comment");
  if (body === "") throw new ConvexError(COMMENT_WORDS.body);
  const now = options?.now ?? Date.now();
  const commentId = await ctx.db.insert("comments", {
    subjectKind: subject.kind,
    subjectId: subject.id,
    ...(subject.company === undefined ? null : { company: subject.company }),
    body,
    createdBy: member.user._id,
    ...(options?.by === undefined ? null : { by: options.by }),
    createdAt: now,
  });
  return { commentId };
}

const presentComment = (row: {
  _id: Id<"comments">;
  subjectKind: CommentSubjectKind;
  subjectId: string;
  company?: CompanyId;
  body: string;
  createdAt: number;
  by?: string;
}) => ({
  id: row._id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  company: row.company ?? null,
  body: row.body,
  createdAt: row.createdAt,
  by: row.by ?? null,
});

/**
 * Newest comments on these companies, and, when `shared` is set, comments on a
 * shared task (no company). A comment whose area the caller does not hold is
 * left out. Oldest of the kept rows first, the same order as one subject.
 */
export async function recentComments(
  ctx: QueryCtx,
  member: Member,
  companies: readonly CompanyId[],
  areas: readonly Area[],
  shared: boolean,
) {
  const rows = [];
  for (const company of companies) {
    if (!member.companies.includes(company)) continue;
    rows.push(
      ...(await ctx.db
        .query("comments")
        .withIndex("by_company", (q) => q.eq("company", company))
        .order("desc")
        .take(COMMENT_ROWS)),
    );
  }
  if (shared) {
    rows.push(
      ...(await ctx.db
        .query("comments")
        .withIndex("by_company", (q) => q.eq("company", undefined))
        .order("desc")
        .take(COMMENT_ROWS)),
    );
  }
  return rows
    .filter((row) => holds(areas, commentArea(row.subjectKind)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, COMMENT_ROWS)
    .reverse()
    .map(presentComment);
}

/** Comments on one subject, oldest first, when the caller may read that subject's area. Else none. */
export async function commentsFor(
  ctx: QueryCtx,
  member: Member,
  args: { subjectKind: string; subjectId: string },
  areas: readonly Area[],
) {
  if (!isCommentSubject(args.subjectKind)) return [];
  if (!holds(areas, commentArea(args.subjectKind))) return [];
  const subject = await subjectOf(ctx, member, args.subjectKind, args.subjectId, false);
  if (subject === null) return [];
  const rows = await ctx.db
    .query("comments")
    .withIndex("by_subject", (q) => q.eq("subjectKind", subject.kind).eq("subjectId", subject.id))
    .order("desc")
    .take(COMMENT_ROWS);
  return rows.reverse().map(presentComment);
}

/** Whether this subject is still there for a proposal, and which company it belongs to. Null when it is gone. */
export async function commentTarget(
  ctx: QueryCtx,
  member: Member,
  kind: CommentSubjectKind,
  rawId: string,
): Promise<{ id: string; company: CompanyId | undefined } | null> {
  const subject = await subjectOf(ctx, member, kind, rawId, false);
  return subject === null ? null : { id: subject.id, company: subject.company };
}

export const list = memberQuery(["board", "sales"])({
  args: { subjectKind: subjectKindValidator, subjectId: v.string() },
  handler: (ctx, args) => commentsFor(ctx, ctx.member, args, ctx.member.areas),
});

export const create = memberMutation(["board", "sales"])({
  args: { subjectKind: subjectKindValidator, subjectId: v.string(), body: v.string() },
  handler: (ctx, args) => addComment(ctx, ctx.member, args, { areas: ctx.member.areas }),
});
