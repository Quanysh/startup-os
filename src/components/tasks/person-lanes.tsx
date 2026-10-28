"use client";

import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Board, type BoardColumn, type BoardLane } from "@/components/board/board";
import { groupByPerson, type Lane } from "@/lib/tasks/view";
import type { TaskColumnId } from "@/lib/task-columns";
import { cn } from "@/lib/utils";
import { AddTaskForm } from "./add-task";
import type { Task } from "./task-card";

const SEP = "|";
const cell = (lane: string, column: string) => `${lane}${SEP}${column}`;

/** Where a card was let go in the rows per person, read back from the board's column id. */
export type LaneDrop = {
  id: string;
  from: Lane<Task>;
  to: Lane<Task>;
  column: string;
  index: number;
  /** The cards on screen in the row and column it was dropped in, in order. */
  shown: readonly string[];
};

/**
 * The task board with one row per person (`groupByPerson`): the viewer first,
 * Unassigned last, each with the board's columns. A row's header names the
 * person, how many of their cards are open and how many are overdue, and
 * folds the row away. Dropping a card in another person's row is reported
 * through `onDrop` for the board to reassign it, through the same checks
 * the editor uses.
 */
export function PersonLanes({
  columns,
  shown,
  me,
  today,
  folded,
  onFold,
  renderCard,
  onDrop,
  adding = null,
  onAdding,
}: {
  columns: readonly BoardColumn[];
  /** The cards on screen, by column, in the order to show them. */
  shown: Readonly<Record<string, readonly Task[]>>;
  me: string | null;
  today: string | null;
  folded: readonly string[];
  onFold: (key: string) => void;
  renderCard: (task: Task) => ReactNode;
  onDrop: (drop: LaneDrop) => void;
  /** The row and column whose add form is open (`row|column`), if any. */
  adding?: string | null;
  onAdding?: (cell: string | null) => void;
}) {
  const lanes = useMemo(
    () => groupByPerson(columns.flatMap((column) => [...(shown[column.id] ?? [])]), me),
    [columns, shown, me],
  );

  const { boardColumns, items, boardLanes } = useMemo(() => {
    const boardColumns: BoardColumn[] = [];
    const items: Record<string, Task[]> = {};
    const boardLanes: BoardLane[] = [];
    for (const lane of lanes) {
      const ids: string[] = [];
      for (const column of columns) {
        const id = cell(lane.key, column.id);
        const cards = lane.tasks.filter((task) => task.column === column.id);
        // Each row repeats the columns: only a sort's note is worth repeating.
        const hint = column.hint?.startsWith("Sorted by") ? column.hint : undefined;
        boardColumns.push({ ...column, id, hint, count: cards.length });
        items[id] = cards;
        ids.push(id);
      }
      const open = lane.tasks.filter((task) => task.column !== "done");
      const overdue =
        today === null ? 0 : open.filter((task) => task.due !== null && task.due < today).length;
      const isFolded = folded.includes(lane.key);
      boardLanes.push({
        id: lane.key,
        label: lane.label,
        columnIds: ids,
        folded: isFolded,
        header: (
          <h3 className="flex items-center">
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() => onFold(lane.key)}
              className="group/lane inline-flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-medium text-ink outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-4 text-ink-3 transition-transform", !isFolded && "rotate-90")}
              />
              {lane.label}
              <span className="font-num text-xs font-normal text-ink-3">{open.length} open</span>
              {overdue > 0 && (
                <span className="font-num text-xs font-medium text-danger-ink">
                  {overdue} overdue
                </span>
              )}
            </button>
          </h3>
        ),
      });
    }
    return { boardColumns, items, boardLanes };
  }, [lanes, columns, folded, onFold, today]);

  if (lanes.length === 0) {
    return <p className="rounded-card bg-surface px-4 py-6 text-sm text-ink-2">No cards match.</p>;
  }

  return (
    <Board<Task>
      columns={boardColumns}
      lanes={boardLanes}
      items={items}
      getLabel={(task) => task.title}
      renderCard={renderCard}
      columnHeaderAction={(column) => {
        const [laneKey, columnId] = column.id.split(SEP) as [string, string];
        const lane = lanes.find((l) => l.key === laneKey);
        // Done takes no new card; a row of someone who cannot be named takes none either.
        if (onAdding === undefined || columnId === "done" || lane === undefined || !lane.accepts) {
          return null;
        }
        return (
          <button
            type="button"
            aria-label={`Add a card to ${column.title} for ${lane.label}`}
            aria-expanded={adding === column.id}
            onClick={() => onAdding(column.id)}
            className="rounded-full p-1 text-ink-3 outline-none transition hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </button>
        );
      }}
      columnTop={(column) => {
        if (adding !== column.id || onAdding === undefined) return null;
        const [laneKey, columnId] = column.id.split(SEP) as [string, string];
        const lane = lanes.find((l) => l.key === laneKey);
        if (lane === undefined) return null;
        return (
          <AddTaskForm
            column={columnId as TaskColumnId}
            columnTitle={column.title}
            atTop
            // A card added in someone's row is theirs; in Unassigned, nobody's.
            assignTo={
              lane.email === null
                ? null
                : { value: lane.email, label: lane.label.replace(/ \(you\)$/, "") }
            }
            onClose={() => onAdding(null)}
          />
        );
      }}
      onMove={(id, target, index) => {
        const [laneKey, column] = target.split(SEP) as [string, string];
        const from = lanes.find((lane) => lane.tasks.some((task) => task.id === id));
        const to = lanes.find((lane) => lane.key === laneKey);
        if (!from || !to) return;
        onDrop({ id, from, to, column, index, shown: (items[target] ?? []).map((t) => t.id) });
      }}
    />
  );
}
