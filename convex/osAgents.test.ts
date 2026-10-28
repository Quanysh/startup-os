import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { GATE_WORDS } from "./lib/agentJobs";
import { STARTUP_OS_PROJECT } from "./lib/agentStartupOs";
import { AGENT_IDS, AGENT_NAMES, type AgentId } from "./lib/agents";
import { setAgent as switchAgent } from "./lib/agentStore";
import { osAgentInstructions } from "./lib/osAgentDefaults";
import { SEEDED_REASON } from "./lib/osAgentRuns";
import { OS_AGENT_DEFAULT_CRON, OS_AGENT_TOOLS, OS_AGENT_WORDS } from "./lib/osAgents";
import { NOT_ALLOWED } from "./lib/owner";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas, type TestBackend } from "./test.setup";

// Startup OS's own four agents, seeded as agents of `startup-os` from their
// code's defaults (docs/agents/), managed on /agents by the owner alone, each
// run by one runner: the Mac (Claude) by default, or Startup OS's own runtime
// (Gemini) where the owner moves it. Every argument and answer is made up;
// the model is a fake fetch, so no test reaches a provider.

/** A day, an hour before the four's default time (06:20 UTC). */
const NOW = Date.parse("2026-10-18T05:20:00Z");
const DUE = Date.parse("2026-10-18T06:20:00Z");
const TODAY = "2026-10-18";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("GOOGLE_GENAI_API_KEY", "made-up-not-a-key");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const finish = (t: TestBackend) => t.finishAllScheduledFunctions(vi.runAllTimers);

/** A fake Gemini that says one thing and calls no tool. */
function gemini() {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "Made-up answer." }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        }),
        { status: 200 },
      );
    }),
  );
  return seen;
}

async function seeded(t: TestBackend) {
  const owner = await signInAsOwner(t);
  await t.mutation(internal.osAgents.seed, {});
  return owner;
}

type Table = "agentDeclared" | "agentHarnessVersions" | "agentControls" | "agentHarnessEvents" | "agentRuntimeRuns" | "agentControlChanges";
const rowsOf = <T extends Table>(t: TestBackend, table: T) => t.run((ctx) => ctx.db.query(table).collect());

describe("seeding the four", () => {
  test("nothing is seeded before an owner has signed in", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.osAgents.seed, {})).toEqual({ seeded: [] });
    expect(await rowsOf(t, "agentDeclared")).toEqual([]);
  });

  test("each is built here with h1 published from its code's defaults, on the Mac, with its switch as the Assistant has it", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    // A switch thrown before the four were built here (the Assistant's switch now seeds them first).
    await t.run((ctx) => switchAgent(ctx, "sales", false, Date.now()));
    expect(await t.mutation(internal.osAgents.seed, {})).toEqual({ seeded: [...AGENT_IDS] });

    const declared = await rowsOf(t, "agentDeclared");
    expect(declared.map((row) => [row.project, row.agentId]).sort()).toEqual(AGENT_IDS.map((id) => [STARTUP_OS_PROJECT, id]).sort());
    for (const agent of AGENT_IDS) {
      const view = await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: agent });
      expect(view.built).toBe(true);
      expect(view.published).toMatchObject({ name: "h1", status: "published" });
      expect(view.published!.parts.prompt!.variants.default!.system).toBe(osAgentInstructions(agent));
      expect(view.published!.parts.tools).toEqual([...OS_AGENT_TOOLS[agent]]);
      expect(view.published!.definition).toMatchObject({
        name: AGENT_NAMES[agent],
        triggers: { schedule: { cron: OS_AGENT_DEFAULT_CRON, variables: {} } },
      });
      // Its runs and answers are the owner's: it proposes, a tool of the owner's own.
      expect(view.ownerOnly).toBe(true);
      expect(view.events[0]).toMatchObject({ name: "h1", action: "publish", overrideReason: SEEDED_REASON });
    }
    const controls = await rowsOf(t, "agentControls");
    expect(controls).toHaveLength(4);
    for (const control of controls) {
      expect(control).toMatchObject({ project: STARTUP_OS_PROJECT, runsOn: "claude_mac", harnessVersion: "h1" });
      expect(control.enabled).toBe(control.agentId !== "sales");
    }
  });

  test("seeding again changes nothing, and the owner's own version is kept", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "finance", from: "published" });
    await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: the owner's own change." });
    expect(await t.mutation(internal.osAgents.seed, {})).toEqual({ seeded: [] });
    expect((await rowsOf(t, "agentDeclared")).length).toBe(4);
    const view = await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "finance" });
    expect(view.published!.name).toBe("h2");
  });

  test("the runtime's tick seeds them once an owner has signed in", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agentRuntime.tick, {});
    expect(await rowsOf(t, "agentDeclared")).toEqual([]);
    await signInAsOwner(t);
    await t.mutation(internal.agentRuntime.tick, {});
    expect((await rowsOf(t, "agentDeclared")).length).toBe(4);
  });

  test("no agent may be created under one of their ids in Startup OS", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.agentBuilder.create, {
        project: STARTUP_OS_PROJECT,
        agentId: "sales",
        name: "Made-up helper",
        description: "Does a made-up thing.",
        mode: "text",
      }),
    ).rejects.toThrow(OS_AGENT_WORDS.reserved);
  });
});

describe("the owner's alone", () => {
  test("Startup OS applies its own changes as they are made: none of its agents or changes reads as pending", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const rows = (await owner.query(api.agentControl.overview, { today: TODAY, project: STARTUP_OS_PROJECT })).agents;
    expect(rows.filter((row) => row.osAgent).length).toBe(AGENT_IDS.length);
    expect(rows.filter((row) => row.pending)).toEqual([]);
    const changes = await owner.query(api.agentControl.changes, { project: STARTUP_OS_PROJECT });
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.filter((change) => change.status !== "applied")).toEqual([]);
  });

  test("a teammate with Agents and Engineering is not shown them and cannot change, test or publish one", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const engineer = await signInWithAreas(t, "engineer", ["agents", "engineering"]);
    const mine = await owner.query(api.agentControl.overview, { today: TODAY, project: STARTUP_OS_PROJECT });
    expect(mine.agents.filter((row) => row.osAgent).map((row) => row.agentId).sort()).toEqual([...AGENT_IDS].sort());
    const theirs = await engineer.query(api.agentControl.overview, { today: TODAY, project: STARTUP_OS_PROJECT });
    expect(theirs.agents.filter((row) => row.osAgent)).toEqual([]);
    expect((await engineer.query(api.agentControl.overview, { today: TODAY })).agents.some((row) => row.osAgent)).toBe(false);
    expect(await engineer.query(api.agentControl.changes, { project: STARTUP_OS_PROJECT })).toEqual([]);

    const where = { project: STARTUP_OS_PROJECT, agentId: "engineering" };
    await expect(engineer.query(api.agentHarness.harness, where)).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.query(api.agentControl.agent, { ...where, today: TODAY })).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.query(api.agentBuilder.runs, where)).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.mutation(api.agentHarness.newDraft, { ...where, from: "published" })).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.mutation(api.agentControl.change, { ...where, enabled: false })).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.mutation(api.agentControl.change, { ...where, runsOn: "gemini" })).rejects.toThrow(NOT_ALLOWED);

    const { id } = await owner.mutation(api.agentHarness.newDraft, { ...where, from: "published" });
    await expect(engineer.mutation(api.agentHarness.publish, { id })).rejects.toThrow(NOT_ALLOWED);
    await expect(engineer.mutation(api.agentHarness.discardDraft, { id })).rejects.toThrow(NOT_ALLOWED);
  });
});

describe("one switch", () => {
  test("the switch on /agents is the Assistant's: thrown on either, both say the same", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "engineering", enabled: false });
    const listed = await owner.query(api.assistant.agents, {});
    expect(listed.find((agent) => agent.id === "engineering")!.on).toBe(false);

    await owner.mutation(api.assistant.setAgent, { agent: "engineering", on: true });
    const rows = await owner.query(api.agentControl.overview, { today: TODAY, project: STARTUP_OS_PROJECT });
    expect(rows.agents.find((row) => row.agentId === "engineering")!.enabled).toBe(true);

    // A write by an agent switched off on /agents is refused, as one switched off on the Assistant always was.
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "sales", enabled: false });
    const off = await t.run((ctx) => ctx.db.query("agentSettings").first());
    expect(off!.off).toEqual(["sales"]);
  });
});

describe("every flip is recorded", () => {
  test("the Assistant's switch writes a change, as the switch on /agents does: before and after, by whom", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const before = (await rowsOf(t, "agentControlChanges")).length;
    await owner.mutation(api.assistant.setAgent, { agent: "finance", on: false });
    await owner.mutation(api.assistant.setAgent, { agent: "finance", on: true });
    const changes = (await rowsOf(t, "agentControlChanges")).slice(before);
    expect(changes.map((row) => [row.agentId, row.before?.enabled, row.after.enabled])).toEqual([
      ["finance", true, false],
      ["finance", false, true],
    ]);
    // The same switch as before: what the agents read.
    expect((await owner.query(api.assistant.agents, {})).find((agent) => agent.id === "finance")!.on).toBe(true);
    // Throwing it to where it already is changes nothing and writes nothing.
    await owner.mutation(api.assistant.setAgent, { agent: "finance", on: true });
    expect((await rowsOf(t, "agentControlChanges")).length).toBe(before + 2);
  });

  test("before the four are seeded, the switch seeds them and records the flip", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.assistant.setAgent, { agent: "sales", on: false });
    const changes = (await rowsOf(t, "agentControlChanges")).filter((row) => row.agentId === "sales");
    expect(changes.at(-1)!.after.enabled).toBe(false);
    expect((await owner.query(api.assistant.agents, {})).find((agent) => agent.id === "sales")!.on).toBe(false);
  });
});

describe("where each runs", () => {
  test("moving one is a control change with its record, and only the four choose where they run", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const result = await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "sales", runsOn: "gemini" });
    expect(result.changed).toBe(true);
    const change = (await rowsOf(t, "agentControlChanges")).find((row) => row.agentId === "sales" && row.before !== null)!;
    expect(change.before).toMatchObject({ runsOn: "claude_mac" });
    expect(change.after).toMatchObject({ runsOn: "gemini" });
    const detail = await owner.query(api.agentControl.agent, { project: STARTUP_OS_PROJECT, agentId: "sales", today: TODAY });
    expect(detail).toMatchObject({ runsOn: "gemini", osAgent: true });
    // Publishing keeps where it runs.
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "sales", from: "published" });
    await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: a change." });
    expect((await rowsOf(t, "agentControls")).find((row) => row.agentId === "sales")!.runsOn).toBe("gemini");

    await expect(
      owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "nobody", runsOn: "gemini" }),
    ).rejects.toThrow(OS_AGENT_WORDS.notOsAgent);
  });

  test("Startup OS's schedule never starts one on the Mac, and starts one moved to Gemini at its time", async () => {
    const seen = gemini();
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "finance", runsOn: "gemini" });
    vi.setSystemTime(DUE + 20_000);
    await t.mutation(internal.agentRuntime.tick, {});
    await finish(t);
    const runs = await rowsOf(t, "agentRuntimeRuns");
    expect(runs.map((run) => run.agentId)).toEqual(["finance"]);
    expect(runs[0]).toMatchObject({ trigger: "schedule", scheduledFor: DUE, state: "done" });
    expect(seen).toHaveLength(1);
    const view = await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "finance" });
    expect(view.runs[0]).toMatchObject({ trigger: "schedule", status: "ok", version: "h1", runner: null, proposals: 0 });
  });

  test("Run now and a test run are refused for one on the Mac, in a sentence; publishing it needs the owner's override", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    await expect(owner.mutation(api.agentRuntime.runNow, { agentId: "engineering", variables: {} })).rejects.toThrow(
      OS_AGENT_WORDS.macRunNow,
    );
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "engineering", from: "published" });
    await expect(
      owner.mutation(api.agentHarness.startRun, {
        draftId: id,
        models: [{ provider: "ai_studio", model: "gemini-3.8-flash" }],
        caseIds: [],
      }),
    ).rejects.toThrow(OS_AGENT_WORDS.macTests);
    await expect(owner.mutation(api.agentHarness.publish, { id })).rejects.toThrow(GATE_WORDS.no_run);
    expect(await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: runs on the Mac." })).toMatchObject({
      version: "h2",
    });
  });

  test("one moved to Gemini is tested by Startup OS's runtime on made-up cases, and published past a passing run", async () => {
    gemini();
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "sales", runsOn: "gemini" });
    const { id } = await owner.mutation(api.agentHarness.newDraft, { project: STARTUP_OS_PROJECT, agentId: "sales", from: "published" });
    const { id: caseId } = await owner.mutation(api.agentHarness.saveCase, {
      project: STARTUP_OS_PROJECT,
      agentId: "sales",
      name: "Made-up quiet pipeline",
      variables: {},
      expect: [{ path: "$", op: "contains", value: '"Made-up"' }],
      madeUp: true,
    });
    await owner.mutation(api.agentHarness.startRun, {
      draftId: id,
      models: [{ provider: "ai_studio", model: "gemini-3.8-flash" }],
      caseIds: [caseId],
    });
    await finish(t);
    expect((await owner.query(api.agentHarness.harness, { project: STARTUP_OS_PROJECT, agentId: "sales" })).draft?.gate).toBe("passed");
    expect(await owner.mutation(api.agentHarness.publish, { id })).toMatchObject({ version: "h2" });
  });

  test("one moved to Gemini runs with Run now, as any agent built here", async () => {
    gemini();
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    await owner.mutation(api.agentControl.change, { project: STARTUP_OS_PROJECT, agentId: "engineering", runsOn: "gemini" });
    const { runId } = await owner.mutation(api.agentRuntime.runNow, { agentId: "engineering", variables: {} });
    await finish(t);
    const view = await owner.query(api.agentBuilder.runs, { project: STARTUP_OS_PROJECT, agentId: "engineering" });
    expect(view.runs[0]).toMatchObject({ runId, trigger: "api", status: "ok" });
  });
});

describe("on the Mac, nothing changes at once", () => {
  test("a tool that changes the board is refused at save and publish while it runs on the Mac, and moving it back with one is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await seeded(t);
    const where = { project: STARTUP_OS_PROJECT, agentId: "engineering" };
    const { id } = await owner.mutation(api.agentHarness.newDraft, { ...where, from: "published" });
    const draft = (await owner.query(api.agentHarness.harness, where)).draft!;
    const save = (revision: number) =>
      owner.mutation(api.agentBuilder.saveDefinition, {
        id,
        revision,
        definition: { ...draft.definition!, approvals: [...draft.definition!.approvals, "task_create"] },
        prompt: { variants: draft.parts.prompt!.variants },
        params: null,
        tools: [...draft.parts.tools!, "task_create"],
        outputSchema: null,
        note: "",
      });
    await expect(save(draft.revision)).rejects.toThrow(OS_AGENT_WORDS.macActTool);

    // On Gemini each call waits for the owner's approval: it is taken, and published.
    await owner.mutation(api.agentControl.change, { ...where, runsOn: "gemini" });
    const saved = await save(draft.revision);
    await owner.mutation(api.agentHarness.publish, { id, overrideReason: "Made-up: approved on Gemini." });
    expect(saved.changed).toBe(true);
    // Back to the Mac with it published: refused, in the same words.
    await expect(owner.mutation(api.agentControl.change, { ...where, runsOn: "claude_mac" })).rejects.toThrow(OS_AGENT_WORDS.macActTool);
    // A draft for the Mac with it, published past the rules: refused at publish too.
    await t.run(async (ctx) => {
      const control = (await ctx.db.query("agentControls").collect()).find((row) => row.agentId === "engineering")!;
      await ctx.db.patch(control._id, { runsOn: "claude_mac" });
    });
    const next = await owner.mutation(api.agentHarness.newDraft, { ...where, from: "published" });
    await expect(owner.mutation(api.agentHarness.publish, { id: next.id, overrideReason: "Made-up." })).rejects.toThrow(OS_AGENT_WORDS.macActTool);
    const view = await owner.query(api.agentHarness.harness, where);
    expect(view.draft!.problems).toContainEqual({ path: "tools", message: OS_AGENT_WORDS.macActTool });
  });
});

describe("a Gemini run of one of the four", () => {
  test("writes as itself only: a call naming another of the four is refused, however approved", async () => {
    const t = convexTest(schema, modules);
    await seeded(t);
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect())[0]!._id);
    const args = { agent: "sales" as AgentId, company: "us", kind: "draft", reason: "Made-up.", dedupeKey: "sales:draft:made-up", payload: { title: "Made-up", body: "Made-up." } };
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRuntimeRuns", {
        project: STARTUP_OS_PROJECT,
        runId: "os-made-up",
        agentId: "finance",
        versionNumber: 1,
        trigger: "api",
        state: "running",
        actAs: ownerId,
        input: "{}",
        createdAt: NOW,
        claimedAt: NOW,
      });
      await ctx.db.insert("agentApprovals", {
        project: STARTUP_OS_PROJECT,
        rootAgentId: "finance",
        rootRunId: "os-made-up",
        agentId: "finance",
        runId: "os-made-up",
        toolId: "propose",
        arguments: JSON.stringify(args),
        state: "approved",
        createdAt: NOW,
      });
    });
    const ran = await t.mutation(internal.agentRuntime.actTool, {
      rootRunId: "os-made-up",
      runId: "os-made-up",
      agentId: "finance",
      versionNumber: 1,
      toolId: "propose",
      input: JSON.stringify(args),
      now: NOW,
      today: TODAY,
    });
    expect(ran).toEqual({ status: "error", message: OS_AGENT_WORDS.wrongAgent });
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toEqual([]);
  });
});
