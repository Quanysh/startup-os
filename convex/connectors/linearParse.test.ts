import { describe, expect, test } from "vitest";
import { ConnectorError } from "./errors";
import { UPDATED, VIEWER_ID, issuePage, node } from "./linear.fixtures";
import { parseIssuePage } from "./linearParse";

const one = (over: Record<string, unknown>) => parseIssuePage(issuePage([node(over)])).rows;

/** What was thrown, so its class and its message can both be checked. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a throw.");
}

const SHAPE = "Linear's issues were not in the expected shape.";

describe("parseIssuePage: issues", () => {
  test("one issue, in full", () => {
    expect(one({})).toEqual([
      {
        kind: "issue",
        issueId: "issue-1",
        identifier: "ENG-1",
        title: "Made-up title",
        url: "https://linear.app/startup/issue/ENG-1/made-up-title",
        stateType: "started",
        stateName: "In Progress",
        teamKey: "ENG",
        teamName: "Engineering",
        assigneeName: "Ada Example",
        mine: true,
        priority: 2,
        dueDate: undefined,
        updatedAt: Date.parse(UPDATED),
      },
    ]);
  });

  test("a page of four, one per state type; mine only where the assignee is the key's own user", () => {
    const { rows, next } = parseIssuePage(
      issuePage([
        node({ id: "i1", state: { name: "Backlog", type: "backlog" } }),
        node({ id: "i2", state: { name: "Todo", type: "unstarted" }, assignee: { id: "user-other", name: "Bo Example" } }),
        node({ id: "i3", state: { name: "In Progress", type: "started" } }),
        node({ id: "i4", state: { name: "Done", type: "completed" }, assignee: null }),
      ]),
    );
    expect(next).toBeNull();
    expect(rows.map((r) => [r.issueId, r.stateType, r.stateName, r.mine])).toEqual([
      ["i1", "backlog", "Backlog", true],
      ["i2", "unstarted", "Todo", false],
      ["i3", "started", "In Progress", true],
      ["i4", "completed", "Done", false],
    ]);
  });

  test.each([["triage"], ["canceled"], ["something_new"], [undefined], [7]])(
    "a state of type %j is not on the board, and is not an error",
    (type) => {
      const { rows } = parseIssuePage(
        issuePage([node({ id: "kept" }), node({ id: "dropped", state: { name: "X", type } })]),
      );
      expect(rows.map((r) => r.issueId)).toEqual(["kept"]);
    },
  );

  test.each([
    ["javascript:alert(1)"],
    ["https://evil.test/startup/issue/ENG-1"],
    ["http://linear.app/startup/issue/ENG-1"],
    ["https://linear.app.evil.test/x"],
    ["https://linear.app/a b"],
    [7],
    [null],
  ])("a url of %j is not kept: it would become a link", (url) => {
    expect(one({ url })[0]?.url).toBe("");
  });

  // The url becomes an href on /board. Only Linear's own https pages are kept.
  test.each([
    ["plain http", "http://linear.app/startup/issue/ENG-1/a-title"],
    ["a script", "javascript:alert(1)"],
    ["another host", "https://linear.app.evil.test/startup/issue/ENG-1"],
    ["a protocol-relative address", "//linear.app/startup/issue/ENG-1"],
    ["upper-case HTTP", "HTTP://linear.app/startup/issue/ENG-1"],
  ])("a link that is %s is dropped: the issue is kept without one", (_name, url) => {
    const [row] = one({ url });
    expect(row?.url).toBe("");
    expect(row?.identifier).not.toBe("");
  });

  test("Linear's own https page is kept", () => {
    const url = "https://linear.app/startup/issue/ENG-1/a-title";
    expect(one({ url })[0]?.url).toBe(url);
  });

  test("no assignee", () => {
    expect(one({ assignee: null })[0]).toMatchObject({ assigneeName: "", mine: false });
    expect(one({ assignee: undefined })[0]).toMatchObject({ assigneeName: "", mine: false });
  });

  test.each([[9], ["high"], [-1], [2.5], [null]])("a priority of %j is none", (priority) => {
    expect(one({ priority })[0]?.priority).toBe(0);
  });

  test.each([[0], [1], [2], [3], [4]])("priority %i is kept", (priority) => {
    expect(one({ priority })[0]?.priority).toBe(priority);
  });

  test("a due date is kept only as a day", () => {
    expect(one({ dueDate: "2026-10-20" })[0]?.dueDate).toBe("2026-10-20");
    expect(one({ dueDate: "soon" })[0]?.dueDate).toBeUndefined();
    expect(one({ dueDate: "2026-10-20T00:00:00Z" })[0]?.dueDate).toBeUndefined();
    expect(one({ dueDate: 7 })[0]?.dueDate).toBeUndefined();
  });

  test("no title", () => {
    expect(one({ title: "" })[0]?.title).toBe("(no title)");
    expect(one({ title: null })[0]?.title).toBe("(no title)");
  });

  test("long or multi-line text is cut to its cap, on one line", () => {
    const [row] = one({
      title: `Made-up\n${"x".repeat(900)}`,
      identifier: "I".repeat(90),
      state: { name: "S".repeat(300), type: "started" },
      team: { key: "K".repeat(60), name: "T".repeat(300) },
      assignee: { id: "user-other", name: "N".repeat(300) },
    });
    expect(row?.title).toHaveLength(200);
    expect(row?.title).not.toContain("\n");
    expect(row?.identifier).toHaveLength(40);
    expect(row?.stateName).toHaveLength(100);
    expect(row?.teamKey).toHaveLength(20);
    expect(row?.teamName).toHaveLength(100);
    expect(row?.assigneeName).toHaveLength(100);
  });

  test("no team", () => {
    expect(one({ team: null })[0]).toMatchObject({ teamKey: "", teamName: "" });
  });
});

describe("parseIssuePage: pages", () => {
  test("the cursor of the next page, when there is one", () => {
    expect(parseIssuePage(issuePage([node()], "c2")).next).toBe("c2");
    expect(parseIssuePage(issuePage([node()])).next).toBeNull();
  });

  test("a next page with no cursor is not a page that can be followed", () => {
    const json = issuePage([node()]);
    json.data.issues.pageInfo = { hasNextPage: true, endCursor: null };
    expect(thrown(() => parseIssuePage(json)).message).toBe(SHAPE);
  });

  test("an empty page", () => {
    expect(parseIssuePage(issuePage([]))).toEqual({ rows: [], next: null });
  });
});

describe("parseIssuePage: what fails the read", () => {
  test.each([
    ["with no data", { errors: [{ message: "REMOTE-TEXT" }] }],
    ["beside data", { ...issuePage([node()]), errors: [{ message: "REMOTE-TEXT" }] }],
  ])("a GraphQL errors array %s is reported in our words, never Linear's", (_name, json) => {
    const error = thrown(() => parseIssuePage(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear reported an error for issues.");
    expect(error.message).not.toContain("REMOTE-TEXT");
  });

  test.each([
    ["null", null],
    ["an empty object", {}],
    ["no viewer", { data: { issues: { nodes: [], pageInfo: {} } } }],
    ["issues with nothing in it", { data: { viewer: { id: VIEWER_ID }, issues: {} } }],
    ["nodes that is not a list", { data: { viewer: { id: VIEWER_ID }, issues: { nodes: "x", pageInfo: {} } } }],
    ["a node that is not an object", issuePage(["x"])],
    ["a node with no state", issuePage([node({ state: null })])],
    ["a node with no id", issuePage([node({ id: undefined })])],
    ["a node with an empty id", issuePage([node({ id: "" })])],
    ["a node with an unreadable updatedAt", issuePage([node({ updatedAt: "REMOTE-TIME" })])],
    ["a node with no updatedAt", issuePage([node({ updatedAt: undefined })])],
  ])("%s", (_name, json) => {
    const error = thrown(() => parseIssuePage(json));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(SHAPE);
  });
});
