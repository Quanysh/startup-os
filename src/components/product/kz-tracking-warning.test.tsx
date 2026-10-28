// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { TrackingWarning } from "./kz-tracking";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const weeks = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const rows = (event: string, counts: number[]) =>
  counts.map((count, i) => ({ weekStart: weeks[i]!, key: event, values: { count, users: 3 } }));

describe("the overview's tracking warning", () => {
  test("says how many events went quiet and leads to Tracking health", () => {
    convex.setQuery(api.kzProduct.breakdowns, rows("gone", [10, 10, 10, 10, 10, 10, 0, 0]));
    render(<TrackingWarning span={4} end={null} />);
    expect(screen.getByRole("status").textContent).toContain("1 app event went silent");
    expect(screen.getByRole("link", { name: "Open Tracking health" }).getAttribute("href")).toContain("view=tracking");
  });

  test("is not drawn while every event is steady, or before the events are read", () => {
    convex.setQuery(api.kzProduct.breakdowns, rows("fine", [10, 10, 10, 10, 10, 10, 10, 10]));
    const { container, rerender } = render(<TrackingWarning span={1} end={null} />);
    expect(container.textContent).toBe("");
    convex.setQuery(api.kzProduct.breakdowns, undefined);
    rerender(<TrackingWarning span={1} end={null} />);
    expect(container.textContent).toBe("");
  });
});
