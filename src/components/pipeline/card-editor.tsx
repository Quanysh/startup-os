"use client";

import { ArchiveIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { DealDetails, DealPriority } from "@convex/lib/dealDetails";
import type { BoardColumn } from "@/components/board/board";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { messageOf } from "@/lib/errors";
import { formatValue } from "@/lib/format";
import type { BoardCard } from "@/lib/pipeline/derive";
import { stageTitle } from "@/lib/pipeline/stages";

/** What a save sends: only the fields that were changed. Null clears one. */
export type CardEdit = {
  name?: string;
  contact?: string | null;
  amount?: number | null;
  stage?: string;
  nextStep?: string | null;
  notes?: string | null;
  // A US deal's details, sent only by an editor opened `withDetails`.
  priority?: DealPriority | null;
  region?: string | null;
  physicians?: number | null;
  locations?: number | null;
  sources?: string[] | null;
};

const PRIORITY_LABELS: Record<DealPriority, string> = { high: "High", medium: "Medium", low: "Low" };

export type EditorWords = {
  /** "deal", "investor". */
  noun: string;
  /** The dialog's title: "Deal", "Investor". */
  title: string;
  nameLabel: string;
  /** Said when the name is blank; the server says the same. */
  blankName: string;
  /** "Monthly fee (USD)", "Cheque (USD)". */
  amountLabel: string;
};

type Draft = {
  name?: string;
  contact?: string;
  amount?: string;
  stage?: string;
  nextStep?: string;
  notes?: string;
  priority?: string;
  region?: string;
  physicians?: string;
  locations?: string;
  sources?: string;
};

const orNull = (text: string) => (text.trim() === "" ? null : text);
const countText = (count: number | null | undefined) => (count == null ? "" : String(count));
/** A count as typed: null for blank, undefined for what is not a whole number. */
const countOf = (text: string): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
};
/** The sources box: one title per line, blank lines dropped. */
const sourcesOf = (text: string) => {
  const titles = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return titles.length === 0 ? null : titles;
};

/**
 * Edit one card.
 *
 * What is typed is kept in a draft, field by field, and a field with a draft
 * never takes the server's value: a push from the source or a save landing
 * elsewhere must not replace words the owner has not saved. A field with no
 * draft shows the live value, so a mirrored card's company and stage stay
 * current while its notes are being written.
 *
 * A mirrored card shows its source-owned fields as text, with no inputs for
 * them and no delete: they are changed where they live. (The server refuses
 * them too; this is only what is offered.)
 *
 * A mirrored card whose source takes changes back (`editable`: a Visible
 * investor) offers its name, amount and stage as inputs and keeps its contact
 * as text: the server queues the change for the source. `note` then says so.
 *
 * `onArchive` adds "Archive" (asked first): the card leaves the board and can
 * be restored. Delete stays for a card made here.
 *
 * `withDetails` (the US sales table) adds a deal's priority, region, size and
 * sources, for a card made here; a mirrored card is never offered them.
 * Without it the editor is what the boards have always opened.
 */
export function CardEditor({
  card,
  words,
  columns,
  currency,
  mirrorNamed,
  withDetails = false,
  editable: editableProp,
  note,
  onSave,
  onDelete,
  onArchive,
  onClose,
  below,
}: {
  /** The live card, or null once it has left the board. */
  card: (BoardCard & Partial<DealDetails>) | null;
  words: EditorWords;
  columns: readonly BoardColumn[];
  currency: string;
  /** For a mirrored card, its source inside a sentence: "the Kazakhstan CRM". */
  mirrorNamed: string | null;
  /** Offer a deal's details (priority, region, size, sources). */
  withDetails?: boolean;
  /** Whether its name, amount and stage can be changed here. Default: only a card made here. */
  editable?: boolean;
  /** For a mirrored card, the line under the title in place of the default. */
  note?: string;
  onSave: (edit: CardEdit) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  /** Take it off the board without deleting it; not offered when absent. */
  onArchive?: () => Promise<unknown>;
  onClose: () => void;
  /** Drawn under the form: linked contacts, mounted by the page (it reads Convex). */
  below?: ReactNode;
}) {
  // The last card seen, so the form still has something to show (and the
  // owner's text something to sit in) if the card leaves the board.
  const [last, setLast] = useState(card);
  if (card !== null && card !== last) setLast(card);
  const shown = card ?? last;

  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"delete" | "archive" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    name: useId(),
    contact: useId(),
    amount: useId(),
    stage: useId(),
    nextStep: useId(),
    notes: useId(),
    priority: useId(),
    region: useId(),
    physicians: useId(),
    locations: useId(),
    sources: useId(),
  };

  if (shown === null) return null;
  const gone = card === null;
  const mirrored = shown.mirrored;
  const editable = editableProp ?? !mirrored;
  const details = withDetails && !mirrored;
  const edit = (patch: Draft) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const fields = {
    name: draft.name ?? shown.name,
    contact: draft.contact ?? shown.contact ?? "",
    amount: draft.amount ?? (shown.amount === null ? "" : String(shown.amount)),
    stage: draft.stage ?? shown.stage,
    nextStep: draft.nextStep ?? shown.nextStep ?? "",
    notes: draft.notes ?? shown.notes ?? "",
    priority: draft.priority ?? shown.priority ?? "",
    region: draft.region ?? shown.region ?? "",
    physicians: draft.physicians ?? countText(shown.physicians),
    locations: draft.locations ?? countText(shown.locations),
    sources: draft.sources ?? (shown.sources ?? []).join("\n"),
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (gone || busy) return;
    const changes: CardEdit = {};
    if (draft.name !== undefined) {
      if (draft.name.trim() === "") return setError(words.blankName);
      changes.name = draft.name;
    }
    if (draft.contact !== undefined) changes.contact = orNull(draft.contact);
    if (draft.amount !== undefined) {
      const text = draft.amount.trim().replaceAll(",", "");
      const amount = text === "" ? null : Number(text);
      if (amount !== null && !Number.isFinite(amount)) {
        return setError("That amount is not a number.");
      }
      changes.amount = amount;
    }
    if (draft.stage !== undefined) changes.stage = draft.stage;
    if (draft.nextStep !== undefined) changes.nextStep = orNull(draft.nextStep);
    if (draft.notes !== undefined) changes.notes = orNull(draft.notes);
    if (details) {
      if (draft.priority !== undefined) {
        changes.priority = draft.priority === "" ? null : (draft.priority as DealPriority);
      }
      if (draft.region !== undefined) changes.region = orNull(draft.region);
      for (const [key, label] of [
        ["physicians", "Physicians"],
        ["locations", "Locations"],
      ] as const) {
        const typed = draft[key];
        if (typed === undefined) continue;
        const count = countOf(typed);
        if (count === undefined) return setError(`${label} must be a whole number.`);
        changes[key] = count;
      }
      if (draft.sources !== undefined) changes.sources = sourcesOf(draft.sources);
    }
    if (Object.keys(changes).length === 0) return onClose();

    setBusy(true);
    setError(null);
    try {
      await onSave(changes);
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{words.title}</DialogTitle>
          <DialogDescription className={mirrored ? "text-sm text-ink-2" : "sr-only"}>
            {!mirrored
              ? `Change this ${words.noun}'s details, stage, next step and notes.`
              : (note ??
                `Mirrored from ${mirrorNamed ?? "another system"}. Its name, contact, stage and amount are changed there. The next step and notes are yours and stay here.`)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4">
          {!editable ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-inner bg-surface p-4 text-sm">
              <dt className="text-ink-3">{words.nameLabel}</dt>
              <dd className="text-ink">{shown.name}</dd>
              <dt className="text-ink-3">Contact</dt>
              <dd className="text-ink">{shown.contact ?? "None given"}</dd>
              <dt className="text-ink-3">Stage</dt>
              <dd className="text-ink">
                {stageTitle(columns, shown.stage)}
                {shown.sourceStage && (
                  <span className="text-ink-2">{` (there: ${shown.sourceStage})`}</span>
                )}
              </dd>
              <dt className="text-ink-3">Amount</dt>
              <dd className="text-ink">
                {shown.amount === null ? "None given" : formatValue(shown.amount, "currency", currency)}
              </dd>
            </dl>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={ids.name}>{words.nameLabel}</Label>
                <input
                  id={ids.name}
                  value={fields.name}
                  disabled={gone}
                  onChange={(e) => edit({ name: e.target.value })}
                  className={`${fieldClass} h-10`}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {mirrored ? (
                  // The source's: changed there, never sent from here.
                  <dl className="space-y-1.5">
                    <dt className="text-sm font-medium text-ink">Contact</dt>
                    <dd className="flex h-10 items-center text-sm text-ink-2">
                      {shown.contact ?? "None given"}
                    </dd>
                  </dl>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.contact}>Contact</Label>
                    <input
                      id={ids.contact}
                      value={fields.contact}
                      disabled={gone}
                      onChange={(e) => edit({ contact: e.target.value })}
                      className={`${fieldClass} h-10`}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor={ids.amount}>{words.amountLabel}</Label>
                  <input
                    id={ids.amount}
                    inputMode="decimal"
                    value={fields.amount}
                    disabled={gone}
                    onChange={(e) => edit({ amount: e.target.value })}
                    className={`${fieldClass} h-10 font-num`}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.stage}>Stage</Label>
                <select
                  id={ids.stage}
                  value={fields.stage}
                  disabled={gone}
                  onChange={(e) => edit({ stage: e.target.value })}
                  className={`${fieldClass} h-10`}
                >
                  {columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.title}
                    </option>
                  ))}
                </select>
              </div>
              {details && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={ids.priority}>Priority</Label>
                      <select
                        id={ids.priority}
                        value={fields.priority}
                        disabled={gone}
                        onChange={(e) => edit({ priority: e.target.value })}
                        className={`${fieldClass} h-10`}
                      >
                        <option value="">No priority</option>
                        {(Object.entries(PRIORITY_LABELS) as [DealPriority, string][]).map(
                          ([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={ids.region}>Region</Label>
                      <input
                        id={ids.region}
                        value={fields.region}
                        disabled={gone}
                        placeholder="A state, like TX"
                        onChange={(e) => edit({ region: e.target.value })}
                        className={`${fieldClass} h-10`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={ids.physicians}>Physicians</Label>
                      <input
                        id={ids.physicians}
                        inputMode="numeric"
                        value={fields.physicians}
                        disabled={gone}
                        onChange={(e) => edit({ physicians: e.target.value })}
                        className={`${fieldClass} h-10 font-num`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={ids.locations}>Locations</Label>
                      <input
                        id={ids.locations}
                        inputMode="numeric"
                        value={fields.locations}
                        disabled={gone}
                        onChange={(e) => edit({ locations: e.target.value })}
                        className={`${fieldClass} h-10 font-num`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.sources}>Sources</Label>
                    <textarea
                      id={ids.sources}
                      value={fields.sources}
                      disabled={gone}
                      rows={2}
                      aria-describedby={`${ids.sources}-hint`}
                      onChange={(e) => edit({ sources: e.target.value })}
                      className={`${fieldClass} py-2`}
                    />
                    <p id={`${ids.sources}-hint`} className="text-xs text-ink-3">
                      The research it came from: one title per line, no links.
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={ids.nextStep}>Next step</Label>
            <input
              id={ids.nextStep}
              value={fields.nextStep}
              disabled={gone}
              onChange={(e) => edit({ nextStep: e.target.value })}
              className={`${fieldClass} h-10`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.notes}>Notes</Label>
            <textarea
              id={ids.notes}
              value={fields.notes}
              disabled={gone}
              onChange={(e) => edit({ notes: e.target.value })}
              rows={3}
              className={`${fieldClass} py-2`}
            />
          </div>

          {gone && (
            <p role="alert" className="text-sm text-destructive">
              {`This ${words.noun} left the board while you were editing, so it can no longer be saved. Copy anything you need before closing.`}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {gone ? (
              <span />
            ) : confirming === "delete" ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                {`Delete this ${words.noun}?`}
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onDelete();
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That could not be deleted. Try again."));
                      setConfirming(null);
                    }
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : confirming === "archive" && onArchive ? (
              <span className="flex flex-wrap items-center gap-1 text-sm text-ink-2">
                {`Archive this ${words.noun}? It can be restored.`}
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await onArchive();
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That could not be archived. Try again."));
                      setConfirming(null);
                    }
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-ink outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Archive it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="-ml-3 flex flex-wrap gap-1">
                {onArchive && (
                  <button type="button" onClick={() => setConfirming("archive")} className={quietButtonClass}>
                    <ArchiveIcon aria-hidden className="size-4" />
                    Archive
                  </button>
                )}
                {!mirrored && (
                  <button
                    type="button"
                    onClick={() => setConfirming("delete")}
                    className={`${quietButtonClass} hover:text-destructive`}
                  >
                    <Trash2Icon aria-hidden className="size-4" />
                    Delete
                  </button>
                )}
              </span>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                {gone ? "Close without saving" : "Cancel"}
              </button>
              <button type="submit" disabled={busy || gone} className={primaryButtonClass}>
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
        {below !== undefined && <div className="mt-6 border-t border-line pt-4">{below}</div>}
      </DialogContent>
    </Dialog>
  );
}
