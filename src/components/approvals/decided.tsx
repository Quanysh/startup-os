"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useId, useMemo } from "react";
import { api } from "@convex/_generated/api";
import { DECIDED_WINDOW_DAYS, REJECT_CODE_LABELS } from "@convex/lib/agents";
import { FlagAuto, Grants } from "@/components/approvals/autonomy";
import { Filters, useView } from "@/components/approvals/filters";
import { CopyText, WhoTag } from "@/components/approvals/row";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import {
  DECIDED_LABELS,
  agentsIn,
  filterInbox,
  goalsIn,
  kindLabel,
  whoLabel,
  type DecidedRow as Decided,
  type DecidedStatus,
} from "@/lib/approvals/inbox";
import { fieldsOf, proposalSentence, resultLink, withdrawnLine } from "@/lib/assistant/words";
import { ageLabel } from "@/lib/freshness";

// "Decided" on /approvals: what became of the last 30 days' proposals and
// tool calls, with the same filters as what waits. Approved automatically is
// here too, each with its one-click flag that revokes the grant. Model text
// is rendered as text; a link is built from what approving made, by id.

const TONES: Record<Exclude<DecidedStatus, "open">, StatusTone> = {
  approved: "success",
  auto_approved: "info",
  dismissed: "neutral",
  denied: "neutral",
  expired: "warning",
  withdrawn: "neutral",
};

const HOUR = 60 * 60 * 1000;
/** From when "Decided" reads: 30 days before the page's clock, to the hour, so the query is not asked anew every tick. */
export const decidedSince = (now: number) => now - (now % HOUR) - DECIDED_WINDOW_DAYS * 24 * HOUR;

/** The owner's reason, as said back: the quick reason and the words, either or both. */
export function reasonLine(row: Pick<Decided, "rejectCode" | "rejectReason">): string | null {
  const code = row.rejectCode === null ? null : REJECT_CODE_LABELS[row.rejectCode];
  if (code === null && row.rejectReason === null) return null;
  return [code, row.rejectReason].filter((part) => part !== null).join(": ");
}

/** One decided item: how it ended, who proposed it, what it did, and the owner's reason. */
export function DecidedRow({ row, now }: { row: Decided; now: number | null }) {
  const status = row.status === "open" ? null : row.status;
  const link = row.status === "approved" || row.status === "auto_approved" ? resultLink(row.result as never) : null;
  const reason = reasonLine(row);
  const withdrawn = row.source === "proposal" ? withdrawnLine(row as never) : null;
  return (
    <li className="min-w-0 py-3 text-sm" data-testid="decided">
      <div className="flex flex-wrap items-center gap-2">
        {status !== null && <StatusChip tone={TONES[status]}>{DECIDED_LABELS[status]}</StatusChip>}
        {row.flagged && (
          <StatusChip tone="warning" variant="outline">
            Flagged
          </StatusChip>
        )}
        <WhoTag row={row} />
        <KindTag tone="slate">{kindLabel(row.kind)}</KindTag>
        <span className="text-xs text-ink-3">
          {now === null || row.decidedAt === null ? "" : ageLabel(now, row.decidedAt)}
          {row.edited && " · you edited it first"}
        </span>
      </div>
      <p className="mt-1.5 text-ink [overflow-wrap:anywhere]">
        {row.source === "tool_call" ? `Run a tool: ${row.toolName}` : now === null ? "" : proposalSentence(row as never, now)}
      </p>
      {row.source === "tool_call" && <p className="mt-1 font-mono text-xs break-all text-ink-2">{row.arguments}</p>}
      {row.why !== null && (
        <p className="mt-1 text-xs text-ink-2 [overflow-wrap:anywhere]">
          <span className="text-ink-3">Why: </span>
          {row.why}
        </p>
      )}
      {row.edits.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-ink-2" aria-label="What you changed">
          {row.edits.map((edit) => (
            <li key={edit.field} className="[overflow-wrap:anywhere]">
              <span className="text-ink-3">{edit.field}: </span>
              {edit.before ?? "None"} <span aria-hidden>→</span>
              <span className="sr-only"> became </span> {edit.after ?? "None"}
            </li>
          ))}
        </ul>
      )}
      {reason !== null && <p className="mt-1 text-xs text-ink-2 [overflow-wrap:anywhere]">Your reason: {reason}</p>}
      {withdrawn !== null && <p className="mt-1 text-xs text-ink-2 [overflow-wrap:anywhere]">{withdrawn}</p>}
      {link !== null && (
        <p className="mt-1 text-sm">
          <Link
            href={link.href}
            className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {link.label}
          </Link>
        </p>
      )}
      {row.kind === "draft" && (row.status === "approved" || row.status === "auto_approved") && (
        <div className="mt-2">
          <CopyText text={fieldsOf(row as never).body ?? ""} />
        </div>
      )}
      {row.status === "auto_approved" && !row.flagged && <FlagAuto id={row.id} name={whoLabel(row)} />}
    </li>
  );
}

/** "Decided": the last 30 days, newest decision first, filtered as the address says. */
export function DecidedList() {
  const now = useNow();
  const [view, setView] = useView();
  const since = now === null ? null : decidedSince(now);
  const rows = useQuery(api.assistant.decided, since === null ? "skip" : { since });
  const ids = useId();
  const shown = useMemo(() => (rows === undefined ? [] : filterInbox(rows, view)), [rows, view]);
  const agents = useMemo(() => (rows === undefined ? [] : agentsIn(rows)), [rows]);
  const goals = useMemo(() => (rows === undefined ? [] : goalsIn(rows)), [rows]);

  if (rows === undefined || now === null) {
    return (
      <Panel>
        <Skeleton className="h-40 w-full" data-testid="decided-loading" />
      </Panel>
    );
  }
  return (
    <Panel className="space-y-4" aria-labelledby={`${ids}-title`}>
      <div className="flex flex-wrap items-end gap-3">
        <h2 id={`${ids}-title`} className="mr-auto text-base font-medium text-ink">
          Decided in the last {DECIDED_WINDOW_DAYS} days
        </h2>
        <Filters view={view} setView={setView} agents={agents} goals={goals} />
      </div>
      <Grants />
      {shown.length === 0 ? (
        <p className="text-sm text-ink-2">
          {rows.length === 0 ? `Nothing was decided in the last ${DECIDED_WINDOW_DAYS} days.` : "Nothing matches these filters."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((row) => (
            <DecidedRow key={row.id} row={row} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
