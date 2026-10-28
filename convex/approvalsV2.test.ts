import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY, NOW, addSam, answer, call, ownerWithToken, seed } from "./mcp.kit";
import { PROPOSAL_EXPIRES_DAYS, PROPOSAL_WORDS } from "./lib/agents";
import { approveProposal } from "./lib/proposals";
import { ownerMember } from "./lib/agentStore";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Approvals v2 (docs/assistant.md, "Approvals"): every proposal carries a
// `why`, a server-worked `effect`, an urgency, and optionally the goal it
// serves and its evidence; a rejection needs a reason; an expired proposal
// blocks its key like a rejection; and `proposals_feedback` tells each bot
// what became of its own. Every title and name is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  await addSam(t);
  const goal = (await t.run((ctx) => ctx.db.query("goals").first()))!._id;
  return { t, ids, owner, token, goal };
}
type World = Awaited<ReturnType<typeof world>>;

let made = 0;
const key = (kind: string, agent = "chief_of_staff") => `${agent}:${kind}:v2-${(made += 1)}`;
const proposals = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());

const taskCreate = (w: World, extra: Record<string, unknown> = {}) =>
  call(w.t, w.token, "propose", {
    agent: "chief_of_staff",
    company: "us",
    kind: "task_create",
    dedupeKey: key("task_create"),
    // A title of its own each time: the same title twice is a near-duplicate (Bot Loop v3).
    payload: { title: `Made-up task ${made}`, assignee: "sam.teammate@gmail.com", column: "this_week" },
    ...extra,
  });

const idOf = (reply: Awaited<ReturnType<typeof call>>) => (reply.output as { id: Id<"proposals"> }).id;

describe("a proposal must say why", () => {
  test("propose, goal_create and goal_update without `why` are refused and store nothing", async () => {
    const w = await world();
    expect((await taskCreate(w)).said).toBe(PROPOSAL_WORDS.why);
    expect((await taskCreate(w, { why: "   " })).said).toBe(PROPOSAL_WORDS.why);
    const goal = { agent: "chief_of_staff", company: "us" };
    expect((await call(w.t, w.token, "goal_create", { ...goal, quarter: "2026-Q4", title: "Made-up" })).said).toBe(
      PROPOSAL_WORDS.why,
    );
    expect((await call(w.t, w.token, "goal_update", { ...goal, goalId: w.goal, status: "at_risk" })).said).toBe(
      PROPOSAL_WORDS.why,
    );
    expect(await proposals(w.t)).toEqual([]);
  });

  test("`why` is stored as the card's reason; the old `reason` is still read; urgency defaults to normal", async () => {
    const w = await world();
    const one = await taskCreate(w, { why: "Made-up why." });
    const two = await taskCreate(w, { reason: "Made-up reason.", urgency: "critical" });
    const rows = await proposals(w.t);
    expect(rows.find((row) => row._id === idOf(one))).toMatchObject({ reason: "Made-up why.", urgency: "normal" });
    expect(rows.find((row) => row._id === idOf(two))).toMatchObject({ reason: "Made-up reason.", urgency: "critical" });
    expect((await taskCreate(w, { why: "x", urgency: "urgent" })).isError).toBe(true);
  });
});

describe("the effect is the server's", () => {
  test("a proposer cannot send one, at the top or in the payload", async () => {
    const w = await world();
    expect((await taskCreate(w, { why: "x", effect: "Nothing at all" })).isError).toBe(true);
    const inPayload = await taskCreate(w, { why: "x", payload: { title: "Made-up", effect: "Nothing" } });
    expect(inPayload.isError).toBe(true);
    expect(await proposals(w.t)).toEqual([]);
  });

  test("the inbox shows before → after for a change, every field for something new, the full text of a draft", async () => {
    const w = await world();
    const created = idOf(await taskCreate(w, { why: "x" }));
    const changed = idOf(
      await call(w.t, w.token, "propose", {
        agent: "engineering",
        company: "us",
        kind: "deal_next_step",
        why: "x",
        dedupeKey: key("deal", "engineering"),
        payload: { dealId: w.ids.usDeal, nextStep: "Made-up next step" },
      }),
    );
    const draft = idOf(
      await call(w.t, w.token, "propose", {
        agent: "sales",
        company: "us",
        kind: "draft",
        why: "x",
        dedupeKey: key("draft", "sales"),
        payload: { title: "Made-up draft", body: "Line one\nLine two" },
      }),
    );
    const rows = await w.owner.query(api.assistant.inbox, { company: "us" });
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(created)).toMatchObject({
      why: "x",
      urgency: "normal",
      goal: null,
      evidence: null,
      effect: {
        changes: [
          { field: "Title", before: null, after: expect.stringMatching(/^Made-up task \d+$/) },
          { field: "Assignee", before: null, after: "Sam Teammate" },
          { field: "Column", before: null, after: "This week" },
        ],
        text: null,
      },
    });
    expect(row(changed)).toMatchObject({
      effect: { changes: [{ field: "Next step", after: "Made-up next step" }], text: null },
    });
    expect(row(draft)).toMatchObject({
      effect: { changes: [], text: { title: "Made-up draft", body: "Line one\nLine two" } },
    });
  });
});

describe("the goal it serves and its evidence are checked", () => {
  test("a goal of this company or both is kept and shown with its status and cash tag; any other is refused", async () => {
    const w = await world();
    await w.owner.mutation(api.goals.update, { id: w.goal, cash: true, status: "at_risk" });
    const kzGoal = await w.t.run((ctx) =>
      ctx.db.insert("goals", { quarter: "2026-Q4", title: "KZ", status: "on_track", order: 9, company: "kz" }),
    );
    expect((await taskCreate(w, { why: "x", goalId: kzGoal })).said).toBe(PROPOSAL_WORDS.goalLink);
    expect((await taskCreate(w, { why: "x", goalId: "not-a-goal" })).said).toBe(PROPOSAL_WORDS.goalLink);
    const id = idOf(await taskCreate(w, { why: "x", goalId: w.goal }));
    const row = (await w.owner.query(api.assistant.inbox, { company: "us" })).find((r) => r.id === id)!;
    expect(row.goal).toEqual({ id: w.goal, title: "Example goal", status: "at_risk", cash: true });
  });

  test("a source must exist for that company; a good one links to its page", async () => {
    const w = await world();
    expect((await taskCreate(w, { why: "x", source: { kind: "deal", id: w.ids.kzDeal } })).said).toBe(
      PROPOSAL_WORDS.sourceGone,
    );
    expect((await taskCreate(w, { why: "x", source: { kind: "task", id: w.ids.kzTask } })).said).toBe(
      PROPOSAL_WORDS.sourceGone,
    );
    expect((await taskCreate(w, { why: "x", source: { kind: "metric", id: "made_up_metric" } })).said).toBe(
      PROPOSAL_WORDS.sourceGone,
    );
    expect((await taskCreate(w, { why: "x", source: { kind: "email", id: "x" } })).isError).toBe(true);
    const id = idOf(await taskCreate(w, { why: "x", source: { kind: "deal", id: w.ids.usDeal } }));
    const row = (await w.owner.query(api.assistant.inbox, { company: "us" })).find((r) => r.id === id)!;
    expect(row.evidence).toMatchObject({ kind: "deal", id: w.ids.usDeal, href: "/sales" });
    expect(typeof row.evidence!.label).toBe("string");
  });

  test("goal_update serves the goal it changes; goal_create takes urgency", async () => {
    const w = await world();
    const update = idOf(
      await call(w.t, w.token, "goal_update", {
        agent: "chief_of_staff",
        company: "us",
        goalId: w.goal,
        status: "at_risk",
        why: "x",
        urgency: "high",
      }),
    );
    expect((await w.t.run((ctx) => ctx.db.get(update)))!).toMatchObject({ goalId: w.goal, urgency: "high" });
  });
});

describe("a rejection needs a reason", () => {
  test("neither code nor words is refused; a code, words or both are stored", async () => {
    const w = await world();
    const a = idOf(await taskCreate(w, { why: "x" }));
    const b = idOf(await taskCreate(w, { why: "x" }));
    const c = idOf(await taskCreate(w, { why: "x" }));
    await expect(w.owner.mutation(api.assistant.dismiss, { id: a })).rejects.toThrow(PROPOSAL_WORDS.rejectReason);
    await expect(w.owner.mutation(api.assistant.dismiss, { id: a, reason: "   " })).rejects.toThrow(
      PROPOSAL_WORDS.rejectReason,
    );
    await w.owner.mutation(api.assistant.dismiss, { id: a, code: "wrong_timing" });
    await w.owner.mutation(api.assistant.dismiss, { id: b, reason: "  Made-up words  " });
    await w.owner.mutation(api.assistant.dismiss, { id: c, code: "rewrite_tone", reason: "Too formal" });
    const rows = await proposals(w.t);
    const get = (id: string) => rows.find((row) => row._id === id)!;
    expect(get(a)).toMatchObject({ status: "dismissed", rejectCode: "wrong_timing" });
    expect(get(a).rejectReason).toBeUndefined();
    expect(get(b)).toMatchObject({ rejectReason: "Made-up words" });
    expect(get(c)).toMatchObject({ rejectCode: "rewrite_tone", rejectReason: "Too formal" });
  });
});

describe("expiry", () => {
  test("the daily sweep expires an open proposal after a week; feedback says expired; the key is blocked like a rejection", async () => {
    const w = await world();
    const dedupeKey = key("task_create");
    const id = idOf(await taskCreate(w, { why: "x", dedupeKey }));
    vi.setSystemTime(NOW + (PROPOSAL_EXPIRES_DAYS + 1) * DAY);
    await w.t.mutation(internal.assistant.sweep, {});
    expect((await w.t.run((ctx) => ctx.db.get(id)))!.status).toBe("expired");
    const fed = (await answer(w.t, w.token, "proposals_feedback")).rows as Record<string, unknown>[];
    expect(fed[0]).toMatchObject({ decision: "expired", status: "expired", decisionMs: (PROPOSAL_EXPIRES_DAYS + 1) * DAY });
    expect((await taskCreate(w, { why: "x", dedupeKey })).said).toBe(PROPOSAL_WORDS.repeatExpired);
  });
});

describe("proposals_feedback", () => {
  test("decision, reject code and reason, edits, time to decision, urgency and goal", async () => {
    const w = await world();
    const edited = idOf(await taskCreate(w, { why: "x", urgency: "high", goalId: w.goal }));
    const rejected = idOf(await taskCreate(w, { why: "x" }));
    vi.setSystemTime(NOW + 3_600_000);
    await w.owner.mutation(api.assistant.approve, {
      id: edited,
      edit: { title: "Made-up task, sharper", assignee: "sam.teammate@gmail.com", column: "this_week" },
    });
    await w.owner.mutation(api.assistant.dismiss, { id: rejected, code: "not_a_priority", reason: "Later" });
    const rows = (await answer(w.t, w.token, "proposals_feedback")).rows as Record<string, unknown>[];
    const approved = rows.find((row) => row.decision === "approved")!;
    expect(approved).toMatchObject({
      decisionMs: 3_600_000,
      urgency: "high",
      goal: { id: w.goal, title: "Example goal" },
      edited: true,
      edits: [{ field: "title", before: expect.stringMatching(/^Made-up task \d+$/), after: "Made-up task, sharper" }],
      rejectCode: null,
      rejectReason: null,
    });
    expect(rows.find((row) => row.decision === "rejected")).toMatchObject({
      rejectCode: "not_a_priority",
      rejectReason: "Later",
      edits: [],
      urgency: "normal",
      goal: null,
      rejection: { kind: "task_create", code: "not_a_priority", reason: "Later" },
    });
  });

  test("a bot reads its own rows only, whatever its areas", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    const mine = idOf(
      await call(w.t, w.token, "goal_create", {
        bot: "strategy_advisor",
        company: "us",
        quarter: "2026-Q4",
        title: "Made-up bot goal",
        why: "x",
      }),
    );
    const theirs = idOf(await taskCreate(w, { why: "x" }));
    await w.owner.mutation(api.assistant.dismiss, { id: mine, code: "wrong_data" });
    await w.owner.mutation(api.assistant.dismiss, { id: theirs, code: "wrong_timing" });
    const bot = await call(w.t, w.token, "proposals_feedback", { bot: "strategy_advisor" });
    expect(bot.said).toBeNull();
    const rows = bot.output.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bot: "strategy_advisor", rejectCode: "wrong_data" });
    // The owner's own Claude (and the four agents) read every proposer's.
    expect(((await answer(w.t, w.token, "proposals_feedback")).rows as unknown[]).length).toBe(2);
  });
});

describe("the approve path the autonomy work calls", () => {
  test("approveProposal with decision auto_approved runs the same path and is fed back as auto_approved", async () => {
    const w = await world();
    const id = idOf(await taskCreate(w, { why: "x" }));
    const result = await w.t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      const owner = users.find((user) => user.email === OWNER)!;
      return approveProposal(ctx, ownerMember(owner), id, { now: NOW, decision: "auto_approved" });
    });
    expect(result).toHaveProperty("taskId");
    const task = await w.t.run((ctx) => ctx.db.get((result as { taskId: Id<"tasks"> }).taskId));
    expect(task).toMatchObject({ title: expect.stringMatching(/^Made-up task/), origin: { source: "agent", agent: "chief_of_staff" } });
    const rows = (await answer(w.t, w.token, "proposals_feedback")).rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ decision: "auto_approved", edits: [], edited: false });
  });
});

describe("goals carry a cash tag and the Bots tab a week's stats", () => {
  test("goals.update sets cash; goals.list returns it", async () => {
    const w = await world();
    await w.owner.mutation(api.goals.update, { id: w.goal, cash: true });
    const list = await w.owner.query(api.goals.list, { quarter: "2026-Q4", company: "us" });
    expect(list.find((goal) => goal.id === w.goal)).toMatchObject({ cash: true });
    await w.owner.mutation(api.goals.update, { id: w.goal, cash: false });
    expect((await w.owner.query(api.goals.list, { quarter: "2026-Q4", company: "us" }))[0]).toMatchObject({ cash: false });
  });

  test("bots.weeklyStats: approval rate, median decision time and top reject reasons, per proposer", async () => {
    const w = await world();
    const ids = [];
    for (let n = 0; n < 4; n++) ids.push(idOf(await taskCreate(w, { why: "x" })));
    vi.setSystemTime(NOW + 1_000);
    await w.owner.mutation(api.assistant.approve, { id: ids[0]! });
    vi.setSystemTime(NOW + 3_000);
    await w.owner.mutation(api.assistant.dismiss, { id: ids[1]!, code: "wrong_data" });
    await w.owner.mutation(api.assistant.dismiss, { id: ids[2]!, code: "wrong_data" });
    await w.owner.mutation(api.assistant.dismiss, { id: ids[3]!, reason: "Made-up words" });
    const stats = await w.owner.query(api.bots.weeklyStats, { since: NOW - 7 * DAY });
    expect(stats).toEqual([
      {
        key: "chief_of_staff",
        bot: null,
        agent: "chief_of_staff",
        decided: 4,
        approved: 1,
        rejected: 3,
        expired: 0,
        withdrawn: 0,
        approvalRate: 0.25,
        medianDecisionMs: 3_000,
        topRejectReasons: [
          { code: "wrong_data", count: 2 },
          { code: "typed", count: 1 },
        ],
      },
    ]);
    // Nothing decided before `since` is counted.
    expect(await w.owner.query(api.bots.weeklyStats, { since: NOW + 10_000 })).toEqual([]);
  });
});
