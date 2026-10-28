import { describe, expect, test } from "vitest";
import { PROPOSAL_KINDS } from "@convex/lib/agents";
import { draftOf, editedPayload, isEditable } from "./edit-then-approve";

const NONE: { task: string | null; deal: string | null; assignee: string | null } = { task: null, deal: null, assignee: null };
const row = (kind: string, payload: Record<string, unknown>, about = NONE) =>
  ({ source: "proposal", kind, payload, about }) as never;

describe("what can be edited before approving", () => {
  test("every kind but a bot's permission, and a goal change only where it renames", () => {
    const editable = PROPOSAL_KINDS.filter((kind) => isEditable(row(kind, { title: "x" })));
    expect(editable).toEqual(PROPOSAL_KINDS.filter((kind) => kind !== "bot_permission" && kind !== "task_archive"));
    expect(isEditable(row("goal_update", { goalId: "g1", status: "at_risk" }))).toBe(false);
    expect(isEditable({ source: "tool_call", kind: "tool_call", payload: null } as never)).toBe(false);
  });
});

describe("the edited payload is the whole of the proposal's own kind", () => {
  test("a new task: the assignee is the owner's to change, or to take off", () => {
    const proposed = row(
      "task_create",
      { title: "Made-up review", notes: "n", assignee: "dana@example.test", due: "2026-10-16", column: "this_week" },
      { ...NONE, assignee: "Dana" },
    );
    const draft = draftOf(proposed);
    expect(draft).toMatchObject({ title: "Made-up review", assignee: "dana@example.test", due: "2026-10-16", column: "this_week" });
    expect(editedPayload(proposed, { ...draft, assignee: "sam@example.test", due: "" })).toEqual({
      title: "Made-up review",
      notes: "n",
      assignee: "sam@example.test",
      column: "this_week",
    });
    expect(editedPayload(proposed, { ...draft, assignee: "" })).not.toHaveProperty("assignee");
  });

  test("a change to a task: only what it set out to change; an emptied field clears", () => {
    const proposed = row("task_change", { taskId: "t1", assignee: "dana@example.test", due: "2026-10-20" });
    const draft = draftOf(proposed);
    expect(editedPayload(proposed, { ...draft, assignee: "sam@example.test" })).toEqual({
      taskId: "t1",
      assignee: "sam@example.test",
      due: "2026-10-20",
    });
    expect(editedPayload(proposed, { ...draft, assignee: "", due: "" })).toEqual({ taskId: "t1", assignee: null, due: null });
  });

  test("a decision, a draft, a next step, a new deal and the goals", () => {
    const decision = row("decision_record", { title: "Per seat", decision: "We charge per seat.", ownerEmail: "d@example.test", meetingId: "m1" });
    expect(editedPayload(decision, { ...draftOf(decision), context: "From the call.", due: "2027-01-05" })).toEqual({
      title: "Per seat",
      decision: "We charge per seat.",
      context: "From the call.",
      ownerEmail: "d@example.test",
      revisitOn: "2027-01-05",
      meetingId: "m1",
    });
    const draft = row("draft", { title: "Follow-up", body: "Hello", about: { type: "deal", id: "d4" } });
    expect(editedPayload(draft, { ...draftOf(draft), body: "Shorter." })).toEqual({ title: "Follow-up", body: "Shorter." });
    const step = row("deal_next_step", { dealId: "d4", nextStep: "Send pricing" });
    expect(editedPayload(step, { ...draftOf(step), nextStep: "Email" })).toEqual({ dealId: "d4", nextStep: "Email" });
    const deal = row("deal_create", { name: "Made-up Spine", stage: "demo", nextStep: "Call.", intel: { summary: "Made-up." } });
    expect(editedPayload(deal, { ...draftOf(deal), title: "Made-up Spine Center", nextStep: " " })).toEqual({
      name: "Made-up Spine Center",
      stage: "demo",
      intel: { summary: "Made-up." },
    });
    const goal = row("goal_create", { quarter: "2026-Q4", title: "Made-up goal", target: "10 clinics" });
    expect(editedPayload(goal, { ...draftOf(goal), title: "Made-up goal, renamed" })).toEqual({
      quarter: "2026-Q4",
      title: "Made-up goal, renamed",
      target: "10 clinics",
    });
    const rename = row("goal_update", { goalId: "g1", title: "Old", status: "at_risk" });
    expect(editedPayload(rename, { ...draftOf(rename), title: "New" })).toEqual({ goalId: "g1", title: "New", status: "at_risk" });
  });
});
