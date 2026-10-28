// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { OS_AGENT_WORDS, RUNS_ON_WORDS } from "@convex/lib/osAgents";
import { mockConvex } from "@/test-support/convex";
import { AgentDetail } from "./agent-detail";
import { BuilderTab } from "./builder-tab";
import type { HarnessView } from "./harness-tab";
import { RunsTab } from "./runs-tab";
import { TestsTab } from "./tests-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Startup OS's own four agents on /agents, with made-up data: where each runs,
// chosen on its Overview tab; a run on the Mac in the same Runs table as one
// in Startup OS, with the proposals it made; and the Tests tab's sentence for
// one on the Mac.

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-18T12:00:00Z");
const TODAY = "2026-10-18";

const run = (over: Record<string, unknown>) => ({
  runId: "mac-made-up-1",
  agentId: "engineering",
  version: "h1",
  trigger: "schedule",
  parentRunId: null,
  status: "ok",
  startedAt: NOW - 600_000,
  durationMs: 120_000,
  steps: 7,
  costUsd: null,
  errorClass: null,
  toolCalls: [
    { toolId: "pull_requests", status: "ok" },
    { toolId: "propose", status: "ok" },
  ],
  pendingApprovals: 0,
  runner: "mac",
  proposals: 1,
  answer: false,
  children: [],
  ...over,
});

test("the Mac's runs and Startup OS's in one table, each with the proposals it made; Run now is the Mac's to say no to", () => {
  convex.setQuery(api.agentBuilder.runs, {
    runs: [run({}), run({ runId: "os-made-up-2", runner: null, proposals: 0, trigger: "api", toolCalls: [] })],
    runsHere: true,
    pendingApprovals: 0,
    runsWaiting: 0,
    read: 2,
  });
  convex.setQuery(api.agentRuntime.approvals, []);
  render(<RunsTab project="startup-os" agentId="engineering" now={NOW} isOwner input={{ mode: "text", variables: [] }} runsOn="claude_mac" />);

  const table = screen.getByRole("table", { name: "Runs" });
  expect(within(table).getByRole("columnheader", { name: "Proposals" })).toBeTruthy();
  const mac = within(table).getByRole("row", { name: /mac-made-up-1/ });
  expect(mac.textContent).toContain(RUNS_ON_WORDS.claude_mac);
  expect(mac.textContent).toContain("propose");
  const here = within(table).getByRole("row", { name: /os-made-up-2/ });
  expect(here.textContent).not.toContain(RUNS_ON_WORDS.claude_mac);

  expect(screen.getByText(OS_AGENT_WORDS.macRunNow)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
});

test("one moved to Gemini is started with Run now, as any agent built here", () => {
  convex.setQuery(api.agentBuilder.runs, { runs: [], runsHere: true, pendingApprovals: 0, runsWaiting: 0, read: 0 });
  convex.setQuery(api.agentRuntime.approvals, []);
  render(<RunsTab project="startup-os" agentId="engineering" now={NOW} isOwner input={{ mode: "text", variables: [] }} runsOn="gemini" />);
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  expect(screen.queryByText(OS_AGENT_WORDS.macRunNow)).toBeNull();
});

test("the Tests tab says why one on the Mac is not tested here, and offers no run", () => {
  convex.setQuery(api.agentHarness.tests, {
    cases: [],
    runs: [],
    choices: [{ provider: "ai_studio", model: "gemini-3.8-flash" }],
    draft: { id: "d1", name: "h2", revision: 1 },
    variables: [],
    tools: [],
    variants: ["default"],
    input: "text",
    providerTools: [],
    subAgentTools: [],
    built: true,
    runsOn: "claude_mac",
  });
  render(<TestsTab project="startup-os" agentId="engineering" now={NOW} />);
  expect(screen.getByText(OS_AGENT_WORDS.macTests)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
});

test("the owner chooses where one of the four runs, on its Overview tab", async () => {
  convex.setQuery(api.agentControl.agent, {
    project: "startup-os",
    projectName: "Startup OS",
    holdsPatientData: false,
    allowedProviders: ["ai_studio"],
    agentId: "engineering",
    name: "Engineering manager",
    phi: null,
    kind: "declarative",
    waiting: false,
    builtHere: true,
    series: [],
    models: [],
    desired: null,
    current: { provider: "ai_studio", model: "gemini-3.8-flash" },
    promptVersion: null,
    runsOn: "claude_mac",
    osAgent: true,
    choices: [],
    changes: [],
  });
  convex.setQuery(api.agentHarness.harness, undefined);
  render(<AgentDetail project="startup-os" agentId="engineering" today={TODAY} now={NOW} onClose={() => undefined} />);

  const section = screen.getByRole("region", { name: "Where it runs" });
  const mac = within(section).getByRole("radio", { name: new RegExp(RUNS_ON_WORDS.claude_mac) }) as HTMLInputElement;
  expect(mac.checked).toBe(true);
  const save = within(section).getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(within(section).getByRole("radio", { name: new RegExp(RUNS_ON_WORDS.gemini) }));
  fireEvent.click(save);
  await waitFor(() =>
    expect(convex.mutation(api.agentControl.change)).toHaveBeenCalledWith({ project: "startup-os", agentId: "engineering", runsOn: "gemini" }),
  );
  // Its header says where it runs now.
  expect(screen.getAllByText(RUNS_ON_WORDS.claude_mac).length).toBeGreaterThan(0);
});

test("the Builder of one on the Mac says why a tool that changes the board cannot be switched on there", () => {
  const definition = {
    name: "Engineering manager",
    description: "Looks for stuck pull requests.",
    input: { mode: "text" as const, variables: [] },
    model: { provider: "ai_studio", model: "gemini-3.8-flash" },
    triggers: { api: true },
    approvals: ["propose", "task_create"],
    limits: { maxSteps: 30, timeoutMs: 600_000 },
  };
  const draft = {
    id: "v2",
    number: 2,
    name: "h2",
    status: "draft",
    revision: 1,
    changed: [],
    promptVariants: ["default"],
    parts: { prompt: { variants: { default: { system: "Made-up instructions.", user: "Do it." } } }, tools: ["propose", "task_create"] },
    definition,
    codeDefault: false,
    basedOn: 1,
    note: "",
    createdBy: "You",
    createdAt: NOW,
    updatedBy: "You",
    updatedAt: NOW,
    publishedBy: null,
    publishedAt: null,
    problems: [],
    gate: "no_run",
  };
  const view = {
    project: "startup-os",
    agentId: "engineering",
    built: true,
    holdsPatientData: false,
    defaults: null,
    published: null,
    draft,
    versions: [draft],
    events: [],
    current: null,
    patientProviders: false,
    ownerOnly: true,
    mayPublish: true,
    isOwner: true,
  } as unknown as HarnessView;
  const tool = (id: string, effect: "read" | "write") => ({ id, name: id, description: "", phi: false, kind: "function", effect, approvable: true, area: "personal" });
  convex.setQuery(api.agentBuilder.builder, {
    project: { slug: "startup-os", name: "Startup OS", holdsPatientData: false, allowedProviders: ["ai_studio"], runsHere: true },
    tools: [tool("propose", "write"), tool("task_create", "write")],
    peers: [],
    publishedToolId: null,
    pairs: [{ provider: "ai_studio", model: "gemini-3.8-flash", patientData: false }],
    providers: [{ provider: "ai_studio", configured: true }],
    isOwner: true,
    macRun: true,
  });
  render(<BuilderTab view={view} now={NOW} />);
  expect(screen.getAllByText(OS_AGENT_WORDS.macActTool, { exact: false }).length).toBeGreaterThan(0);
});
