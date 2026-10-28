import { describe, expect, test } from "vitest";
import {
  DEAL_STALE_DAYS,
  INVESTOR_STALE_DAYS,
  WIN_RATE_MIN_CLOSED,
  WIN_RATE_WINDOW_DAYS,
  coverageNeeded,
  daysSince,
  investorSummary,
  pipelineValue,
  quietCards,
  quietDeals,
  quietness,
  winRate,
  type PipelineBoard,
  type PipelineCard,
} from "./derive";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);
const ago = (days: number) => NOW - days * DAY;

let next = 0;
const card = (stage: string, extra: Partial<PipelineCard> = {}): PipelineCard => ({
  id: `c${next++}`,
  name: `Card ${next}`,
  stage,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: "Call",
  ...extra,
});
const boardOf = (cards: PipelineCard[]): PipelineBoard => {
  const board: Record<string, PipelineCard[]> = {};
  for (const c of cards) (board[c.stage] ??= []).push(c);
  return board;
};

describe("the decisions", () => {
  test("thresholds are the ones the plan settled", () => {
    expect(DEAL_STALE_DAYS).toBe(14);
    expect(INVESTOR_STALE_DAYS).toBe(14);
    expect(WIN_RATE_WINDOW_DAYS).toBe(180);
    expect(WIN_RATE_MIN_CLOSED).toBe(10);
  });
});

describe("daysSince and quietness", () => {
  test("counts whole days, and never goes negative", () => {
    expect(daysSince(NOW, NOW)).toBe(0);
    expect(daysSince(NOW, ago(1) + 1)).toBe(0);
    expect(daysSince(NOW, ago(1))).toBe(1);
    expect(daysSince(NOW, ago(14.5))).toBe(14);
    expect(daysSince(NOW, NOW + DAY)).toBe(0);
  });

  test("quiet means more than the limit, not the limit itself", () => {
    expect(quietness({ lastActivityAt: ago(14) }, NOW, 14)).toEqual({ kind: "active", days: 14 });
    expect(quietness({ lastActivityAt: ago(14.9) }, NOW, 14)).toEqual({ kind: "active", days: 14 });
    expect(quietness({ lastActivityAt: ago(15) }, NOW, 14)).toEqual({ kind: "quiet", days: 15 });
  });

  test("a card with no activity date is neither quiet nor active", () => {
    expect(quietness({ lastActivityAt: null }, NOW, 14)).toEqual({ kind: "undated" });
  });

  test("quiet cards are listed longest silence first, and undated ones are counted apart", () => {
    const cards = [
      card("lead", { id: "a", name: "A", lastActivityAt: ago(20) }),
      card("lead", { id: "b", name: "B", lastActivityAt: ago(3) }),
      card("lead", { id: "c", name: "C", lastActivityAt: ago(41) }),
      card("lead", { id: "d", name: "D", lastActivityAt: null }),
    ];
    expect(quietCards(cards, NOW, 14)).toEqual({
      of: 4,
      quiet: [
        { id: "c", name: "C", days: 41 },
        { id: "a", name: "A", days: 20 },
      ],
      undated: 1,
    });
  });
});

describe("pipelineValue", () => {
  test("sums the monthly fees of open deals, unweighted", () => {
    const board = boardOf([
      card("lead", { amount: 300 }),
      card("qualified", { amount: 500 }),
      card("demo", { amount: 450 }),
      card("proposal", { amount: 750 }),
    ]);
    expect(pipelineValue(board)).toEqual({ open: 4, value: 2_000, withoutAmount: 0, unsorted: 0 });
  });

  test("won and lost deals are not pipeline", () => {
    const board = boardOf([
      card("demo", { amount: 400 }),
      card("won", { amount: 9_000 }),
      card("lost", { amount: 9_000 }),
    ]);
    expect(pipelineValue(board)).toMatchObject({ open: 1, value: 400 });
  });

  test("a deal with no amount is left out and counted, not added as zero", () => {
    const board = boardOf([card("demo", { amount: 400 }), card("lead"), card("lead")]);
    expect(pipelineValue(board)).toEqual({ open: 3, value: 400, withoutAmount: 2, unsorted: 0 });
  });

  test("with no amount on any open deal there is no value, not $0", () => {
    expect(pipelineValue(boardOf([card("lead"), card("demo")]))).toEqual({
      open: 2,
      value: null,
      withoutAmount: 2,
      unsorted: 0,
    });
  });

  test("an amount of zero is a real amount", () => {
    expect(pipelineValue(boardOf([card("lead", { amount: 0 })]))).toMatchObject({
      value: 0,
      withoutAmount: 0,
    });
  });

  test("an empty board has no open deals and no value", () => {
    expect(pipelineValue({})).toEqual({ open: 0, value: null, withoutAmount: 0, unsorted: 0 });
  });

  test("deals in a stage the OS does not know are in no sum, and counted", () => {
    const board = boardOf([card("demo", { amount: 400 }), card("unmapped", { amount: 9_000 })]);
    expect(pipelineValue(board)).toEqual({ open: 1, value: 400, withoutAmount: 0, unsorted: 1 });
  });
});

describe("winRate", () => {
  const closed = (stage: "won" | "lost", daysAgo: number) => card(stage, { closedAt: ago(daysAgo) });

  test("won over won plus lost, among deals closed in the window", () => {
    const board = boardOf([closed("won", 10), closed("lost", 20), closed("lost", 30), closed("lost", 40)]);
    expect(winRate(board, NOW)).toEqual({ kind: "value", rate: 0.25, won: 1, lost: 3, undated: 0 });
  });

  test("open deals do not count against it", () => {
    const board = boardOf([closed("won", 10), card("demo"), card("lead")]);
    expect(winRate(board, NOW)).toMatchObject({ rate: 1, won: 1, lost: 0 });
  });

  test("a deal closed before the window is left out; one on its first day is in", () => {
    const board = boardOf([
      closed("won", WIN_RATE_WINDOW_DAYS),
      closed("lost", WIN_RATE_WINDOW_DAYS + 1),
      closed("lost", 400),
    ]);
    expect(winRate(board, NOW)).toEqual({ kind: "value", rate: 1, won: 1, lost: 0, undated: 0 });
  });

  test("the window can be given", () => {
    const board = boardOf([closed("won", 10), closed("lost", 60)]);
    expect(winRate(board, NOW, 30)).toMatchObject({ won: 1, lost: 0 });
  });

  test("with nothing closed in the window there is no rate, not 0%", () => {
    expect(winRate({}, NOW)).toEqual({ kind: "none", undated: 0 });
    expect(winRate(boardOf([card("demo"), closed("lost", 400)]), NOW)).toEqual({
      kind: "none",
      undated: 0,
    });
  });

  test("nothing won among deals that did close is a real 0%", () => {
    expect(winRate(boardOf([closed("lost", 5), closed("lost", 6)]), NOW)).toEqual({
      kind: "value",
      rate: 0,
      won: 0,
      lost: 2,
      undated: 0,
    });
  });

  test("a closed deal with no close date is left out and counted", () => {
    // A mirrored deal the CRM gave no date for cannot be placed in the window.
    const board = boardOf([closed("won", 5), card("lost"), card("won")]);
    expect(winRate(board, NOW)).toEqual({ kind: "value", rate: 1, won: 1, lost: 0, undated: 2 });
    expect(winRate(boardOf([card("lost")]), NOW)).toEqual({ kind: "none", undated: 1 });
  });
});

describe("coverageNeeded", () => {
  test("is one over the win rate", () => {
    expect(
      coverageNeeded({ kind: "value", rate: 0.25, won: 3, lost: 9, undated: 0 }),
    ).toEqual({ kind: "value", multiple: 4, closed: 12 });
  });

  test("with no win rate there is nothing to give", () => {
    expect(coverageNeeded({ kind: "none", undated: 0 })).toEqual({ kind: "none" });
  });

  test("with no wins it is said in words: there is no finite multiple", () => {
    expect(coverageNeeded({ kind: "value", rate: 0, won: 0, lost: 4, undated: 0 })).toEqual({
      kind: "no_wins",
      closed: 4,
    });
  });
});

describe("quietDeals", () => {
  test("judges open deals only", () => {
    const board = boardOf([
      card("lead", { id: "a", name: "A", lastActivityAt: ago(30) }),
      card("proposal", { id: "b", name: "B", lastActivityAt: ago(2) }),
      card("won", { lastActivityAt: ago(90), closedAt: ago(90) }),
      card("lost", { lastActivityAt: ago(90), closedAt: ago(90) }),
      card("unmapped", { lastActivityAt: ago(90) }),
    ]);
    expect(quietDeals(board, NOW)).toEqual({
      of: 2,
      quiet: [{ id: "a", name: "A", days: 30 }],
      undated: 0,
    });
  });
});

describe("investorSummary", () => {
  test("counts who is in conversation, who is still to contact, and what is committed", () => {
    const board = boardOf([
      card("target"),
      card("target"),
      card("contacted"),
      card("meeting"),
      card("diligence"),
      card("committed", { amount: 250_000, closedAt: ago(3) }),
      card("committed", { amount: 100_000, closedAt: ago(9) }),
      card("passed", { closedAt: ago(9) }),
    ]);
    expect(investorSummary(board, NOW)).toMatchObject({
      active: 3,
      targets: 2,
      committed: { count: 2, value: 350_000, withoutAmount: 0 },
      unsorted: 0,
    });
  });

  test("a commitment with no amount is left out of the sum and counted", () => {
    const board = boardOf([card("committed", { amount: 250_000 }), card("committed")]);
    expect(investorSummary(board, NOW).committed).toEqual({
      count: 2,
      value: 250_000,
      withoutAmount: 1,
    });
    expect(investorSummary(boardOf([card("committed")]), NOW).committed).toEqual({
      count: 1,
      value: null,
      withoutAmount: 1,
    });
  });

  test("only investors in conversation can go quiet or lack a next step", () => {
    const board = boardOf([
      card("target", { lastActivityAt: ago(90), nextStep: null }),
      card("contacted", { id: "q", name: "Quiet Fund", lastActivityAt: ago(21) }),
      card("meeting", { id: "n", name: "No Plan Capital", nextStep: null }),
      card("diligence", { id: "b", name: "Blank Ventures", nextStep: "   " }),
      card("committed", { lastActivityAt: ago(90), nextStep: null }),
      card("passed", { lastActivityAt: ago(90), nextStep: null }),
    ]);
    const summary = investorSummary(board, NOW);
    expect(summary.quiet).toEqual({
      of: 3,
      quiet: [{ id: "q", name: "Quiet Fund", days: 21 }],
      undated: 0,
    });
    expect(summary.noNextStep).toEqual([
      { id: "n", name: "No Plan Capital" },
      { id: "b", name: "Blank Ventures" },
    ]);
  });

  test("an empty board is all zeros and no committed value", () => {
    expect(investorSummary({}, NOW)).toEqual({
      active: 0,
      targets: 0,
      committed: { count: 0, value: null, withoutAmount: 0 },
      quiet: { of: 0, quiet: [], undated: 0 },
      noNextStep: [],
      unsorted: 0,
    });
  });

  test("investors in a stage the OS does not know are counted apart", () => {
    expect(investorSummary(boardOf([card("unmapped"), card("unmapped")]), NOW).unsorted).toBe(2);
  });
});
