// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { ArchivedInvestors } from "./archived-investors";

// `investors.archived` and `investors.restore` are the server branch's; until
// it lands mockConvex answers them by name.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const AT = Date.UTC(2026, 9, 14, 12);
const ARCHIVED = [
  { id: "i1", name: "Example Ventures", stage: "meeting", archivedAt: AT },
  { id: "i2", name: "Sample Capital", stage: "passed", archivedAt: AT - 86_400_000 },
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.investors.archived, ARCHIVED);
});
afterEach(cleanup);

const asked = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref]) => getFunctionName(ref as never) === "investors:archived")
    .map(([, args]) => args);

describe("ArchivedInvestors", () => {
  test("is folded away, and asks for nothing until it is opened", () => {
    render(<ArchivedInvestors />);
    expect(screen.getByRole("button", { name: "Archived investors" }).getAttribute("aria-expanded")).toBe("false");
    expect(asked().every((args) => args === "skip")).toBe(true);
  });

  test("opened, lists them with their stage, and restores one", async () => {
    const user = userEvent.setup();
    render(<ArchivedInvestors />);
    await user.click(screen.getByRole("button", { name: "Archived investors" }));
    expect(asked()).toContainEqual({});
    const rows = within(screen.getByRole("table", { name: "Archived investors" })).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Example Ventures");
    expect(rows[0]!.textContent).toContain("Meeting");
    await user.click(screen.getByRole("button", { name: "Restore Example Ventures" }));
    expect(convex.mutation(api.investors.restore)).toHaveBeenCalledWith({ id: "i1" });
    expect(screen.getByRole("status").textContent).toBe("Restored to Meeting.");
  });

  test("a refused restore is said in the server's words", async () => {
    convex.mutation(api.investors.restore).mockRejectedValue(new ConvexError("That investor is not archived."));
    const user = userEvent.setup();
    render(<ArchivedInvestors />);
    await user.click(screen.getByRole("button", { name: "Archived investors" }));
    await user.click(screen.getByRole("button", { name: "Restore Sample Capital" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That investor is not archived.");
  });

  test("none archived says how to archive", async () => {
    convex.setQuery(api.investors.archived, []);
    const user = userEvent.setup();
    render(<ArchivedInvestors />);
    await user.click(screen.getByRole("button", { name: "Archived investors" }));
    expect(screen.getByText(/Nothing is archived/)).toBeTruthy();
  });
});
