// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { GATE_WORDS, MADE_UP_NOTE } from "@convex/lib/agentJobs";
import { mockConvex } from "@/test-support/convex";
import { HARNESS_WORDS } from "@convex/lib/agentHarness";
import { HarnessTab, MESSAGES_NOTE, type HarnessView } from "./harness-tab";
import { TestsTab } from "./tests-tab";
import { VersionsTab } from "./versions-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The Harness, Tests and Versions tabs with made-up data: what is live, the
// draft's rules as it is typed, the gate, who may publish, and the made-up
// data note.

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-16T12:00:00Z");
const SCHEMA = { type: "object", required: ["codes"], properties: { codes: { type: "array" } } };

type Row = HarnessView["versions"][number];
type Whole = Row & {
  parts: NonNullable<HarnessView["published"]>["parts"];
  definition: NonNullable<HarnessView["published"]>["definition"];
};

const version = (over: Partial<Whole> = {}): Whole => ({
  id: "v1" as never,
  number: 1,
  name: "h1",
  status: "draft",
  revision: 2,
  changed: [],
  promptVariants: null,
  parts: {},
  definition: null,
  codeDefault: true,
  basedOn: null,
  note: "",
  createdBy: "You",
  createdAt: NOW - 3_600_000,
  updatedBy: "You",
  updatedAt: NOW - 3_600_000,
  publishedBy: null,
  publishedAt: null,
  ...over,
});

const view = (over: Partial<HarnessView> = {}): HarnessView => ({
  project: "sample-search",
  agentId: "sample.rank",
  built: false,
  holdsPatientData: false,
  defaults: {
    prompt: { version: "v1", system: "Rank made-up policies.", user: "Query: {{query}}", variables: [{ name: "query", required: true }] },
    params: { temperature: 0.2 },
    tools: [{ id: "web_search", name: "Web search", description: "Made-up search.", phi: false }],
    defaultTools: ["web_search"],
    output: { schemaVersion: "1", schema: JSON.stringify(SCHEMA) },
  },
  published: null,
  draft: null,
  versions: [],
  events: [],
  current: { provider: "ai_studio", model: "made-up-flash", fallbackProvider: null },
  patientProviders: false,
  ownerOnly: false,
  mayPublish: true,
  isOwner: true,
  ...over,
});

test("nothing published: the built-in prompt is said, and a draft can be started from the code's defaults", () => {
  render(<HarnessTab view={view()} now={NOW} />);
  expect(screen.getByText(/Using the project's built-in prompt/)).toBeTruthy();
  expect(screen.getByText(/The code declares: Prompt v1, 1 variable, 1 tool, output schema 1\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New draft from the code's defaults" }));
  expect(convex.mutation(api.agentHarness.newDraft)).toHaveBeenCalledWith({
    project: "sample-search",
    agentId: "sample.rank",
    from: "default",
  });
});

test("a free-text agent with no templates says so", () => {
  const draft = { ...version(), problems: [], gate: "no_run" as const };
  render(<HarnessTab view={view({ defaults: { params: { temperature: 1 } }, draft, versions: [draft] })} now={NOW} />);
  expect(screen.getByText("No prompt template declared: the code builds its prompt itself.")).toBeTruthy();
  expect(screen.getByText("Free-text output: the code declares no schema.")).toBeTruthy();
  expect(screen.getByText(/The code declares: No prompt template declared, no tools, free-text output\./)).toBeTruthy();
});

test("the draft's rules show as it is typed, and publishing waits for a passing run", () => {
  const draft = { ...version(), problems: [], gate: "no_run" as const };
  render(<HarnessTab view={view({ draft, versions: [draft] })} now={NOW} />);
  fireEvent.change(screen.getByLabelText("User"), { target: { value: "{{patientName}}" } });
  expect(screen.getByText(/uses \{\{patientName\}\}, which is not a declared variable\./)).toBeTruthy();
  expect(screen.getByText(/must use the required variable \{\{query\}\}\./)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: JSON.stringify({ type: "object" }) } });
  expect(screen.getByText(/is required by the code and must stay/)).toBeTruthy();
  expect(screen.getByText(GATE_WORDS.no_run)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Publish h1" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Publish without a passing test run" })).toBeTruthy();
});

test("a teammate who may not publish is told so; the override is the owner's alone", () => {
  const draft = { ...version(), problems: [], gate: "failed" as const };
  render(<HarnessTab view={view({ draft, versions: [draft], mayPublish: false, isOwner: false })} now={NOW} />);
  expect(screen.getByText("Publishing and rolling back are for the owner and engineers.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
});

test("a passed draft is published by its button", () => {
  const draft = { ...version(), problems: [], gate: "passed" as const };
  convex.mutation(api.agentHarness.publish).mockResolvedValue({ version: "h1", configVersion: 4 });
  render(<HarnessTab view={view({ draft, versions: [draft], isOwner: false })} now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Publish h1" }));
  expect(convex.mutation(api.agentHarness.publish)).toHaveBeenCalledWith({ id: "v1" });
});

test("versions: who and when, and a rollback for one published before", () => {
  const published = version({ id: "v2" as never, number: 2, name: "h2", status: "published", publishedAt: NOW, publishedBy: "You", parts: { tools: [] }, changed: ["tools"] });
  const older = version({ status: "archived", publishedAt: NOW - 86_400_000, publishedBy: "A teammate", parts: { params: { temperature: 1 } }, changed: ["params"] });
  const discarded = version({ id: "v3" as never, number: 3, name: "h3", status: "archived" });
  render(<VersionsTab view={view({ published, versions: [discarded, published, older] })} now={NOW} />);
  const table = screen.getByRole("table", { name: "Versions" });
  expect(within(table).getByText("Discarded draft")).toBeTruthy();
  expect(within(table).getByText("Changes the parameters")).toBeTruthy();
  expect(within(table).queryByRole("button", { name: "Roll back to h3" })).toBeNull();
  fireEvent.click(within(table).getByRole("button", { name: "Roll back to h1" }));
  expect(convex.mutation(api.agentHarness.rollback)).toHaveBeenCalledWith({ id: "v1" });
});

test("tests: made-up data only, said first; a case is saved only with the tick", () => {
  convex.setQuery(api.agentHarness.tests, {
    cases: [],
    runs: [],
    choices: [{ provider: "ai_studio", model: "made-up-flash" }],
    draft: null,
    variables: [{ name: "query", required: true }],
    tools: [],
    variants: ["default"],
    input: "text",
    providerTools: [],
    subAgentTools: [],
    built: false,
  });
  render(<TestsTab project="sample-search" agentId="sample.rank" now={NOW} />);
  expect(screen.getAllByText(MADE_UP_NOTE).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Add a case" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Made-up query" } });
  const save = screen.getByRole("button", { name: "Save case" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("This case is made-up data, never a real patient."));
  expect(save.disabled).toBe(false);
  expect(screen.getByText("Start a draft on the Harness tab to test it.")).toBeTruthy();
});

// ── Protocol v1.2 ────────────────────────────────────────────────────────────

const V12_DEFAULTS: HarnessView["defaults"] = {
  prompt: {
    version: "v2",
    input: "text",
    variables: [
      { name: "query", required: true },
      { name: "denial", required: false },
    ],
    variants: {
      default: { system: "Answer.{{#denial}} Denied: {{denial}}.{{/denial}}", user: "Query: {{query}}" },
      retry: { system: "Retry.", user: "Again: {{query}}" },
    },
  },
  tools: [{ id: "google_search", name: "Google search", description: "Made-up.", phi: false, kind: "provider" }],
  defaultTools: ["google_search"],
};

test("variants: one editor each, a switcher with each one's problems, and every variant saved together", async () => {
  const draft = { ...version(), problems: [], gate: "no_run" as const };
  render(<HarnessTab view={view({ defaults: V12_DEFAULTS, draft, versions: [draft] })} now={NOW} />);
  expect(screen.getByText(/The code declares: Prompt v2, 2 variables, 2 variants, 1 tool/)).toBeTruthy();
  expect(screen.getByText("Built into the provider: skipped in test runs")).toBeTruthy();
  const switcher = screen.getByRole("group", { name: "Variants" });
  expect(within(switcher).getByRole("button", { name: /default/ }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByLabelText("System, default") as HTMLTextAreaElement).value).toContain("{{#denial}}");

  fireEvent.click(within(switcher).getByRole("button", { name: /retry/ }));
  fireEvent.change(screen.getByLabelText("System, retry"), { target: { value: "Retry.\n{{#denial}}never closed" } });
  expect(within(switcher).getByRole("button", { name: /retry/ }).textContent).toContain("1 problem");
  expect(screen.getByText(/line 2, column 1/)).toBeTruthy();
  expect(screen.getByText(/opens \{\{#denial\}\} and never closes it\./)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("System, retry"), { target: { value: "Retry, made-up." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(convex.mutation(api.agentHarness.saveDraft)).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: {
        variants: {
          default: V12_DEFAULTS!.prompt!.variants!.default,
          retry: { system: "Retry, made-up.", user: "Again: {{query}}" },
        },
      },
    }),
  );
});

test("sections are marked in the editor, and what they mean is said", () => {
  const draft = { ...version(), problems: [], gate: "no_run" as const };
  const { container } = render(<HarnessTab view={view({ defaults: V12_DEFAULTS, draft, versions: [draft] })} now={NOW} />);
  const marks = container.querySelectorAll("mark");
  expect([...marks].map((mark) => mark.textContent)).toEqual(["{{#denial}} Denied: {{denial}}.{{/denial}}"]);
  expect(screen.getByText(/Marked: a section\./)).toBeTruthy();
});

test("an agent that sends its own conversation: the system prompt alone, and it says so", () => {
  const defaults: HarnessView["defaults"] = {
    prompt: {
      version: "v3",
      input: "messages",
      variables: [{ name: "payer", required: true }],
      variants: { default: { system: "Answer about {{payer}}." } },
    },
  };
  const draft = { ...version(), problems: [], gate: "no_run" as const };
  render(<HarnessTab view={view({ defaults, draft, versions: [draft] })} now={NOW} />);
  expect(screen.getByText(MESSAGES_NOTE)).toBeTruthy();
  expect(screen.getByLabelText("System")).toBeTruthy();
  expect(screen.queryByLabelText("User")).toBeNull();
  expect(screen.queryByRole("group", { name: "Variants" })).toBeNull();
});

test("a variant the draft lacks is put back from the code; one the code does not declare can be removed", () => {
  const draft = {
    ...version({ parts: { prompt: { variants: { default: { system: "Mine.", user: "{{query}}" }, extra: { system: "x", user: "y" } } } } }),
    problems: [{ path: "prompt.extra", message: HARNESS_WORDS.variantAdded }],
    gate: "no_run" as const,
  };
  render(<HarnessTab view={view({ defaults: V12_DEFAULTS, draft, versions: [draft] })} now={NOW} />);
  const switcher = screen.getByRole("group", { name: "Variants" });
  expect(within(switcher).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "default",
    expect.stringContaining("extranot declared"),
    "retry",
  ]);
  fireEvent.click(within(switcher).getByRole("button", { name: /extra/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
  expect(within(switcher).getAllByRole("button").map((b) => b.textContent)).toEqual(["default", "retry"]);
});

test("tests, v1.2: a variant picker, and a conversation for an agent that sends its own", () => {
  convex.setQuery(api.agentHarness.tests, {
    cases: [],
    runs: [],
    choices: [{ provider: "ai_studio", model: "made-up-flash" }],
    draft: null,
    variables: [{ name: "payer", required: true }],
    tools: [],
    variants: ["default", "rubric"],
    input: "messages",
    providerTools: [],
    subAgentTools: [],
    built: false,
  });
  render(<TestsTab project="sample-search" agentId="sample.chat" now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a case" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Made-up chat" } });
  fireEvent.change(screen.getByLabelText(/^Variant/), { target: { value: "rubric" } });
  fireEvent.change(screen.getByLabelText(/payer/), { target: { value: "Made-up Payer" } });
  fireEvent.change(screen.getByLabelText("Message 1, text"), { target: { value: "Made-up: is it covered?" } });
  fireEvent.click(screen.getByRole("button", { name: "Add a message" }));
  expect((screen.getByLabelText("Message 2, role") as HTMLSelectElement).value).toBe("assistant");
  fireEvent.change(screen.getByLabelText("Message 2, text"), { target: { value: "Made-up: which plan?" } });
  fireEvent.click(screen.getByLabelText("This case is made-up data, never a real patient."));
  fireEvent.click(screen.getByRole("button", { name: "Save case" }));
  expect(convex.mutation(api.agentHarness.saveCase)).toHaveBeenCalledWith(
    expect.objectContaining({
      variant: "rubric",
      messages: [
        { role: "user", content: "Made-up: is it covered?" },
        { role: "assistant", content: "Made-up: which plan?" },
      ],
    }),
  );
});

test("a run's results say which provider tools were skipped", () => {
  convex.setQuery(api.agentHarness.tests, {
    cases: [],
    runs: [
      {
        id: "r1",
        number: 1,
        name: "h1, revision 2",
        revision: 2,
        ofDraftNow: true,
        status: "done",
        models: [{ provider: "ai_studio", model: "made-up-flash" }],
        expected: 1,
        received: 1,
        passed: 1,
        createdBy: "You",
        createdAt: NOW,
        finishedAt: NOW,
      },
    ],
    choices: [],
    draft: null,
    variables: [],
    tools: ["google_search"],
    variants: ["default", "retry"],
    input: "text",
    providerTools: ["google_search"],
    subAgentTools: [],
    built: false,
  });
  convex.setQuery(api.agentHarness.run, {
    id: "r1",
    project: "sample-search",
    agentId: "sample.answer",
    status: "done",
    models: [{ provider: "ai_studio", model: "made-up-flash" }],
    cases: [{ caseId: "c1", name: "Made-up retry", expect: [], variant: "retry" }],
    results: [
      {
        caseId: "c1",
        provider: "ai_studio",
        model: "made-up-flash",
        output: null,
        schemaValid: true,
        assertions: [],
        passed: true,
        latencyMs: 800,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
        error: null,
        skippedTools: ["google_search"],
      },
    ],
  });
  render(<TestsTab project="sample-search" agentId="sample.answer" now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByText("Skipped: google_search (built into the provider)")).toBeTruthy();
  expect(screen.getByText(/Tools built into the provider are skipped in test runs/)).toBeTruthy();
  expect(screen.getByText("retry")).toBeTruthy();
});
