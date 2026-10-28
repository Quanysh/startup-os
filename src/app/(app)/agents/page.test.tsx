// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { AgentRow } from "@/components/agents/agents-table";
import type { ProjectCard } from "@/components/agents/project-cards";
import type { Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { mockConvex } from "@/test-support/convex";
import AgentsPage from "./page";

const nav = vi.hoisted(() => ({ query: "", listeners: new Set<() => void>(), replaced: [] as string[] }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    nav.listeners.add(listener);
    return () => nav.listeners.delete(listener);
  };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => nav.query)),
    usePathname: () => "/agents",
    useRouter: () => ({
      replace: (href: string) => {
        nav.replaced.push(href);
        nav.query = href.split("?")[1] ?? "";
        nav.listeners.forEach((listener) => listener());
      },
    }),
  };
});
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

// Every project, agent, model and figure here is made up.
const NOW = Date.UTC(2026, 9, 16, 12);
const TODAY = "2026-10-16";

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  project: "vertical-startup",
  agentId: "made-up.select",
  name: null,
  phi: null,
  waiting: false,
  steered: true,
  enabled: true,
  primary: { provider: "vertex", model: "made-up-pro" },
  primaryObserved: false,
  fallback: { provider: "ai_studio", model: "made-up-flash" },
  promptVersion: "3",
  calls7d: 1200,
  errorRate7d: 0.05,
  schemaFailureRate7d: 0,
  fallbackRate7d: 0,
  p95Ms7d: 9800,
  costToday: { usd: 1.5, why: null },
  costMonth: { usd: 60, why: null },
  budgetUsd: 50,
  budgetShare: 1.2,
  lastSeenDay: TODAY,
  version: 3,
  pending: false,
  ...over,
});

const card = (over: Partial<ProjectCard> = {}): ProjectCard => ({
  slug: "vertical-startup",
  name: "Vertical Startup",
  region: "US",
  holdsPatientData: true,
  allowedProviders: ["vertex"],
  status: "active",
  connected: false,
  legacy: true,
  tokenCreatedAt: null,
  lastSeenAt: null,
  lastUsageAt: NOW - 60 * 60_000,
  failMode: "closed",
  agentsCount: 2,
  knownCount: 0,
  callsToday: 40,
  errorsToday: 2,
  costToday: { usd: 1.5, why: null },
  latestVersion: 3,
  appliedVersion: 3,
  phiMismatch: false,
  ...over,
});

const SAMPLE = card({
  slug: "sample-search",
  name: "Sample Search",
  holdsPatientData: false,
  allowedProviders: ["ai_studio", "vertex"],
  connected: true,
  legacy: false,
  tokenCreatedAt: NOW - 86_400_000,
  lastSeenAt: NOW - 5 * 60_000,
  failMode: "open",
  agentsCount: 0,
  callsToday: null,
  errorsToday: null,
  costToday: { usd: null, why: "nothing_reported" },
  latestVersion: 0,
  appliedVersion: null,
});

const overview = (over: Record<string, unknown> = {}) => ({
  agents: [
    row(),
    row({
      agentId: "made-up.extract",
      steered: false,
      enabled: null,
      primary: { provider: "astana_gpu", model: "made-up-open" },
      primaryObserved: true,
      fallback: null,
      calls7d: null,
      errorRate7d: null,
      p95Ms7d: null,
      costToday: { usd: null, why: "unpriced" },
      costMonth: { usd: null, why: "unpriced" },
      budgetUsd: null,
      budgetShare: null,
      version: null,
    }),
  ],
  providers: [
    { project: "vertical-startup", provider: "vertex", model: "made-up-pro", state: "up", checkedAt: NOW - 60_000, lastErrorClass: null },
    { project: "vertical-startup", provider: "astana_gpu", model: "made-up-open", state: "down", checkedAt: NOW - 60_000, lastErrorClass: "timeout" },
  ],
  steering: { connected: true, missing: [] },
  pushed: true,
  ...over,
});

const INTERNAL = {
  slug: "startup-os",
  name: "Startup OS",
  note: "Its own four agents run on the owner's Mac through Claude, or here on Gemini, as the owner chooses for each; not priced.",
  today: { calls: 3, errors: 1 },
  agents: [
    {
      id: "engineering",
      name: "Engineering manager",
      line: "Looks for stuck pull requests.",
      on: true,
      runsOn: "claude_mac",
      calls7d: 4,
      outcomes: { ok: 3, refused: 0, invalid: 0, error: 1 },
      lastRunAt: NOW - 3_600_000,
    },
    {
      id: "sales",
      name: "Sales and pipeline",
      line: "Looks for deals gone quiet.",
      on: false,
      runsOn: "gemini",
      calls7d: 0,
      outcomes: { ok: 0, refused: 0, invalid: 0, error: 0 },
      lastRunAt: null,
    },
  ],
  unattributed7d: 0,
};

/** Startup OS's own four as the agents table has them: built here, each with where it runs. */
const OS_ROWS = [
  row({
    project: "startup-os",
    agentId: "engineering",
    name: "Engineering manager",
    builtHere: true,
    draftOnly: false,
    runsOn: "claude_mac",
    primary: { provider: "ai_studio", model: "gemini-3.8-flash" },
    fallback: null,
    budgetUsd: null,
    budgetShare: null,
  }),
  row({
    project: "startup-os",
    agentId: "sales",
    name: "Sales and pipeline",
    enabled: false,
    builtHere: true,
    draftOnly: false,
    runsOn: "gemini",
    primary: { provider: "ai_studio", model: "gemini-3.8-flash" },
    fallback: null,
    budgetUsd: null,
    budgetShare: null,
  }),
];

let convex: ReturnType<typeof mockConvex>;

function show({
  data = overview(),
  projects = [card(), SAMPLE],
  changes = [] as unknown[],
  areas,
}: { data?: unknown; projects?: ProjectCard[]; changes?: unknown[]; areas?: Area[] } = {}) {
  convex.setQuery(api.agentControl.overview, data);
  convex.setQuery(api.agentControl.changes, changes);
  convex.setQuery(api.agentProjects.list, projects);
  convex.setQuery(api.agentProjects.startupOs, INTERNAL);
  convex.setQuery(api.freshness.forPage, []);
  vi.mocked(useNow).mockReturnValue(NOW);
  const page = (
    <CompanyProvider>
      <AgentsPage />
    </CompanyProvider>
  );
  return render(
    areas === undefined ? (
      page
    ) : (
      <ViewerProvider viewer={{ role: "engineer", companies: ["kz"], areas, email: null, name: null }}>{page}</ViewerProvider>
    ),
  );
}

beforeEach(() => {
  convex = mockConvex();
  nav.query = "";
  nav.replaced.length = 0;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the Agents page", () => {
  test("before any project: one line per step, and Connect a project", () => {
    show({ data: overview({ agents: [], providers: [], pushed: false }), projects: [] });
    const steps = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(steps.slice(0, 3)).toEqual([
      "Connect a project: it gets a token, shown once.",
      "Install the agents package in that project and set STARTUP_AGENTS_URL and STARTUP_AGENTS_TOKEN.",
      "Its agents report here once a day; launch and steer them from this page.",
    ]);
    expect(screen.getByRole("button", { name: "Connect a project" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("project cards: region, patient data, connection, agents and today's figures; missing is not zero", () => {
    show();
    const cards = screen.getByRole("list", { name: "Projects" });
    const vertical = within(cards).getByRole("button", { name: "Vertical Startup" });
    expect(vertical.textContent).toContain("US");
    expect(vertical.textContent).toContain("Patient data");
    expect(vertical.textContent).toContain("Legacy push, 1 hour ago");
    expect(vertical.textContent).toContain("$1.50");
    const sample = within(cards).getByRole("button", { name: "Sample Search" });
    expect(sample.textContent).toContain("No patient data");
    expect(sample.textContent).toContain("Last seen 5 minutes ago");
    expect(sample.textContent).toContain("None reported");
    expect(sample.textContent).not.toContain("$0.00");
    // The owner sees Startup OS's own agents too.
    expect(within(cards).getByRole("button", { name: "Startup OS" }).textContent).toContain("Not token-connected");
  });

  test("choosing a project puts it in the address, and its panel offers its token's actions", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Sample Search" }));
    expect(nav.replaced.at(-1)).toBe("/agents?project=sample-search");
    const panel = screen.getByRole("region", { name: "Sample Search" });
    expect(within(panel).getByText(/Fails open/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Rotate token" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  test("Vertical Startup without a token: Issue a token, and its legacy way named", () => {
    nav.query = "project=vertical-startup";
    show();
    const panel = screen.getByRole("region", { name: "Vertical Startup" });
    expect(within(panel).getByRole("button", { name: "Issue a token" })).toBeTruthy();
    expect(panel.textContent).toContain("INGEST_TOKEN_VERTICAL_AGENTS");
  });

  test("connecting a project shows its token once, with the two variables to set", async () => {
    const user = userEvent.setup();
    convex.mutation(api.agentProjects.connect).mockResolvedValue({ slug: "startup-atlas", token: "rap_made-up-token" });
    show();
    await user.click(screen.getByRole("button", { name: "Connect a project" }));
    await user.click(screen.getByRole("button", { name: "Startup Atlas" }));
    // Filling in a known project says whether it holds patient data: Startup Atlas does not.
    expect((screen.getByRole("checkbox", { name: /Holds patient data/ }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Connect and show its token" }));
    const sent = convex.mutation(api.agentProjects.connect).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      name: "Startup Atlas",
      slug: "startup-atlas",
      region: "US",
      holdsPatientData: false,
      allowedProviders: ["ai_studio", "vertex", "astana_gpu"],
    });
    expect(sent.entropy).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(screen.getByTestId("project-token").textContent).toBe("rap_made-up-token");
    expect(screen.getByTestId("project-setup").textContent).toContain("STARTUP_AGENTS_TOKEN=rap_made-up-token");
    expect(screen.getByTestId("project-setup").textContent).toContain("STARTUP_AGENTS_URL=");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("project-token")).toBeNull();
  });

  test("each agent with its switch, models, figures and budget; a missing figure is not a zero", () => {
    show();
    const table = screen.getByRole("table", { name: "Agents" });
    const select = within(table).getByRole("row", { name: /made-up\.select/ });
    expect(within(select).getByRole("switch", { name: "made-up.select on" }).getAttribute("aria-checked")).toBe("true");
    expect(select.textContent).toContain("Vertical Startup");
    expect(select.textContent).toContain("made-up-pro");
    expect(select.textContent).toContain("made-up-flash");
    expect(select.textContent).toContain("1,200");
    expect(select.textContent).toContain("5.0%");
    expect(select.textContent).toContain("9.8 s");
    expect(select.textContent).toContain("$60.00");
    expect(select.textContent).toContain("Over the $50.00 budget");
    const extract = within(table).getByRole("row", { name: /made-up\.extract/ });
    expect(extract.textContent).toContain("None");
    expect(extract.textContent).toContain("Not priced");
    expect(extract.textContent).toContain("As its project set it");
    expect(extract.textContent).not.toContain("$0.00");
  });

  test("a launched agent its project has not reported yet says it is waiting", () => {
    show({ data: overview({ agents: [row({ project: "sample-search", agentId: "made-up.digest", name: "Digest", waiting: true, pending: true })] }) });
    const digest = screen.getByRole("row", { name: /made-up\.digest/ });
    expect(digest.textContent).toContain("Waiting for the project to report it");
    expect(digest.textContent).toContain("Pending");
  });

  test("the switch sends a change for that agent in its project", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("switch", { name: "made-up.select on" }));
    expect(convex.mutation(api.agentControl.change)).toHaveBeenCalledWith({
      project: "vertical-startup",
      agentId: "made-up.select",
      enabled: false,
    });
  });

  test("launching: a project, an agent it can run, a model it may use", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.agentProjects.launchOptions, {
      holdsPatientData: false,
      allowedProviders: ["ai_studio", "vertex"],
      catalog: [{ agentId: "search.rank", name: "Rank", phi: false, kind: "declarative", launched: false, lastReportedAt: NOW }],
      pairs: [
        { provider: "ai_studio", model: "made-up-flash", patientData: false },
        { provider: "vertex", model: "made-up-pro", patientData: true },
      ],
    });
    show();
    await user.click(screen.getByRole("button", { name: "Launch agent" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "sample-search");
    await user.type(screen.getByRole("textbox", { name: "Monthly budget, USD" }), "30");
    await user.click(screen.getByRole("button", { name: "Launch" }));
    expect(convex.mutation(api.agentControl.launch)).toHaveBeenCalledWith({
      project: "sample-search",
      agentId: "search.rank",
      name: "Rank",
      enabled: true,
      provider: "ai_studio",
      model: "made-up-flash",
      fallback: null,
      monthlyBudgetUsd: 30,
      promptVersionPin: null,
    });
    expect(nav.replaced.at(-1)).toBe("/agents?project=sample-search&agent=search.rank");
  });

  test("providers: the three the OS knows, which are for patient data, and Not connected when never seen", () => {
    show();
    const panel = screen.getByRole("region", { name: "Providers" });
    expect(within(panel).getByText("Only Vertex AI is for real patient data. Google AI Studio and the Made-up GPU are not.")).toBeTruthy();
    expect(within(panel).getByText("Not connected")).toBeTruthy();
    expect(within(panel).getByText("Down")).toBeTruthy();
    expect(within(panel).getByText("Up")).toBeTruthy();
    expect(within(panel).getAllByText("Not for real patient data")).toHaveLength(2);
    expect(within(panel).getByText("For real patient data")).toBeTruthy();
  });

  test("Vertical Startup's legacy steering not connected: said with the variables' names", () => {
    show({ data: overview({ steering: { connected: false, missing: ["VERTICAL_AGENT_CONFIG_SECRET"] } }) });
    expect(screen.getByText(/Steering is not connected: VERTICAL_AGENT_CONFIG_SECRET is not set/)).toBeTruthy();
  });

  test("clicking an agent opens it, with its project, in the address", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.agentControl.agent, undefined);
    show();
    await user.click(screen.getByRole("button", { name: "made-up.select" }));
    expect(nav.replaced).toEqual(["/agents?agent=made-up.select&in=vertical-startup"]);
  });

  test("the Bots tab is the owner's; leaving it takes its filter and open bot out of the address", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.bots.list, { bots: [], suggestedMissing: 0, externalMissing: [] });
    convex.setQuery(api.assistant.clients, []);
    nav.query = "view=bots&filter=off&q=grow&bot=growth&settings=open";
    show();
    expect(screen.getByRole("heading", { name: "Bots" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(nav.replaced.at(-1)).toBe("/agents");
  });

  test("Startup OS's own agents: one table, each with its switch and where it runs", () => {
    nav.query = "project=startup-os";
    show({ data: overview({ agents: OS_ROWS }) });
    const table = screen.getByRole("table", { name: "Startup OS's agents" });
    const engineering = within(table).getByRole("row", { name: /Engineering manager/ });
    expect(within(engineering).getByRole("switch", { name: "engineering on" }).getAttribute("aria-checked")).toBe("true");
    expect(engineering.textContent).toContain("Claude on the Mac");
    const sales = within(table).getByRole("row", { name: /Sales and pipeline/ });
    expect(within(sales).getByRole("switch", { name: "sales on" }).getAttribute("aria-checked")).toBe("false");
    expect(sales.textContent).toContain("Gemini in Startup OS");
    expect(screen.queryByRole("table", { name: "Agents" })).toBeNull();
    // The card says where each of the four runs.
    const card = screen.getByRole("button", { name: "Startup OS" });
    expect(card.textContent).toContain("Engineering manager");
    expect(card.textContent).toContain("Claude on the Mac");
    expect(card.textContent).toContain("Sales and pipeline (off)");
    expect(card.textContent).toContain("Gemini in Startup OS");
  });

  test("every project's agents name Startup OS by its name, never its slug", () => {
    show({ data: overview({ agents: [row(), ...OS_ROWS] }) });
    const table = screen.getByRole("table", { name: "Agents" });
    const engineering = within(table).getByRole("row", { name: /Engineering manager/ });
    expect(engineering.textContent).toContain("Startup OS");
    expect(engineering.textContent).not.toContain("startup-os");
  });

  test("a teammate with the area is not shown Startup OS's own agents, nor asked for them", () => {
    vi.mocked(useQuery).mockClear();
    show({ areas: ["agents"] });
    const asked = vi.mocked(useQuery).mock.calls.filter(([ref]) => getFunctionName(ref as never) === "agentProjects:startupOs");
    expect(asked.every(([, args]) => args === "skip")).toBe(true);
    expect(screen.queryByRole("button", { name: "Startup OS" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sample Search" })).toBeTruthy();
  });

  test("without the area nothing is asked of the server", () => {
    vi.mocked(useQuery).mockClear();
    show({ areas: ["product"] });
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([ref]) => /^agent(Control|Projects):/.test(getFunctionName(ref as never)));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(([, args]) => args === "skip")).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
