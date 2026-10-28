// What the Engineering page shows of the pull requests once each has a stage:
// the flow's columns, the "stuck and piling up" strip, the table by owner, and
// the sortable, filterable list with its state in the address. Pure, like
// flow.ts: "now" is an argument, and nothing here is stored.
//
// A person appears here as the owner of work that is open: how much they
// hold, and what of it is blocked. Nothing counts what a person shipped: there
// is no "merged per person", on purpose.

import {
  FLOW_STAGES,
  OPEN_STAGES,
  STAGES,
  isStage,
  medianAge,
  placeOf,
  type Placed,
  type PullRow,
  type Stage,
} from "./flow";

/** Who a pull request belongs to: its author. */
export type Owner = {
  /** What a filter and a row are matched on. Never shown. */
  key: string;
  /** Their name where GitHub has one, else their login. */
  name: string;
  initials: string;
};

/** A pull request with its place in the flow and its owner. */
export type Item = { pull: PullRow; placed: Placed; owner: Owner };

const NO_AUTHOR = "Deleted account";

function initialsOf(name: string): string {
  // A name's words are its own; a login's parts are what its hyphens divide.
  const parts = /\s/.test(name.trim()) ? name.trim().split(/\s+/) : name.split(/[._-]+/);
  const words = parts.filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters =
    words.length >= 2
      ? [words[0]!, words[1]!].map((word) => [...word][0]!)
      : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

export function ownerOf(pull: Pick<PullRow, "authorLogin" | "authorName">): Owner {
  const name = pull.authorName ?? pull.authorLogin ?? NO_AUTHOR;
  const key =
    pull.authorLogin !== undefined
      ? pull.authorLogin.toLowerCase()
      : pull.authorName !== undefined
        ? `name:${pull.authorName.toLowerCase()}`
        : "none";
  return { key, name, initials: pull.authorLogin === undefined && pull.authorName === undefined ? "?" : initialsOf(name) };
}

/** Every pull request that is in a stage at `now`. One that left the flow long ago is dropped. */
export function placeAll(rows: readonly PullRow[], now: number): Item[] {
  return rows.flatMap((pull) => {
    const placed = placeOf(pull, now);
    return placed === null ? [] : [{ pull, placed, owner: ownerOf(pull) }];
  });
}

export const isStuck = (item: Item) => item.placed.stuck.length > 0;
const isOpen = (item: Item) => item.pull.state === "open";
const idOf = (item: Item) => `${item.pull.repoId.toLowerCase()}#${item.pull.number}`;
/** The name of a repository without its organisation. */
export const repoName = (repoId: string) => repoId.slice(repoId.indexOf("/") + 1);

// ── The flow ────────────────────────────────────────────────────────────────

export type Column = {
  stage: Stage;
  /** Longest in the stage first; for merged, the most recent first. */
  items: Item[];
  stuck: number;
  /** The median time in the stage; null for an empty one, which is not a zero. */
  medianMs: number | null;
};

export function columnsOf(items: readonly Item[]): Column[] {
  return FLOW_STAGES.map((stage) => {
    const own = items.filter((item) => item.placed.stage === stage);
    const sorted = [...own].sort((a, b) =>
      stage === "merged" ? b.placed.since - a.placed.since : a.placed.since - b.placed.since,
    );
    return {
      stage,
      items: sorted,
      stuck: own.filter(isStuck).length,
      medianMs: medianAge(own.map((item) => item.placed.ageMs)),
    };
  });
}

// ── Stuck and piling up ─────────────────────────────────────────────────────

/** How many are stuck, and the ones stuck the longest. */
export function stuckOnes(items: readonly Item[], named = 3): { count: number; oldest: Item[] } {
  const stuck = items.filter(isStuck).sort((a, b) => a.placed.since - b.placed.since);
  return { count: stuck.length, oldest: stuck.slice(0, named) };
}

const PILE_WORDS: Record<(typeof OPEN_STAGES)[number], string> = {
  draft: "in draft",
  waiting_for_review: "waiting for review",
  changes_requested: "with changes requested",
  approved: "approved and not merged",
};

function weeksWords(ratio: number): string {
  if (ratio < 0.75) return "less than a week";
  if (ratio < 1.25) return "about a week";
  const halves = Math.round(ratio * 2) / 2;
  return `about ${halves} weeks`;
}

/**
 * Which open stage holds the most, against last week's merged count. State
 * table (first matching row wins):
 *   last week's merged count not known  → null (no sentence is made up)
 *   nothing open                        → null
 *   none merged last week               → "N waiting for review, and none merged last week."
 *   otherwise                           → "N waiting for review, about a week of work at last week's pace of M merged."
 * A tie goes to the stage further along the flow: it is nearer to shipping.
 */
export function pileUp(items: readonly Item[], mergedLastWeek: number | null): string | null {
  if (mergedLastWeek === null) return null;
  let top: { stage: (typeof OPEN_STAGES)[number]; count: number } | null = null;
  for (const stage of OPEN_STAGES) {
    const count = items.filter((item) => item.placed.stage === stage).length;
    if (count > 0 && (top === null || count >= top.count)) top = { stage, count };
  }
  if (top === null) return null;
  const held = `${top.count} ${PILE_WORDS[top.stage]}`;
  if (mergedLastWeek === 0) return `${held}, and none merged last week.`;
  return `${held}, ${weeksWords(top.count / mergedLastWeek)} of work at last week's pace of ${mergedLastWeek} merged.`;
}

// ── By owner ────────────────────────────────────────────────────────────────

/** One engineer's open work. No field counts what they merged: this is load, not output. */
export type OwnerRow = {
  owner: Owner;
  open: number;
  waiting: number;
  changes: number;
  approved: number;
  stuck: number;
  /** How long their oldest open pull request has been open. */
  oldestMs: number;
};

/** Everyone with an open pull request: the most stuck first, then whoever holds the oldest. */
export function ownerRows(items: readonly Item[], now: number): OwnerRow[] {
  const rows = new Map<string, OwnerRow>();
  for (const item of items.filter(isOpen)) {
    const row = rows.get(item.owner.key) ?? {
      owner: item.owner,
      open: 0,
      waiting: 0,
      changes: 0,
      approved: 0,
      stuck: 0,
      oldestMs: 0,
    };
    row.open += 1;
    if (item.placed.stage === "waiting_for_review") row.waiting += 1;
    if (item.placed.stage === "changes_requested") row.changes += 1;
    if (item.placed.stage === "approved") row.approved += 1;
    if (isStuck(item)) row.stuck += 1;
    row.oldestMs = Math.max(row.oldestMs, now - item.pull.createdAt, 0);
    rows.set(item.owner.key, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.stuck - a.stuck || b.oldestMs - a.oldestMs || a.owner.name.localeCompare(b.owner.name),
  );
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export const SORT_KEYS = ["opened", "activity", "age", "repo", "owner", "stage"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
/** Null is the page's own order: stuck first, then the oldest. */
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

const COMPARE: Record<SortKey, (a: Item, b: Item) => number> = {
  opened: (a, b) => a.pull.createdAt - b.pull.createdAt,
  activity: (a, b) => a.pull.updatedAt - b.pull.updatedAt,
  age: (a, b) => a.placed.ageMs - b.placed.ageMs,
  repo: (a, b) => repoName(a.pull.repoId).localeCompare(repoName(b.pull.repoId)),
  owner: (a, b) => a.owner.name.localeCompare(b.owner.name),
  stage: (a, b) => STAGES.indexOf(a.placed.stage) - STAGES.indexOf(b.placed.stage),
};
/** What settles a tie, whatever the column: the oldest first, then by where it lives. */
const steady = (a: Item, b: Item) =>
  a.pull.createdAt - b.pull.createdAt || idOf(a).localeCompare(idOf(b));

export function sortItems(items: readonly Item[], sort: Sort): Item[] {
  if (sort === null) {
    return [...items].sort((a, b) => Number(isStuck(b)) - Number(isStuck(a)) || steady(a, b));
  }
  const compare = COMPARE[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => sign * compare(a, b) || steady(a, b));
}

/** What a click on a column's header asks for: ascending first, then the other way. */
export function nextSort(current: Sort, key: SortKey): Sort {
  return current?.key === key && current.dir === "asc" ? { key, dir: "desc" } : { key, dir: "asc" };
}

/** A header's `aria-sort`: how the table is ordered by it, or that it is not. */
export function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

// ── Filters, and their place in the address ─────────────────────────────────

export type Filters = {
  /** An owner's key. */
  owner: string | null;
  /** "org/name". */
  repo: string | null;
  stage: Stage | null;
  stuck: boolean;
  /** Which date the range is about. */
  by: "opened" | "activity";
  /** UTC days, "YYYY-MM-DD", both inclusive. */
  from: string | null;
  to: string | null;
};
export type View = { filters: Filters; sort: Sort };

export const NO_FILTERS: Filters = {
  owner: null,
  repo: null,
  stage: null,
  stuck: false,
  by: "opened",
  from: null,
  to: null,
};

export const isFiltered = (filters: Filters) =>
  filters.owner !== null ||
  filters.repo !== null ||
  filters.stage !== null ||
  filters.stuck ||
  filters.from !== null ||
  filters.to !== null;

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export function filterItems(items: readonly Item[], filters: Filters): Item[] {
  return items.filter((item) => {
    if (filters.owner !== null && item.owner.key !== filters.owner) return false;
    if (filters.repo !== null && item.pull.repoId.toLowerCase() !== filters.repo.toLowerCase()) return false;
    if (filters.stage !== null && item.placed.stage !== filters.stage) return false;
    if (filters.stuck && !isStuck(item)) return false;
    const day = utcDay(filters.by === "opened" ? item.pull.createdAt : item.pull.updatedAt);
    if (filters.from !== null && day < filters.from) return false;
    if (filters.to !== null && day > filters.to) return false;
    return true;
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: string | null): string | null =>
  value !== null && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  utcDay(Date.parse(`${value}T00:00:00Z`)) === value
    ? value
    : null;
// What comes from an address is anybody's typing: short, and only what a key or a repository can be.
const short = (value: string | null, pattern: RegExp, max: number): string | null =>
  value !== null && value.length <= max && pattern.test(value) ? value : null;

/** The view an address asks for. Anything it does not understand is left at its default. */
export function readView(params: URLSearchParams): View {
  const sortKey = params.get("sort");
  const stage = params.get("stage");
  return {
    filters: {
      owner: short(params.get("owner"), /^[\p{L}\p{N} .:_'-]+$/u, 110),
      repo: short(params.get("repo"), /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 140),
      stage: isStage(stage) ? stage : null,
      stuck: params.get("stuck") === "1",
      by: params.get("by") === "activity" ? "activity" : "opened",
      from: realDay(params.get("from")),
      to: realDay(params.get("to")),
    },
    sort: (SORT_KEYS as readonly string[]).includes(sortKey ?? "")
      ? { key: sortKey as SortKey, dir: params.get("dir") === "desc" ? "desc" : "asc" }
      : null,
  };
}

/** A view as a query string, defaults left out, so the plain address is the plain page. */
export function writeView({ filters, sort }: View): string {
  const params = new URLSearchParams();
  if (filters.owner !== null) params.set("owner", filters.owner);
  if (filters.repo !== null) params.set("repo", filters.repo);
  if (filters.stage !== null) params.set("stage", filters.stage);
  if (filters.stuck) params.set("stuck", "1");
  if (filters.by === "activity") params.set("by", "activity");
  if (filters.from !== null) params.set("from", filters.from);
  if (filters.to !== null) params.set("to", filters.to);
  if (sort !== null) {
    params.set("sort", sort.key);
    if (sort.dir === "desc") params.set("dir", "desc");
  }
  return params.toString();
}
