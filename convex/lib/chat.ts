// The owner's live chat (the `chatThreads`, `chatMessages` and `chatRunner`
// tables): what the owner's functions (convex/chat.ts) and the runner's three
// tools (convex/lib/mcpTools.ts) do. Runs only inside Convex: never import it
// from the UI.
//
// **No model is called here.** A question is stored with a queued answer
// beside it. The runner on the owner's Mac claims the answer, has Claude Code
// write it, and reports it back through the same endpoint and token as the
// rest of the owner's Claude. If the Mac is off, the question waits.
//
// The question is the owner's typed text and the answer a model's: both are
// cleaned (convex/lib/agentText.ts), refused when over their limit, stored as
// plain text and rendered as text. A step is a tool's name from a closed
// list. Neither a question, an answer nor a title goes in a log, a thrown
// error, an audit row or a scheduled function's arguments: every refusal is
// fixed words (convex/lib/chatRules.ts). Every function takes `now` from its
// caller: a query never reads the clock.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cleanLine, cleanLines } from "./agentText";
import {
  CHAT_CLAIM_MS,
  CHAT_FAILURES,
  CHAT_HISTORY_BYTES,
  CHAT_HISTORY_MESSAGES,
  CHAT_RETENTION_DAYS,
  CHAT_THREADS_SHOWN,
  CHAT_WORDS,
  MAX_CHAT_ANSWER_LENGTH,
  MAX_CHAT_CLAIMS,
  MAX_CHAT_PROPOSALS,
  MAX_CHAT_QUESTIONS_PER_DAY,
  MAX_CHAT_QUESTION_LENGTH,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_TITLE_LENGTH,
  knownSteps,
  type ChatFailure,
  type RunnerFailure,
} from "./chatRules";
import type { CompanyId } from "./company";
import { cardsFor } from "./proposals";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A title made from a question: its first line, this long at most. */
const TITLE_FROM_QUESTION = 60;
/** What a runner that does not say is taken to check in at. */
const DEFAULT_EVERY_MS = 3_000;

type Message = Doc<"chatMessages">;

const refuse = (words: string): never => {
  throw new ConvexError(words);
};

const messagesOf = (ctx: QueryCtx, threadId: Id<"chatThreads">) =>
  ctx.db
    .query("chatMessages")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .take(MAX_THREAD_MESSAGES + 10);

/** Whether a conversation has an answer that is queued or being written. */
async function answering(ctx: QueryCtx, threadId: Id<"chatThreads">): Promise<boolean> {
  for (const status of ["queued", "working"] as const) {
    const waiting = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_status", (q) => q.eq("threadId", threadId).eq("status", status))
      .first();
    if (waiting !== null) return true;
  }
  return false;
}

// ── The owner's side ────────────────────────────────────────────────────────

/**
 * Ask one question: in a conversation, or starting a new one named after it.
 * Stored with a queued answer beside it for the runner to claim. Refused
 * while that conversation's last answer is still on its way.
 */
export async function sendMessage(
  ctx: MutationCtx,
  input: { threadId?: Id<"chatThreads">; company: CompanyId; text: string },
  now: number,
) {
  if (input.text.trim().length > MAX_CHAT_QUESTION_LENGTH) refuse(CHAT_WORDS.tooLong);
  const text = cleanLines(input.text, MAX_CHAT_QUESTION_LENGTH) ?? refuse(CHAT_WORDS.tooLong);
  if (text === "") refuse(CHAT_WORDS.empty);

  const today = await ctx.db
    .query("chatMessages")
    .withIndex("by_role_and_askedAt", (q) => q.eq("role", "user").gte("askedAt", now - (now % DAY_MS)))
    .take(MAX_CHAT_QUESTIONS_PER_DAY);
  if (today.length >= MAX_CHAT_QUESTIONS_PER_DAY) refuse(CHAT_WORDS.tooManyToday);

  let threadId = input.threadId;
  if (threadId === undefined) {
    threadId = await ctx.db.insert("chatThreads", {
      company: input.company,
      title: cleanLine(text.split("\n")[0], TITLE_FROM_QUESTION),
      createdAt: now,
      updatedAt: now,
    });
  } else {
    if ((await ctx.db.get(threadId)) === null) refuse(CHAT_WORDS.threadGone);
    if (await answering(ctx, threadId)) refuse(CHAT_WORDS.busy);
    if ((await messagesOf(ctx, threadId)).length + 2 > MAX_THREAD_MESSAGES) refuse(CHAT_WORDS.full);
    await ctx.db.patch(threadId, { updatedAt: now });
  }
  const blank = { threadId, steps: [], proposalIds: [], askedAt: now };
  await ctx.db.insert("chatMessages", { ...blank, role: "user", text, status: "done" });
  const messageId = await ctx.db.insert("chatMessages", {
    ...blank,
    role: "assistant",
    text: "",
    status: "queued",
  });
  return { threadId, messageId };
}

/** The conversations, the one last added to first. */
export async function listThreads(ctx: QueryCtx) {
  const rows = await ctx.db
    .query("chatThreads")
    .withIndex("by_updatedAt")
    .order("desc")
    .take(CHAT_THREADS_SHOWN);
  return rows.map((row) => ({
    id: row._id,
    title: row.title,
    company: row.company,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/** One conversation in the order it was said, each answer with its proposals as cards. Null for one that is gone. */
export async function listMessages(ctx: QueryCtx, threadId: Id<"chatThreads">) {
  const thread = await ctx.db.get(threadId);
  if (thread === null) return null;
  const messages = [];
  for (const row of await messagesOf(ctx, threadId)) {
    messages.push({
      id: row._id,
      role: row.role,
      text: row.text,
      status: row.status,
      steps: knownSteps(row.steps),
      /** The sentence, never anything the Mac printed. */
      failure: row.failure === undefined ? null : CHAT_FAILURES[row.failure],
      askedAt: row.askedAt,
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      proposals: await cardsFor(ctx, row.proposalIds),
    });
  }
  return { thread: { id: thread._id, title: thread.title, company: thread.company }, messages };
}

export async function renameThread(ctx: MutationCtx, threadId: Id<"chatThreads">, given: string) {
  if ((await ctx.db.get(threadId)) === null) refuse(CHAT_WORDS.threadGone);
  if (given.trim().length > MAX_THREAD_TITLE_LENGTH) refuse(CHAT_WORDS.titleTooLong);
  const title = cleanLine(given, MAX_THREAD_TITLE_LENGTH);
  if (title === "") refuse(CHAT_WORDS.noTitle);
  await ctx.db.patch(threadId, { title });
  return null;
}

/** Delete a conversation and its messages. A proposal made in it stays among the approvals. */
export async function removeThread(ctx: MutationCtx, threadId: Id<"chatThreads">) {
  for (const row of await messagesOf(ctx, threadId)) await ctx.db.delete(row._id);
  if ((await ctx.db.get(threadId)) !== null) await ctx.db.delete(threadId);
  return null;
}

const ended = (failure: ChatFailure, now: number) => ({
  status: "failed" as const,
  failure,
  finishedAt: now,
  claimExpiresAt: undefined,
});

/**
 * Stop an answer that is queued or being written: it is marked failed
 * "Stopped." with what it had, and the runner's next report is refused, which
 * is how the runner learns to drop it. One already finished is left as it is.
 */
export async function stopMessage(ctx: MutationCtx, messageId: Id<"chatMessages">, now: number) {
  const row = await ctx.db.get(messageId);
  if (row === null) return refuse(CHAT_WORDS.messageGone);
  if (row.status === "queued" || row.status === "working") {
    await ctx.db.patch(row._id, ended("stopped", now));
  }
  return null;
}

/** When the runner last checked in and how often it says it does: nulls before the first. */
export async function runnerStatus(ctx: QueryCtx) {
  const row = await ctx.db.query("chatRunner").first();
  return { checkedInAt: row?.checkedInAt ?? null, everyMs: row?.everyMs ?? null };
}

// ── The runner's side ───────────────────────────────────────────────────────

const utf8 = new TextEncoder();
const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

/** What was said before a question, oldest first: the latest few, within the byte budget. */
function historyBefore(earlier: readonly Message[]) {
  const said = earlier
    // A failed or stopped answer is not something that was said.
    .filter((row) => row.role === "user" || (row.status === "done" && row.text !== ""))
    .map((row) => ({ role: row.role, text: row.text }))
    .slice(-CHAT_HISTORY_MESSAGES);
  const kept: typeof said = [];
  for (const entry of said.reverse()) {
    if (bytesOf([entry, ...kept]) > CHAT_HISTORY_BYTES) break;
    kept.unshift(entry);
  }
  return kept;
}

/**
 * The runner's check-in and claim. Writes down that it checked in, then
 * hands it the oldest answer that is queued, or whose claim ran out, marked
 * `working` and its own for `CHAT_CLAIM_MS`. An answer whose claim ran out a
 * second time is marked failed here instead.
 */
export async function claimNext(
  ctx: MutationCtx,
  input: { runner: string; everyMs?: number },
  clock: { now: number; today: string },
) {
  const { now } = clock;
  const seen = { checkedInAt: now, everyMs: input.everyMs ?? DEFAULT_EVERY_MS };
  const row = await ctx.db.query("chatRunner").first();
  if (row === null) await ctx.db.insert("chatRunner", seen);
  else await ctx.db.patch(row._id, seen);

  const waiting = (status: "queued" | "working") =>
    ctx.db.query("chatMessages").withIndex("by_status_and_askedAt", (q) => q.eq("status", status));
  let pick: Message | null = await waiting("queued").first();
  for (const working of await waiting("working").take(50)) {
    if ((working.claimExpiresAt ?? 0) > now) continue;
    if ((working.claims ?? 0) >= MAX_CHAT_CLAIMS) {
      await ctx.db.patch(working._id, ended("gaveUp", now));
    } else if (pick === null || working.askedAt < pick.askedAt) {
      pick = working;
    }
  }
  if (pick === null) return { none: true };

  const thread = await ctx.db.get(pick.threadId);
  const said = await messagesOf(ctx, pick.threadId);
  const earlier = said.filter((message) => message._creationTime < pick._creationTime);
  const question = earlier.findLast((message) => message.role === "user");
  if (thread === null || question === undefined) {
    // Nothing to answer: its conversation went from under it.
    await ctx.db.patch(pick._id, ended("wrong", now));
    return { none: true };
  }
  await ctx.db.patch(pick._id, {
    status: "working",
    // A second try starts from nothing.
    text: "",
    steps: [],
    startedAt: now,
    claimedBy: input.runner,
    claimExpiresAt: now + CHAT_CLAIM_MS,
    claims: (pick.claims ?? 0) + 1,
  });
  return {
    messageId: pick._id,
    threadId: pick.threadId,
    company: thread.company,
    question: question.text,
    history: historyBefore(earlier.filter((message) => message._id !== question._id)),
    today: clock.today,
  };
}

/** The answer a runner is writing, or the refusal that tells it to drop it. */
async function claimedBy(ctx: QueryCtx, messageId: string, runner: string): Promise<Message> {
  const id = ctx.db.normalizeId("chatMessages", messageId);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.status !== "working" || row.claimedBy !== runner) {
    return refuse(CHAT_WORDS.abandon);
  }
  return row;
}

const answerText = (value: string): string =>
  cleanLines(value, MAX_CHAT_ANSWER_LENGTH) ?? refuse(CHAT_WORDS.answerTooLong);

/** Replace the partial answer and its steps, and keep the claim. Refused once the answer is not this runner's. */
export async function reportProgress(
  ctx: MutationCtx,
  input: { messageId: string; runner: string; text?: string; steps?: string[] },
  now: number,
) {
  const row = await claimedBy(ctx, input.messageId, input.runner);
  await ctx.db.patch(row._id, {
    ...(input.text === undefined ? null : { text: answerText(input.text) }),
    ...(input.steps === undefined ? null : { steps: knownSteps(input.steps) }),
    claimExpiresAt: now + CHAT_CLAIM_MS,
  });
  return { ok: true };
}

/** The answer, or why there is none: one of a closed list. */
export async function finishAnswer(
  ctx: MutationCtx,
  input: { messageId: string; runner: string; text: string; steps?: string[]; failed?: RunnerFailure },
  now: number,
) {
  const row = await claimedBy(ctx, input.messageId, input.runner);
  const text = answerText(input.text);
  if (input.failed === undefined && text === "") refuse(CHAT_WORDS.emptyAnswer);
  await ctx.db.patch(row._id, {
    status: input.failed === undefined ? "done" : "failed",
    ...(input.failed === undefined ? null : { failure: input.failed }),
    // Always what the runner sends, an empty text included: after a failure
    // the last partial text may have been the CLI's own words about it.
    text,
    ...(input.steps === undefined ? null : { steps: knownSteps(input.steps) }),
    finishedAt: now,
    claimExpiresAt: undefined,
  });
  if ((await ctx.db.get(row.threadId)) !== null) await ctx.db.patch(row.threadId, { updatedAt: now });
  return { ok: true };
}

/** The answer in progress a proposal says it belongs under, with room for one more. */
export async function answerInProgress(ctx: QueryCtx, messageId: string): Promise<Message> {
  const id = ctx.db.normalizeId("chatMessages", messageId);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.role !== "assistant" || row.status !== "working") {
    return refuse(CHAT_WORDS.notAnswering);
  }
  if (row.proposalIds.length >= MAX_CHAT_PROPOSALS) return refuse(CHAT_WORDS.tooManyProposals);
  return row;
}

/** Put a proposal under the answer it was made in. */
export async function linkProposal(ctx: MutationCtx, message: Message, proposalId: Id<"proposals">) {
  await ctx.db.patch(message._id, { proposalIds: [...message.proposalIds, proposalId] });
}

// ── Keeping ─────────────────────────────────────────────────────────────────

/**
 * Daily (assistant.sweep): an answer whose claim ran out a second time is
 * marked failed, and a few conversations nobody has added to for
 * `CHAT_RETENTION_DAYS` are deleted with their messages. Returns whether
 * there may be more.
 */
export async function sweepChat(ctx: MutationCtx, now: number, batch: number) {
  const working = await ctx.db
    .query("chatMessages")
    .withIndex("by_status_and_askedAt", (q) => q.eq("status", "working"))
    .take(batch);
  for (const row of working) {
    if ((row.claimExpiresAt ?? 0) <= now && (row.claims ?? 0) >= MAX_CHAT_CLAIMS) {
      await ctx.db.patch(row._id, ended("gaveUp", now));
    }
  }
  // A conversation is a few hundred rows at most: a handful a run.
  const threads = Math.max(1, Math.floor(batch / 50));
  const old = await ctx.db
    .query("chatThreads")
    .withIndex("by_updatedAt", (q) => q.lt("updatedAt", now - CHAT_RETENTION_DAYS * DAY_MS))
    .take(threads);
  for (const thread of old) await removeThread(ctx, thread._id);
  return old.length === threads;
}
