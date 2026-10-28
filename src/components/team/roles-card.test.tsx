// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { SUGGESTED_ROLES } from "@convex/lib/roleRules";
import { AREAS, areasOf, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { AddTeammate } from "./add-teammate";
import { pageNames } from "./page-checks";
import { PRESET_NOTE, RolesCard } from "./roles-card";
import { TeamView } from "./team-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// What `roles.list` sends the owner: the three built in, then the owner's own.
const BUILT_IN = [
  { id: "cofounder", name: "Co-founder", focus: "founder", areas: [...areasOf("cofounder")], builtin: true, people: 1 },
  { id: "sales", name: "Sales", focus: "sales", areas: [...areasOf("sales")], builtin: true, people: 0 },
  { id: "engineer", name: "Engineer", focus: "engineering", areas: [...areasOf("engineer")], builtin: true, people: 2 },
];
const SUCCESS = {
  id: "r1",
  name: "Customer success",
  focus: "customers",
  areas: ["customers", "board"],
  builtin: false,
  people: 2,
};
const ADVISOR = { id: "r2", name: "Advisor", focus: "general", areas: [], builtin: false, people: 0 };
const ROLES = [...BUILT_IN, ADVISOR, SUCCESS];

const DEE = {
  id: "m4",
  email: "dee@example.com",
  role: "r1",
  roleName: "Customer success",
  focus: "customers",
  github: "dee-example",
  companies: ["us"],
  areas: ["customers"],
  addedAt: 4,
  name: null,
  signedIn: true,
  self: false,
  editable: true,
  telegram: null,
  telegramLinked: false,
  telegramLinkedAt: null,
};

let convex: ReturnType<typeof mockConvex>;
const as = (role: Role, children: React.ReactNode) => (
  <ViewerProvider
    viewer={{
      role,
      companies: ["us", "kz"],
      areas: role === "owner" ? AREAS : [...areasOf(role), "team"],
      email: "viewer@example.com",
      name: null,
    }}
  >
    {children}
  </ViewerProvider>
);
const rowOf = (name: string) =>
  within(screen.getByRole("rowheader", { name }).closest("tbody")!);
const ticked = (scope: { getAllByRole: (role: string) => HTMLElement[] }) =>
  scope
    .getAllByRole("checkbox")
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.closest("label")!.textContent);

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  convex.setQuery(api.roles.list, ROLES);
});
afterEach(cleanup);

describe("the Roles card", () => {
  test("each role with its focus, usual pages and how many people have it", () => {
    render(as("owner", <RolesCard />));
    const table = screen.getByRole("table", { name: "Roles" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Role",
      "Arranged for",
      "Usual pages",
      "People",
      "Actions",
    ]);
    const cells = (name: string) =>
      within(screen.getByRole("rowheader", { name }).closest("tr")!)
        .getAllByRole("cell")
        .map((td) => td.textContent);
    expect(cells("Customer success").slice(0, 3)).toEqual([
      "Customers",
      pageNames(["customers", "board"]).join(", "),
      "2",
    ]);
    expect(cells("Advisor").slice(0, 3)).toEqual(["General", "None", "0"]);
    expect(cells("Engineer")[0]).toBe("Engineering");
    expect(cells("Engineer")[2]).toBe("2");
  });

  test("a built-in role is said to be built in and has no buttons", () => {
    render(as("owner", <RolesCard />));
    for (const name of ["Co-founder", "Sales", "Engineer"]) {
      expect(rowOf(name).queryByRole("button")).toBeNull();
      expect(rowOf(name).getByText("Built in")).toBeTruthy();
    }
    expect(rowOf("Advisor").getByRole("button", { name: "Edit Advisor" })).toBeTruthy();
    expect(rowOf("Advisor").getByRole("button", { name: "Delete Advisor" })).toBeTruthy();
  });

  test("a name is rendered as text, never as markup", () => {
    convex.setQuery(api.roles.list, [{ ...ADVISOR, name: "<img src=x onerror=alert(1)>" }]);
    render(as("owner", <RolesCard />));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("rowheader", { name: "<img src=x onerror=alert(1)>" })).toBeTruthy();
  });

  test("adding: the suggested names are offered, and one fills the name, focus and pages", async () => {
    const user = userEvent.setup();
    render(as("owner", <RolesCard />));
    const form = within(screen.getByRole("form", { name: "Add a role" }));
    const offered = within(form.getByRole("group", { name: "Suggested names" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
    // Advisor and Customer success are already roles: not offered twice.
    expect(offered).toEqual(
      SUGGESTED_ROLES.map((role) => role.name).filter(
        (name) => name !== "Advisor" && name !== "Customer success",
      ),
    );
    // Nothing was created by offering them.
    expect(convex.mutation(api.roles.create)).not.toHaveBeenCalled();

    await user.click(form.getByRole("button", { name: "Marketing" }));
    expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("Marketing");
    expect((form.getByLabelText("Arranged for") as HTMLSelectElement).value).toBe("marketing");
    expect(ticked(form)).toEqual(pageNames(["scorecard", "marketing", "gtm", "board"]));

    await user.click(form.getByRole("button", { name: "Add role" }));
    expect(convex.mutation(api.roles.create)).toHaveBeenCalledWith({
      name: "Marketing",
      focus: "marketing",
      areas: ["scorecard", "marketing", "gtm", "board"],
    });
  });

  test("adding: the usual pages offer no sensitive page and no Today", () => {
    render(as("owner", <RolesCard />));
    const form = within(screen.getByRole("form", { name: "Add a role" }));
    const boxes = form.getAllByRole("checkbox").map((box) => box.closest("label")!.textContent);
    expect(boxes).toEqual(pageNames(areasOf("cofounder")));
    for (const never of ["Payroll", "Team", "Sources and Telegram"]) expect(boxes).not.toContain(never);
    expect(boxes.some((name) => name!.startsWith("Your day"))).toBe(false);
  });

  test("adding: what the server refuses is said, and what was typed is kept", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.roles.create)
      .mockRejectedValue(new ConvexError("There is already a role with that name."));
    render(as("owner", <RolesCard />));
    const form = within(screen.getByRole("form", { name: "Add a role" }));
    await user.type(form.getByLabelText("Name"), "Advisor");
    await user.click(form.getByRole("button", { name: "Add role" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "There is already a role with that name.",
    );
    expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("Advisor");
  });

  test("editing: rename, another focus and other pages, with what each change does said beside it", async () => {
    const user = userEvent.setup();
    render(as("owner", <RolesCard />));
    await user.click(rowOf("Customer success").getByRole("button", { name: "Edit Customer success" }));
    const editor = within(screen.getByRole("form", { name: "Edit Customer success" }));
    expect(editor.getByText(PRESET_NOTE)).toBeTruthy();
    expect(PRESET_NOTE).toBe(
      "Changing a role's usual pages changes nobody's access. They are what is ticked the next time the role is chosen.",
    );
    expect(
      editor.getByText("2 people have this role: their Dashboard and Today are rearranged at once."),
    ).toBeTruthy();
    expect(ticked(editor)).toEqual(pageNames(["customers", "board"]));

    const name = editor.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Clinic care");
    await user.selectOptions(editor.getByLabelText("Arranged for"), "sales");
    await user.click(editor.getByRole("checkbox", { name: "Sales" }));
    await user.click(editor.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.roles.update)).toHaveBeenCalledWith({
      id: "r1",
      name: "Clinic care",
      focus: "sales",
      areas: ["sales", "customers", "board"],
    });
  });

  test("deleting asks first, and a refusal is shown", async () => {
    const user = userEvent.setup();
    const remove = convex.mutation(api.roles.remove);
    render(as("owner", <RolesCard />));
    await user.click(rowOf("Advisor").getByRole("button", { name: "Delete Advisor" }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(rowOf("Advisor").getByRole("button", { name: "Keep" }));
    expect(remove).not.toHaveBeenCalled();

    remove.mockRejectedValue(
      new ConvexError("2 people have this role. Give them another role first."),
    );
    await user.click(rowOf("Customer success").getByRole("button", { name: "Delete Customer success" }));
    await user.click(rowOf("Customer success").getByRole("button", { name: "Delete role" }));
    expect(remove).toHaveBeenCalledWith({ id: "r1" });
    expect((await rowOf("Customer success").findByRole("alert")).textContent).toBe(
      "2 people have this role. Give them another role first.",
    );
  });
});

describe("the Team page and roles", () => {
  test("the owner has the Roles card; someone who manages the team does not", () => {
    convex.setQuery(api.team.list, []);
    const { unmount } = render(as("owner", <TeamView />));
    expect(screen.getByRole("heading", { level: 2, name: "Roles" })).toBeTruthy();
    unmount();
    render(as("engineer", <TeamView />));
    expect(screen.queryByRole("heading", { level: 2, name: "Roles" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a role" })).toBeNull();
    // They still pick among the roles that exist.
    expect(screen.getByRole("radio", { name: "Customer success" })).toBeTruthy();
  });

  test("a person's row wears their role's name, and their GitHub username", () => {
    convex.setQuery(api.team.list, [DEE]);
    render(as("owner", <TeamView />));
    const row = within(
      screen.getByRole("rowheader", { name: /dee@example\.com/ }).closest("tr")!,
    );
    expect(row.getAllByRole("cell")[0]!.textContent).toBe("Customer success");
    expect(row.getByText("GitHub: @dee-example")).toBeTruthy();
  });

  test("the editor lists every role, starts on the person's own and ticks a chosen role's usual pages", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [DEE]);
    render(as("owner", <TeamView />));
    await user.click(screen.getByRole("button", { name: "Edit dee@example.com" }));
    const select = screen.getByLabelText("Role") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Co-founder",
      "Sales",
      "Engineer",
      "Advisor",
      "Customer success",
    ]);
    expect(select.value).toBe("r1");
    await user.selectOptions(select, "r2");
    const editor = within(select.closest("form")!);
    await user.type(editor.getByLabelText("GitHub username"), "-2");
    await user.click(editor.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(convex.mutation(api.team.update)).toHaveBeenCalledWith({
        id: "m4",
        role: "r2",
        companies: ["us"],
        // Advisor's usual pages: none.
        areas: [],
        // As typed, with its @: the server cleans it.
        github: "@dee-example-2",
      }),
    );
  });

  test("a manager's editor has no GitHub field and sends none", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [DEE]);
    render(as("engineer", <TeamView />));
    await user.click(screen.getByRole("button", { name: "Edit dee@example.com" }));
    expect(screen.queryByLabelText("GitHub username")).toBeNull();
    expect(screen.getByText("Only the owner sets a GitHub username.")).toBeTruthy();
    await user.click(
      within(screen.getByLabelText("Role").closest("form")!).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(convex.mutation(api.team.update)).toHaveBeenCalled());
    expect(convex.mutation(api.team.update).mock.calls[0]![0]).not.toHaveProperty("github");
  });

  test("someone whose role was deleted reads “No role”, and the editor keeps it until another is chosen", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [{ ...DEE, role: "gone", roleName: "No role", focus: "general" }]);
    render(as("owner", <TeamView />));
    await user.click(screen.getByRole("button", { name: "Edit dee@example.com" }));
    const select = screen.getByLabelText("Role") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    expect(select.selectedOptions[0]!.textContent).toBe("No role");
  });
});

describe("adding a teammate with a named role", () => {
  test("the roles the owner named are offered beside the built-in ones; choosing one ticks its pages and sends its id", async () => {
    const user = userEvent.setup();
    render(as("owner", <AddTeammate />));
    const roles = within(screen.getByRole("group", { name: "Start from a role" }));
    expect(roles.getAllByRole("radio").map((radio) => radio.closest("label")!.textContent)).toEqual([
      "Co-founder",
      "Sales",
      "Engineer",
      "Advisor",
      "Customer success",
    ]);
    await user.type(screen.getByLabelText("Google account email"), "new@example.com");
    await user.click(roles.getByRole("radio", { name: "Customer success" }));
    const pages = within(screen.getByRole("group", { name: "Pages" }));
    expect(ticked(pages)).toEqual(pageNames(["customers", "board"]));
    await user.type(screen.getByLabelText("GitHub username"), "@new-person");
    await user.click(screen.getByRole("button", { name: "Add to the team" }));
    await waitFor(() =>
      expect(convex.mutation(api.team.add)).toHaveBeenCalledWith({
        email: "new@example.com",
        role: "r1",
        companies: ["us", "kz"],
        areas: ["customers", "board"],
        github: "@new-person",
      }),
    );
  });

  test("until the roles arrive, the three built-in ones are offered", () => {
    convex.setQuery(api.roles.list, undefined);
    render(as("owner", <AddTeammate />));
    expect(screen.getAllByRole("radio").map((radio) => radio.closest("label")!.textContent)).toEqual([
      "Co-founder",
      "Sales",
      "Engineer",
    ]);
  });
});
