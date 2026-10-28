"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { quietButtonClass } from "@/components/panel";
import { cn } from "@/lib/utils";

/**
 * The question asked before something that cannot be undone. "Keep it" is
 * first in the tab order, so Enter on a just-opened dialog deletes nothing.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onKeep,
}: {
  title: string;
  /** What will happen, in a sentence or two. */
  children: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onKeep()}>
      <DialogContent showCloseButton={false} className="rounded-card p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
          <DialogDescription className="text-sm text-ink-2">{children}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => !busy && onKeep()} className={quietButtonClass}>
            Keep it
          </button>
          {/* aria-disabled, not disabled: a natively disabled button drops focus. */}
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => !busy && onConfirm()}
            className={cn(
              quietButtonClass,
              "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive aria-disabled:opacity-60",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
