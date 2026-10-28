import { describe, expect, test } from "vitest";
import { catalogProblems, catalogToolWire } from "./agentBuilder";
import { STARTUP_OS_TOOL_AREAS, providersConfigured } from "./agentStartupOs";
import { startupOsCatalog } from "./agentStartupOsTools";
import { isCallerTool } from "./botRules";
import { toolsFor } from "./mcpTools";
import { AREAS } from "./roles";

// Startup OS's own tools, as agents built to run here see them: made from the
// owner's agent tools, never handling patient data, each with its area.

describe("Startup OS's tool catalogue", () => {
  test("every tool a model may be given has an area, and the runner's own and the caller's own have none", () => {
    // `whoami` and `bot_rules` are about the caller itself: every caller's, on no area.
    const listed = toolsFor("act")
      .map((tool) => tool.name)
      .filter((name) => !isCallerTool(name))
      .sort();
    expect(Object.keys(STARTUP_OS_TOOL_AREAS).sort()).toEqual(listed);
    expect(listed.some((name) => name.startsWith("chat_"))).toBe(false);
    for (const area of Object.values(STARTUP_OS_TOOL_AREAS)) expect(AREAS).toContain(area);
  });

  test("it reads as a project's catalogue: reads are read, acts are write and approvable, no patient data", () => {
    const catalog = startupOsCatalog();
    expect(catalog.length).toBe(Object.keys(STARTUP_OS_TOOL_AREAS).length);
    const wire = catalog.map(({ area: _area, inputSchema, ...tool }) =>
      catalogToolWire.parse({ ...tool, inputSchema: JSON.parse(inputSchema) as unknown }),
    );
    expect(catalogProblems(wire)).toEqual([]);
    for (const tool of catalog) expect(tool.phi).toBe(false);
    const byId = new Map(catalog.map((tool) => [tool.id, tool]));
    expect(byId.get("metrics")).toMatchObject({ effect: "read", area: "scorecard" });
    expect(byId.get("task_create")).toMatchObject({ effect: "write", approvable: true, area: "board" });
    expect(byId.get("costs")).toMatchObject({ effect: "read", area: "costs" });
    expect(byId.get("brief_write")).toMatchObject({ effect: "write", area: "personal" });
  });

  test("a provider is configured only when every variable it needs is set", () => {
    expect(providersConfigured(() => false)).toEqual({ ai_studio: false, astana_gpu: false });
    expect(providersConfigured((name) => name === "GOOGLE_GENAI_API_KEY" || name === "OPEN_MODELS_BASE_URL")).toEqual({
      ai_studio: true,
      astana_gpu: false,
    });
  });
});
