import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { cleanRemote } from "./lib/mirrorRules";
import { NOT_ALLOWED, memberMutation, memberQuery, requireCompany, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { isQuarter } from "./lib/quarter";
import { GOAL_TARGET_AREAS, may, type Area } from "./lib/roles";
import { knows, nameOf, teamDirectory } from "./lib/teamDirectory";
import { cleanTitle } from "./lib/text";
import { companyValidator, goalStatusValidator } from "./schema";

/**
 * A quarter's goals in their order, for the companies given: a goal with no
 * company (every goal from before goals had one) is both companies', and one
 * company's goal is sent only where that company is asked for. What
 * `goals.list` returns and what the owner's agent reads
 * (convex/lib/mcpTools.ts): one function. `reader` is who it is for: a
 * target goes only to one who holds `GOAL_TARGET_AREAS`.
 */
export async function goalsFor(
  ctx: QueryCtx,
  quarter: string,
  companies: readonly CompanyId[],
  reader: { areas: readonly Area[] },
) {
  const seesTarget = may(reader, GOAL_TARGET_AREAS);
  const goals = await ctx.db
    .query("goals")
    .withIndex("by_quarter_and_order", (q) => q.eq("quarter", quarter))
    .collect();
  const directory = goals.some((g) => g.ownerEmail !== undefined) ? await teamDirectory(ctx.db) : null;
  /** A goal's owner, to a reader who shares a company with them; null otherwise or when none. */
  const ownerOf = async (email: string | undefined) => {
    const person = email === undefined ? undefined : directory?.get(email);
    if (person === undefined || !person.companies.some((c) => companies.includes(c))) return null;
    return { email: person.email, name: await nameOf(ctx.db, person.email) };
  };
  const shown = goals.filter((g) => g.company === undefined || companies.includes(g.company));
  const owners = await Promise.all(shown.map((g) => ownerOf(g.ownerEmail)));
  return shown
    .map((g, index) => ({
      id: g._id,
      quarter: g.quarter,
      title: g.title,
      status: g.status,
      /** Null: both companies'. */
      company: g.company ?? null,
      /** A cash goal (pre-seed, collections): its proposals are pinned in "Cash and runway" on /approvals. */
      cash: g.cash === true,
      /** When it was made or last renamed or re-rated: the Goals page's "last change". */
      changedAt: g.updatedAt ?? g._creationTime,
      /** Who answers for it, as an address and the name they signed in with; null when none (or not someone the reader shares a company with). */
      owner: owners[index] ?? null,
      /** The bot profile's id that works on it, or null. */
      ownerBot: g.ownerBot ?? null,
      /** What done looks like, in a few words, or null (also to a reader without `GOAL_TARGET_AREAS`). */
      target: seesTarget ? (g.target ?? null) : null,
      /** "YYYY-MM-DD", or null. */
      dueOn: g.dueOn ?? null,
    }));
}

/** Every refusal about a goal's owner, bot, target or due day, and a link to one: fixed words, never the value. */
export const GOAL_WORDS = {
  owner: "A goal's owner must be someone on the team for that goal's company.",
  bot: "There is no bot with that id.",
  target: "A target is at most 120 characters.",
  dueOn: "The due day is not a date (YYYY-MM-DD).",
  elsewhere: "That goal is another company's.",
} as const;

export const MAX_GOAL_TARGET = 120;

/** What a goal may carry besides its title and status; null clears a field on an update. */
export type GoalDetails = {
  ownerEmail?: string | null;
  ownerBot?: string | null;
  target?: string | null;
  dueOn?: string | null;
};

/**
 * A goal's details as they are stored, or a refusal in `GOAL_WORDS`: the
 * owner a person on the team the caller knows and on the goal's company (any
 * company for a goal of both), the bot a profile that exists, the target one
 * cleaned line of at most 120 characters, the due day a real day. One check
 * for the Goals page and an approved `goal_create` / `goal_update`.
 */
export async function checkGoalDetails(
  ctx: QueryCtx,
  member: Member,
  company: CompanyId | undefined,
  details: GoalDetails,
): Promise<{ ownerEmail?: string; ownerBot?: string; target?: string; dueOn?: string }> {
  const out: { ownerEmail?: string; ownerBot?: string; target?: string; dueOn?: string } = {};
  if (details.ownerEmail != null) {
    const email = details.ownerEmail.trim().toLowerCase();
    const person = (await teamDirectory(ctx.db)).get(email);
    if (
      person === undefined ||
      !knows(member, person) ||
      (company !== undefined && !person.companies.includes(company))
    ) {
      throw new ConvexError(GOAL_WORDS.owner);
    }
    out.ownerEmail = email;
  }
  if (details.ownerBot != null) {
    const bot = await ctx.db
      .query("bots")
      .withIndex("by_botId", (q) => q.eq("botId", details.ownerBot!.trim().toLowerCase()))
      .first();
    if (bot === null) throw new ConvexError(GOAL_WORDS.bot);
    out.ownerBot = bot.botId;
  }
  if (details.target != null) {
    if (details.target.trim().length > MAX_GOAL_TARGET) throw new ConvexError(GOAL_WORDS.target);
    const target = cleanRemote(details.target, MAX_GOAL_TARGET + 1);
    if (target.length > MAX_GOAL_TARGET) throw new ConvexError(GOAL_WORDS.target);
    if (target !== "") out.target = target;
  }
  if (details.dueOn != null) {
    if (!isCanonicalPeriodStart("day", details.dueOn)) throw new ConvexError(GOAL_WORDS.dueOn);
    out.dueOn = details.dueOn;
  }
  return out;
}

/**
 * A goal something of `company` may be linked to (a deal): one of that
 * company's or both companies'. Refused in fixed words otherwise.
 */
export async function requireGoalLink(ctx: QueryCtx, goalId: Id<"goals">, company: CompanyId) {
  const goal = await ctx.db.get(goalId);
  if (goal === null) throw new ConvexError(GOAL_GONE);
  if (goal.company !== undefined && goal.company !== company) throw new ConvexError(GOAL_WORDS.elsewhere);
  return goal;
}

/** A goal the caller may change: one of both companies', or of a company they are on. */
function requireGoalCompany(member: Member, company: CompanyId | undefined) {
  if (company !== undefined && !member.companies.includes(company)) {
    throw new ConvexError(NOT_ALLOWED);
  }
}

/** The quarter's goals of the company in view (`company`), or of every company the caller is on. */
export const list = memberQuery(["scorecard", "board"])({
  args: { quarter: v.string(), company: v.optional(companyValidator) },
  handler: (ctx, args) => {
    if (args.company !== undefined) requireCompany(ctx.member, args.company);
    return goalsFor(ctx, args.quarter, args.company === undefined ? ctx.member.companies : [args.company], ctx.member);
  },
});

type GoalStatus = Doc<"goals">["status"];

/**
 * What a caller sends, less a target if they may not read one: they are
 * sent none (`GOAL_TARGET_AREAS`), so the null their form sends back is not a
 * clearing, and a figure is set only by someone who holds the numbers.
 */
function withoutUnseenTarget<T extends GoalDetails>(member: Member, args: T): T {
  if (may(member, GOAL_TARGET_AREAS) || args.target === undefined) return args;
  const { target: _unseen, ...rest } = args;
  return rest as T;
}

/**
 * Add a goal at the end of its quarter: what `goals.create` runs, and what
 * approving an agent's `goal_create` proposal runs (convex/lib/proposals.ts),
 * so the two make the same goal and refuse in the same words.
 */
export async function createGoal(
  ctx: MutationCtx,
  member: Member,
  args: { quarter: string; title: string; company?: CompanyId; status?: GoalStatus } & GoalDetails,
): Promise<Id<"goals">> {
  if (args.company !== undefined) requireCompany(member, args.company);
  const details = await checkGoalDetails(ctx, member, args.company, withoutUnseenTarget(member, args));
  if (!isQuarter(args.quarter)) {
    throw new ConvexError(`"${args.quarter}" is not a quarter (expected e.g. 2026-Q4).`);
  }
  const last = await ctx.db
    .query("goals")
    .withIndex("by_quarter_and_order", (q) => q.eq("quarter", args.quarter))
    .order("desc")
    .first();
  return await ctx.db.insert("goals", {
    quarter: args.quarter,
    title: cleanTitle(args.title, "goal"),
    status: args.status ?? "on_track",
    order: (last?.order ?? -1) + 1,
    ...(args.company === undefined ? null : { company: args.company }),
    ...details,
  });
}

/**
 * Rename a goal or change its status: what `goals.update` runs, and what
 * approving an agent's `goal_update` proposal runs.
 */
export async function updateGoal(
  ctx: MutationCtx,
  member: Member,
  args: { id: Id<"goals">; title?: string; status?: GoalStatus; cash?: boolean } & GoalDetails,
  now: number,
): Promise<void> {
  const goal = await ctx.db.get(args.id);
  if (!goal) throw new ConvexError(GOAL_GONE);
  requireGoalCompany(member, goal.company);
  const given = withoutUnseenTarget(member, args);
  const details = await checkGoalDetails(ctx, member, goal.company, given);
  // A field sent as null (or a target of nothing but spaces) is cleared.
  const set = (field: keyof GoalDetails) =>
    given[field] === undefined ? null : { [field]: details[field] };
  await ctx.db.patch(args.id, {
    ...set("ownerEmail"),
    ...set("ownerBot"),
    ...set("target"),
    ...set("dueOn"),
    ...(args.title !== undefined ? { title: cleanTitle(args.title, "goal") } : null),
    ...(args.status !== undefined ? { status: args.status } : null),
    ...(args.cash !== undefined ? { cash: args.cash } : null),
    updatedAt: now,
  });
}

export const GOAL_GONE = "That goal no longer exists.";

const nullableText = v.optional(v.union(v.string(), v.null()));
/** A goal's owner, bot, target and due day, as the Goals page sends them. */
const detailArgs = {
  ownerEmail: nullableText,
  ownerBot: nullableText,
  target: nullableText,
  dueOn: nullableText,
};

export const create = memberMutation("review")({
  args: {
    quarter: v.string(),
    title: v.string(),
    company: v.optional(companyValidator),
    ownerEmail: v.optional(v.string()),
    ownerBot: v.optional(v.string()),
    target: v.optional(v.string()),
    dueOn: v.optional(v.string()),
  },
  handler: (ctx, args) => createGoal(ctx, ctx.member, args),
});

/** Rename a goal, change its status, or tag it a cash goal (`cash`). Its tasks stay linked either way. */
export const update = memberMutation("review")({
  args: {
    id: v.id("goals"),
    title: v.optional(v.string()),
    status: v.optional(goalStatusValidator),
    cash: v.optional(v.boolean()),
    ...detailArgs,
  },
  handler: async (ctx, args) => {
    await updateGoal(ctx, ctx.member, args, Date.now());
    return null;
  },
});

/**
 * Delete a goal. Tasks and deals that pointed at it stay, with the link removed.
 * Removing a goal that is already gone does nothing, so a double-click is safe.
 */
export const remove = memberMutation("review")({
  args: { id: v.id("goals") },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.id);
    if (goal === null) return null;
    requireGoalCompany(ctx.member, goal.company);
    const linked = await ctx.db
      .query("tasks")
      .withIndex("by_goalId", (q) => q.eq("goalId", args.id))
      .collect();
    for (const task of linked) await ctx.db.patch(task._id, { goalId: undefined });
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_goalId", (q) => q.eq("goalId", args.id))
      .collect();
    for (const deal of deals) await ctx.db.patch(deal._id, { goalId: undefined });
    await ctx.db.delete(args.id);
    return null;
  },
});

type Links = { tasks: number; proposals: number | null; deals: number | null; handoffs: number | null };

/**
 * What is linked to each of a quarter's goals the caller is sent, by goal id:
 * its tasks (those the caller may see), its open proposals (the owner's
 * inbox: null to anyone else), its deals that are not archived (null without
 * Sales) and the handoffs open on its tasks (null without the board). Counts
 * only; the items are on their own pages.
 */
export const links = memberQuery(["scorecard", "board"])({
  args: { quarter: v.string(), company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    if (args.company !== undefined) requireCompany(ctx.member, args.company);
    const companies = args.company === undefined ? ctx.member.companies : [args.company];
    const goals = await goalsFor(ctx, args.quarter, companies, ctx.member);
    const member = ctx.member;
    const sees = (company: CompanyId | undefined) => company === undefined || member.companies.includes(company);

    const owner = may(member, "personal");
    const openProposals = owner
      ? await ctx.db
          .query("proposals")
          .withIndex("by_status_and_createdAt", (q) => q.eq("status", "open"))
          .collect()
      : [];
    const openHandoffs = may(member, "board")
      ? (
          await Promise.all(
            member.companies.flatMap((company) =>
              (["open", "accepted"] as const).map((status) =>
                ctx.db
                  .query("handoffs")
                  .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", status))
                  .collect(),
              ),
            ),
          )
        ).flat()
      : [];

    const out: Record<string, Links> = {};
    for (const goal of goals) {
      const tasks = (
        await ctx.db
          .query("tasks")
          .withIndex("by_goalId", (q) => q.eq("goalId", goal.id))
          .collect()
      ).filter((task) => task.archivedAt === undefined && sees(task.company));
      const taskIds = new Set<string>(tasks.map((task) => task._id));
      const deals = may(member, "sales")
        ? (
            await ctx.db
              .query("deals")
              .withIndex("by_goalId", (q) => q.eq("goalId", goal.id))
              .collect()
          ).filter((deal) => deal.archivedAt === undefined && member.companies.includes(deal.market)).length
        : null;
      out[goal.id] = {
        tasks: tasks.length,
        proposals: owner ? openProposals.filter((row) => row.goalId === goal.id).length : null,
        deals,
        handoffs: may(member, "board")
          ? openHandoffs.filter((h) => h.links.some((link) => link.kind === "task" && taskIds.has(link.id))).length
          : null,
      };
    }
    return out;
  },
});
