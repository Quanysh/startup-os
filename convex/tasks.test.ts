import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { moveOnBoard } from "../src/lib/board";
import { DONE_LIMIT, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./lib/limits";
import { OWNER, modules, signInAsOwner } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;

const add = (owner: Owner, title: string, extra: Record<string, unknown> = {}) =>
  owner.mutation(api.tasks.create, { title, ...extra });

const titles = async (owner: Owner) => {
  const board = await owner.query(api.tasks.board, {});
  return Object.fromEntries(
    Object.entries(board).map(([column, tasks]) => [column, tasks.map((t) => t.title)]),
  );
};

describe("tasks.create", () => {
  test("a new task goes to the bottom of the backlog", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "First");
    await add(owner, "Second");
    expect(await titles(owner)).toEqual({
      backlog: ["First", "Second"],
      this_week: [],
      doing: [],
      done: [],
    });
  });

  test("asked for the top, a new task goes first in its column", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "First");
    await add(owner, "Second");
    await add(owner, "On top", { index: 0 });
    await add(owner, "Planned", { column: "this_week" });
    await add(owner, "Planned first", { column: "this_week", index: 0 });
    await add(owner, "Last again");
    expect(await titles(owner)).toEqual({
      backlog: ["On top", "First", "Second", "Last again"],
      this_week: ["Planned first", "Planned"],
      doing: [],
      done: [],
    });
    // The stored order is a plain 0, 1, 2, … again.
    const orders = await t.run(async (ctx) =>
      (await ctx.db.query("tasks").withIndex("by_column_and_order", (q) => q.eq("column", "backlog")).collect()).map(
        (task) => task.order,
      ),
    );
    expect(orders).toEqual([0, 1, 2, 3]);
  });

  test("a position in Done means nothing: it is ordered by finish time", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "Finished", { column: "done", index: 0 });
    expect((await titles(owner)).done).toEqual(["Finished"]);
  });

  test("a task can be created straight into another column", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "Call the CFO", { column: "this_week" });
    expect((await titles(owner)).this_week).toEqual(["Call the CFO"]);
  });

  test("the title is trimmed and may not be blank", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "  Tidy  ");
    expect((await titles(owner)).backlog).toEqual(["Tidy"]);
    await expect(add(owner, "  ")).rejects.toThrow("needs a title");
  });

  test("a title or note far longer than anyone would type is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(add(owner, "x".repeat(MAX_TITLE_LENGTH + 1))).rejects.toThrow("too long");
    await expect(
      add(owner, "ok", { notes: "x".repeat(MAX_NOTES_LENGTH + 1) }),
    ).rejects.toThrow("too long");
  });

  test("a task created straight into done is stamped as finished", async () => {
    // "Done" is read by finish time; a card without one would never show.
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "Already finished", { column: "done" });
    const board = await owner.query(api.tasks.board, {});
    expect(board.done[0]).toMatchObject({ title: "Already finished" });
    expect(board.done[0]?.doneAt).toBeTypeOf("number");
  });

  test("an issue is a task of kind issue", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "Churn risk at one clinic", { kind: "issue" });
    const board = await owner.query(api.tasks.board, {});
    expect(board.backlog[0]?.kind).toBe("issue");
  });

  test("a due date must be a real date", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(add(owner, "x", { due: "2026-02-30" })).rejects.toThrow("is not a date");
    await add(owner, "y", { due: "2026-10-20" });
    expect((await owner.query(api.tasks.board, {})).backlog[0]?.due).toBe("2026-10-20");
  });
});

describe("tasks.move", () => {
  test("reorders within a column", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "A");
    await add(owner, "B");
    const c = await add(owner, "C");
    await owner.mutation(api.tasks.move, { id: c, column: "backlog", index: 0 });
    expect((await titles(owner)).backlog).toEqual(["C", "A", "B"]);
  });

  test("moves to a position in another column and closes the gap behind it", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await add(owner, "A");
    await add(owner, "B");
    await add(owner, "X", { column: "doing" });
    await add(owner, "Y", { column: "doing" });
    await owner.mutation(api.tasks.move, { id: a, column: "doing", index: 1 });
    expect(await titles(owner)).toMatchObject({ backlog: ["B"], doing: ["X", "A", "Y"] });
  });

  test("finishing a task stamps the time, and reopening it clears the stamp", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await add(owner, "A");
    await owner.mutation(api.tasks.move, { id: a, column: "done", index: 0 });
    expect((await t.run((ctx) => ctx.db.get(a)))?.doneAt).toBeTypeOf("number");
    await owner.mutation(api.tasks.move, { id: a, column: "doing", index: 0 });
    expect((await t.run((ctx) => ctx.db.get(a)))?.doneAt).toBeUndefined();
  });

  test("a card moved out of done lands where it was put in a populated column", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "X", { column: "doing" });
    await add(owner, "Y", { column: "doing" });
    const z = await add(owner, "Z", { column: "done" });
    await owner.mutation(api.tasks.move, { id: z, column: "doing", index: 1 });
    expect(await titles(owner)).toMatchObject({ doing: ["X", "Z", "Y"], done: [] });
  });

  test("moving a card within done changes nothing, because done is ordered by finish time", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await add(owner, "Finished first");
    const b = await add(owner, "Finished second");
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
    await owner.mutation(api.tasks.move, { id: a, column: "done", index: 0 });
    vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
    await owner.mutation(api.tasks.move, { id: b, column: "done", index: 0 });
    const stamp = (await t.run((ctx) => ctx.db.get(a)))?.doneAt;

    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    await owner.mutation(api.tasks.move, { id: a, column: "done", index: 0 });

    expect((await titles(owner)).done).toEqual(["Finished second", "Finished first"]);
    expect((await t.run((ctx) => ctx.db.get(a)))?.doneAt).toBe(stamp);
  });

  test("moving a card that was deleted meanwhile says so", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await add(owner, "A");
    await owner.mutation(api.tasks.remove, { id: a });
    await expect(
      owner.mutation(api.tasks.move, { id: a, column: "doing", index: 0 }),
    ).rejects.toThrow("no longer exists");
  });

  test("what the board shows at once matches what the server stores", async () => {
    // The page moves the card on screen before the server answers
    // (moveOnBoard). If the two ever disagree the card visibly jumps.
    const moves: [string, "backlog" | "this_week" | "doing" | "done", number][] = [
      ["A", "doing", 1],
      ["B", "backlog", 5],
      ["X", "done", 0],
      ["C", "doing", 0],
      ["Y", "this_week", 0],
      ["X", "backlog", 1],
      ["A", "done", 3],
    ];
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    for (const title of ["A", "B", "C"]) await add(owner, title);
    for (const title of ["X", "Y"]) await add(owner, title, { column: "doing" });

    for (const [title, column, index] of moves) {
      const before = await owner.query(api.tasks.board, {});
      const card = Object.values(before)
        .flat()
        .find((c) => c.title === title)!;
      const predicted = moveOnBoard(before, card.id, column, column === "done" ? 0 : index);
      await owner.mutation(api.tasks.move, { id: card.id, column, index });
      const after = await owner.query(api.tasks.board, {});
      const ids = (b: typeof after) =>
        Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((c) => c.id)]));
      expect(ids(after), `${title} → ${column}[${index}]`).toEqual(ids(predicted));
    }
  });

  test("done lists the most recently finished first", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const a = await add(owner, "Finished first");
    const b = await add(owner, "Finished second");
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
    await owner.mutation(api.tasks.move, { id: a, column: "done", index: 0 });
    vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
    await owner.mutation(api.tasks.move, { id: b, column: "done", index: 0 });
    expect((await titles(owner)).done).toEqual(["Finished second", "Finished first"]);
  });

  test("done shows only the most recent tasks", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < DONE_LIMIT + 5; i++) {
        await ctx.db.insert("tasks", {
          title: `Done ${i}`,
          kind: "task",
          column: "done",
          order: 0,
          doneAt: 1_000 + i,
        });
      }
    });
    const board = await owner.query(api.tasks.board, {});
    expect(board.done).toHaveLength(DONE_LIMIT);
    expect(board.done[0]?.title).toBe(`Done ${DONE_LIMIT + 4}`);
  });
});

describe("tasks.update and remove", () => {
  test("edits the fields given and leaves the rest", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await add(owner, "Draft update", { notes: "First pass" });
    await owner.mutation(api.tasks.update, { id, title: "Send update", due: "2026-10-31" });
    const [task] = (await owner.query(api.tasks.board, {})).backlog;
    expect(task).toMatchObject({ title: "Send update", notes: "First pass", due: "2026-10-31" });
  });

  test("the editor can change the column in the same save", async () => {
    // One mutation, so a failure cannot leave the fields saved and the card
    // unmoved. A card that changes column goes to the top of the new one.
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "Existing", { column: "doing" });
    const id = await add(owner, "Draft");
    await owner.mutation(api.tasks.update, { id, title: "Final", column: "doing" });
    expect(await titles(owner)).toMatchObject({ backlog: [], doing: ["Final", "Existing"] });
  });

  test("changing the column to done through the editor stamps the finish time", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await add(owner, "Ship it");
    await owner.mutation(api.tasks.update, { id, column: "done" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.doneAt).toBeTypeOf("number");
    await owner.mutation(api.tasks.update, { id, column: "backlog" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.doneAt).toBeUndefined();
  });

  test("editing a card that was deleted meanwhile says so", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await add(owner, "x");
    await owner.mutation(api.tasks.remove, { id });
    await expect(owner.mutation(api.tasks.update, { id, title: "y" })).rejects.toThrow(
      "no longer exists",
    );
  });

  test("null clears an optional field", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await add(owner, "x", { due: "2026-10-31", notes: "n" });
    await owner.mutation(api.tasks.update, { id, due: null, notes: null });
    const [task] = (await owner.query(api.tasks.board, {})).backlog;
    expect(task?.due).toBeNull();
    expect(task?.notes).toBeNull();
  });

  test("a task cannot be linked to a goal that does not exist", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const goalId = await owner.mutation(api.goals.create, { quarter: "2026-Q4", title: "g" });
    await owner.mutation(api.goals.remove, { id: goalId });
    await expect(add(owner, "x", { goalId })).rejects.toThrow("goal no longer exists");
  });

  test("the board carries the linked goal's title", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const goalId = await owner.mutation(api.goals.create, {
      quarter: "2026-Q4",
      title: "Raise seed",
    });
    await add(owner, "Send deck", { goalId });
    expect((await owner.query(api.tasks.board, {})).backlog[0]?.goalTitle).toBe("Raise seed");
  });

  test("remove deletes the task", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await add(owner, "x");
    await owner.mutation(api.tasks.remove, { id });
    expect((await titles(owner)).backlog).toEqual([]);
  });
});

describe("tasks.openIssues", () => {
  test("lists issues that are not done, soonest board position first", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await add(owner, "A plain task");
    await add(owner, "Backlog issue", { kind: "issue" });
    await add(owner, "Active issue", { kind: "issue", column: "doing" });
    const solved = await add(owner, "Solved issue", { kind: "issue" });
    await owner.mutation(api.tasks.move, { id: solved, column: "done", index: 0 });
    const issues = await owner.query(api.tasks.openIssues, {});
    expect(issues.map((i) => i.title)).toEqual(["Active issue", "Backlog issue"]);
  });
});

test("a signed-out caller cannot read the board", async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
});
