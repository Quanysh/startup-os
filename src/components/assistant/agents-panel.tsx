"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { PRODUCT } from "@convex/lib/identity";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { AGENT_TONES, RUN_TIMES, type AgentId } from "@/lib/assistant/agents";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

export const AGENTS_INTRO = `Four agents, each on its own schedule (by default about ${RUN_TIMES.morning}): on your Mac through Claude, or in ${PRODUCT.name} on Gemini, as you choose for each on Agents. Their instructions, tools and schedule are edited there. One you switch off is refused everything it tries to write, from its next call.`;

/**
 * "Agents": the four, what each does in a line, and a switch for each
 * (`assistant.setAgent`). The switch is the server's to keep: an agent that
 * is off is refused there, whatever a prompt on the Mac says.
 */
export function AgentsPanel() {
  const agents = useQuery(api.assistant.agents);
  const setAgent = useMutation(api.assistant.setAgent);
  const [error, setError] = useState<string | null>(null);

  const flip = async (agent: AgentId, on: boolean) => {
    setError(null);
    try {
      await setAgent({ agent, on });
    } catch (failure) {
      setError(messageOf(failure, "That could not be saved. Try again."));
    }
  };

  return (
    <Panel aria-labelledby="agents">
      <h2 id="agents" className="text-base">
        Agents
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">{AGENTS_INTRO}</p>
      {agents === undefined ? (
        <Skeleton data-testid="agents-loading" className="mt-4 h-32 rounded-inner" />
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <KindTag tone={AGENT_TONES[agent.id]}>{agent.name}</KindTag>
                <p className="mt-1.5 max-w-xl text-sm text-ink-2">{agent.line}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={agent.on}
                aria-label={agent.name}
                onClick={() => flip(agent.id, !agent.on)}
                className={cn(
                  "mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line p-0.5 outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50",
                  agent.on ? "justify-end bg-brand-fill" : "justify-start bg-surface",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-4.5 rounded-full shadow-soft-sm", agent.on ? "bg-on-brand" : "bg-ink-3")}
                />
                <span className="sr-only">{agent.on ? "On" : "Off"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Panel>
  );
}
