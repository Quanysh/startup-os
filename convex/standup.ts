// The daily standup's tasks. A Claude session reads the day's standup in
// Fireflies (summary and action items, never a transcript), decides what the
// team took on, and sends what the board does not hold yet. The understanding
// happens there; this file stores, validates and drops what is already here.
//
// Two routes, both on the standup's own bearer token (INGEST_TOKEN_STANDUP),
// both apart from POST /ingest/v1 and its envelope:
//
//   GET  /standup/v1/open    what the board and Linear already hold, so the
//                            session can tell what is missing. THIS IS A READ
//                            OF COMPANY DATA BY A BEARER TOKEN, the only one
//                            the OS has, so it is kept to titles: no note, no
//                            assignee, no id, no person, and never a
//                            teammate's own (personal) Linear rows.
//   POST /standup/v1/tasks   the missing tasks, into Backlog.
//
// What a meeting said is company data and may name people. So no title,
// context, name or address is ever logged, thrown, put in the run log or sent
// back: a reply is counts, an error name, and paths with fixed words.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { SOURCES, ingestToken } from "./connectors/manifest";
import { companyIds, type CompanyId } from "./lib/company";
import { secretsEqual } from "./lib/constantTime";
import { cleanAddress } from "./lib/mirrorRules";
import {
  MAX_DONE_LISTED,
  MAX_LINEAR_LISTED,
  MAX_OPEN_LISTED,
  MAX_STANDUP_BYTES,
  MAX_STANDUP_TASKS_PER_DAY,
  RECENT_DONE_DAYS,
  SHARED_COMPANY,
  STANDUP_SOURCE,
  TOO_MANY_TODAY,
  TOO_MANY_TODAY_WORDS,
  normalTitle,
  parseStandupPush,
  sameScope,
  standupNotes,
  utcDay,
  type StandupIssue,
} from "./lib/standup";
import { classifyCompany, matchPerson, type CompanyEntity, type NamedPerson } from "./lib/standupMapping";
import { nameOf, teamDirectory } from "./lib/teamDirectory";
import { companyValidator, taskKindValidator } from "./schema";
import { setSourceStatus } from "./snapshots";
import { createTask, nearTasks, reachable } from "./tasks";
import { githubList, sharedOpenIssueTitles } from "./workTools";

/** Everyone a card can be given to, with the name they signed in with: what a said name is matched against. */
async function namedPeople(ctx: QueryCtx): Promise<NamedPerson[]> {
  const people: NamedPerson[] = [];
  for (const person of (await teamDirectory(ctx.db)).values()) {
    people.push({ ...person, name: await nameOf(ctx.db, person.email) });
  }
  return people;
}

/**
 * The names that tell a company: clinics (customers), deals and GitHub's
 * repositories, each with its company. Read only to place a card; none is
 * written anywhere.
 */
async function companyEntities(ctx: QueryCtx): Promise<CompanyEntity[]> {
  const entities: CompanyEntity[] = [];
  for (const row of await ctx.db.query("customers").collect()) {
    if (row.archivedAt === undefined) entities.push({ name: row.name, company: row.market });
  }
  for (const row of await ctx.db.query("deals").collect()) {
    if (row.archivedAt === undefined) entities.push({ name: row.name, company: row.market });
  }
  for (const row of (await githubList(ctx, "repo", companyIds())).rows) {
    entities.push({ name: row.name, company: row.company });
  }
  return entities;
}

/**
 * The company of a card the session left unclear: what its words name, else
 * the one company of the person it is for; null when neither tells.
 */
function placeOf(
  text: string,
  entities: readonly CompanyEntity[],
  person: NamedPerson | undefined,
): CompanyId | null {
  const said = classifyCompany(text, entities);
  if (said !== null) return said;
  return person !== undefined && person.companies.length === 1 ? person.companies[0]! : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_COLUMNS = ["backlog", "this_week", "doing"] as const;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Null when the request carries the standup's token; the refusal otherwise.
 * As POST /ingest/v1 does it: 503 while the token is unset (or too short to
 * be a secret), then every configured source's token is compared in constant
 * time with no early exit, and one that two sources share authenticates
 * neither. Every refusal for a bad token is the same 401, decided before
 * anything of the request but its Authorization header is read.
 */
async function refusal(request: Request): Promise<Response | null> {
  if (ingestToken(STANDUP_SOURCE) === undefined) {
    return json(503, { ok: false, error: "ingest_not_configured" });
  }
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const matches: string[] = [];
  for (const source of SOURCES) {
    const token =
      source.kind === "ingest" || source.pushable === true ? ingestToken(source.id) : undefined;
    if (token !== undefined && (await secretsEqual(given, token))) matches.push(source.id);
  }
  return matches.length === 1 && matches[0] === STANDUP_SOURCE
    ? null
    : json(401, { ok: false, error: "unauthorized" });
}

/** GET /standup/v1/open — titles the board and the shared Linear mirror already hold. */
export const openV1 = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== null) return refused;
  try {
    // A query never reads the clock; the action reads it and hands it over.
    const held = await ctx.runQuery(internal.standup.open, { now: Date.now() });
    return json(200, { ok: true, ...held });
  } catch {
    return json(500, { ok: false, error: "read_failed" });
  }
});

/**
 * What is already there, as little of it as tells a duplicate: open cards
 * (title, company, column), cards finished in the last 14 days (title,
 * company), and the open issues of the shared Linear mirror (title, the
 * team's company). Each list is capped, and `truncated` says when one was cut.
 */
export const open = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    let truncated = false;

    const openCards: { title: string; company: CompanyId | null; column: string }[] = [];
    for (const column of OPEN_COLUMNS) {
      const room = MAX_OPEN_LISTED - openCards.length;
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_column_and_order", (q) => q.eq("column", column))
        .take(room + 1);
      if (rows.length > room) truncated = true;
      for (const row of rows.slice(0, room)) {
        if (row.archivedAt !== undefined) continue;
        openCards.push({ title: row.title, company: row.company ?? null, column });
      }
    }

    const finished = await ctx.db
      .query("tasks")
      .withIndex("by_column_and_doneAt", (q) =>
        q.eq("column", "done").gte("doneAt", now - RECENT_DONE_DAYS * DAY_MS),
      )
      .order("desc")
      .take(MAX_DONE_LISTED + 1);
    if (finished.length > MAX_DONE_LISTED) truncated = true;

    const linear = await sharedOpenIssueTitles(ctx, MAX_LINEAR_LISTED);
    if (linear.truncated) truncated = true;

    return {
      open: openCards,
      done: finished
        .filter((row) => row.archivedAt === undefined)
        .slice(0, MAX_DONE_LISTED)
        .map((row) => ({ title: row.title, company: row.company ?? null })),
      linear: linear.titles,
      truncated,
    };
  },
});

/**
 * POST /standup/v1/tasks — the tasks of one standup that the board was missing.
 *
 * Before the token is accepted a request changes nothing and is logged
 * nowhere. After it, every refusal is logged against the source in an error
 * name, a path and fixed words, so a push that "ran green" on the sender's
 * side but was refused here shows on Settings → Sources.
 */
export const tasksV1 = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== null) return refused;
  const startedAt = Date.now();

  const reject = async (status: number, error: string, issues: StandupIssue[] = []) => {
    const first = issues[0];
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    await ctx.runMutation(internal.snapshots.recordFailure, {
      source: STANDUP_SOURCE,
      startedAt,
      status: "error",
      message: first ? `${error}: ${first.path} — ${first.message}${more}` : error,
    });
    return json(status, { ok: false, error, issues });
  };

  // Refuse on the declared size before reading anything, then measure what
  // was actually read, since Content-Length can be wrong or absent.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_STANDUP_BYTES) {
    return reject(413, "payload_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_STANDUP_BYTES) {
    return reject(413, "payload_too_large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject(400, "invalid_json");
  }

  const parsed = parseStandupPush(raw, { now: startedAt });
  if (!parsed.ok) return reject(422, "invalid_push", parsed.issues);
  const { meetingId, meetingDate, tasks } = parsed.push;

  let result;
  try {
    result = await ctx.runMutation(internal.standup.apply, {
      meetingId,
      meetingDate,
      tasks,
      startedAt,
    });
  } catch {
    // Not the error's own words: nothing thrown while tasks are in hand is logged.
    return reject(500, "write_failed");
  }
  if (!result.ok) {
    return reject(429, TOO_MANY_TODAY, [{ path: "tasks", message: TOO_MANY_TODAY_WORDS }]);
  }
  const { ok: _ok, ...counts } = result;
  return json(200, { ok: true, ...counts });
});

/**
 * The one writer of standup tasks. For each item, in order:
 *
 *   known      its meeting and key were taken before: skipped, silently. This
 *              is what makes a push safe to send again, and why a card the
 *              team deleted is not made again.
 *   duplicate  its title, normalised, is that of an open card or one finished
 *              in the last 14 days, of the same company or shared: skipped.
 *              The session's own check comes first; this is the backstop.
 *   nearDuplicate  near an open card of the same company or shared, by the
 *              shared near-duplicate check (`nearTasks`): skipped.
 *   added      to the bottom of Backlog, where `tasks.create` puts a new card.
 *
 * An item is remembered whichever of the last two it was, and both count
 * toward the day's limit. A push that would pass the limit is refused whole.
 *
 * An assignee is kept only where the board's own rule lets a task go to
 * them (`reachable`: the owner or a current teammate, on the task's company,
 * holding the board). Otherwise the task is added with nobody on it: a push
 * is never refused for a person the OS does not know, and the address is
 * never said. Every card is made by `createTask`, the board's one writer.
 */
export const apply = internalMutation({
  args: {
    meetingId: v.string(),
    meetingDate: v.string(),
    startedAt: v.number(),
    tasks: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        company: v.union(companyValidator, v.literal(SHARED_COMPANY), v.null()),
        kind: taskKindValidator,
        assignee: v.optional(v.string()),
        due: v.optional(v.string()),
        context: v.optional(v.string()),
        named: v.optional(v.string()),
        speaker: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const day = utcDay(now);

    const fresh = [];
    let known = 0;
    for (const task of args.tasks) {
      const seen = await ctx.db
        .query("standupItems")
        .withIndex("by_meetingId_and_key", (q) =>
          q.eq("meetingId", args.meetingId).eq("key", task.key),
        )
        .first();
      if (seen === null) fresh.push(task);
      else known += 1;
    }

    if (fresh.length > 0) {
      const today = await ctx.db
        .query("standupItems")
        .withIndex("by_day", (q) => q.eq("day", day))
        .take(MAX_STANDUP_TASKS_PER_DAY + 1);
      if (today.length + fresh.length > MAX_STANDUP_TASKS_PER_DAY) {
        return { ok: false as const };
      }
    }

    // What the board already holds: open cards, and those finished lately.
    const held: { key: string; company: CompanyId | undefined }[] = [];
    for (const column of OPEN_COLUMNS) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_column_and_order", (q) => q.eq("column", column))
        .collect();
      for (const row of rows) {
        if (row.archivedAt !== undefined) continue;
        held.push({ key: normalTitle(row.title), company: row.company });
      }
    }
    const finished = await ctx.db
      .query("tasks")
      .withIndex("by_column_and_doneAt", (q) =>
        q.eq("column", "done").gte("doneAt", now - RECENT_DONE_DAYS * DAY_MS),
      )
      .collect();
    for (const row of finished) {
      if (row.archivedAt !== undefined) continue;
      held.push({ key: normalTitle(row.title), company: row.company });
    }

    const people = fresh.some(
      (task) => task.assignee !== undefined || task.named !== undefined || task.speaker !== undefined || task.company === null,
    )
      ? await namedPeople(ctx)
      : [];
    const byAddress = new Map(people.map((person) => [person.email, person]));
    const entities = fresh.some((task) => task.company === null) ? await companyEntities(ctx) : [];

    let added = 0;
    let duplicate = 0;
    let nearDuplicate = 0;
    let unassigned = 0;
    for (const task of fresh) {
      await ctx.db.insert("standupItems", {
        meetingId: args.meetingId,
        key: task.key,
        day,
        acceptedAt: now,
      });

      // Who it is for: the address the session gave, else the person the
      // item names, else whoever said it of themselves. A name is matched to
      // `people` and kept nowhere.
      const asked =
        task.assignee !== undefined ||
        task.named !== undefined ||
        task.speaker !== undefined;
      const email =
        (task.assignee === undefined ? undefined : byAddress.get(cleanAddress(task.assignee))?.email) ??
        matchPerson(task.named, people) ??
        matchPerson(task.speaker, people) ??
        undefined;
      const person = email === undefined ? undefined : byAddress.get(email);

      // Which company: the session's, or (when it left it unclear) what the
      // card's words name; a card nothing places is shared and flagged.
      let company: CompanyId | undefined;
      let needsCompany = false;
      if (task.company === SHARED_COMPANY) company = undefined;
      else if (task.company !== null) company = task.company;
      else {
        company = placeOf(`${task.title} ${task.context ?? ""}`, entities, person) ?? undefined;
        needsCompany = company === undefined;
      }

      const key = normalTitle(task.title);
      if (key !== "" && held.some((card) => card.key === key && sameScope(card.company, company))) {
        duplicate += 1;
        continue;
      }
      // Near an open card (convex/lib/duplicates.ts), not the same words: skipped too, counted apart.
      if ((await nearTasks(ctx, null, { title: task.title, company: company ?? null, now })).length > 0) {
        nearDuplicate += 1;
        continue;
      }

      // Kept only where the board's own rule lets a task go to them
      // (`reachable`: on the company, with the board); otherwise the card is
      // added with nobody on it, and the address is never said.
      const assignee =
        person === undefined ? null : ((await reachable(ctx, null, person.email, company))?.email ?? null);
      if (assignee === null && asked) unassigned += 1;

      // The board's one writer, at the bottom of Backlog. Whoever it was
      // given to is told, by "the standup": no person sent it, so no Telegram
      // group is told (there is no assigner to name).
      await createTask(
        ctx,
        null,
        {
          title: task.title,
          kind: task.kind,
          column: "backlog",
          notes: standupNotes(args.meetingDate, task.context),
          ...(task.due === undefined ? null : { due: task.due }),
          assignee,
          company: company ?? null,
        },
        {
          origin: { source: STANDUP_SOURCE, meetingDate: args.meetingDate, meetingId: args.meetingId },
          actor: { type: "system", source: "standup" },
          needsCompany,
        },
      );
      added += 1;
      // The same task said twice in one standup is added once.
      held.push({ key, company });
    }

    // Counts only. The date is this codebase's own check of the sender's.
    await ctx.db.insert("syncRuns", {
      source: STANDUP_SOURCE,
      batchId: `${STANDUP_SOURCE}-${args.meetingDate}`,
      startedAt: args.startedAt,
      finishedAt: now,
      status: "ok",
      inserted: added,
      updated: 0,
      unchanged: known + duplicate + nearDuplicate,
    });
    await setSourceStatus(ctx, STANDUP_SOURCE, { state: "ok", at: now });

    return { ok: true as const, added, known, duplicate, nearDuplicate, unassigned };
  },
});

/**
 * Place one meeting's cards again: each open card the standup made from it
 * that has no company and is not flagged (as the import before placing left
 * them) gets the company its words name, or the flag. Run by the owner
 * (`npx convex run standup:placeMeeting '{"meetingId": "…"}'`); counts only.
 * A card someone gave a company, and every card typed on the board, is left
 * alone.
 */
export const placeMeeting = internalMutation({
  args: { meetingId: v.string() },
  handler: async (ctx, { meetingId }) => {
    const entities = await companyEntities(ctx);
    const people = await namedPeople(ctx);
    const byAddress = new Map(people.map((person) => [person.email, person]));
    let placed = 0;
    let flagged = 0;
    for (const column of OPEN_COLUMNS) {
      const rows: Doc<"tasks">[] = await ctx.db
        .query("tasks")
        .withIndex("by_column_and_order", (q) => q.eq("column", column))
        .collect();
      for (const row of rows) {
        if (row.archivedAt !== undefined) continue;
        if (row.origin?.source !== STANDUP_SOURCE || row.origin.meetingId !== meetingId) continue;
        if (row.company !== undefined || row.needsCompany === true) continue;
        const person = row.assignee === undefined ? undefined : byAddress.get(row.assignee);
        const company = placeOf(`${row.title} ${row.notes ?? ""}`, entities, person);
        if (company === null) {
          await ctx.db.patch(row._id, { needsCompany: true });
          flagged += 1;
        } else {
          await ctx.db.patch(row._id, { company });
          placed += 1;
        }
      }
    }
    return { placed, flagged };
  },
});
