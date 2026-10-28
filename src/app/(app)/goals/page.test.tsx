// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, type Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import GoalsPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.UTC(2026, 9, 14, 12) }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.goals.list, [{ id: "g1", quarter: "2026-Q4", title: "Raise seed", status: "at_risk", company: null }]);
  convex.setQuery(api.targets.list, []);
});
afterEach(cleanup);

const asked = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi.mocked(useQuery).mock.calls.some(([called, args]) => args !== "skip" && getFunctionName(called as never) === getFunctionName(ref));

const as = (role: "owner" | "cofounder" | "sales", areas: readonly Area[]) =>
  render(
    <ViewerProvider viewer={{ role, companies: ["us", "kz"], areas, email: "me@example.test", name: null }}>
      <GoalsPage />
    </ViewerProvider>,
  );

describe("Goals and targets", () => {
  test("the quarter's goals and the targets, on one page", () => {
    as("owner", AREAS);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Goals and targets");
    expect(within(screen.getByRole("region", { name: /^Goals/ })).getByText("Raise seed")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Targets" })).toBeTruthy();
    // The owner changes both.
    expect(screen.getByLabelText("New goal")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Targets" })).getAllByRole("spinbutton").length).toBeGreaterThan(0);
  });

  test("each part is there only for a viewer the server sends it: goals with the scorecard or the board, targets with the scorecard or settings", () => {
    vi.mocked(useQuery).mockClear();
    as("sales", ["board"]);
    expect(screen.getByText("Raise seed")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Targets" })).toBeNull();
    expect(asked(api.targets.list)).toBe(false);
    cleanup();
    vi.mocked(useQuery).mockClear();
    as("sales", ["settings"]);
    expect(screen.queryByRole("region", { name: /^Goals/ })).toBeNull();
    expect(asked(api.goals.list)).toBe(false);
    // Settings sets the targets: the editor is theirs.
    expect(within(screen.getByRole("table", { name: "Targets" })).getAllByRole("spinbutton").length).toBeGreaterThan(0);
  });

  test("goals are changed with the review area, targets with settings; without them both are read", () => {
    as("sales", ["scorecard", "board"]);
    expect(screen.queryByLabelText("New goal")).toBeNull();
    expect(screen.getByText("Raise seed")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Targets" })).queryAllByRole("spinbutton")).toEqual([]);
    cleanup();
    as("cofounder", ["scorecard", "review"]);
    expect(screen.getByLabelText("New goal")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Targets" })).queryAllByRole("spinbutton")).toEqual([]);
  });
});
