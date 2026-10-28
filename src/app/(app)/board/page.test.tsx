// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ViewerProvider } from "@/components/viewer-provider";
import { defaultView, type TaskView } from "@/lib/tasks/view";
import BoardPage from "./page";

// The page's part of a link to one card: `/board?task=<id>`. What the board
// does with it is in src/components/tasks/task-link.test.tsx.

const { replace, state } = vi.hoisted(() => ({ replace: vi.fn(), state: { search: "" } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
// The Linear tab's "Updated …" line has its own tests and would ask Convex.
vi.mock("@/components/freshness/freshness-indicator", () => ({
  PageFreshness: ({ page }: { page: string }) => <p>{`freshness of ${page}`}</p>,
}));
vi.mock("@/components/tasks/task-board", () => ({
  TaskBoard: ({
    linked,
    onLinkDone,
    view,
    onView,
  }: {
    linked: string | null;
    onLinkDone: () => void;
    view: TaskView;
    onView: (view: TaskView) => void;
  }) => (
    <>
      <button type="button" onClick={onLinkDone}>
        tasks, linked: {String(linked)}
      </button>
      <output aria-label="view">{JSON.stringify(view)}</output>
      <button type="button" onClick={() => onView({ ...view, due: "overdue" })}>
        overdue
      </button>
    </>
  ),
}));
vi.mock("@/components/work/linear-board", () => ({ LinearBoard: () => <p>linear</p> }));

afterEach(() => {
  cleanup();
  replace.mockClear();
  state.search = "";
});

describe("/board?task=<id>", () => {
  test("hands the id to the task board", () => {
    state.search = "task=abc123";
    render(<BoardPage />);
    expect(screen.getByRole("button", { name: "tasks, linked: abc123" })).toBeTruthy();
  });

  test("with no link the board is given none", () => {
    render(<BoardPage />);
    expect(screen.getByRole("button", { name: "tasks, linked: null" })).toBeTruthy();
  });

  test("when the board is done with the link, the address goes back to /board", async () => {
    state.search = "task=abc123";
    render(<BoardPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /tasks/ }));
    expect(replace).toHaveBeenCalledWith("/board");
  });

  test("a link arriving while the Linear tab is open shows the tasks", async () => {
    const view = render(<BoardPage />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Linear issues" }));
    expect(screen.getByText("linear")).toBeTruthy();
    // Linear's tab says when Linear was read; the tasks, the OS's own, do not.
    expect(screen.getByText("freshness of board_linear")).toBeTruthy();
    state.search = "task=abc123";
    view.rerender(<BoardPage />);
    expect(screen.getByRole("button", { name: "tasks, linked: abc123" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/freshness of/)).toBeNull();
  });
});

describe("/board's view in the address", () => {
  const shownView = () => JSON.parse(screen.getByLabelText("view").textContent!) as TaskView;

  test("the address is read into the board's view", () => {
    state.search = "q=deck&view=list&sort=due&dir=desc&who=none";
    render(<BoardPage />);
    expect(shownView()).toEqual({
      ...defaultView({ isOwner: true }),
      q: "deck",
      layout: "list",
      sort: { key: "due", dir: "desc" },
      who: ["none"],
    });
  });

  test("a teammate's empty address is their own cards", () => {
    render(
      <ViewerProvider
        viewer={{ role: "engineer", companies: ["kz"], areas: ["board"], email: "sam@example.com", name: null }}
      >
        <BoardPage />
      </ViewerProvider>,
    );
    expect(shownView().who).toEqual(["me"]);
  });

  test("a change to the view is written to the address, without scrolling", async () => {
    state.search = "view=list";
    render(<BoardPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "overdue" }));
    expect(replace).toHaveBeenCalledWith("/board?due=overdue&view=list", { scroll: false });
  });

  test("the card link is kept while the view changes, and dropped alone when the board is done with it", async () => {
    state.search = "task=abc123&view=list";
    render(<BoardPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "overdue" }));
    expect(replace).toHaveBeenLastCalledWith("/board?task=abc123&due=overdue&view=list", {
      scroll: false,
    });
    await user.click(screen.getByRole("button", { name: /tasks, linked/ }));
    expect(replace).toHaveBeenLastCalledWith("/board?view=list");
  });
});
