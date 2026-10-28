import { describe, expect, test } from "vitest";
import { boardOf, teamsOf, type LinearIssue } from "./linear";

const AT = Date.UTC(2026, 9, 12, 6);

// Every identifier, title and team here is made up.
const issue = (issueId: string, over: Partial<LinearIssue> = {}): LinearIssue => ({
  kind: "issue",
  issueId,
  identifier: `ENG-${issueId}`,
  title: `Made-up title ${issueId}`,
  url: "",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "",
  mine: false,
  priority: 0,
  updatedAt: AT,
  ...over,
});
const ids = (cards: { id: string }[]) => cards.map((card) => card.id);

describe("teamsOf", () => {
  test("each team once, by key", () => {
    expect(
      teamsOf([
        issue("1", { teamKey: "OPS", teamName: "Operations" }),
        issue("2"),
        issue("3"),
        issue("4", { teamKey: "", teamName: "" }),
      ]),
    ).toEqual([
      { key: "ENG", name: "Engineering" },
      { key: "OPS", name: "Operations" },
    ]);
  });

  test("no issues, no teams", () => {
    expect(teamsOf([])).toEqual([]);
  });
});

describe("boardOf", () => {
  test("one column per state type, each card keyed by its issue id", () => {
    const board = boardOf(
      [
        issue("1", { stateType: "backlog" }),
        issue("2", { stateType: "unstarted" }),
        issue("3", { stateType: "started" }),
        issue("4", { stateType: "completed" }),
      ],
      null,
    );
    expect(Object.keys(board)).toEqual(["backlog", "unstarted", "started", "completed"]);
    expect(ids(board.backlog)).toEqual(["1"]);
    expect(ids(board.unstarted)).toEqual(["2"]);
    expect(ids(board.started)).toEqual(["3"]);
    expect(ids(board.completed)).toEqual(["4"]);
    expect(board.started[0]).toMatchObject({ id: "3", issueId: "3", identifier: "ENG-3" });
  });

  test("a column is ordered Urgent, High, Medium, Low, then no priority", () => {
    const board = boardOf(
      [
        issue("none", { priority: 0 }),
        issue("low", { priority: 4 }),
        issue("urgent", { priority: 1 }),
        issue("medium", { priority: 3 }),
        issue("high", { priority: 2 }),
      ],
      null,
    );
    expect(ids(board.started)).toEqual(["urgent", "high", "medium", "low", "none"]);
  });

  test("within a priority, the most recently updated comes first", () => {
    const board = boardOf(
      [
        issue("older", { priority: 2, updatedAt: AT - 1000 }),
        issue("newer", { priority: 2, updatedAt: AT }),
        issue("urgent", { priority: 1, updatedAt: AT - 9000 }),
      ],
      null,
    );
    expect(ids(board.started)).toEqual(["urgent", "newer", "older"]);
  });

  test("a team narrows every column", () => {
    const issues = [
      issue("1", { stateType: "backlog" }),
      issue("2", { stateType: "backlog", teamKey: "OPS", teamName: "Operations" }),
      issue("3", { stateType: "started", teamKey: "OPS", teamName: "Operations" }),
      issue("4", { stateType: "completed" }),
    ];
    const ops = boardOf(issues, "OPS");
    expect(ids(ops.backlog)).toEqual(["2"]);
    expect(ids(ops.started)).toEqual(["3"]);
    expect(ids(ops.completed)).toEqual([]);
    expect(ids(boardOf(issues, null).backlog).sort()).toEqual(["1", "2"]);
  });

  test("the list passed in is left as it was", () => {
    const issues = [issue("b", { priority: 4 }), issue("a", { priority: 1 })];
    boardOf(issues, null);
    expect(issues.map((i) => i.issueId)).toEqual(["b", "a"]);
  });
});
