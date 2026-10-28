// The owner's bots as a registry with telemetry (Bot Loop v3, J; spec §13):
// one row a bot profile for the `agents` read and the Bots tab, with its last
// seven UTC days of calls, its approval rate and the cost it reported this
// month. Runs only inside Convex (eslint closes it to the UI).
//
// The week is read from `botCallDays`, a rollup written beside each audit row
// of a matched bot (`noteBotCall`, from `assistant.record`), never from
// `agentCalls` itself: that table is pruned to its newest 500 rows, so a busy
// day would shorten a week. The rollup holds counts, a duration histogram,
// the cost a bot reported and a closed provider word: no argument, name or text.
//
// A figure nothing was reported for is null, never 0. A query here reads no
// clock: it is handed the caller's UTC day.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { addDays, dayOf, monthStartOf } from "./agentControl";
import { MAX_BOTS, type BotCompany } from "./botRules";

export { cleanCostUsd, MAX_CALL_COST_USD } from "./botRules";
import { proposerStats } from "./proposals";

/** The days a bot's week is. */
export const TELEMETRY_DAYS = 7;
/** The days a bot's daily rollup is kept: past a month, so this month's cost is whole. */
export const BOT_CALL_DAYS_KEPT = 40;
/** Why a month's cost is null: the bot reported none (an external bot is priced where it runs). */
export const COST_NOT_REPORTED = "external_not_reported";
/** Who answers for every bot: the owner (never the owner's address, which a bot reading `agents` would see). */
export const BOT_OWNER = "owner";

/**
 * The upper edges of the duration buckets, in milliseconds. A call slower
 * than the last edge lands in one bucket past it, and the p95 there is the
 * slowest call itself (`maxMs`).
 */
export const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

export type BotProvider = "external_grok" | "external";
type Outcome = Doc<"agentCalls">["outcome"];

/**
 * The provider a bot's call came through, from its client: Grok when the
 * client's name or the host it signed in from says so, else external. A
 * closed word, never the client's name.
 */
export function providerOf(name: string | undefined, host: string | null): BotProvider {
  return /grok/i.test(`${name ?? ""} ${host ?? ""}`) ? "external_grok" : "external";
}

/** The bucket a duration falls in: its index, or one past the last edge. */
export function bucketOf(ms: number): number {
  const at = DURATION_BUCKETS_MS.findIndex((edge) => ms <= edge);
  return at === -1 ? DURATION_BUCKETS_MS.length : at;
}

/**
 * The 95th percentile of a histogram: the upper edge of the bucket it falls
 * in, never above the slowest call (`maxMs`), and the slowest call itself past
 * the last edge. Null with no calls.
 */
export function p95Of(buckets: readonly number[], maxMs: number): number | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i]!;
    if (seen >= target) return i < DURATION_BUCKETS_MS.length ? Math.min(DURATION_BUCKETS_MS[i]!, maxMs) : maxMs;
  }
  return maxMs;
}

const emptyBuckets = () => Array.from({ length: DURATION_BUCKETS_MS.length + 1 }, () => 0);
const rate = (part: number, whole: number) => Math.round((part / whole) * 10_000) / 10_000;
const money = (usd: number) => Math.round(usd * 10_000) / 10_000;

/**
 * Add one written call of a matched bot to its day's rollup. `costUsd` is a
 * cleaned report (`cleanCostUsd`, botRules.ts) or null. Called by `assistant.record` only,
 * after the audit row, for a bot whose profile matched.
 */
export async function noteBotCall(
  ctx: MutationCtx,
  call: {
    userId: Id<"users">;
    bot: string;
    at: number;
    outcome: Outcome;
    durationMs: number;
    costUsd: number | null;
    provider: BotProvider;
  },
): Promise<void> {
  const day = dayOf(call.at);
  const row = await ctx.db
    .query("botCallDays")
    .withIndex("by_userId_and_bot_and_day", (q) => q.eq("userId", call.userId).eq("bot", call.bot).eq("day", day))
    .first();
  const buckets = row === null ? emptyBuckets() : [...row.buckets];
  while (buckets.length < DURATION_BUCKETS_MS.length + 1) buckets.push(0);
  buckets[bucketOf(call.durationMs)]! += 1;
  const next = {
    calls: (row?.calls ?? 0) + 1,
    errors: (row?.errors ?? 0) + (call.outcome === "error" ? 1 : 0),
    invalid: (row?.invalid ?? 0) + (call.outcome === "invalid" ? 1 : 0),
    refused: (row?.refused ?? 0) + (call.outcome === "refused" ? 1 : 0),
    buckets,
    maxMs: Math.max(row?.maxMs ?? 0, call.durationMs),
    costUsd: (row?.costUsd ?? 0) + (call.costUsd ?? 0),
    costCalls: (row?.costCalls ?? 0) + (call.costUsd === null ? 0 : 1),
    lastAt: Math.max(row?.lastAt ?? 0, call.at),
    provider: call.provider,
  };
  if (row === null) await ctx.db.insert("botCallDays", { userId: call.userId, bot: call.bot, day, ...next });
  else await ctx.db.patch(row._id, next);
}

/** Rollup rows one prune deletes before it schedules its next run. */
const PRUNE_DAYS_BATCH = 500;

/** Delete rollup rows older than `BOT_CALL_DAYS_KEPT` days: whether there are more to delete. */
export async function pruneBotCallDays(ctx: MutationCtx, today: string): Promise<boolean> {
  const before = addDays(today, -BOT_CALL_DAYS_KEPT);
  const old = await ctx.db
    .query("botCallDays")
    .withIndex("by_day", (q) => q.lt("day", before))
    .take(PRUNE_DAYS_BATCH);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length === PRUNE_DAYS_BATCH;
}

export type BotTelemetry = {
  provider: BotProvider;
  calls7d: number | null;
  errorRate7d: number | null;
  schemaFailureRate7d: number | null;
  p95Ms7d: number | null;
  lastSeenDay: string | null;
  /** No call in the last seven days (never called included). */
  idle7d: boolean;
  costMonthUsd: number | null;
  costWhy: typeof COST_NOT_REPORTED | null;
};

/**
 * One bot's week and month from its rollup, up to `today` (the caller's UTC
 * day). One bounded read: its newest rows up to `today`, one a day, enough for
 * a whole month.
 */
export async function telemetryOf(ctx: QueryCtx, userId: Id<"users">, bot: string, today: string): Promise<BotTelemetry> {
  const rows = await ctx.db
    .query("botCallDays")
    .withIndex("by_userId_and_bot_and_day", (q) => q.eq("userId", userId).eq("bot", bot).lte("day", today))
    .order("desc")
    .take(BOT_CALL_DAYS_KEPT);
  const weekFrom = addDays(today, -(TELEMETRY_DAYS - 1));
  const monthFrom = monthStartOf(today);
  const week = rows.filter((row) => row.day >= weekFrom && row.calls > 0);
  const month = rows.filter((row) => row.day >= monthFrom);
  const calls = week.reduce((sum, row) => sum + row.calls, 0);
  const buckets = emptyBuckets();
  for (const row of week) row.buckets.forEach((n, i) => (buckets[Math.min(i, buckets.length - 1)]! += n));
  const reported = month.reduce((sum, row) => sum + row.costCalls, 0);
  const newest = rows.find((row) => row.calls > 0) ?? null;
  return {
    provider: newest?.provider ?? "external",
    calls7d: calls === 0 ? null : calls,
    errorRate7d: calls === 0 ? null : rate(week.reduce((sum, row) => sum + row.errors, 0), calls),
    schemaFailureRate7d: calls === 0 ? null : rate(week.reduce((sum, row) => sum + row.invalid, 0), calls),
    p95Ms7d: calls === 0 ? null : p95Of(buckets, Math.max(...week.map((row) => row.maxMs))),
    lastSeenDay: newest?.day ?? null,
    idle7d: calls === 0,
    costMonthUsd: reported === 0 ? null : money(month.reduce((sum, row) => sum + row.costUsd, 0)),
    costWhy: reported === 0 ? COST_NOT_REPORTED : null,
  };
}

export type BotRegistryRow = BotTelemetry & {
  botId: string;
  name: string;
  owner: typeof BOT_OWNER;
  company: BotCompany | null;
  monthlyBudgetUsd: number | null;
  enabled: boolean;
  /** Approved of approved and rejected, over the week's decided proposals: null with none decided. */
  approvalRate: number | null;
};

/**
 * Every bot profile of the owner's (the external chief of staff and
 * engineering included), by id, with its telemetry up to `today` and its
 * approval rate over the same seven days (`proposerStats`, keyed `bot:<id>`).
 */
export async function botRegistry(ctx: QueryCtx, userId: Id<"users">, today: string): Promise<BotRegistryRow[]> {
  const bots = await ctx.db
    .query("bots")
    .withIndex("by_userId_and_botId", (q) => q.eq("userId", userId))
    .take(MAX_BOTS + 5);
  const since = Date.parse(`${addDays(today, -(TELEMETRY_DAYS - 1))}T00:00:00Z`);
  const stats = new Map((await proposerStats(ctx, since)).map((stat) => [stat.key, stat.approvalRate]));
  const out: BotRegistryRow[] = [];
  for (const bot of bots) {
    out.push({
      botId: bot.botId,
      name: bot.name,
      owner: BOT_OWNER,
      company: bot.company ?? null,
      monthlyBudgetUsd: bot.monthlyBudgetUsd ?? null,
      enabled: bot.enabled,
      approvalRate: stats.get(`bot:${bot.botId}`) ?? null,
      ...(await telemetryOf(ctx, userId, bot.botId, today)),
    });
  }
  return out;
}
