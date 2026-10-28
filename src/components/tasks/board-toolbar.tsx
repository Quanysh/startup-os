"use client";

import {
  ArrowUpDownIcon,
  CalendarIcon,
  ChevronDownIcon,
  InboxIcon,
  KanbanSquareIcon,
  ListIcon,
  PlusIcon,
  Rows3Icon,
  SearchIcon,
  ShapesIcon,
  UserIcon,
  UserRoundSearchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PRODUCT } from "@convex/lib/identity";
import {
  defaultView,
  isFiltered,
  sortName,
  type DueFilter,
  type FromFilter,
  type KindFilter,
  type PersonOption,
  type Sort,
  type TaskView,
} from "@/lib/tasks/view";
import { cn } from "@/lib/utils";

// The task board's toolbar: one calm row that wraps on a narrow screen. Every
// control writes the view (which the page keeps in the address); nothing here
// holds state of its own but the search box while it is being typed in.

/**
 * A filter or layout chip: a quiet tint at rest, the brand's when it holds
 * something other than its default, so what is narrowing the board shows.
 */
const chip = (active: boolean) =>
  cn(
    "h-8 shrink-0 rounded-full text-xs outline-none transition focus-within:ring-3 focus-within:ring-ring/50",
    active
      ? "bg-brand/12 font-medium text-brand ring-1 ring-brand/25"
      : "bg-surface text-ink-2 hover:bg-surface/70 hover:text-ink",
  );

const SEARCH_PAUSE_MS = 250;

const DUE_LABELS: Record<DueFilter, string> = {
  any: "Any due date",
  overdue: "Overdue",
  today: "Due today",
  week: "Due this week",
  none: "No due date",
};
const KIND_LABELS: Record<KindFilter, string> = { any: "Any type", task: "Tasks", issue: "Problems" };
const FROM_LABELS: Record<FromFilter, string> = {
  any: "Added anywhere",
  manual: "Added by hand",
  standup: "Standup",
  telegram: "Telegram",
  agent: "Claude",
  suggestion: `Feedback on ${PRODUCT.name}`,
};
/** The sorts the toolbar offers; a list header can ask for others. */
const SORTS: { value: string; label: string; sort: Sort }[] = [
  { value: "manual", label: "Manual", sort: { key: "manual", dir: "asc" } },
  { value: "due", label: "Due date", sort: { key: "due", dir: "asc" } },
  { value: "created-desc", label: "Newest", sort: { key: "created", dir: "desc" } },
  { value: "created-asc", label: "Oldest", sort: { key: "created", dir: "asc" } },
  { value: "assignee", label: "Assignee", sort: { key: "assignee", dir: "asc" } },
  { value: "title", label: "Title", sort: { key: "title", dir: "asc" } },
];
const OTHER_SORT = "other";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function BoardToolbar({
  view,
  onView,
  people,
  isOwner,
  shown,
  total,
  onNew,
}: {
  view: TaskView;
  onView: (next: TaskView) => void;
  /** Besides Me and Unassigned: the people the viewer may filter by. */
  people: readonly PersonOption[];
  isOwner: boolean;
  shown: number;
  total: number;
  onNew: () => void;
}) {
  const set = (change: Partial<TaskView>) => onView({ ...view, ...change });
  const filtered = isFiltered(view, { isOwner });
  const sortValue =
    SORTS.find((s) => s.sort.key === view.sort.key && s.sort.dir === view.sort.dir)?.value ??
    OTHER_SORT;

  return (
    <div className="space-y-3">
      {/* What to look at and how: search, then the layout and the one action. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={view.q} onChange={(q) => set({ q })} />
        <div className="ml-auto flex items-center gap-2">
          <div
            role="group"
            aria-label="Layout"
            className="inline-flex h-9 shrink-0 gap-0.5 rounded-full bg-surface p-1"
          >
            {(
              [
                ["board", "Board", KanbanSquareIcon],
                ["list", "List", ListIcon],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view.layout === id}
                onClick={() => set({ layout: id })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
                  view.layout === id && "bg-panel text-ink shadow-soft-sm",
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onNew}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-brand-fill px-4 text-xs font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <PlusIcon aria-hidden className="size-3.5" />
            New task
          </button>
        </div>
      </div>

      {/* What narrows the board, then how it is laid out, then the count. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <AssigneeFilter who={view.who} people={people} onChange={(who) => set({ who })} />
        <Select
          label="Due"
          icon={CalendarIcon}
          value={view.due}
          active={view.due !== "any"}
          options={DUE_LABELS}
          onChange={(due) => set({ due })}
        />
        <Select
          label="Type"
          icon={ShapesIcon}
          value={view.kind}
          active={view.kind !== "any"}
          options={KIND_LABELS}
          onChange={(kind) => set({ kind })}
        />
        <Select
          label="Added from"
          icon={InboxIcon}
          value={view.from}
          active={view.from !== "any"}
          options={FROM_LABELS}
          onChange={(from) => set({ from })}
        />
        <button
          type="button"
          aria-pressed={view.needs}
          title="Open cards with nobody on them, or whose company the standup could not tell"
          onClick={() => set({ needs: !view.needs })}
          className={cn(chip(view.needs), "inline-flex items-center gap-1.5 px-3")}
        >
          <UserRoundSearchIcon aria-hidden className="size-3.5 opacity-70" />
          Needs owner
        </button>
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <Select
          label="Sort"
          icon={ArrowUpDownIcon}
          value={sortValue}
          active={view.sort.key !== "manual"}
          options={Object.fromEntries([
            ...SORTS.map((s) => [s.value, s.label]),
            ...(sortValue === OTHER_SORT
              ? [[OTHER_SORT, `${capital(sortName(view.sort))}${view.sort.dir === "desc" ? ", reversed" : ""}`]]
              : []),
          ])}
          onChange={(value) => {
            const picked = SORTS.find((s) => s.value === value);
            if (picked) set({ sort: picked.sort });
          }}
        />
        {view.layout === "board" && (
          <Select
            label="Rows"
            icon={Rows3Icon}
            value={view.group}
            active={view.group !== "none"}
            options={{ none: "One board", person: "A row per person" }}
            onChange={(group) => set({ group: group === "person" ? "person" : "none" })}
          />
        )}
        <p className="ml-auto flex items-center gap-x-3 pl-2 text-xs text-ink-3">
          {filtered && (
            <button
              type="button"
              onClick={() =>
                onView({
                  ...defaultView({ isOwner }),
                  sort: view.sort,
                  layout: view.layout,
                  group: view.group,
                  folded: view.folded,
                })
              }
              className="inline-flex items-center gap-0.5 rounded text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <XIcon aria-hidden className="size-3" />
              Clear filters
            </button>
          )}
          <span className="font-num">
            {shown === total ? `${total} ${total === 1 ? "card" : "cards"}` : `Showing ${shown} of ${total}`}
          </span>
        </p>
      </div>
    </div>
  );
}

/** A filter chip holding a native select. Shared with the sales table's toolbar. */
export function Select<T extends string>({
  label,
  icon: Icon,
  value,
  active,
  options,
  onChange,
}: {
  label: string;
  icon: LucideIcon;
  value: T;
  active: boolean;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <label className={cn(chip(active), "relative inline-flex items-center")}>
      <Icon aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 opacity-70" />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-full cursor-pointer appearance-none rounded-full bg-transparent pr-7 pl-7 outline-none"
      >
        {(Object.entries(options) as [T, string][]).map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
      <ChevronDownIcon aria-hidden className="pointer-events-none absolute right-2.5 size-3.5 opacity-60" />
    </label>
  );
}

/**
 * The search box. What is typed is shown at once and written to the view
 * when typing pauses, so the address is not rewritten on every key.
 */
export function SearchBox({
  value,
  onChange,
  label = "Search tasks",
}: {
  value: string;
  onChange: (q: string) => void;
  /** The box's accessible name. */
  label?: string;
}) {
  const [text, setText] = useState(value);
  // Follow a change made elsewhere (Clear filters, the back button).
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  return (
    <label className="relative flex h-9 min-w-40 flex-1 basis-56 items-center sm:max-w-sm">
      <SearchIcon aria-hidden className="pointer-events-none absolute left-3 size-4 text-ink-3" />
      <input
        type="search"
        aria-label={label}
        placeholder="Search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className={cn(
          "h-9 w-full rounded-full border bg-panel pr-3 pl-9 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          value !== "" ? "border-brand/40" : "border-line",
        )}
      />
    </label>
  );
}

/** Whose cards: Everyone, or any of Me, Unassigned and the people offered. */
function AssigneeFilter({
  who,
  people,
  onChange,
}: {
  who: TaskView["who"];
  people: readonly PersonOption[];
  onChange: (who: TaskView["who"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // A click anywhere else puts the list away.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const chosen = who === "all" ? [] : who;
  const toggle = (key: string) => {
    const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
    onChange(next.length === 0 ? "all" : next);
  };
  const labelOf = (key: string) =>
    key === "me" ? "Me" : key === "none" ? "Unassigned" : (people.find((p) => p.key === key)?.label ?? "1 person");
  const summary =
    who === "all" ? "Everyone" : chosen.length === 1 ? labelOf(chosen[0]!) : `${chosen.length} chosen`;

  const option = (key: string, label: ReactNode) => (
    <label
      key={key}
      className="flex cursor-pointer items-center gap-2 rounded-inner px-2 py-1.5 text-xs text-ink hover:bg-surface"
    >
      <input
        type="checkbox"
        checked={key === "all" ? who === "all" : chosen.includes(key)}
        onChange={() => (key === "all" ? onChange("all") : toggle(key))}
        className="size-3.5 accent-brand"
      />
      <span className="truncate">{label}</span>
    </label>
  );

  return (
    <div
      ref={box}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
        className={cn(chip(who !== "all"), "inline-flex max-w-56 items-center gap-1.5 px-3")}
      >
        <UserIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
        <span className="opacity-70">Assignee</span>
        <span className="truncate">{summary}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
      </button>
      {open && (
        <fieldset
          id={panelId}
          className="absolute left-0 z-30 mt-1 max-h-72 w-60 overflow-y-auto rounded-card bg-panel p-1 shadow-soft"
        >
          <legend className="sr-only">Show cards for</legend>
          {option("all", "Everyone")}
          <div className="my-1 border-t border-line" />
          {option("me", "Me")}
          {option("none", "Unassigned")}
          {people.length > 0 && <div className="my-1 border-t border-line" />}
          {people.map((person) => option(person.key, person.label))}
        </fieldset>
      )}
    </div>
  );
}
