import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { hasOwner, ownerEmailList } from "./authOwner";
import { memberOf } from "./lib/memberOf";
import { allowlistFor, ensureOsAgents, type Allowed } from "./lib/osAgentRuns";
import { isOwner } from "./lib/owner";
import { agentValidator } from "./schema";

// Startup OS's own four agents as agents of `startup-os` (convex/lib/osAgents.ts,
// convex/lib/osAgentRuns.ts): seeding them, and the check POST /mcp/v1 asks
// of every call that names one. Internal only: the owner manages them on
// /agents through the functions every agent there uses.

/**
 * Seed the four from their code's defaults where they are not built here
 * yet, as the first owner address that has signed in. A no-op until one
 * has, and for one that exists. Also asked by the runtime's tick each minute
 * and by the Mac's runner: `npx convex run osAgents:seed` only makes it now.
 */
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!hasOwner()) return { seeded: [] };
    for (const email of ownerEmailList()) {
      const member = await memberOf(ctx, email);
      if (member !== null && isOwner(member)) return { seeded: await ensureOsAgents(ctx, member.user, Date.now()) };
    }
    return { seeded: [] };
  },
});

/** Whether a call to POST /mcp/v1 may use a tool, by the agent (and the Mac run) it names. */
export const allowed = internalQuery({
  args: {
    tool: v.string(),
    header: v.union(agentValidator, v.null()),
    argument: v.union(agentValidator, v.null()),
    runId: v.union(v.string(), v.null()),
  },
  handler: (ctx, args): Promise<Allowed> => allowlistFor(ctx, args),
});
