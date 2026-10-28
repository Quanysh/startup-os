import { describe, expect, test } from "vitest";
import {
  accountsOf,
  addMonths,
  datedPosts,
  filterPosts,
  fromLocalInput,
  monthWeeks,
  postsByDay,
  readView,
  shift,
  toLocalInput,
  weekDays,
  writeView,
  type PostRow,
} from "./view";

const row = (id: string, over: Partial<PostRow> = {}): PostRow => ({
  id: id as PostRow["id"],
  company: "us",
  account: "page",
  person: null,
  status: "idea",
  title: `Post ${id}`,
  body: null,
  pillar: null,
  owner: null,
  plannedAt: null,
  publishedAt: null,
  link: null,
  byClient: null,
  updatedAt: 1,
  snapshots: [],
  ...over,
});
// Local noon, so the viewer's own zone cannot move it across a day.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe("the address", () => {
  test("a view is read and written without noise, and a bad value falls back", () => {
    expect(writeView(readView(new URLSearchParams("")))).toBe("");
    const view = readView(new URLSearchParams("view=week&day=2026-10-14&account=us:page&status=scheduled&q=denials"));
    expect(view).toEqual({ calendar: "week", day: "2026-10-14", account: "us:page", status: "scheduled", q: "denials" });
    expect(new URLSearchParams(writeView(view)).get("day")).toBe("2026-10-14");
    expect(readView(new URLSearchParams("view=year&day=nope&status=maybe"))).toEqual({
      calendar: "month",
      day: null,
      account: null,
      status: null,
      q: "",
    });
  });

  test("filters narrow by account, status and words in the hook, pillar, draft or person", () => {
    const rows = [
      row("a", { title: "Denials at the front desk", status: "draft" }),
      row("b", { company: "kz", account: "person", person: "Ada Example", pillar: "Billing" }),
      row("c", { body: "talks about denials" }),
    ];
    const base = { calendar: "month", day: null, account: null, status: null, q: "" } as const;
    expect(filterPosts(rows, { ...base, q: "DENIALS" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterPosts(rows, { ...base, account: "kz:person:Ada Example" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterPosts(rows, { ...base, status: "draft" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterPosts(rows, { ...base, q: "ada" }).map((r) => r.id)).toEqual(["b"]);
    expect(accountsOf(rows).map((a) => a.key)).toEqual(["kz:person:Ada Example", "us:page"]);
  });
});

describe("rows for the arithmetic", () => {
  test("times become the viewer's own days, and a draft is a body with words", () => {
    const [post] = datedPosts([
      row("a", { plannedAt: noon(2026, 10, 20), body: "  ", snapshots: [] }),
    ]);
    expect(post).toMatchObject({ plannedDay: "2026-10-20", publishedDay: null, hasBody: false });
    expect(datedPosts([row("b", { body: "Words." })])[0]!.hasBody).toBe(true);
  });
});

describe("the calendar's days", () => {
  test("a week is Monday to Sunday", () => {
    expect(weekDays("2026-10-18")).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
  });

  test("a month is whole weeks around its days", () => {
    const weeks = monthWeeks("2026-10-14");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]).toBe("2026-09-28");
    expect(weeks.at(-1)!.at(-1)).toBe("2026-11-01");
    expect(monthWeeks("2027-02-10")).toHaveLength(4);
  });

  test("a step is a week or a month, kept within the month it lands in", () => {
    expect(shift("week", "2026-10-14", 1)).toBe("2026-10-21");
    expect(shift("month", "2026-10-14", -1)).toBe("2026-09-14");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  test("a post sits on the day it went out, else the day it is planned, in time order", () => {
    const byDay = postsByDay([
      row("late", { status: "scheduled", plannedAt: new Date(2026, 9, 20, 15).getTime() }),
      row("early", { status: "scheduled", plannedAt: new Date(2026, 9, 20, 8).getTime() }),
      row("out", { status: "published", plannedAt: noon(2026, 10, 18), publishedAt: noon(2026, 10, 19) }),
      row("idea"),
    ]);
    expect(byDay.get("2026-10-20")!.map((r) => r.id)).toEqual(["early", "late"]);
    expect(byDay.get("2026-10-19")!.map((r) => r.id)).toEqual(["out"]);
    expect(byDay.has("2026-10-18")).toBe(false);
    expect([...byDay.values()].flat()).toHaveLength(3);
  });
});

describe("times in a form", () => {
  test("go to the field and back in the viewer's zone", () => {
    const at = new Date(2026, 9, 21, 9, 30).getTime();
    expect(toLocalInput(at)).toBe("2026-10-21T09:30");
    expect(fromLocalInput("2026-10-21T09:30")).toBe(at);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("garbage")).toBeNull();
  });
});
