// The owner's bots inside Convex (convex/lib/botRules.ts has the rules):
// finding a bot's profile, and admitting one call of it against its
// permissions and its limits, counted per (client, bot) in `botUsage`.
//
// Runs only inside Convex: never import it from the UI. Nothing here logs,
// and nothing here keeps or returns anything a call sent beyond a bot's id
// that matched a profile.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CALL_WINDOW_MS, nextWindow } from "./agentRules";
import type { ClientRef } from "./agentToken";
import { ConvexError } from "convex/values";
import {
  botLevelRefusal,
  BOT_PERMISSION_WORDS,
  BOT_WORDS,
  CALLER_TOOL_CALLS,
  DEFAULT_BOT_LIMITS,
  EXTERNAL_PROFILES,
  externalPermissions,
  isExternalOwnerAgent,
  CLIENT_BOT_CEILING,
  PROPOSING_TOOLS,
  botMayCall,
  clientKey,
  isBotArea,
  limitWords,
  notPermitted,
  rateLimited,
  utcDayOf,
  withLevel,
  type BotLimitKind,
  type BotRefusal,
} from "./botRules";

/** The ceiling's row: every bot of one client together. */
export const CEILING = "*";

/** A bot's profile, by its id, for this owner; null when there is none. */
export async function botNamed(ctx: QueryCtx, userId: Id<"users">, botId: string): Promise<Doc<"bots"> | null> {
  return await ctx.db
    .query("bots")
    .withIndex("by_userId_and_botId", (q) => q.eq("userId", userId).eq("botId", botId))
    .unique();
}

/**
 * An external owner-agent's profile (chief_of_staff, engineering), made with
 * its defaults: any client, read on every bot area, write on the board and
 * memory, the default limits (Bot Loop v3, A). Made at its first call through
 * a client that is not the Mac runner's, it starts **switched off** (the
 * security review of 2026-10-19): a credential that reaches /mcp/v1 must not
 * get a profile that writes before the owner has seen it, so it is refused
 * (`bot_off`, `BOT_WORDS.externalOff`) until he switches it on on the Bots tab.
 * The tab's own button (`bots.addExternalProfile`) makes it on. One that exists
 * is left as he made it. Any other id: nothing happens.
 */
export async function ensureExternalProfile(
  ctx: MutationCtx,
  userId: Id<"users">,
  botId: string,
  now: number,
  enabled: boolean,
): Promise<void> {
  if (!isExternalOwnerAgent(botId)) return;
  if ((await botNamed(ctx, userId, botId)) !== null) return;
  await ctx.db.insert("bots", {
    userId,
    botId,
    name: EXTERNAL_PROFILES[botId].name,
    role: EXTERNAL_PROFILES[botId].role,
    clients: "any",
    permissions: externalPermissions(),
    limits: DEFAULT_BOT_LIMITS,
    enabled,
    suggested: true,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * A token made for one bot refuses any other name, before anything is read
 * or made for it (an external profile included): null when it does not.
 */
const otherBotsToken = (onlyBot: string | null, botId: string): { words: string; refusal: BotRefusal } | null =>
  onlyBot !== null && onlyBot !== botId ? { words: BOT_WORDS.tokenForBot, refusal: { code: "wrong_client" } } : null;

/** Whether a bot may come through this client. */
export const botAllowsClient = (bot: Doc<"bots">, client: ClientRef): boolean =>
  bot.clients === "any" || bot.clients.some((c) => c.kind === client.kind && c.id === client.id);

/**
 * Why a profile is not used for a call from this client, or null when it is.
 * `onlyBot` is the one bot a token was made for: any other is refused.
 */
export function botRefusal(bot: Doc<"bots"> | null, client: ClientRef, onlyBot: string | null = null): string | null {
  return botRefusalOf(bot, client, onlyBot)?.words ?? null;
}

/** The same, with its code (convex/lib/botRules.ts, "Refusal codes"). */
export function botRefusalOf(
  bot: Doc<"bots"> | null,
  client: ClientRef,
  onlyBot: string | null = null,
): { words: string; refusal: BotRefusal } | null {
  if (bot === null) return { words: BOT_WORDS.unknown, refusal: { code: "unknown_bot" } };
  if (!bot.enabled) {
    return { words: isExternalOwnerAgent(bot.botId) ? BOT_WORDS.externalOff : BOT_WORDS.off, refusal: { code: "bot_off" } };
  }
  if (onlyBot !== null && bot.botId !== onlyBot) return { words: BOT_WORDS.tokenForBot, refusal: { code: "wrong_client" } };
  if (!botAllowsClient(bot, client)) return { words: BOT_WORDS.wrongClient, refusal: { code: "wrong_client" } };
  return null;
}

/**
 * Give one of the owner's bots a level on an area: what the Bots tab's Grant
 * and an approved `permission_request` both run, so both make the same checks
 * (`botLevelRefusal`: never a locked area, the bot on, a level it does not
 * hold already). Fixed words.
 */
export async function setBotLevel(
  ctx: MutationCtx,
  bot: Doc<"bots">,
  area: string,
  level: "read" | "write",
  now: number,
): Promise<void> {
  const refusal = botLevelRefusal(bot, area, level);
  if (refusal !== null) throw new ConvexError(refusal);
  if (!isBotArea(area)) throw new ConvexError(BOT_PERMISSION_WORDS.badArea);
  await ctx.db.patch(bot._id, { permissions: withLevel(bot.permissions, area, level), suggested: false, updatedAt: now });
}

async function usageRow(ctx: MutationCtx, userId: Id<"users">, client: string, bot: string): Promise<Doc<"botUsage">> {
  const found = await ctx.db
    .query("botUsage")
    .withIndex("by_client_and_bot", (q) => q.eq("client", client).eq("bot", bot))
    .unique();
  if (found !== null) return found;
  const id = await ctx.db.insert("botUsage", { userId, client, bot });
  return (await ctx.db.get(id))!;
}

export type BotAdmit =
  | { status: "ok" }
  | { status: "unknown_tool" }
  | { status: "read_only" }
  /** Refused: no profile, switched off, not on this client, or not a tool it may use. */
  | { status: "bot_refused"; words: string; refusal: BotRefusal }
  /** Over a limit: `note` is true for the first refusal of its window only. */
  | { status: "bot_limited"; words: string; note: boolean; refusal: BotRefusal };

/** A limit refusal's words and code, from one place. */
const overLimit = (kind: BotLimitKind, max: number, resetsAt: number) => ({
  words: limitWords(kind, max, resetsAt),
  refusal: rateLimited(kind, max, resetsAt),
});

/**
 * Count one call of a named bot and say whether it may run. In order: the
 * profile (none, off, or not on this client: refused, counted against the
 * client's ceiling only); the ceiling's calls; the bot's own calls; an
 * unknown tool; a tool the bot may not use; an act from a read-only client;
 * the bot's changes, the ceiling's changes and, for a tool that proposes,
 * the bot's proposals today. A call turned away for a reason other than a
 * limit still counts as a call.
 */
export async function admitBot(
  ctx: MutationCtx,
  call: {
    userId: Id<"users">;
    client: ClientRef;
    /** The one bot the client's token was made for, if any. */
    onlyBot?: string | null;
    scope: "read" | "act";
    botId: string;
    tool: { name: string; kind: "read" | "act" } | undefined;
    now: number;
  },
): Promise<BotAdmit> {
  const { userId, now } = call;
  const key = clientKey(call.client);
  const today = utcDayOf(now);
  const ceiling = await usageRow(ctx, userId, key, CEILING);
  const ceilingCalls = nextWindow({ windowStart: ceiling.windowStart, count: ceiling.calls }, now, CLIENT_BOT_CEILING.callsPer10Min);
  if (!ceilingCalls.allowed) {
    const note = ceiling.limitNotedFor !== ceilingCalls.windowStart;
    if (note) await ctx.db.patch(ceiling._id, { limitNotedFor: ceilingCalls.windowStart });
    return {
      status: "bot_limited",
      ...overLimit("client_calls", CLIENT_BOT_CEILING.callsPer10Min, ceilingCalls.windowStart + CALL_WINDOW_MS),
      note,
    };
  }

  // The one-bot token's check before anything is made; an external profile's first call makes it off.
  const early = otherBotsToken(call.onlyBot ?? null, call.botId);
  if (early === null) await ensureExternalProfile(ctx, userId, call.botId, now, false);
  const bot = early === null ? await botNamed(ctx, userId, call.botId) : null;
  const refused = early ?? botRefusalOf(bot, call.client, call.onlyBot ?? null);
  if (refused !== null || bot === null) {
    await ctx.db.patch(ceiling._id, { windowStart: ceilingCalls.windowStart, calls: ceilingCalls.count });
    return { status: "bot_refused", ...(refused ?? { words: BOT_WORDS.unknown, refusal: { code: "unknown_bot" } }) };
  }

  const row = await usageRow(ctx, userId, key, bot.botId);
  const fresh = row.day !== today;
  const daily = {
    day: today,
    proposals: fresh ? 0 : (row.proposals ?? 0),
    callsToday: fresh ? 0 : (row.callsToday ?? 0),
    refusalsToday: fresh ? 0 : (row.refusalsToday ?? 0),
  };
  const refuse = async (words: string, refusal: BotRefusal): Promise<BotAdmit> => {
    await ctx.db.patch(row._id, { ...daily, refusalsToday: daily.refusalsToday + 1, lastCallAt: now });
    return { status: "bot_refused", words, refusal };
  };
  const limited = async (over: { words: string; refusal: BotRefusal }, windowStart: number): Promise<BotAdmit> => {
    const note = row.limitNotedFor !== windowStart;
    await ctx.db.patch(row._id, {
      ...daily,
      refusalsToday: daily.refusalsToday + 1,
      lastCallAt: now,
      ...(note ? { limitNotedFor: windowStart } : null),
    });
    return { status: "bot_limited", ...over, note };
  };

  const calls = nextWindow({ windowStart: row.windowStart, count: row.calls }, now, bot.limits.callsPer10Min);
  if (!calls.allowed) {
    return limited(overLimit("calls", bot.limits.callsPer10Min, calls.windowStart + CALL_WINDOW_MS), calls.windowStart);
  }
  await ctx.db.patch(ceiling._id, { windowStart: ceilingCalls.windowStart, calls: ceilingCalls.count });
  await ctx.db.patch(row._id, { windowStart: calls.windowStart, calls: calls.count });
  daily.callsToday += 1;

  const tool = call.tool;
  if (tool === undefined) {
    await ctx.db.patch(row._id, { ...daily, lastCallAt: now });
    return { status: "unknown_tool" };
  }
  if (!botMayCall(bot.permissions, tool.name, tool.kind)) return refuse(BOT_WORDS.notAllowed, notPermitted(tool.name, tool.kind));
  if (tool.kind === "act") {
    if (call.scope !== "act") {
      await ctx.db.patch(row._id, { ...daily, refusalsToday: daily.refusalsToday + 1, lastCallAt: now });
      return { status: "read_only" };
    }
    const acts = nextWindow({ windowStart: row.actWindowStart, count: row.acts }, now, bot.limits.changesPer10Min);
    if (!acts.allowed) {
      return limited(overLimit("changes", bot.limits.changesPer10Min, acts.windowStart + CALL_WINDOW_MS), acts.windowStart);
    }
    const ceilingActs = nextWindow(
      { windowStart: ceiling.actWindowStart, count: ceiling.acts },
      now,
      CLIENT_BOT_CEILING.changesPer10Min,
    );
    if (!ceilingActs.allowed) {
      return limited(
        overLimit("client_changes", CLIENT_BOT_CEILING.changesPer10Min, ceilingActs.windowStart + CALL_WINDOW_MS),
        ceilingActs.windowStart,
      );
    }
    const proposes = PROPOSING_TOOLS.includes(tool.name);
    if (proposes && daily.proposals >= bot.limits.proposalsPerDay) {
      // A day's limit is noted once a day: keyed on the day's start.
      const dayStart = Date.parse(`${today}T00:00:00Z`);
      return limited(overLimit("proposals", bot.limits.proposalsPerDay, dayStart + 24 * 60 * 60 * 1000), dayStart);
    }
    await ctx.db.patch(ceiling._id, { actWindowStart: ceilingActs.windowStart, acts: ceilingActs.count });
    await ctx.db.patch(row._id, { actWindowStart: acts.windowStart, acts: acts.count });
    if (proposes) daily.proposals += 1;
  }
  await ctx.db.patch(row._id, { ...daily, lastCallAt: now });
  return { status: "ok" };
}

/**
 * The bucket `CALLER_TOOLS` of a client are counted in when no profile it may
 * use is named (no name, or a refused one): not a bot id's shape, so never a
 * bot's row, and a loop of made-up names cannot add rows.
 */
export const NO_BOT = "-";

export type CallerAdmit =
  /** `quiet`: an answered call is already on the audit this window, so this one is not written. */
  | { status: "ok"; quiet: boolean }
  /** `note`: the first refusal of its window only is written. */
  | { status: "bot_refused"; words: string; refusal: BotRefusal; note: boolean }
  | { status: "bot_limited"; words: string; refusal: BotRefusal; note: boolean };

/**
 * A call of a tool about the caller itself (`whoami`, `bot_rules`): counted
 * in a window of its own per (client, bot), `CALLER_TOOL_CALLS` in 10
 * minutes, and refused past it (`caller_calls`). A named bot's profile must
 * be one this client may use, as for any call; a refused name and no name
 * are counted in the client's `NO_BOT` bucket. At most one answered call and
 * one refusal a window reach the audit, so a loop cannot push other rows out.
 */
export async function admitCallerTool(
  ctx: MutationCtx,
  call: { userId: Id<"users">; client: ClientRef; onlyBot?: string | null; botId?: string | undefined; now: number },
): Promise<CallerAdmit> {
  const { now } = call;
  const early = call.botId === undefined ? null : otherBotsToken(call.onlyBot ?? null, call.botId);
  if (call.botId !== undefined && early === null) await ensureExternalProfile(ctx, call.userId, call.botId, now, false);
  const bot = call.botId === undefined || early !== null ? null : await botNamed(ctx, call.userId, call.botId);
  const refused =
    call.botId === undefined
      ? null
      : (early ??
        botRefusalOf(bot, call.client, call.onlyBot ?? null) ??
        (bot === null ? { words: BOT_WORDS.unknown, refusal: { code: "unknown_bot" } as BotRefusal } : null));
  const row = await usageRow(ctx, call.userId, clientKey(call.client), refused === null && bot !== null ? bot.botId : NO_BOT);
  const window = nextWindow({ windowStart: row.callerWindowStart, count: row.callerCalls }, now, CALLER_TOOL_CALLS);
  const noteOnce = async () => {
    const note = row.callerRefusalNotedFor !== window.windowStart;
    if (note) await ctx.db.patch(row._id, { callerRefusalNotedFor: window.windowStart });
    return note;
  };
  if (!window.allowed) {
    return {
      status: "bot_limited",
      ...overLimit("caller_calls", CALLER_TOOL_CALLS, window.windowStart + CALL_WINDOW_MS),
      note: await noteOnce(),
    };
  }
  await ctx.db.patch(row._id, {
    callerWindowStart: window.windowStart,
    callerCalls: window.count,
    ...(refused === null && bot !== null ? { lastCallAt: now } : null),
  });
  if (refused !== null) return { status: "bot_refused", ...refused, note: await noteOnce() };
  const quiet = row.callerOkNotedFor === window.windowStart;
  if (!quiet) await ctx.db.patch(row._id, { callerOkNotedFor: window.windowStart });
  return { status: "ok", quiet };
}

/** What `tools/list` shows a named bot: the tools it may call, or none when it is not one this client may use. */
export async function botListFilter(
  ctx: QueryCtx,
  userId: Id<"users">,
  client: ClientRef,
  botId: string,
  onlyBot: string | null = null,
): Promise<Doc<"bots">["permissions"] | null> {
  const bot = await botNamed(ctx, userId, botId);
  // An external owner-agent before its first call lists nothing: that call makes it switched off.
  return botRefusal(bot, client, onlyBot) === null ? bot!.permissions : null;
}
