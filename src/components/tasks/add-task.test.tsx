// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { deferred, mockConvex } from "@/test-support/convex";
import { AddTask, AddTaskForm } from "./add-task";
import { ASSIGNEE_NOT_ON_COMPANY } from "./assignee";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Every name and address here is made up. Ada is on both companies, Sam on
// Globex alone.
const PEOPLE = [
  { email: "ada@example.com", name: "Ada Example", companies: ["us", "kz"] },
  { email: "sam@example.com", name: null, companies: ["kz"] },
];

let convex: ReturnType<typeof mockConvex>;
/** The arguments `team.assignable` was asked with, in order. */
let asked: unknown[];
beforeEach(() => {
  convex = mockConvex();
  asked = [];
  convex.setQueryBy(api.team.assignable, (args) => {
    asked.push(args);
    const company = (args as { company?: string }).company;
    return PEOPLE.filter((p) => company === undefined || p.companies.includes(company)).map(
      ({ email, name }) => ({ email, name }),
    );
  });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const member = (companies: ViewerProfile["companies"]): ViewerProfile => ({
  role: "engineer",
  companies,
  areas: ["product", "board"],
  email: "sam@example.com",
  name: null,
});

const open = async (
  user: ReturnType<typeof userEvent.setup>,
  { viewer, companyInView, assignToMe }: {
    viewer?: ViewerProfile;
    companyInView?: "us" | "kz";
    assignToMe?: boolean;
  } = {},
) => {
  let tree = <AddTask column="backlog" columnTitle="Backlog" assignToMe={assignToMe} />;
  if (companyInView) {
    window.localStorage.setItem("startup-os:company", companyInView);
    tree = <CompanyProvider>{tree}</CompanyProvider>;
  }
  if (viewer) tree = <ViewerProvider viewer={viewer}>{tree}</ViewerProvider>;
  render(tree);
  await user.click(screen.getByRole("button", { name: "Add a card" }));
  return screen.getByLabelText("New card in Backlog") as HTMLInputElement;
};

const assignee = () => screen.getByLabelText("Assignee") as HTMLSelectElement;
const company = () => screen.getByLabelText("Company") as HTMLSelectElement;
const optionsOf = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);

describe("AddTask", () => {
  test("adds a card and is ready for the next one", async () => {
    const user = userEvent.setup();
    const input = await open(user);
    await user.type(input, "Send the deck{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith({
      title: "Send the deck",
      column: "backlog",
      kind: "task",
      assignee: null,
      company: null,
      duplicates: "warn",
    });
    expect(input.value).toBe("");
  });

  test("what is typed for the next card while the last one is saving is kept", async () => {
    // Adding several cards in a row is the usual case. Clearing the field
    // when the save lands would erase whatever was typed in the meantime.
    const user = userEvent.setup();
    const gate = deferred();
    convex.mutation(api.tasks.create).mockReturnValue(gate.promise);
    const input = await open(user);
    await user.type(input, "First{Enter}");
    await user.type(input, "Second");
    gate.resolve(null);
    await waitFor(() => expect(input.value).toBe("Second"));
  });

  test("a failed add puts the title back and says why", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.tasks.create)
      .mockRejectedValue(new ConvexError("That title is too long (200 characters at most)."));
    const input = await open(user);
    await user.type(input, "Far too long{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("too long");
    expect(input.value).toBe("Far too long");
  });

  test("the issue tick resets after each card, so the next is not an issue by accident", async () => {
    const user = userEvent.setup();
    const input = await open(user);
    await user.click(screen.getByLabelText("It's a problem"));
    await user.type(input, "Payment overdue{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "issue" }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("It's a problem") as HTMLInputElement).checked).toBe(false),
    );
  });

  test("Escape closes the form and returns focus to the add button", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.keyboard("{Escape}");
    const button = screen.getByRole("button", { name: "Add a card" });
    expect(document.activeElement).toBe(button);
  });
});

describe("AddTask: a card near one already open", () => {
  const warned = () =>
    new ConvexError({
      words: "This may repeat a card already open on the board.",
      refusal: { code: "possible_duplicate", matches: [{ id: "t1", title: "Send the pitch deck" }] },
    });

  test("names the open card and adds nothing until Add anyway, which adds it as confirmed", async () => {
    const user = userEvent.setup();
    convex.mutation(api.tasks.create).mockRejectedValueOnce(warned());
    const input = await open(user);
    await user.type(input, "Send the deck{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Possible duplicate of “Send the pitch deck”");
    await user.click(screen.getByRole("button", { name: "Add anyway" }));
    expect(convex.mutation(api.tasks.create)).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Send the deck", duplicates: "confirmed" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("Don't add drops it, and the title is given back to change", async () => {
    const user = userEvent.setup();
    convex.mutation(api.tasks.create).mockRejectedValueOnce(warned());
    const input = await open(user);
    await user.type(input, "Send the deck{Enter}");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Don't add" }));
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("Send the deck");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AddTaskForm: at the top of a column", () => {
  test("is open at once, and a card it adds goes first in the column", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AddTaskForm column="doing" columnTitle="Doing" atTop onClose={onClose} />);
    const input = screen.getByLabelText("New card in Doing") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await user.type(input, "Ship it{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith({
      title: "Ship it",
      column: "doing",
      kind: "task",
      assignee: null,
      company: null,
      index: 0,
      duplicates: "warn",
    });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AddTask: who the card is for", () => {
  test("nothing is asked of the team until the form is open", () => {
    render(<AddTask column="backlog" columnTitle="Backlog" />);
    expect(asked).toEqual([]);
  });

  test("the picker lists the people a shared task can go to, with Unassigned first", async () => {
    const user = userEvent.setup();
    await open(user);
    expect(asked.at(-1)).toEqual({});
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam"]);
    expect(assignee().value).toBe("");
  });

  test("the person picked is saved by address", async () => {
    const user = userEvent.setup();
    const input = await open(user);
    await user.selectOptions(assignee(), "Ada Example");
    await user.type(input, "Send the deck{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: "ada@example.com" }),
    );
  });

  test("opened under Mine, the card starts assigned to the viewer", async () => {
    const user = userEvent.setup();
    const input = await open(user, { viewer: member(["kz"]), assignToMe: true });
    expect(assignee().value).toBe("sam@example.com");
    await user.type(input, "Fix the build{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: "sam@example.com" }),
    );
  });
});

describe("AddTask: the card's company", () => {
  test("a viewer with both companies picks one, or both", async () => {
    const user = userEvent.setup();
    await open(user);
    expect(optionsOf(company())).toEqual(["Both companies", "Startup", "Globex"]);
    expect(company().value).toBe("");
  });

  test("with a company in view there is no picker: the card is that company's, and its people are listed", async () => {
    const user = userEvent.setup();
    const input = await open(user, { companyInView: "kz" });
    // The switch has already said whose task this is.
    expect(screen.queryByLabelText("Company")).toBeNull();
    expect(asked.at(-1)).toEqual({ company: "kz" });
    await user.type(input, "Call the lab{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ company: "kz" }),
    );
  });

  test("changing the company reads that company's people", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.selectOptions(company(), "Startup");
    expect(asked.at(-1)).toEqual({ company: "us" });
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example"]);
  });

  test("a viewer with one company gets no picker, and the card takes that company", async () => {
    const user = userEvent.setup();
    const input = await open(user, { viewer: member(["kz"]) });
    expect(screen.queryByLabelText("Company")).toBeNull();
    expect(asked.at(-1)).toEqual({ company: "kz" });
    await user.type(input, "Fix the build{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith({
      title: "Fix the build",
      column: "backlog",
      kind: "task",
      assignee: null,
      company: "kz",
      duplicates: "warn",
    });
  });

  test("a person who is not on the company picked is flagged, and the card is not added", async () => {
    const user = userEvent.setup();
    const input = await open(user);
    await user.selectOptions(company(), "Globex");
    await user.selectOptions(assignee(), "sam");
    await user.selectOptions(company(), "Startup");
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam (not on Startup)"]);
    expect(assignee().value).toBe("sam@example.com");
    await user.type(input, "Call the lab{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(ASSIGNEE_NOT_ON_COMPANY);
    expect(convex.mutation(api.tasks.create)).not.toHaveBeenCalled();
    expect(input.value).toBe("Call the lab");

    // Unassigning is the way out the sentence names.
    await user.selectOptions(assignee(), "Unassigned");
    await user.type(input, "{Enter}");
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Call the lab", assignee: null, company: "us" }),
    );
  });
});
