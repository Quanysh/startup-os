import { describe, expect, test } from "vitest";
import {
  DEFAULT_TABLE_VIEW,
  ariaSort,
  boardRows,
  filterDeals,
  isTableFiltered,
  lastActivityLabel,
  nextSort,
  readTableView,
  regionsOf,
  sizeLabel,
  sortDeals,
  writeTableView,
  type TableDeal,
} from "./table-view";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12);

const deal = (name: string, extra: Partial<TableDeal> = {}): TableDeal => ({
  id: name,
  mirrored: false,
  source: "manual",
  name,
  contact: null,
  stage: "lead",
  sourceStage: null,
  amount: null,
  lastActivityAt: null,
  closedAt: null,
  nextStep: null,
  notes: null,
  priority: null,
  region: null,
  physicians: null,
  locations: null,
  sources: [],
  ...extra,
});

describe("the view in the address", () => {
  test("is the table, open deals, any priority and region, in board order by default", () => {
    expect(readTableView(new URLSearchParams())).toEqual(DEFAULT_TABLE_VIEW);
    expect(DEFAULT_TABLE_VIEW).toEqual({
      layout: "table",
      stage: "open",
      priority: "any",
      region: null,
      sort: null,
      // The intelligence's column set and filters (table-view-intel.test.ts).
      columns: "pipeline",
      ehr: null,
      billing: "any",
      competitor: "any",
    });
    expect(writeTableView(DEFAULT_TABLE_VIEW)).toBe("");
  });

  test("round-trips every choice, and writes only what is not the default", () => {
    const view = {
      ...DEFAULT_TABLE_VIEW,
      layout: "board" as const,
      stage: "won" as const,
      priority: "high" as const,
      region: "TX",
      sort: { key: "size" as const, dir: "desc" as const },
    };
    const written = writeTableView(view);
    expect(written).toBe("view=board&stage=won&priority=high&region=TX&sort=size&dir=desc");
    expect(readTableView(new URLSearchParams(written))).toEqual(view);
    expect(writeTableView({ ...DEFAULT_TABLE_VIEW, sort: { key: "name", dir: "asc" } })).toBe(
      "sort=name",
    );
  });

  test("ignores what it does not know, and never takes a search from the address", () => {
    const view = readTableView(
      new URLSearchParams("view=kanban&stage=maybe&priority=urgent&sort=nope&dir=up&q=SECRET"),
    );
    expect(view).toEqual(DEFAULT_TABLE_VIEW);
    expect(readTableView(new URLSearchParams(`region=${"x".repeat(80)}`)).region).toHaveLength(40);
    expect(readTableView(new URLSearchParams("region=%20%20")).region).toBeNull();
  });

  test("a filter, or words searched for, count as filtering; sort and layout do not", () => {
    expect(isTableFiltered(DEFAULT_TABLE_VIEW, "")).toBe(false);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, layout: "board", sort: { key: "name", dir: "asc" } }, "  ")).toBe(false);
    expect(isTableFiltered(DEFAULT_TABLE_VIEW, "vertical")).toBe(true);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, stage: "all" }, "")).toBe(true);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, region: "TX" }, "")).toBe(true);
  });
});

describe("boardRows", () => {
  test("is every card in board order: the stages in turn, each column as stored", () => {
    const board = {
      lead: [deal("B"), deal("A")],
      qualified: [deal("C", { stage: "qualified" })],
      demo: [],
      proposal: [],
      won: [deal("W", { stage: "won" })],
      lost: [],
      unmapped: [deal("U", { stage: "unmapped" })],
    };
    expect(boardRows(board).map((d) => d.name)).toEqual(["B", "A", "C", "W", "U"]);
  });
});

describe("filterDeals", () => {
  const rows = [
    deal("Austin Vertical", { region: "TX", priority: "high", contact: "Casey Placeholder" }),
    deal("Boise Vertical", { stage: "qualified", region: "ID", notes: "Uses athenahealth" }),
    deal("Cleveland Vertical", { stage: "won", region: "OH", priority: "low" }),
    deal("Denver Vertical", { stage: "lost" }),
    deal("Elsewhere", { stage: "unmapped" }),
  ];
  const names = (view: Partial<typeof DEFAULT_TABLE_VIEW>, q = "") =>
    filterDeals(rows, { ...DEFAULT_TABLE_VIEW, ...view }, q).map((d) => d.name);

  test("shows the open deals by default; closed, one stage or all on request", () => {
    expect(names({})).toEqual(["Austin Vertical", "Boise Vertical"]);
    expect(names({ stage: "closed" })).toEqual(["Cleveland Vertical", "Denver Vertical"]);
    expect(names({ stage: "won" })).toEqual(["Cleveland Vertical"]);
    expect(names({ stage: "all" })).toHaveLength(5);
  });

  test("by priority, none included", () => {
    expect(names({ stage: "all", priority: "high" })).toEqual(["Austin Vertical"]);
    expect(names({ stage: "all", priority: "none" })).toEqual(["Boise Vertical", "Denver Vertical", "Elsewhere"]);
  });

  test("by region whatever its capitals, or those with none", () => {
    expect(names({ stage: "all", region: "tx" })).toEqual(["Austin Vertical"]);
    expect(names({ stage: "all", region: "none" })).toEqual(["Denver Vertical", "Elsewhere"]);
  });

  test("by words in the name, the contact or the notes", () => {
    expect(names({ stage: "all" }, " CASEY ")).toEqual(["Austin Vertical"]);
    expect(names({ stage: "all" }, "athena")).toEqual(["Boise Vertical"]);
    expect(names({ stage: "all" }, "vertical")).toHaveLength(4);
  });
});

describe("sortDeals", () => {
  const rows = [
    deal("b", { priority: "low", region: "TX", physicians: 5, locations: 2, lastActivityAt: 3, sources: ["x"] }),
    deal("A", { stage: "won", priority: null, region: null, physicians: 59, locations: 29, lastActivityAt: 1 }),
    deal("c", { stage: "qualified", priority: "high", region: "id", physicians: 5, locations: 9, sources: ["x", "y"] }),
  ];
  const order = (key: Parameters<typeof nextSort>[1], dir: "asc" | "desc" = "asc") =>
    sortDeals(rows, { key, dir }).map((d) => d.name);

  test("unsorted, the board's order", () => {
    expect(sortDeals(rows, null).map((d) => d.name)).toEqual(["b", "A", "c"]);
  });

  test("by name whatever its capitals, by stage in board order, by priority high first", () => {
    expect(order("name")).toEqual(["A", "b", "c"]);
    expect(order("name", "desc")).toEqual(["c", "b", "A"]);
    expect(order("stage")).toEqual(["b", "c", "A"]);
    expect(order("priority")).toEqual(["c", "b", "A"]);
  });

  test("a missing value goes last whichever way", () => {
    expect(order("region")).toEqual(["c", "b", "A"]);
    expect(order("region", "desc")).toEqual(["b", "c", "A"]);
    expect(order("activity", "desc")).toEqual(["b", "A", "c"]);
  });

  test("by size, physicians then locations; by the number of sources", () => {
    expect(order("size")).toEqual(["b", "c", "A"]);
    expect(order("size", "desc")).toEqual(["A", "c", "b"]);
    expect(order("sources", "desc")).toEqual(["c", "b", "A"]);
  });

  test("a header asks for ascending first, then the other way", () => {
    expect(nextSort(null, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "stage")).toEqual({ key: "stage", dir: "asc" });
    expect(ariaSort({ key: "name", dir: "desc" }, "name")).toBe("descending");
    expect(ariaSort({ key: "name", dir: "desc" }, "stage")).toBe("none");
    expect(ariaSort(null, "name")).toBe("none");
  });
});

describe("what the cells say", () => {
  test("size", () => {
    expect(sizeLabel(59, 29)).toBe("59 phys · 29 loc");
    expect(sizeLabel(59, null)).toBe("59 phys");
    expect(sizeLabel(null, 1)).toBe("1 loc");
    expect(sizeLabel(null, null)).toBeNull();
  });

  test("regions, once each whatever their capitals, in order", () => {
    expect(
      regionsOf([deal("a", { region: "TX" }), deal("b", { region: "id" }), deal("c", { region: "tx" }), deal("d")]),
    ).toEqual(["id", "TX"]);
  });

  test("last activity", () => {
    expect(lastActivityLabel(NOW - 2 * 60 * 60 * 1000, NOW)).toBe("Today");
    expect(lastActivityLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(lastActivityLabel(NOW - 9 * DAY, NOW)).toBe("9 days ago");
  });
});
