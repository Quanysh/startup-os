// Agents › Bots' view: which bots are shown (a filter and a search), in what
// order (problems first, or a column the owner sorted by), which one is open
// and whether "Settings for every bot" is. It lives in the address
// (`readBotsView` / `writeBotsView`), beside the page's own `view=bots`; the
// narrowing and the order are worked out here, on the rows already sent.

import { BOT_ID } from "@convex/lib/botRules";

export const BOT_FILTERS = ["all", "on", "off", "idle", "refused", "suggested"] as const;
export type BotFilter = (typeof BOT_FILTERS)[number];

export const BOT_FILTER_LABELS: Record<BotFilter, string> = {
  all: "All",
  on: "On",
  off: "Off",
  idle: "Idle",
  refused: "Refusals today",
  suggested: "Suggested",
};

export const BOT_SORT_KEYS = ["calls", "approval", "errors", "seen", "cost"] as const;
export type BotSortKey = (typeof BOT_SORT_KEYS)[number];
export type BotSort = { key: BotSortKey; dir: "asc" | "desc" } | null;

export type BotsView = {
  filter: BotFilter;
  /** What the owner typed to find a bot: matched against its id, name and role. */
  q: string;
  sort: BotSort;
  /** The open bot's id (`botId`), or none. */
  bot: string | null;
  /** "Settings for every bot" open. */
  settings: boolean;
};

export const DEFAULT_BOTS_VIEW: BotsView = { filter: "all", q: "", sort: null, bot: null, settings: false };

/** Every key the view writes: the Agents tab clears them. */
export const BOT_VIEW_KEYS = ["filter", "q", "sort", "dir", "bot", "settings"] as const;

/** A search longer than any bot's name is cut, not refused. */
const MAX_SEARCH = 60;

const isFilter = (value: string): value is BotFilter => (BOT_FILTERS as readonly string[]).includes(value);
const isSortKey = (value: string): value is BotSortKey => (BOT_SORT_KEYS as readonly string[]).includes(value);

export function readBotsView(params: URLSearchParams): BotsView {
  const filter = params.get("filter") ?? "";
  const sort = params.get("sort") ?? "";
  const bot = params.get("bot") ?? "";
  return {
    filter: isFilter(filter) ? filter : "all",
    q: (params.get("q") ?? "").slice(0, MAX_SEARCH),
    sort: isSortKey(sort) ? { key: sort, dir: params.get("dir") === "asc" ? "asc" : "desc" } : null,
    bot: BOT_ID.test(bot) ? bot : null,
    settings: params.get("settings") === "open",
  };
}

/** The query string for a view: the page's other keys kept, then only what differs from the default. */
export function writeBotsView(base: URLSearchParams, view: BotsView): string {
  const params = new URLSearchParams(base.toString());
  for (const key of BOT_VIEW_KEYS) params.delete(key);
  if (view.filter !== "all") params.set("filter", view.filter);
  const q = view.q.trim().slice(0, MAX_SEARCH);
  if (q !== "") params.set("q", q);
  if (view.sort !== null) {
    params.set("sort", view.sort.key);
    params.set("dir", view.sort.dir);
  }
  if (view.bot !== null) params.set("bot", view.bot);
  if (view.settings) params.set("settings", "open");
  return params.toString();
}

/** A header's click: the larger first, then the smaller first, then back to the default order. */
export function nextBotSort(current: BotSort, key: BotSortKey): BotSort {
  if (current?.key !== key) return { key, dir: "desc" };
  return current.dir === "desc" ? { key, dir: "asc" } : null;
}

export function ariaSortOf(sort: BotSort, key: BotSortKey): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/**
 * One bot as the table reads it: its profile and today's counts
 * (`bots.list`) with its seven days (`bots.telemetry`). A figure nothing was
 * reported for is null, never 0.
 */
export type BotLine = {
  botId: string;
  name: string;
  role: string;
  enabled: boolean;
  suggested: boolean;
  refusalsToday: number;
  /** No call in seven days. */
  idle: boolean;
  calls7d: number | null;
  approvalRate: number | null;
  errorRate7d: number | null;
  lastSeenDay: string | null;
  costMonthUsd: number | null;
};

const keeps: Record<BotFilter, (bot: BotLine) => boolean> = {
  all: () => true,
  on: (bot) => bot.enabled,
  off: (bot) => !bot.enabled,
  idle: (bot) => bot.idle,
  refused: (bot) => bot.refusalsToday > 0,
  suggested: (bot) => bot.suggested,
};

export function filterCounts(bots: readonly BotLine[]): Record<BotFilter, number> {
  return Object.fromEntries(BOT_FILTERS.map((filter) => [filter, bots.filter(keeps[filter]).length])) as Record<
    BotFilter,
    number
  >;
}

const valueOf: Record<BotSortKey, (bot: BotLine) => number | string | null> = {
  calls: (bot) => bot.calls7d,
  approval: (bot) => bot.approvalRate,
  errors: (bot) => bot.errorRate7d,
  seen: (bot) => bot.lastSeenDay,
  cost: (bot) => bot.costMonthUsd,
};

const compare = (a: number | string, b: number | string) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

/** Problems first: refused today (most first), then idle, then the most calls this week, then by name. */
function problemsFirst(a: BotLine, b: BotLine): number {
  if (a.refusalsToday !== b.refusalsToday) return b.refusalsToday - a.refusalsToday;
  if (a.idle !== b.idle) return a.idle ? -1 : 1;
  const calls = (b.calls7d ?? -1) - (a.calls7d ?? -1);
  return calls !== 0 ? calls : a.name.localeCompare(b.name);
}

/** The bots the view shows, in its order. A bot with nothing reported for the sorted column goes last either way. */
export function shownBots<T extends BotLine>(bots: readonly T[], view: Pick<BotsView, "filter" | "q" | "sort">): T[] {
  const q = view.q.trim().toLowerCase();
  const kept = bots.filter(
    (bot) =>
      keeps[view.filter](bot) &&
      (q === "" || [bot.botId, bot.name, bot.role].some((field) => field.toLowerCase().includes(q))),
  );
  const { sort } = view;
  if (sort === null) return kept.sort(problemsFirst);
  const pick = valueOf[sort.key];
  return kept.sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null || y === null) return x === y ? problemsFirst(a, b) : x === null ? 1 : -1;
    const order = sort.dir === "asc" ? compare(x, y) : compare(y, x);
    return order !== 0 ? order : problemsFirst(a, b);
  });
}

export type BotFigures = {
  bots: number;
  on: number;
  off: number;
  idle: number;
  /** The week's calls of every bot; null when none was reported for any. */
  calls7d: number | null;
  refusedToday: number;
};

export function botFigures(bots: readonly BotLine[]): BotFigures {
  const reported = bots.filter((bot) => bot.calls7d !== null);
  return {
    bots: bots.length,
    on: bots.filter((bot) => bot.enabled).length,
    off: bots.filter((bot) => !bot.enabled).length,
    idle: bots.filter((bot) => bot.idle).length,
    calls7d: reported.length === 0 ? null : reported.reduce((sum, bot) => sum + (bot.calls7d ?? 0), 0),
    refusedToday: bots.reduce((sum, bot) => sum + bot.refusalsToday, 0),
  };
}

/** When something happened, short: "Just now", "5 min ago", "3 h ago", else its UTC day; "Never" for nothing. */
export function agoText(at: number | null, now: number): string {
  if (at === null) return "Never";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toISOString().slice(0, 10);
}
