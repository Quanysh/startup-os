import { describe, expect, test } from "vitest";
import type { PipelineBoard, PipelineCard } from "./derive";
import { funnelRows } from "./funnel";
import { DEAL_COLUMNS, OPEN_DEAL_STAGES } from "./stages";

let seq = 0;
const card = (stage: string, amount: number | null): PipelineCard => ({
  id: `d${++seq}`,
  name: `SECRET DEAL ${seq}`,
  stage,
  amount,
  lastActivityAt: null,
  closedAt: null,
  nextStep: null,
});

describe("funnelRows", () => {
  test("one row per stage asked for, in that order, with the column's title", () => {
    const rows = funnelRows({}, DEAL_COLUMNS, OPEN_DEAL_STAGES);
    expect(rows.map((row) => [row.id, row.title])).toEqual([
      ["lead", "Lead"],
      ["qualified", "Qualified"],
      ["demo", "Demo"],
      ["proposal", "Proposal"],
    ]);
  });

  test("an empty stage counts none and has no sum: nothing was added up", () => {
    const [lead] = funnelRows({}, DEAL_COLUMNS, ["lead"]);
    expect(lead).toEqual({ id: "lead", title: "Lead", count: 0, value: null, withoutAmount: 0 });
  });

  test("a stage sums the amounts it has and counts the cards that have none", () => {
    const board: PipelineBoard = {
      lead: [card("lead", 400), card("lead", null), card("lead", 600)],
      demo: [card("demo", null)],
    };
    const rows = funnelRows(board, DEAL_COLUMNS, OPEN_DEAL_STAGES);
    expect(rows[0]).toMatchObject({ count: 3, value: 1000, withoutAmount: 1 });
    // No card priced: no sum, never a zero.
    expect(rows[2]).toMatchObject({ count: 1, value: null, withoutAmount: 1 });
  });

  test("a stated zero is a figure", () => {
    const [lead] = funnelRows({ lead: [card("lead", 0)] }, DEAL_COLUMNS, ["lead"]);
    expect(lead).toMatchObject({ count: 1, value: 0, withoutAmount: 0 });
  });

  test("stages not asked for, closed or unknown, are in no row", () => {
    const board: PipelineBoard = { won: [card("won", 5)], unmapped: [card("unmapped", 5)] };
    const rows = funnelRows(board, DEAL_COLUMNS, OPEN_DEAL_STAGES);
    expect(rows.every((row) => row.count === 0)).toBe(true);
  });

  test("a row carries no name from the board", () => {
    const rows = funnelRows({ lead: [card("lead", 1)] }, DEAL_COLUMNS, OPEN_DEAL_STAGES);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });
});
