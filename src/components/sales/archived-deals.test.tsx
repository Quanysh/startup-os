// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { ArchivedDeals } from "./archived-deals";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const AT = Date.UTC(2026, 9, 14, 12);
const ARCHIVED = [
  { id: "d1", name: "Boise Vertical", stage: "lead", archivedAt: AT, mirrored: false },
  { id: "d2", name: "Cleveland Vertical", stage: "won", archivedAt: AT - 86_400_000, mirrored: false },
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.deals.archived, ARCHIVED);
});
afterEach(cleanup);

const asked = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref]) => getFunctionName(ref as never) === "deals:archived")
    .map(([, args]) => args);

describe("ArchivedDeals", () => {
  test("is folded away, and asks for nothing until it is opened", () => {
    render(<ArchivedDeals market="us" />);
    const toggle = screen.getByRole("button", { name: "Archived deals" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(asked().every((args) => args === "skip")).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("opened, lists them newest first with when, and restores one", async () => {
    const user = userEvent.setup();
    render(<ArchivedDeals market="us" />);
    await user.click(screen.getByRole("button", { name: "Archived deals" }));
    expect(asked()).toContainEqual({ market: "us" });
    const table = screen.getByRole("table", { name: "Archived deals" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Boise VerticalLeadOct 14Restore",
      "Cleveland VerticalWonOct 13Restore",
    ]);
    await user.click(within(rows[1]!).getByRole("button", { name: "Restore Cleveland Vertical" }));
    expect(convex.mutation(api.deals.restore)).toHaveBeenCalledWith({ id: "d2" });
    expect(screen.getByRole("status").textContent).toBe("Restored to Won.");
  });

  test("a refused restore is said in the server's words", async () => {
    const user = userEvent.setup();
    convex.mutation(api.deals.restore).mockRejectedValueOnce(new ConvexError("That deal is not archived."));
    render(<ArchivedDeals market="us" />);
    await user.click(screen.getByRole("button", { name: "Archived deals" }));
    await user.click(screen.getByRole("button", { name: "Restore Boise Vertical" }));
    expect(screen.getByRole("alert").textContent).toBe("That deal is not archived.");
  });

  test("with none, says how a deal gets here", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.deals.archived, []);
    render(<ArchivedDeals market="us" />);
    await user.click(screen.getByRole("button", { name: "Archived deals" }));
    expect(
      screen.getByText(
        "Nothing is archived. Archive deals from the table to take them off the board without deleting them.",
      ),
    ).toBeTruthy();
  });
});
