// The task board's view: which cards are shown (search and filters), in what
// order, as a board or a list, and whether in one row per person. Worked out
// in the browser on the cards `tasks.board` already sent, and kept in the
// address (`parseView` / `serializeView`), never in component state. Shared
// by the board, the list and the rows per person.
//
// No address goes into the address bar: a person is written as a short key
// worked out from their address (`personKey`), which only someone who is
// already sent that person can turn back into a name.

import type { BoardColumn } from "@/components/board/board";
import { assigneeLabel, personLabel, unfilteredIndex } from "@/components/tasks/assignee";
import { TASK_COLUMNS } from "@/lib/task-columns";

type Assignee =
  | { status: "teammate"; email: string; name: string | null }
  | { status: "removed" | "elsewhere"; email: string | null; name: null };

/** What the view reads of a card. */
export type ViewTask = {
  title: string;
  notes: string | null;
  kind: "task" | "issue";
  column: string;
  due: string | null;
  createdAt: number;
  assignee: Assignee | null;
  origin: { source: string } | null;
  /** The standup could not tell its company (`tasks.needsCompany`). */
  needsCompany?: boolean;
};

export const DUE_FILTERS = ["any", "overdue", "today", "week", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];
export const KIND_FILTERS = ["any", "task", "issue"] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];
export const FROM_FILTERS = ["any", "manual", "standup", "telegram", "agent", "suggestion"] as const;
export type FromFilter = (typeof FROM_FILTERS)[number];
export const SORT_KEYS = ["manual", "due", "created", "assignee", "title", "column", "kind"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type Sort = { key: SortKey; dir: "asc" | "desc" };

export type TaskView = {
  /** Words to find in a card's title or description. */
  q: string;
  /** Whose cards: everyone's, or any of "me", "none" (unassigned) and people's keys. */
  who: "all" | readonly string[];
  due: DueFilter;
  kind: KindFilter;
  from: FromFilter;
  /**
   * "Needs owner": open cards with nobody on them, or whose company the
   * standup could not tell, for someone to give an owner and a company.
   */
  needs: boolean;
  sort: Sort;
  layout: "board" | "list";
  /** One row per person (board only). */
  group: "none" | "person";
  /** The rows per person that are folded away, by lane key. */
  folded: readonly string[];
};

type As = { isOwner: boolean };

export const DEFAULT_SORT: Sort = { key: "manual", dir: "asc" };
const MAX_QUERY = 200;

/** The owner looks across the team; everyone else starts on their own work. */
export function defaultView({ isOwner }: As): TaskView {
  return {
    q: "",
    who: isOwner ? "all" : ["me"],
    due: "any",
    kind: "any",
    from: "any",
    needs: false,
    sort: DEFAULT_SORT,
    layout: "board",
    group: "none",
    folded: [],
  };
}

/**
 * A short key for a person, from their address (FNV-1a, base 36). Stable,
 * whatever the capitals, and never the address itself.
 */
export function personKey(email: string): string {
  let hash = 0x811c9dc5;
  for (const char of email.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p:${hash.toString(36)}`;
}

const WHO_TOKEN = /^(me|none|p:[a-z0-9]{1,8})$/;
const LANE_TOKEN = /^(none|removed|elsewhere|p:[a-z0-9]{1,8})$/;

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

const tokens = (value: string, pattern: RegExp) =>
  [...new Set(value.split(",").filter((token) => pattern.test(token)))];

const sameList = (a: TaskView["who"], b: TaskView["who"]) =>
  a === "all" || b === "all" ? a === b : a.length === b.length && a.every((x, i) => x === b[i]);

export function parseView(params: URLSearchParams, as: As): TaskView {
  const base = defaultView(as);
  const who = params.get("who");
  const key = oneOf(SORT_KEYS, params.get("sort"), "manual");
  return {
    q: (params.get("q") ?? "").slice(0, MAX_QUERY),
    who:
      who === null
        ? base.who
        : who === "all" || tokens(who, WHO_TOKEN).length === 0
          ? "all"
          : tokens(who, WHO_TOKEN),
    due: oneOf(DUE_FILTERS, params.get("due"), "any"),
    kind: oneOf(KIND_FILTERS, params.get("kind"), "any"),
    from: oneOf(FROM_FILTERS, params.get("from"), "any"),
    needs: params.get("needs") === "owner",
    sort: key === "manual" ? DEFAULT_SORT : { key, dir: params.get("dir") === "desc" ? "desc" : "asc" },
    layout: params.get("view") === "list" ? "list" : "board",
    group: params.get("group") === "person" ? "person" : "none",
    folded: tokens(params.get("fold") ?? "", LANE_TOKEN),
  };
}

/** The view as an address query, leaving out whatever is the default. */
export function serializeView(view: TaskView, as: As): string {
  const params = new URLSearchParams();
  if (view.q !== "") params.set("q", view.q);
  if (!sameList(view.who, defaultView(as).who)) {
    params.set("who", view.who === "all" ? "all" : view.who.join(","));
  }
  if (view.due !== "any") params.set("due", view.due);
  if (view.kind !== "any") params.set("kind", view.kind);
  if (view.from !== "any") params.set("from", view.from);
  if (view.needs) params.set("needs", "owner");
  if (view.sort.key !== "manual") {
    params.set("sort", view.sort.key);
    if (view.sort.dir === "desc") params.set("dir", "desc");
  }
  if (view.layout !== "board") params.set("view", view.layout);
  if (view.group !== "none") params.set("group", view.group);
  if (view.folded.length > 0) params.set("fold", view.folded.join(","));
  return params.toString();
}

/** Whether anything holds cards back beyond the viewer's default. Sorting and layout do not. */
export function isFiltered(view: TaskView, as: As): boolean {
  return (
    view.q.trim() !== "" ||
    !sameList(view.who, defaultView(as).who) ||
    view.due !== "any" ||
    view.kind !== "any" ||
    view.from !== "any" ||
    view.needs
  );
}

/** Monday and Sunday of the week a day falls in, as "YYYY-MM-DD". */
export function weekOf(day: string): { start: string; end: string } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const at = Date.UTC(y, m - 1, d);
  const fromMonday = (new Date(at).getUTCDay() + 6) % 7;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const DAY = 86_400_000;
  return { start: iso(at - fromMonday * DAY), end: iso(at + (6 - fromMonday) * DAY) };
}

/** The keys a card answers to in "who": "none", its person's key, and "me" for the viewer's. */
function whoKeys(task: ViewTask, me: string | null): string[] {
  const a = task.assignee;
  if (a === null) return ["none"];
  if (a.status !== "teammate") return [a.status];
  const email = a.email.toLowerCase();
  return me !== null && email === me.toLowerCase() ? ["me", personKey(email)] : [personKey(email)];
}

type Context = { me: string | null; today: string | null };

export function filterTasks<T extends ViewTask>(tasks: readonly T[], view: TaskView, ctx: Context): T[] {
  const words = view.q.trim().toLowerCase();
  const who = view.who === "all" ? null : new Set(view.who);
  const week = ctx.today === null ? null : weekOf(ctx.today);
  const dueOk = (task: T) => {
    switch (view.due) {
      case "any":
        return true;
      case "none":
        return task.due === null;
      default:
        // Before the clock is known nothing is held back on a date.
        if (ctx.today === null || week === null) return true;
        if (task.due === null) return false;
        if (view.due === "overdue") return task.due < ctx.today && task.column !== "done";
        if (view.due === "today") return task.due === ctx.today;
        return task.due >= week.start && task.due <= week.end;
    }
  };
  return tasks.filter(
    (task) =>
      (words === "" ||
        task.title.toLowerCase().includes(words) ||
        (task.notes ?? "").toLowerCase().includes(words)) &&
      (who === null || whoKeys(task, ctx.me).some((key) => who.has(key))) &&
      dueOk(task) &&
      (view.kind === "any" || task.kind === view.kind) &&
      (view.from === "any" ||
        (view.from === "manual" ? task.origin == null : task.origin?.source === view.from)) &&
      (!view.needs || (task.column !== "done" && (task.assignee === null || task.needsCompany === true))),
  );
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
const columnRank = (column: string) => TASK_COLUMNS.findIndex((c) => c.id === column);

/** How each key compares two cards; null values sort last whichever way. */
const VALUE: Record<Exclude<SortKey, "manual">, (task: ViewTask) => string | number | null> = {
  due: (task) => task.due,
  created: (task) => task.createdAt,
  assignee: (task) => assigneeLabel(task.assignee),
  title: (task) => task.title,
  column: (task) => columnRank(task.column),
  kind: (task) => (task.kind === "issue" ? 0 : 1),
};

/** The cards in order. Manual is the order given; ties keep it too. */
export function sortTasks<T extends ViewTask>(tasks: readonly T[], sort: Sort): T[] {
  if (sort.key === "manual") return [...tasks];
  const value = VALUE[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return tasks
    .map((task, index) => ({ task, index, value: value(task) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      }
      const compared =
        typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : byText(String(a.value), String(b.value));
      return sign * compared || a.index - b.index;
    })
    .map(({ task }) => task);
}

/** What a click on a column's header asks for: ascending first, then the other way. */
export function nextSort(current: Sort, key: SortKey): Sort {
  return current.key === key && current.dir === "asc" ? { key, dir: "desc" } : { key, dir: "asc" };
}

/** A header's `aria-sort`. */
export function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** A sort's name in a sentence: "due date", "newest". */
export function sortName(sort: Sort): string {
  switch (sort.key) {
    case "manual":
      return "hand";
    case "due":
      return "due date";
    case "created":
      return sort.dir === "desc" ? "newest" : "oldest";
    case "kind":
      return "type";
    default:
      return sort.key;
  }
}

/**
 * The board's columns under a sort. By hand, as they are. Under any other
 * sort the order on screen is the sort's, so no column can be arranged by
 * hand (a drop within one does nothing) and the header says so; cards still
 * move between columns.
 */
export function boardColumns<C extends BoardColumn>(columns: readonly C[], sort: Sort): C[] {
  if (sort.key === "manual") return [...columns];
  const hint = `Sorted by ${sortName(sort)}: drag between columns to move`;
  return columns.map((column) => ({ ...column, sortable: false, hint }));
}

/**
 * Where a drop lands among every card the server sent for the column, which
 * is what `tasks.move` counts. By hand, just above the card on screen at that
 * place (`unfilteredIndex`). Under another sort the order on screen says
 * nothing about the stored one, so a card entering a column goes to its top
 * and every other card keeps its place: back on Manual, the order is as it was.
 */
export function dropIndex(
  sort: Sort,
  all: readonly string[],
  shown: readonly string[],
  id: string,
  index: number,
): number {
  return sort.key === "manual" ? unfilteredIndex(all, shown, id, index) : 0;
}

export type PersonOption = { key: string; label: string; email: string };

/**
 * The people the Assignee filter offers besides Me and Unassigned: those
 * named on the cards the viewer is sent, and those a card of the company in
 * view can be given to (`team.assignable`). Never anyone else: both lists are
 * already only people the viewer may be told about.
 */
export function assigneeOptions(
  tasks: readonly ViewTask[],
  people: readonly { email: string; name: string | null }[] | undefined,
  me: string | null,
): PersonOption[] {
  const found = new Map<string, PersonOption>();
  const add = (person: { email: string; name: string | null }) => {
    const email = person.email.toLowerCase();
    if (email === me?.toLowerCase() || found.has(email)) return;
    found.set(email, { key: personKey(email), label: personLabel(person), email });
  };
  for (const person of people ?? []) add(person);
  for (const task of tasks) if (task.assignee?.status === "teammate") add(task.assignee);
  return [...found.values()].sort((a, b) => byText(a.label, b.label));
}

export type Lane<T> = {
  /** "none", "removed", "elsewhere" or a person's key. */
  key: string;
  label: string;
  /** Whom a card dropped here is given to (null: nobody, or nobody that can be named). */
  email: string | null;
  /** Whether a card can be dropped here: a person, or Unassigned. */
  accepts: boolean;
  tasks: T[];
};

const LAST = ["elsewhere", "removed", "none"];

/** One lane per person: the viewer first, then by name, the unnamed, and Unassigned last. */
export function groupByPerson<T extends ViewTask>(tasks: readonly T[], me: string | null): Lane<T>[] {
  const lanes = new Map<string, Lane<T>>();
  for (const task of tasks) {
    const a = task.assignee;
    const key = a === null ? "none" : a.status === "teammate" ? personKey(a.email) : a.status;
    let lane = lanes.get(key);
    if (lane === undefined) {
      const mine = a?.status === "teammate" && a.email.toLowerCase() === me?.toLowerCase();
      lane = {
        key,
        label:
          a === null ? "Unassigned" : `${assigneeLabel(a)!}${mine ? " (you)" : ""}`,
        email: a?.status === "teammate" ? a.email.toLowerCase() : null,
        accepts: a === null || a.status === "teammate",
        tasks: [],
      };
      lanes.set(key, lane);
    }
    lane.tasks.push(task);
  }
  const mineKey = me === null ? null : personKey(me);
  const rank = (lane: Lane<T>) =>
    lane.key === mineKey ? -1 : LAST.includes(lane.key) ? LAST.indexOf(lane.key) + 1 : 0;
  return [...lanes.values()].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 0 ? byText(a.label, b.label) : 0),
  );
}
