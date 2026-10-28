"use client";

import { useMutation } from "convex/react";
import { CircleCheckIcon, LightbulbIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  SUGGESTION_MAX_LENGTH,
  SUGGESTION_PAGE_MAX_LENGTH,
  SUGGESTION_WORDS,
  suggestionCard,
} from "@convex/lib/suggestion";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/**
 * "Suggest a change", in the sidebar's footer: for anyone who wants the OS to
 * be better and does not write code. What is sent becomes a card in the task
 * board's Backlog (convex/suggestions.ts).
 *
 * The dialog, and with it the mutation, is mounted only once the button is
 * pressed, and anew each time: it always opens empty, on the page the viewer
 * is on then.
 */
export function SuggestChange() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 rounded-full text-xs text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <LightbulbIcon aria-hidden className="size-3.5" />
        Suggest a change
      </button>
      {open && <SuggestDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SuggestDialog({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.suggestions.create);
  const pathname = usePathname();
  const { can } = useViewer();
  const [text, setText] = useState("");
  const [page, setPage] = useState(pathname ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { text: useId(), page: useId(), error: useId() };

  // A refusal is about what was in the fields: once they change it is stale.
  const edit = (set: (value: string) => void, value: string) => {
    set(value);
    setError(null);
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // The server's own rules, so the words are the same either way.
    const card = suggestionCard(text, page);
    if (!card.ok) return setError(SUGGESTION_WORDS[card.error]);
    setBusy(true);
    setError(null);
    try {
      await create({ text, ...(page.trim() === "" ? null : { page }) });
      setSent(true);
    } catch (failure) {
      // What was typed stays in the field to be sent again.
      setError(messageOf(failure, "That could not be sent. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Suggest a change</DialogTitle>
          <DialogDescription className="text-sm text-ink-2">
            Something missing, wrong or awkward? Say it here and it becomes a card on the
            team&apos;s board.
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="space-y-4">
            <p role="status" className="flex items-center gap-2 text-sm text-ink">
              <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-brand" />
              Sent. It is on the team&apos;s board.
            </p>
            <div className="flex justify-end gap-2">
              {/* Only for someone who can open it: the card is there either way. */}
              {can("board") && (
                <Link href="/board" onClick={onClose} className={quietButtonClass}>
                  Open the board
                </Link>
              )}
              <button type="button" onClick={onClose} className={primaryButtonClass}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={send} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor={ids.text}>What should be better?</Label>
              <textarea
                id={ids.text}
                value={text}
                onChange={(e) => edit(setText, e.target.value)}
                rows={5}
                autoFocus
                aria-invalid={error !== null}
                aria-describedby={error !== null ? ids.error : undefined}
                placeholder="The first line becomes the card's title."
                className={`${fieldClass} py-2`}
              />
              <p className="text-right font-num text-xs text-ink-3">
                {text.trim().length} / {SUGGESTION_MAX_LENGTH}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={ids.page}>Which page (optional)</Label>
              <input
                id={ids.page}
                value={page}
                onChange={(e) => edit(setPage, e.target.value)}
                maxLength={SUGGESTION_PAGE_MAX_LENGTH}
                className={`${fieldClass} h-10`}
              />
            </div>

            {error && (
              <p id={ids.error} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                Cancel
              </button>
              {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
              <button
                type="submit"
                aria-disabled={busy}
                className={`${primaryButtonClass} aria-disabled:opacity-60`}
              >
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Send
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
