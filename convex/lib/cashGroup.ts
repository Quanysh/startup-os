// The approvals inbox's pinned "Cash and runway" group (Bot Loop v3, H):
// a proposal is in it when the goal it serves is tagged cash, or when it or
// its goal is about fundraising, finance or collections: proposed by the
// finance agent or a bot that writes fundraising or finance, a draft to an
// investor, evidence that is a finance metric, or a goal whose title names
// cash, runway, a raise, fundraising, collections or invoices. `inCashGroup`
// is pure; `cashReader` works it out for each row inside Convex, for the page
// (`inboxProposals`, whose flag the page reads) and the 09:00 digest alike.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { METRICS } from "./metricRegistry";

/** Areas whose work is cash work: a bot that writes one of these proposes into the cash group. */
export const CASH_AREAS = ["fundraising", "finance"] as const;

/** Words in a goal's title that make it a cash goal without the tag. */
const CASH_GOAL_WORDS = /\b(cash|runway|fundrais\w*|raise|raising|collections?|collect|invoic\w*|receivables?|burn)\b/i;

export function inCashGroup(row: {
  goal: { cash: boolean; title: string } | null;
  agent: string;
  /** Whether the bot that proposed it writes fundraising or finance (false for none). */
  botWritesCash: boolean;
  draftAbout: string | null;
  /** The section of a metric the proposal cites, when it cites one. */
  metricSection: string | null;
}): boolean {
  if (row.goal !== null && (row.goal.cash || CASH_GOAL_WORDS.test(row.goal.title))) return true;
  if (row.agent === "finance" || row.botWritesCash) return true;
  if (row.draftAbout === "investor") return true;
  return row.metricSection === "finance";
}

// ── Inside Convex: one row's flag, for the page and the digest alike ────────

/** The parts of a proposal row the cash rule reads. */
type CashRow = Pick<Doc<"proposals">, "agent" | "bot" | "kind" | "payload" | "goalId" | "source">;

/**
 * A reader of the cash flag, for many rows: each goal and each bot's profile
 * read once. `assistant.inbox` (`inboxProposals`) and the 09:00 digest
 * (convex/approvalsDigest.ts) both count through it, so the digest's "Cash
 * and runway" count is the page's pinned group, never a rule of its own.
 */
export function cashReader(db: QueryCtx["db"]): (row: CashRow) => Promise<boolean> {
  const goals = new Map<string, Doc<"goals"> | null>();
  const bots = new Map<string, boolean>();
  const goalOf = async (id: Id<"goals">) => {
    if (!goals.has(id)) goals.set(id, await db.get(id));
    return goals.get(id)!;
  };
  const writesCash = async (bot: string | undefined) => {
    if (bot === undefined) return false;
    if (!bots.has(bot)) {
      const profile = await db
        .query("bots")
        .withIndex("by_botId", (q) => q.eq("botId", bot))
        .first();
      bots.set(
        bot,
        profile !== null && profile.permissions.some((p) => p.level === "write" && (CASH_AREAS as readonly string[]).includes(p.area)),
      );
    }
    return bots.get(bot)!;
  };
  return async (row) => {
    const goal = row.goalId === undefined ? null : await goalOf(row.goalId);
    const about = row.kind === "draft" ? ((row.payload as { about?: { type?: unknown } }).about?.type ?? null) : null;
    const source = row.source;
    const metricSection = source?.kind === "metric" ? (METRICS.find((metric) => metric.key === source.id)?.section ?? null) : null;
    return inCashGroup({
      goal: goal === null ? null : { cash: goal.cash === true, title: goal.title },
      agent: row.agent,
      botWritesCash: await writesCash(row.bot),
      draftAbout: typeof about === "string" ? about : null,
      metricSection,
    });
  };
}
