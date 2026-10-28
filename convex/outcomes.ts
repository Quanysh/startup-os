import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { cleanLine, cleanLines } from "./lib/agentText";
import { levelOf, withLevel } from "./lib/botRules";
import type { CompanyId } from "./lib/company";
import { looksLikeContactDetail } from "./lib/dealDetails";
import {
  MAX_EVIDENCE_LENGTH,
  MAX_PLAY_LENGTH,
  OUTCOME_ROWS,
  OUTCOME_SUBJECT_AREAS,
  OUTCOME_SUBJECT_KINDS,
  OUTCOME_WORDS,
  OUTCOME_WRITERS,
  playsOf,
  type OutcomeChannel,
  type OutcomeResult,
  type OutcomeSignal,
  type OutcomeSubjectKind,
} from "./lib/outcomes";
import { memberQuery, ownerQuery, requireCompany, type Member } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { may } from "./lib/roles";

// Outcomes (Bot Loop v3, section G; convex/lib/outcomes.ts): what came of a
// play a bot ran on a deal, a customer, an investor or a partner. Written
// only by `logOutcome`, which the `outcome_log` tool runs (the `outcomes`
// area, write); read by the `outcomes` tool (`outcomeRows`), by a deal's,
// customer's and partner's timeline (`forSubject`, the `outcomes` area) and
// by the Bots tab's "Plays" table (`playsByBot`, the owner's).
//
// Who logged it is the endpoint's matched bot (or one of the four the call
// named), never an argument. No title, name or evidence in a log or a thrown
// error: every refusal is `OUTCOME_WORDS`.

type Row = Doc<"outcomes">;
const subjectKind = v.union(...OUTCOME_SUBJECT_KINDS.map((kind) => v.literal(kind)));

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

/** Text an outcome stores: within its limit, cleaned, not empty, and no email address or phone number. */
function textIn(value: string, max: number, many: boolean): string {
  if (value.trim().length > max) return refuse(OUTCOME_WORDS.tooLong);
  const text = many ? cleanLines(value, max) : cleanLine(value, max);
  if (text === null) return refuse(OUTCOME_WORDS.tooLong);
  if (text === "") return refuse(OUTCOME_WORDS.empty);
  if (looksLikeContactDetail(text)) return refuse(OUTCOME_WORDS.contact);
  return text;
}

const dayIn = (value: string): string =>
  isCanonicalPeriodStart("day", value) ? value : refuse(OUTCOME_WORDS.notADate);

/** Whether a subject is a row of that company: a deal of its market, a clinic of its register, an investor (Startup's), a partner. */
async function subjectExists(ctx: QueryCtx, company: CompanyId, subject: { kind: OutcomeSubjectKind; id: string }) {
  switch (subject.kind) {
    case "deal": {
      const id = ctx.db.normalizeId("deals", subject.id);
      const deal = id === null ? null : await ctx.db.get(id);
      return deal !== null && deal.market === company;
    }
    case "customer": {
      const id = ctx.db.normalizeId("customers", subject.id);
      const clinic = id === null ? null : await ctx.db.get(id);
      return clinic !== null && clinic.market === company;
    }
    case "investor": {
      // Fundraising is Startup's alone.
      const id = ctx.db.normalizeId("investors", subject.id);
      return company === "us" && id !== null && (await ctx.db.get(id)) !== null;
    }
    case "partner": {
      const id = ctx.db.normalizeId("partners", subject.id);
      const partner = id === null ? null : await ctx.db.get(id);
      return partner !== null && partner.company === company;
    }
  }
}

export type OutcomeInput = {
  /** A pending outcome of the caller's to update; left out, a new one. */
  id?: string;
  company: CompanyId;
  subject?: { kind: OutcomeSubjectKind; id: string };
  play?: string;
  channel?: OutcomeChannel;
  result: OutcomeResult;
  signal?: OutcomeSignal;
  evidence: string;
  actedOn?: string;
  observedOn?: string;
  proposalId?: string;
};

/**
 * Log an outcome as `by` (a bot's profile id, or one of the four), or update
 * a pending one `by` logged: its result, signal, channel, evidence and the
 * day it was seen; what it is about and the play stay. Returns its id and
 * whether it was made.
 */
export async function logOutcome(
  ctx: MutationCtx,
  member: Member,
  input: OutcomeInput,
  clock: { now: number; by: string },
): Promise<{ id: Id<"outcomes">; created: boolean }> {
  requireCompany(member, input.company);
  const evidence = textIn(input.evidence, MAX_EVIDENCE_LENGTH, true);
  const observedOn = input.observedOn === undefined ? undefined : dayIn(input.observedOn);
  const changes = {
    result: input.result,
    evidence,
    ...(input.signal === undefined ? null : { signal: input.signal }),
    ...(input.channel === undefined ? null : { channel: input.channel }),
    ...(observedOn === undefined ? null : { observedOn }),
    updatedAt: clock.now,
  };
  if (input.id !== undefined) {
    const id = ctx.db.normalizeId("outcomes", input.id);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null) return refuse(OUTCOME_WORDS.gone);
    if (row.company !== input.company) return refuse(OUTCOME_WORDS.otherCompany);
    if (row.agent !== clock.by) return refuse(OUTCOME_WORDS.notYours);
    if (row.result !== "pending") return refuse(OUTCOME_WORDS.notPending);
    await ctx.db.patch(row._id, changes);
    return { id: row._id, created: false };
  }
  const { subject, play, actedOn } = input;
  if (subject === undefined || play === undefined || actedOn === undefined) return refuse(OUTCOME_WORDS.needs);
  const playText = textIn(play, MAX_PLAY_LENGTH, false);
  const acted = dayIn(actedOn);
  if (!(await subjectExists(ctx, input.company, subject))) return refuse(OUTCOME_WORDS.subject);
  let proposalId: Id<"proposals"> | undefined;
  if (input.proposalId !== undefined) {
    const found = ctx.db.normalizeId("proposals", input.proposalId);
    const followed = found === null ? null : await ctx.db.get(found);
    // Another company's proposal is refused in the same words as one that is gone: no id is told apart.
    if (found === null || followed === null || followed.company !== input.company) return refuse(OUTCOME_WORDS.proposalGone);
    proposalId = found;
  }
  const id = await ctx.db.insert("outcomes", {
    company: input.company,
    agent: clock.by,
    subject: { kind: subject.kind, id: subject.id },
    play: playText,
    actedOn: acted,
    ...(proposalId === undefined ? null : { proposalId }),
    createdAt: clock.now,
    ...changes,
  });
  return { id, created: true };
}

/** An outcome as every reader is sent it: who logged it as `by`. */
const shown = (row: Row) => ({
  id: row._id,
  company: row.company,
  by: row.agent,
  subject: row.subject,
  play: row.play,
  channel: row.channel ?? null,
  result: row.result,
  signal: row.signal ?? null,
  evidence: row.evidence,
  actedOn: row.actedOn,
  observedOn: row.observedOn ?? null,
  proposalId: row.proposalId ?? null,
  updatedAt: row.updatedAt,
});
export type OutcomeRow = ReturnType<typeof shown>;

/** Rows one company's read goes through before its filters, newest first. */
const SCANNED = 2_000;

export type OutcomeFilters = {
  company?: CompanyId | undefined;
  by?: string | undefined;
  play?: string | undefined;
  result?: OutcomeResult | undefined;
  /** A day, "YYYY-MM-DD": acted on that day or later. */
  since?: string | undefined;
};

/** Whether a reader reads an area: a teammate's own areas, or a bot's profile (convex/lib/mcpTools.ts). */
export type AreaReader = (area: (typeof OUTCOME_SUBJECT_AREAS)[OutcomeSubjectKind]) => boolean;

/**
 * The outcomes of the caller's companies (or the one named), filtered, newest
 * first, and each play's tally over every row the filters keep: what the
 * `outcomes` tool returns. Only the subjects `reads` holds the area of are
 * kept, before the tally, so a play's counts say nothing of the rest.
 */
export async function outcomeRows(ctx: QueryCtx, member: Member, filters: OutcomeFilters, reads: AreaReader) {
  const companies = member.companies.filter((c) => filters.company === undefined || c === filters.company);
  const kept: Row[] = [];
  for (const company of companies) {
    const rows = await ctx.db
      .query("outcomes")
      .withIndex("by_company_and_actedOn", (q) =>
        filters.since === undefined ? q.eq("company", company) : q.eq("company", company).gte("actedOn", filters.since),
      )
      .order("desc")
      .take(SCANNED);
    kept.push(
      ...rows.filter(
        (row) =>
          reads(OUTCOME_SUBJECT_AREAS[row.subject.kind]) &&
          (filters.by === undefined || row.agent === filters.by) &&
          (filters.play === undefined || row.play === filters.play) &&
          (filters.result === undefined || row.result === filters.result),
      ),
    );
  }
  kept.sort((a, b) => (a.actedOn < b.actedOn ? 1 : a.actedOn > b.actedOn ? -1 : b.createdAt - a.createdAt));
  return { rows: kept.slice(0, OUTCOME_ROWS).map(shown), plays: playsOf(kept) };
}

/**
 * A deal's, a customer's, an investor's or a partner's outcomes, newest first:
 * its timeline. Nothing to someone who does not also read the subject's own
 * area (`OUTCOME_SUBJECT_AREAS`): the outcomes area alone opens no deal.
 */
export const forSubject = memberQuery("outcomes")({
  args: { kind: subjectKind, id: v.string() },
  handler: async (ctx, args) => {
    if (!may(ctx.member, OUTCOME_SUBJECT_AREAS[args.kind])) return [];
    const rows = await ctx.db
      .query("outcomes")
      .withIndex("by_subject_and_actedOn", (q) => q.eq("subject.kind", args.kind).eq("subject.id", args.id))
      .order("desc")
      .take(OUTCOME_ROWS);
    return rows.filter((row) => ctx.member.companies.includes(row.company)).map(shown);
  },
});

/**
 * Each proposer's plays since a moment (the page's clock: 30 days ago), for
 * the Bots tab: per bot, each play's worked, failed and pending and its win
 * rate. The owner's alone, as the tab is.
 */
export const playsByBot = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const day = new Date(since).toISOString().slice(0, 10);
    const by = new Map<string, Row[]>();
    for (const company of ["us", "kz"] as const) {
      const rows = await ctx.db
        .query("outcomes")
        .withIndex("by_company_and_actedOn", (q) => q.eq("company", company).gte("actedOn", day))
        .take(SCANNED);
      for (const row of rows) by.set(row.agent, [...(by.get(row.agent) ?? []), row]);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([agent, rows]) => ({ by: agent, plays: playsOf(rows) }));
  },
});

/**
 * Once, after the `outcomes` area shipped: give every bot that holds nothing
 * on it its default (write for the bots that run plays, `OUTCOME_WRITERS`,
 * read for the rest), keeping any level the owner set and a suggested bot's
 * mark. `npx convex run outcomes:grantDefaults`. Returns counts only.
 */
export const grantDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let write = 0;
    let read = 0;
    let kept = 0;
    for (const bot of await ctx.db.query("bots").take(1_000)) {
      if (levelOf(bot.permissions, "outcomes") !== "none") {
        kept += 1;
        continue;
      }
      const level = (OUTCOME_WRITERS as readonly string[]).includes(bot.botId) ? "write" : "read";
      await ctx.db.patch(bot._id, { permissions: withLevel(bot.permissions, "outcomes", level), updatedAt: now });
      if (level === "write") write += 1;
      else read += 1;
    }
    return { write, read, kept };
  },
});
