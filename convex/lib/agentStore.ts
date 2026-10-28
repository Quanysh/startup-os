// Which of the owner's agents are switched on (the `agentSettings` table),
// and the owner as the gate sees them. Runs only inside Convex: never import
// it from the UI.
//
// An agent is on unless the one settings row lists it. Every function that
// writes for an agent asks `requireAgentOn` first, in the transaction that
// writes, so a switch thrown while a run is in flight holds from the next
// call. Nothing here logs.

import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { INTERNAL_PROJECT } from "./agentProjects";
import { AGENT_IDS, AGENT_OFF, type AgentId } from "./agents";
import { companyIds } from "./company";
import type { Member } from "./owner";
import { ownerAreas } from "./roles";

/** The agents that are switched off. */
export async function agentsOff(ctx: QueryCtx): Promise<AgentId[]> {
  const row = await ctx.db.query("agentSettings").first();
  return row === null ? [] : AGENT_IDS.filter((agent) => row.off.includes(agent));
}

/** Refuse a write from an agent the owner switched off, in fixed words. */
export async function requireAgentOn(ctx: QueryCtx, agent: AgentId): Promise<void> {
  if ((await agentsOff(ctx)).includes(agent)) throw new ConvexError(AGENT_OFF);
}

/**
 * Switch one agent on or off. This row is the switch, wherever it is thrown
 * (the Assistant page, or the agent's row on /agents): the agent's control
 * in `startup-os`, where it has one, is set to say the same, so every page
 * shows one switch. Who reads whether one of the four may run asks
 * `agentsOff`, never the control.
 */
export async function setAgent(ctx: MutationCtx, agent: AgentId, on: boolean, now: number) {
  const row = await ctx.db.query("agentSettings").first();
  const off = new Set(row?.off ?? []);
  if (on) off.delete(agent);
  else off.add(agent);
  const next = { off: AGENT_IDS.filter((id) => off.has(id)), updatedAt: now };
  if (row === null) await ctx.db.insert("agentSettings", next);
  else await ctx.db.patch(row._id, next);
  const control = await ctx.db
    .query("agentControls")
    .withIndex("by_project_and_agentId", (q) => q.eq("project", INTERNAL_PROJECT).eq("agentId", agent))
    .unique();
  if (control !== null && control.enabled !== on) await ctx.db.patch(control._id, { enabled: on });
}

/**
 * The owner as the gate's `Member`: what `getMember` gives for an owner
 * (convex/lib/owner.ts). For an `ownerMutation`, which holds the owner's
 * `users` row, to run the app's own write helpers as that owner.
 */
export const ownerMember = (user: Doc<"users">): Member => ({
  user,
  role: "owner",
  companies: companyIds(),
  areas: ownerAreas(),
});
