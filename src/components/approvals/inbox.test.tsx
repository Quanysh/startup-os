// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { ApprovalsInbox } from "./inbox";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const nav = { query: "", replaced: [] as string[] };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/approvals",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));
const NOW = Date.UTC(2026, 9, 18, 9);
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// Every name and title is made up.
const change = {
  source: "proposal",
  id: "p1",
  agent: "engineering",
  kind: "task_change",
  company: "us",
  reason: "Made-up reason.",
  createdAt: NOW - 120_000,
  payload: { taskId: "t1", column: "doing" },
  about: { task: "Made-up task", deal: null, assignee: null },
  changes: [{ field: "Column", before: "Backlog", after: "Doing" }],
  bot: null,
  tool: null,
  toolName: null,
  arguments: null,
  why: "Made-up why.",
  urgency: "normal",
  goal: null,
  evidence: null,
  effect: { changes: [{ field: "Column", before: "Backlog", after: "Doing" }], text: null },
  cash: false,
  duplicate: null,
};
const draft = {
  ...change,
  id: "p2",
  agent: "sales",
  kind: "draft",
  createdAt: NOW - 60_000,
  payload: { title: "Made-up draft", body: "b" },
  about: { task: null, deal: null, assignee: null },
  changes: [],
  effect: { changes: [], text: { title: "Made-up draft", body: "Line one\nLine two" } },
};
const call = {
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
  arguments: '{"title":"<b>Made-up</b>"}',
  why: null,
  urgency: "normal",
  goal: null,
  evidence: null,
  effect: null,
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  nav.query = "";
  nav.replaced = [];
  convex.setQuery(api.assistant.inbox, [call, draft, change]);
});
afterEach(cleanup);

const rows = () => screen.getAllByTestId("inbox-row");
/** The arguments a query was asked with, each render. */
const asked_ = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .map(([, args]) => args);

test("lists every waiting item with what it would do, before and after, and who", () => {
  render(<ApprovalsInbox />);
  expect(rows()).toHaveLength(3);
  // Oldest first where nothing is critical or at risk.
  expect(rows()[2]!.textContent).toContain("Run a tool: Create a task");
  // A model's arguments are text, never markup.
  expect(rows()[2]!.querySelector("b")).toBeNull();
  expect(rows()[0]!.textContent).toContain('Change "Made-up task": move it to Doing');
  expect(rows()[0]!.textContent).toMatch(/Column: Backlog.*Doing/);
  expect(rows()[0]!.textContent).toContain("Engineering manager");
  // Why, the goal (none, in grey) and a draft's full text, without a click.
  expect(rows()[0]!.textContent).toContain("Why: Made-up why.");
  expect(rows()[0]!.textContent).toContain("No goal");
  expect(within(rows()[1]!).getByLabelText("Full text").textContent).toContain("Line one\nLine two");
});

test("filters live in the address", () => {
  nav.query = "kind=tool_call";
  render(<ApprovalsInbox />);
  expect(rows()).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "sales" } });
  expect(nav.replaced.at(-1)).toBe("/approvals?agent=sales&kind=tool_call");
});

test("keys: j moves, x selects, a approves the selected through each one's own path", async () => {
  render(<ApprovalsInbox />);
  fireEvent.keyDown(window, { key: "x" });
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "x" });
  expect(screen.getByRole("button", { name: "Approve selected (2)" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "a" });
  await waitFor(() => expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({ id: "p1" }));
  expect(convex.mutation(api.agentRuntime.decide)).toHaveBeenCalledWith({ id: "a1", decision: "approve" });
  expect(convex.mutation(api.assistant.dismiss)).not.toHaveBeenCalled();
});

test("reject selected with one reason for all", async () => {
  render(<ApprovalsInbox />);
  fireEvent.click(screen.getByLabelText("Select every row in Waiting for you"));
  fireEvent.click(screen.getByRole("button", { name: "Reject selected (3)" }));
  const form = screen.getByRole("form", { name: "Reject" });
  // A reason is required: nothing is sent until one is picked or typed.
  expect((within(form).getByRole("button", { name: "Reject 3" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Wrong timing" }));
  fireEvent.change(within(form).getByLabelText("Reason in your words"), { target: { value: "Not this quarter" } });
  fireEvent.click(within(form).getByRole("button", { name: "Reject 3" }));
  await waitFor(() =>
    expect(convex.mutation(api.assistant.dismiss).mock.calls.map(([args]) => args)).toEqual([
      { id: "p1", code: "wrong_timing", reason: "Not this quarter" },
      { id: "p2", code: "wrong_timing", reason: "Not this quarter" },
    ]),
  );
  expect(convex.mutation(api.agentRuntime.decide)).toHaveBeenCalledWith({
    id: "a1",
    decision: "deny",
    reason: "Not this quarter",
  });
});

test("r rejects with a reason for each; a refusal stays listed with the server's words", async () => {
  convex.mutation(api.assistant.dismiss).mockImplementation(async (args: { id: string }) => {
    if (args.id === "p2") throw new ConvexError("That proposal has already been decided.");
    return null;
  });
  render(<ApprovalsInbox />);
  fireEvent.keyDown(window, { key: "x" });
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "x" });
  fireEvent.keyDown(window, { key: "r" });
  const form = screen.getByRole("form", { name: "Reject" });
  fireEvent.click(within(form).getByLabelText("Words for each"));
  const [first, second] = within(form).getAllByRole("textbox");
  fireEvent.change(first!, { target: { value: "Wrong client" } });
  fireEvent.change(second!, { target: { value: "Done already" } });
  fireEvent.click(within(form).getByRole("button", { name: "Reject 2" }));
  await waitFor(() =>
    expect(convex.mutation(api.assistant.dismiss).mock.calls.map(([args]) => args)).toEqual([
      { id: "p1", reason: "Wrong client" },
      { id: "p2", reason: "Done already" },
    ]),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("already been decided");
});

test("critical first, a cash goal pinned in its own section, and the age badge", () => {
  const HOUR = 3_600_000;
  const cash = {
    ...change,
    id: "p3",
    createdAt: NOW - 80 * HOUR,
    cash: true,
    goal: { id: "g1", title: "Made-up pre-seed", status: "on_track", cash: true },
    evidence: { kind: "deal", id: "d1", label: "Made-up Deal", href: "/sales" },
  };
  const critical = { ...draft, id: "p4", urgency: "critical", createdAt: NOW - 30 * HOUR };
  convex.setQuery(api.assistant.inbox, [call, draft, change, cash, critical]);
  render(<ApprovalsInbox />);
  const section = screen.getByRole("region", { name: "Cash and runway" });
  expect(within(section).getAllByTestId("inbox-row")).toHaveLength(1);
  expect(within(section).getByText("Made-up pre-seed")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "Made-up Deal" }).getAttribute("href")).toBe("/sales");
  expect(within(section).getByTestId("age").getAttribute("data-tone")).toBe("danger");
  const rest = screen.getByRole("region", { name: "Everything else" });
  const restRows = within(rest).getAllByTestId("inbox-row");
  expect(restRows[0]!.textContent).toContain("Critical");
  expect(within(restRows[0]!).getByTestId("age").getAttribute("data-tone")).toBe("warning");
  expect(within(restRows[1]!).getByTestId("age").getAttribute("data-tone")).toBeNull();
});

test("a forced near-duplicate carries its badge and the proposer's reason; urgency filters", () => {
  const forced = {
    ...change,
    id: "p5",
    urgency: "high",
    duplicate: { of: [{ id: "t9", title: "Made-up written cap" }], reason: "Made-up: this is the board vote" },
  };
  convex.setQuery(api.assistant.inbox, [forced, draft]);
  render(<ApprovalsInbox />);
  expect(screen.getByTestId("duplicate").textContent).toBe("Possible duplicate of “Made-up written cap”");
  expect(screen.getByText("Made-up: this is the board vote")).toBeTruthy();
  expect(screen.getByLabelText("Urgency")).toBeTruthy();
  // The duplicate reject code is one of the quick reasons.
  fireEvent.keyDown(window, { key: "r" });
  expect(within(screen.getByRole("form", { name: "Reject" })).getByRole("button", { name: "Duplicate" })).toBeTruthy();
});

test("one read of both companies: the page asks the inbox with no company, whatever company is in view", () => {
  render(<ApprovalsInbox />);
  const asked = asked_(api.assistant.inbox);
  expect(asked.length).toBeGreaterThan(0);
  for (const args of asked) expect(args).toEqual({});
});

test("approving many never approves a possible duplicate or a new deal: each stays, with why, for its own button", async () => {
  const forced = { ...change, id: "p5", duplicate: { of: [{ id: "t9", title: "Made-up near one" }], reason: null } };
  const deal = {
    ...change,
    id: "p6",
    kind: "deal_create",
    payload: { name: "Made-up Clinic" },
    about: { task: null, deal: null, assignee: null },
  };
  convex.setQuery(api.assistant.inbox, [change, forced, deal]);
  render(<ApprovalsInbox />);
  expect(screen.getAllByTestId("own-click")).toHaveLength(2);
  fireEvent.click(screen.getByLabelText("Select every row in Waiting for you"));
  fireEvent.click(screen.getByRole("button", { name: "Approve selected (3)" }));
  await waitFor(() => expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledTimes(1));
  expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({ id: "p1" });
  expect(await screen.findAllByRole("alert")).toHaveLength(2);
  // They stay selected, and the a key leaves them too.
  expect(screen.getByRole("button", { name: "Approve selected (2)" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "a" });
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledTimes(1);
  // Its own button approves it.
  const dealRow = rows().find((row) => row.textContent?.includes("Made-up Clinic"))!;
  fireEvent.click(within(dealRow).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(convex.mutation(api.assistant.approve)).toHaveBeenLastCalledWith({ id: "p6" }));
});

test("a draft is kept, not approved; it can be copied and edited", () => {
  render(<ApprovalsInbox />);
  const row = rows()[1]!;
  expect(within(row).getByRole("button", { name: "Keep" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Copy" })).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Edit then approve" }));
  expect((within(row).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("b");
  expect(within(row).getByRole("button", { name: "Keep with changes" })).toBeTruthy();
});

test("a new task is edited whole before approving, its assignee included", async () => {
  const create = {
    ...change,
    id: "p7",
    kind: "task_create",
    payload: { title: "Made-up review", assignee: "dana@example.test", column: "this_week" },
    about: { task: null, deal: null, assignee: "Dana Example" },
  };
  convex.setQuery(api.assistant.inbox, [create]);
  convex.setQuery(api.team.assignable, [
    { email: "dana@example.test", name: "Dana Example" },
    { email: "sam@example.test", name: null },
  ]);
  render(<ApprovalsInbox />);
  fireEvent.click(screen.getByRole("button", { name: "Edit then approve" }));
  expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("dana@example.test");
  fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "sam@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve with changes" }));
  await waitFor(() =>
    expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({
      id: "p7",
      edit: { title: "Made-up review", assignee: "sam@example.test", column: "this_week" },
    }),
  );
  // Who can be given it is asked of the proposal's own company.
  expect(asked_(api.team.assignable)).toContainEqual({ company: "us" });
});

test("arriving with ?id= puts the cursor on that row and brings it into view", () => {
  const into = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: into, configurable: true });
  nav.query = "id=p2";
  render(<ApprovalsInbox />);
  expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
  expect(into.mock.contexts[0]).toBe(rows()[1]);
});

test("below sm each row is a card: chips and text, who on its own line, then its actions, with no table", async () => {
  const narrow = vi.fn((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("matchMedia", narrow);
  try {
    render(<ApprovalsInbox />);
    expect(screen.queryByRole("table")).toBeNull();
    const cards = rows();
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(card.getAttribute("data-layout")).toBe("card");
    // A task change: Approve, Edit then approve, Reject, all in the card's own actions.
    const actions = within(within(cards[0]!).getByTestId("card-actions"));
    expect(actions.getAllByRole("button").map((button) => button.textContent)).toEqual(["Approve", "Edit then approve", "Reject"]);
    expect(within(cards[0]!).getByText("Engineering manager")).toBeTruthy();
    // A draft: Keep and Reject (and its edit).
    expect(within(within(cards[1]!).getByTestId("card-actions")).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Keep",
      "Edit then approve",
      "Reject",
    ]);
    // A tool call has nothing to edit.
    expect(within(within(cards[2]!).getByTestId("card-actions")).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Approve",
      "Reject",
    ]);
    // Keys and bulk work as on the wide layout.
    fireEvent.keyDown(window, { key: "x" });
    expect(screen.getByRole("button", { name: "Approve selected (1)" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({ id: "p1" }));
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Reject" }));
    expect(screen.getByRole("form", { name: "Reject" })).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});
