// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { AGENTS_INTRO, AgentsPanel } from "./agents-panel";
import { ThisWeek, weekStartOf } from "./this-week";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// Local noon on Wednesday 2026-10-14. The week in progress began on Monday the 12th.
const { NOW } = vi.hoisted(() => ({ NOW: new Date(2026, 9, 14, 12).getTime() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Agents", () => {
  const AGENTS = [
    { id: "chief_of_staff", name: "Chief of staff", line: "Writes the brief.", on: true },
    { id: "engineering", name: "Engineering manager", line: "Looks at pull requests.", on: false },
  ];

  test("each agent with what it does and a switch that says whether it is on", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.assistant.agents, AGENTS);
    render(<AgentsPanel />);
    expect(screen.getByText(AGENTS_INTRO)).toBeTruthy();
    // Where each runs is chosen on /agents: on the Mac through Claude, or in Startup OS on Gemini.
    expect(AGENTS_INTRO).toContain("on your Mac through Claude, or in Startup OS on Gemini");
    const chief = screen.getByRole("switch", { name: "Chief of staff" });
    const engineering = screen.getByRole("switch", { name: "Engineering manager" });
    expect(chief.getAttribute("aria-checked")).toBe("true");
    expect(engineering.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Looks at pull requests.")).toBeTruthy();

    await user.click(chief);
    expect(convex.mutation(api.assistant.setAgent)).toHaveBeenCalledWith({ agent: "chief_of_staff", on: false });
    await user.click(engineering);
    expect(convex.mutation(api.assistant.setAgent)).toHaveBeenLastCalledWith({ agent: "engineering", on: true });
  });

  test("a switch that could not be saved says so", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.assistant.agents, AGENTS);
    convex.mutation(api.assistant.setAgent).mockRejectedValue(new Error("offline"));
    render(<AgentsPanel />);
    await user.click(screen.getByRole("switch", { name: "Chief of staff" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That could not be saved. Try again.");
  });
});

describe("This week", () => {
  const MEASURE = { briefs: 6, proposed: 9, tasks: 3, people: { us: 4, kz: 2 } };
  const mrr = (value: number | null) => ({
    tiles: [
      {
        key: "mrr",
        scope: "us",
        latest: value === null ? null : { value, periodStart: "2026-09-01", currency: "USD", source: "manual", syncedAt: 0 },
        series: [],
      },
    ],
    sources: {},
  });
  const counts = () =>
    within(screen.getByRole("region", { name: "This week" }))
      .getAllByRole("listitem")
      .slice(0, 3)
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim());

  test("the counts are asked for from the start of the week in progress, which the page names", () => {
    const seen: unknown[] = [];
    convex.setQueryBy(api.assistant.measure, (args) => {
      seen.push(args);
      return MEASURE;
    });
    convex.setQuery(api.metrics.scorecard, mrr(5_000));
    render(<ThisWeek />);
    expect(seen[0]).toEqual({ since: Date.UTC(2026, 9, 12) });
    expect(weekStartOf(NOW)).toBe(Date.UTC(2026, 9, 12));
    expect(counts()).toEqual(["6 Briefs written", "9 Proposals made", "3 Tasks made by agents"]);
  });

  test("what the owner approved and rejected is not counted here: it is each proposer's week on Agents › Bots", () => {
    convex.setQuery(api.assistant.measure, MEASURE);
    convex.setQuery(api.metrics.scorecard, mrr(5_000));
    render(<ThisWeek />);
    const week = screen.getByRole("region", { name: "This week" });
    expect(within(week).queryByText("Approved")).toBeNull();
    expect(within(week).queryByText("Dismissed")).toBeNull();
    expect(within(week).getByRole("link", { name: "Agents › Bots" }).getAttribute("href")).toBe("/agents?view=bots");
  });

  test("This week is the agents' counts alone: ARR per person is on Finance", () => {
    convex.setQuery(api.assistant.measure, MEASURE);
    convex.setQuery(api.metrics.scorecard, mrr(5_000));
    render(<ThisWeek />);
    expect(screen.queryByTestId("arr-tile")).toBeNull();
    expect(screen.queryByText(/ARR per person/)).toBeNull();
  });
});
