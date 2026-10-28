import { describe, expect, test } from "vitest";
import {
  assigneeLabel,
  initialsOf,
  isStranded,
  KEPT,
  personLabel,
  selectionOf,
  unfilteredIndex,
  visibleTasks,
} from "./assignee";

// Every name and address here is made up.
const teammate = (email: string, name: string | null = null) =>
  ({ status: "teammate", email, name }) as const;

describe("assigneeLabel", () => {
  test("a teammate is their name, or the part of the address before the @", () => {
    expect(assigneeLabel(teammate("ada@example.com", "Ada Example"))).toBe("Ada Example");
    expect(assigneeLabel(teammate("sam.field@example.com"))).toBe("sam.field");
  });

  test("someone removed, someone on the other company, and nobody", () => {
    expect(assigneeLabel({ status: "removed", email: null, name: null })).toBe("Removed teammate");
    expect(assigneeLabel({ status: "removed", email: "gone@example.com", name: null })).toBe(
      "Removed teammate",
    );
    expect(assigneeLabel({ status: "elsewhere", email: null, name: null })).toBe(
      "Someone on the other company",
    );
    expect(assigneeLabel(null)).toBeNull();
  });
});

test("personLabel is the name, or the local part of the address", () => {
  expect(personLabel({ email: "ada@example.com", name: "Ada Example" })).toBe("Ada Example");
  expect(personLabel({ email: "sam@example.com", name: null })).toBe("sam");
});

test("initials come from the first and last word, or the first two letters of one", () => {
  expect(initialsOf("Ada Example")).toBe("AE");
  expect(initialsOf("Ada Maria Example")).toBe("AE");
  expect(initialsOf("sam.field")).toBe("SF");
  expect(initialsOf("sam")).toBe("SA");
});

describe("selectionOf", () => {
  test("a teammate is selected by address; nobody is null", () => {
    expect(selectionOf(teammate("ada@example.com", "Ada Example"))).toEqual({
      value: "ada@example.com",
      label: "Ada Example",
    });
    expect(selectionOf(null)).toBeNull();
  });

  test("someone who cannot be named is kept as they are, never by address", () => {
    expect(selectionOf({ status: "removed", email: "gone@example.com", name: null })).toEqual({
      value: KEPT,
      label: "Removed teammate",
    });
    expect(selectionOf({ status: "elsewhere", email: null, name: null })).toEqual({
      value: KEPT,
      label: "Someone on the other company",
    });
  });
});

describe("isStranded", () => {
  const people = [{ email: "ada@example.com", name: "Ada Example" }];
  const ada = { value: "ada@example.com", label: "Ada Example" };
  const sam = { value: "sam@example.com", label: "sam" };

  test("a person missing from the company's list is stranded", () => {
    expect(isStranded(sam, people)).toBe(true);
    expect(isStranded(ada, people)).toBe(false);
  });

  test("nobody, a kept assignee, a bot id, and a list still loading are not", () => {
    expect(isStranded(null, people)).toBe(false);
    expect(isStranded({ value: KEPT, label: "Removed teammate" }, people)).toBe(false);
    expect(isStranded({ value: "growth", label: "Growth Bot" }, people)).toBe(false);
    expect(isStranded(sam, undefined)).toBe(false);
  });
});

describe("visibleTasks", () => {
  const task = (id: string, company: "us" | "kz" | null, email: string | null) => ({
    id,
    company,
    assignee: email === null ? null : teammate(email),
  });
  const board = {
    backlog: [
      task("a", null, "ada@example.com"),
      task("b", "us", null),
      task("c", "kz", "ada@example.com"),
      task("d", "us", "sam@example.com"),
    ],
    done: [task("e", "kz", null)],
  };
  const ids = (shown: Record<string, { id: string }[]>) =>
    Object.fromEntries(Object.entries(shown).map(([column, tasks]) => [column, tasks.map((t) => t.id)]));

  test("everything, with no company in view and everyone's tasks", () => {
    expect(ids(visibleTasks(board, { company: null, filter: "everyone", email: null }))).toEqual({
      backlog: ["a", "b", "c", "d"],
      done: ["e"],
    });
  });

  test("a company in view keeps its tasks and the shared ones", () => {
    expect(ids(visibleTasks(board, { company: "us", filter: "everyone", email: null }))).toEqual({
      backlog: ["a", "b", "d"],
      done: [],
    });
  });

  test("Mine keeps the tasks assigned to the viewer's address, whatever its case", () => {
    expect(
      ids(visibleTasks(board, { company: null, filter: "mine", email: "Ada@Example.com" })),
    ).toEqual({ backlog: ["a", "c"], done: [] });
    expect(
      ids(visibleTasks(board, { company: "us", filter: "mine", email: "ada@example.com" })),
    ).toEqual({ backlog: ["a"], done: [] });
  });

  test("Mine is empty for a viewer with no address, and never matches a hidden one", () => {
    const hidden = { backlog: [{ id: "x", company: null, assignee: { status: "elsewhere", email: null, name: null } as const }] };
    expect(ids(visibleTasks(hidden, { company: null, filter: "mine", email: null }))).toEqual({
      backlog: [],
    });
  });
});

describe("unfilteredIndex", () => {
  // The server counts the cards the caller sees, leaving the moved one out.
  const all = ["x", "a", "y", "c", "z"];
  const shown = ["a", "c"];

  test("a card dropped above a shown card lands just above it among all the cards", () => {
    expect(unfilteredIndex(all, shown, "c", 0)).toBe(1);
    expect(unfilteredIndex(all, shown, "a", 0)).toBe(2);
  });

  test("a card dropped after the last shown card lands just after it", () => {
    expect(unfilteredIndex(all, shown, "a", 1)).toBe(3);
    expect(unfilteredIndex(all, shown, "a", 9)).toBe(3);
  });

  test("a card arriving from another column is placed among the shown cards the same way", () => {
    expect(unfilteredIndex(all, shown, "new", 1)).toBe(3);
    expect(unfilteredIndex(all, shown, "new", 2)).toBe(4);
  });

  test("with nothing shown in the column, the card goes to its end", () => {
    expect(unfilteredIndex(all, [], "new", 0)).toBe(5);
    expect(unfilteredIndex([], [], "new", 0)).toBe(0);
  });

  test("with nothing filtered out, the index is unchanged", () => {
    expect(unfilteredIndex(all, all, "y", 0)).toBe(0);
    expect(unfilteredIndex(all, all, "x", 4)).toBe(4);
  });
});
