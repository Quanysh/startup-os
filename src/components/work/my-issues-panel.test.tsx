// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { MyIssuesPanel } from "./my-issues-panel";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;
const OK = { state: "ok", message: null, lastOkAt: NOW - 5 * 60_000 };

// Every identifier and title here is made up.
const issue = (n: number, stateType: string, over: object = {}) => ({
  kind: "issue",
  issueId: `id-${n}`,
  identifier: `ENG-${n}`,
  title: `Made-up title ${n}`,
  url: `https://linear.app/example/issue/ENG-${n}/made-up`,
  stateType,
  stateName: "",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "",
  mine: true,
  priority: 0,
  updatedAt: NOW - n * HOUR,
  ...over,
});

let convex: ReturnType<typeof mockConvex>;
const show = (issues: object[], source: object = OK) => {
  convex.setQuery(api.workTools.myIssues, { source, issues });
  return render(<MyIssuesPanel />);
};

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("MyIssuesPanel", () => {
  test("is titled, and shows a skeleton while loading", () => {
    render(<MyIssuesPanel />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Your Linear issues");
    expect(screen.getByTestId("my-issues-loading")).toBeTruthy();
  });

  test("never read: says so, and the owner is sent to the owner's settings", () => {
    show([], { state: null, message: null, lastOkAt: null });
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    // Not "no issue": nothing is known.
    expect(screen.queryByText("No open Linear issue is assigned to you.")).toBeNull();
  });

  test("never pushed, for a teammate: the link is to their own Connect page", () => {
    convex.setQuery(api.workTools.myIssues, {
      source: { state: null, message: null, lastOkAt: null },
      issues: [],
    });
    render(
      <ViewerProvider
        viewer={{ role: "sales", companies: ["us"], areas: ["today"], email: null, name: null }}
      >
        <MyIssuesPanel />
      </ViewerProvider>,
    );
    expect(screen.getByRole("link", { name: "Connect your Claude" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(screen.queryByText("Set it up")).toBeNull();
  });

  test("open issues by state, in progress first; finished ones are left to Linear", () => {
    show([
      issue(1, "backlog"),
      issue(2, "started", { dueDate: "2026-10-20" }),
      issue(3, "completed"),
      issue(4, "unstarted"),
      issue(5, "started"),
    ]);
    const sections = screen.getAllByRole("region").slice(1);
    expect(sections.map((s) => within(s).getByRole("heading", { level: 4 }).textContent)).toEqual([
      "In progress (2)",
      "Todo (1)",
      "Backlog (1)",
    ]);
    expect(within(sections[0]!).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "ENG-2Made-up title 2Due 2026-10-20",
      "ENG-5Made-up title 5",
    ]);
    expect(screen.queryByText("Made-up title 3")).toBeNull();
  });

  test("only Linear's own link becomes a link", () => {
    show([
      issue(1, "started"),
      issue(2, "started", { url: "https://elsewhere.example.test/x" }),
      issue(3, "started", { url: "" }),
    ]);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://linear.app/example/issue/ENG-1/made-up",
    ]);
    expect(links[0]!.getAttribute("rel")).toBe("noreferrer noopener");
    expect(screen.getByText("Made-up title 2")).toBeTruthy();
  });

  test("nothing open, a failed last read, and how fresh the list is", () => {
    const { container } = show([issue(3, "completed")], { ...OK, state: "error" });
    const said = [...container.querySelectorAll("p")].map((p) =>
      p.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(said).toEqual([
      "No open Linear issue is assigned to you.",
      "The last read failed, so this list may be out of date.",
      "Read 5m ago. Titles only; open an issue in Linear to change it.",
    ]);
  });

  test("a long column is cut, and says how many more there are", () => {
    show(Array.from({ length: 15 }, (_, n) => issue(n + 1, "started")));
    expect(screen.getAllByRole("link")).toHaveLength(12);
    expect(screen.getByText("and 3 more in Linear.")).toBeTruthy();
  });
});
