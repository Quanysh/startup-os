// The code's defaults of Startup OS's own four agents (convex/lib/osAgents.ts):
// what each is seeded with as its first published version (h1), and what the
// Mac's runner is given when no published version can be read.
//
// - **Instructions**: docs/agents/run.md (the rules every agent shares), then
//   the agent's own file, as convex/lib/osAgentDocs.ts carries them (a module
//   generated from the files: convex/osAgentDefaults.test.ts fails when the
//   two differ).
// - **Tools**: `OS_AGENT_TOOLS`. Each act tool among them (`propose`,
//   `brief_write`) is in `approvals`, as every write tool of an agent built
//   here is: on Gemini it waits for the owner's click; on the Mac `propose`
//   only stores a proposal for the owner to decide, as it always has.
// - **Schedule**: `OS_AGENT_DEFAULT_CRON` (06:20 UTC, 11:20 in Almaty).
//
// Runs only inside Convex: never import it from the UI (it carries the text
// of five files).

import { AGENT_LINES, AGENT_NAMES, AGENT_PROMPTS, type AgentId } from "./agents";
import { DEFAULT_BUILDER_MODEL, type Definition } from "./agentBuilder";
import { DEFAULT_VARIANT, type HarnessParts } from "./agentHarness";
import { withFeatures } from "./featureGates";
import { OS_AGENT_DOCS } from "./osAgentDocs";
import { OS_AGENT_ACT_TOOLS, OS_AGENT_DEFAULT_CRON, OS_AGENT_LIMITS, OS_AGENT_TOOLS } from "./osAgents";

/** Between the shared rules and an agent's own file. */
const BETWEEN = "\n\n---\n\n";

/** An agent's instructions as the code has them: run.md, then its own file. */
export function osAgentInstructions(agent: AgentId): string {
  const file = AGENT_PROMPTS[agent] as keyof typeof OS_AGENT_DOCS;
  // What belongs to a switched-off feature is taken out (convex/lib/featureGates.ts).
  return withFeatures(`${OS_AGENT_DOCS["run.md"].trimEnd()}${BETWEEN}${OS_AGENT_DOCS[file].trimEnd()}\n`);
}

/** The one user turn of a run: no variables, nothing typed by anyone. */
export const osAgentUserTemplate = (): string =>
  withFeatures(
    "Do this run now<!-- feature:secondCompany -->, for both companies<!-- /feature -->, as your instructions say. Finish with the final answer they describe.",
  );

/** The act tools of an allowlist: each needs an approval, as every write tool of an agent built here does. */
export const actToolsOf = (tools: readonly string[]): string[] =>
  tools.filter((id) => (OS_AGENT_ACT_TOOLS as readonly string[]).includes(id));

/** An agent's code's defaults as a definition and harness parts: its h1. */
export function osAgentDefault(agent: AgentId): { definition: Definition; parts: HarnessParts } {
  const tools = [...OS_AGENT_TOOLS[agent]];
  return {
    definition: {
      name: AGENT_NAMES[agent],
      description: AGENT_LINES[agent],
      input: { mode: "text", variables: [] },
      model: { provider: DEFAULT_BUILDER_MODEL.provider, model: DEFAULT_BUILDER_MODEL.model },
      triggers: { api: true, schedule: { cron: OS_AGENT_DEFAULT_CRON, variables: {} } },
      approvals: actToolsOf(tools),
      limits: { ...OS_AGENT_LIMITS },
    },
    parts: {
      prompt: { variants: { [DEFAULT_VARIANT]: { system: osAgentInstructions(agent), user: osAgentUserTemplate() } } },
      tools,
    },
  };
}

/** What the Mac's runner is given for one run: the instructions, the user turn, the tools, the bounds. */
export type MacConfig = {
  agentId: AgentId;
  /** "h3", or "code default" where no published version could be read. */
  version: string;
  instructions: string;
  user: string;
  tools: string[];
  limits: { maxSteps: number; timeoutMs: number };
};

/** The version a run on the code's defaults is recorded as. */
export const CODE_DEFAULT_VERSION = "code default";

/** The Mac's config from the code's defaults: what it runs when no published version can be read. */
export function macDefaultConfig(agent: AgentId): MacConfig {
  const { definition, parts } = osAgentDefault(agent);
  const variant = parts.prompt!.variants[DEFAULT_VARIANT]!;
  return {
    agentId: agent,
    version: CODE_DEFAULT_VERSION,
    instructions: variant.system,
    user: variant.user ?? osAgentUserTemplate(),
    tools: [...(parts.tools ?? [])],
    limits: { ...definition.limits },
  };
}
