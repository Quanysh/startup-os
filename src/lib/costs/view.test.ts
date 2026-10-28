import { describe, expect, test } from "vitest";
import { ariaSort, costMonthOf, filterLines, nextSort, readView, sortLines, totalsOf, writeView } from "./view";

// Every vendor and amount here is made up.
const row = (name: string, category: string, amount: number, extra: Record<string, unknown> = {}) =>
  ({
    name,
    category,
    amount,
    currency: "USD",
    cadence: "monthly",
    startsOn: "2026-01",
    endsOn: null,
    variable: false,
    archivedAt: null,
    ...extra,
  }) as Parameters<typeof sortLines>[0][number];

const ROWS = [
  row("Vercel", "cloud", 20_00),
  row("aws", "cloud", 400_00),
  row("Office rent", "office", 900_00, { cadence: "quarterly" }),
  row("Notion", "software", 1_200_00, { cadence: "yearly" }),
  row("Kaspi fee", "taxes_fees", 5_000_00, { currency: "KZT" }),
];
const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

describe("the order of the table", () => {
  test("unsorted: by category in the list's order, then by name", () => {
    expect(names(sortLines(ROWS, null))).toEqual(["aws", "Vercel", "Notion", "Office rent", "Kaspi fee"]);
  });

  test("by name, whatever its capitals, both ways", () => {
    expect(names(sortLines(ROWS, { key: "name", dir: "asc" }))).toEqual([
      "aws", "Kaspi fee", "Notion", "Office rent", "Vercel",
    ]);
    expect(names(sortLines(ROWS, { key: "name", dir: "desc" }))[0]).toBe("Vercel");
  });

  test("by category", () => {
    expect(names(sortLines(ROWS, { key: "category", dir: "desc" }))[0]).toBe("Kaspi fee");
  });

  test("by monthly equivalent: within a currency, the company's own first; never one currency against another", () => {
    expect(names(sortLines(ROWS, { key: "monthly", dir: "desc" }))).toEqual([
      "aws", "Office rent", "Notion", "Vercel", "Kaspi fee",
    ]);
    expect(names(sortLines(ROWS, { key: "monthly", dir: "asc" }))).toEqual([
      "Vercel", "Notion", "Office rent", "aws", "Kaspi fee",
    ]);
  });

  test("a click sorts ascending, a second the other way, and the header says which", () => {
    const first = nextSort(null, "name");
    expect(first).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(first, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(first, "monthly")).toEqual({ key: "monthly", dir: "asc" });
    expect(ariaSort(first, "name")).toBe("ascending");
    expect(ariaSort({ key: "name", dir: "desc" }, "name")).toBe("descending");
    expect(ariaSort(first, "category")).toBe("none");
    expect(ariaSort(null, "name")).toBe("none");
  });
});

describe("the filter and the totals", () => {
  test("one category, or all", () => {
    expect(names(filterLines(ROWS, "cloud"))).toEqual(["Vercel", "aws"]);
    expect(filterLines(ROWS, null)).toHaveLength(5);
  });

  test("monthly equivalents are totalled per currency, the first row's currency order kept", () => {
    expect(totalsOf(ROWS)).toEqual([
      { currency: "USD", monthly: 20_00 + 400_00 + 300_00 + 100_00 },
      { currency: "KZT", monthly: 5_000_00 },
    ]);
    expect(totalsOf([])).toEqual([]);
  });
});

describe("the view in the address", () => {
  const round = (view: Parameters<typeof writeView>[0]) => readView(new URLSearchParams(writeView(view)));

  test("nothing chosen is an empty address", () => {
    expect(writeView({ category: null, sort: null })).toBe("");
    expect(readView(new URLSearchParams(""))).toEqual({ category: null, sort: null });
  });

  test("a filter and a sort survive the round trip", () => {
    const view = { category: "office", sort: { key: "monthly", dir: "desc" } } as const;
    expect(writeView(view)).toBe("category=office&sort=monthly&dir=desc");
    expect(round(view)).toEqual(view);
  });

  test("anything the page does not know is dropped", () => {
    expect(readView(new URLSearchParams("category=bribes&sort=amount&dir=sideways"))).toEqual({
      category: null,
      sort: null,
    });
    expect(readView(new URLSearchParams("sort=name&dir=sideways")).sort).toEqual({ key: "name", dir: "asc" });
  });
});

test("the month where the user is, as YYYY-MM", () => {
  expect(costMonthOf(new Date(2026, 9, 13, 12).getTime())).toBe("2026-10");
  expect(costMonthOf(new Date(2027, 0, 1, 0, 5).getTime())).toBe("2027-01");
});
