// The owner's agents, as the Assistant page names them. The sets, the limits
// and every fixed sentence are convex/lib/agents.ts (pure, and what the
// server enforces): this path re-exports them, and adds only how an agent's
// chip looks.
import type { KindTone } from "@/components/ui/status-chip";
import type { AgentId } from "@convex/lib/agents";

export * from "@convex/lib/agents";

/** Each agent's chip: what it is, never how it is doing, so a kind tag's tone. */
export const AGENT_TONES: Record<AgentId, KindTone> = {
  chief_of_staff: "slate",
  engineering: "violet",
  sales: "teal",
  finance: "sand",
};
