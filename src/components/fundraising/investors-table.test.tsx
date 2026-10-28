// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { InvestorCard } from "@/lib/fundraising/sync";
import { DEFAULT_INVESTOR_VIEW, type InvestorView } from "@/lib/fundraising/table-view";
import { mockConvex } from "@/test-support/convex";
import { InvestorsTable } from "./investors-table";

// The investors as a table: the same cards the board draws, filtered and
// sorted by the view the page keeps in the address, a stage changed in the
// row, the sync state in a column, and the bulk bar over `investors.bulk`
// (a stub until the server branch lands: mockConvex answers it by name).

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 86_400_000;

const inv = (name: string, extra: Partial<InvestorCard> = {}): InvestorCard => ({
  id: name.toLowerCase().replaceAll(" ", "-"),
  name,
  stage: "meeting",
  amount: null,
  lastActivityAt: NOW - DAY,
  closedAt: null,
  nextStep: null,
  mirrored: true,
  source: "visible",
  contact: null,
  sourceStage: null,
  notes: null,
  sync: null,
  changedInVisible: false,
  editable: true,
  draggable: true,
  ...extra,
});

const ROWS: InvestorCard[] = [
  inv("Example Ventures", { stage: "contacted", amount: 250_000, nextStep: "Send the deck" }),
  inv("Sample Capital", { stage: "meeting", sync: { status: "pending", queuedAt: NOW } }),
  inv("Placeholder Fund", {
    stage: "diligence",
    amount: 1_000_000,
    sync: { status: "failed", errorCode: "unmapped_stage", queuedAt: NOW },
  }),
  inv("Made-up Angels", { stage: "committed", closedAt: NOW - DAY, changedInVisible: true }),
  inv("Odd Partners", { stage: "unmapped", sourceStage: "Parked", draggable: false }),
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.investors.archived, []);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(start: Partial<InvestorView> = {}, rows = ROWS) {
  const onMove = vi.fn(async (_id: string, _stage: string, _index: number) => null as unknown);
  const onRetry = vi.fn(async (_id: string) => null as unknown);
  const views: InvestorView[] = [];
  function Host() {
    const [view, setView] = useState<InvestorView>({ ...DEFAULT_INVESTOR_VIEW, layout: "table", ...start });
    return (
      <InvestorsTable
        rows={rows}
        view={view}
        onView={(next) => {
          views.push(next);
          setView(next);
        }}
        now={NOW}
        onMove={onMove}
        onRetry={onRetry}
      />
    );
  }
  render(<Host />);
  return { onMove, onRetry, views, user: userEvent.setup() };
}

const table = () => screen.getByRole("table", { name: "Investors" });
const names = () => within(table()).getAllByRole("rowheader").map((cell) => cell.textContent);
const rowOf = (name: string) =>
  within(table())
    .getAllByRole("rowheader")
    .find((cell) => cell.textContent === name)!
    .closest("tr")!;

describe("InvestorsTable", () => {
  test("opens on the investors still in play, in the board's order, each linked to its page", () => {
    setup();
    expect(names()).toEqual(["Example Ventures", "Sample Capital", "Placeholder Fund", "Odd Partners"]);
    expect(within(table()).getByRole("link", { name: "Example Ventures" }).getAttribute("href")).toBe(
      "/fundraising/investors/example-ventures",
    );
    expect(screen.getByText("Showing 4 of 5 investors")).toBeTruthy();
  });

  test("the filters write the view; the search stays on the page", async () => {
    const { user, views } = setup();
    await user.selectOptions(screen.getByLabelText("Stage"), "closed");
    expect(views.at(-1)!.stage).toBe("closed");
    expect(names()).toEqual(["Made-up Angels"]);
    await user.selectOptions(screen.getByLabelText("Sync"), "failed");
    expect(views.at(-1)!.sync).toBe("failed");
    await user.selectOptions(screen.getByLabelText("Stage"), "all");
    expect(names()).toEqual(["Placeholder Fund"]);
  });

  test("every column sorts from its header", async () => {
    const { user, views } = setup();
    await user.click(within(table()).getByRole("button", { name: "Amount" }));
    expect(views.at(-1)!.sort).toEqual({ key: "amount", dir: "asc" });
    expect(names().slice(0, 2)).toEqual(["Example Ventures", "Placeholder Fund"]);
    for (const header of ["Stage", "Last activity", "Sync", "Next step"]) {
      expect(within(table()).getByRole("button", { name: header }), header).toBeTruthy();
    }
  });

  test("a stage changes in the row for a card that moves; one that cannot shows its stage", async () => {
    const { onMove, user } = setup();
    await user.selectOptions(within(rowOf("Example Ventures")).getByLabelText("Stage of Example Ventures"), "meeting");
    expect(onMove).toHaveBeenCalledWith("example-ventures", "meeting", Number.MAX_SAFE_INTEGER);
    expect(within(rowOf("Odd Partners")).queryByLabelText("Stage of Odd Partners")).toBeNull();
    expect(within(rowOf("Odd Partners")).getByText("Unsorted")).toBeTruthy();
  });

  test("the sync column says what is on its way, what failed (with Retry) and what is up to date", async () => {
    const { onRetry, user } = setup();
    expect(within(rowOf("Sample Capital")).getByText("Syncing to Visible")).toBeTruthy();
    expect(within(rowOf("Placeholder Fund")).getByText("Sync failed: Visible has no stage that matches")).toBeTruthy();
    expect(within(rowOf("Example Ventures")).getByText("Up to date")).toBeTruthy();
    await user.click(within(rowOf("Placeholder Fund")).getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledWith("placeholder-fund");
  });

  test("bulk: move the selected to a stage through investors.bulk, each result said", async () => {
    const bulk = convex.mutation(api.investors.bulk);
    // The server's own shape: a refusal carries its words.
    bulk.mockResolvedValue({
      results: [
        { id: "example-ventures", ok: true },
        { id: "sample-capital", ok: false, error: "It is archived." },
      ],
    });
    const { user } = setup();
    await user.click(screen.getByLabelText("Select Example Ventures"));
    await user.click(screen.getByLabelText("Select Sample Capital"));
    const bar = screen.getByRole("region", { name: "Selected investors" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    await user.selectOptions(within(bar).getByLabelText("Set stage"), "diligence");
    expect(bulk).toHaveBeenCalledWith({
      ids: ["example-ventures", "sample-capital"],
      action: { kind: "move", stage: "diligence" },
    });
    const status = await screen.findByRole("status", { name: "Bulk results" });
    expect(status.textContent).toContain("1 moved to Diligence, 1 refused");
    expect(within(status).getByText("Sample Capital: It is archived.")).toBeTruthy();
    // The refused one stays selected.
    expect((screen.getByLabelText("Select Sample Capital") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select Example Ventures") as HTMLInputElement).checked).toBe(false);
  });

  test("bulk: archive asks first; next step takes the words typed", async () => {
    const bulk = convex.mutation(api.investors.bulk);
    bulk.mockImplementation(async (args: { ids: string[] }) => ({ results: args.ids.map((id) => ({ id, ok: true })) }));
    const { user } = setup();
    await user.click(screen.getByLabelText("Select Example Ventures"));
    let bar = screen.getByRole("region", { name: "Selected investors" });
    await user.click(within(bar).getByRole("button", { name: "Set next step" }));
    await user.type(within(bar).getByLabelText("Next step for the selected"), "Book a call");
    await user.click(within(bar).getByRole("button", { name: "Set" }));
    expect(bulk).toHaveBeenLastCalledWith({
      ids: ["example-ventures"],
      action: { kind: "nextStep", text: "Book a call" },
    });

    await user.click(screen.getByLabelText("Select Sample Capital"));
    bar = screen.getByRole("region", { name: "Selected investors" });
    await user.click(within(bar).getByRole("button", { name: "Archive" }));
    expect(bulk).toHaveBeenCalledTimes(1);
    await user.click(within(bar).getByRole("button", { name: "Archive 1" }));
    expect(bulk).toHaveBeenLastCalledWith({ ids: ["sample-capital"], action: { kind: "archive" } });
  });

  test("bulk: a call the server refuses whole is said in its words, and the selection stays", async () => {
    convex.mutation(api.investors.bulk).mockRejectedValue(new ConvexError("You cannot change investors."));
    const { user } = setup();
    await user.click(screen.getByLabelText("Select Example Ventures"));
    await user.selectOptions(screen.getByLabelText("Set stage"), "meeting");
    expect((await screen.findByRole("status", { name: "Bulk results" })).textContent).toBe(
      "You cannot change investors.",
    );
    expect((screen.getByLabelText("Select Example Ventures") as HTMLInputElement).checked).toBe(true);
  });

  test("on a phone, each investor is a card: no table, nothing off to the side", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    setup();
    expect(screen.queryByRole("table", { name: "Investors" })).toBeNull();
    const list = screen.getByRole("list", { name: "Investors" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(4);
    expect(within(cards[0]!).getByRole("link", { name: "Example Ventures" })).toBeTruthy();
    expect(within(cards[0]!).getByLabelText("Select Example Ventures")).toBeTruthy();
    expect(within(cards[2]!).getByText("Sync failed: Visible has no stage that matches")).toBeTruthy();
  });
});
