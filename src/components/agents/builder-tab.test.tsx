// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { BUILDER_WORDS, DEFAULT_BUILDER_MODEL } from "@convex/lib/agentBuilder";
import { STARTUP_OS_WORDS } from "@convex/lib/agentStartupOs";
import { MAC_TOOLS_LINE, RUNS_ON_LINES } from "@convex/lib/osAgents";
import { mockConvex } from "@/test-support/convex";
import { BuilderTab } from "./builder-tab";
import { CreateAgent } from "./create-agent";
import type { HarnessView } from "./harness-tab";
import { RunsTab } from "./runs-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The Builder, Runs and Create agent with made-up data: approvals forced for
// a tool that changes data, the schedule's next runs, the chat box's embed,
// the run tree, and the default model.

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-17T12:00:00Z");

const definition = {
  name: "Sample triage",
  description: "Sorts made-up requests.",
  input: { mode: "text" as const, variables: [{ name: "request", required: true }] },
  model: { provider: "ai_studio", model: "made-up-flash" },
  triggers: { api: true },
  approvals: [],
  limits: { maxSteps: 10, timeoutMs: 120_000 },
};

const draft = {
  id: "v1" as never,
  number: 1,
  name: "h1",
  status: "draft" as const,
  revision: 1,
  changed: [],
  promptVariants: ["default"],
  parts: { prompt: { variants: { default: { system: "Sort it.", user: "{{request}}" } } }, tools: [] },
  definition,
  codeDefault: false,
  basedOn: null,
  note: "",
  createdBy: "You",
  createdAt: NOW,
  updatedBy: "You",
  updatedAt: NOW,
  publishedBy: null,
  publishedAt: null,
  problems: [],
  gate: "no_run" as const,
};

const view = {
  project: "sample-desk",
  agentId: "sample.triage",
  built: true,
  holdsPatientData: false,
  defaults: null,
  published: null,
  draft,
  versions: [draft],
  events: [],
  current: null,
  patientProviders: false,
  ownerOnly: false,
  mayPublish: true,
  isOwner: true,
} as unknown as HarnessView;

const options = {
  project: { slug: "sample-desk", name: "Sample Desk", holdsPatientData: false, allowedProviders: ["ai_studio", "vertex"], runsHere: false },
  tools: [
    { id: "policy.search", name: "Policy search", description: "", phi: false, kind: "function", effect: "read", approvable: true, area: null },
    { id: "claim.note", name: "Claim note", description: "", phi: false, kind: "function", effect: "write", approvable: true, area: null },
  ],
  peers: [],
  publishedToolId: null,
  pairs: [{ provider: "ai_studio", model: "made-up-flash", patientData: false }],
  providers: [{ provider: "ai_studio", configured: null }],
  isOwner: true,
};

test("a tool that changes data asks a person first, always; the schedule shows its next runs; the chat box its embed", () => {
  convex.setQuery(api.agentBuilder.builder, options);
  render(<BuilderTab view={view} now={NOW} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Claim note/ }));
  const forced = screen.getByRole("checkbox", { name: "Asks a person first (always)" }) as HTMLInputElement;
  expect(forced.checked).toBe(true);
  expect(forced.disabled).toBe(true);
  expect(screen.queryByText(new RegExp(BUILDER_WORDS.writeNeedsApproval("claim.note").slice(0, 30)))).toBeNull();

  fireEvent.click(screen.getByRole("checkbox", { name: "On a schedule" }));
  fireEvent.change(screen.getByLabelText("Cron, five fields, UTC"), { target: { value: "30 8 * * 1-5" } });
  expect(screen.getByText("Mon 19 Oct, 08:30 UTC")).toBeTruthy();

  fireEvent.click(screen.getByRole("checkbox", { name: "A chat box in the app" }));
  expect(screen.getByText('<StartupAgentChat agentId="sample.triage" />')).toBeTruthy();
  expect(screen.getByText(BUILDER_WORDS.chatMessages, { exact: false })).toBeTruthy();
  expect(screen.getByText("POST /api/startup-agents/run/sample.triage")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const saved = convex.mutation(api.agentBuilder.saveDefinition).mock.calls[0]![0] as {
    tools: string[];
    definition: { approvals: string[]; triggers: { schedule?: { cron: string } } };
  };
  expect(saved.tools).toEqual(["claim.note"]);
  expect(saved.definition.approvals).toEqual(["claim.note"]);
  expect(saved.definition.triggers.schedule?.cron).toBe("30 8 * * 1-5");
});

test("runs: a sub-agent's run under the run that called it, and what waits for approval", () => {
  const run = {
    runId: "run_01",
    agentId: "sample.triage",
    version: "h1",
    trigger: "api",
    parentRunId: null,
    status: "awaiting_approval",
    startedAt: NOW - 60_000,
    durationMs: 1_200,
    steps: 3,
    costUsd: null,
    errorClass: null,
    toolCalls: [{ toolId: "claim.note", status: "skipped", approval: "pending" }],
    pendingApprovals: 1,
  };
  convex.setQuery(api.agentBuilder.runs, {
    runs: [{ ...run, children: [{ ...run, runId: "run_02", agentId: "sample.helper", trigger: "subagent", status: "ok", toolCalls: [], parentRunId: "run_01" }] }],
    pendingApprovals: 1,
    runsWaiting: 1,
    read: 2,
  });
  render(<RunsTab project="sample-desk" agentId="sample.triage" now={NOW} />);
  expect(screen.getByText(/1 tool call waits for approval, in 1 run\./)).toBeTruthy();
  expect(screen.getByText("run_01")).toBeTruthy();
  expect(screen.getByText("sample.helper")).toBeTruthy();
  expect(screen.getByText("claim.note: not run, waiting for approval")).toBeTruthy();
  expect(screen.getAllByText("Not priced").length).toBe(2);
});

test("create agent: the default model is preselected; a patient-data project gets none", () => {
  render(
    <CreateAgent
      projects={[
        { slug: "sample-desk", name: "Sample Desk", holdsPatientData: false, allowedProviders: ["ai_studio", "vertex"] },
        { slug: "sample-clinic", name: "Sample Clinic", holdsPatientData: true, allowedProviders: ["vertex"] },
      ]}
      initial={null}
      onCreated={() => {}}
      onCancel={() => {}}
    />,
  );
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(DEFAULT_BUILDER_MODEL.model);
  fireEvent.change(screen.getByLabelText("Runs in"), { target: { value: "sample-clinic" } });
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Runs in"), { target: { value: "startup-os" } });
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(DEFAULT_BUILDER_MODEL.model);
});

test("one of Startup OS's own four on the Mac: the Builder says the Mac runs it, not Startup OS", () => {
  convex.setQuery(api.agentBuilder.builder, { ...options, project: { ...options.project, slug: "startup-os", runsHere: true } });
  render(<BuilderTab view={{ ...view, project: "startup-os", agentId: "finance" } as HarnessView} now={NOW} runsOn="claude_mac" />);
  expect(screen.getByText(RUNS_ON_LINES.claude_mac)).toBeTruthy();
  expect(screen.getByText(MAC_TOOLS_LINE)).toBeTruthy();
  expect(screen.queryByText(STARTUP_OS_WORDS.howItRuns)).toBeNull();
});
