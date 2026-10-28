// What the browser may ask about the work tools: the settings, and the lists
// of mirrored records. This is the only file that reads mirrorRecords'
// content for the browser, and no query in it reads a clock.
//
// WHOSE RECORDS. Mail, calendar, meeting notes and "my issues" are personal:
// each caller with the Today area is sent their own and nobody else's. The
// owner's are the rows with no `owner`; a teammate's are the rows whose
// `owner` is their own address and whose `userId` is their own `users` row
// (`holderOf`, `isHeldBy`). The owner is never sent a
// teammate's, a teammate never the owner's or another teammate's, and no
// function here takes an argument that names a person. `issues` is the one
// shared list: the Linear board, for anyone with the board, from the rows
// with no `owner` only. The settings are the owner's alone.

import { ConvexError, v } from "convex/values";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyOfLinearTeam, linearTeamServes, type CompanyId } from "./lib/company";
import { clampLimit } from "./lib/limits";
import { IMPORTABLE_MEETINGS, MEMORY_WORDS } from "./lib/memory";
import {
  cleanDomain,
  groupOf,
  isSharedSource,
  type MirrorKind,
  type MirrorSource,
  type RecordOf,
  type SharedKind,
  type SharedSource,
} from "./lib/mirrorRules";
import { SHARED_CAPS, type SharedRecordOf } from "./lib/sharedRecords";
import { mirrorSourceValidator } from "./lib/mirrorValidators";
import { memberQuery, ownerMutation, ownerQuery } from "./lib/owner";
import { holderKey, holderOf, isHeldBy, personalStatus, type Holder } from "./lib/personal";
import { TURNED_OFF_MESSAGE, deleteRecords, markNotConfigured } from "./mirror";
import { SYNC_ACTIONS } from "./sources";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DOMAINS = 50;
const MAX_THREADS = 200;
const MAX_ISSUES = 1000;

const settingsRow = (ctx: QueryCtx) => ctx.db.query("workToolSettings").first();

async function readSettings(ctx: QueryCtx) {
  const row = await settingsRow(ctx);
  return {
    off: row?.off ?? [],
    investorDomains: row?.investorDomains ?? [],
    customerDomains: row?.customerDomains ?? [],
  };
}

async function writeSettings(
  ctx: MutationCtx,
  change: Partial<Awaited<ReturnType<typeof readSettings>>>,
) {
  const row = await settingsRow(ctx);
  if (row === null) {
    await ctx.db.insert("workToolSettings", {
      off: [],
      investorDomains: [],
      customerDomains: [],
      ...change,
    });
  } else {
    await ctx.db.patch(row._id, change);
  }
}

/** The deployment owner's rows: what the OS mirrors for itself, the shared Linear board among it. */
const SHARED: Holder = { kind: "owner" };

/**
 * How one holder's last read (or push) of a source went. Our own words and
 * timestamps only. The owner's is the deployment's `sourceStatus`; a
 * teammate's is their own row, so neither learns how the other's tools stand.
 */
async function stateOf(ctx: QueryCtx, holder: Holder, source: MirrorSource | SharedSource) {
  const status =
    // A shared list is the deployment's, whoever asks: it has no personal status.
    holder.kind === "owner" || isSharedSource(source)
      ? await ctx.db
          .query("sourceStatus")
          .withIndex("by_source", (q) => q.eq("source", source))
          .unique()
      : await personalStatus(ctx, holder, source);
  return {
    state: status?.state ?? null,
    message: status?.message ?? null,
    lastOkAt: status?.lastOkAt ?? null,
  };
}

/** One holder's records of one source. There is no way to ask for a source's rows across people. */
async function records<K extends MirrorKind>(
  ctx: QueryCtx,
  holder: Holder,
  source: MirrorSource,
  kind: K,
  order: "asc" | "desc",
  limit: number,
): Promise<RecordOf<K>[]> {
  const owner = holderKey(holder);
  const docs = await ctx.db
    .query("mirrorRecords")
    .withIndex("by_owner_and_source_and_sortAt", (q) => q.eq("owner", owner).eq("source", source))
    .order(order)
    .take(limit);
  return docs
    .filter((doc) => isHeldBy(holder, doc))
    .map((doc) => doc.record)
    .filter((r): r is RecordOf<K> => r.kind === kind);
}

/** More than a source's shared lists can hold together; a bound, not a target. */
const MAX_SHARED_ROWS = 500;

/**
 * Apollo's shared lists for the go-to-market page: its sequences, and its
 * contacts and accounts by stage, with when each list was last pushed.
 *
 * Not personal records, and not gated like them: the team's own labels and
 * counts, for anyone with the go-to-market area on Startup (Apollo is Startup's).
 * It reads the rows with no `owner` under the source "apollo" and no other
 * source's, so nobody's mail, calendar, issues or meeting notes can come back
 * from it; and the personal reads above name their own sources, so none of
 * this comes back from them.
 *
 * Before the first push both lists are empty with no `readAt`: the page says
 * "not read yet", never "none".
 */
export const outbound = memberQuery("gtm", "us")({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query("mirrorRecords")
      .withIndex("by_owner_and_source_and_sortAt", (q) =>
        q.eq("owner", holderKey(SHARED)).eq("source", "apollo"),
      )
      .order("desc")
      .take(MAX_SHARED_ROWS);
    // Every row of a list is stamped by each push of it (`touch`), so the
    // newest stamp among a kind's rows is when that list was last read.
    const readAt = (kind: SharedKind) => {
      const stamps = docs.filter((doc) => doc.record.kind === kind).map((doc) => doc.syncedAt);
      return stamps.length === 0 ? null : Math.max(...stamps);
    };
    const of = <K extends SharedKind>(kind: K) =>
      docs.map((doc) => doc.record).filter((r): r is SharedRecordOf<K> => r.kind === kind);

    const stages = of("stage_count")
      .map(({ kind: _kind, ...row }) => row)
      // Contacts before accounts, the fullest stage first, then by name.
      .sort(
        (a, b) =>
          Number(a.entity === "account") - Number(b.entity === "account") ||
          b.count - a.count ||
          a.stage.localeCompare(b.stage),
      );
    return {
      // Newest used first: the index's own order (a sequence never used sorts
      // by when it was made).
      sequences: {
        readAt: readAt("sequence"),
        rows: of("sequence").map(({ kind: _kind, ...row }) => row),
      },
      stages: { readAt: readAt("stage_count"), rows: stages },
      lastOkAt: (await stateOf(ctx, SHARED, "apollo")).lastOkAt,
    };
  },
});

/** GitHub's two lists together: every repository and every pull request it may hold. */
const MAX_GITHUB_ROWS = SHARED_CAPS.repo + SHARED_CAPS.pull_request;

/**
 * One of GitHub's lists, for the companies the caller is on, and when that
 * list was last pushed. The rows with no `owner` under the source "github"
 * and no other source's; of those, the one kind asked for.
 *
 * A repository and a pull request each belong to one company (decided by the
 * script that gathers them), and a caller is sent only the rows of the
 * companies they are on: the gate knows the area, the filter here keeps the
 * rows. `readAt` is the list's, whoever's rows it holds.
 */
export async function githubList<K extends "repo" | "pull_request">(
  ctx: QueryCtx,
  kind: K,
  companies: readonly CompanyId[],
) {
  const docs = await ctx.db
    .query("mirrorRecords")
    .withIndex("by_owner_and_source_and_sortAt", (q) =>
      q.eq("owner", holderKey(SHARED)).eq("source", "github"),
    )
    // Newest first: the index's own order (a repository's last push, a pull
    // request's last activity).
    .order("desc")
    .take(MAX_GITHUB_ROWS);
  const own = docs.filter((doc) => doc.record.kind === kind);
  const rows: SharedRecordOf<"repo" | "pull_request">[] = [];
  for (const { record } of own) {
    if (record.kind !== "repo" && record.kind !== "pull_request") continue;
    // The company rule: a row of a company the caller is not on is never sent.
    if (companies.includes(record.company)) rows.push(record);
  }
  return {
    // Every row is stamped by each push of its list (`touch`), so the newest
    // stamp among a kind's rows is when that list was last read.
    readAt: own.length === 0 ? null : Math.max(...own.map((doc) => doc.syncedAt)),
    rows: rows.filter((row): row is SharedRecordOf<K> => row.kind === kind),
  };
}

/**
 * GitHub's repositories for the Engineering page: each tracked repository's
 * counts and its main branch's build, and when the list was last pushed.
 *
 * The team's, like Apollo's lists above, for anyone with the engineering
 * area, and only the repositories of the companies they are on. A row is a
 * name and counts. Before the first push there are no rows and no `readAt`:
 * the page says "not read yet", never "none".
 */
export async function repositoriesFor(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const { readAt, rows } = await githubList(ctx, "repo", companies);
  return { readAt, rows: rows.map(({ kind: _kind, ...row }) => row) };
}

export const engineering = memberQuery("engineering")({
  args: {},
  handler: (ctx) => repositoriesFor(ctx, ctx.member.companies),
});

/**
 * GitHub's pull requests for the Engineering page: the open ones, and those
 * merged or closed lately, newest activity first, with when the list was
 * last pushed.
 *
 * The one read that returns a pull request's title and the people on it (who
 * opened it, who is asked to review). The owner decided they are shown, to
 * people with the engineering area, for the companies they are on: a
 * teammate on Globex alone is never sent a Startup pull request, and the
 * other way round. Nothing else of a pull request is stored to be returned:
 * no description, comment, file, branch or commit.
 *
 * No clock is read here: which stage a pull request is in and whether it is
 * stuck depend on "now", and are worked out in the browser
 * (src/lib/engineering/flow.ts).
 */
export async function pullRequestsFor(ctx: QueryCtx, companies: readonly CompanyId[]) {
  const { readAt, rows } = await githubList(ctx, "pull_request", companies);
  return { readAt, rows: rows.map(({ kind: _kind, ...row }) => row) };
}

export const pullRequests = memberQuery("engineering")({
  args: {},
  handler: (ctx) => pullRequestsFor(ctx, ctx.member.companies),
});

/**
 * The titles of the shared Linear board's open issues, each with its team's
 * company, newest first: for the standup's "what is already there" read
 * (convex/standup.ts). Rows with no `owner` only, and nothing but a title:
 * no assignee, no id, no link. One row more than `limit` is asked for, so the
 * caller can say the list was cut.
 */
export async function sharedOpenIssueTitles(
  ctx: QueryCtx,
  limit: number,
): Promise<{ titles: { title: string; company: CompanyId | null }[]; truncated: boolean }> {
  const all = await records(ctx, SHARED, "linear", "issue", "desc", limit + 1);
  return {
    titles: all
      .slice(0, limit)
      .filter((issue) => issue.stateType !== "completed")
      .map((issue) => ({ title: issue.title, company: companyOfLinearTeam(issue.teamName) })),
    truncated: all.length > limit,
  };
}

/** Whether the owner switched a source off. Asked by runMirror before every read. */
export const isOff = internalQuery({
  args: { source: mirrorSourceValidator },
  handler: async (ctx, { source }) => (await readSettings(ctx)).off.includes(source),
});

export const settings = ownerQuery({
  args: {},
  handler: async (ctx) => readSettings(ctx),
});

/** The owner's own typing, cut short, for an error that quotes it back. */
const quoted = (value: string) => value.trim().slice(0, 80);

function cleanList(lines: string[]): string[] {
  const domains = new Set<string>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const domain = cleanDomain(line);
    if (domain === null) {
      throw new ConvexError(
        `"${quoted(line)}" is not a domain. Write it like "example.com".`,
      );
    }
    domains.add(domain);
    if (domains.size > MAX_DOMAINS) throw new ConvexError("Keep each list to 50 domains.");
  }
  return [...domains];
}

export const setDomains = ownerMutation({
  args: { investor: v.array(v.string()), customer: v.array(v.string()) },
  handler: async (ctx, args) => {
    await writeSettings(ctx, {
      investorDomains: cleanList(args.investor),
      customerDomains: cleanList(args.customer),
    });
    return null;
  },
});

/** Stop reading a source and delete what was stored from it. */
export const turnOff = ownerMutation({
  args: { source: mirrorSourceValidator },
  handler: async (ctx, { source }) => {
    const { off } = await readSettings(ctx);
    if (!off.includes(source)) await writeSettings(ctx, { off: [...off, source] });
    await deleteRecords(ctx, source);
    await markNotConfigured(ctx, source, TURNED_OFF_MESSAGE, { forget: true });
    return null;
  },
});

/** Read a source again, starting now. */
export const turnOn = ownerMutation({
  args: { source: mirrorSourceValidator },
  handler: async (ctx, { source }) => {
    const { off } = await readSettings(ctx);
    await writeSettings(ctx, { off: off.filter((id) => id !== source) });
    const sync = SYNC_ACTIONS[source];
    if (sync) await ctx.scheduler.runAfter(0, sync, {});
    return null;
  },
});

/** The domain lists are the owner's own sorting of the owner's mail. A teammate has none. */
const NO_LISTS = { investorDomains: [], customerDomains: [] };

/**
 * The caller's own inbox threads waiting on them, oldest first. The owner's
 * are grouped by the owner's lists; a teammate's are all "other".
 */
export const needsReply = memberQuery("today")({
  args: {},
  handler: async (ctx) => {
    const holder = holderOf(ctx.member);
    const lists = holder.kind === "owner" ? await readSettings(ctx) : NO_LISTS;
    const threads = await records(ctx, holder, "gmail", "mail", "asc", MAX_THREADS);
    return {
      source: await stateOf(ctx, holder, "gmail"),
      threads: threads.map((thread) => ({
        ...thread,
        group: groupOf(thread.fromAddress, lists),
      })),
    };
  },
});

/** The caller's own meetings in a span of time. */
export const events = memberQuery("today")({
  // Instants chosen by the browser (its local days). The query has no clock.
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const holder = holderOf(ctx.member);
    const owner = holderKey(holder);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      throw new ConvexError("That is not a span of time.");
    }
    if (to - from > 10 * DAY_MS) throw new ConvexError("Ask for at most ten days of meetings.");
    // An event that began up to a day before `from` may still be running.
    const docs = await ctx.db
      .query("mirrorRecords")
      .withIndex("by_owner_and_source_and_sortAt", (q) =>
        q
          .eq("owner", owner)
          .eq("source", "google_calendar")
          .gte("sortAt", from - DAY_MS)
          .lt("sortAt", to),
      )
      .take(500);
    return {
      source: await stateOf(ctx, holder, "google_calendar"),
      events: docs
        .filter((doc) => isHeldBy(holder, doc))
        .map((doc) => doc.record)
        .filter((r): r is RecordOf<"event"> => r.kind === "event" && r.endsAt > from),
    };
  },
});

/**
 * Linear's issues for the board, newest first: the shared mirror, which is
 * the rows with no `owner`. A teammate's own pushed issues are theirs alone
 * and are never on it.
 */
export const issues = memberQuery("board")({
  args: {},
  handler: async (ctx) => ({
    source: await stateOf(ctx, SHARED, "linear"),
    // A teammate on one company is not sent the other company's team's issues.
    issues: (await records(ctx, SHARED, "linear", "issue", "desc", MAX_ISSUES)).filter((issue) =>
      linearTeamServes(ctx.member.companies, issue.teamName),
    ),
  }),
});

/**
 * The caller's own Linear issues, newest first: for the owner the shared
 * mirror's issues flagged as theirs; for a teammate the issues they pushed
 * themselves, and nothing from the shared board.
 */
export const myIssues = memberQuery("today")({
  args: {},
  handler: async (ctx) => {
    const holder = holderOf(ctx.member);
    const all = await records(ctx, holder, "linear", "issue", "desc", MAX_ISSUES);
    return {
      source: await stateOf(ctx, holder, "linear"),
      issues: holder.kind === "owner" ? all.filter((issue) => issue.mine) : all,
    };
  },
});

/** The caller's own recent meeting notes, newest first. */
export const meetings = memberQuery("today")({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const holder = holderOf(ctx.member);
    return {
      source: await stateOf(ctx, holder, "fireflies"),
      meetings: await records(ctx, holder, "fireflies", "meeting", "desc", clampLimit(limit, 10, 50)),
    };
  },
});

// ── Company memory's import (the owner's alone) ──────────────────────────────
// The owner may start a meeting's notes on /memory from one of his own
// Fireflies meetings. These read the deployment owner's rows only (`SHARED`
// is that holder: rows with no `owner`), never a teammate's, and send the
// title, the date, the summary and the action items: never the participants
// and never a transcript (none is stored). Nothing is written: the page puts
// it in a new draft, and only the owner's save keeps it.

/** The owner's recent Fireflies meetings, as a title and when, newest first. */
export const importableMeetings = ownerQuery({
  args: {},
  handler: async (ctx) =>
    (await records(ctx, SHARED, "fireflies", "meeting", "desc", IMPORTABLE_MEETINGS)).map((meeting) => ({
      meetingId: meeting.meetingId,
      title: meeting.title,
      heldAt: meeting.heldAt,
    })),
});

/** One of the owner's Fireflies meetings, as a draft of meeting notes. */
export const meetingToImport = ownerQuery({
  args: { meetingId: v.string() },
  handler: async (ctx, args) => {
    const meeting = (await records(ctx, SHARED, "fireflies", "meeting", "desc", 200)).find(
      (one) => one.meetingId === args.meetingId,
    );
    if (meeting === undefined) throw new ConvexError(MEMORY_WORDS.importGone);
    return {
      title: meeting.title,
      // The UTC day it was held; the owner can change it before saving.
      heldOn: new Date(meeting.heldAt).toISOString().slice(0, 10),
      notes: meeting.overview,
      actionItems: meeting.actionItems,
    };
  },
});
