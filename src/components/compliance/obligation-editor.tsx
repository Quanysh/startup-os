"use client";

import { useMutation } from "convex/react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "@convex/lib/limits";
import {
  OBLIGATION_CATEGORIES,
  OBLIGATION_STATUS_LABELS,
  RECURRENCES,
  RECURRENCE_LABELS,
  type ObligationCategory,
  type ObligationRow,
  type ObligationStatus,
  type Recurrence,
} from "@convex/lib/obligationShape";
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
import { cn } from "@/lib/utils";

// "Done" is reached with "Mark done", which also schedules the next cycle. It
// is offered here only on an item that is already done, so saving keeps it.
const EDITABLE_STATUSES: readonly ObligationStatus[] = ["open", "in_progress", "not_applicable"];

/** The same rule the server applies (cleanLink), said before the round trip. */
function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Add an obligation, or edit one. The fields are read from the obligation
 * once, when the editor opens: a live update arriving while it is open never
 * replaces what has been typed.
 *
 * A date is a deadline only once the owner has ticked that they checked it,
 * and changing the date clears the tick: the confirmation was of the old one.
 */
export function ObligationEditor({
  obligation,
  category: startCategory,
  onClose,
}: {
  /** The item being edited, or null to add one. */
  obligation: ObligationRow | null;
  /** The category a new item starts in. */
  category: ObligationCategory;
  onClose: () => void;
}) {
  const create = useMutation(api.obligations.create);
  const update = useMutation(api.obligations.update);
  const remove = useMutation(api.obligations.remove);

  const [title, setTitle] = useState(obligation?.title ?? "");
  const [category, setCategory] = useState<ObligationCategory>(obligation?.category ?? startCategory);
  const [due, setDue] = useState(obligation?.due ?? "");
  const [dueConfirmed, setDueConfirmed] = useState(obligation?.dueConfirmed ?? false);
  const [recurrence, setRecurrence] = useState<Recurrence>(obligation?.recurrence ?? "none");
  const [status, setStatus] = useState<ObligationStatus>(obligation?.status ?? "open");
  const [evidenceUrl, setEvidenceUrl] = useState(obligation?.evidenceUrl ?? "");
  const [note, setNote] = useState(obligation?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = {
    title: useId(),
    category: useId(),
    due: useId(),
    confirmed: useId(),
    recurrence: useId(),
    status: useId(),
    evidence: useId(),
    note: useId(),
  };

  const changeDue = (value: string) => {
    setDue(value);
    // The tick was for the date that was there.
    setDueConfirmed(false);
  };

  const problem = (): string | null => {
    if (title.trim() === "") return "A compliance item needs a title.";
    if (title.trim().length > MAX_TITLE_LENGTH) {
      return `That title is too long (${MAX_TITLE_LENGTH} characters at most).`;
    }
    if (note.trim().length > MAX_NOTES_LENGTH) {
      return `That note is too long (${MAX_NOTES_LENGTH} characters at most).`;
    }
    if (evidenceUrl.trim() !== "" && !isHttps(evidenceUrl.trim())) {
      return "An evidence link must be a full https:// address.";
    }
    return null;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = problem();
    if (found !== null) return setError(found);
    setBusy(true);
    setError(null);
    const confirmed = due !== "" && dueConfirmed;
    try {
      if (obligation === null) {
        await create({
          category,
          title,
          recurrence,
          ...(due !== "" ? { due, dueConfirmed: confirmed } : null),
          ...(note.trim() !== "" ? { note } : null),
          ...(evidenceUrl.trim() !== "" ? { evidenceUrl } : null),
        });
      } else {
        await update({
          id: obligation.id,
          category,
          title,
          due: due === "" ? null : due,
          dueConfirmed: confirmed,
          recurrence,
          // Never sent as "done": that is "Mark done"'s to set.
          ...(status !== "done" ? { status } : null),
          note: note.trim() === "" ? null : note,
          evidenceUrl: evidenceUrl.trim() === "" ? null : evidenceUrl,
        });
      }
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  const statuses: readonly ObligationStatus[] =
    obligation?.status === "done" ? ["done", ...EDITABLE_STATUSES] : EDITABLE_STATUSES;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{obligation === null ? "Add an item" : "Edit item"}</DialogTitle>
          <DialogDescription className="sr-only">
            What has to be done, its date, how often it repeats, and where the evidence is.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={ids.title}>Title</Label>
            <input
              id={ids.title}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={`${fieldClass} h-10`}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.category}>Category</Label>
              <select
                id={ids.category}
                value={category}
                onChange={(e) => setCategory(e.target.value as ObligationCategory)}
                className={`${fieldClass} h-10`}
              >
                {OBLIGATION_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {obligation !== null && (
              <div className="space-y-1.5">
                <Label htmlFor={ids.status}>Status</Label>
                <select
                  id={ids.status}
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ObligationStatus)}
                  className={`${fieldClass} h-10`}
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {OBLIGATION_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={ids.due}>Date</Label>
              <input
                id={ids.due}
                type="date"
                value={due}
                onChange={(e) => changeDue(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.recurrence}>Repeats</Label>
              <select
                id={ids.recurrence}
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value as Recurrence)}
                className={`${fieldClass} h-10`}
              >
                {RECURRENCES.map((r) => (
                  <option key={r} value={r}>
                    {RECURRENCE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor={ids.confirmed} className="flex items-start gap-2 text-sm text-ink">
              <input
                id={ids.confirmed}
                type="checkbox"
                checked={due !== "" && dueConfirmed}
                onChange={(e) => setDueConfirmed(due !== "" && e.target.checked)}
                className="mt-0.5 size-4 accent-brand"
              />
              I have checked this date
            </label>
            <p className="text-xs text-ink-3">
              {due === ""
                ? "With no date, the item is listed as having none: it is never shown as due."
                : "Until it is ticked, the date is shown as unconfirmed and is never counted as due or overdue."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={ids.evidence}>Evidence link</Label>
            <input
              id={ids.evidence}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
              className={`${fieldClass} h-10`}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={ids.note}>Note</Label>
            <textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className={`${fieldClass} py-2`}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {obligation === null ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this item?
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await remove({ id: obligation.id });
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That item could not be deleted. Try again."));
                      setConfirmDelete(false);
                    }
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className={`${quietButtonClass} -ml-3 hover:text-destructive`}
              >
                <Trash2Icon aria-hidden className="size-4" />
                Delete
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                Cancel
              </button>
              {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
              <button
                type="submit"
                aria-disabled={busy}
                className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
              >
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
