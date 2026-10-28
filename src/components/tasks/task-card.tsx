import { useCompany } from "@/components/company-provider";
import {
  AlignLeftIcon,
  Building2Icon,
  CalendarIcon,
  CalendarX2Icon,
  CircleAlertIcon,
  TargetIcon,
  UserIcon,
} from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { formatPeriod } from "@/lib/format";
import { cn } from "@/lib/utils";
import { assigneeLabel, initialsOf } from "./assignee";
import { MentionText } from "./mention-field";
import { OriginTag } from "./origin";

export type Task = FunctionReturnType<typeof api.tasks.board>["backlog"][number];

const chip = "inline-flex max-w-full items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-2";

/**
 * A task as it appears on the board. The title is the button that opens the
 * editor; everything else is context: who it is for, whether it is an issue,
 * the goal it serves, when it is due, (for a viewer on both companies) the
 * company it is tied to, and whether the daily standup or a suggestion added it.
 */
export function TaskCard({
  task,
  today,
  onOpen,
}: {
  task: Task;
  /** "YYYY-MM-DD", or null while rendering on the server. */
  today: string | null;
  onOpen: (task: Task) => void;
}) {
  const viewer = useViewer();
  const overdue =
    task.due !== null && today !== null && task.due < today && task.column !== "done";
  const assignee = assigneeLabel(task.assignee);
  // A viewer on one company is only ever sent that company's tasks and the
  // shared ones, and a board showing one company holds only that company's:
  // either way a tag would say nothing.
  const inView = useCompany();
  const company =
    viewer.companies.length > 1 && inView === null && task.company
      ? COMPANIES[task.company]
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(task)}
        className={cn(
          "block w-full rounded pr-5 text-left text-sm text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50",
          task.column === "done" && "text-ink-2 line-through decoration-ink-3",
        )}
      >
        <MentionText text={task.title} labels={task.mentions} />
      </button>
      {/* A card with a description says so, and shows where it begins. */}
      {task.notes && task.notes.trim() !== "" && (
        <p className="mt-1 flex items-start gap-1 text-xs text-ink-2">
          <AlignLeftIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-ink-3" />
          <span className="line-clamp-2 min-w-0 whitespace-pre-line">
            <MentionText text={task.notes} labels={task.mentions} />
          </span>
        </p>
      )}

      {(assignee ||
        company ||
        task.kind === "issue" ||
        task.goalTitle ||
        task.due ||
        task.origin) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {assignee && (
            <span className={cn(chip, "pl-0.5")} title={assignee}>
              {task.assignee?.status === "teammate" ? (
                <span
                  aria-hidden
                  data-initials
                  className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[8px] font-semibold text-brand"
                >
                  {initialsOf(assignee)}
                </span>
              ) : (
                <UserIcon aria-hidden className="ml-1 size-3 shrink-0" />
              )}
              <span className="sr-only">Assigned to</span>
              <span className="truncate">{assignee}</span>
            </span>
          )}
          {company && (
            <span className={chip}>
              <Building2Icon aria-hidden className="size-3 shrink-0" />
              {company.name}
            </span>
          )}
          {task.kind === "issue" && (
            <span className={chip}>
              <CircleAlertIcon aria-hidden className="size-3 text-watch" />
              Problem
            </span>
          )}
          {task.goalTitle && (
            <span className={chip} title={task.goalTitle}>
              <TargetIcon aria-hidden className="size-3 shrink-0 text-brand" />
              <span className="truncate">{task.goalTitle}</span>
            </span>
          )}
          {task.due && (
            <span className={cn(chip, overdue && "font-medium text-ink")}>
              {overdue ? (
                <CalendarX2Icon aria-hidden className="size-3 text-weak" />
              ) : (
                <CalendarIcon aria-hidden className="size-3" />
              )}
              {overdue && "Overdue · "}
              {formatPeriod("day", task.due)}
            </span>
          )}
          {task.origin && <OriginTag origin={task.origin} />}
        </div>
      )}
    </>
  );
}
