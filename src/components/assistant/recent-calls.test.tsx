// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { OUTCOMES, RecentCalls } from "./recent-calls";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 14, 6) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Recent calls", () => {
  const call = (n: number, over: Record<string, unknown> = {}) => ({
    id: `call-${n}`,
    tool: "tasks",
    kind: "read",
    at: NOW - n * HOUR,
    outcome: "ok",
    durationMs: 12,
    client: "Grok bot",
    ...over,
  });
  const rows = () =>
    [...document.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    );

  test("a skeleton while loading", () => {
    render(<RecentCalls />);
    expect(screen.getByTestId("calls-loading")).toBeTruthy();
  });

  test("with none it says so, and says what is kept of a call", () => {
    convex.setQuery(api.assistant.recentCalls, []);
    render(<RecentCalls />);
    expect(screen.getByTestId("calls-empty").textContent).toBe("No calls yet.");
    expect(document.body.textContent).toContain("what was asked for and what came back are not kept");
    expect(document.querySelector("table")).toBeNull();
  });

  test("each call is its tool, which client made it, whether it reads or changes, when, and how it ended", () => {
    convex.setQuery(api.assistant.recentCalls, [
      call(1),
      call(2, { tool: "task_create", kind: "act" }),
      call(3, { tool: "deal_update", kind: "act", outcome: "refused" }),
      call(4, { outcome: "invalid" }),
      call(5, { tool: "sources", outcome: "error" }),
      call(30, { tool: "unknown", outcome: "invalid", client: null }),
    ]);
    render(<RecentCalls />);
    expect(rows()).toEqual([
      ["tasks", "Grok bot", "Read", "1h ago", "Done"],
      ["task_create", "Grok bot", "Change", "2h ago", "Done"],
      ["deal_update", "Grok bot", "Change", "3h ago", "Refused"],
      ["tasks", "Grok bot", "Read", "4h ago", "Not valid"],
      ["sources", "Grok bot", "Read", "5h ago", "Failed"],
      // A row from before clients had names says so.
      ["A tool that does not exist", "Your first token", "Read", "1d ago", "Not valid"],
    ]);
    expect(
      [...document.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["Tool", "Client", "Kind", "When", "Outcome"]);
  });

  test("an outcome is words with an icon in a status chip: colour is never the only sign", () => {
    convex.setQuery(
      api.assistant.recentCalls,
      (Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[]).map((outcome, n) => call(n + 1, { outcome })),
    );
    render(<RecentCalls />);
    const chips = [...document.querySelectorAll('[data-slot="status-chip"]')];
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute("data-tone")])).toEqual(
      Object.values(OUTCOMES).map(({ label, tone }) => [label, tone]),
    );
    for (const chip of chips) expect(chip.querySelector("svg")).toBeTruthy();
  });
});
