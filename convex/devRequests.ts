// A bot asks for a fix (`dev_request`; docs/assistant.md, "Asking for a fix").
//
// The tool stores a request (`fileDevRequest`, in the tool's own transaction)
// and, when `GITHUB_ISSUES_TOKEN` is set, schedules `file`, which opens an
// issue labelled `bot-request` in your-org/your-os. A Claude routine
// outside this repository answers each issue with a comment whose first line
// is a decision marker; every 10 minutes `check` (convex/crons.ts) reads the
// open ones back, oldest check first, and each change reaches the bot in
// `my_inbox` (`devRequestsSince`). `check` also files a request still
// waiting, so one made while the token was unset is filed once it is set.
//
// What leaves for GitHub is the bot's text, fenced and neutralised
// (convex/lib/devRequests.ts); what comes back is one cleaned paragraph, a
// pull request's number and the issue's state. Nothing GitHub sends is logged
// or thrown: a failure is a status code at most, and it is not written down.
// The token is read inside the actions only, never stored, logged or returned.

import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { STARTUP_OS_TOOL_AREAS } from "./lib/agentStartupOs";
import { cleanLine, cleanLines } from "./lib/agentText";
import { BOT_REFUSAL_CODES, CALLER_TOOLS, rateLimited, type BotRefusalCode } from "./lib/botRules";
import { looksLikeContactDetail } from "./lib/dealDetails";
import {
  CHECKED_DEV_STATUSES,
  DEV_API,
  DEV_CHECKS_PER_RUN,
  DEV_FILINGS_PER_RUN,
  DEV_FILING_LEASE_MS,
  DEV_LABEL,
  DEV_REQUESTS_PER_DAY,
  DEV_REQUEST_ROWS,
  DEV_REQUEST_SIMILAR,
  DEV_REQUEST_WORDS,
  MAX_DEV_EXPECTED,
  MAX_DEV_PROBLEM,
  MAX_DEV_TITLE,
  OPEN_DEV_STATUSES,
  changed,
  commentsShape,
  devLimitWords,
  issueBodyOf,
  issueShape,
  issueTitleOf,
  issueUrlOf,
  looksLikeSecret,
  nextState,
  normalDevTitle,
  pullShape,
  type DevState,
} from "./lib/devRequests";
import { titleSimilarity } from "./lib/duplicates";
import { utcDayStart } from "./lib/handoffs";
import { PRODUCT } from "./lib/identity";
import { ownerQuery } from "./lib/owner";

type Row = Doc<"devRequests">;
const DAY_MS = 24 * 60 * 60 * 1000;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};
/** A refusal carried with its code to the endpoint's `structuredContent` (convex/mcp.ts, `CODED_REFUSALS`). */
const refuseCoded = (words: string, refusal: ReturnType<typeof rateLimited> | { code: "contact_detail" | "repeat" }): never => {
  throw new ConvexError({ words, refusal });
};

/** Whether a name is one of the registry's tools a bot could have been using. */
const isKnownTool = (name: string) => Object.hasOwn(STARTUP_OS_TOOL_AREAS, name) || CALLER_TOOLS.includes(name);

export type DevRequestInput = {
  title: string;
  problem: string;
  expected: string;
  tool?: string | undefined;
  refusalCode?: BotRefusalCode | undefined;
};

/** One field, cleaned: a line or several, within its limit, not empty, no contact detail and no secret. */
function cleanField(value: string, max: number, many: boolean): string {
  if (value.trim().length > max) return refuse(DEV_REQUEST_WORDS.tooLong);
  const text = many ? cleanLines(value, max) : cleanLine(value, max);
  if (text === null) return refuse(DEV_REQUEST_WORDS.tooLong);
  if (text === "") return refuse(DEV_REQUEST_WORDS.empty);
  if (looksLikeContactDetail(text)) return refuseCoded(DEV_REQUEST_WORDS.contact, { code: "contact_detail" });
  if (looksLikeSecret(text)) return refuse(DEV_REQUEST_WORDS.secret);
  return text;
}

/** A bot's requests that are still open (`OPEN_DEV_STATUSES`), newest first, bounded. */
async function openOf(ctx: QueryCtx, bot: string): Promise<Row[]> {
  const recent = await ctx.db
    .query("devRequests")
    .withIndex("by_bot_and_createdAt", (q) => q.eq("bot", bot))
    .order("desc")
    .take(DEV_REQUEST_ROWS * 2);
  return recent.filter((row) => OPEN_DEV_STATUSES.includes(row.status));
}

/** Whether filing is switched on: the token is set. Read here, never stored. */
const githubToken = (): string | null => {
  const token = (process.env.GITHUB_ISSUES_TOKEN ?? "").trim();
  return token === "" ? null : token;
};

/**
 * Stores a bot's request, for `dev_request`: checked, limited to five a bot a
 * UTC day, refused as a repeat of one of the bot's own open requests, and
 * scheduled for filing when the token is set. `bot` is the endpoint's matched
 * profile, never an argument.
 */
export async function fileDevRequest(
  ctx: MutationCtx,
  call: { bot: string; client: string; now: number },
  input: DevRequestInput,
): Promise<{ id: Id<"devRequests">; status: "filed" }> {
  const title = cleanField(input.title, MAX_DEV_TITLE, false);
  const problem = cleanField(input.problem, MAX_DEV_PROBLEM, true);
  const expected = cleanField(input.expected, MAX_DEV_EXPECTED, true);
  if (input.tool !== undefined && !isKnownTool(input.tool)) refuse(DEV_REQUEST_WORDS.unknownTool);
  if (input.refusalCode !== undefined && !(BOT_REFUSAL_CODES as readonly string[]).includes(input.refusalCode)) {
    refuse(DEV_REQUEST_WORDS.unknownTool);
  }

  const dayStart = utcDayStart(call.now);
  const today = await ctx.db
    .query("devRequests")
    .withIndex("by_bot_and_createdAt", (q) => q.eq("bot", call.bot).gte("createdAt", dayStart))
    .take(DEV_REQUESTS_PER_DAY);
  if (today.length >= DEV_REQUESTS_PER_DAY) {
    refuseCoded(devLimitWords(DEV_REQUESTS_PER_DAY), rateLimited("dev_requests", DEV_REQUESTS_PER_DAY, dayStart + DAY_MS));
  }

  const key = normalDevTitle(title);
  const near = (await openOf(ctx, call.bot)).some(
    (row) => normalDevTitle(row.title) === key || titleSimilarity(row.title, title) >= DEV_REQUEST_SIMILAR,
  );
  if (near) refuseCoded(DEV_REQUEST_WORDS.repeat, { code: "repeat" });

  const id = await ctx.db.insert("devRequests", {
    bot: call.bot,
    client: call.client,
    title,
    problem,
    expected,
    ...(input.tool === undefined ? null : { tool: input.tool }),
    ...(input.refusalCode === undefined ? null : { refusalCode: input.refusalCode }),
    status: "filed",
    createdAt: call.now,
    updatedAt: call.now,
    lastCheckedAt: 0,
  });
  if (githubToken() !== null) await ctx.scheduler.runAfter(0, internal.devRequests.file, { id });
  return { id, status: "filed" };
}

/** A request as the bot is told of it: no problem text, no client. */
function inboxShape(row: Row) {
  return {
    id: row._id,
    title: row.title,
    status: row.status,
    decision: row.decisionText ?? null,
    ...(row.prUrl === undefined ? null : { prUrl: row.prUrl }),
    ...(row.issueNumber === undefined ? null : { issueUrl: issueUrlOf(row.issueNumber) }),
  };
}

/** A bot's requests that changed since its cursor, oldest change first: `my_inbox`'s `dev_requests`. */
export async function devRequestsSince(ctx: QueryCtx, bot: string, since: number) {
  const rows = await ctx.db
    .query("devRequests")
    .withIndex("by_bot_and_updatedAt", (q) => q.eq("bot", bot).gte("updatedAt", since))
    .take(DEV_REQUEST_ROWS);
  return rows.map(inboxShape);
}

// ── Talking to GitHub ───────────────────────────────────────────────────────

/** How long one request may take. */
const GITHUB_TIMEOUT_MS = 15_000;
/** How long one run of `check` may spend before it leaves the rest for the next. */
const RUN_BUDGET_MS = 3 * 60 * 1000;

type Answer = { status: number; body: unknown } | { status: "unreachable" };

/**
 * One request to the repository's API: a deadline, no redirects, the token
 * in a header. Answers the status and the parsed body; nothing it sends or
 * receives is logged, and a failure to reach GitHub is a status of its own.
 */
async function github(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEV_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": PRODUCT.slug,
        ...(body === undefined ? null : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? null : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return { status: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** An answer GitHub will give again: the request or the issue is wrong for good. */
const settledRefusal = (answer: Answer) => answer.status === 400 || answer.status === 404 || answer.status === 410 || answer.status === 422;

/**
 * Takes a request for filing: still `filed` and not taken in the last five
 * minutes. Marks it taken (`lastCheckedAt`) and hands back what the issue
 * needs; null when it is not to be filed now.
 */
export const claimFiling = internalMutation({
  args: { id: v.id("devRequests"), now: v.number() },
  handler: async (ctx, { id, now }) => {
    const row = await ctx.db.get(id);
    if (row === null || row.status !== "filed" || now - row.lastCheckedAt < DEV_FILING_LEASE_MS) return null;
    await ctx.db.patch(id, { lastCheckedAt: now });
    return {
      bot: row.bot,
      title: row.title,
      problem: row.problem,
      expected: row.expected,
      ...(row.tool === undefined ? null : { tool: row.tool }),
      ...(row.refusalCode === undefined ? null : { refusalCode: row.refusalCode }),
    };
  },
});

/** The issue was opened: its number, and the bot hears it is open. */
export const recordFiled = internalMutation({
  args: { id: v.id("devRequests"), issueNumber: v.number(), now: v.number() },
  handler: async (ctx, { id, issueNumber, now }) => {
    const row = await ctx.db.get(id);
    if (row === null || row.status !== "filed") return;
    await ctx.db.patch(id, { status: "issue_open", issueNumber, updatedAt: now, lastCheckedAt: now });
  },
});

/** GitHub refused it for good (or the issue is gone): the request failed. */
export const recordFailed = internalMutation({
  args: { id: v.id("devRequests"), now: v.number() },
  handler: async (ctx, { id, now }) => {
    const row = await ctx.db.get(id);
    if (row === null || !OPEN_DEV_STATUSES.includes(row.status)) return;
    await ctx.db.patch(id, { status: "failed", updatedAt: now, lastCheckedAt: now });
  },
});

/** Opens the issue for one request. Does nothing without the token or when another run has it. */
async function fileOne(ctx: ActionCtx, token: string, id: Id<"devRequests">) {
  const now = Date.now();
  const claimed = await ctx.runMutation(internal.devRequests.claimFiling, { id, now });
  if (claimed === null) return;
  const answer = await github(token, "POST", "/issues", {
    title: issueTitleOf(claimed),
    body: issueBodyOf(claimed),
    labels: [DEV_LABEL],
  });
  const made = answer.status === 201 ? issueShape.pick({ number: true }).safeParse(answer.body) : null;
  if (made?.success) {
    await ctx.runMutation(internal.devRequests.recordFiled, { id, issueNumber: made.data.number, now });
  } else if (settledRefusal(answer)) {
    await ctx.runMutation(internal.devRequests.recordFailed, { id, now });
  }
  // Anything else (a blip, a rate limit, a token GitHub refused): left filed, for the next run.
}

/** Files one request: scheduled when it is made. */
export const file = internalAction({
  args: { id: v.id("devRequests") },
  handler: async (ctx, { id }) => {
    const token = githubToken();
    if (token === null) return null;
    try {
      await fileOne(ctx, token, id);
    } catch {
      // Nothing GitHub said is passed on or logged; the next run tries again.
    }
    return null;
  },
});

/** What one run of `check` looks at: requests waiting for an issue, and open ones, longest unchecked first. */
export const dueForCheck = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const waiting = await ctx.db
      .query("devRequests")
      .withIndex("by_status_and_lastCheckedAt", (q) => q.eq("status", "filed").lt("lastCheckedAt", now - DEV_FILING_LEASE_MS))
      .take(DEV_FILINGS_PER_RUN);
    const open: Row[] = [];
    for (const status of CHECKED_DEV_STATUSES) {
      open.push(
        ...(await ctx.db
          .query("devRequests")
          .withIndex("by_status_and_lastCheckedAt", (q) => q.eq("status", status))
          .take(DEV_CHECKS_PER_RUN)),
      );
    }
    return {
      file: waiting.map((row) => row._id),
      check: open
        .filter((row) => row.issueNumber !== undefined)
        .sort((a, b) => a.lastCheckedAt - b.lastCheckedAt)
        .slice(0, DEV_CHECKS_PER_RUN)
        .map((row) => ({
          id: row._id,
          issueNumber: row.issueNumber!,
          status: row.status as (typeof CHECKED_DEV_STATUSES)[number],
          ...(row.decisionText === undefined ? null : { decisionText: row.decisionText }),
          ...(row.prUrl === undefined ? null : { prUrl: row.prUrl }),
        })),
    };
  },
});

const statusValidator = v.union(...CHECKED_DEV_STATUSES.map((status) => v.literal(status)));
const nextValidator = v.object({
  status: v.union(
    v.literal("issue_open"),
    v.literal("fix_proposed"),
    v.literal("needs_owner"),
    v.literal("answered"),
    v.literal("shipped"),
  ),
  decisionText: v.optional(v.string()),
  prUrl: v.optional(v.string()),
});

/**
 * One look written down: always when it was looked at; and, when something
 * changed and the row is still as it was read, the new state and `updatedAt`
 * (what `my_inbox` reads).
 */
export const recordCheck = internalMutation({
  args: { id: v.id("devRequests"), now: v.number(), was: statusValidator, next: v.optional(nextValidator) },
  handler: async (ctx, { id, now, was, next }) => {
    const row = await ctx.db.get(id);
    if (row === null) return;
    if (next === undefined || row.status !== was) {
      await ctx.db.patch(id, { lastCheckedAt: now });
      return;
    }
    await ctx.db.patch(id, { ...next, updatedAt: now, lastCheckedAt: now });
  },
});

/** Looks at one open request's issue (and its fix's pull request) and writes down what it found. */
async function checkOne(
  ctx: ActionCtx,
  token: string,
  item: { id: Id<"devRequests">; issueNumber: number } & DevState & { status: (typeof CHECKED_DEV_STATUSES)[number] },
) {
  const now = Date.now();
  const issueAnswer = await github(token, "GET", `/issues/${item.issueNumber}`);
  if (issueAnswer.status === 404 || issueAnswer.status === 410) {
    await ctx.runMutation(internal.devRequests.recordFailed, { id: item.id, now });
    return;
  }
  const issue = issueAnswer.status === 200 ? issueShape.safeParse(issueAnswer.body) : null;
  const commentsAnswer = issue?.success ? await github(token, "GET", `/issues/${item.issueNumber}/comments?per_page=100`) : null;
  const comments = commentsAnswer?.status === 200 ? commentsShape.safeParse(commentsAnswer.body) : null;
  if (!issue?.success || !comments?.success) {
    await ctx.runMutation(internal.devRequests.recordCheck, { id: item.id, now, was: item.status });
    return;
  }
  let merged = false;
  const pr = item.prUrl === undefined ? null : /\/pull\/(\d+)$/.exec(item.prUrl);
  if (issue.data.state === "open" && pr !== null) {
    const pull = await github(token, "GET", `/pulls/${pr[1]}`);
    const parsed = pull.status === 200 ? pullShape.safeParse(pull.body) : null;
    merged = parsed?.success === true && (parsed.data.merged === true || typeof parsed.data.merged_at === "string");
  }
  const before: DevState = {
    status: item.status,
    ...(item.decisionText === undefined ? null : { decisionText: item.decisionText }),
    ...(item.prUrl === undefined ? null : { prUrl: item.prUrl }),
  };
  const after = nextState(before, issue.data, comments.data, merged);
  await ctx.runMutation(internal.devRequests.recordCheck, {
    id: item.id,
    now,
    was: item.status,
    ...(changed(before, after) ? { next: after as Infer<typeof nextValidator> } : null),
  });
}

/**
 * The cron's run (every 10 minutes): files what still waits for an issue,
 * then reads back the open ones, at most 20, longest unchecked first. A
 * no-op without the token.
 */
export const check = internalAction({
  args: {},
  handler: async (ctx) => {
    const token = githubToken();
    if (token === null) return null;
    const started = Date.now();
    const due = await ctx.runQuery(internal.devRequests.dueForCheck, { now: started });
    for (const id of due.file) {
      if (Date.now() - started > RUN_BUDGET_MS) return null;
      try {
        await fileOne(ctx, token, id);
      } catch {
        // Left for the next run; nothing is logged.
      }
    }
    for (const item of due.check) {
      if (Date.now() - started > RUN_BUDGET_MS) return null;
      try {
        await checkOne(ctx, token, item);
      } catch {
        // Left for the next run; nothing is logged.
      }
    }
    return null;
  },
});

// ── The owner's view (Agents › Bots) ────────────────────────────────────────

/** One bot's requests, newest first, with their issue's and pull request's links. The owner's alone. */
export const forBot = ownerQuery({
  args: { botId: v.string() },
  handler: async (ctx, { botId }) => {
    const rows = await ctx.db
      .query("devRequests")
      .withIndex("by_bot_and_createdAt", (q) => q.eq("bot", botId))
      .order("desc")
      .take(DEV_REQUEST_ROWS);
    return rows.map((row) => ({
      id: row._id,
      title: row.title,
      status: row.status,
      decision: row.decisionText ?? null,
      tool: row.tool ?? null,
      refusalCode: row.refusalCode ?? null,
      issueUrl: row.issueNumber === undefined ? null : issueUrlOf(row.issueNumber),
      prUrl: row.prUrl ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});

/** How many requests of every bot are still open (bounded). The owner's alone. */
export const openCount = ownerQuery({
  args: {},
  handler: async (ctx) => {
    let count = 0;
    for (const status of OPEN_DEV_STATUSES) {
      count += (
        await ctx.db
          .query("devRequests")
          .withIndex("by_status_and_lastCheckedAt", (q) => q.eq("status", status))
          .take(500)
      ).length;
    }
    return count;
  },
});
