import { describe, expect, test } from "vitest";
import type { BoardColumn } from "@/components/board/board";
import {
  DEFAULT_SORT,
  assigneeOptions,
  ariaSort,
  boardColumns,
  defaultView,
  dropIndex,
  filterTasks,
  groupByPerson,
  isFiltered,
  nextSort,
  parseView,
  personKey,
  serializeView,
  sortTasks,
  weekOf,
  type TaskView,
  type ViewTask,
} from "./view";

// Every name, address and title here is made up.
const ME = "sam@example.com";
const ADA = "ada@example.com";
const ZED = "zed@example.com";
const TODAY = "2026-10-14"; // a Wednesday

let made = 0;
const task = (over: Partial<ViewTask> & { id?: string } = {}): ViewTask & { id: string } => ({
  id: over.id ?? `t${++made}`,
  title: "A card",
  notes: null,
  kind: "task",
  column: "backlog",
  due: null,
  createdAt: 1000 + made,
  assignee: null,
  origin: null,
  ...over,
});
const to = (email: string, name: string | null = null) =>
  ({ status: "teammate", email, name }) as const;
const ids = (tasks: readonly { id: string }[]) => tasks.map((t) => t.id);

const OWNER = { isOwner: true };
const TEAMMATE = { isOwner: false };
const ctx = { me: ME, today: TODAY };

describe("the address", () => {
  test("an empty address is the default view: the owner sees everyone, a teammate their own", () => {
    expect(parseView(new URLSearchParams(""), OWNER)).toEqual(defaultView(OWNER));
    expect(defaultView(OWNER).who).toBe("all");
    expect(defaultView(TEAMMATE).who).toEqual(["me"]);
    expect(defaultView(OWNER)).toMatchObject({
      q: "",
      due: "any",
      kind: "any",
      from: "any",
      sort: DEFAULT_SORT,
      layout: "board",
      group: "none",
      folded: [],
    });
  });

  test("the default view writes nothing", () => {
    expect(serializeView(defaultView(OWNER), OWNER)).toBe("");
    expect(serializeView(defaultView(TEAMMATE), TEAMMATE)).toBe("");
  });

  test("every field goes out and comes back", () => {
    const view: TaskView = {
      q: "invoice q3",
      who: ["me", "none", personKey(ADA)],
      due: "week",
      kind: "issue",
      from: "telegram",
      needs: true,
      sort: { key: "due", dir: "desc" },
      layout: "list",
      group: "person",
      folded: ["none", personKey(ADA)],
    };
    for (const as of [OWNER, TEAMMATE]) {
      const query = serializeView(view, as);
      expect(parseView(new URLSearchParams(query), as)).toEqual(view);
    }
  });

  test("a teammate looking at everyone says so, since their default is their own", () => {
    const view = { ...defaultView(TEAMMATE), who: "all" as const };
    const query = serializeView(view, TEAMMATE);
    expect(query).toBe("who=all");
    expect(parseView(new URLSearchParams(query), TEAMMATE).who).toBe("all");
  });

  test("the owner looking at their own says so", () => {
    const view = { ...defaultView(OWNER), who: ["me"] };
    expect(parseView(new URLSearchParams(serializeView(view, OWNER)), OWNER).who).toEqual(["me"]);
  });

  test("no address is written into the address, only a key", () => {
    const query = serializeView({ ...defaultView(OWNER), who: [personKey(ADA)] }, OWNER);
    expect(query).not.toContain("ada");
    expect(query).not.toContain("example");
    expect(personKey(ADA)).toBe(personKey(" Ada@Example.com "));
    expect(personKey(ADA)).not.toBe(personKey(ZED));
  });

  test("anything it does not know reads as the default", () => {
    const view = parseView(
      new URLSearchParams(
        "who=me,<script>,p:%%,none&due=soon&kind=bug&from=fax&sort=colour&dir=up&view=grid&group=team&fold=x,none",
      ),
      OWNER,
    );
    expect(view).toEqual({ ...defaultView(OWNER), who: ["me", "none"], folded: ["none"] });
  });

  test("a sort with no direction is ascending, and a search is cut to a sane length", () => {
    const view = parseView(new URLSearchParams(`sort=title&q=${"x".repeat(500)}`), OWNER);
    expect(view.sort).toEqual({ key: "title", dir: "asc" });
    expect(view.q.length).toBe(200);
  });

  test("an empty who list is everyone", () => {
    expect(parseView(new URLSearchParams("who="), TEAMMATE).who).toBe("all");
  });
});

describe("filterTasks", () => {
  test("search matches the title and the description, whatever the capitals", () => {
    const a = task({ title: "Send the Invoice" });
    const b = task({ title: "Call", notes: "about the invoice" });
    const c = task({ title: "Other" });
    const view = { ...defaultView(OWNER), q: "  INVOICE " };
    expect(ids(filterTasks([a, b, c], view, ctx))).toEqual([a.id, b.id]);
  });

  test("who: me, unassigned and named people, in any mix", () => {
    const mine = task({ assignee: to(ME.toUpperCase()) });
    const ada = task({ assignee: to(ADA) });
    const nobody = task();
    const zed = task({ assignee: to(ZED) });
    const all = [mine, ada, nobody, zed];
    const by = (who: TaskView["who"]) => ids(filterTasks(all, { ...defaultView(OWNER), who }, ctx));
    expect(by("all")).toEqual(ids(all));
    expect(by(["me"])).toEqual([mine.id]);
    expect(by(["none"])).toEqual([nobody.id]);
    expect(by([personKey(ADA), "none"])).toEqual([ada.id, nobody.id]);
    // "Me" is the viewer, chosen by name or as "me".
    expect(by([personKey(ME)])).toEqual([mine.id]);
  });

  test("with no viewer address, Me matches nothing", () => {
    const mine = task({ assignee: to(ME) });
    const view = { ...defaultView(TEAMMATE) };
    expect(filterTasks([mine], view, { me: null, today: TODAY })).toEqual([]);
  });

  test("due: overdue, today, this week, no date", () => {
    const late = task({ due: "2026-10-10" });
    const lateButDone = task({ due: "2026-10-10", column: "done" });
    const today = task({ due: TODAY });
    const sunday = task({ due: "2026-10-18" });
    const monday = task({ due: "2026-10-12" });
    const nextWeek = task({ due: "2026-10-19" });
    const none = task();
    const all = [late, lateButDone, today, sunday, monday, nextWeek, none];
    const by = (due: TaskView["due"]) => ids(filterTasks(all, { ...defaultView(OWNER), due }, ctx));
    expect(by("any")).toEqual(ids(all));
    expect(by("overdue")).toEqual([late.id, monday.id]);
    expect(by("today")).toEqual([today.id]);
    expect(by("week")).toEqual([today.id, sunday.id, monday.id]);
    expect(by("none")).toEqual([none.id]);
  });

  test("before the clock is known, a date filter holds nothing back", () => {
    const late = task({ due: "2026-10-10" });
    const view = { ...defaultView(OWNER), due: "overdue" as const };
    expect(ids(filterTasks([late], view, { me: ME, today: null }))).toEqual([late.id]);
  });

  test("type and where it came from", () => {
    const issue = task({ kind: "issue" });
    const typed = task();
    const standup = task({ origin: { source: "standup" } });
    const telegram = task({ origin: { source: "telegram" } });
    const agent = task({ origin: { source: "agent" } });
    const suggestion = task({ origin: { source: "suggestion" } });
    const all = [issue, typed, standup, telegram, agent, suggestion];
    const base = defaultView(OWNER);
    expect(ids(filterTasks(all, { ...base, kind: "issue" }, ctx))).toEqual([issue.id]);
    expect(ids(filterTasks(all, { ...base, kind: "task" }, ctx))).not.toContain(issue.id);
    expect(ids(filterTasks(all, { ...base, from: "manual" }, ctx))).toEqual([issue.id, typed.id]);
    for (const [from, one] of [
      ["standup", standup],
      ["telegram", telegram],
      ["agent", agent],
      ["suggestion", suggestion],
    ] as const) {
      expect(ids(filterTasks(all, { ...base, from }, ctx))).toEqual([one.id]);
    }
  });

  test("filters keep the order they were given", () => {
    const a = task({ assignee: to(ME) });
    const b = task({ assignee: to(ME) });
    expect(ids(filterTasks([b, a], defaultView(TEAMMATE), ctx))).toEqual([b.id, a.id]);
  });

  test("isFiltered says whether anything but the default holds cards back", () => {
    expect(isFiltered(defaultView(OWNER), OWNER)).toBe(false);
    expect(isFiltered(defaultView(TEAMMATE), TEAMMATE)).toBe(false);
    expect(isFiltered({ ...defaultView(OWNER), q: "x" }, OWNER)).toBe(true);
    expect(isFiltered({ ...defaultView(OWNER), sort: { key: "due", dir: "asc" } }, OWNER)).toBe(false);
    expect(isFiltered({ ...defaultView(TEAMMATE), who: "all" }, TEAMMATE)).toBe(true);
  });
});

describe("weekOf", () => {
  test("Monday to Sunday around a day", () => {
    expect(weekOf("2026-10-14")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekOf("2026-10-12")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekOf("2026-10-18")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekOf("2026-12-31")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

describe("sortTasks", () => {
  const a = task({ id: "a", title: "banana", due: "2026-10-20", createdAt: 3, assignee: to(ZED, "Zed") });
  const b = task({ id: "b", title: "Apple", due: null, createdAt: 1, column: "doing" });
  const c = task({ id: "c", title: "cherry", due: "2026-10-01", createdAt: 2, assignee: to(ADA, "Ada"), kind: "issue" });
  const all = [a, b, c];
  const sort = (key: TaskView["sort"]["key"], dir: "asc" | "desc" = "asc") =>
    ids(sortTasks(all, { key, dir }));

  test("manual keeps the order it was given", () => {
    expect(sort("manual")).toEqual(["a", "b", "c"]);
    expect(sort("manual", "desc")).toEqual(["a", "b", "c"]);
  });
  test("due: soonest first, no date last whichever way", () => {
    expect(sort("due")).toEqual(["c", "a", "b"]);
    expect(sort("due", "desc")).toEqual(["a", "c", "b"]);
  });
  test("created: oldest first, or newest", () => {
    expect(sort("created")).toEqual(["b", "c", "a"]);
    expect(sort("created", "desc")).toEqual(["a", "c", "b"]);
  });
  test("assignee by name, unassigned last whichever way", () => {
    expect(sort("assignee")).toEqual(["c", "a", "b"]);
    expect(sort("assignee", "desc")).toEqual(["a", "c", "b"]);
  });
  test("title, whatever the capitals", () => {
    expect(sort("title")).toEqual(["b", "a", "c"]);
    expect(sort("title", "desc")).toEqual(["c", "a", "b"]);
  });
  test("column in board order, and type", () => {
    expect(sort("column")).toEqual(["a", "c", "b"]);
    expect(sort("kind")).toEqual(["c", "a", "b"]);
  });
  test("ties keep the order they were given", () => {
    const x = task({ id: "x", title: "same" });
    const y = task({ id: "y", title: "same" });
    expect(ids(sortTasks([y, x], { key: "title", dir: "asc" }))).toEqual(["y", "x"]);
    expect(ids(sortTasks([y, x], { key: "title", dir: "desc" }))).toEqual(["y", "x"]);
  });
  test("a header click asks ascending first, then the other way; aria-sort says which", () => {
    expect(nextSort(DEFAULT_SORT, "due")).toEqual({ key: "due", dir: "asc" });
    expect(nextSort({ key: "due", dir: "asc" }, "due")).toEqual({ key: "due", dir: "desc" });
    expect(nextSort({ key: "due", dir: "desc" }, "due")).toEqual({ key: "due", dir: "asc" });
    expect(ariaSort({ key: "due", dir: "asc" }, "due")).toBe("ascending");
    expect(ariaSort({ key: "due", dir: "desc" }, "due")).toBe("descending");
    expect(ariaSort({ key: "due", dir: "desc" }, "title")).toBe("none");
  });
});

describe("dragging under a sort", () => {
  const COLUMNS: BoardColumn[] = [
    { id: "backlog", title: "Backlog", hint: "Not scheduled yet" },
    { id: "done", title: "Done", hint: "Finished", sortable: false },
  ];

  test("by hand, columns are as they are", () => {
    expect(boardColumns(COLUMNS, DEFAULT_SORT)).toEqual(COLUMNS);
  });

  test("under another sort no column can be arranged, and the header says why", () => {
    const columns = boardColumns(COLUMNS, { key: "due", dir: "asc" });
    expect(columns.map((c) => c.sortable)).toEqual([false, false]);
    expect(columns[0]!.hint).toBe("Sorted by due date: drag between columns to move");
    expect(boardColumns(COLUMNS, { key: "created", dir: "desc" })[0]!.hint).toBe(
      "Sorted by newest: drag between columns to move",
    );
  });

  test("by hand, a drop among the cards on screen is placed among all of them", () => {
    // All: x a y c; on screen: a c. Dropped at 1 (above c): just above c.
    expect(dropIndex(DEFAULT_SORT, ["x", "a", "y", "c"], ["a", "c"], "n", 1)).toBe(3);
  });

  test("under another sort a card entering a column goes to the top of its stored order", () => {
    // The order on screen is the sort's, not the stored one: it says nothing
    // about where the card belongs by hand, so the stored order is not reshuffled.
    expect(dropIndex({ key: "due", dir: "asc" }, ["x", "a", "y", "c"], ["c", "a"], "n", 1)).toBe(0);
  });
});

describe("assigneeOptions", () => {
  test("the people on the cards and those a card can be given to, once each, by name, without the viewer", () => {
    const tasks = [
      task({ assignee: to(ZED, "Zed") }),
      task({ assignee: to(ME, "Sam") }),
      task({ assignee: { status: "elsewhere", email: null, name: null } }),
      task({ assignee: { status: "removed", email: "gone@example.com", name: null } }),
    ];
    const people = [
      { email: ADA, name: "Ada" },
      { email: ZED, name: "Zed" },
      { email: ME, name: "Sam" },
    ];
    expect(assigneeOptions(tasks, people, ME)).toEqual([
      { key: personKey(ADA), label: "Ada", email: ADA },
      { key: personKey(ZED), label: "Zed", email: ZED },
    ]);
  });

  test("while the list of people loads, the cards' people are enough", () => {
    expect(assigneeOptions([task({ assignee: to(ADA) })], undefined, ME)).toEqual([
      { key: personKey(ADA), label: "ada", email: ADA },
    ]);
  });
});

describe("groupByPerson", () => {
  test("one lane per person: the viewer first, then by name, the unnamed, and Unassigned last", () => {
    const mine = task({ assignee: to(ME, "Sam") });
    const zed = task({ assignee: to(ZED, "Zed") });
    const ada = task({ assignee: to(ADA, "Ada") });
    const ada2 = task({ assignee: to(ADA, "Ada") });
    const nobody = task();
    const gone = task({ assignee: { status: "removed", email: null, name: null } });
    const away = task({ assignee: { status: "elsewhere", email: null, name: null } });
    const lanes = groupByPerson([nobody, zed, ada, gone, mine, away, ada2], ME);
    expect(lanes.map((lane) => [lane.key, lane.label, lane.email, ids(lane.tasks)])).toEqual([
      [personKey(ME), "Sam (you)", ME, [mine.id]],
      [personKey(ADA), "Ada", ADA, [ada.id, ada2.id]],
      [personKey(ZED), "Zed", ZED, [zed.id]],
      ["elsewhere", "Someone on the other company", null, [away.id]],
      ["removed", "Removed teammate", null, [gone.id]],
      ["none", "Unassigned", null, [nobody.id]],
    ]);
  });

  test("a lane can take a card only when it is a person or nobody", () => {
    const lanes = groupByPerson(
      [task({ assignee: to(ADA) }), task(), task({ assignee: { status: "removed", email: null, name: null } })],
      ME,
    );
    expect(lanes.map((lane) => lane.accepts)).toEqual([true, false, true]);
  });
});

describe("Needs owner", () => {
  test("lists the open cards with nobody on them or a company the standup could not tell", () => {
    const tasks = [
      task({ id: "nobody" }),
      task({ id: "flagged", assignee: to(ADA), needsCompany: true }),
      task({ id: "owned", assignee: to(ADA) }),
      task({ id: "done-nobody", column: "done" }),
    ];
    const view = { ...defaultView(OWNER), needs: true };
    expect(ids(filterTasks(tasks, view, ctx))).toEqual(["nobody", "flagged"]);
    expect(ids(filterTasks(tasks, defaultView(OWNER), ctx))).toEqual(["nobody", "flagged", "owned", "done-nobody"]);
  });

  test("is kept in the address and counts as a filter", () => {
    const view: TaskView = { ...defaultView(OWNER), needs: true };
    expect(serializeView(view, OWNER)).toBe("needs=owner");
    expect(parseView(new URLSearchParams("needs=owner"), OWNER)).toEqual(view);
    expect(parseView(new URLSearchParams("needs=SECRET"), OWNER).needs).toBe(false);
    expect(isFiltered(view, OWNER)).toBe(true);
    expect(defaultView(TEAMMATE).needs).toBe(false);
  });
});
