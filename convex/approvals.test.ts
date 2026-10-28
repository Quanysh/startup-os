import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_OPEN_PER_AGENT, MAX_OPEN_PER_BOT, PROPOSAL_WORDS } from "./lib/agents";
import { GOAL_WORDS } from "./goals";
import { BOT_WORDS } from "./lib/botRules";
import { AGENT_HEADER } from "./lib/osAgents";
import { STARTUP_OS_PROJECT } from "./lib/agentStartupOs";
import { NOW, SAM, addSam, answer, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// The approvals inbox (/approvals: `assistant.inbox`), the goal tools that
// propose rather than write (`goal_create`, `goal_update`), and the reasons a
// rejection carries back to the bots through `proposals_feedback`. Every
// title and name is made up.

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
const key = (kind: string) => `chief_of_staff:${kind}:made-up-${(made += 1)}`;
const goals = (t: TestBackend) => t.run((ctx) => ctx.db.query("goals").collect());
const proposals = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());

const goalCreate = (w: World, args: Record<string, unknown> = {}) =>
  answer(w.t, w.token, "goal_create", {
    agent: "chief_of_staff",
    company: "us",
    quarter: "2026-Q4",
    title: "Made-up: ten clinics live",
    reason: "Made-up reason.",
    ...args,
  });

describe("goal tools propose; nothing is written until the owner approves", () => {
  test("goal_create stores a proposal of kind goal_create and makes no goal", async () => {
    const w = await world();
    const before = await goals(w.t);
    const made = await goalCreate(w, { dedupeKey: key("goal_create") });
    expect(made).toMatchObject({ proposed: true });
    expect(await goals(w.t)).toEqual(before);
    const [row] = await proposals(w.t);
    expect(row).toMatchObject({
      kind: "goal_create",
      agent: "chief_of_staff",
      company: "us",
      status: "open",
      payload: { quarter: "2026-Q4", title: "Made-up: ten clinics live" },
    });
  });

  test("approving goal_create makes the goal goals.create would: this company's, last in order, on track", async () => {
    const w = await world();
    const { id } = (await goalCreate(w)) as unknown as { id: Id<"proposals"> };
    const result = await w.owner.mutation(api.assistant.approve, { id });
    expect(result).toHaveProperty("goalId");
    const goal = (await goals(w.t)).find((row) => row.title === "Made-up: ten clinics live")!;
    expect(goal).toMatchObject({ quarter: "2026-Q4", status: "on_track", order: 1, company: "us" });
    // A status given is kept.
    const second = (await goalCreate(w, { title: "Made-up: second", status: "at_risk" })) as unknown as { id: Id<"proposals"> };
    await w.owner.mutation(api.assistant.approve, { id: second.id });
    expect((await goals(w.t)).find((row) => row.title === "Made-up: second")).toMatchObject({ status: "at_risk", order: 2 });
  });

  test("a quarter that is not one is refused, as the goals page refuses it", async () => {
    const w = await world();
    const { said } = await call(w.t, w.token, "goal_create", {
      agent: "chief_of_staff",
      company: "us",
      quarter: "Q4",
      title: "x",
      reason: "r",
    });
    expect(said).toContain("quarter");
    expect(await proposals(w.t)).toEqual([]);
  });

  test("goal_update proposes a rename or a re-rating; approving it changes that and nothing else", async () => {
    const w = await world();
    const { id } = (await answer(w.t, w.token, "goal_update", {
      agent: "chief_of_staff",
      company: "us",
      goalId: w.goal,
      status: "at_risk",
      reason: "Made-up reason.",
    })) as unknown as { id: Id<"proposals"> };
    expect((await w.t.run((ctx) => ctx.db.get(w.goal)))!.status).toBe("on_track");
    await w.owner.mutation(api.assistant.approve, { id });
    const goal = (await w.t.run((ctx) => ctx.db.get(w.goal)))!;
    expect(goal).toMatchObject({ status: "at_risk", title: "Example goal", updatedAt: NOW });
  });

  test("goal_update needs a change, a goal that exists, and one of that company or both", async () => {
    const w = await world();
    const base = { agent: "chief_of_staff", company: "us", reason: "r" };
    expect((await call(w.t, w.token, "goal_update", { ...base, goalId: w.goal })).said).toBe(
      PROPOSAL_WORDS.nothingToChangeGoal,
    );
    const kzGoal = await w.t.run((ctx) =>
      ctx.db.insert("goals", { quarter: "2026-Q4", title: "KZ", status: "on_track", order: 5, company: "kz" }),
    );
    expect((await call(w.t, w.token, "goal_update", { ...base, goalId: kzGoal, title: "x" })).said).toBe(
      PROPOSAL_WORDS.goalElsewhere,
    );
    const { id } = (await answer(w.t, w.token, "goal_update", { ...base, goalId: w.goal, title: "Renamed" })) as unknown as { id: Id<"proposals"> };
    await w.t.run((ctx) => ctx.db.delete(w.goal));
    await expect(w.owner.mutation(api.assistant.approve, { id })).rejects.toThrow(PROPOSAL_WORDS.goalGone);
  });
});

describe("a goal's owner, bot, target and due day, proposed", () => {
  const addBot = (w: World) =>
    w.t.run(async (ctx) => {
      await ctx.db.insert("bots", {
        userId: await ctx.db.insert("users", {}),
        botId: "made_up_advisor",
        name: "Made-up advisor",
        role: "Made-up",
        clients: "any",
        permissions: [{ area: "review", level: "write" }],
        limits: { proposalsPerDay: 5, changesPer10Min: 5, callsPer10Min: 5 },
        enabled: true,
        suggested: false,
        createdAt: 1,
        updatedAt: 1,
      });
    });

  test("goal_create carries them; the card shows them; approving sets them on the goal", async () => {
    const w = await world();
    await addBot(w);
    const { id } = (await goalCreate(w, {
      ownerEmail: SAM,
      ownerBot: "made_up_advisor",
      target: "Made-up: 10 clinics",
      dueOn: "2026-12-31",
    })) as unknown as { id: Id<"proposals"> };
    const [row] = (await w.owner.query(api.assistant.inbox, {})).filter((r) => r.id === id);
    expect(row!.source === "proposal" && row!.effect.changes).toEqual(
      expect.arrayContaining([
        { field: "Owner", before: null, after: expect.any(String) },
        { field: "Bot", before: null, after: "made_up_advisor" },
        { field: "Target", before: null, after: "Made-up: 10 clinics" },
        { field: "Due", before: null, after: "2026-12-31" },
      ]),
    );
    await w.owner.mutation(api.assistant.approve, { id });
    expect((await goals(w.t)).find((g) => g.title === "Made-up: ten clinics live")).toMatchObject({
      ownerEmail: SAM,
      ownerBot: "made_up_advisor",
      target: "Made-up: 10 clinics",
      dueOn: "2026-12-31",
    });
  });

  test("goal_update sets or clears them, before → after on the card", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.goal, { target: "Made-up: old", ownerEmail: SAM }));
    const { id } = (await answer(w.t, w.token, "goal_update", {
      agent: "chief_of_staff",
      company: "us",
      goalId: w.goal,
      target: "Made-up: new",
      ownerEmail: null,
      dueOn: "2026-11-30",
      reason: "Made-up reason.",
    })) as unknown as { id: Id<"proposals"> };
    const [row] = (await w.owner.query(api.assistant.inbox, {})).filter((r) => r.id === id);
    expect(row!.changes).toEqual(
      expect.arrayContaining([
        { field: "Target", before: "Made-up: old", after: "Made-up: new" },
        { field: "Owner", before: expect.any(String), after: null },
        { field: "Due", before: null, after: "2026-11-30" },
      ]),
    );
    await w.owner.mutation(api.assistant.approve, { id });
    const goal = (await w.t.run((ctx) => ctx.db.get(w.goal)))!;
    expect(goal).toMatchObject({ target: "Made-up: new", dueOn: "2026-11-30" });
    expect(goal.ownerEmail).toBeUndefined();
  });

  test("no default dedupeKey holds an address, and two owners proposed are two keys", async () => {
    const w = await world();
    await addBot(w);
    const update = (ownerEmail: string | null) =>
      answer(w.t, w.token, "goal_update", { agent: "chief_of_staff", company: "us", goalId: w.goal, ownerEmail, reason: "r" });
    await update(SAM);
    await update(null);
    await goalCreate(w, { ownerEmail: SAM, title: `Made-up: ask ${SAM} for ten clinics` });
    const local = SAM.split("@")[0]!.replace(/[^a-z0-9]+/g, "-");
    const keys = (await proposals(w.t)).map((row) => row.dedupeKey);
    expect(keys).toHaveLength(3);
    for (const k of keys) {
      expect(k).not.toContain("@");
      expect(k).not.toContain(local);
      expect(k).not.toContain("gmail");
    }
    expect(new Set(keys).size).toBe(3);
    // The goal and the fields it changes stay readable in the key.
    expect(keys[0]).toMatch(/^chief_of_staff:goal_update:[a-z0-9-]+-owneremail-[0-9a-f]{8}$/);
  });

  test("an owner off the company or a bot that does not exist is refused when proposed", async () => {
    const w = await world();
    expect((await call(w.t, w.token, "goal_create", {
      agent: "chief_of_staff", company: "us", quarter: "2026-Q4", title: "x", reason: "r", ownerEmail: "nobody@example.com",
    })).said).toBe(GOAL_WORDS.owner);
    expect((await call(w.t, w.token, "goal_update", {
      agent: "chief_of_staff", company: "us", goalId: w.goal, reason: "r", ownerBot: "no_such_bot",
    })).said).toBe(GOAL_WORDS.bot);
    expect(await proposals(w.t)).toEqual([]);
  });
});

describe("the inbox", () => {
  test("every open proposal and every waiting tool call, newest first, with before and after where known", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    const change = (await answer(t, w.token, "propose", {
      agent: "engineering",
      company: "us",
      kind: "task_change",
      reason: "r",
      dedupeKey: key("task_change").replace(/^chief_of_staff:/, "engineering:"),
      payload: { taskId: ids.usTask, assignee: SAM, column: "doing" },
    })) as unknown as { id: Id<"proposals"> };
    vi.setSystemTime(NOW + 60_000);
    const rerate = (await answer(t, w.token, "goal_update", {
      agent: "chief_of_staff",
      company: "us",
      goalId: w.goal,
      status: "off_track",
      reason: "r",
    })) as unknown as { id: Id<"proposals"> };
    vi.setSystemTime(NOW + 2 * 60_000);
    await answer(t, w.token, "propose", {
      agent: "sales",
      company: "kz",
      kind: "draft",
      reason: "r",
      dedupeKey: key("draft").replace(/^chief_of_staff:/, "sales:"),
      payload: { title: "KZ draft", body: "b" },
    });
    const ownerId = (await t.run((ctx) => ctx.db.query("agentTokens").first()))!.userId;
    const waiting = await t.run(async (ctx) => {
      await ctx.db.insert("agentRuntimeRuns", {
        project: STARTUP_OS_PROJECT,
        runId: "run-1",
        agentId: "made-up.agent",
        versionNumber: 1,
        trigger: "api",
        state: "awaiting_approval",
        actAs: ownerId,
        input: "{}",
        createdAt: NOW,
      });
      return ctx.db.insert("agentApprovals", {
        project: STARTUP_OS_PROJECT,
        rootAgentId: "made-up.agent",
        rootRunId: "run-1",
        agentId: "made-up.agent",
        runId: "run-1",
        toolId: "task_create",
        arguments: '{"title":"Made-up"}',
        state: "pending",
        createdAt: NOW + 3 * 60_000,
      });
    });

    const all = await owner.query(api.assistant.inbox, {});
    expect(all.map((row) => row.id)).toEqual([waiting, expect.any(String), rerate.id, change.id]);
    expect(all[0]).toMatchObject({
      source: "tool_call",
      agent: "made-up.agent",
      kind: "tool_call",
      company: null,
      tool: "task_create",
      arguments: '{"title":"Made-up"}',
    });
    const changeRow = all.find((row) => row.id === change.id)!;
    expect(changeRow).toMatchObject({ source: "proposal", agent: "engineering", kind: "task_change", company: "us" });
    expect(changeRow.changes).toEqual([
      { field: "Assignee", before: null, after: "Sam Teammate" },
      { field: "Column", before: "Backlog", after: "Doing" },
    ]);
    expect(all.find((row) => row.id === rerate.id)!.changes).toEqual([
      { field: "Status", before: "On track", after: "Off track" },
    ]);
    // The company in view: its own proposals, and every tool call (they belong to no company).
    const us = await owner.query(api.assistant.inbox, { company: "us" });
    expect(us.map((row) => row.id)).toEqual([waiting, rerate.id, change.id]);
  });
  // A denied tool call keeps the owner's reason: agentRuntime.test.ts, "denied".
});

describe("proposals_feedback carries the rejection back", () => {
  test("a dismissed proposal says the kind rejected and the owner's reason; kinds are counted", async () => {
    const w = await world();
    const ids: Id<"proposals">[] = [];
    for (let n = 0; n < 3; n++) {
      ids.push(((await goalCreate(w, { title: `Made-up ${n}` })) as unknown as { id: Id<"proposals"> }).id);
    }
    await w.owner.mutation(api.assistant.dismiss, { id: ids[0]!, reason: "We set goals ourselves" });
    await w.owner.mutation(api.assistant.dismiss, { id: ids[1]!, code: "not_a_priority" });
    await w.owner.mutation(api.assistant.approve, { id: ids[2]! });
    const fed = await answer(w.t, w.token, "proposals_feedback");
    const rows = fed.rows as Record<string, unknown>[];
    expect(rows.find((row) => row.dismissReason === "We set goals ourselves")).toMatchObject({
      rejection: { kind: "goal_create", reason: "We set goals ourselves" },
    });
    expect(rows.find((row) => row.status === "approved")).toMatchObject({ rejection: null });
    expect(fed.rejectedKinds).toEqual({ goal_create: 2 });
  });
});

describe("a bot's goal proposal", () => {
  test("lands in the inbox attributed to the bot, filed under the chief of staff", async () => {
    const w = await world();
    // The Strategy Advisor is a suggested bot with write on `review`, the Goals page's area.
    await w.owner.mutation(api.bots.addSuggested, {});
    const { id } = (await answer(w.t, w.token, "goal_create", {
      bot: "strategy_advisor",
      company: "us",
      quarter: "2026-Q4",
      title: "Made-up: bot goal",
      reason: "r",
    })) as unknown as { id: Id<"proposals"> };
    expect(await w.t.run((ctx) => ctx.db.get(id))).toMatchObject({
      bot: "strategy_advisor",
      agent: "chief_of_staff",
      kind: "goal_create",
    });
    expect((await w.t.run((ctx) => ctx.db.get(id)))!.dedupeKey).toMatch(/^bot-strategy_advisor:goal_create:/);
    const [row] = await w.owner.query(api.assistant.inbox, {});
    expect(row).toMatchObject({ id, bot: "strategy_advisor", agent: "chief_of_staff" });
    await w.owner.mutation(api.assistant.dismiss, { id, reason: "Bots do not set goals" });
    const fed = (await answer(w.t, w.token, "proposals_feedback")).rows as Record<string, unknown>[];
    expect(fed[0]).toMatchObject({ bot: "strategy_advisor", rejection: { kind: "goal_create", reason: "Bots do not set goals" } });
  });

  test("the bot is the one the endpoint matched, by the header or `agent` too", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    const base = { company: "us", quarter: "2026-Q4", reason: "r" };
    await call(w.t, w.token, "goal_create", { ...base, title: "Made-up: by header" }, { [AGENT_HEADER]: "strategy_advisor" });
    await call(w.t, w.token, "goal_create", { ...base, title: "Made-up: by agent", agent: "strategy_advisor" });
    expect((await proposals(w.t)).map((p) => p.bot)).toEqual(["strategy_advisor", "strategy_advisor"]);
    // Two names that differ are refused before anything runs.
    const two = await call(w.t, w.token, "goal_create", { ...base, title: "x", bot: "growth" }, { [AGENT_HEADER]: "strategy_advisor" });
    expect(two.said).toBe(BOT_WORDS.wrongAgent);
  });

  test("a bot without write on review, an unknown bot and a bot id that is not a slug are refused", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    const base = { company: "us", quarter: "2026-Q4", title: "x", reason: "r" };
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "growth" })).said).toBe(BOT_WORDS.notAllowed);
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "grok-sales" })).said).toBe(BOT_WORDS.unknown);
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "Not A Slug!" })).isError).toBe(true);
    expect((await call(w.t, w.token, "goal_create", base)).said).toBe(PROPOSAL_WORDS.whoProposes);
    expect(await proposals(w.t)).toEqual([]);
  });
});

describe("a bot's proposals are counted in a bucket of their own", () => {
  const base = { company: "us", quarter: "2026-Q4", reason: "Made-up reason." };
  /** Copies of a proposal already made, open, each with its own key: the cap counts rows, not how they came. */
  const fill = async (w: World, from: Id<"proposals">, count: number, tag: string) =>
    w.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(from))!;
      for (let n = 0; n < count; n++) await ctx.db.insert("proposals", { ...row, dedupeKey: `${tag}:goal_create:copy-${n}` });
    });

  test("open: a bot at its cap does not stop the chief of staff, and the chief of staff's twenty do not stop a bot", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    const first = (await answer(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up 1" })) as unknown as {
      id: Id<"proposals">;
    };
    await fill(w, first.id, MAX_OPEN_PER_BOT - 1, "bot-strategy_advisor");
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up 2" })).said).toBe(
      PROPOSAL_WORDS.tooManyOpenBot,
    );
    // The chief of staff has room: none of the bot's are its.
    const cos = (await goalCreate(w, { dedupeKey: key("goal_create") })) as unknown as { id: Id<"proposals"> };
    expect(cos).toMatchObject({ proposed: true });
    await fill(w, cos.id, MAX_OPEN_PER_AGENT - 1, "chief_of_staff");
    expect((await call(w.t, w.token, "goal_create", { agent: "chief_of_staff", ...base, title: "Made-up 3" })).said).toBe(
      PROPOSAL_WORDS.tooManyOpen,
    );
  });

  test("a day: the bot's own proposals a day, from its profile, across all its clients", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    const advisor = (await w.t.run((ctx) => ctx.db.query("bots").collect())).find((b) => b.botId === "strategy_advisor")!;
    await w.owner.mutation(api.bots.update, {
      id: advisor._id,
      limits: { ...advisor.limits, proposalsPerDay: 2 },
    });
    const other = await w.owner.mutation(api.assistant.createToken, { entropy: "made-up-entropy-0123456789-abcdefghijklmnop", scope: "act", name: "Grok app" });
    for (const title of ["Made-up 1", "Made-up 2"]) {
      expect(await answer(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title })).toMatchObject({ proposed: true });
    }
    expect((await call(w.t, other.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up 3" })).said).toBe(
      PROPOSAL_WORDS.tooManyTodayBot(2),
    );
    // The chief of staff's day is its own.
    expect(await goalCreate(w, { dedupeKey: key("goal_create") })).toMatchObject({ proposed: true });
  });

  test("a key is a repeat only for the one who proposed it: a bot cannot block the chief of staff", async () => {
    const w = await world();
    await w.owner.mutation(api.bots.addSuggested, {});
    // A bot cannot even take the chief of staff's key (Bot Loop v3: an attribution mismatch)…
    const shared = "chief_of_staff:goal_create:made-up-shared";
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up", dedupeKey: shared })).refusal).toEqual({
      code: "attribution_mismatch",
      expected: "strategy_advisor",
      got: "chief_of_staff",
    });
    // …and the same subject under each one's own key is each one's own.
    const mine = "bot-strategy_advisor:goal_create:made-up-shared";
    expect(await answer(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up", dedupeKey: mine })).toMatchObject({
      proposed: true,
    });
    expect(await goalCreate(w, { dedupeKey: shared, title: "Made-up: another quarter's aim" })).toMatchObject({ proposed: true });
    expect((await call(w.t, w.token, "goal_create", { ...base, bot: "strategy_advisor", title: "Made-up", dedupeKey: mine })).said).toBe(
      PROPOSAL_WORDS.repeatOpen,
    );
  });
});
