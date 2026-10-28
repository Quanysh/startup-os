// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ColumnSet, TableDeal, TableSort } from "@/lib/pipeline/table-view";
import { readTable } from "@/lib/table-export";
import { DealTable } from "./deal-table";

afterEach(cleanup);

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
  lastActivityAt: NOW - 2 * DAY,
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

const FULL = deal("Austin Vertical", {
  contact: "Casey Placeholder",
  stage: "qualified",
  nextStep: "Send the pilot outline",
  notes: "Made-up research: a long note about the practice and its billing team.",
  priority: "high",
  region: "TX",
  physicians: 59,
  locations: 29,
  sources: ["Made-up market scan", "Sample list"],
  lastActivityAt: NOW - 9 * DAY,
});

function setup(
  deals: TableDeal[],
  sort: TableSort = null,
  picked: string[] = [],
  columns: ColumnSet = "pipeline",
) {
  const props = {
    onSort: vi.fn(),
    onStage: vi.fn(),
    onPriority: vi.fn(),
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
  };
  render(
    <DealTable
      deals={deals}
      sort={sort}
      now={NOW}
      isSelected={(id) => picked.includes(id)}
      columns={columns}
      {...props}
    />,
  );
  return { ...props, user: userEvent.setup() };
}

const row = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr")!;

describe("DealTable", () => {
  test("names every column, and every one sorts from its header", async () => {
    const { onSort, user } = setup([FULL], { key: "stage", dir: "desc" });
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      "Name",
      "Stage",
      "Priority",
      "Region",
      "Size",
      "Contact",
      "Next step",
      "Last activity",
      "Notes",
      "Sources",
    ]);
    const stage = screen.getByRole("columnheader", { name: "Stage" });
    expect(stage.getAttribute("aria-sort")).toBe("descending");
    // The first header holds the select-all box too, so it is named by both.
    expect(screen.getAllByRole("columnheader")[0]!.getAttribute("aria-sort")).toBe("none");
    await user.click(within(stage).getByRole("button"));
    expect(onSort).toHaveBeenLastCalledWith({ key: "stage", dir: "asc" });
    await user.click(screen.getByRole("button", { name: "Size" }));
    expect(onSort).toHaveBeenLastCalledWith({ key: "size", dir: "asc" });
  });

  test("a row says what the deal is, in each column", () => {
    setup([FULL]);
    const cells = within(row("Austin Vertical")).getAllByRole("cell");
    expect((within(cells[0]!).getByRole("combobox") as HTMLSelectElement).value).toBe("qualified");
    expect((within(cells[1]!).getByRole("combobox") as HTMLSelectElement).value).toBe("high");
    expect(cells.slice(2).map((cell) => cell.textContent)).toEqual([
      "TX",
      "59 phys · 29 loc",
      "Casey Placeholder",
      "Send the pilot outline",
      "9 days ago",
      FULL.notes,
      "2 sources",
    ]);
  });

  test("the name opens the deal's page", () => {
    setup([deal("Austin Vertical", { id: "k57 made/up" })]);
    const link = screen.getByRole("link", { name: "Austin Vertical" });
    expect(link.getAttribute("href")).toBe("/sales/deals/k57%20made%2Fup");
  });

  test("the intelligence's columns: fit, EHR, billing, ownership and signals, each sorting", async () => {
    const researched = deal("Austin Vertical", {
      stage: "qualified",
      nextStep: "Send the pilot outline",
      intel: {
        fit: 82,
        ehr: "athenahealth",
        billingModel: "outsourced",
        ownership: "Physician-owned",
        signals: 3,
        newestSignal: "2026-09",
        competitors: 1,
      },
    });
    const { onSort, user } = setup([researched, deal("Boise Vertical")], null, [], "intel");
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent?.trim())).toEqual([
      "Name",
      "Stage",
      "Priority",
      "Fit",
      "EHR",
      "Billing",
      "Ownership",
      "Signals",
      "Region",
      "Size",
      "Next step",
      "Last activity",
    ]);
    const cells = within(row("Austin Vertical")).getAllByRole("cell");
    expect(cells.slice(2, 7).map((cell) => cell.textContent)).toEqual([
      "82",
      "athenahealth",
      "Outsourced",
      "Physician-owned",
      "3 signalsNewest Sep 2026",
    ]);
    expect(within(row("Boise Vertical")).getAllByRole("cell").slice(2, 7).map((cell) => cell.textContent)).toEqual([
      "—",
      "—",
      "—",
      "—",
      "None",
    ]);
    for (const [name, key] of [
      ["Fit", "fit"],
      ["EHR", "ehr"],
      ["Billing", "billing"],
      ["Ownership", "ownership"],
      ["Signals", "signals"],
    ] as const) {
      await user.click(screen.getByRole("button", { name }));
      expect(onSort).toHaveBeenLastCalledWith({ key, dir: "asc" });
    }
  });

  test("stage and priority change in the row; no priority is a clear", async () => {
    const { onStage, onPriority, user } = setup([FULL]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Stage of Austin Vertical" }), "demo");
    expect(onStage).toHaveBeenCalledWith("Austin Vertical", "demo");
    const priority = screen.getByRole("combobox", { name: "Priority of Austin Vertical" });
    await user.selectOptions(priority, "low");
    expect(onPriority).toHaveBeenLastCalledWith("Austin Vertical", "low");
    await user.selectOptions(priority, "");
    expect(onPriority).toHaveBeenLastCalledWith("Austin Vertical", null);
  });

  test("notes open in full, and the sources list their titles", async () => {
    const { user } = setup([FULL]);
    const notes = screen.getByRole("button", { name: FULL.notes! });
    expect(notes.getAttribute("aria-expanded")).toBe("false");
    expect(notes.getAttribute("title")).toBe(FULL.notes);
    await user.click(notes);
    expect(notes.getAttribute("aria-expanded")).toBe("true");

    const sources = screen.getByRole("button", { name: "2 sources" });
    expect(sources.getAttribute("title")).toBe("Made-up market scan\nSample list");
    expect(screen.queryByRole("list", { name: "Sources of Austin Vertical" })).toBeNull();
    await user.click(sources);
    const list = screen.getByRole("list", { name: "Sources of Austin Vertical" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(FULL.sources);
  });

  test("what is not known is said, not left blank", () => {
    setup([deal("Boise Vertical", { lastActivityAt: null })]);
    const cells = within(row("Boise Vertical")).getAllByRole("cell");
    expect(cells.slice(2).map((cell) => cell.textContent)).toEqual([
      "—",
      "—",
      "—",
      "No next step",
      "No date",
      "—",
      "None",
    ]);
  });

  test("an open deal gone quiet says so, and its row asks for attention", () => {
    setup([deal("Quiet Vertical", { lastActivityAt: NOW - 21 * DAY }), deal("Won Vertical", { stage: "won", lastActivityAt: NOW - 40 * DAY })]);
    expect(within(row("Quiet Vertical")).getByText("Quiet 21 days")).toBeTruthy();
    expect(row("Quiet Vertical").getAttribute("data-tone")).toBe("warning");
    expect(within(row("Won Vertical")).getByText("40 days ago")).toBeTruthy();
    expect(row("Won Vertical").getAttribute("data-tone")).toBeNull();
  });

  test("rows are ticked one by one, or all at once from the header", async () => {
    const { onToggle, onToggleAll, user } = setup([FULL, deal("Boise Vertical")], null, ["Austin Vertical"]);
    expect((screen.getByRole("checkbox", { name: "Select Austin Vertical" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Select Boise Vertical" }));
    expect(onToggle).toHaveBeenCalledWith("Boise Vertical");
    const all = screen.getByRole("checkbox", { name: "Select every deal shown" }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    await user.click(all);
    expect(onToggleAll).toHaveBeenCalled();
  });

  test("a mirrored deal is shown, never changed from its row", () => {
    setup([deal("Mirrored Co", { mirrored: true, source: "kz_crm", priority: undefined, sources: undefined })]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(within(row("Mirrored Co")).getByText("Lead")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Mirrored Co" })).toBeNull();
  });

  test("downloads each stage and priority once, as chosen, and no tick box", () => {
    setup([FULL, deal("Boise Vertical"), deal("Mirrored Co", { mirrored: true, source: "kz_crm", priority: undefined })]);
    expect(screen.getByRole("button", { name: "Download US deals as CSV" })).toBeTruthy();
    const rows = readTable(screen.getByRole("table", { name: "US deals" }));
    expect(rows[0]!.slice(0, 3)).toEqual(["Name", "Stage", "Priority"]);
    expect(rows.slice(1).map((cells) => cells.slice(0, 3))).toEqual([
      ["Austin Vertical", "Qualified", "High"],
      ["Boise Vertical", "Lead", "No priority"],
      ["Mirrored Co", "Lead", "—"],
    ]);
  });
});
