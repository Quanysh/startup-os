// Startup OS's own tool catalogue, for agents built to run in Startup OS (the
// project `startup-os`, convex/lib/agentStartupOs.ts): made from the owner's
// agent tools (convex/lib/mcpTools.ts), so the two can never drift. Each read
// tool is `read`, each act tool `write` and so always approved; none handles
// patient data; each carries the area it needs. The chat runner's own tools
// are no agent's and are left out.
//
// Runs only inside Convex: never import it from the UI (it imports the registry).

import { MAX_DESCRIPTION, type CatalogTool } from "./agentBuilder";
import { STARTUP_OS_TOOL_AREAS } from "./agentStartupOs";
import { describeTool, toolsFor } from "./mcpTools";

export type StartupOsTool = CatalogTool & { inputSchema: string };

const clip = (text: string) => (text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`);

/** Startup OS's tools as a catalogue, in the registry's order. A tool with no area is left out. */
export function startupOsCatalog(): StartupOsTool[] {
  const out: StartupOsTool[] = [];
  for (const tool of toolsFor("act")) {
    const area = STARTUP_OS_TOOL_AREAS[tool.name];
    if (area === undefined) continue;
    const described = describeTool(tool);
    out.push({
      id: tool.name,
      name: tool.title,
      description: clip(described.description),
      phi: false,
      kind: "function",
      effect: tool.kind === "read" ? "read" : "write",
      approvable: true,
      area,
      inputSchema: JSON.stringify(described.inputSchema),
    });
  }
  return out;
}
