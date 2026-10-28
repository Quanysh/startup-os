// The LinkedIn content calendar (/linkedin, the `gtm` area): posts of a
// company page or a named person's profile, planned, drafted, scheduled and
// published, with dated snapshots of the figures LinkedIn shows under each.
// No LinkedIn API is called and nothing is published from here: a post and its
// figures are typed by a person, or pushed by a bot through the owner's agent
// (`linkedin_post_upsert`, `linkedin_stats_add` in convex/lib/mcpTools.ts),
// which run `savePost` and `addStats` below, the same functions the page's
// forms run, so both are held to the same limits.
//
// Each row is one company's: a handler sends only the caller's companies'
// rows and refuses a write to another's, in the words of a missing permission.
// Text is cleaned and bounded (convex/lib/linkedin.ts), stored as plain text,
// rendered as text and in no log or thrown error. A query reads no clock: the
// page works out "today" and the weeks itself.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { checkOwner } from "./decisions";
import type { CompanyId } from "./lib/company";
import { MAX_NAME_LENGTH } from "./lib/limits";
import {
  ACCOUNT_KINDS,
  FIGURES,
  LINKEDIN_WORDS,
  MAX_FIGURE,
  MAX_PILLAR_LENGTH,
  MAX_POST_BODY,
  MAX_POST_TITLE,
  MAX_TARGET_PER_WEEK,
  POST_LIST_ROWS,
  POST_STATUSES,
  STATS_LIST_ROWS,
  addDays,
  cleanLink,
  isDay,
  utcDay,
  type AccountKind,
  type Figure,
  type PostStatus,
} from "./lib/linkedin";
import { cleanMemoryLine, cleanMemoryLines } from "./lib/memory";
import { memberMutation, memberQuery, requireCompany, NOT_ALLOWED, type Member } from "./lib/owner";
import { assignablePeople, knows, nameOf, teamDirectory } from "./lib/teamDirectory";
import { companyValidator } from "./schema";

type Post = Doc<"linkedinPosts">;
type Stat = Doc<"linkedinStats">;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

/** Who wrote a row when it was not a person: the client's name, cut. Never a token. */
export type Origin = { client?: string };
const originOf = (origin: Origin | undefined) =>
  origin === undefined
    ? null
    : {
        origin: {
          source: "agent" as const,
          ...(origin.client === undefined || origin.client === ""
            ? null
            : { client: cleanMemoryLine(origin.client, MAX_NAME_LENGTH, "A client name") }),
        },
      };

// ── Writing a post ──────────────────────────────────────────────────────────

/**
 * What a post takes, as typed. On a new post `company` and `title` are
 * required; on a change (`id`) only what is given changes, and `null` clears
 * a field that can be empty.
 */
export type PostInput = {
  id?: Id<"linkedinPosts">;
  company?: CompanyId;
  account?: AccountKind;
  person?: string | null;
  status?: PostStatus;
  title?: string;
  body?: string | null;
  pillar?: string | null;
  owner?: string | null;
  plannedAt?: number | null;
  publishedAt?: number | null;
  link?: string | null;
};

/** An instant as a number the database can order and a Date can hold. */
function instant(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > 8.64e15) {
    return refuse(LINKEDIN_WORDS.notADate);
  }
  return value;
}

/** A row the caller may change: there, and of one of their companies. */
async function ownPost(ctx: QueryCtx, member: Member, id: Id<"linkedinPosts">): Promise<Post> {
  const row = await ctx.db.get(id);
  if (row === null) return refuse(LINKEDIN_WORDS.postGone);
  if (!member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
  return row;
}

/**
 * Create a post, or change one. What the page's form runs and what the owner's
 * agent's `linkedin_post_upsert` runs. Returns the post's id.
 */
export async function savePost(
  ctx: MutationCtx,
  member: Member,
  input: PostInput,
  now: number,
  origin?: Origin,
): Promise<{ id: Id<"linkedinPosts">; created: boolean }> {
  const was = input.id === undefined ? null : await ownPost(ctx, member, input.id);
  const company = was?.company ?? input.company ?? refuse("A post needs its company.");
  if (was !== null && input.company !== undefined && input.company !== was.company) {
    refuse(LINKEDIN_WORDS.postElsewhere);
  }
  requireCompany(member, company);

  const given = <T>(value: T | undefined, kept: T | undefined) => (value === undefined ? kept : value);
  const status = input.status ?? was?.status ?? "idea";
  const account = input.account ?? was?.account ?? "page";

  const title = cleanMemoryLine(input.title ?? was?.title ?? "", MAX_POST_TITLE, "That hook");
  if (title === "") refuse(LINKEDIN_WORDS.needsTitle);

  const bodyText = given(input.body, was?.body);
  const body = bodyText == null ? "" : cleanMemoryLines(bodyText, MAX_POST_BODY, "That draft");
  const pillarText = given(input.pillar, was?.pillar);
  const pillar = pillarText == null ? "" : cleanMemoryLine(pillarText, MAX_PILLAR_LENGTH, "That pillar");

  let person: string | undefined;
  if (account === "person") {
    const name = cleanMemoryLine(given(input.person, was?.person) ?? "", MAX_NAME_LENGTH, "That name");
    if (name === "") refuse(LINKEDIN_WORDS.needsPerson);
    if (name.includes("@")) refuse(LINKEDIN_WORDS.nameOnly);
    person = name;
  } else if (input.person != null && input.person !== "") {
    refuse(LINKEDIN_WORDS.pageHasNoPerson);
  }

  const owner = await checkOwner(ctx, member, given(input.owner, was?.owner), company);

  const plannedAt = instant(given(input.plannedAt, was?.plannedAt));
  // A publish time and a link belong to a published post: leaving that state
  // drops them, and giving them to any other is refused.
  if (status !== "published" && (input.publishedAt != null || (input.link != null && input.link !== ""))) {
    refuse(LINKEDIN_WORDS.publishedOnly);
  }
  const publishedAt = status === "published" ? instant(given(input.publishedAt, was?.publishedAt)) : undefined;
  const linkText = status === "published" ? given(input.link, was?.link) : undefined;
  const link = linkText == null || linkText.trim() === "" ? undefined : (cleanLink(linkText) ?? refuse(LINKEDIN_WORDS.badLink));
  if (status === "scheduled" && plannedAt === undefined) refuse(LINKEDIN_WORDS.needsPlanned);
  if (status === "published" && publishedAt === undefined) refuse(LINKEDIN_WORDS.needsPublished);

  const fields = {
    company,
    account,
    ...(person === undefined ? null : { person }),
    status,
    title,
    ...(body === "" ? null : { body }),
    ...(pillar === "" ? null : { pillar }),
    ...(owner === undefined ? null : { owner }),
    ...(plannedAt === undefined ? null : { plannedAt }),
    ...(publishedAt === undefined ? null : { publishedAt }),
    ...(link === undefined ? null : { link }),
    sortAt: publishedAt ?? plannedAt ?? was?.createdAt ?? now,
  };
  if (was === null) {
    const id = await ctx.db.insert("linkedinPosts", {
      ...fields,
      createdBy: member.user._id,
      ...originOf(origin),
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  }
  await ctx.db.replace(was._id, {
    ...fields,
    createdBy: was.createdBy,
    ...(was.origin === undefined ? null : { origin: was.origin }),
    createdAt: was.createdAt,
    updatedAt: now,
  });
  return { id: was._id, created: false };
}

// ── Writing figures ─────────────────────────────────────────────────────────

export type StatsInput = {
  postId: Id<"linkedinPosts">;
  /** The day the figures were read, "YYYY-MM-DD". */
  day: string;
} & Partial<Record<Figure, number>>;

/**
 * Keep a post's figures as read on a day. A second set for the same day fills
 * in what it gives and leaves the rest. What the page's form and the agent's
 * `linkedin_stats_add` run.
 */
export async function addStats(
  ctx: MutationCtx,
  member: Member,
  input: StatsInput,
  now: number,
  origin?: Origin,
): Promise<{ id: Id<"linkedinStats">; replaced: boolean }> {
  const post = await ownPost(ctx, member, input.postId);
  if (post.status !== "published" || post.publishedAt === undefined) refuse(LINKEDIN_WORDS.statsForPublished);
  if (!isDay(input.day)) refuse(LINKEDIN_WORDS.notADate);
  // A day either side of the server's UTC day is the browser's: the same slack as the agent's `today`.
  if (input.day > addDays(utcDay(now), 1)) refuse(LINKEDIN_WORDS.statsInFuture);
  if (input.day < addDays(utcDay(post.publishedAt!), -1)) refuse(LINKEDIN_WORDS.statsBeforePublished);
  const figures: Partial<Record<Figure, number>> = {};
  for (const figure of FIGURES) {
    const value = input[figure];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_FIGURE) refuse(LINKEDIN_WORDS.figureRange);
    figures[figure] = value;
  }
  if (Object.keys(figures).length === 0) refuse(LINKEDIN_WORDS.noFigures);

  const same = await ctx.db
    .query("linkedinStats")
    .withIndex("by_postId_and_day", (q) => q.eq("postId", post._id).eq("day", input.day))
    .take(1);
  if (same[0] !== undefined) {
    await ctx.db.patch(same[0]._id, { ...figures, updatedAt: now });
    return { id: same[0]._id, replaced: true };
  }
  const id = await ctx.db.insert("linkedinStats", {
    postId: post._id,
    company: post.company,
    day: input.day,
    ...figures,
    createdBy: member.user._id,
    ...originOf(origin),
    createdAt: now,
    updatedAt: now,
  });
  return { id, replaced: false };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The companies a read covers: one the caller names (theirs), or all of theirs. */
function companiesFor(member: Member, company: CompanyId | undefined): readonly CompanyId[] {
  if (company === undefined) return member.companies;
  requireCompany(member, company);
  return [company];
}

const figuresOf = (row: Stat) => ({
  impressions: row.impressions ?? null,
  reactions: row.reactions ?? null,
  comments: row.comments ?? null,
  reposts: row.reposts ?? null,
  clicks: row.clicks ?? null,
  followersGained: row.followersGained ?? null,
});

/**
 * The newest posts of these companies (`POST_LIST_ROWS` each), each with its
 * snapshots, oldest first. What the page reads and the agent's
 * `linkedin_posts` reads, so what a bot is told and what the page shows
 * cannot drift. The owner is an address, shown only to a caller who shares a
 * company with that person.
 */
export async function postsFor(ctx: QueryCtx, member: Member, companies: readonly CompanyId[]) {
  const directory = await teamDirectory(ctx.db);
  const posts: Post[] = [];
  const stats: Stat[] = [];
  for (const company of companies.filter((c) => member.companies.includes(c))) {
    posts.push(
      ...(await ctx.db
        .query("linkedinPosts")
        .withIndex("by_company_and_sortAt", (q) => q.eq("company", company))
        .order("desc")
        .take(POST_LIST_ROWS)),
    );
    stats.push(
      ...(await ctx.db
        .query("linkedinStats")
        .withIndex("by_company_and_day", (q) => q.eq("company", company))
        .order("desc")
        .take(STATS_LIST_ROWS)),
    );
  }
  const byPost = new Map<string, Stat[]>();
  for (const row of stats) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), row]);
  const rows = [];
  for (const post of posts.sort((a, b) => b.sortAt - a.sortAt || (a._id < b._id ? -1 : 1))) {
    const person = post.owner === undefined ? undefined : directory.get(post.owner);
    const owner =
      post.owner === undefined
        ? null
        : person !== undefined && knows(member, person)
          ? { email: post.owner, name: await nameOf(ctx.db, post.owner) }
          : { email: null, name: null };
    rows.push({
      id: post._id,
      company: post.company,
      account: post.account,
      person: post.person ?? null,
      status: post.status,
      title: post.title,
      body: post.body ?? null,
      pillar: post.pillar ?? null,
      owner,
      plannedAt: post.plannedAt ?? null,
      publishedAt: post.publishedAt ?? null,
      link: post.link ?? null,
      byClient: post.origin === undefined ? null : (post.origin.client ?? "a connected client"),
      updatedAt: post.updatedAt,
      snapshots: (byPost.get(post._id) ?? [])
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .map((row) => ({
          id: row._id,
          day: row.day,
          ...figuresOf(row),
          byClient: row.origin === undefined ? null : (row.origin.client ?? "a connected client"),
        })),
    });
  }
  return rows;
}

export const list = memberQuery("gtm")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    const companies = companiesFor(ctx.member, args.company);
    const targets = [];
    for (const company of companies) {
      const row = await ctx.db.query("linkedinTargets").withIndex("by_company", (q) => q.eq("company", company)).first();
      if (row !== null) targets.push({ company, postsPerWeek: row.postsPerWeek, updatedAt: row.updatedAt });
    }
    return { posts: await postsFor(ctx, ctx.member, companies), targets };
  },
});

/** Who may own a post of a company (one of the caller's): a name and an address. */
export const people = memberQuery("gtm")({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    return assignablePeople(ctx, ctx.member, args.company);
  },
});

// ── Writing, from the page ──────────────────────────────────────────────────

const accountValidator = v.union(...ACCOUNT_KINDS.map((kind) => v.literal(kind)));
const statusValidator = v.union(...POST_STATUSES.map((status) => v.literal(status)));

/** Save a whole post from the form: every field is sent, an empty one clears. */
export const save = memberMutation("gtm")({
  args: {
    id: v.optional(v.id("linkedinPosts")),
    company: companyValidator,
    account: accountValidator,
    person: v.union(v.string(), v.null()),
    status: statusValidator,
    title: v.string(),
    body: v.union(v.string(), v.null()),
    pillar: v.union(v.string(), v.null()),
    owner: v.union(v.string(), v.null()),
    plannedAt: v.union(v.number(), v.null()),
    publishedAt: v.union(v.number(), v.null()),
    link: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => (await savePost(ctx, ctx.member, args, Date.now())).id,
});

/** Delete a post and its figures. One already gone is no error, so a double-click is safe. */
export const remove = memberMutation("gtm")({
  args: { id: v.id("linkedinPosts") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    if (!ctx.member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
    for (;;) {
      const batch = await ctx.db
        .query("linkedinStats")
        .withIndex("by_postId_and_day", (q) => q.eq("postId", args.id))
        .take(200);
      if (batch.length === 0) break;
      for (const stat of batch) await ctx.db.delete(stat._id);
    }
    await ctx.db.delete(args.id);
    return null;
  },
});

/** Keep a post's figures as read on a day (a second set for the day fills in what it gives). */
export const addSnapshot = memberMutation("gtm")({
  args: {
    postId: v.id("linkedinPosts"),
    day: v.string(),
    impressions: v.optional(v.number()),
    reactions: v.optional(v.number()),
    comments: v.optional(v.number()),
    reposts: v.optional(v.number()),
    clicks: v.optional(v.number()),
    followersGained: v.optional(v.number()),
  },
  handler: async (ctx, args) => (await addStats(ctx, ctx.member, args, Date.now())).id,
});

/** Delete one snapshot (a figure typed wrong). One already gone is no error. */
export const removeSnapshot = memberMutation("gtm")({
  args: { id: v.id("linkedinStats") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    if (!ctx.member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
    await ctx.db.delete(args.id);
    return null;
  },
});

/** Set the posts a week a company means to put out. 0 clears the target. */
export const setTarget = memberMutation("gtm")({
  args: { company: companyValidator, postsPerWeek: v.number() },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    if (!Number.isInteger(args.postsPerWeek) || args.postsPerWeek < 0 || args.postsPerWeek > MAX_TARGET_PER_WEEK) {
      refuse(LINKEDIN_WORDS.badTarget);
    }
    const row = await ctx.db.query("linkedinTargets").withIndex("by_company", (q) => q.eq("company", args.company)).first();
    if (args.postsPerWeek === 0) {
      if (row !== null) await ctx.db.delete(row._id);
      return null;
    }
    const fields = { postsPerWeek: args.postsPerWeek, updatedBy: ctx.member.user._id, updatedAt: Date.now() };
    if (row === null) await ctx.db.insert("linkedinTargets", { company: args.company, ...fields });
    else await ctx.db.patch(row._id, fields);
    return null;
  },
});
