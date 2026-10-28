import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import { ownerEmailList } from "./authOwner";
import {
  NOT_SENT,
  OLDEST_SHOWN,
  URGENCIES,
  digestMessage,
  digestTitle,
  urgencyOf,
  whoWords,
  type Digest,
  type DigestItem,
  type Urgency,
} from "./lib/approvalsDigest";
import { cashReader } from "./lib/cashGroup";
import { companyIds } from "./lib/company";
import { isPersonStale } from "./lib/handoffs";
import { MAX_TITLE_LENGTH } from "./lib/limits";
import { isOwnersToolCall } from "./lib/toolCallApprovals";
import { keepNewest } from "./lib/notify";
import { botToken, settingsRow, sentenceOf } from "./telegram";
import { sendMessage } from "./lib/telegramRequest";

// The daily approvals digest (docs/assistant.md "Daily digest"): every day at
// 04:00 UTC (09:00 Almaty, convex/crons.ts), if proposals are open or tool
// calls are paused, or handoffs to people have waited a day, each owner is
// told how many, by urgency, how many are pinned in "Cash and runway", how
// many handoffs to people are open over 24h, and which three are oldest, by
// kind, bot and age. In the owner's own Telegram chat (their
// Telegram user id, which is their private chat with the bot) and as a
// notification in the app. Never the company's group.
//
// No free text anywhere in it (convex/lib/approvalsDigest.ts): not a title, a
// reason, a name or a tool's arguments. Once a day: the notification is the
// day's claim, so a second run the same UTC day does nothing.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows read of each kind; past it the total reads "N+". */
const READ_CAP = 500;

async function gather(ctx: { db: import("./_generated/server").QueryCtx["db"] }, now: number): Promise<Digest | null> {
  const open = await ctx.db
    .query("proposals")
    .withIndex("by_status_and_createdAt", (q) => q.eq("status", "open"))
    .take(READ_CAP);
  // The inbox's own read (convex/lib/toolCallApprovals.ts): Startup OS's runs only, so the counts agree.
  const read = await ctx.db
    .query("agentApprovals")
    .withIndex("by_state_and_createdAt", (q) => q.eq("state", "pending"))
    .take(READ_CAP);
  const paused = read.filter(isOwnersToolCall);
  // Handoffs to people with nothing done for a day: a count, never who or what.
  let staleHandoffs = 0;
  for (const company of companyIds()) {
    const rows = await ctx.db
      .query("handoffs")
      .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", "open"))
      .take(READ_CAP);
    staleHandoffs += rows.filter((row) => isPersonStale(row, now)).length;
  }
  if (open.length + paused.length + staleHandoffs === 0) return null;

  // Proposals pinned in "Cash and runway": the page's own rule and reader
  // (convex/lib/cashGroup.ts), so the count is the group /approvals shows.
  const isCash = cashReader(ctx.db);
  let cash = 0;
  for (const row of open) if (await isCash(row)) cash += 1;

  const byUrgency = Object.fromEntries(URGENCIES.map((name) => [name, 0])) as Record<Urgency, number>;
  for (const row of open) byUrgency[urgencyOf(row)] += 1;
  // A paused tool call has no urgency of its own: it counts as normal.
  byUrgency.normal += paused.length;

  const items: DigestItem[] = [
    ...open.slice(0, OLDEST_SHOWN).map((row) => ({
      kind: row.kind,
      who: whoWords(row),
      createdAt: row.createdAt,
    })),
    ...paused.slice(0, OLDEST_SHOWN).map((row) => ({
      kind: "tool_call",
      who: whoWords({ bot: row.agentId }),
      createdAt: row.createdAt,
    })),
  ]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, OLDEST_SHOWN);

  return {
    cash,
    staleHandoffs,
    total: open.length + paused.length,
    paused: paused.length,
    capped: open.length === READ_CAP || read.length === READ_CAP,
    byUrgency,
    oldest: items,
  };
}

/**
 * Claim today for each owner who has not had it, write their notification, and
 * say what to post to whom. The owner's chat is their Telegram user id in
 * `telegramSettings.owners` (set when the bot first sees their username in a
 * picked group); a private chat with a user has the user's id.
 */
export const prepare = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ chatId: string; text: string }[]> => {
    const now = Date.now();
    const digest = await gather(ctx, now);
    if (digest === null) return [];
    const dayStart = now - (now % DAY_MS);
    const settings = await settingsRow(ctx);
    const botOn = settings !== null && settings.enabled && botToken() !== null;
    const sends: { chatId: string; text: string }[] = [];

    for (const email of ownerEmailList()) {
      const users = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .take(2);
      // One address, one user: two rows are nobody's.
      if (users.length !== 1) continue;
      const user = users[0]!;
      const latest = await ctx.db
        .query("notifications")
        .withIndex("by_recipient_and_createdAt", (q) =>
          q.eq("recipient", user._id).gte("createdAt", dayStart),
        )
        .collect();
      if (latest.some((row) => row.kind === "approvals_digest")) continue;

      const chatId = settings?.owners?.find((o) => o.userId === user._id)?.telegramUserId;
      const note = !botOn ? NOT_SENT.off : chatId === undefined ? NOT_SENT.unlinked : undefined;
      await ctx.db.insert("notifications", {
        recipient: user._id as Id<"users">,
        kind: "approvals_digest",
        actor: { type: "system", source: "digest" },
        title: digestTitle(digest, note).slice(0, MAX_TITLE_LENGTH),
        createdAt: now,
      });
      await keepNewest(ctx, user._id);
      if (note === undefined && chatId !== undefined) {
        sends.push({ chatId, text: digestMessage(digest, now) });
      }
    }
    return sends;
  },
});

/** The cron's entry. Never throws: a failed post is written down as a fixed sentence, as for tasks. */
export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const sends = await ctx.runMutation(internal.approvalsDigest.prepare, {});
      const token = botToken();
      if (token === null) return null;
      for (const send of sends) {
        const result = await sendMessage(token, send.chatId, send.text);
        await ctx.runMutation(
          internal.telegram.record,
          result.ok ? {} : { failure: sentenceOf(result.failure) === "" ? "other" : result.failure },
        );
      }
    } catch {
      // Nothing thrown here is passed on or logged: it may quote a request's address.
    }
    return null;
  },
});
