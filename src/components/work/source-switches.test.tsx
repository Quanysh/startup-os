// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { deferred, mockConvex } from "@/test-support/convex";
import { SourceSwitches } from "./source-switches";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;

type Status = { state: string; message: string | null; lastRunAt: number; lastOkAt: number | null };
const source = (
  id: string,
  label: string,
  over: { missingEnv?: string[]; status?: Status | null; fedBy?: "push" | "pull" | null } = {},
) => ({
  id,
  label,
  kind: "api",
  description: `What ${label} is read for.`,
  configured: (over.missingEnv ?? []).length === 0,
  missingEnv: over.missingEnv ?? [],
  fedBy:
    over.fedBy === undefined ? ((over.missingEnv ?? []).length === 0 ? "pull" : null) : over.fedBy,
  pushEnv: null,
  status: over.status ?? null,
});

const ok = (ago: number): Status => ({
  state: "ok",
  message: null,
  lastRunAt: NOW - ago,
  lastOkAt: NOW - ago,
});

let convex: ReturnType<typeof mockConvex>;
function show(sources: ReturnType<typeof source>[], off: string[] = []) {
  convex.setQuery(api.sources.list, [source("mercury", "Mercury"), ...sources]);
  convex.setQuery(api.workTools.settings, { off, investorDomains: [], customerDomains: [] });
  return render(<SourceSwitches />);
}
const state = (id: string) =>
  screen.getByTestId(`state-${id}`).textContent?.replace(/\s+/g, " ").trim();

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("SourceSwitches", () => {
  test("a skeleton while loading", () => {
    render(<SourceSwitches />);
    expect(screen.getByTestId("sources-loading")).toBeTruthy();
  });

  test("lists the four work tools and nothing else", () => {
    show([
      source("gmail", "Gmail"),
      source("google_calendar", "Google Calendar"),
      source("linear", "Linear"),
      source("fireflies", "Fireflies"),
    ]);
    const table = screen.getByRole("table", { name: "What is read" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Source",
      "Reads",
      "State",
      "Actions",
    ]);
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toEqual([
      "Gmail",
      "Google Calendar",
      "Linear",
      "Fireflies",
    ]);
    const linear = within(within(table).getByRole("rowheader", { name: "Linear" }).closest("tr")!);
    expect(linear.getAllByRole("cell").map((td) => td.textContent)).toEqual([
      "What Linear is read for.",
      "Waiting for its first read.",
      "Turn off and delete",
    ]);
    expect(linear.getByRole("button", { name: "Turn off and delete: Linear" })).toBeTruthy();
  });

  test("fed by a connector run and not pushed yet", () => {
    show([source("linear", "Linear", { fedBy: "push" })]);
    expect(state("linear")).toBe("Pushed by a connector run. Waiting for its first push.");
    expect(screen.getByRole("button", { name: "Turn off and delete: Linear" })).toBeTruthy();
  });

  test("fed by a connector run: an old setup note is not shown as its state", () => {
    const note: Status = {
      state: "not_configured",
      message: "Turned off under Settings → Work tools.",
      lastRunAt: NOW - HOUR,
      lastOkAt: null,
    };
    show([source("gmail", "Gmail", { fedBy: "push", status: note })]);
    expect(state("gmail")).toBe("Pushed by a connector run. Waiting for its first push.");
  });

  test("fed by a connector run and pushed", () => {
    show([source("gmail", "Gmail", { fedBy: "push", status: ok(HOUR) })]);
    expect(state("gmail")).toBe("Last read 1h ago.");
  });

  test("off", () => {
    show([source("linear", "Linear", { status: ok(HOUR) })], ["linear"]);
    expect(state("linear")).toBe("Off. Nothing from Linear is stored.");
    expect(screen.getByRole("button", { name: "Turn on: Linear" }).textContent).toBe("Turn on");
    expect(screen.queryByRole("button", { name: /Turn off/ })).toBeNull();
  });

  test("not set up: names the variable, and offers no control", () => {
    const { container } = show([source("linear", "Linear", { missingEnv: ["LINEAR_API_KEY"] })]);
    expect(state("linear")).toBe("Not set up. Set LINEAR_API_KEY in the Convex dashboard.");
    expect(container.querySelector("code")?.textContent).toBe("LINEAR_API_KEY");
    // The table's download is the only button: nothing turns the source on or off.
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Download What is read as CSV",
    ]);
  });

  test("never read", () => {
    show([source("linear", "Linear")]);
    expect(state("linear")).toBe("Waiting for its first read.");
    expect(screen.getByRole("button", { name: "Turn off and delete: Linear" }).textContent).toBe(
      "Turn off and delete",
    );
  });

  test("last run ok", () => {
    show([source("linear", "Linear", { status: ok(2 * HOUR) })]);
    expect(state("linear")).toBe("Last read 2h ago.");
  });

  test("last run failed, with an earlier good read", () => {
    show([
      source("linear", "Linear", {
        status: {
          state: "error",
          message: "Linear answered 401 for issues.",
          lastRunAt: NOW,
          lastOkAt: NOW - 5 * HOUR,
        },
      }),
    ]);
    expect(state("linear")).toBe(
      "Last run failed: Linear answered 401 for issues. Last good read 5h ago.",
    );
  });

  test("last run failed, never read", () => {
    show([
      source("fireflies", "Fireflies", {
        status: {
          state: "empty",
          message: "The source returned nothing.",
          lastRunAt: NOW,
          lastOkAt: null,
        },
      }),
    ]);
    expect(state("fireflies")).toBe("Last run failed: The source returned nothing.");
  });

  test("a setup step still to do is said in its own sentence, not as a failure", () => {
    show([
      source("gmail", "Gmail", {
        status: {
          state: "not_configured",
          message: "Connect Google under Settings → Work tools.",
          lastRunAt: NOW,
          lastOkAt: null,
        },
      }),
    ]);
    expect(state("gmail")).toBe("Connect Google under Settings → Work tools.");
  });

  test("turning off asks first; Keep it calls nothing", async () => {
    const user = userEvent.setup();
    show([source("gmail", "Gmail", { status: ok(HOUR) })]);
    await user.click(screen.getByRole("button", { name: "Turn off and delete: Gmail" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Turn off Gmail?");
    expect(dialog.textContent).toContain("This deletes what the OS has stored from it.");
    // Google's grant is deleted by its own button, so nothing is said about a key.
    expect(dialog.textContent).not.toContain("Its key stays");
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(convex.mutation(api.workTools.turnOff)).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test.each([
    ["linear", "Linear"],
    ["fireflies", "Fireflies"],
  ])("for %s the question says its key stays where it is", async (id, label) => {
    const user = userEvent.setup();
    show([source(id, label, { status: ok(HOUR) })]);
    await user.click(screen.getByRole("button", { name: `Turn off and delete: ${label}` }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(`Turn off ${label}?`);
    expect(dialog.textContent).toContain(
      "This deletes what the OS has stored from it. Its key stays in the Convex dashboard until you remove it there.",
    );
  });

  test("confirming turns the source off", async () => {
    const user = userEvent.setup();
    show([source("linear", "Linear", { status: ok(HOUR) })]);
    await user.click(screen.getByRole("button", { name: "Turn off and delete: Linear" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Turn off and delete" }),
    );
    expect(convex.mutation(api.workTools.turnOff)).toHaveBeenCalledWith({ source: "linear" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("while it is being turned off the button is aria-disabled, not disabled, and works once", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    convex.mutation(api.workTools.turnOff).mockReturnValue(gate.promise);
    show([source("linear", "Linear", { status: ok(HOUR) })]);
    await user.click(screen.getByRole("button", { name: "Turn off and delete: Linear" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Turn off and delete",
    });
    await user.click(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await user.click(confirm);
    expect(convex.mutation(api.workTools.turnOff)).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a failure to turn off is shown in the question, which stays open", async () => {
    const user = userEvent.setup();
    convex.mutation(api.workTools.turnOff).mockRejectedValue(new ConvexError("not_owner"));
    show([source("linear", "Linear", { status: ok(HOUR) })]);
    await user.click(screen.getByRole("button", { name: "Turn off and delete: Linear" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Turn off and delete" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe("not_owner");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("Turn on needs no question, and a failure is shown on its row", async () => {
    const user = userEvent.setup();
    show([source("linear", "Linear")], ["linear"]);
    await user.click(screen.getByRole("button", { name: "Turn on: Linear" }));
    expect(convex.mutation(api.workTools.turnOn)).toHaveBeenCalledWith({ source: "linear" });

    convex.mutation(api.workTools.turnOn).mockRejectedValue(new Error("network"));
    await user.click(screen.getByRole("button", { name: "Turn on: Linear" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That could not be changed. Try again.",
    );
  });
});
