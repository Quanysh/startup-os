import { describe, expect, test } from "vitest";
import { taskSummary, type SummaryTask } from "./tasks";

const task = (patch: Partial<SummaryTask> = {}): SummaryTask => ({
  due: null,
  assignee: null,
  ...patch,
});
const TODAY = "2026-10-12";
const ME = "me@example.com";
const board = (patch: Partial<Record<string, SummaryTask[]>> = {}) => ({
  backlog: [],
  this_week: [],
  doing: [],
  done: [],
  ...patch,
});

describe("taskSummary", () => {
  test("open is everything not done; doing is its own column", () => {
    const summary = taskSummary(
      board({ backlog: [task()], this_week: [task(), task()], doing: [task()], done: [task()] }),
      { email: ME, today: TODAY },
    );
    expect(summary).toMatchObject({ open: 4, doing: 1 });
  });

  test("mine counts open tasks assigned to the viewer, whatever the address's case", () => {
    const summary = taskSummary(
      board({
        backlog: [
          task({ assignee: { email: "ME@example.com" } }),
          task({ assignee: { email: "other@example.com" } }),
        ],
        doing: [task({ assignee: { email: ME } })],
        done: [task({ assignee: { email: ME } })],
      }),
      { email: ME, today: TODAY },
    );
    expect(summary.mine).toBe(2);
  });

  test("with no address for the viewer, mine is not known: null, never 0", () => {
    expect(taskSummary(board({ doing: [task()] }), { email: null, today: TODAY }).mine).toBeNull();
  });

  test("overdue is an open task due before today; today itself is not late", () => {
    const summary = taskSummary(
      board({
        backlog: [
          task({ due: "2026-10-11" }),
          task({ due: TODAY }),
          task({ due: "2026-10-20" }),
          task(),
        ],
        done: [task({ due: "2026-01-01" })],
      }),
      { email: ME, today: TODAY },
    );
    expect(summary.overdue).toBe(1);
  });

  test("an empty board is four real zeros", () => {
    expect(taskSummary(board(), { email: ME, today: TODAY })).toEqual({
      open: 0,
      doing: 0,
      mine: 0,
      overdue: 0,
    });
  });
});
