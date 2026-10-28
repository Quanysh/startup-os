// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { DecidedList, decidedSince } from "./decided";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const nav = { query: "tab=decided", replaced: [] as string[] };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/approvals",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));
const NOW = Date.UTC(2026, 9, 18, 9, 30);
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// Every name, title and reason is made up.
const base = {
  source: "proposal",
  agent: "engineering",
  bot: null,
  kind: "task_create",
  company: "us",
  reason: "Made-up why.",
  why: "Made-up why.",
  createdAt: NOW - 50 * 3_600_000,
  payload: { title: "Made-up task" },
  about: { task: null, deal: null, assignee: null },
  urgency: "normal",
  goal: null,
  decidedAt: NOW - 3_600_000,
  rejectCode: null,
  rejectReason: null,
  result: null,
  edited: false,
  edits: [],
  withdrawReason: null,
  withdrawNote: null,
  flagged: false,
  tool: null,
  toolName: null,
  arguments: null,
};
const ROWS = [
  { ...base, id: "d1", status: "approved", result: { taskId: "task123" }, edited: true, edits: [{ field: "Title", before: "Old", after: "Made-up task" }] },
  { ...base, id: "d2", status: "dismissed", rejectCode: "wrong_timing", rejectReason: "<b>Not</b> now" },
  { ...base, id: "d3", status: "expired", company: "kz" },
  { ...base, id: "d4", status: "auto_approved", bot: "growth", result: { taskId: "task9" } },
  { ...base, id: "d5", status: "withdrawn", withdrawReason: "superseded", withdrawNote: "<i>Merged</i> into the newer card." },
  {
    ...base,
    source: "tool_call",
    id: "a1",
    agent: "made-up.agent",
    kind: "tool_call",
    company: null,
    why: null,
    reason: null,
    payload: null,
    about: null,
    status: "denied",
    rejectReason: "Made-up: not this week",
    toolName: "Create a task",
    arguments: '{"title":"<b>x</b>"}',
  },
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  nav.query = "tab=decided";
  nav.replaced = [];
  convex.setQuery(api.assistant.decided, ROWS);
  convex.setQuery(api.trust.grants, []);
});
afterEach(cleanup);

const rows = () => screen.getAllByTestId("decided");

test("asks 30 days back from the page's clock, to the hour", () => {
  const seen: unknown[] = [];
  convex.setQueryBy(api.assistant.decided, (args) => {
    seen.push(args);
    return ROWS;
  });
  render(<DecidedList />);
  expect(seen[0]).toEqual({ since: Date.UTC(2026, 9, 18, 9) - 30 * 24 * 3_600_000 });
  expect(decidedSince(NOW)).toBe(Date.UTC(2026, 9, 18, 9) - 30 * 24 * 3_600_000);
});

test("how each ended: approved with what it made and what you changed, dismissed with your reason, expired, automatic, withdrawn, a denied call", () => {
  render(<DecidedList />);
  expect(rows().map((row) => row.querySelector("[data-slot=status-chip]")!.textContent)).toEqual([
    "Approved",
    "Dismissed",
    "Expired",
    "Approved automatically",
    "Withdrawn",
    "Denied",
  ]);
  expect(within(rows()[0]!).getByRole("link", { name: "Open the task on the board" }).getAttribute("href")).toBe("/board?task=task123");
  expect(rows()[0]!.textContent).toContain("you edited it first");
  expect(within(rows()[0]!).getByLabelText("What you changed").textContent).toContain("Old");
  // The owner's reason, code and words, as text.
  expect(rows()[1]!.textContent).toContain("Your reason: Wrong timing: <b>Not</b> now");
  expect(document.querySelector("b, i")).toBeNull();
  // Approved automatically: its bot, and a flag that revokes the grant.
  expect(rows()[3]!.textContent).toContain("Bot: growth");
  expect(within(rows()[3]!).getByRole("button", { name: "Flag and revoke" })).toBeTruthy();
  expect(rows()[4]!.textContent).toContain("Withdrawn by its proposer: superseded. <i>Merged</i> into the newer card.");
  // A tool call: what it would have run and the denial's words.
  expect(rows()[5]!.textContent).toContain("Run a tool: Create a task");
  expect(rows()[5]!.textContent).toContain("Your reason: Made-up: not this week");
});

test("the same filters as what waits, and how it ended, in the address", () => {
  nav.query = "tab=decided&company=kz";
  render(<DecidedList />);
  expect(rows()).toHaveLength(1);
  cleanup();
  nav.query = "tab=decided&decision=withdrawn";
  render(<DecidedList />);
  expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Withdrawn")]);
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "denied" } });
  expect(nav.replaced.at(-1)).toBe("/approvals?tab=decided&decision=denied");
});

test("nothing decided says so", () => {
  convex.setQuery(api.assistant.decided, []);
  render(<DecidedList />);
  expect(screen.getByText("Nothing was decided in the last 30 days.")).toBeTruthy();
});
