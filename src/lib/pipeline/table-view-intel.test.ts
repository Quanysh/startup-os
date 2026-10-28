import { describe, expect, test } from "vitest";
import type { IntelSummary } from "@convex/lib/dealIntel";
import {
  COLUMNS,
  DEFAULT_TABLE_VIEW,
  ehrsOf,
  filterDeals,
  isTableFiltered,
  readTableView,
  sortDeals,
  withColumns,
  writeTableView,
  type TableDeal,
} from "./table-view";

// The US table's intelligence: the column set that shows it, its filters and
// its sorts. The view stays in the address; nothing here is a person's name.

const deal = (name: string, intel: Partial<IntelSummary> | null = null): TableDeal => ({
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
  intel:
    intel === null
      ? null
      : {
          fit: null,
          ehr: null,
          billingModel: null,
          ownership: null,
          signals: 0,
          newestSignal: null,
          competitors: 0,
          ...intel,
        },
});

const A = deal("Austin", { fit: 82, ehr: "athenahealth", billingModel: "outsourced", ownership: "Physician-owned", signals: 3, newestSignal: "2026-09", competitors: 2 });
const B = deal("Boise", { fit: 40, ehr: "Epic", billingModel: "in-house", ownership: "Hospital", signals: 1, newestSignal: "2026-10-02" });
const C = deal("Cleveland", { ehr: "ATHENAHEALTH", signals: 2 });
const D = deal("Denver");
const ALL = [A, B, C, D];
const names = (rows: TableDeal[]) => rows.map((row) => row.name);

describe("the column sets", () => {
  test("the pipeline's columns are the table's own; the intelligence set trades contact, notes and sources for five", () => {
    expect(COLUMNS.pipeline).toEqual([
      "stage",
      "priority",
      "region",
      "size",
      "contact",
      "nextStep",
      "activity",
      "notes",
      "sources",
    ]);
    expect(COLUMNS.intel).toEqual([
      "stage",
      "priority",
      "fit",
      "ehr",
      "billing",
      "ownership",
      "signals",
      "region",
      "size",
      "nextStep",
      "activity",
    ]);
  });

  test("are in the address, with the intelligence filters, and round-trip", () => {
    const view = {
      ...DEFAULT_TABLE_VIEW,
      columns: "intel" as const,
      ehr: "athenahealth",
      billing: "outsourced" as const,
      competitor: "yes" as const,
      sort: { key: "fit" as const, dir: "desc" as const },
    };
    const written = writeTableView(view);
    expect(written).toBe("cols=intel&ehr=athenahealth&billing=outsourced&competitor=yes&sort=fit&dir=desc");
    expect(readTableView(new URLSearchParams(written))).toEqual(view);
    expect(readTableView(new URLSearchParams("cols=wide&billing=maybe&competitor=some&ehr=%20"))).toEqual(
      DEFAULT_TABLE_VIEW,
    );
    expect(readTableView(new URLSearchParams(`ehr=${"x".repeat(200)}`)).ehr).toHaveLength(80);
  });

  test("a sort by a column the set does not show is not kept", () => {
    expect(readTableView(new URLSearchParams("sort=fit")).sort).toBeNull();
    expect(readTableView(new URLSearchParams("cols=intel&sort=notes")).sort).toBeNull();
    expect(readTableView(new URLSearchParams("cols=intel&sort=name&dir=desc")).sort).toEqual({ key: "name", dir: "desc" });
    const sorted = { ...DEFAULT_TABLE_VIEW, columns: "intel" as const, sort: { key: "ehr" as const, dir: "asc" as const } };
    expect(withColumns(sorted, "pipeline")).toEqual({ ...sorted, columns: "pipeline", sort: null });
    const byStage = { ...sorted, sort: { key: "stage" as const, dir: "asc" as const } };
    expect(withColumns(byStage, "pipeline").sort).toEqual({ key: "stage", dir: "asc" });
  });

  test("the intelligence filters count as filtering; the column set does not", () => {
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, columns: "intel" }, "")).toBe(false);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, ehr: "Epic" }, "")).toBe(true);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, billing: "none" }, "")).toBe(true);
    expect(isTableFiltered({ ...DEFAULT_TABLE_VIEW, competitor: "no" }, "")).toBe(true);
  });
});

describe("filtering by intelligence", () => {
  const filtered = (change: Partial<typeof DEFAULT_TABLE_VIEW>) =>
    names(filterDeals(ALL, { ...DEFAULT_TABLE_VIEW, ...change }, ""));

  test("by EHR, whatever its capitals, or none", () => {
    expect(filtered({ ehr: "athenahealth" })).toEqual(["Austin", "Cleveland"]);
    expect(filtered({ ehr: "none" })).toEqual(["Denver"]);
  });

  test("by billing model, or none", () => {
    expect(filtered({ billing: "in-house" })).toEqual(["Boise"]);
    expect(filtered({ billing: "none" })).toEqual(["Cleveland", "Denver"]);
  });

  test("by whether research names a competitor", () => {
    expect(filtered({ competitor: "yes" })).toEqual(["Austin"]);
    expect(filtered({ competitor: "no" })).toEqual(["Boise", "Cleveland", "Denver"]);
  });

  test("the search reads the EHR and the ownership too", () => {
    expect(names(filterDeals(ALL, DEFAULT_TABLE_VIEW, "epic"))).toEqual(["Boise"]);
    expect(names(filterDeals(ALL, DEFAULT_TABLE_VIEW, "physician-owned"))).toEqual(["Austin"]);
  });

  test("ehrsOf lists each EHR once, whatever its capitals, in order", () => {
    expect(ehrsOf(ALL)).toEqual(["athenahealth", "Epic"]);
  });
});

describe("sorting by intelligence", () => {
  const sorted = (key: "fit" | "ehr" | "billing" | "ownership" | "signals", dir: "asc" | "desc" = "asc") =>
    names(sortDeals(ALL, { key, dir }));

  test("fit by score, the unresearched last either way", () => {
    expect(sorted("fit")).toEqual(["Boise", "Austin", "Cleveland", "Denver"]);
    expect(sorted("fit", "desc")).toEqual(["Austin", "Boise", "Cleveland", "Denver"]);
  });

  test("EHR, billing and ownership as text", () => {
    expect(sorted("ehr")).toEqual(["Austin", "Cleveland", "Boise", "Denver"]);
    expect(sorted("billing")).toEqual(["Boise", "Austin", "Cleveland", "Denver"]);
    expect(sorted("ownership", "desc")).toEqual(["Austin", "Boise", "Cleveland", "Denver"]);
  });

  test("signals by the newest one's date, then how many; none last", () => {
    expect(sorted("signals", "desc")).toEqual(["Boise", "Austin", "Cleveland", "Denver"]);
    expect(sorted("signals")).toEqual(["Cleveland", "Austin", "Boise", "Denver"]);
  });
});
