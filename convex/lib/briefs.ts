// The daily brief (the `briefs` table): written by the owner's agents through
// `brief_write` (convex/lib/mcpTools.ts), read by the owner's page
// (`assistant.brief`) and by a later run (`brief_latest`). Runs only inside
// Convex: never import it from the UI.
//
// A brief is a model's text. Each bullet is cleaned to one line, bounded and
// stored as text; its `page` is one of a closed list of the app's own paths,
// never an address. No bullet's text goes in a log or a thrown error: every
// refusal is fixed words (convex/lib/agents.ts).

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentsOff, requireAgentOn } from "./agentStore";
import { cleanLine } from "./agentText";
import {
  AGENT_OFF,
  BRIEF_RETENTION_DAYS,
  BRIEF_WORDS,
  MAX_BRIEF_BULLETS,
  MAX_BULLET_LENGTH,
  isBriefPage,
  type AgentId,
} from "./agents";
import { daysBetween } from "./attention/dates";
import type { CompanyId } from "./company";

export type BriefInput = {
  /** Who is writing. */
  agent: AgentId;
  company: CompanyId;
  /** "YYYY-MM-DD"; the server's day when left out. */
  day?: string;
  bullets: readonly { text: string; page?: string; agent?: AgentId }[];
};

const present = (row: Doc<"briefs">) => ({
  company: row.company,
  day: row.day,
  writtenAt: row.writtenAt,
  bullets: row.bullets,
});

/**
 * Write a company's brief for a day, replacing the one it had. `clock` is
 * the endpoint's: `day` may be the server's UTC day or the day either side.
 * A bullet is stamped with the agent whose finding it is (the writer, unless
 * it says another), and neither may be switched off.
 */
export async function writeBrief(
  ctx: MutationCtx,
  input: BriefInput,
  clock: { now: number; today: string },
) {
  await requireAgentOn(ctx, input.agent);
  const day = input.day ?? clock.today;
  if (Math.abs(daysBetween(clock.today, day)) > 1) throw new ConvexError(BRIEF_WORDS.dayTooFar);
  if (input.bullets.length === 0 || input.bullets.length > MAX_BRIEF_BULLETS) {
    throw new ConvexError(BRIEF_WORDS.noBullets);
  }
  const off = await agentsOff(ctx);
  const bullets = input.bullets.map((bullet) => {
    const agent = bullet.agent ?? input.agent;
    if (off.includes(agent)) throw new ConvexError(AGENT_OFF);
    if (bullet.text.length > MAX_BULLET_LENGTH) throw new ConvexError(BRIEF_WORDS.tooLong);
    const text = cleanLine(bullet.text, MAX_BULLET_LENGTH);
    if (text === "") throw new ConvexError(BRIEF_WORDS.emptyBullet);
    if (bullet.page !== undefined && !isBriefPage(bullet.page)) {
      throw new ConvexError(BRIEF_WORDS.page);
    }
    return { agent, text, ...(bullet.page === undefined ? null : { page: bullet.page }) };
  });

  const existing = await ctx.db
    .query("briefs")
    .withIndex("by_company_and_day", (q) => q.eq("company", input.company).eq("day", day))
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);
  await ctx.db.insert("briefs", { company: input.company, day, bullets, writtenAt: clock.now });
  return { company: input.company, day, bullets: bullets.length, replaced: existing.length > 0 };
}

/** A company's latest brief, or null. Its age is the reader's to judge: no clock is read here. */
export async function latestBrief(ctx: QueryCtx, company: CompanyId) {
  const row = await ctx.db
    .query("briefs")
    .withIndex("by_company_and_day", (q) => q.eq("company", company))
    .order("desc")
    .first();
  return row === null ? null : present(row);
}

/** How many of a company's briefs the archive holds: today and the seven days before. */
export const BRIEF_ARCHIVE_DAYS = 8;

/**
 * A company's latest briefs, one a day, newest day first: the archive on the
 * owner's page. Which of them is recent enough to show is the reader's to
 * judge with its own clock: no clock is read here.
 */
export async function recentBriefs(ctx: QueryCtx, company: CompanyId) {
  const rows = await ctx.db
    .query("briefs")
    .withIndex("by_company_and_day", (q) => q.eq("company", company))
    .order("desc")
    .take(BRIEF_ARCHIVE_DAYS);
  return rows.map(present);
}

/** Briefs written at or after `since`, counted (500 at most). */
export async function briefsSince(ctx: QueryCtx, since: number): Promise<number> {
  const rows = await ctx.db
    .query("briefs")
    .withIndex("by_writtenAt", (q) => q.gte("writtenAt", since))
    .take(500);
  return rows.length;
}

/** Delete a batch of briefs past their keeping. Returns whether there may be more. */
export async function pruneBriefs(ctx: MutationCtx, now: number, batch: number): Promise<boolean> {
  const before = now - BRIEF_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const old = await ctx.db
    .query("briefs")
    .withIndex("by_writtenAt", (q) => q.lt("writtenAt", before))
    .take(batch);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length === batch;
}
