// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Sort } from "@/lib/tasks/view";
import type { Task } from "./task-card";
import { TaskList } from "./task-list";

afterEach(cleanup);

// Every name, address and title here is made up.
const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    title: `Card ${id}`,
    notes: null,
    kind: "task",
    column: "backlog",
    due: null,
    goalId: null,
    goalTitle: null,
    doneAt: null,
    createdAt: Date.UTC(2026, 9, 1, 12),
    company: null,
    assignee: null,
    mentions: [],
    origin: null,
    ...over,
  }) as Task;

const draw = ({
  tasks = [
    task("a", { due: "2026-10-01", assignee: { status: "teammate", email: "ada@example.com", name: "Ada" } }),
    task("b", { column: "doing", kind: "issue", origin: { source: "telegram", by: null } }),
  ],
  sort = { key: "manual", dir: "asc" } as Sort,
  selected = [] as string[],
  showCompany = false,
} = {}) => {
  const onSort = vi.fn();
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  render(
    <TaskList
      tasks={tasks}
      sort={sort}
      onSort={onSort}
      today="2026-10-14"
      onOpen={onOpen}
      isSelected={(id) => selected.includes(id)}
      onToggle={onToggle}
      showCompany={showCompany}
    />,
  );
  return { onSort, onOpen, onToggle, user: userEvent.setup() };
};

const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });

describe("TaskList", () => {
  test("one row per card, with its fields", () => {
    draw();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByRole("button", { name: "Card a" })).toBeTruthy();
    expect(first.getByText("Ada")).toBeTruthy();
    expect(first.getByText("Backlog")).toBeTruthy();
    expect(first.getByText(/Overdue/)).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.getByText("Doing")).toBeTruthy();
    expect(second.getByText("Problem")).toBeTruthy();
    expect(second.getByText("Telegram")).toBeTruthy();
    expect(second.getByText("Unassigned")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Company" })).toBeNull();
  });

  test("the company column shows for a viewer on both with none in view", () => {
    draw({ showCompany: true, tasks: [task("a", { company: "kz" }), task("b")] });
    expect(screen.getByRole("columnheader", { name: "Company" })).toBeTruthy();
    expect(screen.getByText("Globex")).toBeTruthy();
    expect(screen.getByText("Both")).toBeTruthy();
  });

  test("a header is a button that sorts, and says how with aria-sort", async () => {
    const { onSort, user } = draw({ sort: { key: "due", dir: "asc" } });
    expect(header("Due").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Title").getAttribute("aria-sort")).toBe("none");
    await user.click(within(header("Due")).getByRole("button"));
    expect(onSort).toHaveBeenLastCalledWith({ key: "due", dir: "desc" });
    await user.click(within(header("Title")).getByRole("button"));
    expect(onSort).toHaveBeenLastCalledWith({ key: "title", dir: "asc" });
  });

  test("the title opens the card; the checkbox selects it", async () => {
    const { onOpen, onToggle, user } = draw({ selected: ["b"] });
    await user.click(screen.getByRole("button", { name: "Card a" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    const boxA = screen.getByRole("checkbox", { name: "Select Card a" }) as HTMLInputElement;
    expect(boxA.checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Select Card b" }) as HTMLInputElement).checked).toBe(true);
    await user.click(boxA);
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  test("an empty list says so", () => {
    draw({ tasks: [] });
    expect(screen.getByText("No cards match.")).toBeTruthy();
  });
});
