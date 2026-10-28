"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CLOSED_SHOWN } from "@convex/lib/limits";
import { Board, type BoardColumn } from "@/components/board/board";
import { messageOf } from "@/lib/errors";
import { quietness, type BoardCard } from "@/lib/pipeline/derive";
import { boardColumns } from "@/lib/pipeline/stages";
import { AddCard } from "./add-card";
import { CardEditor, type CardEdit, type EditorWords } from "./card-editor";
import { PipelineCardView } from "./pipeline-card";

// A mirrored column longer than this opens on its first cards.
const LONG_COLUMN = 8;

/**
 * A pipeline board: the shared kanban, with pipeline cards on it, an add
 * control under the stages that take new cards, and the editor.
 *
 * It owns no data. Every change is reported to the page, which applies it
 * with its own mutations; a change the server refuses is shown with the
 * server's reason. A mirrored card is passed to the board with `canDrag`
 * false, so it has no grip and cannot be picked up, unless the page says
 * otherwise (`canDrag`: a Visible investor, whose moves are sent back).
 * `cardFooter` puts something under a card (the fundraising page's sync
 * chips); `editableOf`, `editorNote` and `onArchive` reach the editor.
 */
export function PipelineBoard<C extends BoardCard = BoardCard>({
  board,
  columns,
  judgedStages,
  limitDays,
  now,
  currency,
  amountSuffix,
  mirror,
  words,
  add,
  onMove,
  onCreate,
  onSave,
  onDelete,
  canDrag = (card: C) => !card.mirrored,
  cardFooter,
  editableOf,
  editorNote,
  onArchive,
  editorBelow,
}: {
  board: Readonly<Record<string, readonly C[]>>;
  columns: readonly BoardColumn[];
  /** Stages whose cards can go quiet: the open ones. */
  judgedStages: readonly string[];
  limitDays: number;
  /** null while rendering on the server: no card is judged yet. */
  now: number | null;
  currency: string;
  amountSuffix?: string;
  /** Where this board's mirrored cards come from, if it has any. */
  mirror: { short: string; named: string } | null;
  words: EditorWords;
  /** The add control's words and the stages it appears under, or null for none. */
  add: { label: string; placeholder: string; stages: readonly string[] } | null;
  onMove: (id: string, stage: string, index: number) => Promise<unknown>;
  onCreate: (stage: string, name: string) => Promise<unknown>;
  onSave: (id: string, edit: CardEdit) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** Whether a card can be picked up. Default: only a card made here. */
  canDrag?: (card: C) => boolean;
  /** Drawn at the foot of each card. */
  cardFooter?: (card: C) => ReactNode;
  /** Whether the editor offers a card's name, amount and stage. Default: only a card made here. */
  editableOf?: (card: C) => boolean;
  /** The editor's line for a mirrored card, in place of its default. */
  editorNote?: string;
  /** Archive from the editor; not offered when absent. */
  onArchive?: (id: string) => Promise<unknown>;
  /** Drawn under the editor's form for the open card (linked contacts). */
  editorBelow?: (card: C) => ReactNode;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Long mirrored columns the owner has opened in full.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Memoised: the board compares these by identity to know when cards moved.
  // Every column says how many cards it holds, however many it shows.
  const shown = useMemo(
    () =>
      boardColumns(columns, board).map((column) => ({
        ...column,
        count: board[column.id]?.length ?? 0,
      })),
    [columns, board],
  );
  // A column none of whose cards can be picked up cannot be rearranged here,
  // so a long one may be cut short without a hidden card ever being a drop
  // target.
  const long = (column: { id: string; sortable?: boolean }) =>
    mirror !== null &&
    column.sortable !== false &&
    (board[column.id] ?? []).every((card) => !canDrag(card)) &&
    (board[column.id]?.length ?? 0) > LONG_COLUMN;
  const cut = (column: { id: string; sortable?: boolean }) =>
    long(column) && !expanded.has(column.id);
  // A closed column shows its latest cards; the numbers above count them all.
  const items = useMemo(
    () =>
      Object.fromEntries(
        shown.map((column) => {
          const cards = board[column.id] ?? [];
          if (column.sortable === false) return [column.id, cards.slice(0, CLOSED_SHOWN)];
          return [column.id, cut(column) ? cards.slice(0, LONG_COLUMN) : cards];
        }),
      ),
    // `cut` reads the same three things.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, board, expanded, mirror],
  );
  const editing =
    editingId === null
      ? undefined
      : (Object.values(board)
          .flat()
          .find((card) => card.id === editingId) ?? null);

  return (
    <>
      <Board<C>
        columns={shown}
        items={items}
        // More columns than fit side by side: keep their width and scroll.
        fixedColumns={shown.length > 5}
        getLabel={(card) => card.name}
        canDrag={canDrag}
        renderCard={(card) => (
          <PipelineCardView
            card={card}
            quiet={
              now !== null && judgedStages.includes(card.stage)
                ? quietness(card, now, limitDays)
                : null
            }
            currency={currency}
            amountSuffix={amountSuffix}
            onOpen={setEditingId}
            footer={cardFooter?.(card)}
          />
        )}
        onMove={(id, stage, index) => {
          setMoveError(null);
          // If the server refuses, Convex puts the card back where it was;
          // say why, so it does not look like the drop was simply ignored.
          onMove(id, stage, index).catch((failure) =>
            setMoveError(messageOf(failure, "That move could not be saved.")),
          );
        }}
        columnFooter={(column) => {
          const total = board[column.id]?.length ?? 0;
          const open = expanded.has(column.id);
          const toggle = long(column) && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setExpanded((before) => {
                  const next = new Set(before);
                  if (open) next.delete(column.id);
                  else next.add(column.id);
                  return next;
                })
              }
              className="w-full rounded-full px-2 py-1.5 text-left text-xs font-medium text-ink-2 outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {open ? `Show the first ${LONG_COLUMN}` : `Show all ${total}`}
            </button>
          );
          if (add?.stages.includes(column.id)) {
            return (
              <>
                {toggle}
                <AddCard
                  label={add.label}
                  fieldLabel={`New ${words.noun} in ${column.title}`}
                  placeholder={add.placeholder}
                  onAdd={(name) => onCreate(column.id, name)}
                />
              </>
            );
          }
          if (toggle) return toggle;
          return total > CLOSED_SHOWN && column.sortable === false ? (
            <p className="px-2 text-[11px] text-ink-3">
              Showing the latest {CLOSED_SHOWN}. Older ones still count above.
            </p>
          ) : null;
        }}
      />

      {moveError && (
        <p role="alert" className="text-sm text-destructive">
          {moveError}
        </p>
      )}

      {editing !== undefined && (
        <CardEditor
          // Remount per card so each starts with no draft. Never keyed on the
          // card's data: a live update must not discard what is being typed.
          key={editingId}
          card={editing}
          words={words}
          columns={columns}
          currency={currency}
          mirrorNamed={mirror?.named ?? null}
          editable={editing === null || editableOf === undefined ? undefined : editableOf(editing)}
          note={editorNote}
          onSave={(edit) => onSave(editingId!, edit)}
          onDelete={() => onDelete(editingId!)}
          onArchive={onArchive && (() => onArchive(editingId!))}
          onClose={() => setEditingId(null)}
          below={editing ? editorBelow?.(editing) : undefined}
        />
      )}
    </>
  );
}
