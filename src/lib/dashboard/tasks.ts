// The task board in four counts, for the dashboard. Pure: today's date is an
// argument, and the board is taken as the page already narrowed it to the
// company in view (`visibleTasks`).

export type SummaryTask = {
  /** "YYYY-MM-DD", or null where no date was set. */
  due: string | null;
  assignee: { email: string | null } | null;
};

export type TaskSummary = {
  /** Everything not finished: backlog, this week and doing. */
  open: number;
  doing: number;
  /** Open tasks assigned to the viewer; null where the viewer's address is not known. */
  mine: number | null;
  /** Open tasks whose date has passed. A task due today is not late. */
  overdue: number;
};

const DONE = "done";

export function taskSummary(
  board: Readonly<Record<string, readonly SummaryTask[]>>,
  view: { email: string | null; today: string },
): TaskSummary {
  const open = Object.entries(board).flatMap(([column, tasks]) => (column === DONE ? [] : tasks));
  const me = view.email?.toLowerCase() ?? null;
  return {
    open: open.length,
    doing: board.doing?.length ?? 0,
    mine:
      me === null ? null : open.filter((task) => task.assignee?.email?.toLowerCase() === me).length,
    overdue: open.filter((task) => task.due !== null && task.due < view.today).length,
  };
}
