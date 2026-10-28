"use client";

import { useMutation, useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DONE_LIMIT } from "@convex/lib/limits";
import { quarterOf } from "@convex/lib/quarter";
import { Board } from "@/components/board/board";
import { setCompany, useCompany } from "@/components/company-provider";
import { AddTaskForm } from "@/components/tasks/add-task";
import { personLabel, visibleTasks } from "@/components/tasks/assignee";
import { useAssignable } from "@/components/tasks/assignee-picker";
import { BoardToolbar } from "@/components/tasks/board-toolbar";
import { BulkBar } from "@/components/tasks/bulk-bar";
import { PersonLanes, type LaneDrop } from "@/components/tasks/person-lanes";
import { TaskCard, type Task } from "@/components/tasks/task-card";
import { TaskEditor } from "@/components/tasks/task-editor";
import { TaskList } from "@/components/tasks/task-list";
import { useSelection } from "@/components/tasks/use-selection";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { moveOnBoard } from "@/lib/board";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { TASK_COLUMNS, type TaskColumnId } from "@/lib/task-columns";
import {
  assigneeOptions,
  boardColumns,
  defaultView,
  dropIndex,
  filterTasks,
  isFiltered,
  sortTasks,
  type TaskView,
} from "@/lib/tasks/view";
import { cn } from "@/lib/utils";

const COLUMN_IDS = TASK_COLUMNS.map((column) => column.id);
type Columns = Record<TaskColumnId, Task[]>;
const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id as string);

/** A drop on the row of someone a card cannot be given to from here. */
const NOT_A_PERSON = "A card can be dropped only on a person's row or on Unassigned.";

/**
 * The team's task board, kept in the OS: the "Tasks" tab of /board.
 *
 * What is shown and how (search, filters, sort, board or list, a row per
 * person) is the `view`, which the page keeps in the address and hands in
 * with `onView`; without them the board keeps it for as long as it is open.
 *
 * `linked` is a card asked for by address (`/board?task=<id>`, which is how a
 * notification opens its task): that card's editor is open for as long as the
 * link is there, whatever the filters show, and `onLinkDone` asks the page to
 * drop the link. An id that is no card on the board is said, never shown.
 */
export function TaskBoard({
  linked = null,
  onLinkDone,
  view: given,
  onView,
}: {
  linked?: string | null;
  onLinkDone?: () => void;
  view?: TaskView;
  onView?: (view: TaskView) => void;
} = {}) {
  const board = useQuery(api.tasks.board);
  const now = useNow();
  const viewer = useViewer();
  const inView = useCompany();
  // The server sends only the viewer's companies' tasks. A company in view
  // narrows that to its own and the shared ones; a stored choice the viewer
  // is not on narrows nothing.
  const company = inView !== null && viewer.companies.includes(inView) ? inView : null;
  const as = { isOwner: viewer.isOwner };
  const [kept, setKept] = useState<TaskView>(() => defaultView(as));
  const view = given ?? kept;
  const setView = onView ?? setKept;

  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<TaskColumnId | null>(null);
  // In the rows per person: which row and column has its add form open.
  const [addingInRow, setAddingInRow] = useState<string | null>(null);
  const addButtons = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const [moveError, setMoveError] = useState<string | null>(null);
  const people = useAssignable(company);
  const update = useMutation(api.tasks.update);

  // Show the card where it was dropped at once; the server's answer replaces
  // this a moment later. "Done" is ordered by finish time, so a card dropped
  // there goes to the top wherever it was let go.
  const move = useMutation(api.tasks.move).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.tasks.board, {});
    if (!current) return;
    const column = args.column;
    store.setQuery(
      api.tasks.board,
      {},
      moveOnBoard(current, args.id, column, column === "done" ? 0 : args.index, (task) => ({
        ...task,
        column,
        doneAt: column === "done" ? Date.now() : null,
      })),
    );
  });

  const today = now === null ? null : localIsoDate(now);
  const me = viewer.email?.toLowerCase() ?? null;

  // The company's cards, then what the toolbar lets through, in its order.
  const inCompany = useMemo(
    () =>
      board === undefined
        ? undefined
        : (visibleTasks(board, { company, filter: "everyone", email: viewer.email }) as Columns),
    [board, company, viewer.email],
  );
  const shown = useMemo(() => {
    if (inCompany === undefined) return undefined;
    return Object.fromEntries(
      COLUMN_IDS.map((id) => [
        id,
        sortTasks(filterTasks(inCompany[id], view, { me, today }), view.sort),
      ]),
    ) as Columns;
  }, [inCompany, view, me, today]);
  const everyCard = useMemo(
    () => (inCompany === undefined ? [] : COLUMN_IDS.flatMap((id) => inCompany[id])),
    [inCompany],
  );
  const shownFlat = useMemo(
    () => (shown === undefined ? [] : COLUMN_IDS.flatMap((id) => shown[id])),
    [shown],
  );
  const options = useMemo(() => assigneeOptions(everyCard, people, me), [everyCard, people, me]);

  const selection = useSelection(useMemo(() => ids(shownFlat), [shownFlat]));
  const selectedCards = useMemo(
    () => shownFlat.filter((task) => selection.ids.includes(task.id)),
    [shownFlat, selection.ids],
  );

  const onlyMine = view.who !== "all" && view.who.length === 1 && view.who[0] === "me";
  const nothingOfMine =
    onlyMine &&
    !isFiltered({ ...view, who: defaultView({ isOwner: false }).who }, { isOwner: false }) &&
    shown !== undefined &&
    shownFlat.length === 0;

  // The linked card, looked for among every card the server sent, not only
  // those the filters show.
  const linkedTask = useMemo(
    () =>
      linked === null || board === undefined
        ? null
        : (Object.values(board)
            .flat()
            .find((task) => task.id === linked) ?? null),
    [board, linked],
  );
  const linkMissing = linked !== null && board !== undefined && linkedTask === null;
  // A viewer on both companies is looking at one of them: show the card's.
  // (Someone on one company is only ever sent that company's cards.)
  const switchTo =
    linkedTask?.company != null && inView !== null && inView !== linkedTask.company
      ? linkedTask.company
      : null;
  useEffect(() => {
    if (switchTo !== null) setCompany(switchTo);
  }, [switchTo]);
  const open = editing ?? linkedTask;

  const columns = useMemo(() => boardColumns(TASK_COLUMNS, view.sort), [view.sort]);

  const renderCard = (task: Task) => {
    const picked = selection.has(task.id);
    return (
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label={`Select ${task.title}`}
          checked={picked}
          onChange={() => selection.toggle(task.id)}
          className={cn(
            "mt-1 size-3.5 shrink-0 accent-brand transition-opacity",
            // Shown on hover, on focus, once anything is selected, and always on touch.
            selection.ids.length === 0 &&
              "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        />
        <div className="min-w-0 flex-1">
          <TaskCard task={task} today={today} onOpen={setEditing} />
        </div>
      </div>
    );
  };

  const onMove = (id: string, column: string, index: number) => {
    if (board === undefined || shown === undefined) return;
    setMoveError(null);
    const to = column as TaskColumnId;
    // The board counts the cards on screen; the server counts every card it
    // sent for the column. With some filtered out the two differ, so say
    // where the card landed among all of them. Under a sort other than by
    // hand, the stored order is left as it is (`dropIndex`).
    const at = to === "done" ? 0 : dropIndex(view.sort, ids(board[to]), ids(shown[to]), id, index);
    // If the server refuses, Convex puts the card back where it was; say
    // why, so it does not look like the drop was simply ignored.
    move({ id: id as Id<"tasks">, column: to, index: at }).catch((failure) =>
      setMoveError(messageOf(failure, "That move could not be saved.")),
    );
  };

  // A drop in the rows per person: within a row it is an ordinary move;
  // into another person's row it gives them the card, through the same
  // checks as the editor (and changes its column too, in the same save).
  const onLaneDrop = (drop: LaneDrop) => {
    if (board === undefined) return;
    setMoveError(null);
    if (drop.from.key === drop.to.key) {
      const to = drop.column as TaskColumnId;
      const at =
        to === "done" ? 0 : dropIndex(view.sort, ids(board[to]), drop.shown, drop.id, drop.index);
      move({ id: drop.id as Id<"tasks">, column: to, index: at }).catch((failure) =>
        setMoveError(messageOf(failure, "That move could not be saved.")),
      );
      return;
    }
    if (!drop.to.accepts) return setMoveError(NOT_A_PERSON);
    const task = drop.from.tasks.find((t) => t.id === drop.id);
    update({
      id: drop.id as Id<"tasks">,
      assignee: drop.to.email,
      ...(task && task.column !== drop.column ? { column: drop.column as TaskColumnId } : null),
    }).catch((failure) => setMoveError(messageOf(failure, "That card could not be reassigned.")));
  };

  const fold = useCallback(
    (key: string) =>
      setView({
        ...view,
        folded: view.folded.includes(key)
          ? view.folded.filter((k) => k !== key)
          : [...view.folded, key],
      }),
    [setView, view],
  );

  return (
    <div className="space-y-4">
      <BoardToolbar
        view={view}
        onView={setView}
        people={options}
        isOwner={viewer.isOwner}
        shown={shownFlat.length}
        total={everyCard.length}
        onNew={() => setCreating(true)}
      />

      {nothingOfMine && (
        <p className="rounded-card bg-surface px-4 py-3 text-sm text-ink-2">
          <span className="text-ink">Nothing assigned to you.</span>{" "}
          <button
            type="button"
            onClick={() => setView({ ...view, who: "all" })}
            className="rounded text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Show everyone&apos;s tasks
          </button>
        </p>
      )}

      {board === undefined || shown === undefined ? (
        <div className="grid gap-4 lg:grid-cols-4" aria-busy>
          {TASK_COLUMNS.map((c) => (
            <Skeleton key={c.id} className="h-64 rounded-card" />
          ))}
        </div>
      ) : view.layout === "list" ? (
        <TaskList
          tasks={sortTasks(shownFlat, view.sort)}
          sort={view.sort}
          onSort={(sort) => setView({ ...view, sort })}
          today={today}
          onOpen={setEditing}
          isSelected={selection.has}
          onToggle={selection.toggle}
          showCompany={viewer.companies.length > 1 && company === null}
        />
      ) : view.group === "person" ? (
        <PersonLanes
          columns={columns}
          shown={shown}
          me={me}
          today={today}
          folded={view.folded}
          onFold={fold}
          renderCard={renderCard}
          onDrop={onLaneDrop}
          adding={addingInRow}
          onAdding={setAddingInRow}
        />
      ) : (
        <Board<Task>
          columns={columns}
          items={shown}
          getLabel={(task) => task.title}
          renderCard={renderCard}
          onMove={onMove}
          columnHeaderAction={(column) =>
            column.id === "done" ? null : (
              <button
                type="button"
                ref={(button) => {
                  addButtons.current[column.id] = button;
                }}
                aria-label={`Add a card to ${column.title}`}
                aria-expanded={addingTo === column.id}
                onClick={() => setAddingTo(column.id as TaskColumnId)}
                className="rounded-full p-1 text-ink-3 outline-none transition hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <PlusIcon aria-hidden className="size-3.5" />
              </button>
            )
          }
          columnTop={(column) =>
            addingTo === column.id ? (
              <AddTaskForm
                column={column.id as TaskColumnId}
                columnTitle={column.title}
                atTop
                // Or the new card would vanish from the board as it is added.
                assignToMe={onlyMine}
                onClose={() => {
                  setAddingTo(null);
                  addButtons.current[column.id]?.focus();
                }}
              />
            ) : null
          }
          columnFooter={(column) =>
            column.id === "done" && board.done.length >= DONE_LIMIT ? (
              <p className="px-2 text-[11px] text-ink-3">
                Showing the latest {DONE_LIMIT}. Older cards are kept.
              </p>
            ) : null
          }
        />
      )}

      {moveError && (
        <p role="alert" className="text-sm text-destructive">
          {moveError}
        </p>
      )}
      {selection.notice && (
        <p role="alert" className="text-sm text-destructive">
          {selection.notice}
        </p>
      )}

      <BulkBar
        selected={selectedCards}
        people={options}
        me={
          viewer.email === null
            ? null
            : { email: me!, label: personLabel({ email: viewer.email, name: viewer.name }) }
        }
        onKeep={selection.keep}
        onClear={selection.clear}
      />

      {linkMissing && (
        <p className="rounded-card bg-surface px-4 py-3 text-sm text-ink-2">
          <span className="text-ink">That card is no longer on the board.</span>{" "}
          <button
            type="button"
            onClick={() => onLinkDone?.()}
            className="rounded text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Dismiss
          </button>
        </p>
      )}

      {open && (
        <TaskEditor
          // Remount per card so the form starts from that card's values.
          key={open.id}
          task={open}
          quarter={now === null ? null : quarterOf(now)}
          onClose={() => {
            setEditing(null);
            if (editing === null) onLinkDone?.();
          }}
        />
      )}
      {creating && (
        <TaskEditor
          task={null}
          quarter={now === null ? null : quarterOf(now)}
          assignToMe={onlyMine}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
