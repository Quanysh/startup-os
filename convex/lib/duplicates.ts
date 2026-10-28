// Near-duplicates (Bot Loop v3, B; docs/assistant.md, "Near-duplicates"):
// before a bot or an agent puts a new card in front of the owner (a proposal,
// a task, a goal proposal, a handoff), what is already open is compared with
// it, and a near match is refused as `possible_duplicate` unless the caller
// retries with `force` and a `forceReason`.
//
// - **Score**: the titles, word by word (stop words and words under three
//   letters dropped, a light stem), each word matched to its nearest by
//   trigram Dice; the mean of the overlap and Dice of those matches. Plus
//   `LINK_BONUS` when both point at the same deal, task, goal or customer.
//   No model, no embedding: text match and shared links first (the owner's
//   decision of 2026-10-19).
// - **Candidates**: open tasks (backlog, this week, doing), open proposals and
//   unfinished handoffs of the same company plus shared ones, made in the last
//   `DUPLICATE_WINDOW_DAYS`; each list bounded. For a proposed new deal
//   (`deal_create`, given `dealName`) also that market's deals, archived and
//   mirrored ones and any age included, by normalised name (`dealNameKey`):
//   the same name scores 1, as does an open `deal_create` proposal of it.
// - **Threshold**: the owner's (`duplicateSettings`), `DEFAULT_DUP_THRESHOLD`
//   where none is set.
// - **Logged**: every check writes `{tool, sim, decision}` to
//   `duplicateChecks`: numbers and closed words only, never a title.
//
// `findDuplicates` is pure of writes and reads no clock (`now` is handed in),
// so another builder can call it from a query or a mutation; `checkDuplicates`
// is the mutation side that refuses and logs. Runs only inside Convex apart
// from the pure functions at the top, which the UI may import.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { filedBy } from "./agents";
import { levelOf } from "./botRules";
import { botNamed } from "./botStore";
import type { CompanyId } from "./company";
import { dealNameKey } from "./dealDetails";

export const DEFAULT_DUP_THRESHOLD = 0.82;
/** The owner may set the threshold from here to 1. */
export const MIN_DUP_THRESHOLD = 0.5;
export const LINK_BONUS = 0.15;
export const DUPLICATE_WINDOW_DAYS = 60;
export const MAX_DUPLICATE_MATCHES = 3;
export const MAX_FORCE_REASON = 200;
/** Each candidate list is read to at most this many rows. */
const CANDIDATE_ROWS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DUPLICATE_LINK_KINDS = ["deal", "task", "goal", "customer"] as const;
export type DuplicateLinkKind = (typeof DUPLICATE_LINK_KINDS)[number];
export type DuplicateLink = { kind: DuplicateLinkKind; id: string };

export const DUPLICATE_CANDIDATE_TYPES = ["task", "proposal", "handoff", "deal"] as const;
export type DuplicateCandidateType = (typeof DUPLICATE_CANDIDATE_TYPES)[number];
/** What every check compares against unless it says otherwise: deals only for a proposed new deal. */
export const DEFAULT_CANDIDATE_TYPES: readonly DuplicateCandidateType[] = ["task", "proposal", "handoff"];
export type DuplicateMatch = { type: DuplicateCandidateType; id: string; title: string; sim: number };
/** A match as a caller who may not read its type is told it: what it is and how near, never its title or id. */
export type HiddenMatch = { type: DuplicateCandidateType; sim: number };

/** The tools a check is made for, as the log names them: a closed set. */
export const DUPLICATE_CHECK_TOOLS = ["propose", "task_create", "goal_create", "goal_update", "handoff_create", "deal_create"] as const;
export type DuplicateCheckTool = (typeof DUPLICATE_CHECK_TOOLS)[number];
export const DUPLICATE_DECISIONS = ["clear", "refused", "forced"] as const;

export const DUPLICATE_WORDS = {
  possible:
    "This looks like something already open (see `matches`). If it is the same, do not add it. If it is different, call again with `force: true` and a `forceReason` that says how it differs.",
  forceReason: `\`force\` needs a \`forceReason\` of at most ${MAX_FORCE_REASON} characters that says how it differs.`,
  threshold: `The duplicate threshold is a number from ${MIN_DUP_THRESHOLD} to 1.`,
} as const;

// ── Pure: the score ─────────────────────────────────────────────────────────

const STOP = new Set(
  "a an the to of on for and or in at by with from into via is are be as it this that about our new".split(" "),
);
const stem = (word: string) => (word.length > 4 ? word.replace(/(ing|ers|er|es|s|ed)$/, "") : word);

/** A title's content words: lower case, letters and digits only, no stop word, at least 3 letters (or holding a digit), stemmed. */
export function contentWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "" && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)))
    .map(stem);
  return [...new Set(words)];
}

function trigrams(word: string): Set<string> {
  const padded = ` ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function wordDice(a: string, b: string): number {
  if (a === b) return 1;
  const A = trigrams(a);
  const B = trigrams(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** How alike two titles are, 0 to 1, to two decimals. */
export function titleSimilarity(a: string, b: string): number {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.length === 0 || B.length === 0) return 0;
  const [small, large] = A.length <= B.length ? [A, B] : [B, A];
  let matched = 0;
  for (const word of small) {
    let best = 0;
    for (const other of large) best = Math.max(best, wordDice(word, other));
    // A word only counts when it is near another: "smith" and "jones" share nothing.
    if (best >= 0.7) matched += best;
  }
  const dice = (2 * matched) / (A.length + B.length);
  // One word inside a longer title says little ("New task" is in every "… task"): Dice alone.
  if (small.length === 1) return Math.round(dice * 100) / 100;
  const overlap = matched / small.length;
  return Math.round(((overlap + dice) / 2) * 100) / 100;
}

const sharesLink = (a: readonly DuplicateLink[], b: readonly DuplicateLink[]) =>
  a.some((x) => b.some((y) => x.kind === y.kind && x.id === y.id));

/** A new item against one open one: the titles' similarity, plus the bonus for a shared link, at most 1. */
export function scoreDuplicate(
  item: { title: string; links?: readonly DuplicateLink[] },
  candidate: { title: string; links?: readonly DuplicateLink[] },
): number {
  const sim = titleSimilarity(item.title, candidate.title);
  const bonus = sharesLink(item.links ?? [], candidate.links ?? []) ? LINK_BONUS : 0;
  return Math.min(1, Math.round((sim + bonus) * 100) / 100);
}

type PayloadLike = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** What a proposal would be called on a card: its payload's title, a new deal's name, a deal's next step, else nothing. */
export function proposalTitle(payload: PayloadLike): string {
  return str(payload.title) ?? str(payload.name) ?? str(payload.nextStep) ?? "";
}

/** A proposal's links: the task, deal or goal its payload names, the goal it serves, its source, a draft's subject. */
export function linksOfProposal(row: {
  payload: PayloadLike;
  goalId?: string | null | undefined;
  source?: { kind: string; id: string } | null | undefined;
}): DuplicateLink[] {
  const out: DuplicateLink[] = [];
  const add = (kind: DuplicateLinkKind, id: string | null) => {
    if (id !== null && !out.some((l) => l.kind === kind && l.id === id)) out.push({ kind, id });
  };
  const { payload } = row;
  add("task", str(payload.taskId));
  add("deal", str(payload.dealId));
  add("goal", str(payload.goalId));
  const about = payload.about as { type?: unknown; id?: unknown } | undefined;
  if (about !== undefined && (about.type === "deal" || about.type === "customer")) add(about.type, str(about.id));
  add("goal", str(row.goalId ?? null));
  if (row.source != null && (row.source.kind === "deal" || row.source.kind === "task")) add(row.source.kind, row.source.id);
  return out;
}

// ── Inside Convex: candidates, the check, the log ──────────────────────────

/** `nameKey`: a deal's, or a proposed new deal's, normalised name: the same name is a match whatever the titles score. */
type Candidate = { type: DuplicateCandidateType; id: string; title: string; links: DuplicateLink[]; nameKey?: string };

async function openTasks(ctx: QueryCtx, company: CompanyId | null, since: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const column of ["backlog", "this_week", "doing"] as const) {
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_column_and_order", (q) => q.eq("column", column))
      .take(CANDIDATE_ROWS);
    for (const row of rows) {
      if (row.archivedAt !== undefined) continue;
      if (row._creationTime < since) continue;
      // Same company plus shared (a task with no company is both companies').
      if (company !== null && row.company !== undefined && row.company !== company) continue;
      out.push({
        type: "task",
        id: row._id,
        title: row.title,
        links: [{ kind: "task", id: row._id }, ...(row.goalId === undefined ? [] : [{ kind: "goal" as const, id: row.goalId }])],
      });
    }
  }
  return out;
}

async function openProposalRows(ctx: QueryCtx, companies: readonly CompanyId[], since: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const company of companies) {
    const rows = await ctx.db
      .query("proposals")
      .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", "open").gte("createdAt", since))
      .take(CANDIDATE_ROWS);
    for (const row of rows) {
      if (row.kind === "bot_permission") continue;
      const payload = row.payload as PayloadLike;
      const name = row.kind === "deal_create" ? str(payload.name) : null;
      out.push({
        type: "proposal",
        id: row._id,
        title: proposalTitle(payload),
        links: linksOfProposal({ ...row, payload }),
        ...(name === null ? null : { nameKey: dealNameKey(name) }),
      });
    }
  }
  return out;
}

async function openHandoffRows(ctx: QueryCtx, companies: readonly CompanyId[], since: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const company of companies) {
    for (const status of ["open", "accepted"] as const) {
      const rows = await ctx.db
        .query("handoffs")
        .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", status))
        .take(CANDIDATE_ROWS);
      for (const row of rows) {
        if (row.createdAt < since) continue;
        const links = row.links.flatMap((l): DuplicateLink[] =>
          l.kind === "task" || l.kind === "deal" ? [{ kind: l.kind, id: l.id }] : [],
        );
        out.push({ type: "handoff", id: row._id, title: row.title, links });
      }
    }
  }
  return out;
}

/**
 * A market's deals, by normalised name (Bot Loop v3, C): archived and mirrored
 * ones and any age included, since a name on the board is the same company
 * however long ago it came. Only ever read for a proposed new deal.
 */
async function dealRows(ctx: QueryCtx, companies: readonly CompanyId[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const market of companies) {
    const rows = await ctx.db
      .query("deals")
      .withIndex("by_market_and_stage_and_order", (q) => q.eq("market", market))
      .collect();
    for (const row of rows) {
      out.push({ type: "deal", id: row._id, title: row.name, links: [{ kind: "deal", id: row._id }], nameKey: dealNameKey(row.name) });
    }
  }
  return out;
}

/** The owner's threshold, or the default. */
export async function dupThreshold(ctx: QueryCtx): Promise<number> {
  const row = await ctx.db.query("duplicateSettings").first();
  return row?.threshold ?? DEFAULT_DUP_THRESHOLD;
}

/**
 * What is already open and near this item: the top `MAX_DUPLICATE_MATCHES`
 * at or above the threshold, best first, with the best score seen (for the
 * log) and the threshold used. `company` null is a shared item: both
 * companies' rows are candidates. `kinds` narrows the candidate types
 * (`DEFAULT_CANDIDATE_TYPES` when left out); `dealName`, a proposed new deal's
 * name, adds that market's deals by name. Reads no clock: `now` is the caller's.
 */
export async function findDuplicates(
  ctx: QueryCtx,
  args: {
    company: CompanyId | null;
    title: string;
    links?: readonly DuplicateLink[];
    kinds?: readonly DuplicateCandidateType[];
    /** A proposed new deal's name: its market's deals are candidates by normalised name. */
    dealName?: string;
    now: number;
    /** Ids never to match (the row being changed itself). */
    exclude?: readonly string[];
  },
): Promise<{ matches: DuplicateMatch[]; best: number; threshold: number }> {
  const threshold = await dupThreshold(ctx);
  const kinds = args.kinds ?? (args.dealName === undefined ? DEFAULT_CANDIDATE_TYPES : DUPLICATE_CANDIDATE_TYPES);
  const since = args.now - DUPLICATE_WINDOW_DAYS * DAY_MS;
  const companies: CompanyId[] = args.company === null ? ["us", "kz"] : [args.company];
  const candidates: Candidate[] = [
    ...(kinds.includes("task") ? await openTasks(ctx, args.company, since) : []),
    ...(kinds.includes("proposal") ? await openProposalRows(ctx, companies, since) : []),
    ...(kinds.includes("handoff") ? await openHandoffRows(ctx, companies, since) : []),
    ...(kinds.includes("deal") && args.dealName !== undefined ? await dealRows(ctx, companies) : []),
  ];
  const item = { title: args.title, links: args.links ?? [] };
  const nameKey = args.dealName === undefined ? null : dealNameKey(args.dealName);
  let best = 0;
  const scored: DuplicateMatch[] = [];
  for (const candidate of candidates) {
    if (args.exclude?.includes(candidate.id)) continue;
    const sameName = nameKey !== null && candidate.nameKey === nameKey;
    // A deal is matched by its name alone; anything else by title and links (a same-named new deal scores 1).
    const sim = sameName ? 1 : candidate.type === "deal" ? 0 : scoreDuplicate(item, candidate);
    best = Math.max(best, sim);
    if (sim >= threshold) scored.push({ type: candidate.type, id: candidate.id, title: candidate.title, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return { matches: scored.slice(0, MAX_DUPLICATE_MATCHES), best, threshold };
}

// ── What the caller is told of a match ──────────────────────────────────────
// Every candidate is scored, so the decision to refuse is the same for every
// caller; what a refusal (or a forced item's answer) says of each match is
// held to what the caller may read (the security review of 2026-10-19). A
// match's title and id go only to a caller who may read its type: proposals
// never to a bot (they are the owner's own, the locked `personal` area), tasks
// and handoffs to a bot that reads the board, deals to one that reads sales.
// The owner's own clients and Startup OS's four agents (no bot) see every match.

/** The candidate types a caller may be shown in full: every one, or these. */
export type DuplicateView = "all" | readonly DuplicateCandidateType[];

/**
 * What a caller may be shown of a match: `bot` the profile id the endpoint
 * matched (`ToolClock.bot`), or undefined for a call naming no bot. A bot
 * with no profile is shown nothing.
 */
export async function duplicateViewFor(ctx: QueryCtx, owner: Id<"users">, bot: string | undefined): Promise<DuplicateView> {
  if (bot === undefined) return "all";
  const profile = await botNamed(ctx, owner, bot);
  if (profile === null) return [];
  const reads = (area: string) => levelOf(profile.permissions, area) !== "none";
  return [...(reads("board") ? (["task", "handoff"] as const) : []), ...(reads("sales") ? (["deal"] as const) : [])];
}

const mayShow = (view: DuplicateView, type: DuplicateCandidateType) => view === "all" || view.includes(type);

/** The matches as this caller is told them: in full where it may read the type, else type and score. */
export const shownMatches = (matches: readonly DuplicateMatch[], view: DuplicateView): (DuplicateMatch | HiddenMatch)[] =>
  matches.map((m) => (mayShow(view, m.type) ? m : { type: m.type, sim: m.sim }));

/** What a forced item stores: what it may duplicate, and why the caller says it does not. */
export type DuplicateMark = { duplicateOf: string[]; forceReason: string };

/** What a refused check leaves for the endpoint to log after the transaction rolled back: numbers and a closed word. */
export type DuplicateLog = { tool: DuplicateCheckTool; sim: number; threshold: number };

/**
 * The refusal a near match is thrown as: its words and, for the endpoint, its
 * code and matches, and the check's log line (the mutation that threw keeps
 * nothing, so the endpoint writes it: `duplicates.logRefused`).
 */
export function possibleDuplicate(
  matches: (DuplicateMatch | HiddenMatch)[],
  log: DuplicateLog,
  withdrawHint?: string[],
): never {
  // Named only when the caller has one of its own among the matches.
  const refusal = { code: "possible_duplicate", matches, ...(withdrawHint === undefined || withdrawHint.length === 0 ? null : { withdrawHint }) };
  throw new ConvexError({ words: DUPLICATE_WORDS.possible, refusal, log });
}

/**
 * The matched open proposals this proposer filed itself (`filedBy`): the ids
 * a `possible_duplicate` hands back as `withdrawHint`, so it can withdraw and
 * refile (spec §14). Only its own: safe to reveal, never another proposer's.
 */
async function ownMatches(
  ctx: QueryCtx,
  matches: readonly DuplicateMatch[],
  proposer: { bot?: string | undefined; agent?: string | undefined },
): Promise<string[]> {
  const own: string[] = [];
  for (const match of matches) {
    if (match.type !== "proposal") continue;
    const id = ctx.db.normalizeId("proposals", match.id);
    const row = id === null ? null : await ctx.db.get(id);
    if (row !== null && row.status === "open" && filedBy(row, proposer)) own.push(row._id);
  }
  return own;
}

/** A `forceReason` checked: trimmed, one line, 1 to 200 characters. Fixed words otherwise. */
export function cleanForceReason(reason: string | undefined): string {
  const said = (reason ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (said === "" || said.length > MAX_FORCE_REASON) throw new ConvexError(DUPLICATE_WORDS.forceReason);
  return said;
}

/**
 * The check a creating tool makes: find what is near; with nothing near, the
 * item goes ahead (null); with something near and no `force`, refused as
 * `possible_duplicate`; with `force` and a reason, it goes ahead marked
 * (`DuplicateMark`, to store; `shown`, the ids the caller may be handed). Each check is logged as numbers and a closed word.
 * `view` is what the caller may be told of each match (`duplicateViewFor`):
 * it changes what a refusal says, never whether there is one.
 * A mutation that throws writes nothing, so a refused check's row is
 * written by the endpoint from the error's `log` (`duplicates.logRefused`).
 */
export async function checkDuplicates(
  ctx: MutationCtx,
  args: {
    tool: DuplicateCheckTool;
    company: CompanyId | null;
    title: string;
    links?: readonly DuplicateLink[];
    kinds?: readonly DuplicateCandidateType[];
    dealName?: string;
    now: number;
    force?: boolean | undefined;
    forceReason?: string | undefined;
    view: DuplicateView;
    /** A proposal's proposer: a refusal then names its own matching open proposals (`withdrawHint`). */
    proposer?: { bot?: string | undefined; agent?: string | undefined };
  },
): Promise<(DuplicateMark & { shown: string[] }) | null> {
  const reason = args.force === true ? cleanForceReason(args.forceReason) : null;
  const found = await findDuplicates(ctx, args);
  const decision = found.matches.length === 0 ? "clear" : reason === null ? "refused" : "forced";
  if (decision === "refused") {
    possibleDuplicate(
      shownMatches(found.matches, args.view),
      { tool: args.tool, sim: found.best, threshold: found.threshold },
      args.proposer === undefined ? undefined : await ownMatches(ctx, found.matches, args.proposer),
    );
  }
  await ctx.db.insert("duplicateChecks", { at: args.now, tool: args.tool, sim: found.best, decision, threshold: found.threshold });
  if (found.matches.length === 0 || reason === null) return null;
  return {
    duplicateOf: found.matches.map((m) => m.id),
    forceReason: reason,
    // What the caller may be handed back of them; the stored mark keeps every id, for the owner's card.
    shown: found.matches.filter((m) => mayShow(args.view, m.type)).map((m) => m.id),
  };
}

/** Checks kept: the newest this many days (the daily sweep deletes older). */
export const DUPLICATE_CHECK_RETENTION_DAYS = 30;

/** Delete checks older than the retention, a batch at a time. Returns how many. */
export async function pruneDuplicateChecks(ctx: MutationCtx, now: number): Promise<number> {
  const old = await ctx.db
    .query("duplicateChecks")
    .withIndex("by_at", (q) => q.lt("at", now - DUPLICATE_CHECK_RETENTION_DAYS * DAY_MS))
    .take(500);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length;
}

export type DuplicateCheckRow = Doc<"duplicateChecks">;
