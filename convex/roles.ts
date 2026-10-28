import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { BUILTIN_FOCUS, type Focus } from "./lib/focus";
import { isOwner, memberQuery, ownerMutation } from "./lib/owner";
import {
  MAX_ROLES,
  ROLES_FULL,
  ROLE_GONE,
  ROLE_NAME_TAKEN,
  cleanPreset,
  cleanRoleName,
  isReservedRoleName,
  roleNameKey,
} from "./lib/roleRules";
import {
  MEMBER_ROLES,
  ROLE_LABELS,
  areasOf,
  isGrantableArea,
  isPresetArea,
  type GrantableArea,
  type MemberRole,
} from "./lib/roles";
import { focusValidator } from "./schema";

// The roles a teammate can be given: the three built in, and the ones the
// owner named. A role is a label, a focus (what the Dashboard and Today pages
// are arranged for) and the pages the form ticks when it is chosen. **It gives
// nothing.** What a person may open is their own list of areas, picked on the
// Team page; a role is never asked what its holder may do.
//
// The owner alone adds, renames, changes and deletes a role. Someone who
// manages the team reads the list, to give a person one that exists.
//
// A name is typed text: stored cleaned, sent only to people with the Team
// page (and, their own role's, to each person through `viewer.me`), and never
// put in a log or a thrown error. Every refusal here is in fixed words.

type RoleRow = {
  /** What `team.add` / `team.update` take: a built-in word, or the row's id. */
  id: MemberRole | Id<"roles">;
  name: string;
  focus: Focus;
  /** Its usual pages: what choosing it ticks. */
  areas: GrantableArea[];
  builtin: boolean;
  /** How many people have it; null for anyone but the owner. */
  people: number | null;
};

/** Refuse a name another role has, or a built-in's, whatever its capitals. */
async function requireFreeName(ctx: QueryCtx, name: string, own?: Id<"roles">) {
  if (isReservedRoleName(name)) throw new ConvexError(ROLE_NAME_TAKEN);
  const holders = await ctx.db
    .query("roles")
    .withIndex("by_nameKey", (q) => q.eq("nameKey", roleNameKey(name)))
    .take(2);
  if (holders.some((row) => row._id !== own)) throw new ConvexError(ROLE_NAME_TAKEN);
}

/**
 * Every role there is: the three built in, then the owner's by name. Each
 * with its focus and usual pages, and for the owner how many people have it.
 * A manager is not told a head count: how many are on the team in all is the
 * owner's to know.
 */
export const list = memberQuery("team")({
  args: {},
  handler: async (ctx): Promise<RoleRow[]> => {
    const owner = isOwner(ctx.member);
    // At most MAX_MEMBERS rows, and MAX_ROLES of these.
    const members = owner ? await ctx.db.query("members").collect() : [];
    const people = (id: string) => (owner ? members.filter((row) => row.role === id).length : null);
    const named = await ctx.db.query("roles").withIndex("by_nameKey").take(MAX_ROLES);
    return [
      ...MEMBER_ROLES.map((id) => ({
        id,
        name: ROLE_LABELS[id],
        focus: BUILTIN_FOCUS[id],
        areas: areasOf(id).filter(isGrantableArea),
        builtin: true,
        people: people(id),
      })),
      ...named.map((row) => ({
        id: row._id,
        name: row.name,
        focus: row.focus,
        // Ordinary pages only: a row from before may still name payroll or costs.
        areas: row.areas.filter(isPresetArea),
        builtin: false,
        people: people(row._id),
      })),
    ];
  },
});

const fields = {
  name: v.string(),
  focus: focusValidator,
  /** Plain strings, so a refusal is in words written here. */
  areas: v.array(v.string()),
};

/** Name a new role. Nobody has it until it is chosen for them. */
export const create = ownerMutation({
  args: fields,
  handler: async (ctx, args) => {
    const name = cleanRoleName(args.name);
    const areas = cleanPreset(args.areas);
    await requireFreeName(ctx, name);
    const all = await ctx.db.query("roles").take(MAX_ROLES);
    if (all.length >= MAX_ROLES) throw new ConvexError(ROLES_FULL);
    return await ctx.db.insert("roles", {
      name,
      nameKey: roleNameKey(name),
      focus: args.focus,
      areas,
      createdBy: ctx.owner._id,
    });
  },
});

/**
 * Rename a role, or change its focus or its usual pages. The name and the
 * focus hold at once for everyone who has it: both are read from this row
 * each time. **The usual pages change nobody's access**: they are what the
 * form ticks the next time the role is chosen, and each person keeps the
 * pages that were saved for them.
 */
export const update = ownerMutation({
  args: { id: v.id("roles"), ...fields },
  handler: async (ctx, args) => {
    const name = cleanRoleName(args.name);
    const areas = cleanPreset(args.areas);
    if ((await ctx.db.get(args.id)) === null) throw new ConvexError(ROLE_GONE);
    await requireFreeName(ctx, name, args.id);
    await ctx.db.patch(args.id, { name, nameKey: roleNameKey(name), focus: args.focus, areas });
    return null;
  },
});

/**
 * Delete a role nobody has. One that people have is refused, saying how many
 * (a number, never who): nothing cascades, so nobody loses their role by a
 * deletion. Deleting one already gone does nothing.
 */
export const remove = ownerMutation({
  args: { id: v.id("roles") },
  handler: async (ctx, args) => {
    if ((await ctx.db.get(args.id)) === null) return null;
    // At most MAX_MEMBERS rows: `team.add` refuses more.
    const holders = (await ctx.db.query("members").collect()).filter(
      (row) => row.role === args.id,
    ).length;
    if (holders > 0) {
      throw new ConvexError(
        `${holders === 1 ? "1 person has" : `${holders} people have`} this role. Give them another role first.`,
      );
    }
    await ctx.db.delete(args.id);
    return null;
  },
});
