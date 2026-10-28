"use client";

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, CalendarX2Icon } from "lucide-react";
import {
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { COMPANIES } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { formatPeriod } from "@/lib/format";
import { taskColumnTitle } from "@/lib/task-columns";
import { ariaSort, nextSort, type Sort, type SortKey } from "@/lib/tasks/view";
import { cn } from "@/lib/utils";
import { assigneeLabel } from "./assignee";
import { MentionText } from "./mention-field";
import { OriginTag } from "./origin";
import type { Task } from "./task-card";

/** A column's state as a chip: only Done reads as finished, Doing as under way. */
const COLUMN_TONE: Record<Task["column"], StatusTone> = {
  backlog: "neutral",
  this_week: "neutral",
  doing: "info",
  done: "success",
};

/**
 * The task board as a table: the cards the toolbar lets through, in the
 * toolbar's order. A header that is a button sorts by it (`aria-sort`); the
 * title opens the card's editor; the checkbox selects it for a bulk action.
 */
export function TaskList({
  tasks,
  sort,
  onSort,
  today,
  onOpen,
  isSelected,
  onToggle,
  showCompany,
}: {
  tasks: readonly Task[];
  sort: Sort;
  onSort: (next: Sort) => void;
  /** "YYYY-MM-DD", or null while rendering on the server. */
  today: string | null;
  onOpen: (task: Task) => void;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** A viewer on both companies with neither in view: say whose each card is. */
  showCompany: boolean;
}) {
  const head = (key: SortKey, label: string, hideBelow?: "sm" | "md" | "lg", pinned?: boolean) => (
    <SortHeader sort={sort} column={key} onSort={onSort} hideBelow={hideBelow} pinned={pinned}>
      {label}
    </SortHeader>
  );

  if (tasks.length === 0) {
    return <p className="rounded-card bg-surface px-4 py-6 text-sm text-ink-2">No cards match.</p>;
  }

  return (
    <div className="rounded-card bg-panel p-3 shadow-soft-sm">
      <DataTable label="Tasks" bleed={false} className="min-w-[48rem]">
        <DataHead>
          {head("title", "Title", undefined, true)}
          {head("assignee", "Assignee")}
          {head("column", "Column")}
          {head("due", "Due")}
          {head("kind", "Type")}
          {showCompany && <DataHeader>Company</DataHeader>}
          <DataHeader>From</DataHeader>
          {head("created", "Created")}
        </DataHead>
        <DataBody>
          {tasks.map((task) => {
            const overdue =
              task.due !== null && today !== null && task.due < today && task.column !== "done";
            const assignee = assigneeLabel(task.assignee);
            return (
              <DataRow key={task.id} tone={overdue ? "danger" : undefined}>
                <DataRowHeader pinned className="max-w-[24rem] font-normal sm:min-w-64">
                  {/* The checkbox rides with the title, so both stay in view on a phone. */}
                  <span className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${task.title}`}
                      checked={isSelected(task.id)}
                      onChange={() => onToggle(task.id)}
                      className="mt-1 size-3.5 shrink-0 accent-brand"
                    />
                    <button
                      type="button"
                      onClick={() => onOpen(task)}
                      className={cn(
                        "rounded text-left font-medium text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50",
                        task.column === "done" && "text-ink-2 line-through decoration-ink-3",
                      )}
                    >
                      <MentionText text={task.title} labels={task.mentions} />
                    </button>
                  </span>
                </DataRowHeader>
                <DataCell className="whitespace-nowrap">
                  {assignee ?? <Blank>Unassigned</Blank>}
                </DataCell>
                <DataCell>
                  <StatusChip tone={COLUMN_TONE[task.column]}>{taskColumnTitle(task.column)}</StatusChip>
                </DataCell>
                <DataCell className="font-num whitespace-nowrap">
                  {task.due === null ? (
                    <Blank />
                  ) : overdue ? (
                    <StatusChip tone="danger" icon={CalendarX2Icon}>
                      Overdue · {formatPeriod("day", task.due)}
                    </StatusChip>
                  ) : (
                    formatPeriod("day", task.due)
                  )}
                </DataCell>
                <DataCell>
                  {task.kind === "issue" ? (
                    <KindTag tone="plum">Problem</KindTag>
                  ) : (
                    <KindTag tone="slate">Task</KindTag>
                  )}
                </DataCell>
                {showCompany && (
                  <DataCell className="whitespace-nowrap">
                    {task.company ? COMPANIES[task.company].name : <Blank>Both</Blank>}
                  </DataCell>
                )}
                <DataCell>{task.origin ? <OriginTag origin={task.origin} /> : <Blank>By hand</Blank>}</DataCell>
                <DataCell className="font-num whitespace-nowrap text-ink-2">
                  {formatPeriod("day", localIsoDate(task.createdAt))}
                </DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
    </div>
  );
}

/** A column's name as the button that sorts by it. The header cell carries `aria-sort`. */
function SortHeader({
  sort,
  column,
  onSort,
  hideBelow,
  pinned,
  children,
}: {
  sort: Sort;
  column: SortKey;
  onSort: (next: Sort) => void;
  hideBelow?: "sm" | "md" | "lg";
  pinned?: boolean;
  children: string;
}) {
  const state = ariaSort(sort, column);
  const Icon =
    state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <DataHeader aria-sort={state} hideBelow={hideBelow} pinned={pinned} className={pinned ? "pl-9" : undefined}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
          state !== "none" && "text-ink",
        )}
      >
        {children}
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "none" && "opacity-50")} />
      </button>
    </DataHeader>
  );
}
