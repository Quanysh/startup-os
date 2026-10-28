"use client";

import { useState } from "react";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";

/**
 * Whether a Telegram username is tied to a Telegram account yet, and the way
 * to undo it. The first task someone adds from the group ties their username
 * to the account that wrote; the owner sees that here, with the date, and
 * "Reset link" forgets the account (never the username), so the next task
 * links afresh. Which account it is is never sent to the browser. The state
 * is shown to whoever is shown the person; the button only where the server
 * would let them press it (`team.resetTelegram` follows `team.update`).
 */
export function TelegramLink({
  linked,
  linkedAt,
  whose,
  onReset,
}: {
  linked: boolean;
  /** When it was linked; null for a link made before dates were kept. */
  linkedAt: number | null;
  /** Whose link the button resets, for someone who hears it without the row round it. */
  whose: string;
  /** Left out where the viewer may not reset it: the state is said, with no button. */
  onReset?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!linked) return <span className="block text-xs text-ink-3">Not used yet</span>;

  const reset = async () => {
    if (busy || onReset === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await onReset();
    } catch (failure) {
      setError(messageOf(failure, "The link could not be reset. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="block text-xs text-ink-2">
      <span>{linkedAt === null ? "Linked" : `Linked ${localIsoDate(linkedAt)}`}</span>
      {onReset !== undefined && (
        <>
          {" "}
          {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request.
              Not in a table's download: it is an action, not what the cell says. */}
          <button
            type="button"
            data-export-skip=""
            aria-disabled={busy}
            onClick={reset}
            className="font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60"
          >
            Reset link<span className="sr-only"> of {whose}</span>
          </button>
        </>
      )}
      {error !== null && (
        <span role="alert" className="block whitespace-normal text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
