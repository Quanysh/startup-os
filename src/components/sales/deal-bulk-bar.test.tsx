// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TableDeal } from "@/lib/pipeline/table-view";
import { DealBulkBar } from "./deal-bulk-bar";

afterEach(cleanup);

const deal = (id: string, extra: Partial<TableDeal> = {}): TableDeal => ({
  id,
  mirrored: false,
  source: "manual",
  name: `Deal ${id}`,
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

function setup(selected: TableDeal[]) {
  const props = {
    onStage: vi.fn(async (_id: string, _stage: string) => null as unknown),
    onPriority: vi.fn(async (_id: string, _priority: unknown) => null as unknown),
    onArchive: vi.fn(async (_id: string) => null as unknown),
    onKeep: vi.fn(),
    onClear: vi.fn(),
  };
  render(<DealBulkBar selected={selected} {...props} />);
  return { ...props, user: userEvent.setup() };
}

const status = () => screen.getByRole("status").textContent;

describe("DealBulkBar", () => {
  test("is not there with nothing selected; its status line always is", () => {
    setup([]);
    expect(screen.queryByRole("region", { name: "Selected deals" })).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  test("moves the selected deals to a stage, skipping those already there", async () => {
    const { onStage, onClear, user } = setup([deal("a"), deal("b", { stage: "demo" }), deal("c")]);
    expect(screen.getByText("3 selected")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Set stage" }), "demo");
    expect(onStage.mock.calls).toEqual([
      ["a", "demo"],
      ["c", "demo"],
    ]);
    expect(status()).toBe("2 moved to Demo");
    expect(onClear).toHaveBeenCalled();
  });

  test("says what was refused in the server's words, and keeps those selected", async () => {
    const { onPriority, onKeep, onClear, user } = setup([deal("a"), deal("b")]);
    onPriority.mockImplementation(async (id) => {
      if (id === "b") throw new ConvexError("That deal is no longer on the board.");
      return null;
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "Set priority" }), "high");
    expect(onPriority.mock.calls).toEqual([
      ["a", "high"],
      ["b", "high"],
    ]);
    expect(status()).toBe(
      "Priority set to High on 1, 1 refused: That deal is no longer on the board.",
    );
    expect(onKeep).toHaveBeenCalledWith(["b"]);
    expect(onClear).not.toHaveBeenCalled();
  });

  test("clears the priority", async () => {
    const { onPriority, user } = setup([deal("a", { priority: "low" })]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Set priority" }), "none");
    expect(onPriority).toHaveBeenCalledWith("a", null);
    expect(status()).toBe("Priority cleared on 1");
  });

  test("archives only once asked, and says where archived deals are", async () => {
    const { onArchive, onClear, user } = setup([deal("a"), deal("b")]);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByText("Archive 2 deals?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(onArchive).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive 2" }));
    expect(onArchive.mock.calls).toEqual([["a"], ["b"]]);
    expect(status()).toBe("2 archived: they are under Archived deals, where they can be restored");
    expect(onClear).toHaveBeenCalled();
  });
});
