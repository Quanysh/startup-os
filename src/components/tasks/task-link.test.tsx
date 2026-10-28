// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { TaskBoard } from "./task-board";

// A link to one card: `/board?task=<id>`, which the board page hands down as
// `linked` (src/app/(app)/board/page.tsx). It is how a notification opens its
// task. Every name, address and title here is made up.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 13, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const KEY = "startup-os:company";
const card = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Card ${id}`,
  notes: null,
  kind: "task",
  column: "backlog",
  due: null,
  goalId: null,
  goalTitle: null,
  doneAt: null,
  company: null,
  assignee: null,
  mentions: [],
  origin: null,
  ...over,
});

const BOTH: ViewerProfile = {
  role: "cofounder",
  companies: ["us", "kz"],
  areas: ["board"],
  email: "cora@example.com",
  name: "Cora Founder",
};
const KZ_ONLY: ViewerProfile = { ...BOTH, role: "engineer", companies: ["kz"] };

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.team.assignable, []);
  convex.setQuery(api.goals.list, []);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const BOARD = {
  backlog: [card("a"), card("k", { company: "kz" }), card("u", { company: "us" })],
  this_week: [],
  doing: [card("theirs", { assignee: { status: "teammate", email: "ada@example.com", name: "Ada" } })],
  done: [card("d", { column: "done", doneAt: 1 })],
};

function show(
  linked: string | null,
  { viewer = BOTH, inView = "us", loading = false } = {},
) {
  convex.setQuery(api.tasks.board, loading ? undefined : BOARD);
  window.localStorage.setItem(KEY, inView);
  const onLinkDone = vi.fn();
  const tree = (id: string | null) => (
    <ViewerProvider viewer={viewer}>
      <CompanyProvider allowed={viewer.companies}>
        <TaskBoard linked={id} onLinkDone={onLinkDone} />
      </CompanyProvider>
    </ViewerProvider>
  );
  const view = render(tree(linked));
  return { onLinkDone, user: userEvent.setup(), relink: (id: string | null) => view.rerender(tree(id)) };
}

const editor = () => screen.queryByRole("dialog", { name: "Edit card" });
const titleField = () => screen.getByLabelText("Title") as HTMLTextAreaElement;

describe("a link to a card", () => {
  test("opens that card's editor", () => {
    show("a");
    expect(editor()).toBeTruthy();
    expect(titleField().value).toBe("Card a");
  });

  test("with no link nothing opens", () => {
    show(null);
    expect(editor()).toBeNull();
  });

  test("a finished card, and one that is somebody else's under “Mine”, open too", () => {
    const first = show("d");
    expect(titleField().value).toBe("Card d");
    cleanup();
    first.onLinkDone.mockClear();
    // A co-founder starts on their own tasks, where this card is not shown.
    show("theirs");
    expect(screen.queryByRole("button", { name: "Card theirs" })).toBeNull();
    expect(titleField().value).toBe("Card theirs");
  });

  test("closing the editor says the link is done with, once", async () => {
    const { user, onLinkDone } = show("a");
    expect(onLinkDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLinkDone).toHaveBeenCalledTimes(1);
  });

  test("once the link is gone the editor is closed, and a card opened by hand is not the link's", async () => {
    const { user, onLinkDone, relink } = show("a");
    relink(null);
    expect(editor()).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Assignee/ }));
    await user.click(screen.getByRole("checkbox", { name: "Everyone" }));
    await user.click(screen.getByRole("button", { name: "Card a" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLinkDone).not.toHaveBeenCalled();
  });

  test("waits for the board: nothing is opened or said while it loads", () => {
    show("a", { loading: true });
    expect(editor()).toBeNull();
    expect(screen.queryByText("That card is no longer on the board.")).toBeNull();
  });
});

describe("the company in view", () => {
  test("a viewer on both is switched to the card's company", () => {
    show("k", { inView: "us" });
    expect(window.localStorage.getItem(KEY)).toBe("kz");
    expect(titleField().value).toBe("Card k");
  });

  test("already on it, or a card shared by both: nothing is switched", () => {
    show("u", { inView: "us" });
    expect(window.localStorage.getItem(KEY)).toBe("us");
    cleanup();
    show("a", { inView: "kz" });
    expect(window.localStorage.getItem(KEY)).toBe("kz");
  });

  test("a viewer on one company has nothing to switch", () => {
    // What this browser remembers from another account is left alone.
    show("k", { viewer: KZ_ONLY, inView: "us" });
    expect(window.localStorage.getItem(KEY)).toBe("us");
    expect(titleField().value).toBe("Card k");
  });
});

describe("a link to a card that is not on the board", () => {
  test("says so instead of opening anything, and can be dismissed", async () => {
    const { user, onLinkDone } = show("gone");
    expect(editor()).toBeNull();
    expect(screen.getByText("That card is no longer on the board.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onLinkDone).toHaveBeenCalledTimes(1);
  });

  test("what the link holds is never shown", () => {
    show('<b>SECRET</b>"');
    expect(document.body.textContent).not.toContain("SECRET");
  });
});
