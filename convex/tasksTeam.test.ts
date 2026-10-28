import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { moveOnBoard } from "../src/lib/board";
import { DONE_LIMIT } from "./lib/limits";
import schema from "./schema";
import { ASSIGNEE_NOT_ON_COMPANY, CANNOT_ASSIGN, CANNOT_MENTION } from "./tasks";
import {
  OWNER,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// Tasks once there is a team: who a task can be given to, which company it
// is of, and what a teammate on one company sees and may move.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

const US_SALES = memberEmail("sales", ["us"]);
const KZ_ENGINEER = memberEmail("engineer", ["kz"]);
const COFOUNDER = memberEmail("cofounder");

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const usSales = await signInAsSales(t, ["us"]);
  const kzEngineer = await signInAsEngineer(t, ["kz"]);
  const cofounder = await signInAsCofounder(t);
  return { t, owner, usSales, kzEngineer, cofounder };
};
const stored = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const cards = async (client: Client) => Object.values(await client.query(api.tasks.board, {})).flat();
const backlog = async (client: Client) =>
  (await client.query(api.tasks.board, {})).backlog.map((task) => task.title);

describe("a card added at the top by a teammate", () => {
  test("goes above the first card they see; the other company's keep their order", async () => {
    const { owner, kzEngineer } = await start();
    await owner.mutation(api.tasks.create, { title: "US one", company: "us" });
    await owner.mutation(api.tasks.create, { title: "KZ one", company: "kz" });
    await owner.mutation(api.tasks.create, { title: "US two", company: "us" });
    await kzEngineer.mutation(api.tasks.create, { title: "KZ new", company: "kz", index: 0 });
    expect(await backlog(kzEngineer)).toEqual(["KZ new", "KZ one"]);
    expect(await backlog(owner)).toEqual(["US one", "KZ new", "KZ one", "US two"]);
  });
});

describe("who can take work: the board, on the company", () => {
  // A person without the board can open no page that shows a task (the board,
  // Today's "your tasks" and a notification's link all need it), so a task is
  // never given to them, as a handoff is not: one rule for both.
  test("a teammate without the board is not offered, cannot be given a task and cannot be mentioned", async () => {
    const { t, owner } = await start();
    await signInWithAreas(t, "engineer", ["sales"], ["us"]);
    const noBoard = memberEmail("engineer", ["us"]);
    const offered = (await owner.query(api.team.assignable, { company: "us" })).map((p) => p.email);
    expect(offered).not.toContain(noBoard);
    expect(offered).toContain(OWNER);
    await expect(owner.mutation(api.tasks.create, { title: "Theirs", company: "us", assignee: noBoard })).rejects.toThrow(
      CANNOT_ASSIGN,
    );
    const id = await owner.mutation(api.tasks.create, { title: "Someone's", company: "us" });
    await expect(owner.mutation(api.tasks.update, { id, assignee: noBoard })).rejects.toThrow(CANNOT_ASSIGN);
    await expect(owner.mutation(api.tasks.update, { id, mentions: [noBoard] })).rejects.toThrow(CANNOT_MENTION);
  });
});

describe("rows from before there was a team", () => {
  test("a task with none of the new fields is shared, unassigned and still editable", async () => {
    const { t, owner, kzEngineer } = await start();
    const id = await t.run((ctx) =>
      ctx.db.insert("tasks", { title: "Old task", kind: "task", column: "backlog", order: 0 }),
    );
    for (const client of [owner, kzEngineer]) {
      expect((await cards(client))[0]).toMatchObject({
        title: "Old task",
        company: null,
        assignee: null,
      });
    }
    await kzEngineer.mutation(api.tasks.update, { id, title: "Old task, renamed" });
    await kzEngineer.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    expect((await stored(t))[0]).toMatchObject({ title: "Old task, renamed", column: "doing" });
    await kzEngineer.mutation(api.tasks.remove, { id });
    expect(await stored(t)).toEqual([]);
  });
});

describe("tasks.create with a team", () => {
  test("it records who made it, its company and its assignee, lower-cased", async () => {
    const { t, usSales } = await start();
    await usSales.mutation(api.tasks.create, {
      title: "Call back",
      company: "us",
      assignee: `  ${COFOUNDER.toUpperCase()} `,
    });
    const [task] = await stored(t);
    expect(task).toMatchObject({ company: "us", assignee: COFOUNDER });
    const maker = await t.run((ctx) => ctx.db.get(task!.createdBy!));
    expect(maker?.email).toBe(US_SALES);
  });

  test("with neither, it is shared and nobody's", async () => {
    const { t, usSales } = await start();
    await usSales.mutation(api.tasks.create, { title: "Tidy", assignee: null, company: null });
    const [task] = await stored(t);
    expect(task?.company).toBeUndefined();
    expect(task?.assignee).toBeUndefined();
  });
});

describe("who a task can be given to", () => {
  const give = (client: Client, assignee: string, company?: "us" | "kz") =>
    client.mutation(api.tasks.create, { title: "x", assignee, company });

  test("the owner, by anyone", async () => {
    const { t, usSales, kzEngineer } = await start();
    await give(usSales, OWNER, "us");
    await give(kzEngineer, OWNER);
    expect((await stored(t)).map((task) => task.assignee)).toEqual([OWNER, OWNER]);
  });

  test("a teammate who shares a company with the task and with the caller", async () => {
    const { t, usSales, owner } = await start();
    await give(usSales, COFOUNDER, "us");
    await give(usSales, US_SALES);
    await give(owner, KZ_ENGINEER, "kz");
    expect((await stored(t)).map((task) => task.assignee)).toEqual([
      COFOUNDER,
      US_SALES,
      KZ_ENGINEER,
    ]);
  });

  test("not someone who is not on the task's company", async () => {
    const { t, owner, cofounder } = await start();
    await expect(give(owner, KZ_ENGINEER, "us")).rejects.toThrow(CANNOT_ASSIGN);
    await expect(give(cofounder, US_SALES, "kz")).rejects.toThrow(CANNOT_ASSIGN);
    expect(await stored(t)).toEqual([]);
  });

  test("not, on a shared task, someone the caller shares no company with", async () => {
    // Otherwise the answer would tell a teammate who is on the other company.
    const { t, usSales } = await start();
    await expect(give(usSales, KZ_ENGINEER)).rejects.toThrow(CANNOT_ASSIGN);
    expect(await stored(t)).toEqual([]);
  });

  test("an address that is nobody's gets the same words, and is not quoted back", async () => {
    const { usSales } = await start();
    const attempt = give(usSales, "nobody.at.all@gmail.com");
    await expect(attempt).rejects.toThrow(CANNOT_ASSIGN);
    await attempt.catch((error: Error) => expect(error.message).not.toContain("nobody.at.all"));
    const other = give(usSales, KZ_ENGINEER);
    await other.catch((error: Error) => expect(error.message).not.toContain(KZ_ENGINEER));
  });

  test("update assigns, reassigns and, with null, unassigns", async () => {
    const { t, owner, usSales } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "x", company: "us" });
    await usSales.mutation(api.tasks.update, { id, assignee: US_SALES });
    expect((await stored(t))[0]?.assignee).toBe(US_SALES);
    await expect(usSales.mutation(api.tasks.update, { id, assignee: KZ_ENGINEER })).rejects.toThrow(
      CANNOT_ASSIGN,
    );
    // Leaving it out keeps it.
    await usSales.mutation(api.tasks.update, { id, title: "y" });
    expect((await stored(t))[0]?.assignee).toBe(US_SALES);
    await usSales.mutation(api.tasks.update, { id, assignee: null });
    expect((await stored(t))[0]?.assignee).toBeUndefined();
  });

  test("a new assignee is checked against the company the same edit gives the task", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "x", company: "us" });
    await expect(
      owner.mutation(api.tasks.update, { id, assignee: KZ_ENGINEER }),
    ).rejects.toThrow(CANNOT_ASSIGN);
    await owner.mutation(api.tasks.update, { id, assignee: KZ_ENGINEER, company: "kz" });
    expect((await stored(t))[0]).toMatchObject({ assignee: KZ_ENGINEER, company: "kz" });
  });

  test("a task cannot move to a company its assignee is not on", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "x", assignee: US_SALES });
    await expect(owner.mutation(api.tasks.update, { id, company: "kz" })).rejects.toThrow(
      ASSIGNEE_NOT_ON_COMPANY,
    );
    expect((await stored(t))[0]?.company).toBeUndefined();
    await owner.mutation(api.tasks.update, { id, company: "us" });
    await owner.mutation(api.tasks.update, { id, company: null });
    expect((await stored(t))[0]).toMatchObject({ assignee: US_SALES });
    expect((await stored(t))[0]?.company).toBeUndefined();
  });

  test("a removed teammate's task can still be moved to a company", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "x", assignee: US_SALES });
    const row = (await owner.query(api.team.list, {})).find((m) => m.email === US_SALES)!;
    await owner.mutation(api.team.remove, { id: row.id });
    await owner.mutation(api.tasks.update, { id, company: "kz" });
    expect((await stored(t))[0]).toMatchObject({ assignee: US_SALES, company: "kz" });
  });
});

describe("how an assignee is shown", () => {
  test("a teammate the caller shares a company with: address and name", async () => {
    const { t, owner, usSales } = await start();
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", COFOUNDER))
        .first();
      await ctx.db.patch(user!._id, { name: "Co Founder" });
    });
    await owner.mutation(api.tasks.create, { title: "x", assignee: COFOUNDER });
    await owner.mutation(api.tasks.create, { title: "y", assignee: OWNER });
    const [first, second] = await cards(usSales);
    expect(first?.assignee).toEqual({ status: "teammate", email: COFOUNDER, name: "Co Founder" });
    expect(second?.assignee).toEqual({ status: "teammate", email: OWNER, name: null });
  });

  test("someone on the other company alone: neither address nor name", async () => {
    const { owner, usSales, kzEngineer } = await start();
    await owner.mutation(api.tasks.create, { title: "Shared", assignee: KZ_ENGINEER });
    expect((await cards(usSales))[0]?.assignee).toEqual({
      status: "elsewhere",
      email: null,
      name: null,
    });
    expect(JSON.stringify(await usSales.query(api.tasks.board, {}))).not.toContain(KZ_ENGINEER);
    expect(JSON.stringify(await usSales.query(api.tasks.openIssues, {}))).not.toContain(KZ_ENGINEER);
    expect((await cards(kzEngineer))[0]?.assignee).toMatchObject({
      status: "teammate",
      email: KZ_ENGINEER,
    });
  });
});

describe("moving a card past cards the caller cannot see", () => {
  const seedColumn = async (owner: Client) => {
    // The whole backlog, in order: A (us), K (kz), B (us), L (kz), C (shared).
    for (const [title, company] of [
      ["A", "us"],
      ["K", "kz"],
      ["B", "us"],
      ["L", "kz"],
      ["C", null],
    ] as const) {
      await owner.mutation(api.tasks.create, { title, company });
    }
  };
  const idOf = async (client: Client, title: string) =>
    (await cards(client)).find((task) => task.title === title)!.id;

  test("the index counts the cards the caller sees, and hidden cards keep their order", async () => {
    const { owner, usSales } = await start();
    await seedColumn(owner);
    expect(await backlog(usSales)).toEqual(["A", "B", "C"]);

    await usSales.mutation(api.tasks.move, {
      id: await idOf(usSales, "C"),
      column: "backlog",
      index: 0,
    });
    expect(await backlog(usSales)).toEqual(["C", "A", "B"]);
    expect(await backlog(owner)).toEqual(["C", "A", "K", "B", "L"]);

    await usSales.mutation(api.tasks.move, {
      id: await idOf(usSales, "C"),
      column: "backlog",
      index: 9,
    });
    expect(await backlog(usSales)).toEqual(["A", "B", "C"]);
    expect((await backlog(owner)).filter((title) => title === "K" || title === "L")).toEqual([
      "K",
      "L",
    ]);
  });

  test("cards the caller cannot see at the top of a column do not shift where a card lands", async () => {
    const { owner, usSales } = await start();
    // The whole backlog: K (kz), L (kz), A (us), B (us), C (shared).
    for (const [title, company] of [
      ["K", "kz"],
      ["L", "kz"],
      ["A", "us"],
      ["B", "us"],
      ["C", null],
    ] as const) {
      await owner.mutation(api.tasks.create, { title, company });
    }
    // Second place on their board is between A and B, not between K and L.
    await usSales.mutation(api.tasks.move, {
      id: await idOf(usSales, "C"),
      column: "backlog",
      index: 1,
    });
    expect(await backlog(usSales)).toEqual(["A", "C", "B"]);
    expect(await backlog(owner)).toEqual(["K", "L", "A", "C", "B"]);
  });

  test("what the caller's board shows at once matches what the server stores", async () => {
    const { owner, usSales } = await start();
    await seedColumn(owner);
    const moves: [string, "backlog" | "this_week" | "doing", number][] = [
      ["B", "backlog", 0],
      ["A", "doing", 0],
      ["C", "backlog", 1],
      ["A", "backlog", 1],
      ["B", "backlog", 2],
    ];
    for (const [title, column, index] of moves) {
      const before = await usSales.query(api.tasks.board, {});
      const id = await idOf(usSales, title);
      const predicted = moveOnBoard(before, id, column, index);
      await usSales.mutation(api.tasks.move, { id, column, index });
      const after = await usSales.query(api.tasks.board, {});
      const ids = (b: typeof after) =>
        Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((c) => c.id)]));
      expect(ids(after), `${title} → ${column}[${index}]`).toEqual(ids(predicted));
    }
    // The other company's cards never moved relative to each other.
    expect((await backlog(owner)).filter((title) => title === "K" || title === "L")).toEqual([
      "K",
      "L",
    ]);
  });
});

describe("finished tasks", () => {
  test("the latest of the caller's own, however many the other company finished since", async () => {
    const { t, usSales } = await start();
    await t.run(async (ctx) => {
      const done = (title: string, company: "us" | "kz", doneAt: number) =>
        ctx.db.insert("tasks", { title, kind: "task", column: "done", order: 0, company, doneAt });
      for (let n = 0; n < DONE_LIMIT; n += 1) await done(`ours ${n}`, "us", n);
      for (let n = 0; n < DONE_LIMIT + 5; n += 1) await done(`SECRET ${n}`, "kz", 1_000 + n);
    });
    const { done } = await usSales.query(api.tasks.board, {});
    expect(done).toHaveLength(DONE_LIMIT);
    expect(done.every((task) => task.title.startsWith("ours"))).toBe(true);
    expect(done[0]?.title).toBe(`ours ${DONE_LIMIT - 1}`);
  });
});
