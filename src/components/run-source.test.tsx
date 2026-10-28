// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { deferred, mockConvex } from "@/test-support/convex";
import { RunSource } from "./run-source";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const STARTED = "Started. It is listed under Recent runs when it finishes; a backfill can take a minute.";
const backfill = () => screen.getByRole("button", { name: "Backfill 13 months: Mercury" });
const runNow = () => screen.getByRole("button", { name: "Run now: Mercury" });

describe("RunSource", () => {
  test("Run now starts the sync and says where the result will show", async () => {
    const user = userEvent.setup();
    render(<RunSource source="mercury" label="Mercury" />);
    await user.click(runNow());
    expect(convex.mutation(api.sources.runNow)).toHaveBeenCalledWith({ source: "mercury" });
    expect(await screen.findByText(STARTED)).toBeTruthy();
  });

  test("Backfill asks for the long history", async () => {
    const user = userEvent.setup();
    render(<RunSource source="mercury" label="Mercury" />);
    await user.click(backfill());
    expect(convex.mutation(api.sources.runNow)).toHaveBeenCalledWith({
      source: "mercury",
      backfill: true,
    });
  });

  test("a second click while one is starting does nothing, and focus stays put", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    convex.mutation(api.sources.runNow).mockReturnValue(gate.promise);
    render(<RunSource source="mercury" label="Mercury" />);
    await user.click(runNow());
    // Both buttons say so while a start is in flight.
    expect(runNow().getAttribute("aria-disabled")).toBe("true");
    expect(backfill().getAttribute("aria-disabled")).toBe("true");
    await user.click(runNow());
    expect(convex.mutation(api.sources.runNow)).toHaveBeenCalledTimes(1);
    // Not natively disabled: that would drop focus to the top of the page.
    expect(document.activeElement).toBe(runNow());
    gate.resolve(null);
    await screen.findByText(STARTED);
  });

  test("pressing the other button clears the earlier message until its own result", async () => {
    const user = userEvent.setup();
    render(<RunSource source="mercury" label="Mercury" />);
    await user.click(runNow());
    await screen.findByText(STARTED);
    const gate = deferred();
    convex.mutation(api.sources.runNow).mockReturnValue(gate.promise);
    await user.click(backfill());
    expect(screen.queryByText(STARTED)).toBeNull();
    gate.resolve(null);
    await screen.findByText(STARTED);
  });

  test("each button's accessible name starts with its visible text", () => {
    // WCAG 2.5.3: someone who says what they see must hit the button.
    render(<RunSource source="mercury" label="Mercury" />);
    expect(runNow().textContent).toBe("Run now");
    expect(backfill().textContent).toBe("Backfill 13 months");
    expect(runNow().getAttribute("aria-label")?.startsWith("Run now")).toBe(true);
    expect(backfill().getAttribute("aria-label")?.startsWith("Backfill 13 months")).toBe(true);
  });

  test("a source with no backfill gets one button, not two", () => {
    render(<RunSource source="vertical_startup" label="Vertical Startup" backfill={false} />);
    expect(screen.getByRole("button", { name: "Run now: Vertical Startup" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Backfill/ })).toBeNull();
  });

  test("a refusal is shown, not swallowed", async () => {
    const user = userEvent.setup();
    convex.mutation(api.sources.runNow).mockRejectedValue(new ConvexError("Not today."));
    render(<RunSource source="mercury" label="Mercury" />);
    await user.click(runNow());
    expect((await screen.findByRole("alert")).textContent).toBe("Not today.");
  });
});
