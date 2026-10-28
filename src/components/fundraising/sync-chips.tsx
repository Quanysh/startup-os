"use client";

import { CloudUploadIcon, Loader2Icon, PencilLineIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { StatusChip } from "@/components/ui/status-chip";
import { messageOf } from "@/lib/errors";
import type { InvestorExtras } from "@/lib/fundraising/sync";
import { syncStateOf } from "@/lib/fundraising/sync";
import { SYNC_WORDS, syncErrorWords } from "@/lib/fundraising/words";

/**
 * What an investor card says about Visible: its change on the way ("Syncing
 * to Visible"), a send that failed with the reason in words and Retry, or a
 * value someone changed in Visible since. Nothing while it is up to date.
 * Retry (`investors.retrySync`) puts the change back in the queue for the
 * next daily run.
 */
export function SyncChips({
  card,
  onRetry,
  className,
}: {
  card: Pick<InvestorExtras, "sync" | "changedInVisible"> & { id: string; name: string };
  onRetry: (id: string) => Promise<unknown>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = syncStateOf(card);
  if (state === "none") return null;

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRetry(card.id);
    } catch (failure) {
      setError(messageOf(failure, SYNC_WORDS.retryFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className ?? "mt-1.5 flex flex-wrap items-center gap-1.5"}>
      {state === "syncing" && (
        <StatusChip tone="info" icon={CloudUploadIcon}>
          {SYNC_WORDS.syncing}
        </StatusChip>
      )}
      {state === "failed" && (
        <>
          <StatusChip tone="danger" className="whitespace-normal">
            {SYNC_WORDS.failed(syncErrorWords(card.sync?.errorCode))}
          </StatusChip>
          <button
            type="button"
            aria-label={`Retry sending ${card.name} to Visible`}
            aria-disabled={busy}
            onClick={() => void retry()}
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60"
          >
            {busy ? (
              <Loader2Icon aria-hidden className="size-3 animate-spin" />
            ) : (
              <RotateCcwIcon aria-hidden className="size-3" />
            )}
            {SYNC_WORDS.retry}
          </button>
        </>
      )}
      {state === "changed" && (
        <StatusChip tone="warning" icon={PencilLineIcon}>
          {SYNC_WORDS.changed}
        </StatusChip>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
