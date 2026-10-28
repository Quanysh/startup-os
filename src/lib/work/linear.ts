// Linear's issues arranged for the board. Pure.

import type { RecordOf } from "@convex/lib/mirrorRules";
import type { BoardColumn } from "@/components/board/board";

export type LinearIssue = RecordOf<"issue">;
/** A board card: the issue, with the `id` the board keys on. */
export type LinearCard = LinearIssue & { id: string };
export type LinearColumnId = LinearIssue["stateType"];

// Every column keeps its own order (by priority, then newest), and nothing
// can be dragged: the board shows where Linear has each issue.
export const LINEAR_COLUMNS = [
  { id: "backlog", title: "Backlog", sortable: false },
  { id: "unstarted", title: "Todo", sortable: false },
  { id: "started", title: "In progress", sortable: false },
  { id: "completed", title: "Done", hint: "Last 14 days", sortable: false },
] as const satisfies readonly BoardColumn[];

export const PRIORITY_LABEL: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** The teams that have an issue on the board, by key. */
export function teamsOf(issues: readonly LinearIssue[]): { key: string; name: string }[] {
  const teams = new Map<string, string>();
  for (const issue of issues) {
    if (issue.teamKey !== "" && !teams.has(issue.teamKey)) teams.set(issue.teamKey, issue.teamName);
  }
  return [...teams]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// Urgent first; "no priority" (0) after Low.
const rank = (priority: number) => (priority === 0 ? 5 : priority);

/** The issues by column, for one team or (null) all of them. */
export function boardOf(
  issues: readonly LinearIssue[],
  teamKey: string | null,
): Record<LinearColumnId, LinearCard[]> {
  const board: Record<LinearColumnId, LinearCard[]> = {
    backlog: [],
    unstarted: [],
    started: [],
    completed: [],
  };
  for (const issue of issues) {
    if (teamKey !== null && issue.teamKey !== teamKey) continue;
    board[issue.stateType].push({ ...issue, id: issue.issueId });
  }
  for (const cards of Object.values(board)) {
    cards.sort(
      (a, b) =>
        rank(a.priority) - rank(b.priority) ||
        b.updatedAt - a.updatedAt ||
        a.identifier.localeCompare(b.identifier),
    );
  }
  return board;
}
