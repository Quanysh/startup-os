// The owner's assistant: the clients the owner connected to POST /mcp/v1
// (convex/mcp.ts), their limits, and the record of what each called.
//
// Every public function here is the owner's alone (`ownerQuery` /
// `ownerMutation`) and answers about the caller's own clients: there is no
// argument that names a person. A client is a named token (`sosa_…`): returned
// once, by `createToken`, and only its SHA-256 is stored. Nothing here
// returns, throws or logs a token or a hash, and the audit rows hold no
// argument, title, name or text: only the tool, how it ended, and which
// client (by the owner's own name for it).
//
// This is not a personal token (convex/connect.ts): that one is a teammate's,
// excludes the owner and writes mirror rows only. These are the owner's
// alone and read company data: the owner decided so on 2026-10-13.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  AGENT_CALL_RETENTION_DAYS,
  AGENT_TOKEN_BYTES,
  CLIENT_WORDS,
  MAX_ACTS_PER_WINDOW,
  MAX_AGENT_CALLS,
  MAX_AGENT_TOKENS,
  MAX_CALLS_PER_WINDOW,
  MAX_CLIENT_NAME,
  RECENT_AGENT_CALLS,
  TOKEN_NOT_MADE,
  UNKNOWN_TOOL,
  agentTokenFrom,
  nextWindow,
  type AgentScope,
} from "./lib/agentRules";
import { changeAgent } from "./agentControl";
import { agentsOff, ownerMember } from "./lib/agentStore";
import { ensureOsAgents } from "./lib/osAgentRuns";
import { STARTUP_OS_PROJECT } from "./lib/agentStartupOs";
import {
  clientHolder,
  credentialValidator,
  grantBotsOnly,
  tokenBotsOnly,
  tokenIsRunner,
  tokenName,
  type Holder,
  type LimitFields,
} from "./lib/agentToken";
import { AGENT_IDS, AGENT_LINES, AGENT_NAMES, DECIDED_ROWS } from "./lib/agents";
import { briefsSince, latestBrief, pruneBriefs, recentBriefs } from "./lib/briefs";
import { sweepChat } from "./lib/chat";
import { MAX_RUNNER_CALLS_PER_WINDOW } from "./lib/chatRules";
import { companyIds } from "./lib/company";
import { decidedToolCalls, waitingToolCalls } from "./lib/toolCallApprovals";
import { toolFor, toolNamed } from "./lib/mcpTools";
import { cleanRemote } from "./lib/mirrorRules";
import { deleteGrant } from "./lib/oauthStore";
import { ownerMutation, ownerQuery } from "./lib/owner";
import { hashToken } from "./lib/personalRules";
import {
  approveProposal,
  dismiss as dismissProposal,
  decidedForOwner,
  inboxProposals,
  proposalsMadeSince,
  sweepProposals,
} from "./lib/proposals";
// Nothing asks a question any more (the queued Ask was removed in the
// 2026-10 dedupe; the chat is the one place to ask): rows already on record
// still age out with the sweep.
import { pruneQuestions } from "./lib/questions";
import { admitBot, admitCallerTool, botNamed } from "./lib/botStore";
import { pruneDuplicateChecks } from "./lib/duplicates";
import { noteBotCall, providerOf, pruneBotCallDays } from "./lib/botTelemetry";
import { dayOf } from "./lib/agentControl";
import { BOT_WORDS, cleanCostUsd, isCallerTool, type BotRefusal } from "./lib/botRules";
import { assignablePeople } from "./lib/teamDirectory";
import {
  agentClientValidator,
  agentOutcomeValidator,
  agentRefusalValidator,
  agentScopeValidator,
  agentValidator,
  companyValidator,
  proposalPayloadValidator,
  rejectCodeValidator,
} from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The caller's token rows: `MAX_AGENT_TOKENS` at most, so a bounded read. */
async function tokensOf(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("agentTokens")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(MAX_AGENT_TOKENS + 5);
}

/** The caller's OAuth grants: one a client, a bounded read. */
async function grantsOf(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("oauthGrants")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100);
}

/**
 * The caller's connected clients, oldest first: each one's name, kind (a
 * named token, or an OAuth sign-in the owner approved), what it may do,
 * whether it is the Mac's runner, and when it was made (approved) and last
 * used. Never a token or a hash.
 */
export const clients = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const tokens = await tokensOf(ctx, ctx.owner._id);
    const grants = (await grantsOf(ctx, ctx.owner._id)).map((grant) => ({
      id: grant._id as string,
      kind: "oauth" as const,
      name: grant.clientName,
      scope: grant.scope,
      runner: false,
      botsOnly: grantBotsOnly(grant),
      onlyBot: null as string | null,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt ?? null,
      /** Where it signed in from: the host its browser was sent back to. */
      host: grant.redirectHost as string | null,
    }));
    // The chat's runner on the owner's Mac uses its client's token on a count
    // of its own that does not stamp the row: a check-in since the token was
    // made is use of it all the same.
    const checkIn = (await ctx.db.query("chatRunner").first())?.checkedInAt ?? null;
    return tokens
      .map((token) => {
        const runner = tokenIsRunner(token);
        const checkedIn = runner && checkIn !== null && checkIn >= token.createdAt ? checkIn : 0;
        const used = Math.max(token.lastUsedAt ?? 0, checkedIn);
        return {
          id: token._id as string,
          kind: "token" as "token" | "oauth",
          name: tokenName(token),
          scope: token.scope,
          runner,
          botsOnly: tokenBotsOnly(token),
          onlyBot: token.onlyBot ?? null,
          createdAt: token.createdAt,
          lastUsedAt: used === 0 ? null : used,
          host: null as string | null,
        };
      })
      .concat(grants)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/** What the browser adds to the token's randomness: 32 bytes or more, URL-safe base64. */
const ENTROPY = /^[A-Za-z0-9_-]{43,128}$/;

/** Random bytes from the runtime, or none where it has no source of them. */
function serverBytes(): Uint8Array {
  try {
    return crypto.getRandomValues(new Uint8Array(AGENT_TOKEN_BYTES));
  } catch {
    return new Uint8Array(0);
  }
}

/** A client's name as typed, cleaned of what the eye cannot see, or a refusal in fixed words. */
export function cleanClientName(value: string): string {
  // Cleaned with room to spare, so a name over the limit is refused rather than cut.
  const name = cleanRemote(value, MAX_CLIENT_NAME + 2);
  if (name === "") throw new ConvexError(CLIENT_WORDS.nameMissing);
  if (name.length > MAX_CLIENT_NAME) throw new ConvexError(CLIENT_WORDS.nameTooLong);
  return name;
}

/**
 * Make a token for one client and return it: the one time it can be read.
 * Only its SHA-256 is stored. `name` is the owner's word for the client;
 * `scope` is what it may do ("read", or "act" to read and change things);
 * `runner` makes it the Mac's runner, the one client that may call the
 * runner's tools (one at a time, and only one that may act). Other clients'
 * tokens are not touched.
 *
 * The token is 32 bytes: SHA-256 over 32 random bytes drawn here and 32 or
 * more drawn by the caller's browser, as a personal token is made.
 */
export const createToken = ownerMutation({
  args: {
    entropy: v.string(),
    scope: agentScopeValidator,
    name: v.string(),
    runner: v.optional(v.boolean()),
    /** Only the owner's bots may use it: on unless said otherwise, and off for the runner's. */
    botsOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { entropy, scope, name, runner, botsOnly }) =>
    await mintToken(ctx, ctx.owner._id, { entropy, scope, name, runner: runner === true, botsOnly: botsOnly ?? runner !== true }),
});

/**
 * Make one named token for the owner (createToken, and a bot's own token on
 * Agents › Bots): checked, mixed from both sources of randomness, and only its
 * SHA-256 stored. Returns the token, the one time it can be read.
 */
export async function mintToken(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: { entropy: string; scope: AgentScope; name: string; runner: boolean; botsOnly: boolean; onlyBot?: string },
) {
  const { entropy, scope, runner } = args;
  if (!ENTROPY.test(entropy)) throw new ConvexError(TOKEN_NOT_MADE);
  const cleaned = cleanClientName(args.name);
  const held = await tokensOf(ctx, userId);
  if (held.length >= MAX_AGENT_TOKENS) throw new ConvexError(CLIENT_WORDS.tooMany);
  if (runner) {
    if (scope !== "act") throw new ConvexError(CLIENT_WORDS.runnerActs);
    if (held.some(tokenIsRunner)) throw new ConvexError(CLIENT_WORDS.oneRunner);
  }

  const material = new TextEncoder().encode(entropy);
  const drawn = serverBytes();
  const mixed = new Uint8Array(drawn.length + material.length);
  mixed.set(drawn, 0);
  mixed.set(material, drawn.length);
  const token = agentTokenFrom(new Uint8Array(await crypto.subtle.digest("SHA-256", mixed)));
  const id = await ctx.db.insert("agentTokens", {
    userId,
    tokenHash: await hashToken(token),
    scope,
    name: cleaned,
    runner,
    botsOnly: args.botsOnly,
    ...(args.onlyBot === undefined ? null : { onlyBot: args.onlyBot }),
    createdAt: Date.now(),
  });
  return { token, id };
}

/**
 * Whether only the owner's bots may use one of the owner's clients (a named
 * token or an OAuth grant): one click on Settings › Connections. Only the
 * caller's own; one that is gone is no error.
 */
export const setBotsOnly = ownerMutation({
  args: { kind: v.union(v.literal("token"), v.literal("oauth")), id: v.string(), on: v.boolean() },
  handler: async (ctx, { kind, id, on }) => {
    if (kind === "token") {
      const tokenId = ctx.db.normalizeId("agentTokens", id);
      const row = tokenId === null ? null : await ctx.db.get(tokenId);
      if (row !== null && row.userId === ctx.owner._id) await ctx.db.patch(row._id, { botsOnly: on });
      return null;
    }
    const grantId = ctx.db.normalizeId("oauthGrants", id);
    const grant = grantId === null ? null : await ctx.db.get(grantId);
    if (grant !== null && grant.userId === ctx.owner._id) await ctx.db.patch(grant._id, { botsOnly: on });
    return null;
  },
});

/**
 * What one of the owner's clients may do (read, or read and act), changed in
 * place on Settings › Connections: its next call is checked against it, so a
 * client approved Read only needs no reconnecting to act, and one can be held
 * to reading at once. The Mac runner's token stays read and act (its tools
 * need it). Only the caller's own; one that is gone is no error.
 */
export const setScope = ownerMutation({
  args: { kind: v.union(v.literal("token"), v.literal("oauth")), id: v.string(), scope: agentScopeValidator },
  handler: async (ctx, { kind, id, scope }) => {
    if (kind === "token") {
      const tokenId = ctx.db.normalizeId("agentTokens", id);
      const row = tokenId === null ? null : await ctx.db.get(tokenId);
      if (row === null || row.userId !== ctx.owner._id) return null;
      if (scope !== "act" && tokenIsRunner(row)) throw new ConvexError(CLIENT_WORDS.runnerActs);
      await ctx.db.patch(row._id, { scope });
      return null;
    }
    const grantId = ctx.db.normalizeId("oauthGrants", id);
    const grant = grantId === null ? null : await ctx.db.get(grantId);
    if (grant !== null && grant.userId === ctx.owner._id) await ctx.db.patch(grant._id, { scope });
    return null;
  },
});

/**
 * Revoke one client: the next call it makes is refused, one in flight
 * included. A named token is deleted; an OAuth grant is deleted with its
 * access and refresh tokens. Only the caller's own; one already gone is no
 * error, so a double-click is safe. Every other client goes on working.
 */
export const revokeClient = ownerMutation({
  args: { kind: v.union(v.literal("token"), v.literal("oauth")), id: v.string() },
  handler: async (ctx, { kind, id }) => {
    if (kind === "token") {
      const tokenId = ctx.db.normalizeId("agentTokens", id);
      const row = tokenId === null ? null : await ctx.db.get(tokenId);
      if (row !== null && row.userId === ctx.owner._id) await ctx.db.delete(row._id);
      return null;
    }
    const grantId = ctx.db.normalizeId("oauthGrants", id);
    const grant = grantId === null ? null : await ctx.db.get(grantId);
    if (grant !== null && grant.userId === ctx.owner._id) await deleteGrant(ctx, grant._id);
    return null;
  },
});

/**
 * The caller's clients' latest calls, newest first: the tool, whether it
 * reads or acts, when, how it ended, how long it took, and which client. That
 * is all a row holds.
 */
export const recentCalls = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("agentCalls")
      .withIndex("by_userId_and_at", (q) => q.eq("userId", ctx.owner._id))
      .order("desc")
      .take(RECENT_AGENT_CALLS);
    const botNames = new Map<string, string>();
    for (const row of rows) {
      if (row.bot === undefined || botNames.has(row.bot)) continue;
      botNames.set(row.bot, (await botNamed(ctx, ctx.owner._id, row.bot))?.name ?? row.bot);
    }
    return rows.map((row) => ({
      id: row._id,
      tool: row.tool,
      kind: row.kind,
      at: row.at,
      outcome: row.outcome,
      durationMs: row.durationMs,
      /** Which agent said it was calling, where one did. */
      agent: row.agent ?? null,
      /** Which client made it, by the name it had then; null on rows from before clients had names. */
      client: row.clientName ?? null,
      /** Which of the owner's bots it was, by its name now (its id when the bot is gone). */
      bot: row.bot === undefined ? null : (botNames.get(row.bot) ?? row.bot),
    }));
  },
});

// ── For POST /mcp/v1 ────────────────────────────────────────────────────────
// The endpoint hands these the SHA-256 of what the client presented, never
// the credential itself.

/** Which client this is and what it may do, or null for a credential that is not honoured. */
export const holder = internalQuery({
  args: { credential: credentialValidator, now: v.number() },
  handler: async (ctx, { credential, now }) => {
    const known = await clientHolder(ctx, credential, now);
    return known === null
      ? null
      : {
          userId: known.member.user._id,
          scope: known.scope,
          runner: known.runner,
          // A token or grant made for one bot is bots-only whatever its setting says.
          botsOnly: known.botsOnly || known.onlyBot !== null,
        };
  },
});

/** Write a client's counters on the row they are kept on: its token's, or its grant's. */
const countOn = (ctx: MutationCtx, known: Holder, fields: Partial<LimitFields>) =>
  known.client.kind === "token"
    ? ctx.db.patch(known.client.id, fields)
    : ctx.db.patch(known.client.id, fields);

/**
 * Count one tool call against the client's limits and say whether it may
 * run. The client is looked up again, so one revoked since the request began
 * is refused here. In order: an unknown tool (a runner's tool is unknown to
 * any client but the Mac's) and an act asked of a read-only client are
 * counted (as calls) and turned away; a call over a limit is turned away
 * uncounted, and `note` is true for the first one in its window only, so a
 * caller stuck in a loop cannot fill the audit with refusals.
 */
export const admit = internalMutation({
  args: {
    credential: credentialValidator,
    name: v.string(),
    now: v.number(),
    /**
     * The bot the call names (an id of the right shape that is not one of the
     * four): admitted against that bot's profile, permissions and limits
     * (convex/lib/botStore.ts) instead of the client's own limits.
     */
    bot: v.optional(v.string()),
    /** Whether the call names one of Startup OS's own four (by header or argument) or a run of the Mac's. */
    four: v.optional(v.boolean()),
  },
  handler: async (ctx, { credential, name, now, bot, four }) => {
    const known = await clientHolder(ctx, credential, now);
    if (known === null) return { status: "unauthorized" as const };
    const row = known.limits;
    const who = {
      userId: known.member.user._id,
      client: known.client,
      clientName: known.name,
      runner: known.runner,
    };
    const tool = toolFor(name, known.runner);
    const kind = tool?.kind ?? ("read" as const);

    // A tool about the caller itself (`whoami`, `bot_rules`) is every caller's,
    // counted in a generous window of its own per (client, bot), not against
    // the client's or the bot's calls: a bot's profile is still asked, and a
    // client only bots may use answers it with no name too, so a bot that
    // forgot its name learns so instead of being refused. At most one answered
    // call and one refusal a window are written down (`quiet`, `note`).
    if (tool !== undefined && isCallerTool(tool.name)) {
      await countOn(ctx, known, { lastUsedAt: now });
      const admitted = await admitCallerTool(ctx, {
        userId: known.member.user._id,
        client: known.client,
        onlyBot: known.onlyBot,
        botId: bot,
        now,
      });
      const named = bot !== undefined && (await botNamed(ctx, who.userId, bot)) !== null ? { bot } : {};
      switch (admitted.status) {
        case "ok":
          return { status: "ok" as const, ...who, ...(bot === undefined ? null : { bot }), kind, quiet: admitted.quiet };
        case "bot_refused":
          return { status: "bot_refused" as const, ...who, ...named, kind, words: admitted.words, refusal: admitted.refusal, note: admitted.note };
        case "bot_limited":
          return { status: "bot_limited" as const, ...who, ...named, kind, words: admitted.words, refusal: admitted.refusal, note: admitted.note };
      }
    }

    // A client only the owner's bots may use (or one made for one bot): a call
    // naming no bot is refused, and so is one naming the four, unless this is the Mac runner's token (its
    // runner's own tools, which no bot may call, included). Counted against the
    // client's calls, so a loop of refusals stops at the limit like any other.
    // A token or grant made for one bot is bots-only whatever its setting says.
    const botsOnly = known.botsOnly || known.onlyBot !== null;
    if (bot === undefined && botsOnly && !(known.runner && (four === true || tool?.audience === "runner"))) {
      const window = nextWindow({ windowStart: row.windowStart, count: row.calls }, now, MAX_CALLS_PER_WINDOW);
      if (!window.allowed) {
        const note = row.limitNotedFor !== window.windowStart;
        if (note) await countOn(ctx, known, { limitNotedFor: window.windowStart });
        return { status: "limited" as const, ...who, kind, note };
      }
      await countOn(ctx, known, { windowStart: window.windowStart, calls: window.count, lastUsedAt: now });
      return {
        status: "bot_refused" as const,
        ...who,
        kind,
        words: four === true ? BOT_WORDS.botsOnlyFour : BOT_WORDS.botsOnly,
        refusal: { code: "bots_only" } as BotRefusal,
      };
    }

    if (bot !== undefined) {
      await countOn(ctx, known, { lastUsedAt: now });
      const admitted = await admitBot(ctx, {
        userId: known.member.user._id,
        client: known.client,
        onlyBot: known.onlyBot,
        scope: known.scope,
        botId: bot,
        tool: tool === undefined ? undefined : { name: tool.name, kind: tool.kind },
        now,
      });
      // The bot's id goes on the audit only once it matched a profile this client may use.
      const named = admitted.status === "bot_refused" && (await botNamed(ctx, who.userId, bot)) === null ? {} : { bot };
      switch (admitted.status) {
        case "bot_refused":
          return { status: "bot_refused" as const, ...who, ...named, kind, words: admitted.words, refusal: admitted.refusal };
        case "bot_limited":
          return {
            status: "bot_limited" as const,
            ...who,
            ...named,
            kind,
            words: admitted.words,
            note: admitted.note,
            refusal: admitted.refusal,
          };
        default:
          return { status: admitted.status, ...who, ...named, kind };
      }
    }

    // The chat's runner program checks in every few seconds: counted in a
    // window of its own, so it can neither use up a model's calls nor be
    // stopped by a model that used up its own.
    if (tool?.audience === "runner") {
      const window = nextWindow(
        { windowStart: row.runnerWindowStart, count: row.runnerCalls },
        now,
        MAX_RUNNER_CALLS_PER_WINDOW,
      );
      if (!window.allowed) {
        const note = row.runnerLimitNotedFor !== window.windowStart;
        if (note) await countOn(ctx, known, { runnerLimitNotedFor: window.windowStart });
        return { status: "runner_limited" as const, ...who, kind, note };
      }
      await countOn(ctx, known, { runnerWindowStart: window.windowStart, runnerCalls: window.count });
      return { status: known.scope === "act" ? ("ok" as const) : ("read_only" as const), ...who, kind };
    }

    const calls = nextWindow({ windowStart: row.windowStart, count: row.calls }, now, MAX_CALLS_PER_WINDOW);
    const limited = async (status: "limited" | "acts_limited", windowStart: number) => {
      const note = row.limitNotedFor !== windowStart;
      if (note) await countOn(ctx, known, { limitNotedFor: windowStart });
      return { status, ...who, kind, note };
    };
    if (!calls.allowed) return limited("limited", calls.windowStart);

    const counted = { windowStart: calls.windowStart, calls: calls.count, lastUsedAt: now };
    if (tool === undefined) {
      await countOn(ctx, known, counted);
      return { status: "unknown_tool" as const, ...who, kind };
    }
    if (tool.kind === "act") {
      if (known.scope !== "act") {
        await countOn(ctx, known, counted);
        return { status: "read_only" as const, ...who, kind };
      }
      const acts = nextWindow({ windowStart: row.actWindowStart, count: row.acts }, now, MAX_ACTS_PER_WINDOW);
      if (!acts.allowed) return limited("acts_limited", acts.windowStart);
      await countOn(ctx, known, { actWindowStart: acts.windowStart, acts: acts.count });
    }
    await countOn(ctx, known, counted);
    return { status: "ok" as const, ...who, kind };
  },
});

/**
 * Write down one call: a registered tool's name (anything else, and a
 * runner's tool called by another client, is "unknown", never what was
 * sent), its kind, when, how it ended, how long it took, and which client.
 * No argument, title, name or text has a field here.
 */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    at: v.number(),
    outcome: agentOutcomeValidator,
    durationMs: v.number(),
    /** Which agent the call said it was: one of the closed set, never text. */
    agent: v.optional(agentValidator),
    /** The Mac's run of that agent it was made in: an id the server handed out, checked before it is passed. */
    runId: v.optional(v.string()),
    /** The client, and its name as `admit` read it from the client's own row. */
    client: v.optional(agentClientValidator),
    clientName: v.optional(v.string()),
    /** Whether that client may call the runner's tools. */
    runner: v.optional(v.boolean()),
    /** The owner's bot that named itself: an id that matched a profile (admit says so), never text. */
    bot: v.optional(v.string()),
    /** A bot's refusal: its code, and a not-permitted call's area and level (botRules.auditOfRefusal). */
    refusal: v.optional(agentRefusalValidator),
    /** What the call said it cost (`costUsd`): kept only for a matched bot, and only from 0 to 100. */
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, { userId, name, at, outcome, durationMs, agent, runId, client, clientName, runner, bot, refusal, costUsd }) => {
    const tool = toolFor(name, runner === true);
    // A bot's id only once it matched a profile; a cost only a matched bot's.
    const matched = bot !== undefined && (await botNamed(ctx, userId, bot)) !== null ? bot : null;
    const cost = matched === null ? null : cleanCostUsd(costUsd);
    const took = Math.max(0, Math.round(durationMs));
    await ctx.db.insert("agentCalls", {
      userId,
      tool: tool?.name ?? UNKNOWN_TOOL,
      kind: tool?.kind ?? "read",
      at,
      outcome,
      durationMs: took,
      // One of the closed set (the endpoint passes nothing else), for a tool that exists.
      ...(agent !== undefined && tool !== undefined ? { agent } : null),
      ...(runId !== undefined && agent !== undefined && tool !== undefined ? { runId } : null),
      ...(client === undefined ? null : { client }),
      ...(clientName === undefined ? null : { clientName }),
      ...(matched === null ? null : { bot: matched }),
      ...(refusal === undefined || outcome !== "refused" ? null : { refusal }),
      ...(cost === null ? null : { costUsd: cost }),
    });
    if (matched !== null) {
      // The bot's day (convex/lib/botTelemetry.ts): its week outlives this table's pruning.
      const grantId = client?.kind === "oauth" ? ctx.db.normalizeId("oauthGrants", client.id) : null;
      const host = grantId === null ? null : ((await ctx.db.get(grantId))?.redirectHost ?? null);
      await noteBotCall(ctx, {
        userId,
        bot: matched,
        at,
        outcome,
        durationMs: took,
        costUsd: cost,
        provider: providerOf(clientName, host),
      });
    }
    return null;
  },
});

// ── The agents, and what they write ─────────────────────────────────────────
// The daily brief and the proposals the owner decides (convex/lib/briefs.ts,
// proposals.ts). All of it is
// the owner's alone. A query here never reads the clock: it returns times,
// and the page decides what is fresh.

/** The four agents: what each is called, what it does, and whether it is switched on. */
export const agents = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const off = await agentsOff(ctx);
    return AGENT_IDS.map((id) => ({
      id,
      name: AGENT_NAMES[id],
      line: AGENT_LINES[id],
      on: !off.includes(id),
    }));
  },
});

/**
 * Switch an agent on or off. One that is off is refused every write, from its
 * next call. The same change as the switch on /agents (`changeAgent`), so the
 * flip is recorded (`agentControlChanges`: who, when, before and after); the
 * four are seeded first where they have not been yet.
 */
export const setAgent = ownerMutation({
  args: { agent: agentValidator, on: v.boolean() },
  handler: async (ctx, { agent, on }) => {
    await ensureOsAgents(ctx, ctx.owner, Date.now());
    await changeAgent(ctx, ownerMember(ctx.owner), { project: STARTUP_OS_PROJECT, agentId: agent, enabled: on });
    return null;
  },
});

/** A company's latest brief with when it was written, or null. Whether it is still today's is the page's to say. */
export const brief = ownerQuery({
  args: { company: companyValidator },
  handler: (ctx, { company }) => latestBrief(ctx, company),
});

/**
 * A company's briefs for the Assistant's archive: the latest eight days on
 * record, newest first. The page keeps those of today and the seven days
 * before by its own clock; nothing here reads one.
 */
export const briefArchive = ownerQuery({
  args: { company: companyValidator },
  handler: (ctx, { company }) => recentBriefs(ctx, company),
});

/**
 * The approvals inbox (/approvals): everything that waits for the owner's
 * click, newest first. Every open proposal of the company named (both where
 * none is: the page, its navigation count, Today's "Needs you" and the Bots
 * tab all read it with none, so they agree), with what it would change before
 * and after where that is known; and every tool call a Startup OS run paused on
 * (`agentApprovals`), which belongs to no company and is always listed.
 * Deciding goes through the existing paths, one item at a time: `approve` /
 * `dismiss` here, the runtime's own `decide` for a tool call. Nothing here
 * reads the clock.
 */
export const inbox = ownerQuery({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, { company }) => {
    const proposals = (await inboxProposals(ctx, company === undefined ? companyIds() : [company])).map(
      (row) => ({
        ...row,
        source: "proposal" as const,
        tool: null,
        toolName: null,
        arguments: null,
      }),
    );
    const calls = (await waitingToolCalls(ctx.db)).map((row) => ({
      source: "tool_call" as const,
      id: row._id as string,
      agent: row.agentId,
      bot: null,
      kind: "tool_call" as const,
      company: null,
      reason: null,
      createdAt: row.createdAt,
      payload: null,
      about: null,
      changes: [],
      why: null,
      urgency: "normal" as const,
      goal: null,
      evidence: null,
      effect: null,
      cash: false,
      duplicate: null,
      tool: row.toolId,
      toolName: toolNamed(row.toolId)?.title ?? row.toolId,
      /** JSON text, as the model sent it: data, shown as text. */
      arguments: row.arguments,
    }));
    return [...proposals, ...calls].sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * /approvals' "Decided": what became of the proposals of both companies and of
 * the tool calls of Startup OS runs, decided at or after `since` (the page
 * names it, 30 days back by its clock: a query reads none), newest decision
 * first. A proposal says how it was decided (approved, dismissed with the
 * owner's code and words, expired, approved automatically, withdrawn with
 * its proposer's reason and note); a tool call whether it was approved or
 * denied, and the denial's words.
 */
export const decided = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const proposals = await decidedForOwner(ctx, companyIds(), since);
    const calls = (await decidedToolCalls(ctx.db, since, DECIDED_ROWS)).map((row) => ({
      source: "tool_call" as const,
      id: row._id as string,
      agent: row.agentId,
      bot: null,
      kind: "tool_call" as const,
      company: null,
      reason: null,
      createdAt: row.createdAt,
      payload: null,
      about: null,
      why: null,
      urgency: "normal" as const,
      goal: null,
      status: row.state === "approved" ? ("approved" as const) : ("denied" as const),
      decidedAt: row.decidedAt ?? null,
      rejectCode: null,
      rejectReason: row.denyReason ?? null,
      result: null,
      edited: false,
      edits: [],
      withdrawReason: null,
      withdrawNote: null,
      flagged: false,
      tool: row.toolId,
      toolName: toolNamed(row.toolId)?.title ?? row.toolId,
      /** JSON text, as the model sent it: data, shown as text. */
      arguments: row.arguments,
    }));
    const rows = [
      ...proposals.map((row) => ({ ...row, tool: null, toolName: null, arguments: null })),
      ...calls,
    ];
    return rows.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  },
});

/**
 * Approve a proposal, as it is or as the owner edited it: it is checked
 * against the live data again and carried out through the app's own
 * function, as the owner. One that no longer applies is refused with a
 * sentence and stays open. `proposal_decide` runs this same function.
 */
export const approve = ownerMutation({
  args: { id: v.id("proposals"), edit: v.optional(proposalPayloadValidator) },
  handler: (ctx, { id, edit }) =>
    approveProposal(ctx, ownerMember(ctx.owner), id, { now: Date.now(), ...(edit === undefined ? null : { edit }) }),
});

/**
 * Reject (dismiss) a proposal. A reason is required: a quick one (`code`, a
 * chip on /approvals), typed words (`reason`), or both. The next run reads it
 * through `proposals_feedback`. `proposal_decide` runs this same function.
 */
export const dismiss = ownerMutation({
  args: { id: v.id("proposals"), reason: v.optional(v.string()), code: v.optional(rejectCodeValidator) },
  handler: (ctx, { id, reason, code }) =>
    dismissProposal(
      ctx,
      id,
      { ...(reason === undefined ? null : { reason }), ...(code === undefined ? null : { code }) },
      Date.now(),
    ),
});

/**
 * What the agents did since a moment the page names (a query reads no
 * clock): briefs written, proposals made and tasks an agent made (what the
 * owner approved and rejected is the Bots tab's week, `bots.weeklyStats`). And how many people are in the OS on each
 * company (the owner and the teammates on it): a head count for the page's
 * one ratio, read from who a task can be given to and from nothing of payroll.
 */
export const measure = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const made = await ctx.db
      .query("tasks")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .take(2000);
    const member = ownerMember(ctx.owner);
    const people = { us: 0, kz: 0 };
    for (const company of companyIds()) {
      people[company] = (await assignablePeople(ctx, member, company)).length;
    }
    return {
      briefs: await briefsSince(ctx, since),
      proposed: await proposalsMadeSince(ctx, since),
      tasks: made.filter((task) => task.origin?.source === "agent").length,
      people,
    };
  },
});

/** Rows of each kind one sweep handles before it schedules its own next run. */
const SWEEP_BATCH = 200;

/**
 * Daily (convex/crons.ts): open proposals nobody decided in a week are
 * marked expired, and briefs, decided proposals and answered questions past
 * their keeping are deleted. A batch at a time; a run with more to do
 * schedules its own next one, with no arguments.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const more = [
      await sweepProposals(ctx, now, SWEEP_BATCH),
      await pruneBriefs(ctx, now, SWEEP_BATCH),
      await pruneQuestions(ctx, now, SWEEP_BATCH),
      await sweepChat(ctx, now, SWEEP_BATCH),
      // Near-duplicate checks older than 30 days (convex/lib/duplicates.ts).
      (await pruneDuplicateChecks(ctx, now)) === 500,
    ];
    if (more.some(Boolean)) await ctx.scheduler.runAfter(0, internal.assistant.sweep, {});
    return null;
  },
});

/** Rows one sweep deletes before it schedules its own next run. */
const PRUNE_BATCH = 500;

/**
 * Keep the audit to its newest `MAX_AGENT_CALLS` rows and to
 * `AGENT_CALL_RETENTION_DAYS`. Daily (convex/crons.ts), a batch at a time: a
 * run with more to delete schedules its own next one, with no arguments.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const newest = await ctx.db
      .query("agentCalls")
      .withIndex("by_at")
      .order("desc")
      .take(MAX_AGENT_CALLS);
    // Everything older than the oldest row kept, and everything past its age.
    const oldestKept = newest.length === MAX_AGENT_CALLS ? newest.at(-1)!.at : 0;
    const before = Math.max(oldestKept, now - AGENT_CALL_RETENTION_DAYS * DAY_MS);
    const old = await ctx.db
      .query("agentCalls")
      .withIndex("by_at", (q) => q.lt("at", before))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    // The bots' daily rollup, kept longer than the audit (convex/lib/botTelemetry.ts).
    const moreDays = await pruneBotCallDays(ctx, dayOf(now));
    if (old.length === PRUNE_BATCH || moreDays) await ctx.scheduler.runAfter(0, internal.assistant.prune, {});
    return null;
  },
});
