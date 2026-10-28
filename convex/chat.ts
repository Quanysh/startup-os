// The owner's live chat on /assistant: the conversations, what is asked in
// them, and whether the Mac that answers is there. The rules and the limits
// are convex/lib/chatRules.ts; what each function does is convex/lib/chat.ts.
//
// Every function here is the owner's alone (`ownerQuery` / `ownerMutation`).
// **Nothing here calls a model, and the server holds no model key** (the
// owner's decision of 2026-10-13). A question is stored and waits; the
// runner on the owner's Mac (scripts/assistantRunner.ts) claims it through
// POST /mcp/v1 and Claude Code there writes the answer, which arrives on the
// page through these queries as it is written.
//
// A query here never reads the clock: it returns times, and the page decides
// what is fresh. Nothing here logs, and no question, answer or title is put
// in a thrown error.

import { v } from "convex/values";
import {
  listMessages,
  listThreads,
  removeThread,
  renameThread,
  runnerStatus,
  sendMessage,
  stopMessage,
} from "./lib/chat";
import { ownerMutation, ownerQuery } from "./lib/owner";
import { companyValidator } from "./schema";

/** The conversations, the one last added to first. */
export const threads = ownerQuery({
  args: {},
  handler: (ctx) => listThreads(ctx),
});

/** One conversation: its messages in order, each answer with its steps and its proposals. Null for one that is gone. */
export const messages = ownerQuery({
  args: { threadId: v.id("chatThreads") },
  handler: (ctx, { threadId }) => listMessages(ctx, threadId),
});

/** When the runner on the owner's Mac last checked in, and how often it says it does. */
export const runner = ownerQuery({
  args: {},
  handler: (ctx) => runnerStatus(ctx),
});

/**
 * Ask a question, in a conversation or starting a new one. Refused while
 * that conversation's last answer is still on its way.
 */
export const send = ownerMutation({
  args: { threadId: v.optional(v.id("chatThreads")), company: companyValidator, text: v.string() },
  handler: (ctx, args) => sendMessage(ctx, args, Date.now()),
});

export const rename = ownerMutation({
  args: { threadId: v.id("chatThreads"), title: v.string() },
  handler: (ctx, { threadId, title }) => renameThread(ctx, threadId, title),
});

/** Delete a conversation and its messages. */
export const remove = ownerMutation({
  args: { threadId: v.id("chatThreads") },
  handler: (ctx, { threadId }) => removeThread(ctx, threadId),
});

/** Stop an answer that is queued or being written: the runner drops it at its next report. */
export const stop = ownerMutation({
  args: { messageId: v.id("chatMessages") },
  handler: (ctx, { messageId }) => stopMessage(ctx, messageId, Date.now()),
});
