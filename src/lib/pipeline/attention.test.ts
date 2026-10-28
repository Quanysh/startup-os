import { describe, expect, test } from "vitest";
import { sortAttention, type AttentionItem } from "@/lib/metrics/scorecard";
import { pipelineAttention } from "./attention";
import type { PipelineBoard, PipelineCard } from "./derive";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);

let next = 0;
const card = (stage: string, daysAgo: number, extra: Partial<PipelineCard> = {}): PipelineCard => ({
  id: `c${next++}`,
  name: "Zzyzx Dental",
  stage,
  amount: null,
  lastActivityAt: NOW - daysAgo * DAY,
  closedAt: null,
  nextStep: "Call",
  ...extra,
});
const boardOf = (cards: PipelineCard[]): PipelineBoard => {
  const board: Record<string, PipelineCard[]> = {};
  for (const c of cards) (board[c.stage] ??= []).push(c);
  return board;
};
const NONE = { usDeals: {}, kzDeals: {}, investors: {} };

describe("pipelineAttention", () => {
  test("nothing quiet and nothing idle adds nothing", () => {
    expect(pipelineAttention(NONE, NOW)).toEqual([]);
    const busy = boardOf([card("demo", 2), card("won", 90), card("lost", 90)]);
    expect(pipelineAttention({ ...NONE, usDeals: busy }, NOW)).toEqual([]);
  });

  test("quiet deals are one line per market, with the count and the longest silence", () => {
    const us = boardOf([card("lead", 41), card("demo", 20), card("proposal", 3)]);
    const kz = boardOf([card("qualified", 15)]);
    expect(pipelineAttention({ ...NONE, usDeals: us, kzDeals: kz }, NOW)).toEqual([
      {
        id: "quiet-deals:us",
        severity: "stale",
        title: "2 US deals have gone quiet",
        detail: "No activity for more than 14 days. Longest: 41 days.",
        href: "/sales",
      },
      {
        id: "quiet-deals:kz",
        severity: "stale",
        title: "1 Kazakhstan deal has gone quiet",
        detail: "No activity for more than 14 days. Longest: 15 days.",
        href: "/sales",
      },
    ]);
  });

  test("a deal with no activity date is not called quiet", () => {
    const kz = boardOf([card("demo", 0, { lastActivityAt: null })]);
    expect(pipelineAttention({ ...NONE, kzDeals: kz }, NOW)).toEqual([]);
  });

  test("investors in conversation with nothing planned are one line", () => {
    const investors = boardOf([
      card("meeting", 1, { nextStep: null }),
      card("contacted", 1, { nextStep: " " }),
      card("target", 1, { nextStep: null }),
      card("passed", 1, { nextStep: null }),
    ]);
    expect(pipelineAttention({ ...NONE, investors }, NOW)).toEqual([
      {
        id: "investors-no-next-step",
        severity: "empty",
        title: "2 investors in conversation have no next step",
        detail: "Give each a next step, or move it to Passed.",
        href: "/fundraising",
      },
    ]);
  });

  test("one investor reads in the singular", () => {
    const investors = boardOf([card("meeting", 30, { nextStep: null })]);
    expect(pipelineAttention({ ...NONE, investors }, NOW).map((i) => i.title)).toEqual([
      "1 investor has gone quiet",
      "1 investor in conversation has no next step",
    ]);
  });

  test("quiet investors say how long", () => {
    const investors = boardOf([card("diligence", 22), card("contacted", 16)]);
    expect(pipelineAttention({ ...NONE, investors }, NOW)).toEqual([
      {
        id: "quiet-investors",
        severity: "stale",
        title: "2 investors have gone quiet",
        detail: "No activity for more than 14 days. Longest: 22 days.",
        href: "/fundraising",
      },
    ]);
  });

  test("a board that has not loaded adds nothing", () => {
    const us = boardOf([card("lead", 41)]);
    expect(
      pipelineAttention({ usDeals: us, kzDeals: undefined, investors: undefined }, NOW),
    ).toHaveLength(1);
    expect(
      pipelineAttention({ usDeals: undefined, kzDeals: us, investors: undefined }, NOW).map(
        (item) => item.id,
      ),
    ).toEqual(["quiet-deals:kz"]);
    expect(
      pipelineAttention({ usDeals: undefined, kzDeals: undefined, investors: undefined }, NOW),
    ).toEqual([]);
  });

  test("no company or person is named on the home page", () => {
    const board = boardOf([card("lead", 41), card("meeting", 41, { nextStep: null })]);
    const items = pipelineAttention({ usDeals: board, kzDeals: board, investors: board }, NOW);
    expect(items.length).toBeGreaterThan(2);
    expect(JSON.stringify(items)).not.toMatch(/zzyzx/i);
  });
});

describe("sortAttention", () => {
  const item = (id: string, severity: AttentionItem["severity"]): AttentionItem => ({
    id,
    severity,
    title: id,
    detail: "",
    href: "/",
  });

  test("failures first, then stale, then missing, each keeping the order it came in", () => {
    // The home page appends the pipeline items to the metric ones and sorts.
    const sorted = sortAttention([
      item("missing-metric", "empty"),
      item("stale-metric", "stale"),
      item("failed-source", "error"),
      item("quiet-deals:us", "stale"),
      item("investors-no-next-step", "empty"),
    ]);
    expect(sorted.map((i) => i.id)).toEqual([
      "failed-source",
      "stale-metric",
      "quiet-deals:us",
      "missing-metric",
      "investors-no-next-step",
    ]);
  });

  test("does not reorder the list it was given", () => {
    const given = [item("b", "empty"), item("a", "error")];
    sortAttention(given);
    expect(given.map((i) => i.id)).toEqual(["b", "a"]);
  });
});
