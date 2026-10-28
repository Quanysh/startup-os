// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf, type Role } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { GoalsPanel } from "./goals-panel";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const Q = "2026-Q4";
let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.goals.list, [
    { id: "g1", quarter: Q, title: "Raise seed", status: "on_track" },
  ]);
});
afterEach(cleanup);

describe("GoalsPanel follows the company in view", () => {
  const inKz = () =>
    render(
      <CompanyProvider allowed={["us", "kz"]}>
        <GoalsPanel quarter={Q} />
      </CompanyProvider>,
    );
  beforeEach(() => window.localStorage.setItem("startup-os:company", "kz"));
  afterEach(() => window.localStorage.clear());

  test("it asks for that company's goals (and the shared ones), and says which a shared one is", () => {
    convex.setQuery(api.goals.list, [
      { id: "g1", quarter: Q, title: "Raise seed", status: "on_track", company: null },
      { id: "g2", quarter: Q, title: "Ten clinics", status: "on_track", company: "kz" },
    ]);
    inKz();
    const asked = vi
      .mocked(useQuery)
      .mock.calls.filter(([ref]) => getFunctionName(ref as never) === "goals:list")
      .map(([, args]) => args);
    expect(asked.at(-1)).toEqual({ quarter: Q, company: "kz" });
    expect(screen.getByText("Raise seed").closest("li")!.textContent).toContain("Both companies");
    expect(screen.getByText("Ten clinics").closest("li")!.textContent).not.toContain("Both companies");
  });

  test("a new goal is the company in view's, or both companies' when chosen", async () => {
    const user = userEvent.setup();
    inKz();
    await user.type(screen.getByLabelText("New goal"), "Ten clinics{Enter}");
    expect(convex.mutation(api.goals.create)).toHaveBeenLastCalledWith({ quarter: Q, title: "Ten clinics", company: "kz" });
    await user.selectOptions(screen.getByLabelText("Whose goal"), "both");
    await user.type(screen.getByLabelText("New goal"), "Hire a designer{Enter}");
    expect(convex.mutation(api.goals.create)).toHaveBeenLastCalledWith({ quarter: Q, title: "Hire a designer" });
  });
});

describe("GoalsPanel", () => {
  test("removing a goal asks first, because it unlinks its tasks for good", async () => {
    const user = userEvent.setup();
    render(<GoalsPanel quarter={Q} />);
    await user.click(screen.getByRole("button", { name: "Remove Raise seed" }));
    expect(convex.mutation(api.goals.remove)).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.goals.remove)).toHaveBeenCalledWith({ id: "g1" });
  });

  test("the removal can be backed out of", async () => {
    const user = userEvent.setup();
    render(<GoalsPanel quarter={Q} />);
    await user.click(screen.getByRole("button", { name: "Remove Raise seed" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(convex.mutation(api.goals.remove)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Raise seed" })).toBeTruthy();
  });

  test("a goal can be renamed in place", async () => {
    const user = userEvent.setup();
    render(<GoalsPanel quarter={Q} />);
    await user.click(screen.getByRole("button", { name: "Rename Raise seed" }));
    const field = screen.getByLabelText("Goal title") as HTMLInputElement;
    expect(field.value).toBe("Raise seed");
    await user.clear(field);
    await user.type(field, "Close the seed round{Enter}");
    expect(convex.mutation(api.goals.update)).toHaveBeenCalledWith({
      id: "g1",
      title: "Close the seed round",
    });
  });

  test("a goal is tagged cash in one press, and untagged in another", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.goals.list, [
      { id: "g1", quarter: Q, title: "Raise seed", status: "on_track", cash: false },
      { id: "g2", quarter: Q, title: "Collect invoices", status: "on_track", cash: true },
    ]);
    render(<GoalsPanel quarter={Q} />);
    const raise = screen.getByRole("button", { name: "Cash goal: Raise seed" });
    expect(raise.getAttribute("aria-pressed")).toBe("false");
    await user.click(raise);
    expect(convex.mutation(api.goals.update)).toHaveBeenCalledWith({ id: "g1", cash: true });
    await user.click(screen.getByRole("button", { name: "Cash goal: Collect invoices" }));
    expect(convex.mutation(api.goals.update)).toHaveBeenLastCalledWith({ id: "g2", cash: false });
  });

  test("Escape abandons a rename", async () => {
    const user = userEvent.setup();
    render(<GoalsPanel quarter={Q} />);
    await user.click(screen.getByRole("button", { name: "Rename Raise seed" }));
    await user.type(screen.getByLabelText("Goal title"), " typo{Escape}");
    expect(convex.mutation(api.goals.update)).not.toHaveBeenCalled();
    expect(screen.getByText("Raise seed")).toBeTruthy();
  });

  test("a change that fails says why instead of failing silently", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.goals.update)
      .mockRejectedValue(new ConvexError("That goal no longer exists."));
    render(<GoalsPanel quarter={Q} />);
    await user.selectOptions(screen.getByLabelText("Status of Raise seed"), "at_risk");
    expect((await screen.findByRole("alert")).textContent).toContain("no longer exists");
  });

  test("adding a goal clears the field at once and restores it if the add fails", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.goals.create)
      .mockRejectedValue(new ConvexError("That title is too long (200 characters at most)."));
    render(<GoalsPanel quarter={Q} />);
    const field = screen.getByLabelText("New goal") as HTMLInputElement;
    await user.type(field, "Sign two pilots{Enter}");
    expect(convex.mutation(api.goals.create)).toHaveBeenCalledWith({
      quarter: Q,
      title: "Sign two pilots",
    });
    expect((await screen.findByRole("alert")).textContent).toContain("too long");
    expect(field.value).toBe("Sign two pilots");
  });
});

describe("GoalsPanel for a viewer who cannot change goals", () => {
  const as = (role: Role) =>
    render(
      <ViewerProvider
        viewer={{ role, companies: ["us", "kz"], areas: areasOf(role), email: null, name: null }}
      >
        <GoalsPanel quarter={Q} />
      </ViewerProvider>,
    );

  test.each(["sales", "engineer"] as const)("%s reads each goal and its status, with nothing to press", (role) => {
    as(role);
    expect(screen.getByText("Raise seed")).toBeTruthy();
    // The status is said in words: there is no menu to read it from.
    expect(screen.getByText("On track")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });

  test("with no goals it does not suggest adding any", () => {
    convex.setQuery(api.goals.list, []);
    as("sales");
    expect(screen.getByText("No goals for this quarter yet.")).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });

  test("a co-founder keeps every control", () => {
    as("cofounder");
    expect(screen.getByRole("combobox", { name: "Status of Raise seed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Raise seed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Raise seed" })).toBeTruthy();
    expect(screen.getByLabelText("New goal")).toBeTruthy();
  });
});

describe("a goal's owner, bot, target, due day and links", () => {
  const goal = {
    id: "g1",
    quarter: Q,
    title: "Raise seed",
    status: "on_track",
    company: null,
    owner: { email: "lena@example.test", name: "Lena Sample" },
    ownerBot: "strategy_advisor",
    target: "v2 live at 3 pilot clinics",
    dueOn: "2026-12-31",
  };

  test("each goal shows them, and what is linked to it", () => {
    convex.setQuery(api.goals.list, [goal]);
    convex.setQuery(api.goals.links, { g1: { tasks: 3, proposals: 1, deals: 2, handoffs: 0 } });
    convex.setQuery(api.bots.list, { bots: [{ botId: "strategy_advisor", name: "Strategy Advisor" }], suggestedMissing: 0 });
    render(<GoalsPanel quarter={Q} />);
    const row = screen.getByText("Raise seed").closest("li")!.textContent!;
    for (const words of ["Lena Sample", "Strategy Advisor", "v2 live at 3 pilot clinics", "Due Dec 31", "3 tasks", "1 proposal", "2 deals", "0 handoffs"]) {
      expect(row).toContain(words);
    }
  });

  test("a count the viewer is not given is left out, not shown as zero", () => {
    convex.setQuery(api.goals.list, [{ ...goal, owner: null, ownerBot: null, target: null, dueOn: null }]);
    convex.setQuery(api.goals.links, { g1: { tasks: 1, proposals: null, deals: null, handoffs: 2 } });
    render(<GoalsPanel quarter={Q} />);
    const row = screen.getByText("Raise seed").closest("li")!.textContent!;
    expect(row).toContain("1 task");
    expect(row).toContain("2 handoffs");
    expect(row).not.toContain("proposal");
    expect(row).not.toContain("deal");
  });

  test("the details are edited in place and saved together; an emptied field is cleared", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.goals.list, [goal]);
    convex.setQuery(api.team.assignable, [
      { email: "lena@example.test", name: "Lena Sample" },
      { email: "sam@example.test", name: null },
    ]);
    convex.setQuery(api.bots.list, { bots: [{ botId: "strategy_advisor", name: "Strategy Advisor" }], suggestedMissing: 0 });
    render(<GoalsPanel quarter={Q} />);
    await user.click(screen.getByRole("button", { name: "Edit owner and target of Raise seed" }));
    await user.selectOptions(screen.getByLabelText("Owner"), "sam@example.test");
    await user.selectOptions(screen.getByLabelText("Bot"), "");
    const target = screen.getByLabelText("Target");
    await user.clear(target);
    await user.type(target, "10 clinics");
    await user.clear(screen.getByLabelText("Due"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.goals.update)).toHaveBeenLastCalledWith({
      id: "g1",
      ownerEmail: "sam@example.test",
      ownerBot: null,
      target: "10 clinics",
      dueOn: null,
    });
  });

  test("an editor without Scorecard or Finance is given no target field, and sends none", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.goals.list, [{ ...goal, target: null }]);
    convex.setQuery(api.team.assignable, [{ email: "lena@example.test", name: "Lena Sample" }]);
    render(
      <ViewerProvider viewer={{ role: "engineer", companies: ["us", "kz"], areas: ["board", "review"], email: null, name: null }}>
        <GoalsPanel quarter={Q} />
      </ViewerProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Edit owner and target of Raise seed" }));
    expect(screen.queryByLabelText("Target")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.goals.update)).toHaveBeenLastCalledWith({
      id: "g1",
      ownerEmail: "lena@example.test",
      ownerBot: "strategy_advisor",
      dueOn: "2026-12-31",
    });
  });

  test("the summary on Today shows none of it", () => {
    convex.setQuery(api.goals.list, [goal]);
    render(<GoalsPanel quarter={Q} summary />);
    expect(screen.getByText("Raise seed").closest("li")!.textContent).not.toContain("MRR");
  });
});
