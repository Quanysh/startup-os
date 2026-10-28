// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import BoardPage from "@/app/(app)/board/page";
import { CompanyProvider } from "@/components/company-provider";
import { mockConvex } from "@/test-support/convex";
import { LinearBoard } from "./linear-board";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
// The board page reads the address for a link to one card (page.test.tsx). None here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const HOUR = 60 * 60 * 1000;

// Every identifier, title, team and person here is made up.
const issue = (issueId: string, over: object = {}) => ({
  kind: "issue",
  issueId,
  identifier: `ENG-${issueId}`,
  title: `Made-up title ${issueId}`,
  url: `https://linear.app/startup/issue/ENG-${issueId}/made-up-title`,
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "Ada Example",
  mine: true,
  priority: 0,
  updatedAt: NOW - HOUR,
  ...over,
});
const read = (over: object = {}) => ({ state: "ok", message: null, lastOkAt: NOW - 5 * 60_000, ...over });
const NEVER = { state: null, message: null, lastOkAt: null };

let convex: ReturnType<typeof mockConvex>;
const setIssues = (issues: object[], source: object = read()) =>
  convex.setQuery(api.workTools.issues, { source, issues });
const show = (issues: object[], source: object = read()) => {
  setIssues(issues, source);
  return render(<LinearBoard />);
};
const column = (title: string) => screen.getByRole("region", { name: new RegExp(`^${title}`) });
const cards = (title: string) =>
  within(column(title))
    .queryAllByRole("listitem")
    .map((li) => li.textContent ?? "");
const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll("p")]
    .filter((p) => !p.classList.contains("sr-only"))
    .map((p) => p.textContent?.replace(/\s+/g, " ").trim());

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("LinearBoard", () => {
  test("says what it is, and shows a skeleton while loading", () => {
    render(<LinearBoard />);
    expect(
      screen.getByText(
        "Linear's issues, read once a day. Cards open in Linear; to move one, move it there.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("linear-loading")).toBeTruthy();
  });

  test("never read: says so and links to the settings, with no empty board", () => {
    const { container } = show([], NEVER);
    expect(paragraphs(container)).toEqual([
      "Linear's issues, read once a day. Cards open in Linear; to move one, move it there.",
      "Linear has not been read yet. Set it up",
    ]);
    expect(screen.getByRole("link", { name: "Set it up" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(screen.queryByRole("region")).toBeNull();
  });

  test("four columns, each issue under its state", () => {
    show([
      issue("1", { stateType: "backlog" }),
      issue("2", { stateType: "unstarted" }),
      issue("3", { stateType: "started" }),
      issue("4", { stateType: "completed" }),
    ]);
    expect(screen.getAllByRole("region").map((r) => within(r).getByRole("heading").textContent)).toEqual(
      ["Backlog1", "Todo1", "In progress1", "Done1"],
    );
    expect(within(column("Done")).getByText("Last 14 days")).toBeTruthy();
    expect(cards("Backlog")[0]).toContain("Made-up title 1");
    expect(cards("Todo")[0]).toContain("Made-up title 2");
    expect(cards("In progress")[0]).toContain("Made-up title 3");
    expect(cards("Done")[0]).toContain("Made-up title 4");
  });

  test("no card can be picked up: there is no grip anywhere on the board", () => {
    const { container } = show([issue("1"), issue("2", { stateType: "backlog" })]);
    expect(container.querySelectorAll("[data-board-grip]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    // And nothing to add or edit: the only controls are links and the team filter.
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("a card is one link to the issue in Linear, opened in a new tab", () => {
    show([issue("7")]);
    const link = screen.getByRole("link", { name: "ENG-7 Made-up title 7" });
    expect(link.getAttribute("href")).toBe("https://linear.app/startup/issue/ENG-7/made-up-title");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  test.each([[""], ["javascript:alert(1)"], ["https://evil.test/x"]])(
    "a card whose url is %j renders no link",
    (url) => {
      show([issue("7", { url })]);
      expect(screen.queryByRole("link")).toBeNull();
      expect(cards("In progress")[0]).toContain("ENG-7 Made-up title 7");
    },
  );

  test("chips: team, assignee, priority and due date", () => {
    show([issue("1", { priority: 1, dueDate: "2026-10-20" })]);
    const card = within(column("In progress")).getByRole("listitem");
    expect(within(card).getByText("ENG").getAttribute("title")).toBe("Engineering");
    expect(within(card).getByText("Ada Example")).toBeTruthy();
    expect(within(card).getByText("Urgent")).toBeTruthy();
    expect(card.textContent).toContain("Oct 20");
    expect(card.textContent).not.toContain("Overdue");
  });

  test.each([
    [1, "Urgent"],
    [2, "High"],
    [3, "Medium"],
    [4, "Low"],
  ])("priority %i reads %s", (priority, label) => {
    show([issue("1", { priority })]);
    expect(screen.getByText(label)).toBeTruthy();
  });

  test("no priority shows no priority chip, and no assignee reads Unassigned", () => {
    show([issue("1", { priority: 0, assigneeName: "" })]);
    for (const label of ["Urgent", "High", "Medium", "Low"]) expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });

  test("a due date before today is overdue, unless the issue is finished", () => {
    show([
      issue("1", { dueDate: "2026-10-01" }),
      issue("2", { dueDate: "2026-10-01", stateType: "completed" }),
    ]);
    expect(cards("In progress")[0]).toContain("Overdue · Oct 1");
    expect(cards("Done")[0]).toContain("Oct 1");
    expect(cards("Done")[0]).not.toContain("Overdue");
  });

  test("with a company in view only its team's issues show, and no team is asked for", () => {
    window.localStorage.setItem("startup-os:company", "kz");
    setIssues([
      issue("1", { stateType: "backlog", teamKey: "SEC", teamName: "Second" }),
      issue("2", { stateType: "backlog", teamKey: "FIR", teamName: "First" }),
    ]);
    render(
      <CompanyProvider>
        <LinearBoard />
      </CompanyProvider>,
    );
    expect(cards("Backlog")).toHaveLength(1);
    expect(cards("Backlog")[0]).toContain("Made-up title 1");
    expect(screen.getByLabelText("Team").closest("div")?.className).toContain("hidden");
    window.localStorage.clear();
  });

  test("the team filter narrows every column", async () => {
    const user = userEvent.setup();
    show([
      issue("1", { stateType: "backlog" }),
      issue("2", { stateType: "backlog", teamKey: "OPS", teamName: "Operations" }),
      issue("3", { stateType: "started", teamKey: "OPS", teamName: "Operations" }),
      issue("4", { stateType: "completed" }),
    ]);
    const select = screen.getByLabelText("Team") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All teams",
      "Engineering",
      "Operations",
    ]);
    expect(cards("Backlog")).toHaveLength(2);

    await user.selectOptions(select, "Operations");
    expect(cards("Backlog")).toHaveLength(1);
    expect(cards("Backlog")[0]).toContain("Made-up title 2");
    expect(cards("In progress")[0]).toContain("Made-up title 3");
    expect(cards("Done")).toEqual([]);

    await user.selectOptions(select, "All teams");
    expect(cards("Backlog")).toHaveLength(2);
    expect(cards("Done")).toHaveLength(1);
  });

  // Until 2026-10-15 a footer said "Read 5m ago.": when Linear was read is
  // the Board header's on this tab now (freshness.forPage), said once.
  test("no footer repeats when it was read", () => {
    const { container } = show([issue("1")]);
    expect(container.textContent).not.toMatch(/Read \d/);
    expect(screen.queryByText("The last read failed, so this board may be out of date.")).toBeNull();
  });

  test.each([["error"], ["empty"], ["not_configured"]])(
    "when the last read did not succeed (%s) it says the board may be out of date",
    (state) => {
      const { container } = show(
        [issue("1")],
        read({ state, message: "Linear answered 401 for issues.", lastOkAt: NOW - 2 * HOUR }),
      );
      expect(paragraphs(container).at(-1)).toBe(
        "The last read failed, so this board may be out of date.",
      );
      expect(container.textContent).not.toContain("answered 401");
    },
  );
});

describe("the board page", () => {
  const EMPTY_TASKS = { backlog: [], this_week: [], doing: [], done: [] };
  const tab = (name: string) => screen.getByRole("tab", { name });
  const selected = () =>
    screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true")
      .map((t) => t.textContent);

  beforeEach(() => {
    convex.setQuery(api.tasks.board, EMPTY_TASKS);
  });

  test("is headed Board, with two tabs: the team's tasks, then the Linear mirror", () => {
    setIssues([issue("1")]);
    render(<BoardPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Board");
    expect(within(screen.getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Tasks",
      "Linear issues",
    ]);
  });

  test("opens on Tasks at once, without waiting for Linear", () => {
    render(<BoardPage />);
    expect(selected()).toEqual(["Tasks"]);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    expect(screen.getByRole("region", { name: /^Backlog/ })).toBeTruthy();
  });

  test("opens on Tasks even once Linear has been read", () => {
    setIssues([issue("1")]);
    render(<BoardPage />);
    expect(selected()).toEqual(["Tasks"]);
    expect(screen.getByRole("region", { name: /^Backlog/ })).toBeTruthy();
    // Three columns take new cards; Done does not.
    expect(screen.getAllByRole("button", { name: /^Add a card to / })).toHaveLength(3);
    expect(screen.queryByRole("link", { name: "ENG-1 Made-up title 1" })).toBeNull();
  });

  test("the Tasks tab is the one stop in the tab order", () => {
    render(<BoardPage />);
    expect(tab("Tasks").tabIndex).toBe(0);
    expect(tab("Linear issues").tabIndex).toBe(-1);
  });

  test("switching to Linear shows the mirror, and back shows the native board", async () => {
    const user = userEvent.setup();
    setIssues([issue("1")]);
    render(<BoardPage />);
    await user.click(tab("Linear issues"));
    expect(selected()).toEqual(["Linear issues"]);
    expect(screen.getByRole("link", { name: "ENG-1 Made-up title 1" })).toBeTruthy();
    // The mirror is read-only: nothing on it takes a new card.
    expect(screen.queryAllByRole("button", { name: /^Add a card to / })).toHaveLength(0);
    await user.click(tab("Tasks"));
    expect(selected()).toEqual(["Tasks"]);
    await user.click(screen.getAllByRole("button", { name: /^Add a card to / })[0]!);
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  test("the pick holds when Linear's status changes underneath", async () => {
    const user = userEvent.setup();
    setIssues([], NEVER);
    const view = render(<BoardPage />);
    await user.click(tab("Linear issues"));
    expect(screen.getByText(/^Linear has not been read yet\./)).toBeTruthy();
    setIssues([issue("1")]);
    view.rerender(<BoardPage />);
    expect(selected()).toEqual(["Linear issues"]);
  });

  test("arrow keys move between the tabs", async () => {
    const user = userEvent.setup();
    setIssues([issue("1")]);
    render(<BoardPage />);
    tab("Tasks").focus();
    await user.keyboard("{ArrowRight}");
    expect(selected()).toEqual(["Linear issues"]);
    expect(document.activeElement).toBe(tab("Linear issues"));
    await user.keyboard("{ArrowLeft}");
    expect(selected()).toEqual(["Tasks"]);
  });
});
