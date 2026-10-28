"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PartnerCard } from "@convex/lib/partnerStages";
import { Board } from "@/components/board/board";
import { AddCard } from "@/components/pipeline/add-card";
import { messageOf } from "@/lib/errors";
import { PARTNER_COLUMNS } from "@/lib/partnerships/view";
import { PartnerCardView } from "./partner-card";
import { PartnerEditor, type PartnerChange } from "./partner-editor";

/** New partners go under the stages where nobody has yet agreed anything. */
const ADD_UNDER: readonly string[] = ["identified", "contacted", "in_talks"];

/**
 * The partnerships board: the shared kanban with partner cards on it, an add
 * control under the early stages, and the editor. It owns no data: every
 * change is reported to the page, which applies it with its own mutations,
 * and one the server refuses is shown with the server's reason. A partner
 * just added opens its editor at once, since its type still has to be chosen.
 */
export function PartnerBoard({
  board,
  now,
  today,
  currency,
  onMove,
  onCreate,
  onSave,
  onDelete,
  editorBelow,
}: {
  board: Readonly<Record<string, readonly PartnerCard[]>>;
  now: number | null;
  today: string | null;
  currency: string;
  onMove: (id: string, stage: string, index: number) => Promise<unknown>;
  /** Returns the new partner's id. */
  onCreate: (stage: string, name: string) => Promise<string>;
  onSave: (id: string, change: PartnerChange) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** Drawn under the editor's form for the open partner (linked contacts). */
  editorBelow?: (partner: PartnerCard) => ReactNode;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const columns = useMemo(
    () => PARTNER_COLUMNS.map((column) => ({ ...column, count: board[column.id]?.length ?? 0 })),
    [board],
  );
  const items = useMemo(
    () => Object.fromEntries(PARTNER_COLUMNS.map((column) => [column.id, [...(board[column.id] ?? [])]])),
    [board],
  );
  const editing =
    editingId === null
      ? undefined
      : (Object.values(board)
          .flat()
          .find((partner) => partner.id === editingId) ?? null);

  return (
    <>
      <Board<PartnerCard>
        columns={columns}
        items={items}
        // Seven columns: keep their width and scroll.
        fixedColumns
        getLabel={(partner) => partner.name}
        renderCard={(partner) => (
          <PartnerCardView partner={partner} now={now} today={today} onOpen={setEditingId} />
        )}
        onMove={(id, stage, index) => {
          setMoveError(null);
          // If the server refuses, Convex puts the card back where it was;
          // say why, so it does not look like the drop was ignored.
          onMove(id, stage, index).catch((failure) =>
            setMoveError(messageOf(failure, "That move could not be saved.")),
          );
        }}
        columnFooter={(column) =>
          ADD_UNDER.includes(column.id) ? (
            <AddCard
              label="Add a partner"
              fieldLabel={`New partner in ${column.title}`}
              placeholder="Company or organisation"
              onAdd={async (name) => setEditingId(await onCreate(column.id, name))}
            />
          ) : null
        }
      />

      {moveError && (
        <p role="alert" className="text-sm text-destructive">
          {moveError}
        </p>
      )}

      {editing !== undefined && (
        <PartnerEditor
          // Remount per partner so each starts with no draft. Never keyed on
          // the partner's data: a live update must not discard what is typed.
          key={editingId}
          partner={editing}
          currency={currency}
          onSave={(change) => onSave(editingId!, change)}
          onDelete={() => onDelete(editingId!)}
          onClose={() => setEditingId(null)}
          below={editing ? editorBelow?.(editing) : undefined}
        />
      )}
    </>
  );
}
