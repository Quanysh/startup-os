import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import {
  POST_STATUSES,
  accountKey,
  addDays,
  dayOnCalendar,
  isDay,
  mondayOf,
  type DatedPost,
  type PostStatus,
  type Snapshot,
} from "@convex/lib/linkedin";
import { localIsoDate } from "@/lib/dates";

// /linkedin's view: week or month, the day it is centred on, and the filters.
// It lives in the address (read with `readView`, written with `writeView`),
// never in component state, and the narrowing is done here on the rows already
// sent. Days are the browser's own (a post planned for 9:00 where the viewer
// is sits on that day there), worked out with `localIsoDate`.

export type ListData = FunctionReturnType<typeof api.linkedin.list>;
export type PostRow = ListData["posts"][number];
export type SnapshotRow = PostRow["snapshots"][number];

export const CALENDAR_VIEWS = ["week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export type View = {
  calendar: CalendarView;
  /** The day the calendar is centred on, "YYYY-MM-DD"; null is today. */
  day: string | null;
  /** An account key (`accountKey`): a company's page or one of its people. */
  account: string | null;
  status: PostStatus | null;
  /** Words to look for in a hook, a pillar or a draft. */
  q: string;
};

export const DEFAULT_VIEW: View = { calendar: "month", day: null, account: null, status: null, q: "" };

export function readView(params: URLSearchParams): View {
  const calendar = params.get("view");
  const status = params.get("status");
  const day = params.get("day");
  return {
    calendar: calendar === "week" ? "week" : "month",
    day: day !== null && isDay(day) ? day : null,
    account: params.get("account") || null,
    status: (POST_STATUSES as readonly string[]).includes(status ?? "") ? (status as PostStatus) : null,
    q: (params.get("q") ?? "").slice(0, 100),
  };
}

/** The query string for a view: only what differs from the default. */
export function writeView(view: View): string {
  const params = new URLSearchParams();
  if (view.calendar !== DEFAULT_VIEW.calendar) params.set("view", view.calendar);
  if (view.day !== null) params.set("day", view.day);
  if (view.account !== null) params.set("account", view.account);
  if (view.status !== null) params.set("status", view.status);
  if (view.q !== "") params.set("q", view.q);
  return params.toString();
}

export function filterPosts(rows: readonly PostRow[], view: View): PostRow[] {
  const words = view.q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (view.account === null || accountKey(row) === view.account) &&
      (view.status === null || row.status === view.status) &&
      (words === "" ||
        [row.title, row.pillar ?? "", row.body ?? "", row.person ?? ""].some((text) => text.toLowerCase().includes(words))),
  );
}

/** The accounts the rows are on, for the filter: one per company page and per person. */
export function accountsOf(rows: readonly PostRow[]): { key: string; row: PostRow }[] {
  const seen = new Map<string, PostRow>();
  for (const row of rows) if (!seen.has(accountKey(row))) seen.set(accountKey(row), row);
  return [...seen].map(([key, row]) => ({ key, row })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ── Rows as the arithmetic reads them ───────────────────────────────────────

/** The rows with each time turned into the viewer's own calendar day. */
export function datedPosts(rows: readonly PostRow[], dayOf: (at: number) => string = localIsoDate): DatedPost[] {
  return rows.map((row) => ({
    id: row.id,
    company: row.company,
    account: row.account,
    person: row.person,
    status: row.status,
    title: row.title,
    hasBody: row.body !== null && row.body.trim() !== "",
    plannedDay: row.plannedAt === null ? null : dayOf(row.plannedAt),
    publishedDay: row.publishedAt === null ? null : dayOf(row.publishedAt),
    snapshots: row.snapshots.map(
      (s): Snapshot => ({
        day: s.day,
        impressions: s.impressions,
        reactions: s.reactions,
        comments: s.comments,
        reposts: s.reposts,
        clicks: s.clicks,
        followersGained: s.followersGained,
      }),
    ),
  }));
}

// ── The calendar's days ─────────────────────────────────────────────────────

/** The seven days of the week a day is in, Monday first. */
export function weekDays(anchor: string): string[] {
  const start = mondayOf(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The weeks of the month a day is in, each Monday to Sunday, padded with the days around it. */
export function monthWeeks(anchor: string): string[][] {
  const first = `${anchor.slice(0, 7)}-01`;
  const last = addDays(`${addMonths(anchor, 1).slice(0, 7)}-01`, -1);
  const weeks: string[][] = [];
  for (let start = mondayOf(first); start <= last; start = addDays(start, 7)) weeks.push(weekDays(start));
  return weeks;
}

/** The same day of the month `by` months on, kept within the month it lands in. */
export function addMonths(day: string, by: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const total = year * 12 + (month - 1) + by;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(date, inMonth)).padStart(2, "0")}`;
}

/** One step back or forward: a week, or a month. */
export const shift = (view: CalendarView, anchor: string, direction: -1 | 1): string =>
  view === "week" ? addDays(anchor, 7 * direction) : addMonths(anchor, direction);

/** The posts on each calendar day (a published post on the day it went out), in time order. */
export function postsByDay(rows: readonly PostRow[], dayOf: (at: number) => string = localIsoDate): Map<string, PostRow[]> {
  const byDay = new Map<string, PostRow[]>();
  for (const row of rows) {
    const day = dayOnCalendar({
      plannedDay: row.plannedAt === null ? null : dayOf(row.plannedAt),
      publishedDay: row.publishedAt === null ? null : dayOf(row.publishedAt),
    });
    if (day !== null) byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.publishedAt ?? a.plannedAt ?? 0) - (b.publishedAt ?? b.plannedAt ?? 0));
  return byDay;
}

// ── Times in a form ─────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** A time as a `datetime-local` field holds it, in the viewer's own zone; "" for none. */
export function toLocalInput(at: number | null): string {
  if (at === null) return "";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The time a `datetime-local` field holds, or null for an empty or unreadable one. */
export function fromLocalInput(value: string): number | null {
  if (value === "") return null;
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? null : at;
}
