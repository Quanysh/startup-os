// What `whoami` answers (convex/lib/mcpTools.ts): who Startup OS takes the
// caller for, what it may do, what is left of its limits in the current
// window, the address it should use and the rules it is to follow. Every
// caller may ask, at no limit's cost (`CALLER_TOOLS`), so a bot learns all of
// it before a refusal does.
//
// Runs only inside Convex: never import it from the UI. Reads only; never the
// clock (`now` is handed in). Nothing here logs.

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CALL_WINDOW_MS, MAX_ACTS_PER_WINDOW, MAX_CALLS_PER_WINDOW, type AgentScope } from "./agentRules";
import type { ClientRef } from "./agentToken";
import { CLIENT_BOT_CEILING, botAddressOf, clientKey, utcDayOf } from "./botRules";
import { rulesForBot, type RulesForBot } from "./botRuleVersions";
import { CEILING, botNamed, botRefusal } from "./botStore";
import { PRODUCT } from "./identity";
import { siteOrigin } from "./oauthRules";
import { MAX_OPEN_PER_BOT } from "./agents";
import { AUTONOMY_ELIGIBLE, activeGrant, grantPausedOn, isAutonomyEligible } from "./trust";

/** The client a call came through, as the endpoint matched it: handed to the tool, never sent by the call. */
export type CallerView = {
  client: ClientRef;
  name: string;
  scope: AgentScope;
  botsOnly: boolean;
  onlyBot: string | null;
  /** The bot whose own address the call was made at, if any. */
  address: string | null;
};

type Counted = { windowStart?: number | undefined; count?: number | undefined };

/** A window's count as of `now`: what is used, what is left and when it resets (null when nothing is counted yet). */
function left({ windowStart, count }: Counted, max: number, now: number) {
  const open = windowStart !== undefined && now >= windowStart && now - windowStart < CALL_WINDOW_MS;
  const used = open ? (count ?? 0) : 0;
  return {
    max,
    used,
    remaining: Math.max(0, max - used),
    resetsAt: open ? new Date(windowStart + CALL_WINDOW_MS).toISOString() : null,
  };
}

const NOTE_BOT =
  `${PRODUCT.name} takes you for this bot on every call through this client. Follow the rules below; a tool outside your permissions is refused.`;
const NOTE_NO_BOT_ONLY =
  "You named no bot, and this client is for bots only: use your own connector address (Agents › Bots), or send `agent: <your bot id>` with every call.";
const NOTE_NO_BOT = "You named no bot: you act as this client, with its own limits.";

export async function whoamiFor(
  ctx: QueryCtx,
  userId: Id<"users">,
  caller: CallerView,
  call: { bot: string | null; agent: string | null; now: number },
) {
  const { now } = call;
  const origin = siteOrigin(process.env.SITE_URL);
  const client = {
    name: caller.name,
    kind: caller.client.kind,
    scope: caller.scope,
    botsOnly: caller.botsOnly,
  };

  const profile = call.bot === null ? null : await botNamed(ctx, userId, call.bot);
  if (profile === null || botRefusal(profile, caller.client, caller.onlyBot) !== null) {
    const row = await ctx.db.get(caller.client.id);
    return {
      bot: null,
      agent: call.agent,
      client,
      address: null,
      permissions: null,
      limits:
        row === null
          ? null
          : {
              calls: left({ windowStart: row.windowStart, count: row.calls }, MAX_CALLS_PER_WINDOW, now),
              changes: left({ windowStart: row.actWindowStart, count: row.acts }, MAX_ACTS_PER_WINDOW, now),
            },
      autoApproved: null,
      rules: (await rulesForBot(ctx, userId, null)) as RulesForBot | null,
      note: caller.botsOnly ? NOTE_NO_BOT_ONLY : NOTE_NO_BOT,
    };
  }

  const key = clientKey(caller.client);
  const usage = await ctx.db
    .query("botUsage")
    .withIndex("by_client_and_bot", (q) => q.eq("client", key).eq("bot", profile.botId))
    .unique();
  const ceiling = await ctx.db
    .query("botUsage")
    .withIndex("by_client_and_bot", (q) => q.eq("client", key).eq("bot", CEILING))
    .unique();
  const today = utcDayOf(now);
  const proposalsUsed = usage?.day === today ? (usage.proposals ?? 0) : 0;
  // Its proposals waiting on the owner (Approvals v2's bucket: no more while full).
  const open = (
    await ctx.db
      .query("proposals")
      .withIndex("by_bot_and_status", (q) => q.eq("bot", profile.botId).eq("status", "open"))
      .take(MAX_OPEN_PER_BOT)
  ).length;
  // The kinds the owner lets it do without approval (earned autonomy), as they hold now.
  const autoApproved: string[] = [];
  for (const kind of AUTONOMY_ELIGIBLE) {
    if (!isAutonomyEligible(kind)) continue;
    const grant = await activeGrant(ctx, profile.botId, kind);
    // A grant paused for want of write on the kind's area gives nothing yet.
    if (grant !== null && grant.userId === userId && (await grantPausedOn(ctx, userId, profile.botId, kind)) === null) {
      autoApproved.push(kind);
    }
  }
  return {
    bot: { id: profile.botId, name: profile.name, role: profile.role },
    agent: null,
    client,
    address: origin === null ? null : botAddressOf(origin, profile.botId),
    // Through a read-only client a bot never acts, whatever its profile says.
    permissions: profile.permissions.map((p) => ({
      area: p.area,
      level: p.level === "write" && caller.scope !== "act" ? ("read" as const) : p.level,
    })),
    limits: {
      calls: left({ windowStart: usage?.windowStart, count: usage?.calls }, profile.limits.callsPer10Min, now),
      changes: left({ windowStart: usage?.actWindowStart, count: usage?.acts }, profile.limits.changesPer10Min, now),
      proposalsToday: {
        max: profile.limits.proposalsPerDay,
        used: proposalsUsed,
        remaining: Math.max(0, profile.limits.proposalsPerDay - proposalsUsed),
        resetsAt: new Date(Date.parse(`${today}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString(),
      },
      proposalsOpen: { max: MAX_OPEN_PER_BOT, used: open, remaining: Math.max(0, MAX_OPEN_PER_BOT - open) },
      clientCalls: left({ windowStart: ceiling?.windowStart, count: ceiling?.calls }, CLIENT_BOT_CEILING.callsPer10Min, now),
      clientChanges: left(
        { windowStart: ceiling?.actWindowStart, count: ceiling?.acts },
        CLIENT_BOT_CEILING.changesPer10Min,
        now,
      ),
    },
    /** Kinds of proposal approved the moment it makes them (earned autonomy); every other waits for the owner. */
    autoApproved,
    rules: await rulesForBot(ctx, userId, profile.botId),
    note: NOTE_BOT,
  };
}
