import { describe, expect, test } from "vitest";
import {
  BOT_VIEW_KEYS,
  agoText,
  DEFAULT_BOTS_VIEW,
  botFigures,
  filterCounts,
  nextBotSort,
  readBotsView,
  shownBots,
  writeBotsView,
  type BotLine,
} from "./bots-view";

const line = (botId: string, over: Partial<BotLine> = {}): BotLine => ({
  botId,
  name: `Made-up ${botId}`,
  role: "",
  enabled: true,
  suggested: false,
  refusalsToday: 0,
  idle: false,
  calls7d: null,
  approvalRate: null,
  errorRate7d: null,
  lastSeenDay: null,
  costMonthUsd: null,
  ...over,
});

describe("the Bots tab's view in the address", () => {
  test("nothing in the address is every bot, in the default order, nothing open", () => {
    expect(readBotsView(new URLSearchParams("view=bots"))).toEqual(DEFAULT_BOTS_VIEW);
  });

  test("a filter, a search, a sort, the open bot and the settings are read back", () => {
    const view = readBotsView(new URLSearchParams("view=bots&filter=idle&q=grow&sort=calls&dir=asc&bot=growth&settings=open"));
    expect(view).toEqual({ filter: "idle", q: "grow", sort: { key: "calls", dir: "asc" }, bot: "growth", settings: true });
  });

  test("anything the page does not know is left at its default", () => {
    const view = readBotsView(new URLSearchParams("filter=everything&sort=mood&dir=up&bot=Not%20an%20id!&settings=yes"));
    expect(view).toEqual(DEFAULT_BOTS_VIEW);
    // A sort with no direction is the larger first.
    expect(readBotsView(new URLSearchParams("sort=cost")).sort).toEqual({ key: "cost", dir: "desc" });
  });

  test("a long search is cut, not refused", () => {
    expect(readBotsView(new URLSearchParams(`q=${"a".repeat(200)}`)).q).toHaveLength(60);
  });

  test("writing keeps the page's other keys and only what differs from the default", () => {
    const base = new URLSearchParams("view=bots&filter=off&bot=old");
    expect(writeBotsView(base, { ...DEFAULT_BOTS_VIEW, bot: "growth" })).toBe("view=bots&bot=growth");
    expect(writeBotsView(base, { ...DEFAULT_BOTS_VIEW, filter: "refused", q: " grow ", sort: { key: "errors", dir: "asc" } })).toBe(
      "view=bots&filter=refused&q=grow&sort=errors&dir=asc",
    );
    expect(writeBotsView(base, { ...DEFAULT_BOTS_VIEW, settings: true })).toBe("view=bots&settings=open");
    // Every key it writes is one the Agents tab can clear.
    expect([...BOT_VIEW_KEYS].sort()).toEqual(["bot", "dir", "filter", "q", "settings", "sort"]);
  });
});

describe("which bots are shown, and in what order", () => {
  const bots = [
    line("quiet", { calls7d: 3 }),
    line("busy", { calls7d: 120 }),
    line("sleepy", { idle: true }),
    line("refused", { refusalsToday: 4, calls7d: 10 }),
    line("off", { enabled: false, calls7d: 50 }),
    line("new", { suggested: true, role: "Growth", calls7d: 1 }),
  ];

  test("by default, problems first: refused today, then idle, then the most calls", () => {
    expect(shownBots(bots, DEFAULT_BOTS_VIEW).map((b) => b.botId)).toEqual(["refused", "sleepy", "busy", "off", "quiet", "new"]);
  });

  test("each filter keeps its bots", () => {
    const ids = (filter: (typeof DEFAULT_BOTS_VIEW)["filter"]) =>
      shownBots(bots, { ...DEFAULT_BOTS_VIEW, filter }).map((b) => b.botId).sort();
    expect(ids("on")).toEqual(["busy", "new", "quiet", "refused", "sleepy"]);
    expect(ids("off")).toEqual(["off"]);
    expect(ids("idle")).toEqual(["sleepy"]);
    expect(ids("refused")).toEqual(["refused"]);
    expect(ids("suggested")).toEqual(["new"]);
  });

  test("the search reads the id, the name and the role, in any case", () => {
    expect(shownBots(bots, { ...DEFAULT_BOTS_VIEW, q: "GROWTH" }).map((b) => b.botId)).toEqual(["new"]);
    expect(shownBots(bots, { ...DEFAULT_BOTS_VIEW, q: "made-up bu" }).map((b) => b.botId)).toEqual(["busy"]);
  });

  test("a sort by a column puts a bot with nothing reported last, either way", () => {
    const desc = shownBots(bots, { ...DEFAULT_BOTS_VIEW, sort: { key: "calls", dir: "desc" } }).map((b) => b.botId);
    expect(desc).toEqual(["busy", "off", "refused", "quiet", "new", "sleepy"]);
    const asc = shownBots(bots, { ...DEFAULT_BOTS_VIEW, sort: { key: "calls", dir: "asc" } }).map((b) => b.botId);
    expect(asc).toEqual(["new", "quiet", "refused", "off", "busy", "sleepy"]);
  });

  test("the last seen sort reads the day; the cost sort what was reported", () => {
    const seen = [line("a", { lastSeenDay: "2026-10-02" }), line("b", { lastSeenDay: "2026-10-18" }), line("c")];
    expect(shownBots(seen, { ...DEFAULT_BOTS_VIEW, sort: { key: "seen", dir: "desc" } }).map((b) => b.botId)).toEqual(["b", "a", "c"]);
    const cost = [line("a", { costMonthUsd: 0.5 }), line("b"), line("c", { costMonthUsd: 2 })];
    expect(shownBots(cost, { ...DEFAULT_BOTS_VIEW, sort: { key: "cost", dir: "desc" } }).map((b) => b.botId)).toEqual(["c", "a", "b"]);
  });

  test("a header's click: larger first, then smaller first, then back to the default order", () => {
    expect(nextBotSort(null, "calls")).toEqual({ key: "calls", dir: "desc" });
    expect(nextBotSort({ key: "calls", dir: "desc" }, "calls")).toEqual({ key: "calls", dir: "asc" });
    expect(nextBotSort({ key: "calls", dir: "asc" }, "calls")).toBeNull();
    expect(nextBotSort({ key: "calls", dir: "asc" }, "errors")).toEqual({ key: "errors", dir: "desc" });
  });

  test("each filter chip's count", () => {
    expect(filterCounts(bots)).toEqual({ all: 6, on: 5, off: 1, idle: 1, refused: 1, suggested: 1 });
  });
});

describe("the figures over the table", () => {
  test("counts, the week's calls and today's refusals", () => {
    const figures = botFigures([
      line("a", { calls7d: 120, refusalsToday: 2 }),
      line("b", { enabled: false, calls7d: 5 }),
      line("c", { idle: true }),
    ]);
    expect(figures).toEqual({ bots: 3, on: 2, off: 1, idle: 1, calls7d: 125, refusedToday: 2 });
  });

  test("a week nobody reported a call for is not a zero", () => {
    expect(botFigures([line("a"), line("b")]).calls7d).toBeNull();
    expect(botFigures([]).calls7d).toBeNull();
  });
});

describe("when, in words", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  test("from just now to a day, then the UTC day", () => {
    expect(agoText(null, now)).toBe("Never");
    expect(agoText(now - 10_000, now)).toBe("Just now");
    expect(agoText(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(agoText(now - 3 * 86_400_000, now)).toBe("2026-10-15");
  });
});
