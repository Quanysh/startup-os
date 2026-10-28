"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { RESULT_LABELS, type OutcomeResult, type OutcomeSubjectKind } from "@convex/lib/outcomes";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { dayLabel } from "@/lib/format";

// A deal's, a customer's or a partner's "Outcomes" (Bot Loop v3): what came of
// each play a bot ran on it, newest first. Read through `outcomes.forSubject`
// (the `outcomes` area); someone without the area is shown nothing, never an
// empty shell. Every text here a bot wrote: shown as text.

export const RESULT_TONES: Record<OutcomeResult, StatusTone> = {
  worked: "success",
  failed: "danger",
  pending: "neutral",
};

/** A signal as words: "no_reply" reads "no reply". */
const signalWords = (signal: string) => signal.replace(/_/g, " ");

export function OutcomesTimeline({ kind, id }: { kind: OutcomeSubjectKind; id: string }) {
  const { can } = useViewer();
  const allowed = can("outcomes");
  const rows = useQuery(api.outcomes.forSubject, allowed && id !== "" ? { kind, id } : "skip");
  const now = useNow();
  if (!allowed) return null;

  return (
    <section aria-labelledby={`outcomes-${id}`} className="space-y-3">
      <h2 id={`outcomes-${id}`} className="text-base">
        Outcomes
      </h2>
      {rows === undefined ? (
        <Skeleton className="h-16 rounded-inner" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-2">No outcomes logged yet. A bot logs what came of a play it ran here.</p>
      ) : (
        <ol className="space-y-3 border-l border-line pl-4">
          {rows.map((row) => (
            <li key={row.id} className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusChip tone={RESULT_TONES[row.result]}>{RESULT_LABELS[row.result]}</StatusChip>
                {/* The play's name and the bot's id: text a bot chose, never markup. */}
                <span className="min-w-0 break-words font-medium text-ink">{row.play}</span>
                <KindTag tone="slate">{row.by}</KindTag>
              </div>
              <p className="text-xs text-ink-3">
                {now === null ? row.actedOn : dayLabel(row.actedOn, now)}
                {row.channel !== null && ` · ${row.channel}`}
                {row.signal !== null && ` · ${signalWords(row.signal)}`}
              </p>
              <p className="whitespace-pre-line break-words text-sm text-ink-2">{row.evidence}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
