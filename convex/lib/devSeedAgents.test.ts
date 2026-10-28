import { describe, expect, test } from "vitest";
import { overviewOf, modelsOf, type UsageDay } from "./agentControl";
import { allowedProvidersProblem, providerPolicyProblem } from "./agentProjects";
import { defaultsFromWire, defaultsProblems, harnessDefaultsWire, harnessProblems, promptPartOf } from "./agentHarness";
import { caseFitProblems, caseProblems } from "./agentJobs";
import { catalogProblems, catalogToolWire, declarativeProblems, definitionOut, runSummaryWire, runsProblems, type Peer } from "./agentBuilder";
import { startupOsCatalog } from "./agentStartupOsTools";
import { resumeRun } from "./agentRuntime";
import { projectPushProblems, projectUsageBody } from "./agentShape";
import {
  SEED_AGENT_CHANGES,
  SEED_BUILT,
  seedBuiltRuns,
  SEED_AGENT_CONFIG,
  SEED_CATALOG,
  SEED_HARNESS,
  SEED_PROJECTS,
  seedAgentProviders,
  seedAgentUsage,
  seedNoTokenHash,
  SEED_STARTUP_OS,
  seedStartupOsRuns,
} from "./devSeedAgents";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const TODAY = "2026-10-16";

describe("the local projects and agents", () => {
  test("each project's rows pass Protocol v1's own rules, as one report would", () => {
    for (const project of SEED_PROJECTS) {
      const own = <T extends { project: string }>(rows: readonly T[]) =>
        rows.filter((row) => row.project === project.slug).map(({ project: _p, ...row }) => row);
      const body = {
        batchId: "seed",
        observedAt: new Date(NOW).toISOString(),
        agentUsage: own(seedAgentUsage(NOW)),
        providers: own(seedAgentProviders(NOW)),
        agentsKnown: own(SEED_CATALOG),
        configApplied: { version: 0, appliedAt: null },
      };
      const parsed = projectUsageBody.safeParse(body);
      expect([project.slug, parsed.success]).toEqual([project.slug, true]);
      expect(projectPushProblems(parsed.data!, NOW)).toEqual([]);
    }
  });

  test("read as made up, and show every state the page has", () => {
    for (const project of SEED_PROJECTS) {
      expect(project.slug).toMatch(/^sample-/);
      expect(project.name).toMatch(/^Sample /);
      expect(allowedProvidersProblem(project.allowedProviders, project.holdsPatientData)).toBeNull();
    }
    const usage = seedAgentUsage(NOW);
    for (const row of usage) expect(row.model).toMatch(/^made-up-/);
    const of = (slug: string) => usage.filter((row) => row.project === slug) as UsageDay[];
    expect(overviewOf(of("sample-clinic"), [], TODAY).map((row) => row.agentId)).toEqual([
      "sample-coding.extract",
      "sample-coding.select",
    ]);
    // Not priced, never $0.
    expect(overviewOf(of("sample-kz"), [], TODAY)[0]!.costMonth).toEqual({ usd: null, why: "unpriced" });
    // Two models in thirty days: the comparison shows.
    expect(modelsOf(of("sample-clinic"), "sample-coding.select", TODAY)).toHaveLength(2);
    // No two seeded projects share a token hash, and none is a token's.
    expect(new Set(SEED_PROJECTS.map((_, i) => seedNoTokenHash(i))).size).toBe(SEED_PROJECTS.length);
  });

  test("the changes: versions in order per project, held to each project's providers", () => {
    for (const project of SEED_PROJECTS) {
      const own = SEED_AGENT_CHANGES.filter((change) => change.project === project.slug);
      expect(own.map((change) => change.version)).toEqual(own.map((_, i) => i + 1));
      for (const change of own) {
        expect(providerPolicyProblem(change.after.provider, project, false)).toBeNull();
      }
      const config = SEED_AGENT_CONFIG.find((row) => row.project === project.slug)!;
      expect(config.latestVersion).toBe(own.length);
    }
    // One launched agent its project has not reported: "Waiting for the project to report it".
    const launched = SEED_AGENT_CHANGES.filter((change) => change.launched);
    expect(launched.map((change) => change.agentId)).toEqual(["sample-search.digest"]);
    expect(SEED_CATALOG.some((entry) => entry.agentId === "sample-search.digest")).toBe(false);
  });
});

describe("the local harness", () => {
  test("the code's defaults, the draft and the cases keep the rules a report, a publish and a save are held to", () => {
    const wire = harnessDefaultsWire.parse(SEED_HARNESS.defaults);
    expect(defaultsProblems(wire, "harness")).toEqual([]);
    const defaults = defaultsFromWire(wire);
    expect(harnessProblems({ prompt: promptPartOf(SEED_HARNESS.draft.prompt) }, { defaults, patientProviders: false })).toEqual([]);
    for (const seeded of SEED_HARNESS.cases) {
      expect(seeded.name).toMatch(/^Made-up /);
      const variables: Record<string, string> = { ...seeded.variables };
      expect(caseProblems({ name: seeded.name, variables, expect: seeded.expect })).toEqual([]);
      expect(caseFitProblems(seeded.name, { variables }, wire.prompt!.variables, ["web_search"])).toEqual([]);
    }
    expect(SEED_HARNESS.run.outputs).toHaveLength(SEED_HARNESS.cases.length);
    expect(
      SEED_CATALOG.some((entry) => entry.project === SEED_HARNESS.project && entry.agentId === SEED_HARNESS.agentId),
    ).toBe(true);
    // The seeded run is on the model the agent runs on, which its project reports up.
    expect(
      seedAgentProviders(NOW).some(
        (row) =>
          row.project === SEED_HARNESS.project &&
          row.provider === SEED_HARNESS.run.model.provider &&
          row.model === SEED_HARNESS.run.model.model &&
          row.state === "up",
      ),
    ).toBe(true);
  });
});

describe("the local agents built here", () => {
  test("the catalogue, both agents and their runs keep the rules a report and a publish are held to", () => {
    const tools = SEED_BUILT.tools.map((tool) => catalogToolWire.parse(tool));
    expect(catalogProblems(tools)).toEqual([]);
    const lookup = SEED_BUILT.agents[0];
    const peer: Peer = {
      agentId: lookup.agentId,
      name: lookup.definition.name,
      toolId: lookup.definition.triggers.subAgent.toolId,
      description: lookup.definition.triggers.subAgent.description,
      tools: [...lookup.tools],
    };
    for (const agent of SEED_BUILT.agents) {
      const context = {
        agentId: agent.agentId,
        catalog: tools,
        peers: agent.agentId === lookup.agentId ? [] : [peer],
        policy: { holdsPatientData: false, allowedProviders: ["ai_studio", "vertex"] },
        publishing: true,
        publishedToolId: agent.agentId === lookup.agentId ? peer.toolId : null,
      };
      const definition = JSON.parse(JSON.stringify(agent.definition));
      expect(declarativeProblems(definition, { prompt: agent.prompt, tools: [...agent.tools] }, context)).toEqual([]);
    }
    const runs = seedBuiltRuns(NOW).map((run) => runSummaryWire.parse(run));
    expect(runsProblems(runs, NOW)).toEqual([]);
    expect(runs.some((run) => run.status === "awaiting_approval")).toBe(true);
  });
});

describe("the local Startup OS agent", () => {
  test("its definition keeps the rules, its runs are summaries, and its waiting run resumes", async () => {
    const catalog = startupOsCatalog();
    const context = {
      agentId: SEED_STARTUP_OS.agentId,
      catalog,
      peers: [],
      policy: { holdsPatientData: false, allowedProviders: ["ai_studio", "astana_gpu"] },
      publishing: true,
      publishedToolId: null,
      runsHere: true,
    };
    const parts = { prompt: promptPartOf(SEED_STARTUP_OS.prompt), tools: [...SEED_STARTUP_OS.tools] };
    expect(declarativeProblems(JSON.parse(JSON.stringify(SEED_STARTUP_OS.definition)), parts, context)).toEqual([]);
    const seeded = seedStartupOsRuns(NOW);
    for (const { output: _o, startedAt, ...run } of seeded.runs) {
      expect(runSummaryWire.safeParse({ ...run, startedAt: new Date(startedAt).toISOString(), costUsd: null }).success).toBe(true);
    }
    const agent = {
      agentId: SEED_STARTUP_OS.agentId,
      version: "h1",
      versionNumber: 1,
      definition: definitionOut(1, JSON.parse(JSON.stringify(SEED_STARTUP_OS.definition)), parts),
      model: SEED_STARTUP_OS.definition.model,
      refusal: null,
    };
    const resumed = await resumeRun(seeded.waiting.state, "denied", {
      catalog: new Map(),
      subAgent: () => null,
      agentAt: () => agent,
      clientFor: () => ({ provider: "ai_studio", generate: async () => ({ text: "Made-up: not added.", toolCalls: [], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } }) }),
      execute: async () => ({ status: "error", message: "never" }),
      now: () => NOW,
      newRunId: () => "never",
    });
    expect(resumed.records.at(-1)).toMatchObject({
      runId: "os-sample-2",
      status: "ok",
      toolCalls: [{ toolId: "tasks", status: "ok" }, { toolId: "task_create", status: "denied", approval: "denied" }],
    });
  });
});
