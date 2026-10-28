import { describe, expect, test, vi } from "vitest";
import {
  EVERYTHING,
  ageTone,
  ONE_CLICK_WORDS,
  decideMany,
  duplicateBadge,
  filterInbox,
  goalsIn,
  kindLabel,
  oneClickOnly,
  readView,
  rowSentence,
  sortInbox,
  splitCash,
  typeOf,
  whoLabel,
  writeView,
  type InboxRow,
} from "./inbox";

const NOW = Date.UTC(2026, 9, 18, 9);

const proposal = (over: Record<string, unknown> = {}): InboxRow =>
  ({
    source: "proposal",
    id: "p1",
    agent: "sales",
    kind: "deal_next_step",
    company: "us",
    reason: "Made-up reason.",
    createdAt: NOW - 60_000,
    payload: { dealId: "d1", nextStep: "Call" },
    about: { task: null, deal: "Made-up Deal", assignee: null },
    changes: [{ field: "Next step", before: null, after: "Call" }],
    bot: null,
    tool: null,
    toolName: null,
    arguments: null,
    why: "Made-up reason.",
    urgency: "normal",
    goal: null,
    evidence: null,
    effect: { changes: [{ field: "Next step", before: null, after: "Call" }], text: null },
    cash: false,
    duplicate: null,
    ...over,
  }) as InboxRow;

const toolCall = (over: Record<string, unknown> = {}): InboxRow =>
  ({
    source: "tool_call",
    id: "a1",
    agent: "made-up.agent",
    kind: "tool_call",
    company: null,
    reason: null,
    createdAt: NOW,
    payload: null,
    about: null,
    changes: [],
    bot: null,
    tool: "task_create",
    toolName: "Create a task",
    arguments: "{}",
    why: null,
    urgency: "normal",
    goal: null,
    evidence: null,
    effect: null,
    cash: false,
    duplicate: null,
    ...over,
  }) as InboxRow;

describe("the view lives in the address", () => {
  test("only what differs from everything is written, and nonsense reads as everything", () => {
    expect(writeView(EVERYTHING)).toBe("");
    const view = {
      tab: "waiting",
      company: "kz",
      agent: "sales",
      goal: "none",
      type: "message",
      kind: "draft",
      urgency: "high",
      decision: null,
    } as const;
    expect(readView(new URLSearchParams(writeView(view)))).toEqual(view);
    // "Decided" is a tab of the same page, with the same filters and one of its own: how it ended.
    const decided = { ...view, tab: "decided", decision: "withdrawn" } as const;
    expect(writeView(decided)).toContain("tab=decided");
    expect(readView(new URLSearchParams(writeView(decided)))).toEqual(decided);
    expect(
      readView(
        new URLSearchParams(
          "kind=<b>&company=xx&type=money&goal=<i>&urgency=urgent&tab=all&decision=lost&agent=" + "x".repeat(200),
        ),
      ),
    ).toEqual(EVERYTHING);
  });

  test("filters by agent and by kind", () => {
    const rows = [proposal(), proposal({ id: "p2", agent: "finance", kind: "draft" }), toolCall()];
    expect(filterInbox(rows, { ...EVERYTHING, agent: "sales" }).map((row) => row.id)).toEqual(["p1"]);
    expect(filterInbox(rows, { ...EVERYTHING, kind: "tool_call" }).map((row) => row.id)).toEqual(["a1"]);
    expect(filterInbox(rows, { ...EVERYTHING, agent: "made-up.agent", kind: "tool_call" }).map((row) => row.id)).toEqual(["a1"]);
    // A bot's proposal is the bot's, not the agent it is filed under.
    const bot = proposal({ id: "b1", agent: "chief_of_staff", bot: "grok-sales" });
    expect(filterInbox([...rows, bot], { ...EVERYTHING, agent: "bot:grok-sales" }).map((row) => row.id)).toEqual(["b1"]);
    expect(filterInbox([...rows, bot], { ...EVERYTHING, agent: "chief_of_staff" })).toEqual([]);
    // How it ended narrows what was decided; a row still waiting has no decision and is never narrowed by it.
    const ended = [
      { ...proposal(), status: "approved" },
      { ...proposal({ id: "p2" }), status: "withdrawn" },
    ];
    expect(filterInbox(ended, { ...EVERYTHING, decision: "withdrawn" }).map((row) => row.id)).toEqual(["p2"]);
    expect(filterInbox(rows, { ...EVERYTHING, decision: "withdrawn" })).toHaveLength(3);
    expect(whoLabel(bot)).toBe("Bot: grok-sales");
    expect(readView(new URLSearchParams("agent=bot:grok-sales")).agent).toBe("bot:grok-sales");
  });
});

describe("the urgency filter and the duplicate badge (Bot Loop v3)", () => {
  test("filters by urgency", () => {
    const rows = [proposal({ id: "c", urgency: "critical" }), proposal({ id: "n" }), proposal({ id: "l", urgency: "low" })];
    expect(filterInbox(rows, { ...EVERYTHING, urgency: "critical" }).map((row) => row.id)).toEqual(["c"]);
    expect(filterInbox(rows, { ...EVERYTHING, urgency: "normal" }).map((row) => row.id)).toEqual(["n"]);
    expect(readView(new URLSearchParams("urgency=low")).urgency).toBe("low");
  });

  test("a forced near-duplicate names what it is near", () => {
    expect(duplicateBadge(proposal())).toBeNull();
    expect(duplicateBadge(proposal({ duplicate: { of: [{ id: "t1", title: "Made-up cap" }], reason: "Made-up" } }))).toBe(
      "Possible duplicate of “Made-up cap”",
    );
    expect(
      duplicateBadge(
        proposal({
          duplicate: {
            of: [
              { id: "t1", title: "Made-up cap" },
              { id: "t2", title: "Made-up other" },
            ],
            reason: null,
          },
        }),
      ),
    ).toBe("Possible duplicate of “Made-up cap” and 1 more");
  });
});

describe("company, goal and type filters; the order; the cash section; the age badge", () => {
  const goal = (over: Record<string, unknown> = {}) => ({ id: "g1", title: "Made-up goal", status: "on_track", cash: false, ...over });

  test("company, goal (or none) and type, which groups kinds", () => {
    const rows = [
      proposal({ id: "a", company: "us", goal: goal() }),
      proposal({ id: "b", company: "kz", kind: "draft" }),
      proposal({ id: "c", company: "us", kind: "task_create" }),
      toolCall({ id: "d" }),
    ];
    expect(filterInbox(rows, { ...EVERYTHING, company: "kz" }).map((row) => row.id)).toEqual(["b"]);
    expect(filterInbox(rows, { ...EVERYTHING, goal: "g1" }).map((row) => row.id)).toEqual(["a"]);
    expect(filterInbox(rows, { ...EVERYTHING, goal: "none" }).map((row) => row.id)).toEqual(["b", "c", "d"]);
    expect(filterInbox(rows, { ...EVERYTHING, type: "message" }).map((row) => row.id)).toEqual(["b"]);
    expect(filterInbox(rows, { ...EVERYTHING, type: "data" }).map((row) => row.id)).toEqual(["d"]);
    expect(typeOf("goal_update")).toBe("goal");
    expect(typeOf("task_change")).toBe("task");
    expect(typeOf("deal_next_step")).toBe("deal");
    expect(typeOf("deal_create")).toBe("deal");
    expect(kindLabel("deal_create")).toBe("New deal");
    expect(typeOf("decision_record")).toBe("data");
    expect(goalsIn(rows)).toEqual([{ id: "g1", title: "Made-up goal" }]);
  });

  test("critical first, then a goal at risk, then oldest first", () => {
    const rows = [
      proposal({ id: "new", createdAt: NOW - 1 }),
      proposal({ id: "old", createdAt: NOW - 9 }),
      proposal({ id: "risk", createdAt: NOW, goal: goal({ status: "at_risk" }) }),
      proposal({ id: "off", createdAt: NOW - 2, goal: goal({ status: "off_track" }) }),
      proposal({ id: "crit", createdAt: NOW, urgency: "critical" }),
      proposal({ id: "high", createdAt: NOW - 3, urgency: "high" }),
    ];
    expect(sortInbox(rows).map((row) => row.id)).toEqual(["crit", "off", "risk", "old", "high", "new"]);
  });

  test("what serves a cash goal is pinned apart", () => {
    // The server says which rows are cash work (convex/lib/cashGroup.ts): a cash goal, or fundraising, finance or collections.
    const { cash, rest } = splitCash([proposal({ id: "a", goal: goal({ cash: true }), cash: true }), proposal({ id: "b" })]);
    expect(cash.map((row) => row.id)).toEqual(["a"]);
    expect(rest.map((row) => row.id)).toEqual(["b"]);
  });

  test("amber after a day, red after three", () => {
    const HOUR = 3_600_000;
    expect(ageTone(NOW, NOW - 23 * HOUR)).toBe("fresh");
    expect(ageTone(NOW, NOW - 25 * HOUR)).toBe("amber");
    expect(ageTone(NOW, NOW - 73 * HOUR)).toBe("red");
  });
});

describe("how a row reads", () => {
  test("a proposal by its sentence, a tool call by its tool", () => {
    expect(rowSentence(proposal(), NOW)).toBe('Set the next step of Made-up Deal to "Call"');
    expect(rowSentence(toolCall(), NOW)).toBe("Run a tool: Create a task");
    expect(whoLabel(proposal())).toBe("Sales and pipeline");
    expect(whoLabel(toolCall())).toBe("made-up.agent");
    expect(kindLabel("goal_update")).toBe("Goal change");
    expect(kindLabel("tool_call")).toBe("Tool call");
  });
});

describe("deciding many", () => {
  test("each through its own path, one at a time; a refusal keeps that one and the rest go on", async () => {
    const approve = vi.fn(async (args: { id: string }): Promise<null> => {
      if (args.id === "p2") throw new Error("That task is no longer on the board.");
      return null;
    });
    const dismiss = vi.fn(async (_args: { id: string; reason?: string }) => null);
    const decide = vi.fn(async (_args: { id: string; decision: string; reason?: string }) => null);
    const rows = [proposal(), proposal({ id: "p2" }), toolCall()];
    const failed = await decideMany(rows, "approve", { approve, dismiss, decide }, () => ({ code: null, text: "" }));
    expect(approve.mock.calls.map(([args]) => args)).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(decide).toHaveBeenCalledWith({ id: "a1", decision: "approve" });
    expect(failed).toEqual({ p2: "That task is no longer on the board." });
  });

  test("a rejection carries each row's code and words; a tool call the words, or the code's label", async () => {
    const approve = vi.fn(async (_args: { id: string }) => null);
    const dismiss = vi.fn(async (_args: { id: string; reason?: string }) => null);
    const decide = vi.fn(async (_args: { id: string; decision: string; reason?: string }) => null);
    const reasons = {
      p1: { code: null, text: "Not now" },
      p2: { code: "wrong_timing", text: "  " },
      a1: { code: "wrong_data", text: "" },
    } as const;
    await decideMany(
      [proposal(), proposal({ id: "p2" }), toolCall()],
      "reject",
      { approve, dismiss, decide },
      (id) => reasons[id as keyof typeof reasons],
    );
    expect(dismiss.mock.calls.map(([args]) => args)).toEqual([
      { id: "p1", reason: "Not now" },
      { id: "p2", code: "wrong_timing" },
    ]);
    expect(decide).toHaveBeenCalledWith({ id: "a1", decision: "deny", reason: "Wrong data" });
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("what takes a click of its own", () => {
  test("a possible duplicate and a kind never done without the owner: never in bulk, never by the a key", async () => {
    const forced = proposal({ id: "p2", kind: "task_change", duplicate: { of: [{ id: "t1", title: "Made-up" }], reason: null } });
    const deal = proposal({ id: "p3", kind: "deal_create", payload: { name: "Made-up Clinic" } });
    const investor = proposal({ id: "p4", kind: "draft", payload: { title: "Made-up investor update", body: "b" } });
    expect(oneClickOnly(proposal())).toBe(false);
    expect(oneClickOnly(toolCall())).toBe(false);
    for (const row of [forced, deal, investor]) expect(oneClickOnly(row)).toBe(true);
    for (const kind of ["goal_create", "goal_update", "bot_permission"]) expect(oneClickOnly(proposal({ kind }))).toBe(true);

    const approve = vi.fn(async (_args: { id: string }) => null);
    const dismiss = vi.fn(async (_args: { id: string; reason?: string }) => null);
    const decide = vi.fn(async (_args: { id: string; decision: string; reason?: string }) => null);
    const none = () => ({ code: null, text: "" });
    // In bulk: the rest are approved; each of these stays, with why.
    const failed = await decideMany([proposal(), forced, deal, investor, toolCall()], "approve", { approve, dismiss, decide }, none, undefined, {
      bulk: true,
    });
    expect(approve.mock.calls.map(([args]) => args)).toEqual([{ id: "p1" }]);
    expect(decide).toHaveBeenCalledWith({ id: "a1", decision: "approve" });
    expect(failed).toEqual({ p2: ONE_CLICK_WORDS, p3: ONE_CLICK_WORDS, p4: ONE_CLICK_WORDS });
    // Its own button: approved like any other.
    await decideMany([deal], "approve", { approve, dismiss, decide }, none);
    expect(approve).toHaveBeenLastCalledWith({ id: "p3" });
    // Rejecting in bulk is never held back.
    await decideMany([forced, deal], "reject", { approve, dismiss, decide }, () => ({ code: "duplicate", text: "" }), undefined, {
      bulk: true,
    });
    expect(dismiss.mock.calls.map(([args]) => args)).toEqual([
      { id: "p2", code: "duplicate" },
      { id: "p3", code: "duplicate" },
    ]);
  });

  test("a tool call is denied only with a reason, as a proposal is rejected", async () => {
    const approve = vi.fn(async (_args: { id: string }) => null);
    const dismiss = vi.fn(async (_args: { id: string; reason?: string }) => null);
    const decide = vi.fn(async (_args: { id: string; decision: string; reason?: string }) => null);
    const failed = await decideMany([toolCall(), proposal()], "reject", { approve, dismiss, decide }, () => ({ code: null, text: " " }));
    expect(decide).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(Object.keys(failed)).toEqual(["a1", "p1"]);
  });
});
