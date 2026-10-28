import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isOwnerEmail, memberByEmail } from "./authOwner";
import { COMPANY_NOT_IN_USE, companyIds, isCompanyId, type CompanyId } from "./lib/company";
import {
  NOT_ALLOWED,
  isOwner,
  memberMutation,
  memberQuery,
  ownerMutation,
  ownerQuery,
  requireCompany,
  type Member,
} from "./lib/owner";
import { forgetPerson } from "./lib/personal";
import {
  GITHUB_IS_THE_OWNERS,
  GITHUB_TAKEN,
  ROLE_GONE,
  cleanGithub,
  sameGithub,
} from "./lib/roleRules";
import { shownRole } from "./lib/roleRows";
import {
  CUSTOM_ROLE,
  GRANTABLE_AREAS,
  MAX_MEMBERS,
  SENSITIVE_AREAS,
  OWNERS_ONLY,
  PAY_AND_COSTS_ARE_THE_OWNERS,
  effectiveAreas,
  isArea,
  isGrantableArea,
  isPayOrCosts,
  roleKind,
  type GrantableArea,
} from "./lib/roles";
import { assignablePeople, knows } from "./lib/teamDirectory";
import { cleanTelegram, sameTelegram } from "./lib/telegramMessage";
import { linkLogWith, requireFreeUsername, settingsRow, writeSettings } from "./telegram";
import { companyValidator, storedRoleValidator } from "./schema";

// The team: who, besides the owner, may use the OS, which pages each may open
// and for which company. It is the `team` area's: the owner's, and a
// teammate's the owner ticked it for by name (a "manager" below). A teammate's
// address and name are personal data: no message thrown here quotes one, and
// nothing here writes one anywhere but the `members` table.
//
// A manager helps run the team: they add and remove people and choose their
// ordinary pages, within their own companies. They can never widen their own
// access, lock the owner out or keep the page once the owner takes it away.
// What a manager cannot do, each rule enforced below and tested in
// convex/teamManager.test.ts:
//
// - give an area that is the owner's alone (`cleanAreas`, for everyone,
//   the owner included): payroll and costs among them;
// - give or take one of the two sensitive areas (settings, team):
//   someone they add has none, and someone they change keeps exactly the ones
//   they had (`requireSensitiveUnchanged`). Only the owner hands those out;
// - change, reset or remove someone who manages the team (`requireEditable`):
//   two managers cannot keep each other in place;
// - touch the owner, who is not a row (and a stale row under an owner's
//   address is the owner's to clear);
// - reach past their own companies: they are sent the people who share one,
//   change or remove only people who are on no other, and can put nobody on a
//   company they are not on themselves;
// - change or remove themselves, so nobody widens their own access and the
//   page is taken away by the owner;
// - act unseen: each change a manager makes is written to `teamChanges`,
//   which the owner alone reads and nothing changes or deletes.

const teamQuery = memberQuery("team");
const teamMutation = memberMutation("team");

/** Said to a manager who names their own row. */
export const CANNOT_CHANGE_SELF = "You cannot change or remove yourself. Only the owner can.";

/** Said to a manager whose add is refused for a reason that is not theirs to hear. */
export const CANNOT_ADD_FROM_HERE = "That person cannot be added from here.";

/** Said to the owner of a row that is on no company: only removing it is offered. */
export const NO_COMPANY_ON_RECORD = "This record has no company. Remove it, then add the person again.";

/** Said to a manager who names one of the two sensitive areas, to give or to take. */
export const SENSITIVE_ARE_THE_OWNERS = "Only the owner gives Sources and Telegram, or Team.";

/** Said to a manager who names the row of someone who manages the team. */
export const CANNOT_CHANGE_MANAGER = "Only the owner changes or removes someone who manages the team.";

/** Said to a manager whose add or change names a Telegram username, whatever it says. */
export const TELEGRAM_IS_THE_OWNERS = "Only the owner sets or resets a Telegram username.";

/**
 * Refuse a manager anything about a Telegram username. Whoever sets one
 * decides which Telegram account the bot takes for that person, so a manager
 * who could type one could point a teammate's at an account of their own and
 * add tasks from the group as them. Naming it at all is asking to change it:
 * the same value, blank and null are refused like a new one.
 */
function requireOwnerForTelegram(member: Member, telegram: unknown) {
  if (telegram !== undefined && !isOwner(member)) throw new ConvexError(TELEGRAM_IS_THE_OWNERS);
}

/**
 * Refuse a manager anything about a GitHub username, as with Telegram's: it
 * says who a person is to another system, and that is the owner's to say.
 * Naming it at all is asking to change it.
 */
function requireOwnerForGithub(member: Member, github: unknown) {
  if (github !== undefined && !isOwner(member)) throw new ConvexError(GITHUB_IS_THE_OWNERS);
}

/**
 * Refuse a GitHub username another record already holds, whatever its
 * capitals: another teammate's row or another owner's own. One login is one
 * person's, so "mine" can never be somebody else's pull requests. The refusal
 * does not say whose it is.
 */
async function requireFreeGithub(
  ctx: QueryCtx,
  github: string | undefined,
  own: { member?: Id<"members">; owner?: Id<"users"> },
) {
  if (github === undefined) return;
  // At most MAX_MEMBERS rows: `team.add` refuses more.
  for (const member of await ctx.db.query("members").collect()) {
    if (member._id === own.member || member.github === undefined) continue;
    if (sameGithub(member.github, github)) throw new ConvexError(GITHUB_TAKEN);
  }
  for (const profile of await ctx.db.query("ownerProfiles").collect()) {
    if (profile.userId === own.owner || profile.github === undefined) continue;
    if (sameGithub(profile.github, github)) throw new ConvexError(GITHUB_TAKEN);
  }
}

/**
 * Refuse a role that is not there to give: a built-in word always is, and a
 * role the owner named must still be a row. Anyone with the Team page may
 * give any role that exists; it is a label and an arrangement, and what the
 * person may open is the pages saved with it.
 */
async function requireRole(ctx: QueryCtx, role: StoredRole) {
  if (roleKind(role) !== CUSTOM_ROLE) return;
  if ((await ctx.db.get(role as Id<"roles">)) === null) throw new ConvexError(ROLE_GONE);
}

/** How many changes the owner is sent at a time. */
const CHANGES_PAGE = 20;
/** How many widenings are kept at the top, whatever their age. */
const WIDENED_SHOWN = 20;
/** How many rows from before widenings were marked are read for what they say. */
const UNMARKED_READ = 200;

/** Whether every one of some companies is one the caller is on. */
const within = (member: Member, companies: readonly string[]) =>
  companies.every((company) => (member.companies as readonly string[]).includes(company));

const isSelf = (member: Member, row: Doc<"members">) =>
  member.user.email?.trim().toLowerCase() === row.email;

/** The sensitive areas among some, in the table's order. */
const sensitiveOf = (areas: readonly string[]) =>
  SENSITIVE_AREAS.filter((area) => areas.includes(area));

/** Whether a row holds the Team page as the gate reads it: someone who manages the team. */
const managesTeam = (row: Doc<"members">) => effectiveAreas(row.role, row.areas).includes("team");

/**
 * A row within a manager's reach by who it is and where: not yet by what it
 * holds. A row on no company is within nobody's: "every one of none" must not
 * read as within every manager's companies.
 */
const withinReach = (member: Member, row: Doc<"members">) =>
  !isSelf(member, row) &&
  !isOwnerEmail(row.email) &&
  row.companies.length > 0 &&
  within(member, row.companies);

/**
 * Refuse to act on a row that is on no company. The schema cannot say "at
 * least one", so such a row could only have been written by hand; nothing
 * here changes it, and the owner removes it.
 */
function requireSomeCompany(row: Doc<"members">) {
  if (row.companies.length === 0) throw new ConvexError(NO_COMPANY_ON_RECORD);
}

/** Whether a row is the caller's to change or remove. The owner's, always. */
function editable(member: Member, row: Doc<"members">): boolean {
  if (isOwner(member)) return true;
  return withinReach(member, row) && !managesTeam(row);
}

/**
 * Refuse a manager a row that is not theirs to change: their own in fixed
 * words, anyone beyond their companies (or a row under an owner's address) as
 * a missing permission is, and someone who manages the team in fixed words.
 * Two managers cannot change each other, so one cannot give the page back to
 * another the owner took it from, or take it from one the owner gave it to.
 */
function requireEditable(member: Member, row: Doc<"members">) {
  if (isOwner(member)) return;
  if (isSelf(member, row)) throw new ConvexError(CANNOT_CHANGE_SELF);
  if (!withinReach(member, row)) throw new ConvexError(NOT_ALLOWED);
  if (managesTeam(row)) throw new ConvexError(CANNOT_CHANGE_MANAGER);
}

/**
 * Refuse a manager any change to who holds a sensitive area: the two a
 * person has after must be exactly the two they had before (none, for
 * someone being added). Given and taken by the owner alone, so a manager can
 * neither make a second manager nor undo what the owner ticked.
 */
function requireSensitiveUnchanged(
  member: Member,
  before: readonly string[],
  after: readonly string[],
) {
  if (isOwner(member)) return;
  if (sensitiveOf(before).join() !== sensitiveOf(after).join()) {
    throw new ConvexError(SENSITIVE_ARE_THE_OWNERS);
  }
}

/** Refuse a manager who would put someone on a company they are not on themselves. */
function requireOwnCompanies(member: Member, companies: readonly CompanyId[]) {
  if (!isOwner(member) && !within(member, companies)) throw new ConvexError(NOT_ALLOWED);
}

/** A role as a teammate's row holds it: a built-in word, or the id of one the owner named. */
type StoredRole = Doc<"members">["role"];

type TeamState = { role: StoredRole; companies: CompanyId[]; areas: GrantableArea[] };

/** What someone has, as the gate would read it: for the record of a change. */
const stateOf = (row: {
  role: StoredRole;
  companies: readonly string[];
  areas?: readonly string[];
}): TeamState => ({
  role: row.role,
  companies: row.companies.filter(isCompanyId),
  areas: effectiveAreas(row.role, row.areas).filter(isGrantableArea),
});

type RecordedState = { role: string; companies: readonly string[]; areas: readonly string[] };

/**
 * Whether a change widened what someone can reach: they have a sensitive area
 * they did not have, or (someone already on the team) are on a company they
 * were not on. Taking something away, or changing ordinary pages, is not it.
 * A change recorded before payroll and costs were the owner's alone that gave
 * one of them widened reach too, and is still read so.
 */
function widensReach(before: RecordedState | undefined, after: RecordedState | undefined): boolean {
  if (after === undefined) return false;
  const had = before?.areas ?? [];
  const gained = after.areas.filter((area) => !had.includes(area));
  if (gained.some((area) => isPayOrCosts(area) || sensitiveOf([area]).length > 0)) return true;
  return before !== undefined && after.companies.some((company) => !before.companies.includes(company));
}

const sameState = (a: TeamState, b: TeamState) =>
  a.role === b.role && a.companies.join() === b.companies.join() && a.areas.join() === b.areas.join();

/**
 * Write down a change to the team. Ids and what the person had and has: never
 * an address, a name or a username.
 *
 * A manager's: every one that changed something. A save that leaves everything
 * as it was is no change and is not written, so the record cannot be filled
 * with them to push a real one out of sight. The owner's own: only one that
 * widens someone's reach, so that who was given a sensitive page or another
 * company is on record whoever did it. A widening is marked as it is written
 * (`widens`), and `changes` keeps those at the top whatever their age.
 */
async function recordChange(
  ctx: MutationCtx,
  actor: Member,
  change: {
    kind: Doc<"teamChanges">["kind"];
    member: Id<"members">;
    /** Read here only to find their `users` row; not stored. */
    email: string;
    before?: TeamState;
    after?: TeamState;
    telegramChanged?: boolean;
  },
) {
  const widens = widensReach(change.before, change.after);
  if (isOwner(actor) && !widens) return;
  if (
    change.kind === "update" &&
    change.before !== undefined &&
    change.after !== undefined &&
    sameState(change.before, change.after) &&
    change.telegramChanged !== true
  ) {
    return;
  }
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", change.email))
    .first();
  await ctx.db.insert("teamChanges", {
    at: Date.now(),
    kind: change.kind,
    actor: actor.user._id,
    member: change.member,
    ...(user === null ? null : { memberUser: user._id }),
    ...(change.before === undefined ? null : { before: change.before }),
    ...(change.after === undefined ? null : { after: change.after }),
    ...(change.telegramChanged === true ? { telegramChanged: true } : null),
    widens,
  });
}

/** The longest address the mail standards allow. */
const MAX_EMAIL_LENGTH = 254;
// Printable ASCII with no space: what a Google account's address is made of.
const PRINTABLE = /^[\x21-\x7e]+$/;
const PLAUSIBLE = /^[^@]+@[^@.]+(\.[^@.]+)+$/;

/** The address as it is stored, or a refusal in fixed words. */
function cleanEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (
    email.length > MAX_EMAIL_LENGTH ||
    !PRINTABLE.test(email) ||
    !PLAUSIBLE.test(email)
  ) {
    throw new ConvexError("That is not an email address.");
  }
  return email;
}

/** One or both companies, each once, in the usual order. */
function cleanCompanies(companies: readonly CompanyId[]): CompanyId[] {
  // A company the OS is not run for (one-company mode) is refused, not dropped.
  if (!companies.every(isCompanyId)) throw new ConvexError(COMPANY_NOT_IN_USE);
  const chosen = companyIds().filter((id) => companies.includes(id));
  if (chosen.length === 0) throw new ConvexError("Pick at least one company.");
  return chosen;
}

/**
 * The pages picked, each once, in the table's order; none is allowed. The
 * names arrive as plain strings so that a refusal is in words written here:
 * payroll and costs, the owner's own two areas, and a name that is no area,
 * each get a fixed sentence that quotes nothing. Refused for everyone, the
 * owner included: no teammate holds payroll or costs.
 */
function cleanAreas(areas: readonly string[]): GrantableArea[] {
  if (areas.some(isPayOrCosts)) throw new ConvexError(PAY_AND_COSTS_ARE_THE_OWNERS);
  if (areas.some((area) => isArea(area) && !isGrantableArea(area))) {
    throw new ConvexError(OWNERS_ONLY);
  }
  if (!areas.every(isGrantableArea)) throw new ConvexError("That is not a page of the OS.");
  return GRANTABLE_AREAS.filter((area) => areas.includes(area));
}

/**
 * The teammates the caller is told of, by address, with whether each has
 * signed in yet and the areas each has: the ones the gate goes by, so the
 * page says what is so. The owner is sent everyone. A manager is sent the
 * people who share a company with them (`knows`), themselves included, and
 * for each whether it is theirs to change (`editable`).
 */
export const list = teamQuery({
  args: {},
  handler: async (ctx) => {
    const everyone = await ctx.db.query("members").withIndex("by_email").collect();
    const rows = everyone.filter(
      (row) =>
        isOwner(ctx.member) ||
        // An owner's address is the owner, whatever a row says: not a manager's to see.
        (!isOwnerEmail(row.email) &&
          knows(ctx.member, { email: row.email, companies: row.companies.filter(isCompanyId) })),
    );
    return await Promise.all(
      rows.map(async (row) => {
        const user = await ctx.db
          .query("users")
          .withIndex("email", (q) => q.eq("email", row.email))
          .first();
        const role = await shownRole(ctx.db, row.role);
        return {
          id: row._id,
          email: row.email,
          /** As stored: a built-in word, or the id of a role the owner named. */
          role: row.role,
          /** What the role is called, and what their pages are arranged for. */
          roleName: role.name,
          focus: role.focus,
          /** Their GitHub username; null when none is on record. */
          github: row.github ?? null,
          companies: row.companies,
          areas: [...effectiveAreas(row.role, row.areas)],
          addedAt: row.addedAt,
          /** The caller's own row: shown, and never theirs to change. */
          self: !isOwner(ctx.member) && isSelf(ctx.member, row),
          /** Whether the caller may change or remove this person. */
          editable: editable(ctx.member, row),
          /** Their Telegram username; null when none is on record. */
          telegram: row.telegram ?? null,
          /**
           * Whether a Telegram account is tied to that username yet, and since
           * when. Never which. Sent with the row, to whoever is sent the row.
           */
          telegramLinked: row.telegramUserId !== undefined,
          telegramLinkedAt: row.telegramBoundAt ?? null,
          /** The name they signed in with; null until they have. */
          name: user?.name ?? null,
          signedIn: user !== null,
        };
      }),
    );
  },
});

/**
 * Let a Google account in. From then on that address can sign in (to the
 * standard the owner's is held to: Google must vouch for it) and call what
 * the picked pages open, for its companies. The role is the label it wears.
 */
export const add = teamMutation({
  args: {
    email: v.string(),
    role: storedRoleValidator,
    companies: v.array(companyValidator),
    areas: v.array(v.string()),
    /** Their Telegram username, with or without the "@". Blank or left out: none. */
    telegram: v.optional(v.string()),
    /** Their GitHub username, with or without the "@". Blank or left out: none. */
    github: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireOwnerForTelegram(ctx.member, args.telegram);
    requireOwnerForGithub(ctx.member, args.github);
    const email = cleanEmail(args.email);
    const companies = cleanCompanies(args.companies);
    const areas = cleanAreas(args.areas);
    const telegram = cleanTelegram(args.telegram ?? "");
    const github = cleanGithub(args.github ?? "");
    requireSensitiveUnchanged(ctx.member, [], areas);
    requireOwnCompanies(ctx.member, companies);
    await requireRole(ctx, args.role);
    await requireFreeUsername(ctx, telegram, {});
    await requireFreeGithub(ctx, github, {});
    if (isOwnerEmail(email)) {
      throw new ConvexError("That address is an owner's. An owner is not added to the team.");
    }
    const already = await memberByEmail(ctx.db, email);
    if (already !== null) {
      // Someone the caller is sent anyway is said to be on the team. Someone
      // on another company alone is not theirs to hear of: the neutral words.
      const told =
        isOwner(ctx.member) ||
        knows(ctx.member, { email, companies: already.companies.filter(isCompanyId) });
      throw new ConvexError(told ? "That person is already on the team." : CANNOT_ADD_FROM_HERE);
    }
    const team = await ctx.db.query("members").take(MAX_MEMBERS);
    if (team.length >= MAX_MEMBERS) {
      // How many are on the team in all is the owner's to know.
      throw new ConvexError(
        isOwner(ctx.member) ? `The team is full (${MAX_MEMBERS} people at most).` : CANNOT_ADD_FROM_HERE,
      );
    }
    const id = await ctx.db.insert("members", {
      email,
      role: args.role,
      companies,
      areas,
      addedAt: Date.now(),
      addedBy: ctx.member.user._id,
      ...(telegram === undefined ? null : { telegram }),
      ...(github === undefined ? null : { github }),
    });
    await recordChange(ctx, ctx.member, {
      kind: "add",
      member: id,
      email,
      after: stateOf({ role: args.role, companies, areas }),
      telegramChanged: telegram !== undefined,
    });
    return id;
  },
});

/**
 * Change a teammate's role, companies and pages. It holds from their next
 * call: the gate reads this row every time, whatever session they have open.
 * The pages are always said, so a row from before they could be picked gets a
 * list of its own here and stops following its role.
 *
 * Saved without Today, everything held for the person under it goes in this
 * same transaction: their personal token (a push in flight is refused when it
 * lands), their own mail, calendar, meeting notes and issues, and how each
 * tool stood. Ticking Today again later starts them from nothing.
 */
export const update = teamMutation({
  args: {
    id: v.id("members"),
    role: storedRoleValidator,
    companies: v.array(companyValidator),
    areas: v.array(v.string()),
    /** Their Telegram username: left out keeps it, null or blank clears it. */
    telegram: v.optional(v.union(v.string(), v.null())),
    /** Their GitHub username: left out keeps it, null or blank clears it. */
    github: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireOwnerForTelegram(ctx.member, args.telegram);
    requireOwnerForGithub(ctx.member, args.github);
    const github = args.github === undefined ? null : { github: cleanGithub(args.github ?? "") };
    const companies = cleanCompanies(args.companies);
    const areas = cleanAreas(args.areas);
    const telegram = args.telegram === undefined ? null : { telegram: cleanTelegram(args.telegram ?? "") };
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("That person is no longer on the team.");
    // A manager: not their own row, not someone beyond their companies, and
    // not onto a company they are not on. Before anything is written.
    requireEditable(ctx.member, row);
    requireSomeCompany(row);
    requireSensitiveUnchanged(ctx.member, effectiveAreas(row.role, row.areas), areas);
    requireOwnCompanies(ctx.member, companies);
    await requireRole(ctx, args.role);
    await requireFreeUsername(ctx, telegram?.telegram, { member: args.id });
    await requireFreeGithub(ctx, github?.github, { member: args.id });
    // Another username is another Telegram account: whoever uses it first is bound afresh.
    const unbind =
      telegram !== null &&
      !(row.telegram !== undefined &&
        telegram.telegram !== undefined &&
        sameTelegram(row.telegram, telegram.telegram));
    await ctx.db.patch(args.id, {
      role: args.role,
      companies,
      areas,
      ...telegram,
      ...github,
      ...(unbind ? { telegramUserId: undefined, telegramBoundAt: undefined } : null),
    });
    if (!areas.includes("today")) await forgetPerson(ctx, row.email);
    await recordChange(ctx, ctx.member, {
      kind: "update",
      member: args.id,
      email: row.email,
      before: stateOf(row),
      after: stateOf({ role: args.role, companies, areas }),
      telegramChanged: telegram !== null && telegram.telegram !== row.telegram,
    });
    return null;
  },
});

/**
 * What was changed on the team, newest first: the owner's alone to read.
 * Each says who did it and whose record it was, for as long as a row still
 * says who they are; someone removed before they ever signed in is not named.
 *
 * Twenty at a time: `next` is what to send as `before` for the twenty before
 * those, or null at the end, so every row can be reached. With the first page
 * comes `widened`: the latest changes that gave someone a sensitive page or
 * put them on another company, whatever their age and however many changes
 * came after.
 */
export const changes = ownerQuery({
  args: { before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const shown = async (row: Doc<"teamChanges">) => {
      const actor = await ctx.db.get(row.actor);
      const member = await ctx.db.get(row.member);
      const user = row.memberUser === undefined ? null : await ctx.db.get(row.memberUser);
      const email = member?.email ?? user?.email ?? null;
      // A role is named as it is called now; one since deleted reads "No role".
      const named = async (state: Doc<"teamChanges">["before"]) =>
        state === undefined
          ? null
          : { ...state, roleName: (await shownRole(ctx.db, state.role)).name };
      return {
        id: row._id,
        at: row.at,
        kind: row.kind,
        actor: actor?.email ? { email: actor.email, name: actor.name ?? null } : null,
        person: email === null ? null : { email, name: user?.name ?? null },
        before: await named(row.before),
        after: await named(row.after),
        telegramChanged: row.telegramChanged === true,
      };
    };
    const { before } = args;
    const page = await (before === undefined
      ? ctx.db.query("teamChanges")
      : ctx.db
          .query("teamChanges")
          .withIndex("by_creation_time", (q) => q.lt("_creationTime", before))
    )
      .order("desc")
      .take(CHANGES_PAGE + 1);
    const rows = page.slice(0, CHANGES_PAGE);

    let widened: Doc<"teamChanges">[] = [];
    if (before === undefined) {
      const marked = await ctx.db
        .query("teamChanges")
        .withIndex("by_widens", (q) => q.eq("widens", true))
        .order("desc")
        .take(WIDENED_SHOWN);
      // Rows from before the mark was written, read for what they say.
      const unmarked = await ctx.db
        .query("teamChanges")
        .withIndex("by_widens", (q) => q.eq("widens", undefined))
        .order("desc")
        .take(UNMARKED_READ);
      widened = [...marked, ...unmarked.filter((row) => widensReach(row.before, row.after))]
        .sort((a, b) => b._creationTime - a._creationTime)
        .slice(0, WIDENED_SHOWN);
    }
    return {
      rows: await Promise.all(rows.map(shown)),
      next: page.length > CHANGES_PAGE ? rows[rows.length - 1]!._creationTime : null,
      widened: await Promise.all(widened.map(shown)),
    };
  },
});

/** End every session of the users with an address, so open tabs stop at once. */
async function endSessions(ctx: MutationCtx, email: string) {
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .collect();
  for (const user of users) {
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .collect();
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const token of tokens) await ctx.db.delete(token._id);
      await ctx.db.delete(session._id);
    }
  }
}

/**
 * Take a teammate off the team. Their sessions are ended here, and the gate
 * would refuse them without that. Their tasks keep them as assignee and show
 * a removed teammate. Removing someone already gone does nothing.
 *
 * Their personal token, their own mail, calendar, meeting notes and issues,
 * and how each tool stood are deleted here too, in this transaction: nothing
 * of theirs is left, and a push in flight is refused when it lands.
 */
export const remove = teamMutation({
  args: { id: v.id("members") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return null;
    requireEditable(ctx.member, row);
    await recordChange(ctx, ctx.member, {
      kind: "remove",
      member: args.id,
      email: row.email,
      before: stateOf(row),
    });
    await ctx.db.delete(args.id);
    // A stale row under an owner's address is only cleared: the sessions
    // behind that address are the owner's, and are not ended.
    if (isOwnerEmail(row.email)) return null;
    await endSessions(ctx, row.email);
    await forgetPerson(ctx, row.email);
    return null;
  },
});

/**
 * The people a task can be assigned to, as an address and a name and nothing
 * else: the owner, and the teammates who share a company with the caller and
 * hold the board (`mayTakeWork`). Given a company (one of the caller's), only
 * those on it.
 */
export const assignable = memberQuery("board")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    if (args.company !== undefined) requireCompany(ctx.member, args.company);
    return assignablePeople(ctx, ctx.member, args.company, { work: true });
  },
});

/**
 * The caller's own GitHub username, for "my pull requests": the owner's from
 * their own record, a teammate's from their row. Never anyone else's; it
 * takes no argument that names a person.
 */
export const myGithub = memberQuery("engineering")({
  args: {},
  handler: async (ctx) => {
    if (isOwner(ctx.member)) {
      const profile = await ctx.db
        .query("ownerProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", ctx.member.user._id))
        .first();
      return { login: profile?.github ?? null };
    }
    const row = await memberByEmail(ctx.db, ctx.member.user.email);
    return { login: row?.github ?? null };
  },
});

/** The owner's own GitHub username: an owner has no row to hold it. Blank clears it. */
export const setMyGithub = ownerMutation({
  args: { github: v.string() },
  handler: async (ctx, args) => {
    const github = cleanGithub(args.github);
    await requireFreeGithub(ctx, github, { owner: ctx.owner._id });
    const profile = await ctx.db
      .query("ownerProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.owner._id))
      .first();
    if (profile === null) {
      if (github !== undefined) await ctx.db.insert("ownerProfiles", { userId: ctx.owner._id, github });
    } else {
      await ctx.db.patch(profile._id, { github });
    }
    return null;
  },
});

/**
 * Forget which Telegram account is tied to a teammate's username, keeping the
 * username. The next task from that username links afresh and says so in the
 * group. For when the wrong account was linked: a username was typed that the
 * teammate does not hold, or they have a new account.
 *
 * The owner's alone, like setting a username: it decides who the bot will
 * next take for this person. An owner's own link is `telegram.resetMine`.
 */
export const resetTelegram = ownerMutation({
  args: { id: v.id("members") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError("That person is no longer on the team.");
    requireSomeCompany(row);
    if (row.telegramUserId === undefined) return null;
    await ctx.db.patch(args.id, { telegramUserId: undefined, telegramBoundAt: undefined });
    await writeSettings(ctx, {
      log: linkLogWith(await settingsRow(ctx), { event: "reset", at: Date.now(), member: args.id }),
    });
    return null;
  },
});
