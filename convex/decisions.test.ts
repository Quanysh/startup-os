import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MEMORY_WORDS } from "./lib/memory";
import schema from "./schema";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsOwner,
  signInWithAreas,
} from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const base = {
  company: "us" as const,
  title: "Price per seat",
  decision: "We charge per seat from November.",
  decidedOn: "2026-10-01",
  status: "decided" as const,
};

describe("decisions", () => {
  test("one is recorded, cleaned, and listed for its company", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.decisions.create, {
      ...base,
      title: "  Price​ per seat ",
      context: "Because\n\n\n<b>margins</b>",
      tags: ["Pricing", "pricing"],
      owner: OWNER,
    });
    const rows = await owner.query(api.decisions.list, { company: "us" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Price per seat",
      context: "Because\n\n<b>margins</b>",
      tags: ["pricing"],
      status: "decided",
      owner: { email: OWNER },
    });
    expect(await owner.query(api.decisions.list, { company: "kz" })).toEqual([]);
  });

  test("its owner must be someone a task of that company could be given to", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await addMember(t, { email: "kz.only@gmail.com", role: "engineer", companies: ["kz"] });
    await expect(
      owner.mutation(api.decisions.create, { ...base, owner: "kz.only@gmail.com" }),
    ).rejects.toThrow(MEMORY_WORDS.cannotOwn);
    await expect(
      owner.mutation(api.decisions.create, { ...base, owner: "nobody@gmail.com" }),
    ).rejects.toThrow(MEMORY_WORDS.cannotOwn);
  });

  test("over-long text is refused, never cut", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.decisions.create, { ...base, decision: "x".repeat(1_001) }),
    ).rejects.toThrow("too long");
    await expect(
      owner.mutation(api.decisions.create, { ...base, revisitOn: "soon" }),
    ).rejects.toThrow(MEMORY_WORDS.notADate);
  });

  test("a teammate on Globex alone is sent no Startup decision and cannot write one", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.decisions.create, base);
    const kz = await signInAsCofounder(t, ["kz"]);
    expect(await kz.query(api.decisions.list, {})).toEqual([]);
    await expect(kz.query(api.decisions.list, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.decisions.create, base)).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.decisions.update, { id, ...base })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.decisions.remove, { id })).rejects.toThrow("not_allowed");
  });

  test("changing the revisit date clears the reminder, so the new date is told again", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.decisions.create, { ...base, revisitOn: "2026-10-05" });
    await t.run((ctx) => ctx.db.patch(id, { revisitNotifiedAt: 5 }));
    await owner.mutation(api.decisions.update, { id, ...base, revisitOn: "2026-10-05", title: "Renamed" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.revisitNotifiedAt).toBe(5);
    await owner.mutation(api.decisions.update, { id, ...base, revisitOn: "2026-12-01" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.revisitNotifiedAt).toBeUndefined();
  });

  test("links are kept only to rows that exist, and shown only where the caller may see them", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const taskId = await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "Linked task", kind: "task", column: "backlog", order: 0, company: "us" }),
    );
    const dealId = await t.run((ctx) =>
      ctx.db.insert("deals", { source: "manual", externalId: "d", market: "us", name: "Linked deal", stage: "lead", order: 0 }),
    );
    await owner.mutation(api.decisions.create, { ...base, taskIds: [taskId], dealIds: [dealId] });
    const memoryOnly = await signInWithAreas(t, "engineer", ["memory"]);
    const [row] = await memoryOnly.query(api.decisions.list, {});
    expect(row!.links).toEqual([]);
    const [mine] = await owner.query(api.decisions.list, {});
    expect(mine!.links.map((link) => link.title).sort()).toEqual(["Linked deal", "Linked task"]);
  });

  test("the caller's own decisions due for a revisit, by the day they say it is", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const cofounder = memberEmail("cofounder");
    await addMember(t, { email: cofounder, role: "cofounder" });
    await owner.mutation(api.decisions.create, { ...base, title: "Mine due", owner: OWNER, revisitOn: "2026-10-10" });
    await owner.mutation(api.decisions.create, { ...base, title: "Mine later", owner: OWNER, revisitOn: "2026-11-10" });
    await owner.mutation(api.decisions.create, { ...base, title: "Reversed", owner: OWNER, revisitOn: "2026-10-01", status: "reversed" });
    await owner.mutation(api.decisions.create, { ...base, title: "Theirs", owner: cofounder, revisitOn: "2026-10-01" });
    const due = await owner.query(api.decisions.mineToRevisit, { today: "2026-10-14" });
    expect(due.map((row) => row.title)).toEqual(["Mine due"]);
  });

  test("the daily sweep marks a decision due and tells its owner once, by no person", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 14, 5));
    try {
      const t = convexTest(schema, modules);
      const owner = await signInAsOwner(t);
      const due = await owner.mutation(api.decisions.create, { ...base, owner: OWNER, revisitOn: "2026-10-14" });
      await owner.mutation(api.decisions.create, { ...base, title: "Later", owner: OWNER, revisitOn: "2026-10-15" });
      await owner.mutation(api.decisions.create, {
        ...base,
        title: "Gone back",
        owner: OWNER,
        revisitOn: "2026-10-01",
        status: "reversed",
      });
      await t.mutation(internal.decisions.markRevisits, {});
      await t.mutation(internal.decisions.markRevisits, {});
      const told = await t.run((ctx) => ctx.db.query("notifications").collect());
      expect(told.map((row) => [row.kind, row.decisionId, row.title, row.actor])).toEqual([
        ["decision_revisit", due, "Price per seat", { type: "system", source: "memory" }],
      ]);
      const rows = await t.run((ctx) => ctx.db.query("decisions").collect());
      const marked = rows.filter((row) => row.revisitNotifiedAt !== undefined).map((row) => row.title).sort();
      expect(marked).toEqual(["Gone back", "Price per seat"]);
      // Its status stays as it was.
      expect(rows.find((row) => row._id === due)?.status).toBe("decided");
      const [mine] = (await owner.query(api.notifications.mine, {})).rows;
      expect(mine).toMatchObject({ kind: "decision_revisit", taskId: null, decisionId: due });
    } finally {
      vi.useRealTimers();
    }
  });

  test("an owner taken off the company is no longer shown its decisions to revisit", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const cofounder = await signInAsCofounder(t);
    await owner.mutation(api.decisions.create, { ...base, owner: memberEmail("cofounder"), revisitOn: "2026-10-01" });
    expect(await cofounder.query(api.decisions.mineToRevisit, { today: "2026-10-14" })).toHaveLength(1);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("members").collect()).find((m) => m.email === memberEmail("cofounder"))!;
      await ctx.db.patch(row._id, { companies: ["kz"] });
    });
    expect(await cofounder.query(api.decisions.mineToRevisit, { today: "2026-10-14" })).toEqual([]);
  });

  test("the reminder leads to the decision only for an owner who has the memory page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 14, 5));
    try {
      const t = convexTest(schema, modules);
      const owner = await signInAsOwner(t);
      const noMemory = await signInWithAreas(t, "engineer", ["board"]);
      const withMemory = await signInWithAreas(t, "sales", ["memory"]);
      for (const who of [memberEmail("engineer"), memberEmail("sales")]) {
        await owner.mutation(api.decisions.create, { ...base, title: who, owner: who, revisitOn: "2026-10-14" });
      }
      await t.mutation(internal.decisions.markRevisits, {});
      const [without] = (await noMemory.query(api.notifications.mine, {})).rows;
      expect(without).toMatchObject({ kind: "decision_revisit", decisionId: null });
      const [kept] = (await withMemory.query(api.notifications.mine, {})).rows;
      expect(kept!.decisionId).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a person without the memory page is refused", async () => {
    const t = convexTest(schema, modules);
    const sales = await signInWithAreas(t, "sales", ["sales", "board"]);
    await expect(sales.query(api.decisions.list, {})).rejects.toThrow("not_allowed");
  });
});
