import type { BoardColumn } from "@/components/board/board";

// The task board's columns. "Done" keeps its own order (newest finished
// first), so cards cannot be arranged within it by hand.
export const TASK_COLUMNS = [
  { id: "backlog", title: "Backlog", hint: "Not scheduled yet" },
  { id: "this_week", title: "This week", hint: "Committed for this week" },
  { id: "doing", title: "Doing", hint: "In progress now" },
  { id: "done", title: "Done", hint: "Finished, newest first", sortable: false },
] as const satisfies readonly BoardColumn[];

export type TaskColumnId = (typeof TASK_COLUMNS)[number]["id"];

export const taskColumnTitle = (id: string) =>
  TASK_COLUMNS.find((column) => column.id === id)?.title ?? id;
