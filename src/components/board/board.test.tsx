// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Board } from "./board";

afterEach(cleanup);

const columns = [
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done", sortable: false },
] as const;

const card = (id: string, locked = false) => ({ id, title: `Card ${id}`, locked });

function setup(items: Record<string, ReturnType<typeof card>[]>) {
  const onMove = vi.fn();
  render(
    <Board
      columns={columns}
      items={items}
      getLabel={(c) => c.title}
      renderCard={(c) => <span>{c.title}</span>}
      canDrag={(c) => !c.locked}
      onMove={onMove}
    />,
  );
  return { onMove, user: userEvent.setup() };
}

const grip = (title: string) => screen.getByRole("button", { name: `Move ${title}` });
// dnd-kit keeps a live region of its own for pointer drags; this is the
// board's, for keyboard moves.
const spoken = () => document.querySelector("[data-board-status]")?.textContent;

describe("Board keyboard moves", () => {
  test("an arrow key on a card's grip moves it one place and says so", async () => {
    const { onMove, user } = setup({ doing: [card("a"), card("b")], done: [] });
    grip("Card a").focus();
    await user.keyboard("{ArrowDown}");
    expect(onMove).toHaveBeenCalledWith("a", "doing", 1);
    expect(spoken()).toBe("Card a moved to Doing, position 2.");
  });

  test("a card entering a column that keeps its own order goes first, with no position announced", async () => {
    const { onMove, user } = setup({ doing: [card("a"), card("b")], done: [card("z")] });
    grip("Card b").focus();
    await user.keyboard("{ArrowRight}");
    expect(onMove).toHaveBeenCalledWith("b", "done", 0);
    expect(spoken()).toBe("Card b moved to Done.");
  });

  test("up and down do nothing in a column that keeps its own order", async () => {
    const { onMove, user } = setup({ doing: [], done: [card("y"), card("z")] });
    grip("Card y").focus();
    await user.keyboard("{ArrowDown}");
    expect(onMove).not.toHaveBeenCalled();
    expect(spoken()).toBe("");
  });

  test("a key that moves nothing is left alone for the browser", async () => {
    const { onMove, user } = setup({ doing: [card("a")], done: [] });
    grip("Card a").focus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onMove).not.toHaveBeenCalled();
  });

  test("a card that cannot be moved has no grip", () => {
    // How a record mirrored from another system is shown read-only.
    setup({ doing: [card("a"), card("m", true)], done: [] });
    expect(screen.queryByRole("button", { name: "Move Card m" })).toBeNull();
    expect(screen.getByText("Card m")).toBeTruthy();
  });

  test("each column shows how many cards it holds", () => {
    setup({ doing: [card("a"), card("b")], done: [card("z")] });
    expect(screen.getByRole("heading", { name: /Doing/ }).textContent).toContain("2");
    expect(screen.getByRole("heading", { name: /Done/ }).textContent).toContain("1");
  });
});

describe("Board: optional slots", () => {
  test("a column can carry an action in its header and something above its cards", () => {
    render(
      <Board
        columns={columns}
        items={{ doing: [card("a")], done: [] }}
        getLabel={(c) => c.title}
        renderCard={(c) => <span>{c.title}</span>}
        onMove={vi.fn()}
        columnHeaderAction={(column) => <button type="button">Add to {column.title}</button>}
        columnTop={(column) => (column.id === "doing" ? <p>form at the top</p> : null)}
      />,
    );
    const doing = screen.getByRole("region", { name: /^Doing/ });
    const action = screen.getByRole("button", { name: "Add to Doing" });
    const top = screen.getByText("form at the top");
    const first = screen.getByText("Card a");
    expect(doing.contains(action) && doing.contains(top)).toBe(true);
    // Above the first card, not at the foot.
    expect(top.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("without them a column is as it was", () => {
    setup({ doing: [card("a")], done: [] });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Move Card a",
    ]);
  });
});

describe("Board: rows", () => {
  const laneColumns = [
    { id: "x::doing", title: "Doing" },
    { id: "x::done", title: "Done", sortable: false },
    { id: "y::doing", title: "Doing" },
    { id: "y::done", title: "Done", sortable: false },
  ] as const;
  const lanes = [
    { id: "x", label: "Lane X", header: <h3>Lane X</h3>, columnIds: ["x::doing", "x::done"] },
    {
      id: "y",
      label: "Lane Y",
      header: <h3>Lane Y</h3>,
      columnIds: ["y::doing", "y::done"],
      folded: true,
    },
  ];

  const draw = () => {
    const onMove = vi.fn();
    render(
      <Board
        columns={laneColumns}
        lanes={lanes}
        items={{
          "x::doing": [card("a")],
          "x::done": [card("d")],
          "y::doing": [card("b")],
          "y::done": [],
        }}
        getLabel={(c) => c.title}
        renderCard={(c) => <span>{c.title}</span>}
        onMove={onMove}
      />,
    );
    return { onMove, user: userEvent.setup() };
  };

  test("each row has its header and its own columns; a folded row shows only its header", () => {
    draw();
    const x = screen.getByRole("group", { name: "Lane X" });
    expect(x.querySelectorAll("section")).toHaveLength(2);
    expect(screen.getByText("Card a")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Lane Y" }).querySelectorAll("section")).toHaveLength(0);
    expect(screen.queryByText("Card b")).toBeNull();
  });

  test("arrow keys move a card between the columns of its own row only", async () => {
    const { onMove, user } = draw();
    grip("Card d").focus();
    await user.keyboard("{ArrowRight}");
    expect(onMove).not.toHaveBeenCalled();
    await user.keyboard("{ArrowLeft}");
    expect(onMove).toHaveBeenCalledWith("d", "x::doing", 0);
  });
});
