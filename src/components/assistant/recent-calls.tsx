"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  AGENT_CALL_RETENTION_DAYS,
  MAX_AGENT_CALLS,
  RECENT_AGENT_CALLS,
  UNKNOWN_TOOL,
  type AgentOutcome,
} from "@convex/lib/agentRules";
import { LEGACY_TOKEN_NAME } from "@convex/lib/agentClients";
import { Panel } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { AGENT_NAMES, AGENT_TONES } from "@/lib/assistant/agents";
import { ageLabel } from "@/lib/freshness";

/** How each outcome reads. A refusal is the OS holding a rule, not a fault. */
export const OUTCOMES: Record<AgentOutcome, { label: string; tone: StatusTone }> = {
  ok: { label: "Done", tone: "success" },
  refused: { label: "Refused", tone: "warning" },
  invalid: { label: "Not valid", tone: "neutral" },
  error: { label: "Failed", tone: "danger" },
};

/**
 * What the owner's Claude called lately: the tool, whether it reads or
 * changes, when, and how it ended. That is all that is kept of a call
 * (convex/assistant.ts): never what was asked for or what came back.
 */
export function RecentCalls() {
  const calls = useQuery(api.assistant.recentCalls);
  const now = useNow();

  return (
    <Panel aria-labelledby="recent-calls">
      <h2 id="recent-calls" className="text-base">
        Recent calls
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        What your clients did here, newest first. A row is the tool, the client and how the call
        ended: what was asked for and what came back are not kept.
      </p>

      {calls === undefined ? (
        <Skeleton data-testid="calls-loading" className="mt-4 h-24 rounded-inner" />
      ) : calls.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2" data-testid="calls-empty">
          No calls yet.
        </p>
      ) : (
        <>
          {/* On a phone the kind drops out: a tool's name says whether it changes anything. */}
          <DataTable caption="Recent calls by your clients" className="min-w-[21rem]" boxClassName="mt-3">
            <DataHead>
              <DataHeader pinned>Tool</DataHeader>
              <DataHeader>Client</DataHeader>
              <DataHeader hideBelow="sm">Kind</DataHeader>
              <DataHeader>When</DataHeader>
              <DataHeader>Outcome</DataHeader>
            </DataHead>
            <DataBody>
              {calls.map((call) => (
                <DataRow key={call.id}>
                  <DataRowHeader pinned>
                    {call.tool === UNKNOWN_TOOL ? (
                      <span className="text-ink-2">A tool that does not exist</span>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <code className="font-mono text-xs">{call.tool}</code>
                        {call.agent != null && (
                          <KindTag tone={AGENT_TONES[call.agent]}>{AGENT_NAMES[call.agent]}</KindTag>
                        )}
                        {/* One of the owner's bots, by the name the owner gave it: text, never markup. */}
                        {call.bot != null && <KindTag tone="slate">{call.bot}</KindTag>}
                      </span>
                    )}
                  </DataRowHeader>
                  {/* The owner's name for the client, or a name it gave itself: text, never markup. */}
                  <DataCell>{call.client ?? LEGACY_TOKEN_NAME}</DataCell>
                  <DataCell hideBelow="sm">
                    <KindTag tone={call.kind === "act" ? "plum" : "slate"}>
                      {call.kind === "act" ? "Change" : "Read"}
                    </KindTag>
                  </DataCell>
                  <DataCell>{now === null ? "" : ageLabel(now, call.at)}</DataCell>
                  <DataCell>
                    <StatusChip tone={OUTCOMES[call.outcome].tone}>
                      {OUTCOMES[call.outcome].label}
                    </StatusChip>
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
          <p className="mt-3 max-w-2xl text-xs text-ink-3">
            The latest {RECENT_AGENT_CALLS}. The newest {MAX_AGENT_CALLS} are kept, for{" "}
            {AGENT_CALL_RETENTION_DAYS} days.
          </p>
        </>
      )}
    </Panel>
  );
}
