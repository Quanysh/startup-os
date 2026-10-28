// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { MEMBER_ROLES, ROLE_LABELS, areasOf } from "@convex/lib/roles";
import { deferred, mockConvex } from "@/test-support/convex";
import { AddTeammate } from "./add-teammate";
import { NO_PAGES, pageNames } from "./page-checks";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
const added = () => convex.mutation(api.team.add);
const email = () => screen.getByLabelText("Google account email") as HTMLInputElement;
const role = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const company = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const pages = () => within(screen.getByRole("group", { name: "Pages" }));
const page = (name: string) => pages().getByRole("checkbox", { name }) as HTMLInputElement;
/** The names of the ticked pages, in the order shown. */
const ticked = () =>
  (pages().getAllByRole("checkbox") as HTMLInputElement[])
    .filter((box) => box.checked)
    .map((box) => box.labels?.[0]?.textContent);
const addButton = () => screen.getByRole("button", { name: "Add to the team" });

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const AGENTS = "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents";

describe("AddTeammate", () => {
  test("starts with both companies ticked, no role chosen, no page ticked, and says how the person signs in", () => {
    render(<AddTeammate />);
    expect(company("Startup").checked).toBe(true);
    expect(company("Globex").checked).toBe(true);
    for (const name of ["Co-founder", "Sales", "Engineer"]) expect(role(name).checked).toBe(false);
    expect(screen.queryByRole("radio", { name: "Owner" })).toBeNull();
    expect(ticked()).toEqual([]);
    // Nothing is said about an empty set before there is a set to speak of.
    expect(screen.queryByText(NO_PAGES)).toBeNull();
    expect(screen.getByText(/signs in with that Google account at/)).toBeTruthy();
    expect(screen.getByText(window.location.origin)).toBeTruthy();
  });

  test.each(MEMBER_ROLES)("choosing %s ticks exactly that role's pages", async (id) => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.click(role(ROLE_LABELS[id]));
    expect(ticked()).toEqual(pageNames(areasOf(id)));
  });

  test("choosing another role sets the pages to that role's, replacing what was ticked", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.click(role("Co-founder"));
    await user.click(page("Finance"));
    await user.click(role("Engineer"));
    expect(ticked()).toEqual(["Board", "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents", "Product", "Engineering: pull requests, who owns them and what is stuck"]);
  });

  test("pages are ticked and unticked freely, and the role stays what was chosen", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.type(email(), "new.person@example.com");
    await user.click(role("Engineer"));
    await user.click(page("Finance"));
    await user.click(page("Board"));
    expect(role("Engineer").checked).toBe(true);
    expect(ticked()).toEqual(["Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents", "Finance", "Product", "Engineering: pull requests, who owns them and what is stuck"]);
    await user.click(addButton());
    expect(added()).toHaveBeenCalledWith({
      email: "new.person@example.com",
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["finance", "product", "engineering", "agents"],
    });
  });

  test("sends the email, role, companies and pages, then clears and returns to the email field", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.type(email(), "new.person@example.com");
    await user.click(role("Sales"));
    await user.click(company("Globex"));
    await user.click(addButton());

    expect(added()).toHaveBeenCalledTimes(1);
    expect(added()).toHaveBeenCalledWith({
      email: "new.person@example.com",
      role: "sales",
      companies: ["us"],
      areas: ["scorecard", "sales", "customers", "marketing", "gtm", "board"],
    });
    expect(email().value).toBe("");
    expect(role("Sales").checked).toBe(false);
    expect(ticked()).toEqual([]);
    expect(company("Startup").checked).toBe(true);
    expect(company("Globex").checked).toBe(true);
    expect(document.activeElement).toBe(email());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("with every page unticked it says what the person will see, and still adds them", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.type(email(), "new.person@example.com");
    await user.click(role("Engineer"));
    expect(screen.queryByText(NO_PAGES)).toBeNull();
    await user.click(page("Product"));
    await user.click(page("Engineering: pull requests, who owns them and what is stuck"));
    await user.click(page("Board"));
    await user.click(page(AGENTS));
    expect(screen.getByText(NO_PAGES)).toBeTruthy();
    await user.click(addButton());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(added()).toHaveBeenCalledWith({
      email: "new.person@example.com",
      role: "engineer",
      companies: ["us", "kz"],
      areas: [],
    });
  });

  test("a ticked page that will be empty for the chosen companies is named, and goes when it no longer is", async () => {
    const user = userEvent.setup();
    const NOTE = "Empty for someone on Globex only: Fundraising.";
    render(<AddTeammate />);
    await user.click(role("Co-founder"));
    expect(screen.queryByText(/^Empty for someone/)).toBeNull();
    await user.click(company("Startup"));
    expect(screen.getByText(NOTE)).toBeTruthy();
    // Go to market has the LinkedIn calendar, which Globex has too: not empty.
    await user.click(page("Fundraising"));
    expect(screen.queryByText(/^Empty for someone/)).toBeNull();
    await user.click(page("Fundraising"));
    expect(screen.getByText(NOTE)).toBeTruthy();
    await user.click(company("Startup"));
    expect(screen.queryByText(/^Empty for someone/)).toBeNull();
  });

  test.each([
    "That is not an email address.",
    "Pick at least one company.",
    "That address is an owner's. An owner is not added to the team.",
    "That person is already on the team.",
    "The team is full (50 people at most).",
    "The owner's own mail, calendar and meeting notes, and the work-tool settings, are the owner's only.",
    "That is not a page of the OS.",
  ])("shows the server's refusal as it came: %s", async (sentence) => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    added().mockRejectedValueOnce(new ConvexError(sentence));
    await user.type(email(), "someone@example.com");
    await user.click(role("Engineer"));
    await user.click(page("Finance"));
    await user.click(addButton());

    expect(screen.getByRole("alert").textContent).toBe(sentence);
    // What was typed and ticked is kept, to be corrected.
    expect(email().value).toBe("someone@example.com");
    expect(role("Engineer").checked).toBe(true);
    expect(ticked()).toEqual(["Board", "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents", "Finance", "Product", "Engineering: pull requests, who owns them and what is stuck"]);
  });

  test("a failure that is not the server's own words still says something", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    added().mockRejectedValueOnce(new Error("network"));
    await user.type(email(), "someone@example.com");
    await user.click(role("Engineer"));
    await user.click(addButton());
    expect(screen.getByRole("alert").textContent).toBe("That could not be saved. Try again.");
  });

  test("with no company ticked nothing is sent, in the server's own sentence", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.type(email(), "someone@example.com");
    await user.click(role("Engineer"));
    await user.click(company("Startup"));
    await user.click(company("Globex"));
    await user.click(addButton());
    expect(added()).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Pick at least one company.");
  });

  test("with no email or no role nothing is sent, even with pages ticked by hand", async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.click(addButton());
    expect(screen.getByRole("alert").textContent).toBe("That is not an email address.");
    await user.type(email(), "someone@example.com");
    await user.click(page("Finance"));
    await user.click(addButton());
    expect(screen.getByRole("alert").textContent).toBe("Pick a role.");
    expect(added()).not.toHaveBeenCalled();
    expect(ticked()).toEqual(["Finance"]);
  });

  test("while a request is out the button is aria-disabled, not disabled, and sends nothing twice", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<AddTeammate />);
    added().mockReturnValueOnce(pending.promise);
    await user.type(email(), "someone@example.com");
    await user.click(role("Engineer"));
    await user.click(addButton());

    expect(addButton().getAttribute("aria-disabled")).toBe("true");
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    await user.click(addButton());
    expect(added()).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    await waitFor(() => expect(email().value).toBe(""));
    expect(addButton().getAttribute("aria-disabled")).toBe("false");
  });
});
