import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { PAY_NEEDS_PAYROLL } from "./budget";
import { costLinesFor, costSummaryFor } from "./costs";
import type { Member } from "./lib/owner";
import { AREAS, PAY_AND_COSTS_ARE_THE_OWNERS, effectiveAreas } from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  addMember,
  modules,
  signInAs,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// The owner's decision: "Payroll is mine alone". Payroll and costs (which
// carries the burn and the run-rate incl. pay) can be held by no teammate,
// whatever their row, role or named role says. What keeps it so is tested
// here: the team and roles mutations refuse them in fixed words, a row from
// before still opens nothing, and the one-off migration takes them out of
// every stored list. Every name and amount here is made up.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const NEW = {
  email: "new.person@gmail.com",
  role: "cofounder" as const,
  companies: ["kz" as const],
};
const members = (t: TestBackend) => t.run((ctx) => ctx.db.query("members").collect());
const roles = (t: TestBackend) => t.run((ctx) => ctx.db.query("roles").collect());

describe("the team cannot give them", () => {
  test.each([["payroll"], ["costs"], ["finance", "payroll"], ["board", "costs"]])(
    "the owner adding someone with %s is refused, and nobody is added",
    async (...areas) => {
      const t = convexTest(schema, modules);
      const owner = await signInAsOwner(t);
      await expect(owner.mutation(api.team.add, { ...NEW, areas })).rejects.toThrow(
        PAY_AND_COSTS_ARE_THE_OWNERS,
      );
      expect(await members(t)).toEqual([]);
    },
  );

  test("the owner cannot tick either for someone already on the team", async () => {
    const t = convexTest(schema, modules);
    const id = await addMember(t, { email: NEW.email, role: "cofounder", companies: ["kz"], areas: ["finance"] });
    const owner = await signInAsOwner(t);
    for (const areas of [["finance", "payroll"], ["finance", "costs"]]) {
      await expect(
        owner.mutation(api.team.update, { id, role: "cofounder", companies: ["kz"], areas }),
      ).rejects.toThrow(PAY_AND_COSTS_ARE_THE_OWNERS);
    }
    expect((await t.run((ctx) => ctx.db.get(id)))?.areas).toEqual(["finance"]);
  });

  test("nor can someone who manages the team", async () => {
    const t = convexTest(schema, modules);
    await addMember(t, { email: "manager@gmail.com", role: "engineer", companies: ["kz"], areas: ["team"] });
    const manager = await signInAs(t, { email: "manager@gmail.com", emailVerificationTime: 1 });
    await expect(
      manager.mutation(api.team.add, { ...NEW, areas: ["sales", "payroll"] }),
    ).rejects.toThrow(PAY_AND_COSTS_ARE_THE_OWNERS);
    expect(await members(t)).toHaveLength(1);
  });

  test("a row from before is saved without them, as the team page sends it back", async () => {
    const t = convexTest(schema, modules);
    const id = await addMember(t, {
      email: NEW.email,
      role: "cofounder",
      companies: ["kz"],
      areas: ["finance", "payroll", "costs"],
    });
    const owner = await signInAsOwner(t);
    const listed = (await owner.query(api.team.list, {})).find((row) => row.id === id)!;
    expect(listed.areas).toEqual(["finance"]);
    await owner.mutation(api.team.update, { id, role: "cofounder", companies: ["kz"], areas: listed.areas });
    expect((await t.run((ctx) => ctx.db.get(id)))?.areas).toEqual(["finance"]);
  });
});

describe("the record of team changes keeps what was so", () => {
  test("a change from before that gave Payroll is still listed as widening someone's reach", async () => {
    const t = convexTest(schema, modules);
    const id = await addMember(t, { email: NEW.email, role: "sales", companies: ["kz"], areas: ["sales"] });
    await t.run(async (ctx) => {
      const actor = await ctx.db.insert("users", {});
      // As the first version wrote them: no mark at all.
      await ctx.db.insert("teamChanges", {
        at: 1,
        kind: "update",
        actor,
        member: id,
        before: { role: "sales", companies: ["kz"], areas: ["sales"] },
        after: { role: "sales", companies: ["kz"], areas: ["sales", "payroll"] },
      });
    });
    const owner = await signInAsOwner(t);
    const { widened } = await owner.query(api.team.changes, {});
    expect(widened.map((row) => row.after?.areas)).toEqual([["sales", "payroll"]]);
  });
});

describe("a named role cannot hold them", () => {
  const product = { name: "Product", focus: "engineering" as const, areas: ["product", "board"] };

  test.each(["payroll", "costs"])("creating a role with %s is refused in fixed words", async (area) => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.roles.create, { ...product, areas: ["board", area] }),
    ).rejects.toThrow(PAY_AND_COSTS_ARE_THE_OWNERS);
    expect(await roles(t)).toEqual([]);
  });

  test.each(["payroll", "costs"])("changing a role to hold %s is refused too", async (area) => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.roles.create, product);
    await expect(owner.mutation(api.roles.update, { id, ...product, areas: [area] })).rejects.toThrow(
      PAY_AND_COSTS_ARE_THE_OWNERS,
    );
    expect((await roles(t))[0]!.areas).toEqual(["product", "board"]);
  });

  test("a role stored from before is listed without them", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.roles.create, product);
    await t.run((ctx) => ctx.db.patch(id, { areas: ["product", "payroll", "costs", "board"] }));
    const listed = (await owner.query(api.roles.list, {})).find((row) => row.id === id)!;
    expect(listed.areas).toEqual(["product", "board"]);
  });
});

describe("a teammate whose row still says payroll or costs", () => {
  const legacy = (t: TestBackend) =>
    signInWithAreas(t, "cofounder", ["finance", "scorecard", "payroll", "costs"], ["us", "kz"]);

  test("is told neither is theirs", async () => {
    const t = convexTest(schema, modules);
    const me = await (await legacy(t)).query(api.viewer.me, {});
    expect(me).toMatchObject({ isMember: true, areas: ["scorecard", "finance"] });
  });

  test("is refused every payroll and costs read and write", async () => {
    const t = convexTest(schema, modules);
    const client = await legacy(t);
    await expect(client.query(api.payroll.listPeople, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(client.query(api.payroll.listLines, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(client.query(api.payroll.listRuns, { company: "kz" })).rejects.toThrow("not_allowed");
    await expect(client.query(api.costs.list, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(
      client.query(api.costs.summary, { company: "us", month: "2026-10" }),
    ).rejects.toThrow("not_allowed");
    await expect(
      client.mutation(api.payroll.createPerson, {
        company: "kz",
        name: "Made up",
        kind: "employee",
        monthlyGross: 1,
      }),
    ).rejects.toThrow("not_allowed");
  });

  test("gets the budget as a Finance holder without Payroll and Costs does: neither row", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.budget.setCells, {
      company: "kz",
      cells: [
        { month: "2026-10", category: "payroll", amount: 777_000_00 },
        { month: "2026-10", category: "cloud", amount: 555_000_00 },
      ],
    });
    const client = await legacy(t);
    const view = await client.query(api.budget.view, { company: "kz", first: "2026-10", count: 1 });
    expect(view).toMatchObject({ payroll: "hidden", costs: "hidden", cells: [] });
    await expect(
      client.mutation(api.budget.setCells, {
        company: "kz",
        cells: [{ month: "2026-10", category: "payroll", amount: 1 }],
      }),
    ).rejects.toThrow(PAY_NEEDS_PAYROLL);
  });

  test("the owner still reads and writes both", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.payroll.listPeople, { company: "kz" })).toEqual([]);
    expect(await owner.query(api.costs.list, { company: "us" })).toEqual([]);
    const view = await owner.query(api.budget.view, { company: "kz", first: "2026-10", count: 1 });
    expect(view).toMatchObject({ payroll: "shown", costs: "shown" });
  });
});

describe("the cost register's helpers refuse a caller without Costs themselves", () => {
  // budget.ts and the owner's agent call these; a new caller that forgot to
  // ask `may` first would still hand a teammate nothing.
  const as = (areas: Member["areas"]): Member => ({
    user: {} as Doc<"users">,
    role: "cofounder",
    companies: ["us", "kz"],
    areas,
  });

  test("a teammate's areas, even read from a row that says costs, are refused", async () => {
    const t = convexTest(schema, modules);
    const teammate = as(effectiveAreas("cofounder", ["finance", "costs", "payroll"]));
    await t.run(async (ctx) => {
      await expect(costLinesFor(ctx, teammate, "us")).rejects.toThrow("not_allowed");
      await expect(costSummaryFor(ctx, teammate, "us", "2026-10")).rejects.toThrow("not_allowed");
    });
  });

  test("the owner's are let in", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(await costLinesFor(ctx, { ...as(AREAS), role: "owner" }, "us")).toEqual([]);
    });
  });
});

describe("migrations:dropOwnerOnlyAreas", () => {
  test("takes payroll and costs out of every row and role, and says only how many", async () => {
    const t = convexTest(schema, modules);
    const a = await addMember(t, { email: "a@gmail.com", role: "cofounder", areas: ["finance", "payroll"] });
    const b = await addMember(t, { email: "b@gmail.com", role: "sales", areas: ["costs"] });
    const c = await addMember(t, { email: "c@gmail.com", role: "sales", areas: ["sales", "team"] });
    // A row from before pages could be picked has no list, and is left as it is.
    const d = await addMember(t, { email: "d@gmail.com", role: "engineer" });
    const owner = await signInAsOwner(t);
    const kept = await owner.mutation(api.roles.create, { name: "Ops", focus: "general", areas: ["board"] });
    const old = await owner.mutation(api.roles.create, { name: "Old", focus: "general", areas: ["board"] });
    await t.run((ctx) => ctx.db.patch(old, { areas: ["payroll", "board", "costs"] }));

    const result = await t.mutation(internal.migrations.dropOwnerOnlyAreas, {});
    expect(result).toEqual({ membersChanged: 2, rolesChanged: 1 });

    const after = await t.run(async (ctx) => ({
      a: (await ctx.db.get(a))?.areas,
      b: (await ctx.db.get(b))?.areas,
      c: (await ctx.db.get(c))?.areas,
      d: (await ctx.db.get(d))?.areas,
      kept: (await ctx.db.get(kept))?.areas,
      old: (await ctx.db.get(old))?.areas,
    }));
    expect(after).toEqual({
      a: ["finance"],
      b: [],
      c: ["sales", "team"],
      d: undefined,
      kept: ["board"],
      old: ["board"],
    });

    // A second run finds nothing to change.
    expect(await t.mutation(internal.migrations.dropOwnerOnlyAreas, {})).toEqual({
      membersChanged: 0,
      rolesChanged: 0,
    });
  });
});
