"use client";

import { useMutation } from "convex/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_DISMISS_REASON_LENGTH, isAgentId, type RejectCode } from "@convex/lib/agents";
import { EditThenApprove } from "@/components/approvals/edit-then-approve";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import {
  ONE_CLICK_WORDS,
  REJECT_CHIPS,
  URGENCY_LABELS,
  ageTone,
  decideMany,
  duplicateBadge,
  hasReason,
  kindLabel,
  oneClickOnly,
  rowSentence,
  whoLabel,
  type Deciders,
  type InboxRow,
} from "@/lib/approvals/inbox";
import { AGENT_TONES } from "@/lib/assistant/agents";
import { fieldsOf } from "@/lib/assistant/words";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";

// One waiting item, as /approvals lists it and as a chat answer shows the
// proposal it just made: the same row, the same data (`assistant.inbox`) and
// the same calls. Model text is rendered as text: never markup, never a link
// built from it (a source's link is built from its kind).

const URGENCY_TONES: Record<InboxRow["urgency"], StatusTone> = {
  critical: "danger",
  high: "warning",
  normal: "neutral",
  low: "neutral",
};
const AGE_TONES = { amber: "warning", red: "danger" } as const;
const small = "h-9 px-3";

/** The calls that decide a row: each one's own, never a path of this page's. */
export function useDeciders(): Deciders {
  const approve = useMutation(api.assistant.approve);
  const dismiss = useMutation(api.assistant.dismiss);
  const decide = useMutation(api.agentRuntime.decide);
  return { approve, dismiss, decide } as never;
}

/** Copy a draft's text: approving one only marks it kept, and nothing is ever sent. */
export function CopyText({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={cn(quietButtonClass, small, "bg-surface text-ink")}>
        {state === "copied" ? <CheckIcon aria-hidden className="size-4" /> : <CopyIcon aria-hidden className="size-4" />}
        Copy
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "copied" && "Copied."}
        {state === "failed" && "Could not copy. Select the text and copy it by hand."}
      </span>
    </span>
  );
}

/**
 * What the owner needs to decide without a click: why, what approving would
 * change (the server's effect: before → after, or a draft's full text), the
 * goal it serves (or "No goal" in grey) and its evidence.
 */
function Context({ row }: { row: InboxRow }) {
  if (row.source === "tool_call") {
    return <p className="mt-1 font-mono text-xs break-all text-ink-2">{row.arguments}</p>;
  }
  const changes = row.effect?.changes ?? row.changes;
  return (
    <div className="mt-1 space-y-1 text-xs text-ink-2">
      {row.why !== null && (
        <p className="[overflow-wrap:anywhere]">
          <span className="text-ink-3">Why: </span>
          {row.why}
        </p>
      )}
      {changes.length > 0 && (
        <ul className="space-y-0.5" aria-label="What changes">
          {changes.map((change) => (
            <li key={change.field} className="[overflow-wrap:anywhere]">
              <span className="text-ink-3">{change.field}: </span>
              {change.before !== null && (
                <>
                  <span>{change.before}</span>
                  <span aria-hidden> → </span>
                  <span className="sr-only"> becomes </span>
                </>
              )}
              <span className="whitespace-pre-line text-ink">{change.after ?? "None"}</span>
            </li>
          ))}
        </ul>
      )}
      {row.duplicate?.reason != null && (
        <p className="[overflow-wrap:anywhere]">
          <span className="text-ink-3">Why it is not a duplicate: </span>
          {row.duplicate.reason}
        </p>
      )}
      {row.effect?.text != null && (
        <div className="rounded-inner border border-line bg-surface p-2" aria-label="Full text" data-testid="draft-body">
          <p className="font-medium text-ink [overflow-wrap:anywhere]">{row.effect.text.title}</p>
          <p className="mt-1 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{row.effect.text.body}</p>
        </div>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-0.5">
        {row.goal === null ? (
          <span className="text-ink-3">No goal</span>
        ) : (
          <span>
            <span className="text-ink-3">Goal: </span>
            {row.goal.title}
          </span>
        )}
        {row.evidence !== null && (
          <span>
            <span className="text-ink-3">Source: </span>
            <Link href={row.evidence.href} className="text-brand underline-offset-2 hover:underline">
              {row.evidence.label ?? `${row.evidence.kind} (no longer there)`}
            </Link>
          </span>
        )}
      </p>
    </div>
  );
}

/** Who proposed it, as a tag: one of the four in its own colour, a bot or another agent in slate. */
export function WhoTag({ row }: { row: Pick<InboxRow, "agent" | "bot" | "company"> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <KindTag tone={row.bot === null && isAgentId(row.agent) ? AGENT_TONES[row.agent] : "slate"}>{whoLabel(row)}</KindTag>
      {row.company !== null && <span className="text-xs text-ink-3 uppercase">{row.company}</span>}
    </span>
  );
}

/**
 * The row's own content: urgency, kind, a possible duplicate, whether it
 * takes a click of its own, its age (amber after a day, red after three);
 * what approving does; its context; and Edit then approve, or Copy for a
 * draft. `inTable`: the kind has a column of its own from md up.
 */
export function ApprovalBody({
  row,
  now,
  inTable = false,
  withEdit = true,
}: {
  row: InboxRow;
  now: number;
  inTable?: boolean;
  /** False where the row's actions carry Edit then approve themselves (the phone's card). */
  withEdit?: boolean;
}) {
  const age = ageTone(now, row.createdAt);
  const badge = duplicateBadge(row);
  return (
    <>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {row.urgency !== "normal" && (
          <StatusChip tone={URGENCY_TONES[row.urgency]} variant={row.urgency === "low" ? "outline" : "solid"} data-testid="urgency">
            {URGENCY_LABELS[row.urgency]}
          </StatusChip>
        )}
        <KindTag tone="slate" className={cn(inTable && "md:hidden")}>
          {kindLabel(row.kind)}
        </KindTag>
        {badge !== null && (
          <StatusChip tone="warning" variant="outline" data-testid="duplicate" title={badge} className="min-w-0">
            <span className="truncate">{badge}</span>
          </StatusChip>
        )}
        {oneClickOnly(row) && (
          <StatusChip tone="neutral" variant="outline" title={ONE_CLICK_WORDS} data-testid="own-click">
            Own click
          </StatusChip>
        )}
        {age === "fresh" ? (
          <span className="text-xs whitespace-nowrap text-ink-3" data-testid="age">
            {ageLabel(now, row.createdAt)}
          </span>
        ) : (
          <StatusChip tone={AGE_TONES[age]} data-testid="age">
            {ageLabel(now, row.createdAt)}
          </StatusChip>
        )}
      </div>
      <p className="text-ink [overflow-wrap:anywhere]" data-testid="proposal-sentence">
        {rowSentence(row, now)}
      </p>
      <Context row={row} />
      <div className="flex flex-wrap items-start gap-2">
        {withEdit && <EditThenApprove row={row} />}
        {row.kind === "draft" && (
          <span className="mt-2">
            <CopyText text={fieldsOf(row as never).body ?? ""} />
          </span>
        )}
      </div>
    </>
  );
}

/** "Approve", or "Keep" for a draft (nothing is sent: it is text to copy). */
export const approveLabel = (row: Pick<InboxRow, "kind">) => (row.kind === "draft" ? "Keep" : "Approve");

/** One rejection's reason: a quick one, words, or both; Reject stays off until there is one. */
function RejectOne({ onReject, onCancel, busy }: { onReject: (code: RejectCode | null, text: string) => void; onCancel: () => void; busy: boolean }) {
  const [code, setCode] = useState<RejectCode | null>(null);
  const [text, setText] = useState("");
  const id = useId();
  const ready = hasReason({ code, text });
  return (
    <form
      aria-label="Reject"
      className="mt-3 space-y-3 rounded-inner border border-line bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onReject(code, text);
      }}
    >
      <fieldset>
        <legend className="text-xs font-medium text-ink-2">Why not? It goes back to the proposer.</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {REJECT_CHIPS.map((chip) => (
            <button
              key={chip.code}
              type="button"
              aria-pressed={code === chip.code}
              onClick={() => setCode(code === chip.code ? null : chip.code)}
              className={cn(
                "h-8 rounded-full border px-3 text-xs font-medium",
                code === chip.code ? "border-brand bg-brand-fill text-on-brand" : "border-line bg-panel text-ink hover:bg-surface",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </fieldset>
      <label htmlFor={id} className="block text-xs font-medium text-ink-2">
        Reason in your words
      </label>
      <input id={id} value={text} maxLength={MAX_DISMISS_REASON_LENGTH} onChange={(e) => setText(e.target.value)} className={cn(fieldClass, "h-9")} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !ready} className={cn(primaryButtonClass, small)}>
          Reject
        </button>
        <button type="button" onClick={onCancel} className={cn(quietButtonClass, small, "bg-panel text-ink")}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One waiting item on its own, with its own Approve and Reject: what a chat
 * answer shows under itself for a proposal it just made. The same row as
 * /approvals, deciding through the same calls (`decideMany`, one row).
 */
export function ApprovalCard({ row, now }: { row: InboxRow; now: number }) {
  const deciders = useDeciders();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "approve" | "reject", code: RejectCode | null = null, text = "") => {
    if (busy) return;
    setBusy(true);
    const failed = await decideMany([row], action, deciders, () => ({ code, text }), (failure) =>
      messageOf(failure, "That could not be done. Try again."),
    );
    setError(failed[row.id] ?? null);
    if (failed[row.id] === undefined) setRejecting(false);
    setBusy(false);
  };
  return (
    <li className="rounded-inner border border-line p-4 text-sm" data-testid="proposal">
      <div className="mb-2">
        <WhoTag row={row} />
      </div>
      <ApprovalBody row={row} now={now} />
      {rejecting ? (
        <RejectOne busy={busy} onCancel={() => setRejecting(false)} onReject={(code, text) => void run("reject", code, text)} />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void run("approve")} className={cn(primaryButtonClass, small)}>
            {approveLabel(row)}
          </button>
          <button type="button" disabled={busy} onClick={() => setRejecting(true)} className={cn(quietButtonClass, small, "bg-surface text-ink")}>
            Reject
          </button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
