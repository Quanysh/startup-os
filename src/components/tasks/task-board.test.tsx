// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { defaultView } from "@/lib/tasks/view";
import { mockConvex } from "@/test-support/convex";
import { TaskBoard } from "./task-board";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// Every name, address and title here is made up.
const ME = "sam@example.com";
const OTHER = "ada@example.com";

const card = (
  id: string,
  { to = null, company = null }: { to?: string | null; company?: "us" | "kz" | null } = {},
) => ({
  id,
  title: `Card ${id}`,
  notes: null,
  kind: "task",
  column: "backlog",
  due: null,
  goalId: null,
  goalTitle: null,
  doneAt: null,
  company,
  assignee: to === null ? null : { status: "teammate", email: to, name: null },
});

const OWNER: ViewerProfile = {
  role: "owner",
  companies: ["us", "kz"],
  areas: ["board", "scorecard", "admin"],
  email: "owner@example.com",
  name: "Olive Owner",
};
const ENGINEER: ViewerProfile = {
  role: "engineer",
  companies: ["kz"],
  areas: ["product", "board"],
  email: ME,
  name: null,
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.team.assignable, []);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const show = (
  board: Partial<Record<"backlog" | "this_week" | "doing" | "done", object[]>>,
  viewer: ViewerProfile | null,
  companyInView?: "us" | "kz",
) => {
  convex.setQuery(api.tasks.board, { backlog: [], this_week: [], doing: [], done: [], ...board });
  let tree = <TaskBoard />;
  if (companyInView) {
    window.localStorage.setItem("startup-os:company", companyInView);
    tree = <CompanyProvider>{tree}</CompanyProvider>;
  }
  if (viewer) tree = <ViewerProvider viewer={viewer}>{tree}</ViewerProvider>;
  render(tree);
  return userEvent.setup();
};

const column = (title: string) => screen.getByRole("region", { name: new RegExp(`^${title}`) });
const cardsIn = (title: string) =>
  within(column(title))
    .queryAllByRole("button", { name: /^Card / })
    .map((b) => b.textContent);
const countIn = (title: string) =>
  within(column(title)).getByRole("heading").textContent?.slice(title.length);
const whoButton = () => screen.getByRole("button", { name: /^Assignee/ });
/** What the Assignee filter says it holds: "Everyone", "Me", "2 chosen". */
const who = () => whoButton().textContent?.replace(/^Assignee/, "");
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(whoButton());
  await user.click(screen.getByRole("checkbox", { name }));
  await user.keyboard("{Escape}");
};
const grip = (title: string) => screen.getByRole("button", { name: `Move ${title}` });
const moved = () => convex.mutation(api.tasks.move).mock.calls.at(-1)?.[0];
/** The board's own status line: the bulk bar's result (the board's keyboard one is apart). */
const statusText = () =>
  screen
    .getAllByRole("status")
    .find((node) => !node.hasAttribute("data-board-status") && node.textContent !== "")?.textContent;

describe("TaskBoard: whose cards", () => {
  const BOARD = {
    backlog: [card("a", { to: ME }), card("b", { to: OTHER }), card("c")],
    doing: [card("d", { to: ME })],
  };

  test("the owner starts on everyone's tasks", () => {
    show(BOARD, OWNER);
    expect(who()).toBe("Everyone");
    expect(cardsIn("Backlog")).toEqual(["Card a", "Card b", "Card c"]);
  });

  test("outside the app shell the viewer is the owner, on everyone's tasks", () => {
    show(BOARD, null);
    expect(who()).toBe("Everyone");
  });

  test("anyone else starts on their own", () => {
    show(BOARD, ENGINEER);
    expect(who()).toBe("Me");
    expect(cardsIn("Backlog")).toEqual(["Card a"]);
    expect(cardsIn("Doing")).toEqual(["Card d"]);
  });

  test("column counts follow the filter", async () => {
    const user = show(BOARD, ENGINEER);
    expect(countIn("Backlog")).toBe("1");
    await pick(user, "Everyone");
    expect(who()).toBe("Everyone");
    expect(countIn("Backlog")).toBe("3");
    expect(cardsIn("Backlog")).toEqual(["Card a", "Card b", "Card c"]);
    await pick(user, "Unassigned");
    expect(cardsIn("Backlog")).toEqual(["Card c"]);
    expect(screen.getByText("Showing 1 of 4")).toBeTruthy();
  });

  test("a person on the cards can be picked, and Unassigned beside them", async () => {
    const user = show(BOARD, OWNER);
    await user.click(whoButton());
    await user.click(screen.getByRole("checkbox", { name: "ada" }));
    await user.click(screen.getByRole("checkbox", { name: "Unassigned" }));
    expect(cardsIn("Backlog")).toEqual(["Card b", "Card c"]);
    expect(who()).toBe("2 chosen");
  });

  test("with nothing assigned to the viewer, Mine says so and offers everyone's", async () => {
    const user = show({ backlog: [card("b", { to: OTHER })] }, ENGINEER);
    expect(screen.getByText("Nothing assigned to you.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show everyone's tasks" }));
    expect(who()).toBe("Everyone");
    expect(cardsIn("Backlog")).toEqual(["Card b"]);
    expect(screen.queryByText("Nothing assigned to you.")).toBeNull();
  });

  test("an empty board under Everyone is just an empty board", () => {
    show({}, OWNER);
    expect(screen.queryByText("Nothing assigned to you.")).toBeNull();
  });

  test("a card added under Me starts assigned to the viewer, so it stays in sight", async () => {
    convex.setQuery(api.team.assignable, [{ email: ME, name: null }]);
    const user = show({}, ENGINEER);
    await user.click(screen.getByRole("button", { name: "Add a card to Backlog" }));
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe(ME);
  });

  test("a card added under Everyone starts unassigned", async () => {
    const user = show({}, OWNER);
    await user.click(screen.getByRole("button", { name: "Add a card to Backlog" }));
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("");
  });
});

describe("TaskBoard: adding at the top", () => {
  test("a column's + opens the form above its cards, and the card goes first", async () => {
    const user = show({ backlog: [card("a"), card("b")] }, OWNER);
    expect(within(column("Backlog")).queryByRole("button", { name: "Add a card" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add a card to Backlog" }));
    const input = within(column("Backlog")).getByLabelText("New card in Backlog");
    expect(
      input.compareDocumentPosition(screen.getByRole("button", { name: "Card a" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.type(input, "Urgent{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Urgent", column: "backlog", index: 0 }),
    );
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a card to Backlog" }));
  });

  test("Done has no +: a finished card is not added there by hand", () => {
    show({}, OWNER);
    expect(screen.queryByRole("button", { name: "Add a card to Done" })).toBeNull();
  });

  test("New task opens the full editor, empty", async () => {
    const user = show({}, OWNER);
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("heading", { name: "New card" })).toBeTruthy();
  });
});

describe("TaskBoard: search, filters and sort", () => {
  const BOARD = {
    backlog: [
      { ...card("a"), title: "Card a invoice", due: "2026-10-20" },
      { ...card("b"), notes: "invoice attached", due: "2026-10-01" },
      { ...card("c"), kind: "issue" },
    ],
  };

  test("search narrows every column to the matching cards", async () => {
    const user = show(BOARD, OWNER);
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "INVOICE");
    await waitFor(() => expect(cardsIn("Backlog")).toEqual(["Card a invoice", "Card b"]));
    expect(countIn("Backlog")).toBe("2");
  });

  test("type and due filters", async () => {
    const user = show(BOARD, OWNER);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "Problems");
    expect(cardsIn("Backlog")).toEqual(["Card c"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "Any type");
    await user.selectOptions(screen.getByRole("combobox", { name: "Due" }), "Overdue");
    expect(cardsIn("Backlog")).toEqual(["Card b"]);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(cardsIn("Backlog")).toHaveLength(3);
  });

  test("sorted by due date, the header says so and cards keep their place in a column", async () => {
    const user = show(BOARD, OWNER);
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "Due date");
    expect(cardsIn("Backlog")).toEqual(["Card b", "Card a invoice", "Card c"]);
    expect(within(column("Backlog")).getByText("Sorted by due date: drag between columns to move")).toBeTruthy();
    // Within a column a move would reshuffle the stored order: nothing happens.
    grip("Card b").focus();
    await user.keyboard("{ArrowDown}");
    expect(convex.mutation(api.tasks.move)).not.toHaveBeenCalled();
    // Between columns the card goes to the top of the stored order there.
    await user.keyboard("{ArrowRight}");
    expect(moved()).toEqual({ id: "b", column: "this_week", index: 0 });
  });
});

describe("TaskBoard: the view in the address", () => {
  test("a view handed in is shown, and every change is handed back", async () => {
    const onView = vi.fn();
    convex.setQuery(api.tasks.board, {
      backlog: [card("a", { to: ME }), card("b")],
      this_week: [],
      doing: [],
      done: [],
    });
    render(
      <ViewerProvider viewer={OWNER}>
        <TaskBoard view={{ ...defaultView({ isOwner: true }), who: ["none"] }} onView={onView} />
      </ViewerProvider>,
    );
    expect(cardsIn("Backlog")).toEqual(["Card b"]);
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Due" }), "Overdue");
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ who: ["none"], due: "overdue" }));
  });
});

describe("TaskBoard: the list", () => {
  test("shows the same cards as a table, sorted by its headers", async () => {
    const user = show(
      { backlog: [card("a"), card("b")], doing: [{ ...card("c"), column: "doing" }] },
      OWNER,
    );
    await user.click(screen.getByRole("button", { name: "List" }));
    const table = screen.getByRole("table", { name: "Tasks" });
    const titles = () =>
      within(table)
        .getAllByRole("button", { name: /^Card / })
        .map((b) => b.textContent);
    expect(titles()).toEqual(["Card a", "Card b", "Card c"]);
    await user.click(within(screen.getByRole("columnheader", { name: /^Title/ })).getByRole("button"));
    await user.click(within(screen.getByRole("columnheader", { name: /^Title/ })).getByRole("button"));
    expect(titles()).toEqual(["Card c", "Card b", "Card a"]);
    expect(screen.getByRole("columnheader", { name: /^Title/ }).getAttribute("aria-sort")).toBe("descending");
  });
});

describe("TaskBoard: bulk actions", () => {
  const BOARD = { backlog: [card("a"), card("b"), card("c")] };

  test("selecting cards brings up the bar; moving them reports how it went", async () => {
    const user = show(BOARD, OWNER);
    expect(screen.queryByRole("region", { name: "Selected cards" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Select Card a" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Card c" }));
    const bar = screen.getByRole("region", { name: "Selected cards" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    await user.selectOptions(within(bar).getByRole("combobox", { name: "Move to" }), "Doing");
    expect(convex.mutation(api.tasks.move).mock.calls.map((call) => call[0])).toEqual([
      { id: "a", column: "doing", index: Number.MAX_SAFE_INTEGER },
      { id: "c", column: "doing", index: Number.MAX_SAFE_INTEGER },
    ]);
    await waitFor(() => expect(statusText()).toBe("2 moved to Doing"));
    expect(screen.queryByRole("region", { name: "Selected cards" })).toBeNull();
  });

  test("a refusal is said in the server's words, and that card stays selected", async () => {
    convex
      .mutation(api.tasks.update)
      .mockImplementation(async (args: { id: string }) => {
        if (args.id === "b") throw new ConvexError("That person cannot be given this task.");
        return null;
      });
    convex.setQuery(api.team.assignable, [{ email: OTHER, name: "Ada" }]);
    const user = show(BOARD, OWNER);
    await user.click(screen.getByRole("checkbox", { name: "Select Card a" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Card b" }));
    const bar = screen.getByRole("region", { name: "Selected cards" });
    await user.selectOptions(within(bar).getByRole("combobox", { name: "Assign to" }), "Ada");
    await waitFor(() =>
      expect(statusText()).toBe("1 assigned to Ada, 1 refused: That person cannot be given this task."),
    );
    expect(within(screen.getByRole("region", { name: "Selected cards" })).getByText("1 selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select Card b" }) as HTMLInputElement).checked).toBe(true);
  });

  test("delete asks first", async () => {
    const user = show(BOARD, OWNER);
    await user.click(screen.getByRole("checkbox", { name: "Select Card b" }));
    const bar = screen.getByRole("region", { name: "Selected cards" });
    await user.click(within(bar).getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.tasks.remove)).not.toHaveBeenCalled();
    expect(within(bar).getByText("Delete 1 card?")).toBeTruthy();
    await user.click(within(bar).getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.tasks.remove)).toHaveBeenCalledWith({ id: "b" });
    await waitFor(() => expect(statusText()).toBe("1 deleted"));
  });
});

describe("TaskBoard: a company in view", () => {
  const BOARD = {
    backlog: [card("s"), card("u", { company: "us" }), card("k", { company: "kz" })],
  };

  test("shows that company's tasks and the shared ones", () => {
    show(BOARD, OWNER, "kz");
    expect(cardsIn("Backlog")).toEqual(["Card s", "Card k"]);
    expect(countIn("Backlog")).toBe("2");
  });

  test("with no company in view, everything the server sent shows", () => {
    show(BOARD, OWNER);
    expect(cardsIn("Backlog")).toEqual(["Card s", "Card u", "Card k"]);
  });

  test("a stored company the viewer is not on hides nothing", async () => {
    const user = show({ backlog: [card("s"), card("k", { company: "kz" })] }, ENGINEER, "us");
    await pick(user, "Everyone");
    expect(cardsIn("Backlog")).toEqual(["Card s", "Card k"]);
  });
});

describe("TaskBoard: moving a card while some are filtered out", () => {
  // The server's index counts the cards it sent, not the ones left on screen.
  const BOARD = {
    backlog: [card("x", { to: OTHER }), card("a", { to: ME }), card("y"), card("c", { to: ME })],
    this_week: [card("p", { to: OTHER })],
    doing: [card("q"), card("m", { to: ME }), card("r")],
  };

  test("up one place among mine lands just above the card it passed", async () => {
    const user = show(BOARD, ENGINEER);
    expect(cardsIn("Backlog")).toEqual(["Card a", "Card c"]);
    grip("Card c").focus();
    await user.keyboard("{ArrowUp}");
    expect(moved()).toEqual({ id: "c", column: "backlog", index: 1 });
  });

  test("down past the last of mine lands just after it", async () => {
    const user = show(BOARD, ENGINEER);
    grip("Card a").focus();
    await user.keyboard("{ArrowDown}");
    expect(moved()).toEqual({ id: "a", column: "backlog", index: 3 });
  });

  test("into a column where none of mine show goes to that column's end", async () => {
    const user = show(BOARD, ENGINEER);
    grip("Card a").focus();
    await user.keyboard("{ArrowRight}");
    expect(moved()).toEqual({ id: "a", column: "this_week", index: 1 });
  });

  test("into a column beside a card of mine keeps to that card's side", async () => {
    const user = show({ ...BOARD, this_week: [card("n", { to: ME })] }, ENGINEER);
    grip("Card n").focus();
    await user.keyboard("{ArrowRight}");
    // Dropped on the first row of Doing, where "m" shows: above "m", below "q".
    expect(moved()).toEqual({ id: "n", column: "doing", index: 1 });
  });

  test("Done orders itself, so a card entering it is reported first", async () => {
    const user = show({ doing: [card("m", { to: ME })], done: [card("z"), card("w")] }, ENGINEER);
    grip("Card m").focus();
    await user.keyboard("{ArrowRight}");
    expect(moved()).toEqual({ id: "m", column: "done", index: 0 });
  });

  test("the same holds for cards hidden by the company in view", async () => {
    const user = show(
      {
        backlog: [
          card("u", { company: "us" }),
          card("k1", { company: "kz" }),
          card("u2", { company: "us" }),
          card("k2", { company: "kz" }),
        ],
      },
      OWNER,
      "kz",
    );
    grip("Card k2").focus();
    await user.keyboard("{ArrowUp}");
    expect(moved()).toEqual({ id: "k2", column: "backlog", index: 1 });
  });

  test("with nothing filtered out the index goes through as it is", async () => {
    const user = show(BOARD, OWNER);
    grip("Card c").focus();
    await user.keyboard("{ArrowUp}");
    expect(moved()).toEqual({ id: "c", column: "backlog", index: 2 });
  });
});

describe("TaskBoard: when the server refuses", () => {
  test("a refused move is explained in the server's words", async () => {
    convex
      .mutation(api.tasks.move)
      .mockRejectedValue(new ConvexError("That task no longer exists."));
    const user = show({ backlog: [card("a"), card("b")] }, OWNER);
    grip("Card a").focus();
    await user.keyboard("{ArrowDown}");
    expect((await screen.findByRole("alert")).textContent).toBe("That task no longer exists.");
  });
});
