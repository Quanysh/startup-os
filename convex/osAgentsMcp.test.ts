import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { STARTUP_OS_PROJECT } from "./lib/agentStartupOs";
import { CODE_DEFAULT_VERSION, osAgentInstructions } from "./lib/osAgentDefaults";
import { MAC_RUN_STUCK_MS, MAC_START_WITHIN_MS, OS_AGENT_TOOLS, OS_AGENT_WORDS, RUN_HEADER, AGENT_HEADER } from "./lib/osAgents";
import { BOT_WORDS } from "./lib/botRules";
import { forward } from "../src/lib/os/pass-through";
import { call, ownerWithToken, rpc } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// The Mac's side of Startup OS's own four agents, through POST /mcp/v1: the
// runner's check-in hands it each agent due on the Mac with its published
// instructions and tools (the code's defaults when none can be read), never
// one moved to Gemini; every call Claude makes in a run names the agent and
// the run, and may use only that agent's tools; the runner's last word on a
// run becomes its row on the Runs tab, made of its calls. Everything typed is
// made up.

const DUE = Date.parse("2026-10-18T06:20:00Z");
const RUNNER = "made-up-runner-1";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DUE - 60 * 60 * 1000);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Handed = {
  runId: string;
  agentId: string;
  name: string;
  version: string;
  instructions: string;
  user: string;
  tools: string[];
  limits: { maxSteps: number; timeoutMs: number };
};

const due = async (t: TestBackend, token: string) => {
  const reply = await call(t, token, "os_agents_due", { runner: RUNNER });
  if (reply.output === null) throw new Error(`os_agents_due did not answer: ${reply.text}`);
  return reply.output as { none?: true; runs: Handed[]; today?: string };
};

/** Hand out what is due and start each run, as the runner does just before it starts Claude Code. */
const dueStarted = async (t: TestBackend, token: string) => {
  const handed = await due(t, token);
  for (const run of handed.runs) {
    const started = await call(t, token, "os_agent_start", { runner: RUNNER, runId: run.runId });
    if (started.output === null) throw new Error(`os_agent_start did not answer: ${started.text}`);
  }
  return handed;
};

const as = (agent: string, runId?: string) => ({ [AGENT_HEADER]: agent, ...(runId === undefined ? {} : { [RUN_HEADER]: runId }) });

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner, token } = await ownerWithToken(t, "act");
  return { t, owner, token };
}

describe("which agents are due on the Mac", () => {
  test("none before their time; at it each on the Mac, chief of staff last, with its published instructions and tools; a time is handed out once", async () => {
    const { t, token } = await setUp();
    expect(await due(t, token)).toMatchObject({ none: true, runs: [] });
    // A check-in that found nothing leaves no audit row.
    expect(await t.run((ctx) => ctx.db.query("agentCalls").collect())).toEqual([]);

    vi.setSystemTime(DUE + 30_000);
    const handed = await due(t, token);
    expect(handed.runs.map((run) => run.agentId)).toEqual(["engineering", "sales", "finance", "chief_of_staff"]);
    for (const run of handed.runs) {
      const agent = run.agentId as keyof typeof OS_AGENT_TOOLS;
      expect(run).toMatchObject({ version: "h1", instructions: osAgentInstructions(agent), tools: [...OS_AGENT_TOOLS[agent]] });
      expect(run.runId).toMatch(/^mac-[a-z0-9-]+$/);
    }
    // Handed out, not started: the run's clock starts when the runner starts it.
    const rows = await t.run((ctx) => ctx.db.query("agentRuntimeRuns").collect());
    expect(rows.every((row) => row.runner === "mac" && row.state === "queued" && row.scheduledFor === DUE && row.claimedAt === undefined)).toBe(true);

    vi.setSystemTime(DUE + 90_000);
    expect(await due(t, token)).toMatchObject({ none: true });
  });

  test("a run the Mac missed is handed out when it is back, the same day", async () => {
    const { t, token } = await setUp();
    vi.setSystemTime(DUE + 3 * 60 * 60 * 1000);
    expect((await due(t, token)).runs).toHaveLength(4);
  });

  test("the Mac is never handed one moved to Gemini, nor one switched off", async () => {
    const { t, owner, token } = await setUp();
    await due(t, token); // seeds them
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "sales", runsOn: "gemini" });
    await owner.mutation(api.assistant.setAgent, { agent: "finance", on: false });
    vi.setSystemTime(DUE + 30_000);
    expect((await due(t, token)).runs.map((run) => run.agentId)).toEqual(["engineering", "chief_of_staff"]);
  });

  test("the owner's published version is what it runs; with none that can be read, the code's defaults", async () => {
    const { t, owner, token } = await setUp();
    await due(t, token);
    // The owner takes the agents tool from the engineering manager.
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "engineering", from: "published" });
    const view = await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "engineering" });
    const draft = view.draft!;
    await owner.mutation(api.agentBuilder.saveDefinition, {
      id,
      revision: draft.revision,
      definition: draft.definition!,
      prompt: { variants: { default: { system: "Made-up instructions of the owner's.", user: "Made-up user turn." } } },
      params: null,
      tools: OS_AGENT_TOOLS.engineering.filter((tool) => tool !== "agents"),
      outputSchema: null,
      note: "",
    });
    await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: the owner's own." });
    // The sales agent's published prompt cannot be read.
    await t.run(async (ctx) => {
      const sales = (await ctx.db.query("agentHarnessVersions").collect()).find((row) => row.agentId === "sales")!;
      for (const row of await ctx.db.query("agentHarnessPrompts").collect()) if (row.versionId === sales._id) await ctx.db.delete(row._id);
    });

    vi.setSystemTime(DUE + 30_000);
    const runs = (await dueStarted(t, token)).runs;
    const engineering = runs.find((run) => run.agentId === "engineering")!;
    expect(engineering).toMatchObject({ version: "h2", instructions: "Made-up instructions of the owner's.", user: "Made-up user turn." });
    expect(engineering.tools).not.toContain("agents");
    const sales = runs.find((run) => run.agentId === "sales")!;
    expect(sales).toMatchObject({ version: CODE_DEFAULT_VERSION, instructions: osAgentInstructions("sales"), tools: [...OS_AGENT_TOOLS.sales] });

    // What it runs on is what it may call: the published version's list.
    const refused = await call(t, token, "agents", {}, as("engineering", engineering.runId));
    expect(refused.said).toBe(OS_AGENT_WORDS.notAllowedTool("engineering"));
  });
});

describe("a call made in a run", () => {
  test("may use only its agent's tools, as that agent, in that run; a call naming none keeps what the token may do", async () => {
    const { t, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const runs = (await dueStarted(t, token)).runs;
    const engineering = runs.find((run) => run.agentId === "engineering")!;
    const sales = runs.find((run) => run.agentId === "sales")!;

    expect((await call(t, token, "pull_requests", {}, as("engineering", engineering.runId))).isError).toBe(false);
    expect((await call(t, token, "deals", {}, as("engineering", engineering.runId))).said).toBe(OS_AGENT_WORDS.notAllowedTool("engineering"));
    expect((await call(t, token, "task_create", { title: "Made-up" }, as("engineering", engineering.runId))).said).toBe(
      OS_AGENT_WORDS.notAllowedTool("engineering"),
    );
    // A runner's own tool is no agent's.
    expect((await call(t, token, "os_agents_due", { runner: RUNNER }, as("engineering", engineering.runId))).said).toBe(
      OS_AGENT_WORDS.notAllowedTool("engineering"),
    );
    // It writes as itself only, and only in its own run.
    const proposal = { agent: "sales", company: "us", kind: "draft", reason: "Made-up.", dedupeKey: "sales:draft:made-up", payload: { title: "x", body: "y" } };
    expect((await call(t, token, "propose", proposal, as("engineering", engineering.runId))).said).toBe(OS_AGENT_WORDS.wrongAgent);
    expect((await call(t, token, "deals", {}, as("engineering", sales.runId))).said).toBe(OS_AGENT_WORDS.runGone);
    // A name that is none of the four and no bot of the owner's: refused with where to add it.
    expect((await call(t, token, "deals", {}, as("nobody"))).said).toBe(BOT_WORDS.unknown);
    expect((await call(t, token, "deals", {}, as("sales", "Not A Run!"))).said).toBe(OS_AGENT_WORDS.unknownAgent);

    // Naming an agent in the call is held to the same list, with no header.
    expect((await call(t, token, "brief_write", { agent: "sales", company: "us", bullets: [{ text: "Made-up" }] })).said).toBe(
      OS_AGENT_WORDS.notAllowedTool("sales"),
    );
    // Naming none: as before.
    expect((await call(t, token, "deals", {})).isError).toBe(false);

    // tools/list in a run lists that agent's tools only.
    const listed = (await rpc(t, token, "tools/list", undefined, as("sales", sales.runId))).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name).sort()).toEqual([...OS_AGENT_TOOLS.sales].sort());

    // Each call is written down with its agent, and with its run where the run was its own.
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    const ofRun = audit.filter((row) => row.runId === engineering.runId).map((row) => [row.tool, row.outcome, row.agent]);
    expect(ofRun).toEqual([
      ["pull_requests", "ok", "engineering"],
      ["deals", "refused", "engineering"],
      ["task_create", "refused", "engineering"],
      ["os_agents_due", "refused", "engineering"],
      ["propose", "refused", "engineering"],
    ]);
    expect(audit.some((row) => row.runId === sales.runId)).toBe(false);
  });
});

describe("on the Mac, a tool that changes something at once is never admitted", () => {
  test("even where an older version holds one, a Mac run's call to it is refused, in a sentence, and it is not listed", async () => {
    const { t, token } = await setUp();
    await due(t, token);
    await t.run(async (ctx) => {
      const version = (await ctx.db.query("agentHarnessVersions").collect()).find((row) => row.agentId === "sales")!;
      await ctx.db.patch(version._id, { tools: [...(version.tools ?? []), "deal_update"] });
    });
    vi.setSystemTime(DUE + 30_000);
    const sales = (await dueStarted(t, token)).runs.find((run) => run.agentId === "sales")!;
    expect(sales.tools).not.toContain("deal_update");
    expect((await call(t, token, "deal_update", { dealId: "made-up", nextStep: "x" }, as("sales", sales.runId))).said).toBe(OS_AGENT_WORDS.macActTool);
    // Named by argument, without the runner: the same, while it runs on the Mac.
    expect((await call(t, token, "propose", { agent: "sales", company: "us", kind: "draft", reason: "Made-up.", dedupeKey: "sales:draft:made-up-x", payload: { title: "x", body: "y" } }, as("sales", sales.runId))).isError).toBe(false);
    const listed = (await rpc(t, token, "tools/list", undefined, as("sales", sales.runId))).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).not.toContain("deal_update");
  });
});

describe("a run's start", () => {
  test("its clock starts when the runner starts it, not when it was handed out, so the last of a long batch is not timed out waiting", async () => {
    const { t, owner, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const chief = (await due(t, token)).runs.find((run) => run.agentId === "chief_of_staff")!;
    // Not started: a call in it is refused, and nothing names it.
    expect((await call(t, token, "brief_latest", {}, as("chief_of_staff", chief.runId))).said).toBe(OS_AGENT_WORDS.runGone);

    // The three before it took long: past the stuck limit since the hand-out, it still waits, and is not ended.
    vi.setSystemTime(DUE + 30_000 + MAC_RUN_STUCK_MS + 60_000);
    await due(t, token);
    expect((await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "chief_of_staff" })).runs).toEqual([]);

    const startedAt = Date.now();
    expect((await call(t, token, "os_agent_start", { runner: RUNNER, runId: chief.runId })).isError).toBe(false);
    // Once.
    expect((await call(t, token, "os_agent_start", { runner: RUNNER, runId: chief.runId })).said).toBe(OS_AGENT_WORDS.runGone);
    expect((await call(t, token, "brief_latest", {}, as("chief_of_staff", chief.runId))).isError).toBe(false);
    vi.setSystemTime(startedAt + 5 * 60_000);
    await due(t, token);
    await call(t, token, "os_agent_finish", { runner: RUNNER, runId: chief.runId, outcome: "done" });
    expect((await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "chief_of_staff" })).runs[0]).toMatchObject({
      status: "ok",
      startedAt,
      durationMs: 5 * 60_000,
    });
  });

  test("one handed out and never started is ended as timed out after an hour; a run that is not the Mac's cannot be started", async () => {
    const { t, owner, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const sales = (await due(t, token)).runs.find((run) => run.agentId === "sales")!;
    vi.setSystemTime(DUE + 30_000 + MAC_START_WITHIN_MS + 60_000);
    await due(t, token);
    expect((await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "sales" })).runs[0]).toMatchObject({
      status: "timeout",
      errorClass: "timeout",
      runner: "mac",
    });
    expect((await call(t, token, "os_agent_start", { runner: RUNNER, runId: sales.runId })).said).toBe(OS_AGENT_WORDS.runGone);
    expect((await call(t, token, "os_agent_start", { runner: RUNNER, runId: "mac-not-a-run-at-all" })).said).toBe(OS_AGENT_WORDS.runGone);
  });
});

describe("the runner's last word", () => {
  test("ends the run: its row on the Runs tab, made of its calls, with the proposals it made; once", async () => {
    const { t, owner, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const engineering = (await dueStarted(t, token)).runs.find((run) => run.agentId === "engineering")!;
    await call(t, token, "pull_requests", {}, as("engineering", engineering.runId));
    await call(t, token, "deals", {}, as("engineering", engineering.runId));
    const proposal = {
      agent: "engineering",
      company: "us",
      kind: "task_create",
      reason: "Made-up reason.",
      dedupeKey: "engineering:task_create:made-up-1",
      payload: { title: "Made-up task" },
    };
    expect((await call(t, token, "propose", proposal, as("engineering", engineering.runId))).isError).toBe(false);

    vi.setSystemTime(DUE + 150_000);
    const finished = await call(t, token, "os_agent_finish", { runner: RUNNER, runId: engineering.runId, outcome: "done", turns: 7 });
    expect(finished.isError).toBe(false);
    const view = await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "engineering" });
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({
      runId: engineering.runId,
      version: "h1",
      trigger: "schedule",
      status: "ok",
      steps: 7,
      durationMs: 120_000,
      costUsd: null,
      runner: "mac",
      proposals: 1,
      toolCalls: [
        { toolId: "pull_requests", status: "ok" },
        { toolId: "deals", status: "denied" },
        { toolId: "propose", status: "ok" },
      ],
    });
    // Once: a run ended is no run of the Mac's, for a last word or a call.
    const again = await call(t, token, "os_agent_finish", { runner: RUNNER, runId: engineering.runId, outcome: "done" });
    expect(again.said).toBe(OS_AGENT_WORDS.runGone);
    expect((await call(t, token, "pull_requests", {}, as("engineering", engineering.runId))).said).toBe(OS_AGENT_WORDS.runGone);
  });

  test("a failure is one of a closed list; a run never finished is ended as timed out", async () => {
    const { t, owner, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const runs = (await dueStarted(t, token)).runs;
    const sales = runs.find((run) => run.agentId === "sales")!;
    await call(t, token, "os_agent_finish", { runner: RUNNER, runId: sales.runId, outcome: "usageLimit" });
    expect((await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "sales" })).runs[0]).toMatchObject({
      status: "error",
      errorClass: "rate_limit",
      runner: "mac",
    });
    const bad = await call(t, token, "os_agent_finish", { runner: RUNNER, runId: sales.runId, outcome: "SECRET words" });
    expect(bad.said).toMatch(/^The arguments are not valid\./);

    vi.setSystemTime(DUE + 30_000 + MAC_RUN_STUCK_MS + 60_000);
    await due(t, token);
    const finance = await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "finance" });
    expect(finance.runs[0]).toMatchObject({ status: "timeout", errorClass: "timeout", runner: "mac" });
  });
});

describe("through the app's own address", () => {
  // In production the runner calls https://os.example.com/mcp/v1, which the app
  // passes on to the deployment (src/lib/os/pass-through.ts): the agent and
  // the run must reach the endpoint that way too, or no list would hold.
  const ORIGIN = "https://made-up-animal-123.convex.site";
  const viaApp = (t: TestBackend, token: string, name: string, args: unknown, headers: Record<string, string>) =>
    forward(
      new Request("https://os.example.test/mcp/v1", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      "/mcp/v1",
      {
        origin: ORIGIN,
        fetch: ((url: string | URL | Request, init?: RequestInit) =>
          t.fetch(String(url).slice(ORIGIN.length), init)) as unknown as typeof fetch,
      },
    ).then(async (response) => (await response.json()) as { result: { isError: boolean; content: { text: string }[] } });

  test("a run's call is held to its agent's tools and written down with its run", async () => {
    const { t, token } = await setUp();
    vi.setSystemTime(DUE + 30_000);
    const engineering = (await dueStarted(t, token)).runs.find((run) => run.agentId === "engineering")!;
    const headers = as("engineering", engineering.runId);
    expect((await viaApp(t, token, "pull_requests", {}, headers)).result.isError).toBe(false);
    const refused = await viaApp(t, token, "deals", {}, headers);
    expect(refused.result).toMatchObject({ isError: true, content: [{ text: OS_AGENT_WORDS.notAllowedTool("engineering") }] });
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.filter((row) => row.runId === engineering.runId).map((row) => [row.tool, row.outcome])).toEqual([
      ["pull_requests", "ok"],
      ["deals", "refused"],
    ]);
  });
});
