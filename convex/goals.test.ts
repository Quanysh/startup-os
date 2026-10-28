import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { GOAL_WORDS } from "./goals";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const Q = "2026-Q4";

describe("goals", () => {
  test("a new goal starts on track, at the end of its quarter's list", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.goals.create, { quarter: Q, title: "Close two US pilots" });
    await owner.mutation(api.goals.create, { quarter: Q, title: "Sign the lead investor" });
    const goals = await owner.query(api.goals.list, { quarter: Q });
    expect(goals.map((g) => g.title)).toEqual([
      "Close two US pilots",
      "Sign the lead investor",
    ]);
    expect(goals[0]?.status).toBe("on_track");
  });

  test("each goal says when it last changed: made, then renamed or re-rated", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 1));
      const t = convexTest(schema, modules);
      const owner = await signInAsOwner(t);
      const id = await owner.mutation(api.goals.create, { quarter: Q, title: "Ship v1" });
      const [made] = await owner.query(api.goals.list, { quarter: Q });
      expect(made!.changedAt).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 1));
      vi.setSystemTime(Date.UTC(2026, 9, 7));
      await owner.mutation(api.goals.update, { id, status: "at_risk" });
      const [changed] = await owner.query(api.goals.list, { quarter: Q });
      expect(changed!.changedAt).toBe(Date.UTC(2026, 9, 7));
    } finally {
      vi.useRealTimers();
    }
  });

  test("goals from another quarter are not listed", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.goals.create, { quarter: "2026-Q3", title: "Old" });
    expect(await owner.query(api.goals.list, { quarter: Q })).toEqual([]);
  });

  test("the title is trimmed and may not be blank", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.goals.create, { quarter: Q, title: "  Ship v1  " });
    expect((await owner.query(api.goals.list, { quarter: Q }))[0]?.title).toBe("Ship v1");
    await expect(
      owner.mutation(api.goals.create, { quarter: Q, title: "   " }),
    ).rejects.toThrow("needs a title");
  });

  test("a malformed quarter is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.goals.create, { quarter: "2026-Q5", title: "x" }),
    ).rejects.toThrow("is not a quarter");
  });

  test("the status can be changed", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.goals.create, { quarter: Q, title: "Raise seed" });
    await owner.mutation(api.goals.update, { id, status: "at_risk" });
    const [goal] = await owner.query(api.goals.list, { quarter: Q });
    expect(goal).toMatchObject({ title: "Raise seed", status: "at_risk" });
  });

  test("a goal can be renamed, keeping its status and its tasks", async () => {
    // Fixing a typo must not mean deleting the goal and losing its links.
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.goals.create, { quarter: Q, title: "Rase seed" });
    await owner.mutation(api.goals.update, { id, status: "at_risk" });
    const taskId = await owner.mutation(api.tasks.create, { title: "Send deck", goalId: id });
    await owner.mutation(api.goals.update, { id, title: "  Raise seed " });
    const [goal] = await owner.query(api.goals.list, { quarter: Q });
    expect(goal).toMatchObject({ title: "Raise seed", status: "at_risk" });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.goalId).toBe(id);
    await expect(owner.mutation(api.goals.update, { id, title: "  " })).rejects.toThrow(
      "needs a title",
    );
  });

  test("removing a goal twice is harmless", async () => {
    // A double-click sends two removes.
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.goals.create, { quarter: Q, title: "Raise seed" });
    await owner.mutation(api.goals.remove, { id });
    await expect(owner.mutation(api.goals.remove, { id })).resolves.toBeNull();
  });

  test("removing a goal unlinks its tasks instead of deleting them", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const goalId = await owner.mutation(api.goals.create, { quarter: Q, title: "Raise seed" });
    const taskId = await owner.mutation(api.tasks.create, {
      title: "Send deck to three funds",
      goalId,
    });
    await owner.mutation(api.goals.remove, { id: goalId });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).not.toBeNull();
    expect(task?.goalId).toBeUndefined();
    expect(await owner.query(api.goals.list, { quarter: Q })).toEqual([]);
  });

  test("a goal may be one company's; one with none (every goal from before) is both's", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run((ctx) => ctx.db.insert("goals", { quarter: Q, title: "Older, both", status: "on_track", order: 0 }));
    await owner.mutation(api.goals.create, { quarter: Q, title: "Startup's", company: "us" });
    await owner.mutation(api.goals.create, { quarter: Q, title: "Globex's", company: "kz" });
    const titles = async (company?: "us" | "kz") =>
      (await owner.query(api.goals.list, { quarter: Q, ...(company ? { company } : null) })).map((g) => g.title);
    expect(await titles()).toEqual(["Older, both", "Startup's", "Globex's"]);
    expect(await titles("us")).toEqual(["Older, both", "Startup's"]);
    expect(await titles("kz")).toEqual(["Older, both", "Globex's"]);
    const rows = await owner.query(api.goals.list, { quarter: Q });
    expect(rows.map((g) => g.company)).toEqual([null, "us", "kz"]);
  });

  test("a teammate on Globex alone is sent no Startup goal, and cannot make or change one", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const us = await owner.mutation(api.goals.create, { quarter: Q, title: "Startup's", company: "us" });
    await owner.mutation(api.goals.create, { quarter: Q, title: "Both" });
    const kz = await signInAsCofounder(t, ["kz"]);
    expect((await kz.query(api.goals.list, { quarter: Q })).map((g) => g.title)).toEqual(["Both"]);
    await expect(kz.query(api.goals.list, { quarter: Q, company: "us" })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.goals.create, { quarter: Q, title: "x", company: "us" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(kz.mutation(api.goals.update, { id: us, status: "done" })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.goals.remove, { id: us })).rejects.toThrow("not_allowed");
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.goals.list, { quarter: Q })).rejects.toThrow("not_allowed");
  });
});

// A goal's owner, bot, target and due day, and what is linked to it. Every
// name, address and title here is made up.
describe("goal owners and links", () => {
  const KZ_PERSON = memberEmail("engineer", ["kz"]);
  const US_PERSON = memberEmail("sales", ["us"]);

  const seed = async (t: TestBackend) => {
    await addMember(t, { email: KZ_PERSON, role: "engineer", companies: ["kz"] });
    await addMember(t, { email: US_PERSON, role: "sales", companies: ["us"] });
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: KZ_PERSON, name: "Konstantin Example" });
      await ctx.db.insert("bots", {
        userId: await ctx.db.insert("users", {}),
        botId: "strategy_advisor",
        name: "Strategy Advisor",
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
  };

  test("owner, bot, target and due day are saved and read back, and each can be cleared", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.goals.create, {
      quarter: Q,
      title: "Grow Globex",
      company: "kz",
      ownerEmail: ` ${KZ_PERSON.toUpperCase()} `,
      ownerBot: "strategy_advisor",
      target: "  v2 live at 3 pilot clinics ",
      dueOn: "2026-12-31",
    });
    const [goal] = await owner.query(api.goals.list, { quarter: Q });
    expect(goal).toMatchObject({
      id,
      owner: { email: KZ_PERSON, name: "Konstantin Example" },
      ownerBot: "strategy_advisor",
      target: "v2 live at 3 pilot clinics",
      dueOn: "2026-12-31",
    });
    await owner.mutation(api.goals.update, { id, ownerEmail: null, ownerBot: null, target: null, dueOn: null });
    expect((await owner.query(api.goals.list, { quarter: Q }))[0]).toMatchObject({
      owner: null,
      ownerBot: null,
      target: null,
      dueOn: null,
    });
  });

  test("a target is a figure: sent with Scorecard or Finance, never to the board alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.goals.create, { quarter: Q, title: "Grow Globex", target: "v2 live at 3 pilot clinics" });
    const boardOnly = await signInWithAreas(t, "engineer", ["board", "product", "engineering", "today"]);
    const scorecard = await signInWithAreas(t, "sales", ["scorecard"]);
    const finance = await signInWithAreas(t, "cofounder", ["finance", "board"]);
    const [seen] = await boardOnly.query(api.goals.list, { quarter: Q });
    expect(seen).toMatchObject({ title: "Grow Globex", target: null });
    expect(JSON.stringify(await boardOnly.query(api.goals.list, { quarter: Q }))).not.toContain("4.0M");
    expect((await scorecard.query(api.goals.list, { quarter: Q }))[0]?.target).toBe("v2 live at 3 pilot clinics");
    expect((await finance.query(api.goals.list, { quarter: Q }))[0]?.target).toBe("v2 live at 3 pilot clinics");
    expect((await owner.query(api.goals.list, { quarter: Q }))[0]?.target).toBe("v2 live at 3 pilot clinics");
  });

  test("a goal editor without Scorecard or Finance neither sees nor changes a target", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.goals.create, { quarter: Q, title: "Grow Globex", target: "v2 live at 3 pilot clinics" });
    const editor = await signInWithAreas(t, "engineer", ["board", "review"]);
    // The Goals page's details form sends every field; a target it could not read arrives as null.
    await editor.mutation(api.goals.update, { id, ownerEmail: null, ownerBot: null, target: null, dueOn: "2026-12-31" });
    await editor.mutation(api.goals.update, { id, target: "ARR $1M" });
    const made = await editor.mutation(api.goals.create, { quarter: Q, title: "Ship v2", target: "Burn under $20K" });
    const goals = await owner.query(api.goals.list, { quarter: Q });
    expect(goals.find((g) => g.id === id)).toMatchObject({ target: "v2 live at 3 pilot clinics", dueOn: "2026-12-31" });
    expect(goals.find((g) => g.id === made)?.target).toBeNull();
  });

  test("an owner off the goal's company, an unknown bot, a long target or a bad day is refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const make = (over: Record<string, unknown>) =>
      owner.mutation(api.goals.create, { quarter: Q, title: "Grow Globex", company: "kz", ...over });
    await expect(make({ ownerEmail: US_PERSON })).rejects.toThrow(GOAL_WORDS.owner);
    await expect(make({ ownerEmail: "SECRET@nowhere.example" })).rejects.toThrow(GOAL_WORDS.owner);
    await expect(make({ ownerBot: "no_such_bot" })).rejects.toThrow(GOAL_WORDS.bot);
    await expect(make({ target: "x".repeat(121) })).rejects.toThrow(GOAL_WORDS.target);
    await expect(make({ dueOn: "31.12.2026" })).rejects.toThrow(GOAL_WORDS.dueOn);
    // A goal of both companies may be anyone's on the team.
    await owner.mutation(api.goals.create, { quarter: Q, title: "Both", ownerEmail: US_PERSON });
  });

  test("a goal's links: tasks, open proposals, deals and handoffs of its tasks", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const goalId = await owner.mutation(api.goals.create, { quarter: Q, title: "Pilots", company: "us" });
    const other = await owner.mutation(api.goals.create, { quarter: Q, title: "Nothing linked", company: "us" });
    await t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", { title: "Linked", kind: "task", column: "backlog", order: 0, goalId, company: "us" });
      await ctx.db.insert("tasks", { title: "Linked too", kind: "task", column: "done", order: 0, goalId, company: "us" });
      await ctx.db.insert("deals", { source: "manual", externalId: "d1", name: "Clinic", stage: "lead", order: 0, market: "us", goalId });
      await ctx.db.insert("deals", { source: "manual", externalId: "d2", name: "Gone", stage: "lead", order: 1, market: "us", goalId, archivedAt: 1 });
      await ctx.db.insert("proposals", {
        agent: "sales",
        kind: "draft",
        company: "us",
        reason: "made up",
        payload: { title: "x", body: "y" },
        dedupeKey: "sales:draft:x",
        status: "open",
        createdAt: 1,
        editedBeforeApprove: false,
        goalId,
      });
      const handoff = {
        company: "us" as const,
        from: "growth",
        fromKey: "growth",
        to: "support",
        toKey: "support",
        title: "x",
        summary: "y",
        openSince: 1,
        createdAt: 1,
        updatedAt: 1,
        history: [],
      };
      await ctx.db.insert("handoffs", { ...handoff, status: "open", links: [{ kind: "task", id: taskId }] });
      await ctx.db.insert("handoffs", { ...handoff, status: "done", links: [{ kind: "task", id: taskId }] });
      await ctx.db.insert("handoffs", { ...handoff, status: "open", links: [] });
    });
    const links = await owner.query(api.goals.links, { quarter: Q });
    expect(links[goalId]).toEqual({ tasks: 2, proposals: 1, deals: 1, handoffs: 1 });
    expect(links[other]).toEqual({ tasks: 0, proposals: 0, deals: 0, handoffs: 0 });

    // A teammate is told only what their own pages show: no proposals without the owner's inbox.
    const cofounder = await signInAsCofounder(t, ["us"]);
    expect((await cofounder.query(api.goals.links, { quarter: Q }))[goalId]).toMatchObject({ tasks: 2, proposals: null });
    // And nothing of a company they are not on.
    const kz = await signInAsCofounder(t, ["kz"]);
    expect((await kz.query(api.goals.links, { quarter: Q }))[goalId]).toBeUndefined();
  });

  test("a deal is linked to a goal of its own company or both, and unlinked with null", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const us = await owner.mutation(api.goals.create, { quarter: Q, title: "Pilots", company: "us" });
    const kz = await owner.mutation(api.goals.create, { quarter: Q, title: "KZ", company: "kz" });
    const dealId = await t.run((ctx) =>
      ctx.db.insert("deals", { source: "manual", externalId: "d1", name: "Clinic", stage: "lead", order: 0, market: "us" }),
    );
    await owner.mutation(api.deals.setGoal, { id: dealId, goalId: us });
    expect((await t.run((ctx) => ctx.db.get(dealId)))!.goalId).toBe(us);
    await expect(owner.mutation(api.deals.setGoal, { id: dealId, goalId: kz })).rejects.toThrow(GOAL_WORDS.elsewhere);
    await owner.mutation(api.deals.setGoal, { id: dealId, goalId: null });
    expect((await t.run((ctx) => ctx.db.get(dealId)))!.goalId).toBeUndefined();
  });
});
