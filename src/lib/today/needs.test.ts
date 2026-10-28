import { describe, expect, test } from "vitest";
import type { AttentionItem } from "@/lib/metrics/scorecard";
import { rankNeeds, type NeedsInput } from "./needs";

// Local noon on 2026-10-16.
const NOW = new Date(2026, 9, 16, 12).getTime();
const HOUR = 60 * 60 * 1000;

const none: NeedsInput = {
  attention: [],
  approvals: [],
  notifications: [],
  tasks: { due: [], fresh: [] },
  revisits: [],
  reviews: [],
  support: [],
  now: NOW,
};
const item = (id: string, severity: AttentionItem["severity"]): AttentionItem => ({
  id,
  severity,
  title: `Made-up ${id}`,
  detail: `Why ${id}`,
  href: "/compliance",
});
const ids = (input: Partial<NeedsInput>) => rankNeeds({ ...none, ...input }).map((need) => need.id);

describe("what needs you: one ranked list", () => {
  test("nothing anywhere is an empty list", () => {
    expect(rankNeeds(none)).toEqual([]);
  });

  test("most urgent first: late, then what waits on you today, then the rest, then what is stale or missing", () => {
    expect(
      ids({
        attention: [item("source", "error"), item("stale", "stale"), item("due", "due"), item("missing", "empty"), item("risk", "risk")],
        approvals: [{ id: "p1", text: "Add a made-up task", createdAt: NOW - 2 * HOUR, href: "/approvals?id=p1" }],
        tasks: {
          due: [
            { id: "t-late", title: "Late made-up task", due: "2026-10-10", when: "overdue" },
            { id: "t-today", title: "Today's made-up task", due: "2026-10-16", when: "today" },
          ],
          fresh: [{ id: "t-new", title: "New made-up task", createdAt: NOW - HOUR }],
        },
        notifications: [
          { id: "n1", text: "Olga mentioned you in a made-up card", createdAt: NOW - HOUR, taskId: "t-other", decisionId: null, href: "/board?task=t-other" },
        ],
        revisits: [{ id: "d1", title: "A made-up decision", revisitOn: "2026-10-14" }],
        reviews: [{ id: "pr1", title: "A made-up pull request", href: "https://github.com/example/repo/pull/1" }],
      }),
    ).toEqual([
      // Late: my overdue task, then a failed source.
      "task:t-late",
      "attention:source",
      // Waiting on me today: proposals, what is due today, what is at risk.
      "approval:p1",
      "task:t-today",
      "attention:risk",
      // Then: reviews asked of me, what I was told, decisions to revisit, what is new for me, what is due soon.
      "review:pr1",
      "notification:n1",
      "revisit:d1",
      "task:t-new",
      "attention:due",
      // Then what has gone stale, then what is missing.
      "attention:stale",
      "attention:missing",
    ]);
  });

  test("each row says what, why it is urgent, and leads to where it is acted on", () => {
    const [late, today, fresh] = rankNeeds({
      ...none,
      tasks: {
        due: [
          { id: "t1", title: "Late made-up task", due: "2026-10-10", when: "overdue" },
          { id: "t2", title: "Today's made-up task", due: "2026-10-16", when: "today" },
        ],
        fresh: [{ id: "t3", title: "New made-up task", createdAt: NOW - HOUR }],
      },
    });
    expect(late).toMatchObject({ title: "Late made-up task", why: "Overdue, was due Oct 10", href: "/board?task=t1", tone: "danger" });
    expect(today).toMatchObject({ why: "Due today", href: "/board?task=t2" });
    expect(fresh).toMatchObject({ why: "New for you", href: "/board?task=t3" });

    const [approval, revisit, attention] = rankNeeds({
      ...none,
      approvals: [{ id: "p1", text: "Add a made-up task", createdAt: NOW - 2 * HOUR, href: "/assistant#proposal-p1" }],
      revisits: [{ id: "d1", title: "A made-up decision", revisitOn: "2026-10-14" }],
      attention: [item("x", "stale")],
    });
    expect(approval).toMatchObject({ why: "Proposed 2h ago", href: "/assistant#proposal-p1", action: "Review" });
    expect(revisit).toMatchObject({ why: "To revisit since Oct 14", href: "/memory?decision=d1" });
    expect(attention).toMatchObject({ title: "Made-up x", why: "Why x", href: "/compliance" });
  });

  test("a notification about a task already listed is said once, by the task", () => {
    expect(
      ids({
        tasks: { due: [{ id: "t1", title: "Made-up task", due: "2026-10-16", when: "today" }], fresh: [{ id: "t2", title: "New", createdAt: NOW - HOUR }] },
        notifications: [
          { id: "n1", text: "Olga gave you a made-up task", createdAt: NOW - HOUR, taskId: "t1", decisionId: null, href: "/board?task=t1" },
          { id: "n2", text: "Olga gave you another", createdAt: NOW - HOUR, taskId: "t2", decisionId: null, href: "/board?task=t2" },
          { id: "n3", text: "Olga mentioned you", createdAt: NOW - HOUR, taskId: "t9", decisionId: null, href: "/board?task=t9" },
        ],
      }),
    ).toEqual(["task:t1", "notification:n3", "task:t2"]);
  });

  test("a revisit reminder for a decision already listed is said once, by the decision", () => {
    expect(
      ids({
        revisits: [{ id: "d1", title: "A made-up decision", revisitOn: "2026-10-14" }],
        notifications: [
          { id: "n1", text: "Reminder: time to revisit", createdAt: NOW - HOUR, taskId: null, decisionId: "d1", href: "/memory?decision=d1" },
        ],
      }),
    ).toEqual(["revisit:d1"]);
  });

  test("the same item from two lists is one row", () => {
    expect(ids({ attention: [item("a", "due"), item("a", "due")] })).toEqual(["attention:a"]);
  });

  test("a notification that leads nowhere the viewer can open still says what it is, with no link", () => {
    const [row] = rankNeeds({
      ...none,
      notifications: [{ id: "n1", text: "Olga moved a made-up card", createdAt: NOW - 3 * HOUR, taskId: null, decisionId: null, href: null }],
    });
    expect(row).toMatchObject({ title: "Olga moved a made-up card", why: "3h ago", href: null });
  });
});

describe("customers waiting on a person (Support, Globex's Intercom)", () => {
  const wait = (id: string, hours: number) => ({
    id,
    waitedMs: hours * HOUR,
    pageArea: "studies/report",
    fin: "escalated" as const,
    href: `https://app.intercom.com/a/inbox/made0up1/inbox/conversation/${id}`,
  });

  test("each is a row of today's tier in the danger tone, with how long and where, and Intercom's link", () => {
    const [row] = rankNeeds({ ...none, support: [wait("901", 5)] });
    expect(row).toEqual({
      id: "support:901",
      kind: "support",
      ref: "901",
      tier: 1,
      title: "A customer is waiting on a person",
      why: "Waited 5 h at the last push · /studies/report · Handed to a person",
      href: "https://app.intercom.com/a/inbox/made0up1/inbox/conversation/901",
      action: "Open in Intercom",
      tone: "danger",
    });
  });

  test("after a late task and a proposal, before what is due today; the longest wait first as given", () => {
    expect(
      ids({
        support: [wait("901", 30), wait("902", 5)],
        approvals: [{ id: "p1", text: "Add a made-up task", createdAt: NOW - HOUR, href: "/approvals?id=p1" }],
        tasks: {
          due: [
            { id: "t-late", title: "Late made-up task", due: "2026-10-10", when: "overdue" },
            { id: "t-today", title: "Today's made-up task", due: "2026-10-16", when: "today" },
          ],
          fresh: [],
        },
      }),
    ).toEqual(["task:t-late", "approval:p1", "support:901", "support:902", "task:t-today"]);
  });
});

describe("a bot refused often", () => {
  test("a bot refused more than five times in the hour is one row, after the owner's proposals, leading to its card", () => {
    const rows = rankNeeds({
      ...none,
      approvals: [{ id: "p1", text: "Add a made-up task", createdAt: NOW - HOUR, href: "/approvals" }],
      bots: [{ id: "b1", name: "Made-up Growth Bot", refusals: 7 }],
    });
    expect(rows.map((row) => row.id)).toEqual(["approval:p1", "bot:b1"]);
    expect(rows[1]).toMatchObject({
      kind: "bot",
      tier: 1,
      title: "Made-up Growth Bot was refused 7 times in the last hour",
      href: "/agents?view=bots",
      action: "Open",
    });
  });
});
