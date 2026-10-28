// Delivers a bot event after the mutation that recorded it has committed.
// The mutation calls `scheduleBotEvent`; this file's action POSTs. The URL
// and the signing secrets are read here, from the environment, at delivery
// time, and a secret is never logged, stored or put on the scheduled job.
//
// Who is woken: a profile of the owner's (`bots`, found by the owner's user
// and the bot's id) that is switched on, reads or writes the board and works
// for the event's company. Checked when the event is scheduled and again just
// before it is sent, so a bot switched off in between is not woken. At most
// `EVENTS_PER_BOT_PER_HOUR` a bot an hour; the rest are counted and dropped.
//
// Unset URL: nothing is scheduled and nothing is thrown. A bad URL or a
// missing secret, a non-2xx answer after the retries, or a network failure
// after them is written to the bot's `botEventStatus` row in fixed words; the
// original mutation is never failed or blocked.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isOwnerEmail } from "./authOwner";
import { MAX_BOTS } from "./lib/botRules";
import { botNamed } from "./lib/botStore";
import { PRODUCT } from "./lib/identity";
import {
  DELIVERY_TIMEOUT_MS,
  PREVIOUS_SIGNATURE_HEADER,
  RETRY_BACKOFF_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SECRET_PREVIOUS_ENV,
  WEBHOOK_URL_ENV,
  botEventPayload,
  countEvent,
  deliveryBody,
  mayReceiveEvents,
  signBody,
  webhookConfigured,
  webhookTarget,
  type BotEventDraft,
} from "./lib/botEvents";
import { refusalHere } from "./lib/devLocal";

/** What a failure is written as: closed words, never a body, a URL or a secret. */
const FAILURE = /^(network|unusable|http \d{3})$/;

/**
 * The owner's profile of this id: a `bots` row whose user is the owner. A
 * teammate never has one, so this is the owner's user and the bot's id.
 */
export async function ownersBot(ctx: QueryCtx, botId: string): Promise<Doc<"bots"> | null> {
  const rows = await ctx.db
    .query("bots")
    .withIndex("by_botId", (q) => q.eq("botId", botId))
    .take(MAX_BOTS);
  for (const row of rows) {
    const user = await ctx.db.get(row.userId);
    if (user !== null && isOwnerEmail(user.email)) return row;
  }
  return null;
}

const statusOf = (ctx: QueryCtx, bot: string) =>
  ctx.db
    .query("botEventStatus")
    .withIndex("by_bot", (q) => q.eq("bot", bot))
    .unique();

/** Count one more event for the bot this hour; false when it is over its limit (counted, not sent). */
async function reserve(ctx: MutationCtx, bot: string, now: number): Promise<boolean> {
  const row = await statusOf(ctx, bot);
  const { send, row: next } = countEvent(row, now);
  if (row === null) await ctx.db.insert("botEventStatus", { bot, ...next });
  else await ctx.db.patch(row._id, next);
  return send;
}

/**
 * Schedule one delivery once this mutation commits. No-op when the URL env is
 * unset, when the draft is not an event we send (a person, a shared task, a
 * Mac agent, one of the bare four), when the profile may not receive it, or
 * when the bot had its hour's events. Whatever is thrown is swallowed: the
 * write stands.
 */
export async function scheduleBotEvent(ctx: MutationCtx, draft: Omit<BotEventDraft, "deliveryId">): Promise<void> {
  try {
    if (!webhookConfigured(process.env[WEBHOOK_URL_ENV])) return;
    const payload = botEventPayload({ ...draft, deliveryId: crypto.randomUUID() });
    if (payload === null) return;
    const profile = await ownersBot(ctx, payload.agent);
    if (profile === null || !mayReceiveEvents(profile, payload.company)) return;
    if (!(await reserve(ctx, payload.agent, Date.now()))) return;
    await ctx.scheduler.runAfter(0, internal.botEvents.deliver, {
      ...payload,
      userId: profile.userId,
      attempt: 0,
    });
  } catch {
    // The row is already written. What was thrown is not logged: it can quote the title.
  }
}

/** Whether the profile may still be woken about this company: switched on, the board, its company. */
export const receiverReady = internalQuery({
  args: { userId: v.id("users"), bot: v.string(), company: v.union(v.literal("us"), v.literal("kz")) },
  handler: async (ctx, args): Promise<boolean> =>
    mayReceiveEvents(await botNamed(ctx, args.userId, args.bot), args.company),
});

/** Write how a delivery ended on the bot's row: when it went through, or the failure in closed words. */
export const noteDelivery = internalMutation({
  args: { bot: v.string(), failure: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await statusOf(ctx, args.bot);
    if (row === null) return null;
    const now = Date.now();
    if (args.failure === undefined) {
      await ctx.db.patch(row._id, { lastSentAt: now, lastFailure: undefined });
    } else {
      const what = FAILURE.test(args.failure) ? args.failure : "network";
      await ctx.db.patch(row._id, { lastFailure: { what, at: now } });
    }
    return null;
  },
});

export const deliver = internalAction({
  args: {
    event: v.union(v.literal("task.assigned"), v.literal("handoff.assigned"), v.literal("proposal.decided")),
    company: v.union(v.literal("us"), v.literal("kz")),
    agent: v.string(),
    id: v.string(),
    title: v.string(),
    decision: v.optional(v.union(v.literal("approved"), v.literal("dismissed"), v.literal("auto_approved"))),
    deliveryId: v.string(),
    at: v.number(),
    userId: v.id("users"),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const target = webhookTarget({
      url: process.env[WEBHOOK_URL_ENV],
      secret: process.env[WEBHOOK_SECRET_ENV],
      previous: process.env[WEBHOOK_SECRET_PREVIOUS_ENV],
      dev: refusalHere() === null,
    });
    if (target.kind === "unset") return;
    if (target.kind === "unusable") {
      await ctx.runMutation(internal.botEvents.noteDelivery, { bot: args.agent, failure: "unusable" });
      return;
    }
    const { attempt, userId, ...event } = args;
    const payload = botEventPayload(event);
    if (payload === null) return;
    // Switched off, off the board or moved to the other company since it was queued: not woken.
    const ready = await ctx.runQuery(internal.botEvents.receiverReady, {
      userId,
      bot: payload.agent,
      company: payload.company,
    });
    if (!ready) return;

    const body = JSON.stringify(deliveryBody(payload));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": PRODUCT.slug,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: await signBody(target.secret, timestamp, body),
    };
    if (target.previous !== null) {
      headers[PREVIOUS_SIGNATURE_HEADER] = await signBody(target.previous, timestamp, body);
    }
    let failed: "network" | `http ${number}` | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) failed = `http ${response.status}`;
    } catch {
      failed = "network";
    } finally {
      clearTimeout(timer);
    }
    if (failed === null) {
      await ctx.runMutation(internal.botEvents.noteDelivery, { bot: payload.agent });
      return;
    }
    const delay = RETRY_BACKOFF_MS[attempt];
    if (delay !== undefined) {
      // The same delivery id: a receiver that saw an earlier try drops this one.
      await ctx.scheduler.runAfter(delay, internal.botEvents.deliver, { ...args, attempt: attempt + 1 });
      return;
    }
    await ctx.runMutation(internal.botEvents.noteDelivery, { bot: payload.agent, failure: failed });
  },
});
