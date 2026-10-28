// Earned autonomy (Revision 7 §4, docs/assistant.md "Earned autonomy"): how
// far the owner trusts a proposer (one of the four agents, or a bot by its
// profile's id) with one kind of proposal, and the grants that let a kind be
// approved without his click. Runs only inside Convex.
//
// - `botTrust`, one row per (proposer, kind): consecutive clean approvals
//   (approved with no edit), totals, the last reset, and which proposal's edit
//   last reset it (what was edited is that proposal's own `edits`, stored by
//   `approveProposal`). Written only from the owner's own approve / dismiss path
//   (`noteDecision`, called by convex/lib/proposals.ts) and from a flag.
// - The offer: after `OFFER_AFTER` clean approvals in a row of an eligible
//   kind. "Not yet" asks again after `OFFER_AFTER` more.
// - `autonomyGrants`: the owner's yes. A covered proposal runs the very same
//   approve path at once (`approveProposal(..., { decision: "auto_approved" })`).
// - **The never-list is the server's**: only `AUTONOMY_ELIGIBLE` may ever be
//   offered, granted or auto-approved, and only when the kind's area is no
//   locked area. A grant row written any other way does nothing: the check is
//   made again at the moment a proposal arrives. Drafts and outbound messages,
//   deal stage changes, money, legal or compliance items, goals and bot
//   permissions are not on the list; a kind added later is not on it either
//   until someone puts it there.
//
// No title, name or text in a log or a thrown error: refusals are `TRUST_WORDS`.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { AGENT_NAMES, AUTONOMY_ELIGIBLE, NEVER_AUTONOMOUS, isAgentId, type ProposalKind } from "./agents";
import { botNamed } from "./botStore";
import { EXTERNAL_PROFILES, externalProposerOf, isExternalOwnerAgent, isExternalProposer, isLockedBotArea, levelOf } from "./botRules";
import { isOwner, type Member } from "./owner";
import { AREA_NAMES, type Area } from "./roles";

/** Clean approvals in a row before the offer, and between "Not yet" and the next. */
export const OFFER_AFTER = 10;

// The two lists live in ./agents, beside the kinds, so the browser reads them too.
export { AUTONOMY_ELIGIBLE, NEVER_AUTONOMOUS };

/** The area each kind of proposal belongs to (an eligible kind of a locked area is still never eligible). */
export const KIND_AREA: Record<ProposalKind, Area> = {
  task_create: "board",
  task_change: "board",
  deal_next_step: "sales",
  decision_record: "memory",
  draft: "sales",
  goal_create: "review",
  goal_update: "review",
  // A bot's own profile: the owner's Agents › Bots.
  bot_permission: "agents",
  deal_create: "sales",
  memory_note: "memory",
  // A comment on a deal still needs sales, checked when it is written.
  comment: "board",
  task_archive: "board",
  handoff_reassign: "board",
};

/** Whether a kind may ever be offered, granted or auto-approved. Any name that is not one is not. */
export function isAutonomyEligible(kind: string): boolean {
  if (!(AUTONOMY_ELIGIBLE as readonly string[]).includes(kind)) return false;
  return !isLockedBotArea(KIND_AREA[kind as ProposalKind]);
}

export const TRUST_WORDS = {
  neverEligible: "That kind of proposal always waits for your approval.",
  notEarned: `Not earned yet: it takes ${OFFER_AFTER} approvals in a row with no edit.`,
  noGrant: "There is no such grant.",
  notAuto: "Only an item that was approved automatically can be flagged here.",
  tooLong: "That reason is too long (200 characters at most).",
} as const;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

/**
 * Who a proposal is trusted as: its bot, or the one of the four that made it.
 * An external owner-agent (chief_of_staff, engineering) is counted apart
 * from the Mac's agent of that id (`bot:<id>`), so neither earns the other's trust.
 */
export const proposerOf = (row: Pick<Doc<"proposals">, "agent" | "bot">): string =>
  isExternalOwnerAgent(row.bot) ? externalProposerOf(row.bot) : (row.bot ?? row.agent);

/** A proposer's name as the owner reads it: the bot's profile name, or the agent's. */
export async function proposerName(ctx: QueryCtx, owner: Id<"users">, proposer: string): Promise<string> {
  if (isAgentId(proposer)) return AGENT_NAMES[proposer];
  if (isExternalProposer(proposer)) {
    const id = proposer.slice(4) as keyof typeof EXTERNAL_PROFILES;
    return (await botNamed(ctx, owner, id))?.name ?? EXTERNAL_PROFILES[id].name;
  }
  return (await botNamed(ctx, owner, proposer))?.name ?? proposer;
}

export function trustRow(ctx: QueryCtx, proposer: string, kind: ProposalKind) {
  return ctx.db
    .query("botTrust")
    .withIndex("by_proposer_and_kind", (q) => q.eq("proposer", proposer).eq("kind", kind))
    .unique();
}

/** The grant in force for (proposer, kind), if any. */
export function activeGrant(ctx: QueryCtx, proposer: string, kind: ProposalKind) {
  return ctx.db
    .query("autonomyGrants")
    .withIndex("by_proposer_and_kind_and_revokedAt", (q) =>
      q.eq("proposer", proposer).eq("kind", kind).eq("revokedAt", undefined),
    )
    .first();
}

export type Decision = "clean" | "edited" | "auto" | "dismissed";

/**
 * Count one decision on a proposal toward its proposer's trust in that kind.
 * A clean approval adds to the streak; an edit, a dismissal or a flag starts
 * it again (an edit names its proposal, whose `edits` say what changed). An
 * automatic approval is counted on its own and leaves the streak as it was.
 */
export async function noteDecision(
  ctx: MutationCtx,
  row: Doc<"proposals">,
  decision: Decision,
  now: number,
  editedProposal?: Id<"proposals">,
) {
  const proposer = proposerOf(row);
  const was = await trustRow(ctx, proposer, row.kind);
  const base = was ?? {
    proposer,
    kind: row.kind,
    streak: 0,
    approved: 0,
    edited: 0,
    dismissed: 0,
    autoApproved: 0,
    offerAt: OFFER_AFTER,
    updatedAt: now,
  };
  const next: Partial<Doc<"botTrust">> & { updatedAt: number } = { updatedAt: now };
  switch (decision) {
    case "clean":
      next.streak = base.streak + 1;
      next.approved = base.approved + 1;
      break;
    case "auto":
      next.autoApproved = base.autoApproved + 1;
      break;
    case "edited":
      next.streak = 0;
      next.edited = base.edited + 1;
      next.offerAt = OFFER_AFTER;
      next.lastResetAt = now;
      next.lastEditedProposal = editedProposal ?? row._id;
      break;
    case "dismissed":
      next.streak = 0;
      next.dismissed = base.dismissed + 1;
      next.offerAt = OFFER_AFTER;
      next.lastResetAt = now;
      break;
  }
  if (was === null) await ctx.db.insert("botTrust", { ...base, ...next });
  else await ctx.db.patch(was._id, next);
}

/**
 * The area a bot's grant waits on: the kind's area (`KIND_AREA`) when the bot
 * no longer holds write there (demoted, or gone), else null. One of the four
 * never waits on one. A paused grant auto-approves nothing until write is back.
 */
export async function grantPausedOn(
  ctx: QueryCtx,
  owner: Id<"users">,
  proposer: string,
  kind: ProposalKind,
): Promise<{ area: Area; name: string } | null> {
  if (isAgentId(proposer)) return null;
  const area = KIND_AREA[kind];
  const bot = await botNamed(ctx, owner, proposer);
  if (bot !== null && levelOf(bot.permissions, area) === "write") return null;
  return { area, name: AREA_NAMES[area] };
}

/**
 * The credential a proposal came through, as the endpoint matched it: the one
 * bot its token or grant was made for, and the bot whose own address it was
 * called at. Null for a call that did not come through the endpoint.
 */
export type ProposalCaller = { onlyBot: string | null; address: string | null };

/**
 * Whether a bot's name is the credential's own, not only what the call said:
 * its token or OAuth grant was made for that bot, or the call was made at
 * that bot's own connector address. Bots sharing a client can claim each
 * other's names, so a name alone never earns what a grant gives.
 */
export const boundToBot = (caller: ProposalCaller | null | undefined, bot: string): boolean =>
  caller != null && (caller.onlyBot === bot || caller.address === bot);

/**
 * Whether a proposal just stored is to be approved at once: an eligible kind,
 * a grant in force for its proposer and kind, and the owner as the one it
 * would be carried out as; for a bot, a credential bound to it
 * (`boundToBot`) and write on the kind's area now (`grantPausedOn`). Checked here, at the moment it arrives, whatever the grant
 * row says: a crafted grant of a never-list kind does nothing, and a bot
 * named on a shared client leaves its proposal open for the owner.
 */
export async function grantCovers(
  ctx: QueryCtx,
  member: Member,
  proposal: { kind: ProposalKind; agent: string; bot?: string | undefined },
  caller?: ProposalCaller | null,
): Promise<boolean> {
  if (!isAutonomyEligible(proposal.kind) || !isOwner(member)) return false;
  // An external owner-agent profile is never approved automatically.
  if (isExternalOwnerAgent(proposal.bot)) return false;
  if (proposal.bot !== undefined) {
    if (!boundToBot(caller, proposal.bot)) return false;
    // A bot demoted below write on the kind's area loses what the grant gave.
    if ((await grantPausedOn(ctx, member.user._id, proposal.bot, proposal.kind)) !== null) return false;
  }
  const grant = await activeGrant(ctx, proposal.bot ?? proposal.agent, proposal.kind);
  return grant !== null && grant.userId === member.user._id;
}

/** The trust row of (proposer, kind), refusing a kind that is never eligible. */
export async function requireEligible(ctx: QueryCtx, proposer: string, kind: ProposalKind) {
  if (!isAutonomyEligible(kind)) refuse(TRUST_WORDS.neverEligible);
  return trustRow(ctx, proposer, kind);
}

/** Whether the offer stands for this row: eligible, earned, not deferred, not already granted. */
export async function offerStands(ctx: QueryCtx, row: Doc<"botTrust">): Promise<boolean> {
  if (!isAutonomyEligible(row.kind) || row.streak < Math.max(row.offerAt, OFFER_AFTER)) return false;
  if (isExternalProposer(row.proposer)) return false;
  return (await activeGrant(ctx, row.proposer, row.kind)) === null;
}

export { refuse as refuseTrust };
