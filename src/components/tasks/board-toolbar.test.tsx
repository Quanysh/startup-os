// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultView, personKey, type TaskView } from "@/lib/tasks/view";
import { BoardToolbar } from "./board-toolbar";

afterEach(cleanup);

// Every name and address here is made up.
const PEOPLE = [
  { key: personKey("ada@example.com"), label: "Ada Example", email: "ada@example.com" },
  { key: personKey("zed@example.com"), label: "Zed", email: "zed@example.com" },
];

function Harness({
  isOwner = true,
  start,
  onView,
  onNew = () => {},
}: {
  isOwner?: boolean;
  start?: Partial<TaskView>;
  onView: (view: TaskView) => void;
  onNew?: () => void;
}) {
  const [view, setView] = useState<TaskView>({ ...defaultView({ isOwner }), ...start });
  return (
    <BoardToolbar
      view={view}
      onView={(next) => {
        onView(next);
        setView(next);
      }}
      people={PEOPLE}
      isOwner={isOwner}
      shown={2}
      total={5}
      onNew={onNew}
    />
  );
}

const setup = (props: Partial<Parameters<typeof Harness>[0]> = {}) => {
  const onView = vi.fn<(view: TaskView) => void>();
  render(<Harness onView={onView} {...props} />);
  const last = () => onView.mock.calls.at(-1)?.[0];
  return { onView, last, user: userEvent.setup() };
};

describe("BoardToolbar", () => {
  test("search is written to the view once typing pauses", async () => {
    const { last, user } = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "deck");
    await waitFor(() => expect(last()?.q).toBe("deck"));
  });

  test("Assignee: tick people, Me and Unassigned; Everyone clears the list", async () => {
    const { last, user } = setup();
    const button = screen.getByRole("button", { name: /^Assignee/ });
    expect(button.textContent).toContain("Everyone");
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("group", { name: "Show cards for" });
    const names = within(list)
      .getAllByRole("checkbox")
      .map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);
    expect(names).toEqual(["Everyone", "Me", "Unassigned", "Ada Example", "Zed"]);
    await user.click(within(list).getByRole("checkbox", { name: "Ada Example" }));
    expect(last()?.who).toEqual([PEOPLE[0]!.key]);
    await user.click(within(list).getByRole("checkbox", { name: "Unassigned" }));
    expect(last()?.who).toEqual([PEOPLE[0]!.key, "none"]);
    expect(button.textContent).toContain("2 chosen");
    await user.click(within(list).getByRole("checkbox", { name: "Everyone" }));
    expect(last()?.who).toBe("all");
    await user.keyboard("{Escape}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  test("unticking the last one is everyone again", async () => {
    const { last, user } = setup({ isOwner: false });
    const button = screen.getByRole("button", { name: /^Assignee/ });
    expect(button.textContent).toContain("Me");
    await user.click(button);
    await user.click(screen.getByRole("checkbox", { name: "Me" }));
    expect(last()?.who).toBe("all");
  });

  test("due, type, origin and sort", async () => {
    const { last, user } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Due" }), "Overdue");
    expect(last()?.due).toBe("overdue");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "Problems");
    expect(last()?.kind).toBe("issue");
    await user.selectOptions(screen.getByRole("combobox", { name: "Added from" }), "Telegram");
    expect(last()?.from).toBe("telegram");
    // "Suggest a change" cards are named for what they are, and can be shown alone.
    await user.selectOptions(screen.getByRole("combobox", { name: "Added from" }), "Feedback on Startup OS");
    expect(last()?.from).toBe("suggestion");
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "Newest");
    expect(last()?.sort).toEqual({ key: "created", dir: "desc" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "Manual");
    expect(last()?.sort).toEqual({ key: "manual", dir: "asc" });
  });

  test("a sort chosen in the list's headers is shown as it is", () => {
    setup({ start: { sort: { key: "column", dir: "desc" } } });
    const sort = screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement;
    expect(sort.selectedOptions[0]?.textContent).toBe("Column, reversed");
  });

  test("board or list, and rows per person on the board only", async () => {
    const { last, user } = setup();
    const layout = screen.getByRole("group", { name: "Layout" });
    expect(within(layout).getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    await user.selectOptions(screen.getByRole("combobox", { name: "Rows" }), "A row per person");
    expect(last()?.group).toBe("person");
    await user.click(within(layout).getByRole("button", { name: "List" }));
    expect(last()?.layout).toBe("list");
    expect(within(layout).getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("combobox", { name: "Rows" })).toBeNull();
  });

  test("says how many show, and clears the filters but not the sort or layout", async () => {
    const { last, user } = setup({
      start: { q: "x", due: "today", sort: { key: "due", dir: "asc" }, layout: "list" },
    });
    expect(screen.getByText("Showing 2 of 5")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(last()).toEqual({
      ...defaultView({ isOwner: true }),
      sort: { key: "due", dir: "asc" },
      layout: "list",
    });
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect((screen.getByRole("searchbox", { name: "Search tasks" }) as HTMLInputElement).value).toBe("");
  });

  test("New task", async () => {
    const onNew = vi.fn();
    const { user } = setup({ onNew });
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(onNew).toHaveBeenCalled();
  });

  test("Needs owner is a toggle that narrows the board and says it is on", async () => {
    const { last, user } = setup();
    const toggle = screen.getByRole("button", { name: "Needs owner" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    expect(last()?.needs).toBe(true);
    expect(screen.getByRole("button", { name: "Needs owner" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Needs owner" }));
    expect(last()?.needs).toBe(false);
  });
});
