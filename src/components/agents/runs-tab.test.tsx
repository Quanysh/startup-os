// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { useQuery } from "convex/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { STARTUP_OS_WORDS } from "@convex/lib/agentStartupOs";
import { mockConvex } from "@/test-support/convex";
import { BuilderTab } from "./builder-tab";
import type { HarnessView } from "./harness-tab";
import { AgentsTable } from "./agents-table";
import { RunsTab } from "./runs-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The Runs tab of an agent Startup OS runs itself, with made-up data: Run now,
// the calls waiting for the owner with Approve and Deny, a run's answer shown
// as text, and what a teammate sees instead; and the Builder's words for it.

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-17T12:00:00Z");

const run = {
  runId: "os-made-up-1",
  agentId: "os.writer",
  version: "h1",
  trigger: "api",
  parentRunId: null,
  status: "ok",
  startedAt: NOW - 60_000,
  durationMs: 1_200,
  steps: 2,
  costUsd: null,
  errorClass: null,
  toolCalls: [{ toolId: "task_create", status: "ok", approval: "approved" }],
  pendingApprovals: 0,
  answer: true,
  children: [],
};

const runs = (over: Record<string, unknown> = {}) => ({
  runs: [run],
  runsHere: true,
  pendingApprovals: 1,
  runsWaiting: 1,
  read: 1,
  ...over,
});

const waiting = [
  {
    id: "a1",
    rootRunId: "os-made-up-2",
    runId: "os-made-up-2",
    agentId: "os.writer",
    toolId: "task_create",
    toolName: "Add a task",
    arguments: '{"title":"<b>Made-up</b> [card](https://example.com)"}',
    createdAt: NOW - 30_000,
  },
];

const INPUT = { mode: "text" as const, variables: [{ name: "request", required: true }] };

test("the owner starts it with its variables; what waits is decided on Approvals, not here", async () => {
  convex.setQuery(api.agentBuilder.runs, runs());
  convex.setQuery(api.agentRuntime.approvals, waiting);
  render(<RunsTab project="startup-os" agentId="os.writer" now={NOW} isOwner input={INPUT} />);

  expect(screen.getByText(new RegExp(STARTUP_OS_WORDS.approvalsHere.slice(0, 30)))).toBeTruthy();
  expect(screen.queryByText(/project's own app/)).toBeNull();

  fireEvent.change(screen.getByLabelText("request, required"), { target: { value: "made-up request" } });
  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(convex.mutation(api.agentRuntime.runNow)).toHaveBeenCalledWith({ agentId: "os.writer", variables: { request: "made-up request" } }));

  // One line to the one place calls are decided; no approve or deny of its own, and the model's arguments are not shown here.
  const link = screen.getByRole("link", { name: /1 waiting/ });
  expect(link.getAttribute("href")).toBe("/approvals?kind=tool_call");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  expect(screen.queryByText(/Made-up<\/b>/)).toBeNull();
  expect(convex.mutation(api.agentRuntime.decide)).not.toHaveBeenCalled();
});

test("a conversation agent is started with a message", async () => {
  convex.setQuery(api.agentBuilder.runs, runs({ runs: [] }));
  convex.setQuery(api.agentRuntime.approvals, []);
  render(<RunsTab project="startup-os" agentId="os.chat" now={NOW} isOwner input={{ mode: "messages", variables: [] }} />);
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Made-up question?" } });
  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() =>
    expect(convex.mutation(api.agentRuntime.runNow)).toHaveBeenCalledWith({ agentId: "os.chat", variables: {}, message: "Made-up question?" }),
  );
  expect(screen.getByText(/No run yet\. It runs on its schedule, with Run now/)).toBeTruthy();
});

test("a run's answer opens below the table, as text", () => {
  convex.setQuery(api.agentBuilder.runs, runs({ pendingApprovals: 0, runsWaiting: 0 }));
  convex.setQuery(api.agentRuntime.approvals, []);
  convex.setQuery(api.agentRuntime.output, {
    runId: run.runId,
    agentId: "os.writer",
    format: "json",
    text: '{"note":"<script>made-up</script>"}',
    truncated: false,
  });
  render(<RunsTab project="startup-os" agentId="os.writer" now={NOW} isOwner input={INPUT} />);
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  const answer = screen.getByText(/<script>made-up<\/script>/);
  expect(answer.tagName).toBe("PRE");
  expect(document.querySelector("section script")).toBeNull();
});

test("a teammate sees the runs, no Run now, no approvals, and no answer they may not read", () => {
  vi.mocked(useQuery).mockClear();
  convex.setQuery(api.agentBuilder.runs, runs({ runs: [{ ...run, answer: false }] }));
  render(<RunsTab project="startup-os" agentId="os.writer" now={NOW} input={INPUT} />);
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  expect(screen.getByText(/The owner approves them on Approvals\./)).toBeTruthy();
  const asked = vi.mocked(useQuery).mock.calls.map(([ref]) => getFunctionName(ref as never));
  expect(asked).not.toContain(getFunctionName(api.agentRuntime.approvals));
});

test("the Builder of an agent that runs here: how it runs, no API endpoint yet, no chat box", () => {
  const definition = {
    name: "Made-up helper",
    description: "Does a made-up thing.",
    input: { mode: "text" as const, variables: [{ name: "request", required: true }] },
    model: { provider: "ai_studio", model: "gemini-3.8-flash" },
    triggers: { api: true },
    approvals: [],
    limits: { maxSteps: 10, timeoutMs: 120_000 },
  };
  const draft = {
    id: "v1",
    number: 1,
    name: "h1",
    status: "draft",
    revision: 1,
    changed: [],
    promptVariants: ["default"],
    parts: { prompt: { variants: { default: { system: "Help.", user: "{{request}}" } } }, tools: [] },
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
    gate: "no_run",
  };
  const view = {
    project: "startup-os",
    agentId: "os.helper",
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
  convex.setQuery(api.agentBuilder.builder, {
    project: { slug: "startup-os", name: "Startup OS", holdsPatientData: false, allowedProviders: ["ai_studio", "astana_gpu"], runsHere: true },
    tools: [],
    peers: [],
    publishedToolId: null,
    pairs: [{ provider: "ai_studio", model: "gemini-3.8-flash", patientData: false }],
    providers: [
      { provider: "ai_studio", configured: true },
      { provider: "astana_gpu", configured: false },
    ],
    isOwner: true,
  });
  render(<BuilderTab view={view} now={NOW} />);
  expect(screen.getByText(STARTUP_OS_WORDS.howItRuns)).toBeTruthy();
  expect(screen.getByText(STARTUP_OS_WORDS.noApi)).toBeTruthy();
  expect(screen.getByText(STARTUP_OS_WORDS.noChat)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "A chat box in the app" })).toBeNull();
  expect(screen.queryByText(/does not run its own agents/)).toBeNull();
});

test("a Startup OS agent's budget says it is not enforced while its runs are not priced", () => {
  convex.setQuery(api.agentBuilder.builder, {
    project: { slug: "startup-os", name: "Startup OS", holdsPatientData: false, allowedProviders: ["ai_studio"], runsHere: true },
    tools: [],
    peers: [],
    publishedToolId: null,
    pairs: [],
    providers: [{ provider: "ai_studio", configured: true }],
    isOwner: true,
  });
  const draft = {
    id: "v1",
    number: 1,
    name: "h1",
    status: "draft",
    revision: 1,
    changed: [],
    promptVariants: ["default"],
    parts: { prompt: { variants: { default: { system: "Help.", user: "{{request}}" } } }, tools: [] },
    definition: {
      name: "Made-up helper",
      description: "Does a made-up thing.",
      input: { mode: "text", variables: [] },
      model: { provider: "ai_studio", model: "gemini-3.8-flash" },
      triggers: { api: true },
      approvals: [],
      limits: { maxSteps: 10, timeoutMs: 120_000, monthlyBudgetUsd: 20 },
    },
    problems: [],
    gate: "no_run",
    note: "",
  };
  const view = { project: "startup-os", agentId: "os.helper", built: true, published: null, draft, versions: [draft], ownerOnly: false, isOwner: true, mayPublish: true } as unknown as HarnessView;
  render(<BuilderTab view={view} now={NOW} />);
  expect(screen.getByText(STARTUP_OS_WORDS.budgetNotEnforced)).toBeTruthy();
});

test("the agents table says a Startup OS agent's budget is not enforced; a project's says nothing more", () => {
  const row = {
    agentId: "os.helper",
    steered: true,
    enabled: true,
    primary: { provider: "ai_studio", model: "gemini-3.8-flash" },
    primaryObserved: true,
    fallback: null,
    promptVersion: "h1",
    calls7d: 3,
    errorRate7d: 0,
    schemaFailureRate7d: 0,
    fallbackRate7d: 0,
    p95Ms7d: 900,
    costToday: { usd: null, why: "unpriced" as const },
    costMonth: { usd: null, why: "unpriced" as const },
    budgetUsd: 20,
    budgetShare: null,
    lastSeenDay: "2026-10-17",
    version: 1,
    project: "startup-os",
    name: "Made-up helper",
    phi: false,
    waiting: false,
    pending: false,
    builtHere: true,
  };
  const { rerender } = render(<AgentsTable rows={[row]} selected={null} busy={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.getByText("Not enforced: its runs are not priced.")).toBeTruthy();
  rerender(<AgentsTable rows={[{ ...row, project: "sample-desk" }]} selected={null} busy={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.queryByText("Not enforced: its runs are not priced.")).toBeNull();
});

test("one of the four on the Mac: the table names Claude Code, not the Gemini model it would use there", () => {
  const row = {
    agentId: "finance",
    steered: true,
    enabled: true,
    primary: { provider: "ai_studio", model: "gemini-3.8-flash" },
    primaryObserved: false,
    fallback: null,
    promptVersion: "h1",
    calls7d: null,
    errorRate7d: null,
    schemaFailureRate7d: null,
    fallbackRate7d: null,
    p95Ms7d: null,
    costToday: { usd: null, why: "unpriced" as const },
    costMonth: { usd: null, why: "unpriced" as const },
    budgetUsd: null,
    budgetShare: null,
    lastSeenDay: null,
    version: 1,
    project: "startup-os",
    name: "Finance and compliance",
    phi: false,
    waiting: false,
    pending: false,
    builtHere: true,
    runsOn: "claude_mac" as const,
  };
  const { rerender } = render(<AgentsTable rows={[row]} selected={null} busy={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.getByText("Claude Code, on the owner's Mac")).toBeTruthy();
  expect(screen.queryByText("gemini-3.8-flash")).toBeNull();
  rerender(<AgentsTable rows={[{ ...row, runsOn: "gemini" as const }]} selected={null} busy={null} onSelect={() => {}} onToggle={() => {}} />);
  expect(screen.queryByText("Claude Code, on the owner's Mac")).toBeNull();
});

test("an agent with nothing reported has one quiet line across its figures, not a placeholder in each", () => {
  const row = {
    agentId: "sample.idle",
    steered: true,
    enabled: true,
    primary: { provider: "ai_studio", model: "gemini-3.8-flash" },
    primaryObserved: false,
    fallback: null,
    promptVersion: null,
    calls7d: null,
    errorRate7d: null,
    schemaFailureRate7d: null,
    fallbackRate7d: null,
    p95Ms7d: null,
    costToday: { usd: null, why: "nothing_reported" as const },
    costMonth: { usd: null, why: "nothing_reported" as const },
    budgetUsd: null,
    budgetShare: null,
    lastSeenDay: null,
    version: 1,
    project: "sample-desk",
    name: "Made-up idle agent",
    phi: false,
    waiting: false,
    pending: false,
    builtHere: true,
  };
  render(<AgentsTable rows={[row]} selected={null} busy={null} onSelect={() => {}} onToggle={() => {}} />);
  const line = screen.getByText("Nothing reported in seven days");
  expect(line.closest("td")!.getAttribute("colspan")).toBe("5");
  expect(screen.queryByText("None reported")).toBeNull();
  expect(screen.queryByText("None")).toBeNull();
});
