// The owner's bots (convex/lib/botRules.ts): the external bots that call
// POST /mcp/v1 through a connected client and name themselves with
// `X-Startup-Agent` or an `agent` argument. Kept on /agents › Bots.
//
// Every public function is the owner's alone and answers about the caller's
// own bots. A locked area (sensitive, the owner's own, Today) can never be
// given: the schema's validator does not hold one and `cleanPermissions`
// refuses it again, so a crafted mutation cannot. Nothing here logs.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { clientHolder, credentialValidator, type ClientRef } from "./lib/agentToken";
import {
  BOT_ID,
  BOT_WORDS,
  DEFAULT_BOT_LIMITS,
  EXTERNAL_OWNER_AGENTS,
  RECENT_BOT_CALLS,
  externalProposerOf,
  isExternalOwnerAgent,
  REFUSALS_ALERT,
  MAX_BOTS,
  MAX_BOT_NAME,
  MAX_BOT_NOTE,
  MAX_BOT_ROLE,
  MAX_RULES_TEXT,
  SUGGESTED_BOTS,
  cleanBudget,
  cleanLimits,
  cleanPermissions,
  defaultPermissions,
  suggestedPermissions,
  type BotLimits,
} from "./lib/botRules";
import { latestRules, publishRules as publishRulesFor } from "./lib/botRuleVersions";
import { botListFilter, ensureExternalProfile, setBotLevel } from "./lib/botStore";
import { AGENT_IDS, isAgentId } from "./lib/agents";
import { MAX_CLIENT_NAME } from "./lib/agentRules";
import { botKey } from "./lib/handoffs";
import { mintToken } from "./assistant";
import { cleanRemote } from "./lib/mirrorRules";
import { deleteGrant } from "./lib/oauthStore";
import { ownerMutation, ownerQuery } from "./lib/owner";
import { proposerStats } from "./lib/proposals";
import { botCompanyValidator, botLimitsValidator } from "./schema";
import { botRegistry } from "./lib/botTelemetry";
import { isCanonicalPeriodStart } from "./lib/periods";

/** `today` that is not a UTC day. */
const NOT_A_DAY = "today is not a date";

/** The caller's bots: `MAX_BOTS` at most, a bounded read. */
async function botsOf(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("bots")
    .withIndex("by_userId_and_botId", (q) => q.eq("userId", userId))
    .take(MAX_BOTS + 5);
}

/** Fixed words from the rules, as the refusal the page shows. */
function rule<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : BOT_WORDS.badPermission);
  }
}

function cleanName(value: string): string {
  const name = cleanRemote(value, MAX_BOT_NAME + 2);
  if (name === "") throw new ConvexError(BOT_WORDS.nameMissing);
  if (name.length > MAX_BOT_NAME) throw new ConvexError(BOT_WORDS.nameTooLong);
  return name;
}

function cleanRole(value: string): string {
  const role = cleanRemote(value, MAX_BOT_ROLE + 2);
  if (role.length > MAX_BOT_ROLE) throw new ConvexError(BOT_WORDS.roleTooLong);
  return role;
}

/** Clients the browser chose: "any", or the owner's own named tokens and sign-ins. */
async function cleanClients(
  ctx: QueryCtx,
  userId: Id<"users">,
  given: "any" | { kind: "token" | "oauth"; id: string }[],
): Promise<Doc<"bots">["clients"]> {
  if (given === "any") return "any";
  const out: ClientRef[] = [];
  for (const client of given.slice(0, 40)) {
    if (client.kind === "token") {
      const id = ctx.db.normalizeId("agentTokens", client.id);
      const row = id === null ? null : await ctx.db.get(id);
      if (row === null || row.userId !== userId) throw new ConvexError(BOT_WORDS.badClient);
      if (!out.some((c) => c.id === row._id)) out.push({ kind: "token", id: row._id });
    } else {
      const id = ctx.db.normalizeId("oauthGrants", client.id);
      const row = id === null ? null : await ctx.db.get(id);
      if (row === null || row.userId !== userId) throw new ConvexError(BOT_WORDS.badClient);
      if (!out.some((c) => c.id === row._id)) out.push({ kind: "oauth", id: row._id });
    }
  }
  if (out.length === 0) throw new ConvexError(BOT_WORDS.badClient);
  return out;
}

/**
 * Refuse an id or a name that another bot already goes by, written another
 * way (`botKey`: "Growth Bot", "growth-bot" and "growth_bot" are one), and an
 * id that is one of the four's written another way. Bots that share a client
 * name themselves, so two bots one key apart could be taken for each other
 * (a handoff's sender and addressee are matched by key).
 */
function requireOwnKeys(held: readonly Doc<"bots">[], self: Id<"bots"> | null, botId: string, name: string) {
  // An external owner-agent's own row keeps its id (chief_of_staff, engineering).
  const ownExternal = self !== null && isExternalOwnerAgent(botId);
  if (!ownExternal && AGENT_IDS.some((agent) => botKey(agent) === botKey(botId))) throw new ConvexError(BOT_WORDS.reserved);
  const mine = new Set([botKey(botId), botKey(name)].filter((key) => key !== ""));
  for (const other of held) {
    if (other._id === self) continue;
    if ([botKey(other.botId), botKey(other.name)].some((key) => mine.has(key))) throw new ConvexError(BOT_WORDS.keyTaken);
  }
}

const permissionsArg = v.array(v.object({ area: v.string(), level: v.string() }));
const clientsArg = v.union(
  v.literal("any"),
  v.array(v.object({ kind: v.union(v.literal("token"), v.literal("oauth")), id: v.string() })),
);

/**
 * The caller's bots, by name: each one's id, name, role, clients, permissions
 * and limits, and from its counters (summed over its clients) when it last
 * called and its calls and refusals on `today` (the page's UTC day: a query
 * reads no clock).
 */
export const list = ownerQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const bots = await botsOf(ctx, ctx.owner._id);
    const out = [];
    for (const bot of bots) {
      const usage = await ctx.db
        .query("botUsage")
        .withIndex("by_userId_and_bot", (q) => q.eq("userId", ctx.owner._id).eq("bot", bot.botId))
        .take(50);
      let lastCallAt: number | null = null;
      let callsToday = 0;
      let refusalsToday = 0;
      for (const row of usage) {
        if (row.lastCallAt !== undefined && (lastCallAt === null || row.lastCallAt > lastCallAt)) lastCallAt = row.lastCallAt;
        if (row.day === today) {
          callsToday += row.callsToday ?? 0;
          refusalsToday += row.refusalsToday ?? 0;
        }
      }
      out.push({
        id: bot._id,
        botId: bot.botId,
        name: bot.name,
        role: bot.role,
        clients: bot.clients === "any" ? ("any" as const) : bot.clients.map((c) => ({ kind: c.kind, id: c.id as string })),
        permissions: bot.permissions,
        limits: bot.limits,
        enabled: bot.enabled,
        suggested: bot.suggested,
        company: bot.company ?? null,
        monthlyBudgetUsd: bot.monthlyBudgetUsd ?? null,
        lastCallAt,
        callsToday,
        refusalsToday,
      });
    }
    const missing = SUGGESTED_BOTS.filter((s) => !bots.some((b) => b.botId === s.id)).length;
    return {
      bots: out.sort((a, b) => a.name.localeCompare(b.name)),
      suggestedMissing: missing,
      // The external owner-agent profiles not there yet (each made at its first call, or below).
      externalMissing: EXTERNAL_OWNER_AGENTS.filter((id) => !bots.some((b) => b.botId === id)),
    };
  },
});

/**
 * Make an external owner-agent's profile (chief_of_staff or engineering) now,
 * with its defaults, so the owner can set it before its first call (Bot Loop
 * v3, A). One that exists is left as it is.
 */
export const addExternalProfile = ownerMutation({
  args: { id: v.union(...EXTERNAL_OWNER_AGENTS.map((id) => v.literal(id))) },
  handler: async (ctx, { id }) => {
    // The owner's own click: made switched on (a first call makes it off).
    await ensureExternalProfile(ctx, ctx.owner._id, id, Date.now(), true);
    return null;
  },
});

async function insertBot(
  ctx: MutationCtx,
  userId: Id<"users">,
  bot: Omit<Doc<"bots">, "_id" | "_creationTime" | "userId" | "createdAt" | "updatedAt">,
  now: number,
) {
  return await ctx.db.insert("bots", { userId, ...bot, createdAt: now, updatedAt: now });
}

/**
 * Each proposer's week on /approvals, for the Bots tab: decided, approved,
 * rejected and expired, the approval rate, the median time to the owner's
 * decision and the three commonest reasons for a rejection (codes only, never
 * the owner's words). `since` is the page's clock less a week: a query reads none.
 */
export const weeklyStats = ownerQuery({
  args: { since: v.number() },
  handler: (ctx, { since }) => proposerStats(ctx, since),
});

/**
 * Each bot's last seven days and this month, for the Bots tab (Bot Loop v3, J):
 * the `agents` read's own rows (convex/lib/botTelemetry.ts), up to `today`,
 * the page's UTC day (a query reads no clock).
 */
export const telemetry = ownerQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    if (!isCanonicalPeriodStart("day", today)) throw new ConvexError(NOT_A_DAY);
    return await botRegistry(ctx, ctx.owner._id, today);
  },
});

/**
 * Add a bot. A new bot reads every area a bot may read and writes none,
 * with the default limits, unless the owner chose otherwise.
 */
export const create = ownerMutation({
  args: {
    botId: v.string(),
    name: v.string(),
    role: v.string(),
    clients: v.optional(clientsArg),
    permissions: v.optional(permissionsArg),
    limits: v.optional(botLimitsValidator),
    company: v.optional(botCompanyValidator),
    monthlyBudgetUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const botId = args.botId.trim();
    if (!BOT_ID.test(botId)) throw new ConvexError(BOT_WORDS.badId);
    if (isAgentId(botId)) throw new ConvexError(BOT_WORDS.reserved);
    const held = await botsOf(ctx, ctx.owner._id);
    if (held.length >= MAX_BOTS) throw new ConvexError(BOT_WORDS.tooMany);
    if (held.some((b) => b.botId === botId)) throw new ConvexError(BOT_WORDS.taken);
    const name = cleanName(args.name);
    requireOwnKeys(held, null, botId, name);
    const id = await insertBot(
      ctx,
      ctx.owner._id,
      {
        botId,
        name,
        role: cleanRole(args.role),
        clients: await cleanClients(ctx, ctx.owner._id, args.clients ?? "any"),
        permissions: args.permissions === undefined ? defaultPermissions() : rule(() => cleanPermissions(args.permissions!)),
        limits: args.limits === undefined ? DEFAULT_BOT_LIMITS : rule(() => cleanLimits(args.limits as BotLimits)),
        enabled: true,
        suggested: false,
        ...(args.company === undefined ? null : { company: args.company }),
        ...(args.monthlyBudgetUsd === undefined ? null : { monthlyBudgetUsd: rule(() => cleanBudget(args.monthlyBudgetUsd!)) }),
      },
      Date.now(),
    );
    return { id };
  },
});

/** The fields of a bot that are not what it is or may do: changing them keeps a suggested bot suggested. */
const BOOKKEEPING = new Set<string>(["enabled", "company", "monthlyBudgetUsd"]);

/** Change a bot: only the fields sent. A suggested bot the owner edits is no longer marked suggested. */
export const update = ownerMutation({
  args: {
    id: v.id("bots"),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    clients: v.optional(clientsArg),
    permissions: v.optional(permissionsArg),
    limits: v.optional(botLimitsValidator),
    enabled: v.optional(v.boolean()),
    /** The company it works for (Bot Loop v3, J). */
    company: v.optional(botCompanyValidator),
    /** Its monthly budget in USD; null takes it away. */
    monthlyBudgetUsd: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const bot = await ctx.db.get(args.id);
    if (bot === null || bot.userId !== ctx.owner._id) throw new ConvexError(BOT_WORDS.gone);
    const changes: Partial<Doc<"bots">> = {};
    if (args.name !== undefined) {
      changes.name = cleanName(args.name);
      requireOwnKeys(await botsOf(ctx, ctx.owner._id), bot._id, bot.botId, changes.name);
    }
    if (args.role !== undefined) changes.role = cleanRole(args.role);
    if (args.clients !== undefined) changes.clients = await cleanClients(ctx, ctx.owner._id, args.clients);
    if (args.permissions !== undefined) changes.permissions = rule(() => cleanPermissions(args.permissions!));
    if (args.limits !== undefined) changes.limits = rule(() => cleanLimits(args.limits!));
    if (args.enabled !== undefined) changes.enabled = args.enabled;
    if (args.company !== undefined) changes.company = args.company;
    // null takes the budget away (a patch with `undefined` removes the field).
    if (args.monthlyBudgetUsd !== undefined) {
      changes.monthlyBudgetUsd = args.monthlyBudgetUsd === null ? undefined : rule(() => cleanBudget(args.monthlyBudgetUsd!));
    }
    // A suggested bot stays one until what it is or may do changes: not for its switch, company or budget.
    const edited = Object.keys(changes).some((key) => !BOOKKEEPING.has(key));
    await ctx.db.patch(bot._id, { ...changes, ...(edited ? { suggested: false } : null), updatedAt: Date.now() });
    return null;
  },
});

/** Rows read when a bot is removed: its trust (one per kind), its grants, the owner's clients. */
const REMOVE_BATCH = 500;

/**
 * Remove a bot and everything that was its: its counters, its earned trust,
 * its autonomy grants (revoked by the owner, kept for the record) and the
 * credentials made for it alone (tokens and OAuth grants with its `onlyBot`,
 * with the grants' tokens), so the same id made again starts clean and an
 * old credential is refused. Its calls and proposals on record keep its id.
 */
export const remove = ownerMutation({
  args: { id: v.id("bots") },
  handler: async (ctx, { id }) => {
    const bot = await ctx.db.get(id);
    if (bot === null || bot.userId !== ctx.owner._id) return null;
    const now = Date.now();
    const usage = await ctx.db
      .query("botUsage")
      .withIndex("by_userId_and_bot", (q) => q.eq("userId", ctx.owner._id).eq("bot", bot.botId))
      .take(100);
    for (const row of usage) await ctx.db.delete(row._id);
    // Its trust is kept as its proposer (an external profile's is `bot:<id>`), never the Mac agent's of that id.
    const proposer = isExternalOwnerAgent(bot.botId) ? externalProposerOf(bot.botId) : bot.botId;
    const grants = await ctx.db
      .query("autonomyGrants")
      .withIndex("by_proposer_and_kind_and_revokedAt", (q) => q.eq("proposer", proposer))
      .take(REMOVE_BATCH);
    for (const grant of grants) {
      if (grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: now, revokedBy: "owner" });
    }
    const trust = await ctx.db
      .query("botTrust")
      .withIndex("by_proposer_and_kind", (q) => q.eq("proposer", proposer))
      .take(REMOVE_BATCH);
    for (const row of trust) await ctx.db.delete(row._id);
    const tokens = await ctx.db
      .query("agentTokens")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.owner._id))
      .take(REMOVE_BATCH);
    for (const token of tokens) if (token.onlyBot === bot.botId) await ctx.db.delete(token._id);
    const signIns = await ctx.db
      .query("oauthGrants")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.owner._id))
      .take(REMOVE_BATCH);
    for (const grant of signIns) if (grant.onlyBot === bot.botId) await deleteGrant(ctx, grant._id);
    await ctx.db.delete(bot._id);
    return null;
  },
});

/**
 * Add the suggested bots the owner does not have yet (by id), each marked
 * suggested, on any client, with the default limits. One the owner has is
 * left as it is. Returns how many were added.
 */
export const addSuggested = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const held = await botsOf(ctx, ctx.owner._id);
    const now = Date.now();
    let added = 0;
    for (const suggestion of SUGGESTED_BOTS) {
      if (held.some((b) => b.botId === suggestion.id)) continue;
      if (held.length + added >= MAX_BOTS) break;
      await insertBot(
        ctx,
        ctx.owner._id,
        {
          botId: suggestion.id,
          name: suggestion.name,
          role: suggestion.role,
          clients: "any",
          permissions: suggestedPermissions(suggestion),
          limits: DEFAULT_BOT_LIMITS,
          enabled: true,
          suggested: true,
        },
        now,
      );
      added += 1;
    }
    return { added };
  },
});

/**
 * Make a named token for one bot and make it that bot's only client: the
 * token is bots-only and made for this bot alone (no other bot may call
 * through it), so a bot that takes a static token is kept apart from the
 * others. It acts only when the bot writes something. The bot's previous
 * tokens made for it alone are revoked (`revoked` says how many): a bot has
 * one live static token, so a leaked one is ended by making a new one. Its
 * OAuth sign-ins are left as they are. Returns the token, the one time it can
 * be read.
 */
export const makeToken = ownerMutation({
  args: { id: v.id("bots"), entropy: v.string() },
  handler: async (ctx, { id, entropy }) => {
    const bot = await ctx.db.get(id);
    if (bot === null || bot.userId !== ctx.owner._id) throw new ConvexError(BOT_WORDS.gone);
    const before = await ctx.db
      .query("agentTokens")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.owner._id))
      .take(REMOVE_BATCH);
    let revoked = 0;
    for (const token of before) {
      if (token.onlyBot !== bot.botId) continue;
      await ctx.db.delete(token._id);
      revoked += 1;
    }
    const made = await mintToken(ctx, ctx.owner._id, {
      entropy,
      scope: bot.permissions.some((p) => p.level === "write") ? "act" : "read",
      name: bot.name.slice(0, MAX_CLIENT_NAME),
      runner: false,
      botsOnly: true,
      onlyBot: bot.botId,
    });
    await ctx.db.patch(bot._id, { clients: [{ kind: "token", id: made.id }], updatedAt: Date.now() });
    return { ...made, revoked };
  },
});

/** Refused calls the activity reads for one bot in a day: enough to group, bounded. */
const REFUSALS_READ = 500;

/**
 * Each bot's activity for the Bots tab: its last calls (tool, outcome, when,
 * a refusal's code) and its refusals since `since` (the page's start of the
 * UTC day: a query reads no clock), grouped by code and, for a tool it may not
 * call, by the area and level it would need. From the audit: no content.
 */
export const activity = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const out = [];
    for (const bot of await botsOf(ctx, ctx.owner._id)) {
      const calls = ctx.db
        .query("agentCalls")
        .withIndex("by_userId_and_bot_and_at", (q) => q.eq("userId", ctx.owner._id).eq("bot", bot.botId));
      const recent = await calls.order("desc").take(RECENT_BOT_CALLS);
      const today = await ctx.db
        .query("agentCalls")
        .withIndex("by_userId_and_bot_and_at", (q) => q.eq("userId", ctx.owner._id).eq("bot", bot.botId).gte("at", since))
        .order("desc")
        .take(REFUSALS_READ);
      const groups = new Map<string, { code: string; area: string | null; need: string | null; count: number }>();
      for (const row of today) {
        if (row.outcome !== "refused" || row.refusal === undefined) continue;
        const key = `${row.refusal.code}:${row.refusal.area ?? ""}:${row.refusal.need ?? ""}`;
        const group = groups.get(key) ?? { code: row.refusal.code, area: row.refusal.area ?? null, need: row.refusal.need ?? null, count: 0 };
        group.count += 1;
        groups.set(key, group);
      }
      out.push({
        id: bot._id,
        botId: bot.botId,
        recent: recent.map((row) => ({
          id: row._id,
          tool: row.tool,
          outcome: row.outcome,
          at: row.at,
          code: row.refusal?.code ?? null,
        })),
        refusals: [...groups.values()].sort((a, b) => b.count - a.count),
      });
    }
    return out;
  },
});

/**
 * The bots refused more than `REFUSALS_ALERT` times since `since` (the page's
 * clock less an hour): a row each of the owner's "Needs you".
 */
export const refusedLately = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const out = [];
    for (const bot of await botsOf(ctx, ctx.owner._id)) {
      const rows = await ctx.db
        .query("agentCalls")
        .withIndex("by_userId_and_bot_and_at", (q) => q.eq("userId", ctx.owner._id).eq("bot", bot.botId).gte("at", since))
        .take(REFUSALS_READ);
      const refusals = rows.filter((row) => row.outcome === "refused").length;
      if (refusals > REFUSALS_ALERT) out.push({ id: bot._id, botId: bot.botId, name: bot.name, refusals });
    }
    return out.sort((a, b) => b.refusals - a.refusals);
  },
});

/**
 * Give a bot one level on one area in one click (the Bots tab's Grant, beside
 * a repeated "not permitted"): what an approved `permission_request` runs.
 * Never a locked area.
 */
export const grant = ownerMutation({
  args: { id: v.id("bots"), area: v.string(), level: v.union(v.literal("read"), v.literal("write")) },
  handler: async (ctx, { id, area, level }) => {
    const bot = await ctx.db.get(id);
    if (bot === null || bot.userId !== ctx.owner._id) throw new ConvexError(BOT_WORDS.gone);
    await setBotLevel(ctx, bot, area, level, Date.now());
    return null;
  },
});

/**
 * For `tools/list` (convex/mcp.ts): the permissions of the bot a client
 * names, or null when it is no bot this client may use. The credential is
 * asked again here.
 */
export const permissionsFor = internalQuery({
  args: { credential: credentialValidator, now: v.number(), bot: v.string() },
  handler: async (ctx, { credential, now, bot }) => {
    const known = await clientHolder(ctx, credential, now);
    if (known === null) return null;
    return await botListFilter(ctx, known.member.user._id, known.client, bot, known.onlyBot);
  },
});


// ── The rules for the bots ──────────────────────────────────────────────────

/** Rules text as the owner typed it: control characters but line breaks dropped, ends trimmed. */
const cleanRulesText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n?/g, "\n").trim();

/**
 * The rules the bots are given, as last published: the version (0 before the
 * first publish), when, the text for every bot and each bot's own note.
 */
export const rules = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const latest = await latestRules(ctx, ctx.owner._id);
    return latest === null
      ? { version: 0, publishedAt: null, rules: "", notes: [] as { bot: string; text: string }[] }
      : { version: latest.version, publishedAt: latest.publishedAt, rules: latest.rules, notes: latest.notes };
  },
});

/**
 * Publish the rules as the next version: the text for every bot and a note
 * for any of the owner's bots (an empty note is dropped). Every bot is given
 * the new version on its next `whoami` or `bot_rules`. Returns the version.
 */
export const publishRules = ownerMutation({
  args: { rules: v.string(), notes: v.array(v.object({ bot: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    if (args.rules.length > MAX_RULES_TEXT || args.notes.length > MAX_BOTS) throw new ConvexError(BOT_WORDS.rulesTooLong);
    const text = cleanRulesText(args.rules);
    const held = await botsOf(ctx, ctx.owner._id);
    const notes: { bot: string; text: string }[] = [];
    for (const note of args.notes) {
      if (note.text.length > MAX_BOT_NOTE) throw new ConvexError(BOT_WORDS.rulesTooLong);
      if (!held.some((bot) => bot.botId === note.bot)) throw new ConvexError(BOT_WORDS.gone);
      const cleaned = cleanRulesText(note.text);
      if (cleaned !== "" && !notes.some((n) => n.bot === note.bot)) notes.push({ bot: note.bot, text: cleaned });
    }
    const version = await publishRulesFor(ctx, ctx.owner._id, text, notes, Date.now());
    return { version };
  },
});
