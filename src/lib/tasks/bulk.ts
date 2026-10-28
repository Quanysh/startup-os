// Changing several cards at once. Each card goes through the same mutation a
// single change does (`tasks.move`, `tasks.update`, `tasks.remove`), one after
// another, so every check, notification and Telegram message is exactly as
// for one card; what was refused is said in the server's own sentence.

import { messageOf } from "@/lib/errors";

/** The most cards one bulk action touches. */
export const MAX_SELECTED = 50;

export type Outcome = { id: string; ok: true } | { id: string; ok: false; reason: string };

/** Run `act` for each id in turn, never two at once, and note how each went. */
export async function runBulk(
  ids: readonly string[],
  act: (id: string) => Promise<unknown>,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const id of ids) {
    try {
      await act(id);
      outcomes.push({ id, ok: true });
    } catch (failure) {
      outcomes.push({ id, ok: false, reason: messageOf(failure, "That change could not be saved.") });
    }
  }
  return outcomes;
}

/** "3 moved", or "2 moved, 1 refused: <the server's sentence>". */
export function bulkReport(outcomes: readonly Outcome[], done: (count: number) => string): string {
  const accepted = outcomes.filter((outcome) => outcome.ok).length;
  const reasons = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
  if (reasons.length === 0) return done(accepted);
  const refused = `${reasons.length} refused: ${[...new Set(reasons)].join(" ")}`;
  return accepted === 0 ? refused : `${done(accepted)}, ${refused}`;
}
