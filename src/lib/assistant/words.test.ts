import { describe, expect, test } from "vitest";
import { PAGE_AREAS } from "@/lib/nav";
import { AGENT_IDS, AGENT_TONES, BRIEF_PAGES, BRIEF_PAGE_LABELS, BRIEF_FRESH_MS, briefIsFresh } from "./agents";
import { briefFooter, clockTime, proposalSentence, resultLink, whenWritten, withdrawnLine, type OpenProposal } from "./words";

// Local noon, so "today" is the 14th in any timezone.
const NOW = new Date(2026, 9, 14, 12).getTime();
const HOUR = 60 * 60 * 1000;

const row = (
  kind: OpenProposal["kind"],
  payload: Record<string, unknown>,
  about: Partial<OpenProposal["about"]> = {},
) =>
  ({
    kind,
    payload,
    about: { task: null, deal: null, assignee: null, ...about },
  }) as unknown as OpenProposal;

describe("what approving a proposal will do, in plain words", () => {
  test("a bot's permission request names the bot, the level and the area by its label", () => {
    expect(proposalSentence(row("bot_permission", { bot: "partnerships", area: "partnerships", level: "write" }), NOW)).toBe(
      "Let the bot partnerships read and change Partnerships",
    );
    expect(proposalSentence(row("bot_permission", { bot: "growth", area: "sales", level: "read" }), NOW)).toBe(
      "Let the bot growth read Sales",
    );
  });

  test("a new deal: its name, its stage (lead unless given) and its contact", () => {
    expect(proposalSentence(row("deal_create", { name: "Made-up Spine", stage: "demo", contact: "Dana, manager" }), NOW)).toBe(
      'Add a new deal: "Made-up Spine" at demo, contact Dana, manager',
    );
    expect(proposalSentence(row("deal_create", { name: "Made-up Hand" }), NOW)).toBe('Add a new deal: "Made-up Hand" at lead');
  });

  test("a goal's owner, bot, target and due day, set or cleared", () => {
    expect(
      proposalSentence(
        row("goal_update", { goalId: "g1", target: "v2 live at 3 pilot clinics", dueOn: "2026-12-31", ownerBot: "strategy_advisor", ownerEmail: null }, { task: "Grow Globex" }),
        NOW,
      ),
    ).toBe('Change the goal "Grow Globex": take its owner off, give it to the bot strategy_advisor, set its target "v2 live at 3 pilot clinics", make it due Dec 31');
    expect(
      proposalSentence(row("goal_create", { quarter: "2026-Q4", title: "Pilots", target: "10 clinics", dueOn: "2026-12-31" }), NOW),
    ).toBe('Add a goal for 2026-Q4: "Pilots", target "10 clinics", due Dec 31');
  });

  test("a new task: who for, its title, when it is due and where it goes", () => {
    expect(
      proposalSentence(
        row("task_create", { title: "Review PR #118", assignee: "dana@example.test", due: "2026-10-16", column: "this_week" }, { assignee: "Dana" }),
        NOW,
      ),
    ).toBe('Create a task for Dana: "Review PR #118", due Oct 16, in This week');
    expect(proposalSentence(row("task_create", { title: "Call the bank" }), NOW)).toBe(
      'Create a task: "Call the bank", in Backlog',
    );
  });

  test("a change to a task: each thing it changes, and a clearing said as one", () => {
    expect(
      proposalSentence(
        row("task_change", { taskId: "t", assignee: "sam@example.test", due: "2027-01-05", column: "doing" }, { task: "Ship the export", assignee: "Sam" }),
        NOW,
      ),
    ).toBe('Change "Ship the export": give it to Sam, set it due Jan 5, 2027, move it to Doing');
    expect(
      proposalSentence(row("task_change", { taskId: "t", assignee: null, due: null }, { task: "Ship the export" }), NOW),
    ).toBe('Change "Ship the export": take it off whoever holds it, clear its due date');
    expect(proposalSentence(row("task_change", { taskId: "t", column: "done" }), NOW)).toBe(
      "Change a task that is no longer on the board: move it to Done",
    );
  });

  test("a next step, and a draft", () => {
    expect(
      proposalSentence(row("deal_next_step", { dealId: "d", nextStep: "Send pricing" }, { deal: "Example Clinic Group" }), NOW),
    ).toBe('Set the next step of Example Clinic Group to "Send pricing"');
    expect(proposalSentence(row("deal_next_step", { dealId: "d", nextStep: "Call" }), NOW)).toBe(
      'Set the next step of a deal that is no longer on the board to "Call"',
    );
    expect(proposalSentence(row("draft", { title: "Follow-up", body: "Hello" }), NOW)).toBe(
      'A draft for you to send yourself: "Follow-up"',
    );
  });

  test("a decision to record: its title, whose it is and when to look again", () => {
    expect(
      proposalSentence(
        row("decision_record", { title: "Price per seat", decision: "x", revisitOn: "2027-01-05" }, { assignee: "Dana" }),
        NOW,
      ),
    ).toBe('Record a decision, owned by Dana: "Price per seat", to revisit Jan 5, 2027');
    expect(proposalSentence(row("decision_record", { title: "Price per seat", decision: "x" }), NOW)).toBe(
      'Record a decision: "Price per seat"',
    );
  });

  test("a model's text is only ever text in the sentence", () => {
    const title = '<img src=x onerror=alert(1)> [link](https://example.com)';
    expect(proposalSentence(row("task_create", { title }), NOW)).toBe(`Create a task: "${title}", in Backlog`);
  });
});

describe("when a brief was written", () => {
  test("the hour and minute in the reader's own time, with the day once it is not today", () => {
    const at = new Date(2026, 9, 14, 11, 20).getTime();
    expect(clockTime(at)).toBe("11:20");
    expect(clockTime(new Date(2026, 9, 14, 9, 5).getTime())).toBe("09:05");
    expect(whenWritten(at, NOW)).toBe("at 11:20");
    expect(whenWritten(at - 24 * HOUR, NOW)).toBe("on Oct 13 at 11:20");
    expect(briefFooter(at, NOW)).toBe("Written by Claude at 11:20 from the OS's figures.");
  });

  test("a brief is today's for thirty-six hours and no longer", () => {
    expect(BRIEF_FRESH_MS).toBe(36 * HOUR);
    expect(briefIsFresh(NOW - 36 * HOUR, NOW)).toBe(true);
    expect(briefIsFresh(NOW - 36 * HOUR - 1, NOW)).toBe(false);
    expect(briefIsFresh(NOW, NOW)).toBe(true);
  });
});

describe("where a brief's bullet and a result may lead", () => {
  test("every page a bullet may point at is a page of the app, with a name, and none is the owner's alone or sensitive", () => {
    for (const page of BRIEF_PAGES) {
      expect(PAGE_AREAS[page], page).toBeDefined();
      expect(["personal", "admin", "payroll", "settings", "team"]).not.toContain(PAGE_AREAS[page]);
      expect(BRIEF_PAGE_LABELS[page].length).toBeGreaterThan(0);
      expect(page).toMatch(/^\/[a-z]+$/);
    }
  });

  test("a task leads to the board, a deal to sales, a kept draft nowhere", () => {
    expect(resultLink({ taskId: "abc" } as never)).toEqual({ href: "/board?task=abc", label: "Open the task on the board" });
    expect(resultLink({ dealId: "abc" } as never)?.href).toBe("/sales");
    expect(resultLink({ decisionId: "abc" } as never)).toEqual({
      href: "/memory?decision=abc",
      label: "Open the decision in Memory",
    });
    expect(resultLink({ kept: true })).toBeNull();
    expect(resultLink(null)).toBeNull();
  });

  test("every agent has a chip", () => {
    for (const agent of AGENT_IDS) expect(AGENT_TONES[agent]).toBeTruthy();
  });
});

describe("a withdrawn proposal, in the owner's history", () => {
  test("its proposer's reason, then its note as text; nothing for a row not withdrawn", () => {
    expect(withdrawnLine({ withdrawReason: "superseded", withdrawNote: "Made-up: merged into the newer card." })).toBe(
      "Withdrawn by its proposer: superseded. Made-up: merged into the newer card.",
    );
    expect(withdrawnLine({ withdrawReason: "duplicate", withdrawNote: null })).toBe("Withdrawn by its proposer: a duplicate.");
    expect(withdrawnLine({ withdrawReason: null, withdrawNote: null })).toBeNull();
  });
});
