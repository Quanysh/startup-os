// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { BoardLane } from "@/components/board/board";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { defaultView, personKey } from "@/lib/tasks/view";
import { mockConvex } from "@/test-support/convex";
import { TaskBoard } from "./task-board";

// The rows per person. A drag between rows cannot be played in jsdom, so the
// shared board is stood in for by one that keeps what it was given: the test
// then drops a card where a person would, through the board's own `onMove`.

type Props = {
  lanes?: readonly BoardLane[];
  columns: readonly { id: string; title: string }[];
  columnHeaderAction?: (column: { id: string; title: string }) => React.ReactNode;
  columnTop?: (column: { id: string; title: string }) => React.ReactNode;
  items: Record<string, { id: string; title: string }[]>;
  onMove: (id: string, column: string, index: number) => void;
};
const board: { props: Props | null } = { props: null };
vi.mock("@/components/board/board", () => ({
  Board: (props: Props) => {
    board.props = props;
    return (
      <div>
        {props.lanes?.map((lane) => (
          <div key={lane.id} role="group" aria-label={lane.label}>
            {lane.header}
            {lane.columnIds.map((id) => {
              const column = props.columns.find((c) => c.id === id)!;
              return (
                <div key={id}>
                  {props.columnHeaderAction?.(column)}
                  {props.columnTop?.(column)}
                </div>
              );
            })}
            {!lane.folded &&
              lane.columnIds.flatMap((column) =>
                (props.items[column] ?? []).map((card) => <p key={card.id}>{card.title}</p>),
              )}
          </div>
        ))}
      </div>
    );
  },
}));
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 14, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// Every name, address and title here is made up.
const ME = "sam@example.com";
const ADA = "ada@example.com";
const card = (id: string, to: string | null, over: Record<string, unknown> = {}) => ({
  id,
  title: `Card ${id}`,
  notes: null,
  kind: "task",
  column: "backlog",
  due: null,
  goalId: null,
  goalTitle: null,
  doneAt: null,
  createdAt: 1,
  company: "kz",
  mentions: [],
  origin: null,
  assignee: to === null ? null : { status: "teammate", email: to, name: to === ADA ? "Ada" : "Sam" },
  ...over,
});

const ENGINEER: ViewerProfile = {
  role: "engineer",
  companies: ["kz"],
  areas: ["board"],
  email: ME,
  name: "Sam",
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.team.assignable, []);
  convex.setQuery(api.tasks.board, {
    backlog: [card("a", ME), card("b", ADA, { due: "2026-10-01" }), card("c", null)],
    this_week: [card("d", ADA, { column: "this_week" })],
    doing: [],
    done: [card("z", null, { column: "done" })],
  });
});
afterEach(() => {
  cleanup();
  board.props = null;
});

const draw = (folded: string[] = []) => {
  const onView = vi.fn();
  render(
    <ViewerProvider viewer={ENGINEER}>
      <TaskBoard
        view={{ ...defaultView({ isOwner: false }), who: "all", group: "person", folded }}
        onView={onView}
      />
    </ViewerProvider>,
  );
  return { onView, user: userEvent.setup() };
};
const drop = (id: string, lane: string, column: string, index = 0) =>
  act(() => board.props!.onMove(id, `${lane}|${column}`, index));

describe("rows per person", () => {
  test("one row each: the viewer first, then by name, Unassigned last, with counts", () => {
    draw();
    expect(board.props!.lanes!.map((lane) => lane.label)).toEqual(["Sam (you)", "Ada", "Unassigned"]);
    const ada = screen.getByRole("group", { name: "Ada" });
    expect(within(ada).getByRole("button", { name: /^Ada/ }).textContent).toContain("2 open");
    expect(within(ada).getByText("1 overdue")).toBeTruthy();
    // Unassigned holds a finished card too, which is not open.
    expect(within(screen.getByRole("group", { name: "Unassigned" })).getByText("1 open")).toBeTruthy();
  });

  test("a row folds, and the fold is kept in the view", async () => {
    const { onView, user } = draw();
    await user.click(within(screen.getByRole("group", { name: "Ada" })).getByRole("button", { name: /^Ada/ }));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ folded: [personKey(ADA)] }));
  });

  test("a folded row shows its header only", () => {
    draw([personKey(ADA)]);
    const ada = screen.getByRole("group", { name: "Ada" });
    expect(within(ada).getByRole("button", { name: /^Ada/ }).getAttribute("aria-expanded")).toBe("false");
    expect(within(ada).queryByText("Card b")).toBeNull();
  });

  test("dropped in another person's row, the card is given to them", async () => {
    draw();
    await drop("a", personKey(ADA), "backlog");
    expect(convex.mutation(api.tasks.update)).toHaveBeenCalledWith({ id: "a", assignee: ADA });
    expect(convex.mutation(api.tasks.move)).not.toHaveBeenCalled();
  });

  test("in another row and another column, both change in one save", async () => {
    draw();
    await drop("c", personKey(ME), "doing");
    expect(convex.mutation(api.tasks.update)).toHaveBeenCalledWith({
      id: "c",
      assignee: ME,
      column: "doing",
    });
  });

  test("dropped on Unassigned, the card is given to nobody", async () => {
    draw();
    await drop("b", "none", "backlog");
    expect(convex.mutation(api.tasks.update)).toHaveBeenCalledWith({ id: "b", assignee: null });
  });

  test("a refusal is said in the server's words, and the card stays where it was", async () => {
    convex
      .mutation(api.tasks.update)
      .mockRejectedValue(new ConvexError("That person cannot be given this task."));
    draw();
    await drop("a", personKey(ADA), "backlog");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That person cannot be given this task.",
    );
    expect(within(screen.getByRole("group", { name: "Sam (you)" })).getByText("Card a")).toBeTruthy();
  });

  test("the row of someone who cannot be named takes no card", async () => {
    convex.setQuery(api.tasks.board, {
      backlog: [card("a", ME), card("r", null, { assignee: { status: "removed", email: null, name: null } })],
      this_week: [],
      doing: [],
      done: [],
    });
    draw();
    await drop("a", "removed", "backlog");
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A card can be dropped only on a person's row or on Unassigned.",
    );
  });

  test("within a row it is an ordinary move, counted among all the column's cards", async () => {
    draw();
    // Ada's row shows b in Backlog; all of Backlog is a, b, c. Dropped above b: index 1.
    await drop("d", personKey(ADA), "backlog", 0);
    expect(convex.mutation(api.tasks.move)).toHaveBeenCalledWith({ id: "d", column: "backlog", index: 1 });
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
  });
});

describe("adding a card inside a person's row", () => {
  test("each row's open columns have a +, Done has none", () => {
    draw();
    const ada = screen.getByRole("group", { name: "Ada" });
    expect(within(ada).getByRole("button", { name: "Add a card to Backlog for Ada" })).toBeTruthy();
    expect(within(ada).getByRole("button", { name: "Add a card to Doing for Ada" })).toBeTruthy();
    expect(within(ada).queryByRole("button", { name: /Add a card to Done/ })).toBeNull();
  });

  test("the form opens at the top of that column, with the card already that person's", async () => {
    convex.setQuery(api.team.assignable, [{ email: ADA, name: "Ada" }]);
    const { user } = draw();
    const ada = screen.getByRole("group", { name: "Ada" });
    await user.click(within(ada).getByRole("button", { name: "Add a card to This week for Ada" }));
    const picker = within(ada).getByRole("combobox", { name: /assign|who/i }) as HTMLSelectElement;
    expect(picker.selectedOptions[0]!.textContent).toBe("Ada");
  });

  test("in Unassigned, the card starts with nobody", async () => {
    const { user } = draw();
    const none = screen.getByRole("group", { name: "Unassigned" });
    await user.click(within(none).getByRole("button", { name: "Add a card to Backlog for Unassigned" }));
    const picker = within(none).getByRole("combobox", { name: /assign|who/i }) as HTMLSelectElement;
    expect(picker.value).toBe("");
  });
});
