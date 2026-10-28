import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DECIDE_WORDS, PROPOSAL_WORDS } from "./lib/agents";
import { BOT_WORDS } from "./lib/botRules";
import { AGENT_HEADER, OS_AGENT_WORDS } from "./lib/osAgents";
import { ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// The chief of staff approves or dismisses for the owner (docs/assistant.md,
// "Deciding a proposal"). Made-up titles throughout. The button and the tool
// share approveProposal and dismiss.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
  await owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
  return { t, owner, mac, grok: grok.token };
}

const tasksOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const rowOf = (t: TestBackend, id: string) => t.run((ctx) => ctx.db.get(id as Id<"proposals">));

const proposal = (agent: string, dedupeKey: string, title: string, extra: Record<string, unknown> = {}) => ({
  agent,
  company: "us",
  kind: "task_create",
  why: "Made-up why.",
  dedupeKey,
  payload: { title },
  ...extra,
});

async function made(t: TestBackend, token: string, args: Record<string, unknown>): Promise<string> {
  const reply = await call(t, token, "propose", args);
  if (reply.output === null) throw new Error(`propose did not answer: ${reply.text}`);
  return reply.output.id as string;
}

async function atAddress(t: TestBackend, bot: string, token: string, name: string, args: unknown = {}) {
  const response = await t.fetch(`/mcp/v1/bot/${bot}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await response.json()) as {
    result?: { isError: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
  };
  return body.result!;
}

/** The card the two paths must agree on. Order and ids are assigned as each card is made. */
function cardOf(task: Doc<"tasks">) {
  return {
    title: task.title,
    company: task.company,
    column: task.column,
    notes: task.notes ?? null,
    assignee: task.assignee ?? null,
    due: task.due ?? null,
    origin: task.origin ?? null,
    createdBy: task.createdBy ?? null,
  };
}

describe("who may decide", () => {
  test("a bot that is not the chief of staff is refused, and naming chief_of_staff does not override that", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));

    const growth = await call(t, grok, "proposal_decide", { agent: "growth", ids: [id], decision: "approve" });
    expect(growth.isError).toBe(true);
    expect(growth.said).toBe(DECIDE_WORDS.notChief);
    expect(growth.refusal).toEqual({ code: "not_chief_of_staff" });
    expect((await rowOf(t, id))!.status).toBe("open");
    expect(await tasksOf(t)).toEqual([]);

    // A header that authenticated growth, and a body that names the chief of staff: the endpoint refuses the mismatch.
    const mismatch = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [id], decision: "approve" }, { [AGENT_HEADER]: "growth" });
    expect(mismatch.said).toBe(BOT_WORDS.wrongAgent);
    expect((await rowOf(t, id))!.status).toBe("open");

    const engineering = await call(t, grok, "proposal_decide", { agent: "engineering", ids: [id], decision: "dismiss", reason: "Made-up: not now." });
    expect(engineering.said).toBe(DECIDE_WORDS.notChief);
    expect(engineering.refusal).toEqual({ code: "not_chief_of_staff" });
    expect((await rowOf(t, id))!.status).toBe("open");
  });

  test("the Mac's sales agent is refused the tool, and a call that names nobody is not the chief of staff", async () => {
    const { t, mac, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));

    const sales = await call(t, mac, "proposal_decide", { agent: "sales", ids: [id], decision: "approve" });
    expect(sales.said).toBe(OS_AGENT_WORDS.notAllowedTool("sales"));
    expect((await rowOf(t, id))!.status).toBe("open");

    // The runner, naming no agent: the tool runs and refuses. A missing name is not permission.
    const unnamed = await call(t, mac, "proposal_decide", { ids: [id], decision: "approve" });
    expect(unnamed.said).toBe(DECIDE_WORDS.notChief);
    expect(unnamed.refusal).toEqual({ code: "not_chief_of_staff" });
    expect(await tasksOf(t)).toEqual([]);
  });
});

describe("approve", () => {
  test("creates the same task the Approve button does", async () => {
    const { t, owner, grok } = await setUp();
    const byButton = await made(t, grok, proposal("growth", "growth:task_create:button", "Made-up button title"));
    const byTool = await made(t, grok, proposal("growth", "growth:task_create:tool", "Made-up tool title"));

    await owner.mutation(api.assistant.approve, { id: byButton as Id<"proposals"> });
    const decided = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [byTool], decision: "approve" });
    expect(decided.output).toMatchObject({ decided: 1 });
    expect(decided.output.results[0]).toMatchObject({
      id: byTool,
      ok: true,
      already: false,
      status: "approved",
      decision: "approved",
      decidedBy: "owner",
      via: "chief_of_staff",
    });

    const tasks = await tasksOf(t);
    expect(tasks).toHaveLength(2);
    const buttonTask = tasks.find((task) => task.title === "Made-up button title")!;
    const toolTask = tasks.find((task) => task.title === "Made-up tool title")!;
    expect(cardOf(toolTask)).toEqual({ ...cardOf(buttonTask), title: "Made-up tool title" });
    expect(decided.output.results[0].createdId).toBe(toolTask._id);
    expect(await rowOf(t, byTool)).toMatchObject({ decidedBy: "owner", decidedVia: "chief_of_staff" });
    expect((await rowOf(t, byButton))!.decidedBy).toBeUndefined();
  });

  test("an edited payload changes the same fields the button's edit does", async () => {
    const { t, owner, grok } = await setUp();
    const byButton = await made(t, grok, proposal("growth", "growth:task_create:button", "Made-up button title"));
    const byTool = await made(t, grok, proposal("growth", "growth:task_create:tool", "Made-up tool title"));
    await owner.mutation(api.assistant.approve, { id: byButton as Id<"proposals">, edit: { title: "Made-up button edited" } });
    const decided = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [byTool],
      decision: "approve",
      reason: "  Made-up: clearer title  ",
      editedPayload: { title: "Made-up tool edited" },
    });
    expect(decided.output.results[0].edits).toEqual([{ field: "title", before: "Made-up tool title", after: "Made-up tool edited" }]);
    const tasks = await tasksOf(t);
    const buttonTask = tasks.find((task) => task.title === "Made-up button edited")!;
    const toolTask = tasks.find((task) => task.title === "Made-up tool edited")!;
    expect(cardOf(toolTask)).toEqual({ ...cardOf(buttonTask), title: "Made-up tool edited" });
    expect(await rowOf(t, byTool)).toMatchObject({
      editedBeforeApprove: true,
      decisionReason: "Made-up: clearer title",
      decidedBy: "owner",
      decidedVia: "chief_of_staff",
    });
  });

  test("approving the same proposal twice creates one task", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const first = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [id], decision: "approve" });
    const createdId = first.output.results[0].createdId as string;
    expect(await tasksOf(t)).toHaveLength(1);

    const second = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [id], decision: "approve" });
    expect(second.output).toMatchObject({ decided: 0 });
    expect(second.output.results[0]).toMatchObject({ id, ok: true, already: true, status: "approved", createdId });
    expect(await tasksOf(t)).toHaveLength(1);

    // The same id twice in one call: the second sees it already decided.
    const other = await made(t, grok, proposal("growth", "growth:task_create:two", "Made-up onboarding email"));
    const batch = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [other, other], decision: "approve" });
    expect(batch.output.results.map((item: { already: boolean }) => item.already)).toEqual([false, true]);
    expect(batch.output.results[0].createdId).toBe(batch.output.results[1].createdId);
    expect(await tasksOf(t)).toHaveLength(2);
  });

  test("a draft is kept as text and nothing is sent", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:draft:outside", "Made-up note", { kind: "draft", payload: { title: "Made-up note", body: "Made-up text the owner sends himself." } }));
    const before = (await tasksOf(t)).length;
    const decided = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [id], decision: "approve" });
    expect(decided.output.results[0]).toMatchObject({ ok: true, status: "approved", createdId: null });
    expect((await rowOf(t, id))!.result).toEqual({ kept: true });
    expect(await tasksOf(t)).toHaveLength(before);
  });

  test("the chief of staff's own address needs no agent argument", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const result = await atAddress(t, "chief_of_staff", grok, "proposal_decide", { ids: [id], decision: "approve" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ decided: 1 });
    expect(await tasksOf(t)).toHaveLength(1);
  });
});

describe("dismiss", () => {
  test("is logged as the owner's decision through the chief of staff", async () => {
    const { t, mac, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const decided = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [id],
      decision: "dismiss",
      reason: "Made-up: already covered.",
    });
    expect(decided.output.results[0]).toMatchObject({
      id,
      ok: true,
      already: false,
      status: "dismissed",
      decision: "rejected",
      decidedBy: "owner",
      via: "chief_of_staff",
      reason: "Made-up: already covered.",
      createdId: null,
    });
    expect(await rowOf(t, id)).toMatchObject({
      status: "dismissed",
      rejectReason: "Made-up: already covered.",
      decidedBy: "owner",
      decidedVia: "chief_of_staff",
    });
    expect((await rowOf(t, id))!.decisionReason).toBeUndefined();
    expect(await tasksOf(t)).toEqual([]);

    const asOwner = (await call(t, mac, "proposals_feedback")).output.rows as Record<string, unknown>[];
    expect(asOwner.find((row) => row.dedupeKey === "growth:task_create:one")).toMatchObject({
      decision: "rejected",
      decidedBy: "owner",
      via: "chief_of_staff",
      rejectReason: "Made-up: already covered.",
      decisionReason: null,
    });
    const asGrowth = (await call(t, grok, "proposals_feedback", { agent: "growth" })).output.rows as Record<string, unknown>[];
    expect(asGrowth).toHaveLength(1);
    expect(asGrowth[0]).toMatchObject({ decidedBy: "owner", via: "chief_of_staff", decision: "rejected" });
  });

  test("a batch answers each id, and one already decided is left as it is", async () => {
    const { t, owner, grok } = await setUp();
    const open = await made(t, grok, proposal("growth", "growth:task_create:open", "Made-up open card"));
    const approved = await made(t, grok, proposal("growth", "growth:task_create:done", "Made-up done card"));
    await owner.mutation(api.assistant.approve, { id: approved as Id<"proposals"> });
    const tasksBefore = (await tasksOf(t)).length;

    const reply = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [open, "not-a-proposal", approved],
      decision: "dismiss",
      reason: "Made-up: not this week.",
    });
    expect(reply.output).toMatchObject({
      decided: 1,
      results: [
        { id: open, ok: true, already: false, status: "dismissed" },
        { id: "not-a-proposal", ok: false, error: PROPOSAL_WORDS.gone },
        { id: approved, ok: true, already: true, status: "approved" },
      ],
    });
    expect((await rowOf(t, approved))!.status).toBe("approved");
    expect((await rowOf(t, approved))!.decidedBy).toBeUndefined();
    expect(await tasksOf(t)).toHaveLength(tasksBefore);
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.filter((row) => row.tool === "proposal_decide")).toHaveLength(1);
  });

  test("a dismissal with no reason changes nothing, and an edit is refused before any write", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const quiet = await call(t, grok, "proposal_decide", { agent: "chief_of_staff", ids: [id], decision: "dismiss" });
    expect(quiet.output.results[0]).toMatchObject({ ok: false, status: "open", error: PROPOSAL_WORDS.rejectReason });
    expect((await rowOf(t, id))!.status).toBe("open");

    const edited = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [id],
      decision: "dismiss",
      reason: "Made-up: no.",
      editedPayload: { title: "Made-up other title" },
    });
    expect(edited.said).toBe(DECIDE_WORDS.editOnDismiss);
    expect((await rowOf(t, id))!.status).toBe("open");

    const second = await made(t, grok, proposal("growth", "growth:task_create:two", "Made-up second card"));
    const many = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [id, second],
      decision: "approve",
      editedPayload: { title: "Made-up one edit" },
    });
    expect(many.said).toBe(DECIDE_WORDS.editOne);
    expect((await rowOf(t, id))!.status).toBe("open");
    expect((await rowOf(t, second))!.status).toBe("open");
    expect(await tasksOf(t)).toEqual([]);
  });
});
