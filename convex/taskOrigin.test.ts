import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ownerMember } from "./lib/agentStore";
import { approveProposal } from "./lib/proposals";
import { ENTROPY, NOW, answer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Which bot made a card. The id is the authenticated caller, or the bot that
// filed a proposal `approveProposal` then carried out. Made-up titles only.

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
  const grok = await owner.mutation(api.assistant.createToken, {
    entropy: ENTROPY,
    scope: "act",
    name: "Grok app",
  });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token };
}

const stored = (t: TestBackend, title: string) =>
  t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((row) => row.title === title) ?? null);

async function proposed(t: TestBackend, token: string, args: Record<string, unknown>) {
  const made = await call(t, token, "propose", args);
  if (made.output?.id === undefined) throw new Error(`propose did not answer: ${made.text}`);
  return made.output.id as Id<"proposals">;
}

async function boardOrigin(owner: Awaited<ReturnType<typeof setUp>>["owner"], title: string) {
  const board = await owner.query(api.tasks.board, {});
  return board.backlog.find((card) => card.title === title)?.origin;
}

async function toolOrigin(t: TestBackend, token: string, title: string, args: Record<string, unknown> = {}) {
  const listed = await answer(t, token, "tasks", args);
  const backlog = listed.backlog as { title: string; origin: unknown }[];
  return backlog.find((card) => card.title === title)?.origin;
}

describe("which bot made a card", () => {
  test("a direct task_create records the authenticated caller, and a call with no bot records none", async () => {
    const { t, owner, mac, grok } = await setUp();
    const made = await call(t, grok, "task_create", {
      agent: "growth",
      company: "us",
      title: "Alpha quartz kiln schedule for the sample workshop",
    });
    expect(made.said).toBeNull();
    expect(await stored(t, "Alpha quartz kiln schedule for the sample workshop")).toMatchObject({
      origin: { source: "agent", bot: "growth" },
    });
    expect(await boardOrigin(owner, "Alpha quartz kiln schedule for the sample workshop")).toEqual({
      source: "agent",
      for: null,
      bot: "growth",
    });
    expect(await toolOrigin(t, mac, "Alpha quartz kiln schedule for the sample workshop")).toEqual({
      source: "agent",
      for: null,
      bot: "growth",
    });
    expect(await toolOrigin(t, grok, "Alpha quartz kiln schedule for the sample workshop", { agent: "growth" })).toEqual({
      source: "agent",
      for: null,
      bot: "growth",
    });

    const id = made.output.id as string;
    const renamed = await call(t, grok, "task_update", {
      agent: "growth",
      id,
      title: "Alpha quartz kiln schedule revised for the sample workshop",
    });
    expect(renamed.said).toBeNull();
    expect(await stored(t, "Alpha quartz kiln schedule revised for the sample workshop")).toMatchObject({
      origin: { source: "agent", bot: "growth" },
    });

    const plain = await call(t, mac, "task_create", {
      company: "us",
      title: "Bravo owner card filed with no bot at all",
    });
    expect(plain.said).toBeNull();
    expect(await stored(t, "Bravo owner card filed with no bot at all")).toMatchObject({
      origin: { source: "agent" },
    });
    expect((await stored(t, "Bravo owner card filed with no bot at all"))!.origin).toEqual({ source: "agent" });
  });

  test("an external owner-agent profile records its id, with no agent of the four", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const made = await call(t, grok, "task_create", {
      agent: "chief_of_staff",
      company: "us",
      title: "Charlie external chief card for the sample ledger",
    });
    expect(made.said).toBeNull();
    const row = await stored(t, "Charlie external chief card for the sample ledger");
    expect(row!.origin).toEqual({ source: "agent", bot: "chief_of_staff" });
    expect(await boardOrigin(owner, "Charlie external chief card for the sample ledger")).toEqual({
      source: "agent",
      for: null,
      bot: "chief_of_staff",
    });
  });

  test("approving a proposal, and auto-approval, attribute the card to the proposing bot", async () => {
    const { t, owner, mac, grok } = await setUp();
    const id = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "bot-growth:task_create:delta-kiln",
      payload: { title: "Delta growth proposal about the sample clinic list" },
    });
    await owner.mutation(api.assistant.approve, { id });
    expect(await stored(t, "Delta growth proposal about the sample clinic list")).toMatchObject({
      origin: { source: "agent", agent: "chief_of_staff", bot: "growth" },
    });
    expect(await boardOrigin(owner, "Delta growth proposal about the sample clinic list")).toEqual({
      source: "agent",
      for: null,
      agent: "chief_of_staff",
      bot: "growth",
    });
    expect(await toolOrigin(t, mac, "Delta growth proposal about the sample clinic list")).toEqual({
      source: "agent",
      for: null,
      agent: "chief_of_staff",
      bot: "growth",
    });

    const auto = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why for the automatic path.",
      dedupeKey: "bot-growth:task_create:echo-newsletter",
      payload: { title: "Echo automatic growth card about the sample newsletter" },
    });
    const result = await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      const user = users.find((row) => row.email === OWNER)!;
      return approveProposal(ctx, ownerMember(user), auto, { now: NOW, decision: "auto_approved" });
    });
    expect(result).toHaveProperty("taskId");
    expect(await t.run((ctx) => ctx.db.get(auto))).toMatchObject({ status: "auto_approved", bot: "growth" });
    expect(await stored(t, "Echo automatic growth card about the sample newsletter")).toMatchObject({
      origin: { source: "agent", agent: "chief_of_staff", bot: "growth" },
    });
  });

  test("proposal_decide approves through the same path and stamps the proposing bot", async () => {
    const { t, owner, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const id = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "bot-growth:task_create:november-decide",
      payload: { title: "November growth card decided by the chief of staff" },
    });
    const decided = await call(t, grok, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [id],
      decision: "approve",
    });
    expect(decided.said).toBeNull();
    expect(decided.output).toMatchObject({ decided: 1 });
    expect((await stored(t, "November growth card decided by the chief of staff"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
  });

  test("one of the four, with no bot on the call, stays without a bot", async () => {
    const { t, owner, mac } = await setUp();
    const id = await proposed(t, mac, {
      agent: "engineering",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "engineering:task_create:foxtrot-chart",
      payload: { title: "Foxtrot engineering proposal about the sample chart" },
    });
    await owner.mutation(api.assistant.approve, { id });
    const row = await stored(t, "Foxtrot engineering proposal about the sample chart");
    expect(row!.origin).toEqual({ source: "agent", agent: "engineering" });
    expect(await toolOrigin(t, mac, "Foxtrot engineering proposal about the sample chart")).toEqual({
      source: "agent",
      for: null,
      agent: "engineering",
    });
  });

  test("a proposal whose bot is not a profile id stamps nothing, and the migration copies only a reliable bot", async () => {
    const { t, owner, grok } = await setUp();
    const keptId = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "bot-growth:task_create:golf-kept",
      payload: { title: "Golf growth card that already records its bot" },
    });
    await owner.mutation(api.assistant.approve, { id: keptId });

    const junkId = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "bot-growth:task_create:hotel-junk",
      payload: { title: "Hotel card whose proposal names no profile" },
    });
    await t.run((ctx) => ctx.db.patch(junkId, { bot: "Nope" }));
    await owner.mutation(api.assistant.approve, { id: junkId });
    expect((await stored(t, "Hotel card whose proposal names no profile"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
    });

    const auto = await proposed(t, grok, {
      agent: "growth",
      company: "us",
      kind: "task_create",
      reason: "Made-up why.",
      dedupeKey: "bot-growth:task_create:india-auto",
      payload: { title: "India automatic card waiting to be derived" },
    });
    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      const user = users.find((row) => row.email === OWNER)!;
      await approveProposal(ctx, ownerMember(user), auto, { now: NOW, decision: "auto_approved" });
      const task = (await ctx.db.query("tasks").collect()).find(
        (row) => row.title === "India automatic card waiting to be derived",
      )!;
      // As a card from before the bot was recorded: the filing agent only.
      await ctx.db.patch(task._id, { origin: { source: "agent", agent: "chief_of_staff" } });
    });

    const { historical, research, gone } = await t.run(async (ctx) => {
      const historicalId = await ctx.db.insert("tasks", {
        title: "Juliet historical card with no proposal",
        kind: "task",
        column: "backlog",
        order: 40,
        origin: { source: "agent", agent: "sales" },
      });
      const researchId = await ctx.db.insert("tasks", {
        title: "Kilo card that already names research",
        kind: "task",
        column: "backlog",
        order: 41,
        origin: { source: "agent", bot: "research" },
      });
      const goneId = await ctx.db.insert("tasks", {
        title: "Lima card deleted before the migration",
        kind: "task",
        column: "backlog",
        order: 42,
        origin: { source: "agent" },
      });
      await ctx.db.insert("proposals", {
        agent: "chief_of_staff",
        bot: "growth",
        kind: "task_create",
        company: "us",
        reason: "Made-up.",
        payload: { title: "Kilo card that already names research" },
        dedupeKey: "bot-growth:task_create:kilo-research",
        status: "approved",
        createdAt: NOW,
        decidedAt: NOW,
        editedBeforeApprove: false,
        result: { taskId: researchId },
      });
      await ctx.db.insert("proposals", {
        agent: "chief_of_staff",
        bot: "growth",
        kind: "task_create",
        company: "us",
        reason: "Made-up.",
        payload: { title: "A draft that made no card" },
        dedupeKey: "bot-growth:task_create:kept-draft",
        status: "approved",
        createdAt: NOW,
        decidedAt: NOW,
        editedBeforeApprove: false,
        result: { kept: true },
      });
      await ctx.db.insert("proposals", {
        agent: "chief_of_staff",
        bot: "growth",
        kind: "task_create",
        company: "us",
        reason: "Made-up.",
        payload: { title: "Lima card deleted before the migration" },
        dedupeKey: "bot-growth:task_create:lima-gone",
        status: "approved",
        createdAt: NOW,
        decidedAt: NOW,
        editedBeforeApprove: false,
        result: { taskId: goneId },
      });
      await ctx.db.delete(goneId);
      return { historical: historicalId, research: researchId, gone: goneId };
    });

    // India is the one card a decided proposal can still name. Hotel's bot is
    // not a profile id, Golf and Kilo already record one, and the draft and
    // the deleted card have nothing to stamp.
    const first = await t.mutation(internal.migrations.stampBotOnAgentTasks, {});
    expect(first).toEqual({ stamped: 1, read: 6 });
    expect((await stored(t, "India automatic card waiting to be derived"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
    expect((await stored(t, "Hotel card whose proposal names no profile"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
    });

    await t.run((ctx) => ctx.db.patch(junkId, { bot: "growth" }));
    const second = await t.mutation(internal.migrations.stampBotOnAgentTasks, {});
    expect(second).toEqual({ stamped: 1, read: 6 });
    expect((await stored(t, "India automatic card waiting to be derived"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
    expect((await stored(t, "Hotel card whose proposal names no profile"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
    expect((await stored(t, "Golf growth card that already records its bot"))!.origin).toEqual({
      source: "agent",
      agent: "chief_of_staff",
      bot: "growth",
    });
    expect((await t.run((ctx) => ctx.db.get(research)))!.origin).toEqual({ source: "agent", bot: "research" });
    expect((await t.run((ctx) => ctx.db.get(historical)))!.origin).toEqual({
      source: "agent",
      agent: "sales",
    });
    expect(await t.run((ctx) => ctx.db.get(gone))).toBeNull();

    expect(await t.mutation(internal.migrations.stampBotOnAgentTasks, {})).toEqual({ stamped: 0, read: 6 });
  });
});
