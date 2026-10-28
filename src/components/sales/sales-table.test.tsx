// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { DEFAULT_TABLE_VIEW, type DealTableView, type TableDeal } from "@/lib/pipeline/table-view";
import { mockConvex } from "@/test-support/convex";
import { SalesTable } from "./sales-table";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

const deal = (name: string, extra: Partial<TableDeal> = {}): TableDeal => ({
  id: name,
  mirrored: false,
  source: "manual",
  name,
  contact: null,
  stage: "lead",
  sourceStage: null,
  amount: null,
  lastActivityAt: NOW - DAY,
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

const BOARD = {
  lead: [
    deal("Austin Vertical", { priority: "high", region: "TX", contact: "Casey Placeholder" }),
    deal("Boise Vertical", { region: "ID", notes: "Uses athenahealth" }),
  ],
  qualified: [deal("Cleveland Vertical", { stage: "qualified", priority: "low", region: "OH" })],
  demo: [],
  proposal: [],
  won: [deal("Denver Vertical", { stage: "won", closedAt: NOW - DAY })],
  lost: [],
  unmapped: [],
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.deals.archived, []);
  convex.setQuery(api.dealIntel.list, []);
});
afterEach(cleanup);

function setup(start: Partial<DealTableView> = {}, board = BOARD) {
  const handlers = {
    onMove: vi.fn(async (_id: string, _stage: string, _index: number) => null as unknown),
    onCreate: vi.fn(async (_stage: string, _name: string) => null as unknown),
  };
  const views: DealTableView[] = [];
  // The page keeps the view in the address; here, in state, so a change shows.
  function Host() {
    const [view, setView] = useState<DealTableView>({ ...DEFAULT_TABLE_VIEW, ...start });
    return (
      <SalesTable
        board={board}
        view={view}
        onView={(next) => {
          views.push(next);
          setView(next);
        }}
        now={NOW}
        {...handlers}
      />
    );
  }
  render(<Host />);
  return { ...handlers, views, user: userEvent.setup() };
}

const names = () =>
  within(screen.getByRole("table", { name: "US deals" }))
    .getAllByRole("rowheader")
    .map((cell) => cell.textContent);
const count = () => screen.getByText(/^(Showing \d+ of )?\d+ deals?$/).textContent;

describe("SalesTable", () => {
  test("opens on the deals still in play, and says how many of all it shows", () => {
    setup();
    expect(names()).toEqual(["Austin Vertical", "Boise Vertical", "Cleveland Vertical"]);
    expect(count()).toBe("Showing 3 of 4 deals");
  });

  test("a filter writes the view; won and lost are one choice away", async () => {
    const { user, views } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "closed");
    expect(views.at(-1)).toMatchObject({ stage: "closed" });
    expect(names()).toEqual(["Denver Vertical"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Region" }), "TX");
    expect(views.at(-1)).toMatchObject({ stage: "closed", region: "TX" });
    expect(screen.getByText("No deals match.")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: /Clear filters/ })[0]!);
    expect(views.at(-1)).toEqual(DEFAULT_TABLE_VIEW);
    expect(names()).toHaveLength(3);
  });

  test("the region filter offers the regions the deals name", () => {
    setup();
    const options = within(screen.getByRole("combobox", { name: "Region" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Any region", "ID", "OH", "TX", "No region"]);
  });

  test("the search narrows the table without touching the view (names stay out of the address)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, views } = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search deals" }), "athena");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(names()).toEqual(["Boise Vertical"]);
    expect(views).toEqual([]);
    vi.useRealTimers();
  });

  test("a header sorts, through the view", async () => {
    const { user, views } = setup();
    await user.click(screen.getByRole("button", { name: "Priority" }));
    expect(views.at(-1)?.sort).toEqual({ key: "priority", dir: "asc" });
    expect(names()).toEqual(["Austin Vertical", "Cleveland Vertical", "Boise Vertical"]);
  });

  test("stage changes in the row go to the end of the new stage; priority through deals.update", async () => {
    const { onMove, user } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Stage of Boise Vertical" }), "demo");
    expect(onMove).toHaveBeenCalledWith("Boise Vertical", "demo", Number.MAX_SAFE_INTEGER);
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority of Boise Vertical" }), "medium");
    expect(convex.mutation(api.deals.update)).toHaveBeenCalledWith({ id: "Boise Vertical", priority: "medium" });
  });

  test("a refused change in a row is said in the server's words", async () => {
    const { user } = setup();
    convex.mutation(api.deals.update).mockRejectedValueOnce(new ConvexError("That deal is no longer on the board."));
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority of Austin Vertical" }), "low");
    expect((await screen.findByRole("alert")).textContent).toBe("That deal is no longer on the board.");
  });

  test("select every deal shown, then archive them, each through deals.archive", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Select every deal shown" }));
    expect(screen.getByText("3 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive 3" }));
    expect(convex.mutation(api.deals.archive).mock.calls).toEqual([
      [{ id: "Austin Vertical" }],
      [{ id: "Boise Vertical" }],
      [{ id: "Cleveland Vertical" }],
    ]);
  });

  test("at most 100 are selected at once, and the table says so", async () => {
    const many = Array.from({ length: 120 }, (_, n) => deal(`Made-up Vertical ${n}`));
    const { user } = setup({}, { ...BOARD, lead: many });
    await user.click(screen.getByRole("checkbox", { name: "Select every deal shown" }));
    expect(screen.getByText("100 selected")).toBeTruthy();
    expect(screen.getByText("At most 100 deals can be selected at once.")).toBeTruthy();
  });

  test("the name opens the deal's page, where its editor is", () => {
    setup();
    expect(screen.getByRole("link", { name: "Austin Vertical" }).getAttribute("href")).toBe(
      "/sales/deals/Austin%20Vertical",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the intelligence's columns show what research found, and its filters narrow the table", async () => {
    convex.setQuery(api.dealIntel.list, [
      {
        dealId: "Austin Vertical",
        fit: 82,
        ehr: "athenahealth",
        billingModel: "outsourced",
        ownership: "Physician-owned",
        signals: 2,
        newestSignal: "2026-09-02",
        competitors: 1,
      },
      {
        dealId: "Cleveland Vertical",
        fit: 40,
        ehr: "Epic",
        billingModel: "in-house",
        ownership: null,
        signals: 0,
        newestSignal: null,
        competitors: 0,
      },
    ]);
    const { views, user } = setup();
    // The pipeline's columns by default, and no intelligence filter in sight.
    expect(screen.queryByRole("columnheader", { name: "Fit" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "EHR" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Intelligence" }));
    expect(views.at(-1)!.columns).toBe("intel");
    expect(screen.getByRole("columnheader", { name: "Fit" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Notes" })).toBeNull();
    const austin = screen.getByRole("rowheader", { name: /Austin Vertical/ }).closest("tr")!;
    expect(within(austin).getByText("athenahealth")).toBeTruthy();
    expect(within(austin).getByText("Outsourced")).toBeTruthy();

    const ehr = screen.getByRole("combobox", { name: "EHR" }) as HTMLSelectElement;
    expect([...ehr.options].map((option) => option.textContent)).toEqual([
      "Any EHR",
      "athenahealth",
      "Epic",
      "No EHR known",
    ]);
    await user.selectOptions(ehr, "Epic");
    expect(names()).toEqual(["Cleveland Vertical"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "EHR" }), "any");
    await user.selectOptions(screen.getByRole("combobox", { name: "Competitors" }), "yes");
    expect(names()).toEqual(["Austin Vertical"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Competitors" }), "any");
    await user.selectOptions(screen.getByRole("combobox", { name: "Billing" }), "none");
    expect(names()).toEqual(["Boise Vertical"]);

    // Sorted by fit, then back to the pipeline's columns: the sort goes with them.
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(views.at(-1)!.sort).toEqual({ key: "fit", dir: "asc" });
    await user.click(screen.getByRole("button", { name: "Pipeline" }));
    expect(views.at(-1)).toMatchObject({ columns: "pipeline", sort: null, billing: "none" });
    // A filter that is set stays in sight with the pipeline's columns.
    expect(screen.getByRole("combobox", { name: "Billing" })).toBeTruthy();
  });

  test("a deal is added to Lead", async () => {
    const { onCreate, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add a deal" }));
    await user.type(screen.getByRole("textbox", { name: "New deal in Lead" }), "Erie Vertical{Enter}");
    expect(onCreate).toHaveBeenCalledWith("lead", "Erie Vertical");
  });

  test("with no deals at all, says how to start", () => {
    setup({}, { lead: [], qualified: [], demo: [], proposal: [], won: [], lost: [], unmapped: [] });
    expect(screen.getByText("No US deals yet. Add the first one above.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "US deals" })).toBeNull();
  });
});
