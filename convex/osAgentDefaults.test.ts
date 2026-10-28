// @vitest-environment node
import { BOT_OWN_TOOLS } from "./lib/botRules";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { OS_AGENT_DOC_FILES, renderDocsModule } from "../scripts/osAgentDocs";
import { declarativeProblems } from "./lib/agentBuilder";
import { nextRuns } from "./lib/agentCron";
import { withFeatures } from "./lib/featureGates";
import { AGENT_IDS, AGENT_PROMPTS, RUN_TIMES } from "./lib/agents";
import { STARTUP_OS_POLICY } from "./lib/agentStartupOs";
import { startupOsCatalog } from "./lib/agentStartupOsTools";
import { TOOLS } from "./lib/mcpTools";
import { OS_AGENT_DOCS } from "./lib/osAgentDocs";
import {
  CODE_DEFAULT_VERSION,
  osAgentUserTemplate,
  macDefaultConfig,
  osAgentDefault,
  osAgentInstructions,
} from "./lib/osAgentDefaults";
import {
  DEFAULT_RUNS_ON,
  MAC_ACT_TOOLS,
  MAC_CATCH_UP_MS,
  OS_AGENT_ACT_TOOLS,
  OS_AGENT_DEFAULT_CRON,
  OS_AGENT_RUN_ORDER,
  OS_AGENT_TOOLS,
  OS_AGENT_WORDS,
  isOsAgent,
  macDueAt,
  runsOnOf,
} from "./lib/osAgents";

// Startup OS's own four agents' code's defaults are docs/agents/: the module
// that carries the files' text into Convex must be the files, the tools each
// may use are the ones its file names, and the schedule is the time the Mac's
// scheduled task used to run them.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const file = (name: string) => readFileSync(`${ROOT}docs/agents/${name}`, "utf8");
const toolsIn = (text: string) => new Set([...text.matchAll(/mcp__startup-os__([a-z_]+)/g)].map((match) => match[1]!));
/** What a file names only to forbid (convex/agentPrompts.test.ts holds that it does). */
const FORBIDDEN = ["task_create", "task_update", "task_move", "deal_update", "investor_update", "investor_create", "customer_update", "partner_upsert", "partner_move"];
/** The first steps of every run (docs/agents/run.md, "Each run"). */
const RUN_STEPS = ["sources", "proposals_feedback", "proposals_open"];

describe("the docs module", () => {
  test.each(OS_AGENT_DOC_FILES)("carries %s exactly as it is in docs/agents/", (name) => {
    expect(OS_AGENT_DOCS[name]).toBe(file(name));
  });

  test("is what pnpm gen:agent-docs writes from the files, whole", () => {
    const texts = Object.fromEntries(OS_AGENT_DOC_FILES.map((name) => [name, file(name)]));
    expect(readFileSync(`${ROOT}convex/lib/osAgentDocs.ts`, "utf8")).toBe(renderDocsModule(texts));
  });

  test("holds run.md and each of the four agents' files, and nothing else", () => {
    expect([...OS_AGENT_DOC_FILES].sort()).toEqual(["run.md", ...AGENT_IDS.map((id) => AGENT_PROMPTS[id])].sort());
  });
});

describe("each agent's code's defaults", () => {
  test.each(AGENT_IDS)("%s's instructions are run.md, then its own file", (agent) => {
    const text = osAgentInstructions(agent);
    // As the switches have it (convex/lib/featureGates.ts): with all on, the files as they are.
    expect(text.startsWith(withFeatures(file("run.md")).trimEnd())).toBe(true);
    expect(text.endsWith(`${withFeatures(file(AGENT_PROMPTS[agent])).trimEnd()}\n`)).toBe(true);
    // No template tag: the runtime renders it, and it declares no variable.
    expect(text).not.toMatch(/\{\{|\}\}/);
  });

  test.each(AGENT_IDS)("%s may use the tools its file names and the run's first steps, and never the four that change the board at once", (agent) => {
    const named = toolsIn(file(AGENT_PROMPTS[agent]));
    const expected = new Set([...RUN_STEPS, ...[...named].filter((name) => !FORBIDDEN.includes(name))]);
    expect(new Set(OS_AGENT_TOOLS[agent])).toEqual(expected);
    expect(OS_AGENT_TOOLS[agent].length).toBe(expected.size);
  });

  test("every tool in a list is a model's tool of the registry, never a runner's", () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
    for (const agent of AGENT_IDS) {
      for (const id of OS_AGENT_TOOLS[agent]) {
        expect(byName.get(id), `${agent}: ${id}`).toBeDefined();
        expect(byName.get(id)!.audience, `${agent}: ${id}`).toBeUndefined();
      }
    }
  });

  test("the act tools named here are the registry's act tools that are not a runner's", () => {
    // A bot's own (`permission_request`) is no agent's: it refuses a call naming no bot.
    const acts = TOOLS.filter(
      (tool) => tool.kind === "act" && tool.audience !== "runner" && !(BOT_OWN_TOOLS as readonly string[]).includes(tool.name),
    ).map((tool) => tool.name);
    expect([...OS_AGENT_ACT_TOOLS].sort()).toEqual(acts.sort());
  });

  test.each(AGENT_IDS)("%s's defaults keep every rule of an agent built to run in Startup OS, published by the owner", (agent) => {
    const { definition, parts } = osAgentDefault(agent);
    const problems = declarativeProblems(definition, parts, {
      agentId: agent,
      catalog: startupOsCatalog(),
      peers: [],
      policy: STARTUP_OS_POLICY,
      publishing: true,
      publishedToolId: null,
      ownerPublishing: true,
      runsHere: true,
    });
    expect(problems).toEqual([]);
    // Every act tool it may use waits for an approval; nothing else does.
    expect(definition.approvals).toEqual(OS_AGENT_TOOLS[agent].filter((id) => (MAC_ACT_TOOLS as readonly string[]).includes(id)));
    expect(definition.triggers.schedule).toEqual({ cron: OS_AGENT_DEFAULT_CRON, variables: {} });
    expect(parts.prompt!.variants.default!.user).toBe(osAgentUserTemplate());
  });

  test("only the chief of staff writes the brief; every agent may propose", () => {
    for (const agent of AGENT_IDS) {
      expect(OS_AGENT_TOOLS[agent].includes("brief_write")).toBe(agent === "chief_of_staff");
      expect(OS_AGENT_TOOLS[agent]).toContain("propose");
    }
  });

  test.each(AGENT_IDS)("the Mac's fallback for %s is the code's defaults, said to be", (agent) => {
    const config = macDefaultConfig(agent);
    expect(config).toEqual({
      agentId: agent,
      version: CODE_DEFAULT_VERSION,
      instructions: osAgentInstructions(agent),
      user: osAgentUserTemplate(),
      tools: [...OS_AGENT_TOOLS[agent]],
      limits: osAgentDefault(agent).definition.limits,
    });
  });
});

describe("where and when they run", () => {
  test("the default schedule is the old morning run: 11:20 in Almaty, in UTC", () => {
    const [first] = nextRuns(OS_AGENT_DEFAULT_CRON, Date.UTC(2026, 9, 17, 0, 0), 1);
    expect(new Date(first!).toISOString()).toBe("2026-10-17T06:20:00.000Z");
    const almaty = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" }).format(first);
    expect(almaty).toBe(RUN_TIMES.morning);
  });

  test("the Mac runs a missed time the same day, within the catch-up, and never one not yet due", () => {
    const due = Date.UTC(2026, 9, 17, 6, 20);
    expect(macDueAt(OS_AGENT_DEFAULT_CRON, due - 60_000)).toBeNull();
    expect(macDueAt(OS_AGENT_DEFAULT_CRON, due)).toBe(due);
    expect(macDueAt(OS_AGENT_DEFAULT_CRON, due + 3 * 60 * 60 * 1000)).toBe(due);
    expect(macDueAt(OS_AGENT_DEFAULT_CRON, due + MAC_CATCH_UP_MS - 60_000)).toBe(due);
    expect(macDueAt(OS_AGENT_DEFAULT_CRON, due + MAC_CATCH_UP_MS)).toBeNull();
    // A schedule every five minutes: the latest time, not the first.
    expect(macDueAt("*/5 * * * *", Date.UTC(2026, 9, 17, 6, 23))).toBe(Date.UTC(2026, 9, 17, 6, 20));
  });

  test("the four run on the Mac until the owner says otherwise; another Startup OS agent in Startup OS; a project's in its project", () => {
    expect(DEFAULT_RUNS_ON).toBe("claude_mac");
    for (const agent of AGENT_IDS) {
      expect(isOsAgent("startup-os", agent)).toBe(true);
      expect(runsOnOf("startup-os", agent, undefined)).toBe("claude_mac");
      expect(runsOnOf("startup-os", agent, "gemini")).toBe("gemini");
      expect(isOsAgent("vertical-startup", agent)).toBe(false);
    }
    expect(runsOnOf("startup-os", "os.reader", undefined)).toBe("gemini");
    expect(runsOnOf("vertical-startup", "sales", "claude_mac")).toBeNull();
  });

  test("the Mac runs the chief of staff last, after every other", () => {
    expect([...OS_AGENT_RUN_ORDER].sort()).toEqual([...AGENT_IDS].sort());
    expect(OS_AGENT_RUN_ORDER.at(-1)).toBe("chief_of_staff");
  });
});

describe("on the Mac, only proposing and the brief change anything", () => {
  const context = (macRun: boolean) => ({
    agentId: "engineering",
    catalog: startupOsCatalog(),
    peers: [],
    policy: STARTUP_OS_POLICY,
    publishing: true,
    publishedToolId: null,
    ownerPublishing: true,
    runsHere: true,
    macRun,
  });
  const withTool = (tool: string) => {
    const { definition, parts } = osAgentDefault("engineering");
    return {
      definition: { ...definition, approvals: [...definition.approvals, tool] },
      parts: { ...parts, tools: [...(parts.tools ?? []), tool] },
    };
  };

  test.each(["task_create", "task_update", "task_move", "deal_update", "investor_update", "investor_create", "customer_update", "partner_upsert", "partner_move", "note_write", "comment_create", "task_archive", "handoff_reassign", "proposal_decide"])("%s is refused for an agent on the Mac, in a sentence, and taken on Gemini with its approval", (tool) => {
    const { definition, parts } = withTool(tool);
    expect(declarativeProblems(definition, parts, context(true))).toEqual([{ path: "tools", message: OS_AGENT_WORDS.macActTool }]);
    expect(declarativeProblems(definition, parts, context(false))).toEqual([]);
  });

  test("propose and brief_write stay: on the Mac they only store something for the owner", () => {
    const { definition, parts } = withTool("brief_write");
    expect(declarativeProblems(definition, parts, context(true))).toEqual([]);
  });
});
