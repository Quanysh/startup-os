// Earned autonomy on /approvals and the Bots tab (convex/lib/trust.ts). The
// owner's alone, like the rest of the Assistant: every function is
// `ownerQuery` / `ownerMutation`. Nothing here reads the clock in a query.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { proposalKindValidator } from "./schema";
import { MAX_DISMISS_REASON_LENGTH, PROPOSAL_WORDS, REJECT_CODES, type RejectCode } from "./lib/agents";
import { cleanLine } from "./lib/agentText";
import { ownerMutation, ownerQuery } from "./lib/owner";
import {
  OFFER_AFTER,
  TRUST_WORDS,
  activeGrant,
  grantPausedOn,
  noteDecision,
  offerStands,
  proposerName,
  proposerOf,
  refuseTrust,
  requireEligible,
  trustRow,
} from "./lib/trust";

const MAX_TRUST_ROWS = 500;
const MAX_GRANTS = 200;

/** The offers that stand: "Let Growth do `deal_next_step` without approval?" */
export const offers = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("botTrust").take(MAX_TRUST_ROWS);
    const out = [];
    for (const row of rows) {
      if (!(await offerStands(ctx, row))) continue;
      out.push({
        proposer: row.proposer,
        name: await proposerName(ctx, ctx.owner._id, row.proposer),
        kind: row.kind,
        streak: row.streak,
      });
    }
    return out;
  },
});

/**
 * Every grant in force, with the proposer's name and, for a bot that no longer
 * holds write on the kind's area, the area it is paused on: the Bots tab's
 * cards and /approvals read it.
 */
export const grants = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("autonomyGrants")
      .withIndex("by_revokedAt", (q) => q.eq("revokedAt", undefined))
      .take(MAX_GRANTS);
    const out = [];
    for (const row of rows) {
      out.push({
        id: row._id,
        proposer: row.proposer,
        name: await proposerName(ctx, ctx.owner._id, row.proposer),
        kind: row.kind,
        grantedAt: row.grantedAt,
        /** A bot's grant waiting on write on the kind's area: it auto-approves nothing until then. */
        paused: await grantPausedOn(ctx, ctx.owner._id, row.proposer, row.kind),
      });
    }
    return out;
  },
});

/** Yes to an offer. Refused for a kind that is never eligible, and before it is earned. */
export const grant = ownerMutation({
  args: { proposer: v.string(), kind: proposalKindValidator },
  handler: async (ctx, { proposer, kind }) => {
    const trust = await requireEligible(ctx, proposer, kind);
    if (trust === null || trust.streak < OFFER_AFTER) refuseTrust(TRUST_WORDS.notEarned);
    if ((await activeGrant(ctx, proposer, kind)) !== null) return null;
    await ctx.db.insert("autonomyGrants", { userId: ctx.owner._id, proposer, kind, grantedAt: Date.now() });
    return null;
  },
});

/** "Not yet": the offer is made again after ten more clean approvals in a row. */
export const notYet = ownerMutation({
  args: { proposer: v.string(), kind: proposalKindValidator },
  handler: async (ctx, { proposer, kind }) => {
    const trust = await requireEligible(ctx, proposer, kind);
    if (trust === null) return null;
    await ctx.db.patch(trust._id, { offerAt: trust.streak + OFFER_AFTER, updatedAt: Date.now() });
    return null;
  },
});

async function revokeGrant(
  ctx: MutationCtx,
  grantRow: Doc<"autonomyGrants">,
  patch: Partial<Doc<"autonomyGrants">>,
) {
  await ctx.db.patch(grantRow._id, { revokedAt: Date.now(), ...patch });
}

/** Take a grant back in one click: the kind waits for approval again from the next proposal. */
export const revoke = ownerMutation({
  args: { proposer: v.string(), kind: proposalKindValidator },
  handler: async (ctx, { proposer, kind }) => {
    const row = await activeGrant(ctx, proposer, kind);
    if (row === null) refuseTrust(TRUST_WORDS.noGrant);
    await revokeGrant(ctx, row!, { revokedBy: "owner" });
    // The streak starts again, so the offer is earned afresh.
    const trust = await trustRow(ctx, proposer, kind);
    if (trust !== null) await ctx.db.patch(trust._id, { streak: 0, offerAt: OFFER_AFTER, lastResetAt: Date.now() });
    return null;
  },
});

/**
 * Flag an auto-approved item: the grant for its proposer and kind is revoked,
 * the streak starts again, and the reason (a quick one, `code`, typed words,
 * or both: a rejection's own `rejectCode` / `rejectReason`, Approvals v2)
 * reaches the proposer through `proposals_feedback`. What was done is not
 * undone.
 */
export const flag = ownerMutation({
  args: { id: v.id("proposals"), reason: v.optional(v.string()), code: v.optional(v.string()) },
  handler: async (ctx, { id, reason, code }) => {
    const row = await ctx.db.get(id);
    if (row === null || row.status !== "auto_approved") return refuseTrust(TRUST_WORDS.notAuto);
    if ((reason ?? "").trim().length > MAX_DISMISS_REASON_LENGTH) refuseTrust(TRUST_WORDS.tooLong);
    if (code !== undefined && !(REJECT_CODES as readonly string[]).includes(code)) refuseTrust(PROPOSAL_WORDS.rejectReason);
    const said = cleanLine(reason ?? "", MAX_DISMISS_REASON_LENGTH);
    const now = Date.now();
    const grantRow = await activeGrant(ctx, proposerOf(row), row.kind);
    if (grantRow !== null) await revokeGrant(ctx, grantRow, { revokedBy: "flag", flaggedProposal: id });
    await ctx.db.patch(id, {
      ...(code === undefined ? null : { rejectCode: code as RejectCode }),
      rejectReason: said === "" ? "Flagged after it was approved automatically." : said,
    });
    await noteDecision(ctx, row, "dismissed", now);
    return null;
  },
});
