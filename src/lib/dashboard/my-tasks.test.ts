import { describe, expect, test } from "vitest";
import { MY_TASKS_SHOWN, myOpenTasks, tasksForToday, type MyTask } from "./my-tasks";

const ME = "me@example.test";
const TODAY = "2026-10-12";
const NOW = Date.UTC(2026, 9, 12, 9);
const HOUR = 60 * 60 * 1000;

let n = 0;
const task = (title: string, patch: Partial<MyTask> = {}): MyTask => ({
  id: `t${++n}`,
  title,
  due: null,
  company: null,
  createdAt: NOW - 10 * 24 * HOUR,
  assignee: { email: ME },
  ...patch,
});
const board = (patch: Record<string, MyTask[]> = {}): Record<string, MyTask[]> => ({
  backlog: [],
  this_week: [],
  doing: [],
  done: [],
  ...patch,
});
const view = { email: ME, company: null, today: TODAY };
const titles = (tasks: readonly MyTask[]) => tasks.map((t) => t.title);

describe("my open tasks", () => {
  test("only mine, whatever the address's capitals; never someone else's, an unassigned one or a finished one", () => {
    const result = myOpenTasks(
      board({
        backlog: [
          task("mine"),
          task("capitals", { assignee: { email: "ME@Example.Test" } }),
          task("theirs", { assignee: { email: "other@example.test" } }),
          task("nobody's", { assignee: null }),
          task("unnamed", { assignee: { email: null } }),
        ],
        done: [task("finished")],
      }),
      view,
    );
    expect(titles(result.shown)).toEqual(["mine", "capitals"]);
    expect(result.total).toBe(2);
  });

  test("with no address on record there is nothing to call mine", () => {
    expect(myOpenTasks(board({ backlog: [task("a")] }), { ...view, email: null })).toEqual({
      shown: [],
      total: 0,
    });
  });

  test("only the company in view and the shared ones; every company's when none is in view", () => {
    const tasks = board({
      backlog: [task("us", { company: "us" }), task("kz", { company: "kz" }), task("shared")],
    });
    expect(titles(myOpenTasks(tasks, { ...view, company: "kz" }).shown)).toEqual(["kz", "shared"]);
    expect(titles(myOpenTasks(tasks, { ...view, company: "us" }).shown)).toEqual(["us", "shared"]);
    expect(titles(myOpenTasks(tasks, view).shown)).toEqual(["us", "kz", "shared"]);
  });

  test("overdue first, oldest first; then due within a week, soonest first; then the rest", () => {
    const result = myOpenTasks(
      board({
        backlog: [
          task("no date, backlog"),
          task("next month", { due: "2026-11-20" }),
          task("in a week", { due: "2026-10-19" }),
        ],
        this_week: [task("today", { due: "2026-10-12" }), task("yesterday", { due: "2026-10-11" })],
        doing: [task("no date, doing"), task("last month", { due: "2026-09-01" })],
      }),
      view,
    );
    expect(result.shown.map((t) => [t.title, t.when])).toEqual([
      ["last month", "overdue"],
      ["yesterday", "overdue"],
      ["today", "soon"],
      ["in a week", "soon"],
      // The rest: dated ones by date, then undated as the board has them
      // (doing, this week, backlog).
      ["next month", "later"],
      ["no date, doing", "later"],
      ["no date, backlog", "later"],
    ]);
  });

  test("eight at most, and the count of all of them", () => {
    expect(MY_TASKS_SHOWN).toBe(8);
    const many = Array.from({ length: 11 }, (_, i) => task(`task ${i}`));
    const result = myOpenTasks(board({ backlog: many }), view);
    expect(result.shown).toHaveLength(8);
    expect(result.total).toBe(11);
    // The cut never drops something late in favour of something that is not.
    const late = task("late", { due: "2026-10-01" });
    expect(myOpenTasks(board({ backlog: [...many, late] }), view).shown[0]!.title).toBe("late");
  });
});

describe("my tasks, for today", () => {
  test("due: overdue and due today, oldest first; nothing due later", () => {
    const result = tasksForToday(
      board({
        backlog: [task("tomorrow", { due: "2026-10-13" }), task("today", { due: "2026-10-12" })],
        doing: [task("late", { due: "2026-10-02" }), task("no date")],
        done: [task("done late", { due: "2026-10-01" })],
      }),
      { ...view, now: NOW },
    );
    expect(result.due.map((t) => [t.title, t.when])).toEqual([
      ["late", "overdue"],
      ["today", "today"],
    ]);
  });

  test("new: mine, added in the last day, and not already listed as due", () => {
    const result = tasksForToday(
      board({
        backlog: [
          task("an hour ago", { createdAt: NOW - HOUR }),
          task("23 hours ago", { createdAt: NOW - 23 * HOUR }),
          task("25 hours ago", { createdAt: NOW - 25 * HOUR }),
          task("new and due", { createdAt: NOW - HOUR, due: "2026-10-12" }),
          task("someone else's", { createdAt: NOW - HOUR, assignee: { email: "x@example.test" } }),
        ],
      }),
      { ...view, now: NOW },
    );
    expect(titles(result.fresh)).toEqual(["an hour ago", "23 hours ago"]);
    expect(titles(result.due)).toEqual(["new and due"]);
  });

  test("the company in view holds there too", () => {
    const result = tasksForToday(
      board({
        backlog: [
          task("us late", { company: "us", due: "2026-10-01" }),
          task("kz new", { company: "kz", createdAt: NOW - HOUR }),
        ],
      }),
      { ...view, company: "kz", now: NOW },
    );
    expect(titles(result.due)).toEqual([]);
    expect(titles(result.fresh)).toEqual(["kz new"]);
  });
});
