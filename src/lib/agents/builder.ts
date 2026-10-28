// The words and small sums of agents built here (/agents: Create agent, the
// Builder, Runs and Tools tabs). Pure; the rules are convex/lib/agentBuilder.ts.

import type { AgentRunStatus, ApprovalState, RunTrigger, ToolCallStatus } from "@convex/lib/agentBuilder";
import type { StatusTone } from "@/components/ui/status-chip";
import { AREA_NAMES, type Area } from "@convex/lib/roles";

export const TRIGGER_WORDS: Record<RunTrigger, string> = {
  api: "API",
  schedule: "Schedule",
  subagent: "Sub-agent",
  chat: "Chat",
  test: "Test",
};

export const RUN_STATUS: Record<AgentRunStatus, { words: string; tone: StatusTone }> = {
  ok: { words: "Done", tone: "success" },
  error: { words: "Error", tone: "danger" },
  refused: { words: "Refused", tone: "warning" },
  awaiting_approval: { words: "Waiting for approval", tone: "info" },
  denied: { words: "Denied", tone: "warning" },
  timeout: { words: "Timed out", tone: "danger" },
};

const CALL_WORDS: Record<ToolCallStatus, string> = { ok: "ran", error: "failed", denied: "denied", skipped: "not run" };
const APPROVAL_WORDS: Record<ApprovalState, string> = { approved: "approved", denied: "denied", pending: "waiting for approval" };

/** One tool call in words: "claim.note: not run, waiting for approval". */
export const toolCallWords = (call: { toolId: string; status: ToolCallStatus; approval?: ApprovalState }) =>
  `${call.toolId}: ${CALL_WORDS[call.status]}${call.approval === undefined ? "" : `, ${APPROVAL_WORDS[call.approval]}`}`;

/** A run's length: "850 ms", "4.2 s", "3 min", "2 h 5 min". */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
}

/** A time in UTC, to the minute: "Mon 19 Oct, 06:00 UTC". */
export function utcWords(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/**
 * What a page an area opens is called, for a tool's tag: the one list of area
 * names (convex/lib/roles.ts), so every area has one, with the board as its
 * page's name and the owner's own as "Owner only".
 */
export const AREA_WORDS: Record<Area, string> = { ...AREA_NAMES, board: "Tasks", personal: "Owner only" };

/** A whole number from what was typed, or null. */
export function wholeOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A budget from what was typed: none for blank, NaN for nonsense (the rules say so). */
export function budgetOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}
