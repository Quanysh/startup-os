"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { placeAt } from "@convex/lib/ordering";
import { dropTarget, keyboardMove, settleDrop } from "@/lib/board";
import { cn } from "@/lib/utils";

export type BoardColumn = {
  id: string;
  title: string;
  /** One line under the title saying what belongs here. */
  hint?: string;
  /**
   * False for a column that keeps its own order (the task board's "Done",
   * newest finished first). Cards can be moved into and out of it but not
   * arranged within it, and a card entering it is reported at index 0.
   */
  sortable?: boolean;
  /** How many cards the column holds, when it is shown only some of them. */
  count?: number;
};

type Card = { id: string };

/**
 * A row of the board (the task board's rows per person): a header and its
 * own columns, whose ids are among `columns`. Cards move between every
 * column of every row with the pointer; the keyboard keeps to the card's row.
 */
export type BoardLane = {
  id: string;
  /** The row's name, for a screen reader and in announcements. */
  label: string;
  header: ReactNode;
  columnIds: readonly string[];
  /** Folded away: only the header shows. */
  folded?: boolean;
};

/**
 * A kanban board: columns of cards that can be moved between and within
 * columns by mouse, by touch (press and hold), or from the keyboard (focus a
 * card's grip and press an arrow key: each press moves it one place).
 *
 * The board owns no data. It reports a drop through `onMove` and expects the
 * caller to update `items`; while a card is in the air it shows its own
 * working copy. A card for which `canDrag` is false cannot be picked up,
 * which is how a mirrored record (one whose source of truth is another
 * system) is shown read-only. Other cards can still be placed around it.
 */
export function Board<T extends Card>({
  columns,
  items,
  renderCard,
  getLabel,
  onMove,
  canDrag = () => true,
  columnFooter,
  columnHeaderAction,
  columnTop,
  lanes,
  fixedColumns = false,
  className,
}: {
  /**
   * Keep every column at its reading width and scroll sideways at any screen
   * size. For a board with more columns than fit: squeezed columns wrap every
   * card's name onto three lines.
   */
  fixedColumns?: boolean;
  columns: readonly BoardColumn[];
  items: Readonly<Record<string, readonly T[]>>;
  renderCard: (item: T) => ReactNode;
  /** A card's name, for screen-reader announcements. */
  getLabel: (item: T) => string;
  onMove: (id: string, column: string, index: number) => void;
  canDrag?: (item: T) => boolean;
  columnFooter?: (column: BoardColumn) => ReactNode;
  /** Something beside a column's title (the task board's "+"). */
  columnHeaderAction?: (column: BoardColumn) => ReactNode;
  /** Something above a column's cards (the task board's quick-add form). */
  columnTop?: (column: BoardColumn) => ReactNode;
  /** Draw the columns in rows (`BoardLane`) instead of one row. */
  lanes?: readonly BoardLane[];
  className?: string;
}) {
  // Stable ids so server and client render the same aria attributes.
  const dndId = useId();
  const gripHintId = useId();
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, T>();
    for (const list of Object.values(items)) for (const item of list) map.set(item.id, item);
    return map;
  }, [items]);

  const settled = useMemo(
    () =>
      Object.fromEntries(
        columns.map((column) => [column.id, (items[column.id] ?? []).map((item) => item.id)]),
      ),
    [columns, items],
  );
  // A card deleted elsewhere mid-drag must not linger in the working copy.
  const order = useMemo(
    () =>
      draft === null
        ? settled
        : Object.fromEntries(
            Object.entries(draft).map(([column, ids]) => [
              column,
              ids.filter((id) => byId.has(id)),
            ]),
          ),
    [draft, settled, byId],
  );
  const unordered = useMemo(
    () => new Set(columns.filter((c) => c.sortable === false).map((c) => c.id)),
    [columns],
  );

  const sensors = useSensors(
    // A small travel before a drag starts, so a click still reads as a click.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Press and hold on touch, so the column can still be scrolled.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  // Keyboard moves are immediate, one arrow press at a time, and are spoken
  // through a live region. (dnd-kit's own keyboard sensor picks its target by
  // geometry, which lands unpredictably between columns of different heights.)
  const [spoken, setSpoken] = useState("");
  const refocus = useRef<string | null>(null);
  const moveByKey = (id: string, key: string) => {
    const lane = lanes?.find((l) => l.columnIds.some((c) => settled[c]?.includes(id)));
    const target = keyboardMove(
      lane ? [...lane.columnIds] : columns.map((c) => c.id),
      settled,
      id,
      key,
      unordered,
    );
    if (!target) return false;
    refocus.current = id;
    onMove(id, target.column, target.index);
    setSpoken(`${labelOf(id)} moved to ${place(target)}.`);
    return true;
  };
  // A card that changes column is remounted, which drops focus: put it back
  // on the same card's grip so the next arrow press continues the move. The
  // card to follow is remembered until the owner focuses or clicks something
  // else, so it survives the later re-render when the server confirms.
  useEffect(() => {
    if (refocus.current === null) return;
    const grip = document.querySelector<HTMLElement>(
      `[data-board-grip="${window.CSS.escape(refocus.current)}"]`,
    );
    if (grip && document.activeElement !== grip) grip.focus();
  }, [settled]);
  const stopFollowing = (target: EventTarget | null) => {
    const grip = (target as HTMLElement | null)?.closest?.("[data-board-grip]");
    if (grip?.getAttribute("data-board-grip") !== refocus.current) refocus.current = null;
  };

  const columnTitle = (id: string) => {
    const title = columns.find((c) => c.id === id)?.title ?? id;
    const lane = lanes?.find((l) => l.columnIds.includes(id));
    return lane ? `${lane.label}, ${title}` : title;
  };
  const labelOf = (id: string | number) => {
    const item = byId.get(String(id));
    return item ? getLabel(item) : "card";
  };
  const describe = (overId: string | number | undefined) => {
    if (overId === undefined) return null;
    const target = dropTarget(order, String(activeId), String(overId));
    return target ? place(target) : null;
  };
  // Position means nothing in a column that keeps its own order.
  const place = (target: { column: string; index: number }) =>
    unordered.has(target.column)
      ? columnTitle(target.column)
      : `${columnTitle(target.column)}, position ${target.index + 1}`;

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}.`,
    onDragOver: ({ active, over }) => {
      const where = describe(over?.id);
      return where ? `${labelOf(active.id)} is over ${where}.` : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const where = describe(over?.id);
      return where
        ? `${labelOf(active.id)} was dropped in ${where}.`
        : `${labelOf(active.id)} was put back.`;
    },
    onDragCancel: ({ active }) => `Move cancelled. ${labelOf(active.id)} was put back.`,
  };

  const reset = () => {
    setDraft(null);
    setActiveId(null);
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setDraft(settled);
  };

  // Crossing into another column moves the card there in the working copy,
  // so that column opens a gap for it.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !draft) return;
    const id = String(active.id);
    const target = dropTarget(draft, id, String(over.id));
    if (!target) return;
    const from = Object.keys(draft).find((column) => draft[column]!.includes(id));
    if (from === undefined || from === target.column) return;
    setDraft({
      ...draft,
      [from]: draft[from]!.filter((other) => other !== id),
      [target.column]: placeAt(draft[target.column]!, id, target.index),
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    const target = over && draft ? dropTarget(draft, id, String(over.id)) : null;
    reset();
    const move = target && settleDrop(settled, id, target, unordered);
    if (move) onMove(id, move.column, move.index);
  };

  const active = activeId ? byId.get(activeId) : undefined;

  const views = columns.map((column) => (
    <BoardColumnView
      key={column.id}
      column={column}
      ids={order[column.id] ?? []}
      fixed={fixedColumns}
      action={columnHeaderAction?.(column)}
      top={columnTop?.(column)}
      footer={columnFooter?.(column)}
    >
      {(order[column.id] ?? []).map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        return (
          <SortableCard
            key={id}
            id={id}
            label={getLabel(item)}
            draggable={canDrag(item)}
            gripHintId={gripHintId}
            onArrow={(key) => moveByKey(id, key)}
          >
            {renderCard(item)}
          </SortableCard>
        );
      })}
    </BoardColumnView>
  ));
  const row = (shown: readonly BoardColumn[]) => (
    <div className={cn("flex min-w-max gap-4", !fixedColumns && "lg:min-w-0")}>
      {views.filter((_, at) => shown.includes(columns[at]!))}
    </div>
  );

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCorners}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      {/* The board scrolls sideways on narrow screens; the page does not. In
          rows, each row scrolls on its own and the rows stack. */}
      <div
        className={cn(
          lanes ? "space-y-3" : "-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6",
          className,
        )}
        onFocusCapture={(event) => stopFollowing(event.target)}
        onPointerDownCapture={(event) => stopFollowing(event.target)}
        // Focus leaving the board for elsewhere on the page ends the follow
        // too, or the next live update would pull focus back here. (A card
        // being remounted blurs to nowhere, with no relatedTarget.)
        onBlurCapture={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
            refocus.current = null;
          }
        }}
      >
        {lanes ? (
          lanes.map((lane) => (
            <div key={lane.id} role="group" aria-label={lane.label}>
              {lane.header}
              {!lane.folded && (
                <div className="-mx-4 overflow-x-auto px-4 pt-2 pb-2 sm:-mx-6 sm:px-6">
                  {row(columns.filter((c) => lane.columnIds.includes(c.id)))}
                </div>
              )}
            </div>
          ))
        ) : (
          row(columns)
        )}
      </div>

      <p id={gripHintId} className="sr-only">
        Press an arrow key to move this card one place.
      </p>
      <p role="status" data-board-status className="sr-only">
        {spoken}
      </p>

      <DragOverlay dropAnimation={{ duration: 160 }}>
        {active ? (
          <div className="rotate-1 cursor-grabbing rounded-inner bg-panel p-3 shadow-soft ring-1 ring-brand/30">
            {renderCard(active)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumnView({
  column,
  ids,
  fixed,
  action,
  top,
  footer,
  children,
}: {
  column: BoardColumn;
  ids: readonly string[];
  fixed: boolean;
  action?: ReactNode;
  top?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex w-[17.5rem] shrink-0 flex-col rounded-card bg-surface p-3",
        !fixed && "lg:w-auto lg:min-w-0 lg:flex-1",
      )}
    >
      <header className="px-2 pt-1 pb-3">
        <div className="flex items-center gap-1">
          <h2
            id={headingId}
            className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-sm font-medium text-ink"
          >
            {column.title}
            <span className="font-num text-xs font-normal text-ink-3">
              {column.count ?? ids.length}
            </span>
          </h2>
          {action}
        </div>
        {column.hint && <p className="mt-0.5 text-[11px] text-ink-3">{column.hint}</p>}
      </header>

      {top && <div className="mb-2">{top}</div>}

      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={cn(
            "flex min-h-16 flex-1 flex-col gap-2 rounded-inner transition-colors",
            isOver && "bg-brand/5",
          )}
        >
          {children}
        </ul>
      </SortableContext>

      {footer && <div className="mt-2">{footer}</div>}
    </section>
  );
}

function SortableCard({
  id,
  label,
  draggable,
  gripHintId,
  onArrow,
  children,
}: {
  id: string;
  label: string;
  draggable: boolean;
  gripHintId: string;
  /** Returns true when the key moved the card. */
  onArrow: (key: string) => boolean;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !draggable,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...(draggable ? listeners : null)}
      className={cn(
        "group/card relative rounded-inner bg-panel p-3 shadow-soft-sm",
        draggable && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      {draggable && (
        <button
          type="button"
          data-board-grip={id}
          aria-label={`Move ${label}`}
          aria-describedby={gripHintId}
          onKeyDown={(event) => {
            if (onArrow(event.key)) event.preventDefault();
          }}
          className="absolute top-2 right-1.5 rounded p-0.5 text-ink-3 opacity-0 outline-none transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </button>
      )}
      {children}
    </li>
  );
}
