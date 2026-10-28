// The viewer's own open tasks, for the dashboard's block and for Today. Pure:
// today's date and "now" are arguments, and the board is what `tasks.board`
// already sent (the caller's companies' tasks and the shared ones: nothing
// here can show a task the server did not send).

import type { CompanyId } from "@convex/lib/company";
import { daysBetween } from "@/lib/dates";

export type MyTask = {
  id: string;
  /** Typed text: rendered as text. */
  title: string;
  /** "YYYY-MM-DD", or null where no date was set. */
  due: string | null;
  /** null is a shared task. */
  company: CompanyId | null;
  /** When the card was added. */
  createdAt: number;
  assignee: { email: string | null } | null;
};
type Board<T> = Readonly<Record<string, readonly T[]>>;

/** How many the dashboard's block shows. */
export const MY_TASKS_SHOWN = 8;
/** A task due within this many days is "due soon". */
export const DUE_SOON_TASK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// What is being worked on first, then this week's, then the backlog.
const OPEN_COLUMNS = ["doing", "this_week", "backlog"] as const;

type View = { email: string | null; company: CompanyId | null; today: string };

/** The viewer's open tasks for the company in view, in the board's own order. */
function mine<T extends MyTask>(board: Board<T>, view: View): T[] {
  // With no address on record nothing matches (a lower-cased address is never
  // null): an unassigned task is nobody's.
  const me = view.email?.toLowerCase() ?? null;
  return OPEN_COLUMNS.flatMap((column) => board[column] ?? []).filter(
    (task) =>
      task.assignee?.email?.toLowerCase() === me &&
      (view.company === null || task.company === null || task.company === view.company),
  );
}

const byDue = (a: MyTask, b: MyTask) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0);

export type When = "overdue" | "soon" | "later";

/**
 * Open tasks assigned to the viewer, for the company in view: overdue first
 * (oldest first), then due within a week (soonest first), then the rest
 * (dated ones by date, then undated as the board has them). `shown` is the
 * first eight; `total` is all of them.
 */
export function myOpenTasks<T extends MyTask>(
  board: Board<T>,
  view: View,
  cap: number = MY_TASKS_SHOWN,
): { shown: (T & { when: When })[]; total: number } {
  const all = mine(board, view);
  const dated = all.filter((task) => task.due !== null).sort(byDue);
  const undated = all.filter((task) => task.due === null);
  const when = (task: T): When =>
    task.due === null
      ? "later"
      : task.due < view.today
        ? "overdue"
        : daysBetween(view.today, task.due) <= DUE_SOON_TASK_DAYS
          ? "soon"
          : "later";
  // Dates ascending already puts overdue before soon before later.
  const ordered = [...dated, ...undated].map((task) => ({ ...task, when: when(task) }));
  return { shown: ordered.slice(0, cap), total: ordered.length };
}

/**
 * What of the viewer's tasks needs them today: `due` is what is overdue or
 * due today, oldest first; `fresh` is what was added for them in the last
 * day and is not already in `due`.
 *
 * "Added in the last day" is the card's own age. The board does not record
 * when a card was given to someone, so a card made last week and handed over
 * this morning is not counted new.
 */
export function tasksForToday<T extends MyTask>(
  board: Board<T>,
  view: View & { now: number },
): { due: (T & { when: "overdue" | "today" })[]; fresh: T[] } {
  const all = mine(board, view);
  const due = all
    .filter((task) => task.due !== null && task.due <= view.today)
    .sort(byDue)
    .map((task) => ({
      ...task,
      when: task.due! < view.today ? ("overdue" as const) : ("today" as const),
    }));
  const listed = new Set(due.map((task) => task.id));
  const fresh = all.filter(
    (task) => !listed.has(task.id) && view.now - task.createdAt <= DAY_MS && task.createdAt <= view.now,
  );
  return { due, fresh };
}
