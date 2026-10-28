// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { ApprovalCard } from "./row";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const NOW = Date.UTC(2026, 9, 14, 12);

// Every name and title is made up.
const waiting = (over: Record<string, unknown>) =>
  ({
    source: "proposal",
    id: "p1",
    agent: "chief_of_staff",
    bot: null,
    kind: "task_create",
    company: "us",
    reason: "Made-up reason.",
    why: "Made-up reason.",
    createdAt: NOW - 2 * 3_600_000,
    payload: { title: "Made-up task" },
    about: { task: null, deal: null, assignee: null },
    changes: [],
    urgency: "normal",
    goal: null,
    evidence: null,
    effect: { changes: [], text: null },
    cash: false,
    duplicate: null,
    tool: null,
    toolName: null,
    arguments: null,
    ...over,
  }) as never;

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.team.assignable, [{ email: "dana@example.test", name: "Dana Example" }]);
});
afterEach(cleanup);

const card = () => within(screen.getByTestId("proposal"));

test("a refusal at the click is the server's own sentence, and the card stays", async () => {
  convex.mutation(api.assistant.approve).mockRejectedValue(new ConvexError("That task is no longer on the board."));
  render(<ApprovalCard row={waiting({})} now={NOW} />);
  await userEvent.click(card().getByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That task is no longer on the board.");
  expect(screen.getByTestId("proposal")).toBeTruthy();
});

test("Reject needs a reason: a quick one, words, or both", async () => {
  render(<ApprovalCard row={waiting({})} now={NOW} />);
  await userEvent.click(card().getByRole("button", { name: "Reject" }));
  const form = within(screen.getByRole("form", { name: "Reject" }));
  expect((form.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(form.getByRole("button", { name: "Wrong data" }));
  await userEvent.type(form.getByLabelText("Reason in your words"), "  Made-up: done by hand  ");
  await userEvent.click(form.getByRole("button", { name: "Reject" }));
  expect(convex.mutation(api.assistant.dismiss)).toHaveBeenCalledWith({ id: "p1", code: "wrong_data", reason: "Made-up: done by hand" });
  expect(convex.mutation(api.assistant.approve)).not.toHaveBeenCalled();
});

test("a decision to record is edited whole, owner and revisit date included, in the same meeting", async () => {
  const record = waiting({
    kind: "decision_record",
    payload: { title: "Made-up: per seat", decision: "We charge per seat.", ownerEmail: "dana@example.test", meetingId: "m1" },
    about: { task: null, deal: null, assignee: "Dana Example" },
  });
  render(<ApprovalCard row={record} now={NOW} />);
  expect(card().getByTestId("proposal-sentence").textContent).toBe('Record a decision, owned by Dana Example: "Made-up: per seat"');
  await userEvent.click(card().getByRole("button", { name: "Edit then approve" }));
  expect((card().getByLabelText("Owner") as HTMLSelectElement).value).toBe("dana@example.test");
  await userEvent.type(card().getByLabelText("Revisit on"), "2027-01-05");
  await userEvent.type(card().getByLabelText("Context"), "From the call.");
  await userEvent.click(card().getByRole("button", { name: "Approve with changes" }));
  expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({
    id: "p1",
    edit: {
      title: "Made-up: per seat",
      decision: "We charge per seat.",
      context: "From the call.",
      ownerEmail: "dana@example.test",
      revisitOn: "2027-01-05",
      meetingId: "m1",
    },
  });
});

test("a model's text is the characters it is: in the sentence, the reason and a draft", () => {
  const html = '<img src=x onerror="alert(1)"><b>Bold</b>';
  const markdown = "[A link](https://example.com) and **stars**";
  render(
    <ApprovalCard
      row={waiting({
        kind: "draft",
        why: html,
        payload: { title: markdown, body: html },
        effect: { changes: [], text: { title: markdown, body: `${markdown}\n${html}` } },
      })}
      now={NOW}
    />,
  );
  expect(document.querySelector("img, b")).toBeNull();
  expect(screen.getByTestId("proposal").querySelectorAll("a")).toHaveLength(0);
  expect(screen.getByTestId("draft-body").textContent).toContain(`${markdown}\n${html}`);
  expect(screen.getByTestId("proposal").textContent).toContain(`Why: ${html}`);
  // A draft is kept, not approved: nothing is ever sent.
  expect(card().getByRole("button", { name: "Keep" })).toBeTruthy();
});
