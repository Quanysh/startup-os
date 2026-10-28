// Which bot made a card on the task board. The id is the authenticated MCP
// caller's profile (`ToolClock.bot`), or the bot that filed a proposal the
// owner then approved. One function, so a direct `task_create` and
// `approveProposal` (the owner's click, auto-approval, and any later decide
// tool) stamp the same way.
//
// A name that is not a profile's id is left off. The field is never a guess
// and never text a caller typed unchecked. Cards from before this was
// recorded stay without it unless a decided proposal still names the task
// and the bot (`migrations.stampBotOnAgentTasks`).

import type { Doc } from "../_generated/dataModel";
import type { AgentId } from "./agents";
import { isProfileId } from "./botRules";

export type AgentTaskOrigin = Extract<NonNullable<Doc<"tasks">["origin"]>, { source: "agent" }>;

/**
 * Origin of a card the agent endpoint made. `agent` is one of the owner's
 * four, when the call or the proposal names one. `bot` is a profile id.
 */
export function agentTaskOrigin(args: {
  agent?: AgentId | undefined;
  bot?: string | undefined;
}): AgentTaskOrigin {
  const bot = args.bot !== undefined && isProfileId(args.bot) ? args.bot : undefined;
  return {
    source: "agent",
    ...(args.agent === undefined ? null : { agent: args.agent }),
    ...(bot === undefined ? null : { bot }),
  };
}
