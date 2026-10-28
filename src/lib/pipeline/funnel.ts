// A board read as a funnel: how many cards sit in each stage and what their
// amounts add up to. For the dashboard, which shows counts and sums and never
// a card's name. Pure, and nothing here reads a clock.

import type { PipelineBoard } from "./derive";

export type FunnelRow = {
  id: string;
  title: string;
  /** Cards in the stage. Zero is a real zero: the board was read. */
  count: number;
  /** The sum of the amounts the stage's cards have; null when none has one. */
  value: number | null;
  /** Cards with no amount, which the sum leaves out. */
  withoutAmount: number;
};

/**
 * One row per stage asked for, in that order, titled as the board's column
 * is. A stage with no priced card has no sum: a missing number is not a zero.
 */
export function funnelRows(
  board: PipelineBoard,
  columns: readonly { id: string; title: string }[],
  stages: readonly string[],
): FunnelRow[] {
  return stages.map((id) => {
    const cards = board[id] ?? [];
    const priced = cards.filter((card) => card.amount !== null);
    return {
      id,
      title: columns.find((column) => column.id === id)?.title ?? id,
      count: cards.length,
      value: priced.length === 0 ? null : priced.reduce((sum, card) => sum + card.amount!, 0),
      withoutAmount: cards.length - priced.length,
    };
  });
}
