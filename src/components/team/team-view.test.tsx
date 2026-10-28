// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, areasOf, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { deferred, mockConvex } from "@/test-support/convex";
import { NO_PAGES, pageNames } from "./page-checks";
import { TeamView } from "./team-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Made-up people at a reserved domain. `areas` is what `team.list` sends: the
// pages each can open, in the server's order.
const ADA = {
  id: "m1",
  email: "ada@example.com",
  role: "cofounder",
  companies: ["us", "kz"],
  areas: [...areasOf("cofounder")],
  addedAt: 1,
  name: "Ada Example",
  signedIn: true,
  self: false,
  editable: true,
};
// Pages of his own: not the Sales page his role starts with, and two it does not.
const BEN = {
  id: "m2",
  email: "ben@example.com",
  role: "sales",
  companies: ["kz"],
  areas: ["customers", "fundraising", "board"],
  addedAt: 2,
  name: null,
  signedIn: false,
  self: false,
  editable: true,
};
const CAL = {
  id: "m3",
  email: "cal@example.com",
  role: "engineer",
  companies: ["us"],
  areas: [],
  addedAt: 3,
  name: null,
  signedIn: true,
  self: false,
  editable: true,
};
const OWNER_EMAIL = "owner@example.com";
const OWNERS_ONLY =
  "The owner's own mail, calendar and meeting notes, and the work-tool settings, are the owner's only.";

let convex: ReturnType<typeof mockConvex>;
const as = (role: Role, children: ReactNode) => (
  <ViewerProvider
    viewer={{
      role,
      companies: ["us", "kz"],
      areas: role === "owner" ? AREAS : areasOf(role),
      email: role === "owner" ? OWNER_EMAIL : "member@example.com",
      name: role === "owner" ? "Olga Owner" : null,
    }}
  >
    {children}
  </ViewerProvider>
);
const page = () => as("owner", <TeamView />);
// The address is also in the hidden half of that row's button names.
// A person's group of rows: the one that is read and, under it, whatever is open for them.
const rowOf = (email: string) =>
  within(screen.getByText(email, { selector: "p" }).closest("tbody")!);
/** A person's row by its row header, as the text of its cells. */
const cellsOf = (email: string) =>
  within(screen.getByRole("rowheader", { name: new RegExp(email.replace(".", "\\.")) }).closest("tr")!)
    .getAllByRole("cell")
    .map((td) => td.textContent);
/** The pages a row says its person can open, as they read. */
const opens = (email: string) =>
  [...rowOf(email).getByRole("group", { name: "Pages they can open" }).children].map(
    (chip) => chip.textContent,
  );
const updated = () => convex.mutation(api.team.update);
const removed = () => convex.mutation(api.team.remove);

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
});
afterEach(cleanup);

describe("TeamView: the list", () => {
  test("the owner first, then each teammate with role, companies and whether they have signed in", () => {
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    expect(screen.getByRole("heading", { level: 1, name: "Team" })).toBeTruthy();

    const people = screen.getByRole("table", { name: "People" });
    expect(within(people).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Person",
      "Role",
      "Companies",
      "Pages",
      "Telegram",
      "Signed in",
      "Actions",
    ]);
    const rows = within(people)
      .getAllByRole("rowheader")
      .map((th) => th.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(OWNER_EMAIL);
    expect(rows[1]).toContain(ADA.email);
    expect(rows[2]).toContain(BEN.email);

    // Role, companies and whether they have signed in each have a column.
    const adaCells = cellsOf(ADA.email);
    expect(adaCells.slice(0, 2)).toEqual(["Co-founder", "Startup, Globex"]);
    expect(adaCells[4]).toBe("Yes");
    expect(adaCells[5]).toBe(`Edit ${ADA.email}Remove ${ADA.email}`);
    const benCells = cellsOf(BEN.email);
    expect(benCells.slice(0, 2)).toEqual(["Sales", "Globex"]);
    expect(benCells[4]).toBe("Not yet");

    const owner = rowOf(OWNER_EMAIL);
    expect(owner.getByText("Olga Owner")).toBeTruthy();
    expect(owner.getByText("Owner")).toBeTruthy();
    // Each company is a tag of its own; the cell still reads as the list.
    expect(cellsOf(OWNER_EMAIL)[1]).toBe("Startup, Globex");
    expect(owner.getByText("Startup").dataset.slot).toBe("kind-tag");
    expect(owner.getByText("Globex").dataset.slot).toBe("kind-tag");
    // The owner is set in the deployment, not here.
    expect(owner.queryByRole("button")).toBeNull();

    const ada = rowOf(ADA.email);
    expect(ada.getByText("Ada Example")).toBeTruthy();
    expect(ada.getByText("Co-founder")).toBeTruthy();
    expect(ada.getByText("Startup")).toBeTruthy();
    expect(ada.getByText("Globex")).toBeTruthy();
    expect(ada.queryByText("Not yet")).toBeNull();

    const ben = rowOf(BEN.email);
    expect(ben.getByText("Sales")).toBeTruthy();
    expect(ben.getByText("Globex")).toBeTruthy();
    expect(ben.getByText("Not yet")).toBeTruthy();
  });

  test("each teammate's row lists the pages that person can open, in the navigation's order", () => {
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    expect(opens(ADA.email)).toEqual(pageNames(areasOf("cofounder")));
    // His own, not a sales person's usual ones.
    expect(opens(BEN.email)).toEqual(["Board", "Fundraising", "Customers"]);
    expect(rowOf(ADA.email).queryByText(/^Empty for someone/)).toBeNull();
  });

  test("a ticked page that is empty for the person's companies is said on their row", () => {
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    expect(
      rowOf(BEN.email).getByText(
        "Empty for someone on Globex only: Fundraising.",
      ),
    ).toBeTruthy();
  });

  test("a teammate with no pages is listed with a line saying what they see", () => {
    convex.setQuery(api.team.list, [CAL]);
    render(page());
    expect(rowOf(CAL.email).queryByRole("group", { name: "Pages they can open" })).toBeNull();
    expect(rowOf(CAL.email).getByText(NO_PAGES)).toBeTruthy();
  });

  test("the owner's row lists no pages: every page, and what stays the owner's alone", () => {
    convex.setQuery(api.team.list, [ADA]);
    render(page());
    const owner = rowOf(OWNER_EMAIL);
    expect(owner.queryByRole("group", { name: "Pages they can open" })).toBeNull();
    expect(owner.getByText(`Every page. ${OWNERS_ONLY}`)).toBeTruthy();
    expect(
      owner.getByText("You. The owner is set in the deployment and cannot be changed here."),
    ).toBeTruthy();
  });

  test("the page explains that pages are picked per person, and shows no fixed table by role", () => {
    convex.setQuery(api.team.list, [ADA]);
    render(page());
    expect(screen.queryByRole("heading", { name: "What each role can open" })).toBeNull();
    const how = screen.getByRole("region", { name: "How access works" });
    expect(within(how).getByText(/You pick, for each teammate, the pages they can open/)).toBeTruthy();
    expect(within(how).queryAllByRole("listitem")).toEqual([]);
  });

  test("with no teammates it says so, under the owner's row", () => {
    convex.setQuery(api.team.list, []);
    render(page());
    expect(rowOf(OWNER_EMAIL).getByText("Owner")).toBeTruthy();
    expect(screen.getByText("No teammates yet. Add the first one below.")).toBeTruthy();
  });

  test("while the list is loading it does not claim there is nobody", () => {
    render(page());
    expect(screen.queryByText(/No teammates yet/)).toBeNull();
  });
});

describe("TeamView: changing a teammate", () => {
  const openEditor = async (user: ReturnType<typeof userEvent.setup>, email: string) => {
    await user.click(rowOf(email).getByRole("button", { name: `Edit ${email}` }));
    return {
      role: () => rowOf(email).getByLabelText("Role") as HTMLSelectElement,
      company: (name: string) => rowOf(email).getByRole("checkbox", { name }) as HTMLInputElement,
      page: (name: string) =>
        within(rowOf(email).getByRole("group", { name: "Pages" })).getByRole("checkbox", {
          name,
        }) as HTMLInputElement,
      /** The names of the ticked pages, in the order shown. */
      ticked: () =>
        (
          within(rowOf(email).getByRole("group", { name: "Pages" })).getAllByRole(
            "checkbox",
          ) as HTMLInputElement[]
        )
          .filter((box) => box.checked)
          .map((box) => box.labels?.[0]?.textContent),
      save: () => rowOf(email).getByRole("button", { name: "Save" }),
    };
  };

  test("the editor opens on the person's own pages, not their role's", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    expect(editor.role().value).toBe("sales");
    expect(editor.ticked()).toEqual(["Board", "Fundraising", "Customers"]);
    expect(rowOf(BEN.email).queryByRole("checkbox", { name: /Team, sources/ })).toBeNull();
    expect(rowOf(BEN.email).queryByRole("checkbox", { name: /Work tools/ })).toBeNull();
    // Today can be ticked for anyone, and is not ticked until the owner does.
    const today = rowOf(BEN.email).getByRole("checkbox", { name: /^Today/ }) as HTMLInputElement;
    expect(today.checked).toBe(false);
  });

  test("the draft survives a live update, and Save sends role, companies and pages", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA, BEN]);
    const view = render(page());
    const editor = await openEditor(user, BEN.email);
    expect(editor.role().value).toBe("sales");
    expect(editor.company("Startup").checked).toBe(false);
    expect(editor.company("Globex").checked).toBe(true);

    await user.selectOptions(editor.role(), "engineer");
    await user.click(editor.page("Finance"));
    await user.click(editor.company("Startup"));
    // Someone else's change to the same row arrives while the editor is open.
    convex.setQuery(api.team.list, [
      ADA,
      { ...BEN, role: "cofounder", companies: ["us"], areas: ["scorecard"] },
    ]);
    view.rerender(page());
    expect(editor.role().value).toBe("engineer");
    expect(editor.ticked()).toEqual(["Board", "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents", "Finance", "Product", "Engineering: pull requests, who owns them and what is stuck"]);
    expect(editor.company("Startup").checked).toBe(true);
    expect(editor.company("Globex").checked).toBe(true);

    await user.click(editor.save());
    expect(updated()).toHaveBeenCalledTimes(1);
    expect(updated()).toHaveBeenCalledWith({
      id: "m2",
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["finance", "product", "engineering", "board", "agents"],
    });
    // Saved: the editor closes and the row shows what the server says.
    await waitFor(() => expect(rowOf(BEN.email).queryByLabelText("Role")).toBeNull());
    expect(document.activeElement).toBe(
      rowOf(BEN.email).getByRole("button", { name: `Edit ${BEN.email}` }),
    );
  });

  test("choosing a role sets the pages to that role's; ticking afterwards leaves the role alone", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    await user.selectOptions(editor.role(), "cofounder");
    expect(editor.ticked()).toEqual(pageNames(areasOf("cofounder")));
    await user.selectOptions(editor.role(), "engineer");
    expect(editor.ticked()).toEqual(["Board", "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents", "Product", "Engineering: pull requests, who owns them and what is stuck"]);
    await user.click(editor.page("Sales"));
    await user.click(editor.page("Board"));
    expect(editor.role().value).toBe("engineer");
    await user.click(editor.save());
    expect(updated()).toHaveBeenCalledWith({
      id: "m2",
      role: "engineer",
      companies: ["kz"],
      areas: ["product", "engineering", "sales", "agents"],
    });
  });

  test("changing pages alone keeps the role, and sends the list in the server's order", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    await user.click(editor.page("Go to market"));
    await user.click(editor.page("Today: the company's numbers and health"));
    await user.click(editor.page("Customers"));
    await user.click(editor.save());
    expect(updated()).toHaveBeenCalledWith({
      id: "m2",
      role: "sales",
      companies: ["kz"],
      areas: ["scorecard", "fundraising", "gtm", "board"],
    });
  });

  test("with every page unticked it says what the person will see, and saves the empty list", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    const form = () => within(rowOf(BEN.email).getByRole("button", { name: "Save" }).closest("form")!);
    expect(form().queryByText(NO_PAGES)).toBeNull();
    for (const name of ["Board", "Fundraising", "Customers"]) {
      await user.click(editor.page(name));
    }
    expect(form().getByText(NO_PAGES)).toBeTruthy();
    await user.click(editor.save());
    expect(rowOf(BEN.email).queryByRole("alert")).toBeNull();
    expect(updated()).toHaveBeenCalledWith({ id: "m2", role: "sales", companies: ["kz"], areas: [] });
  });

  test("the editor's note about empty pages follows the draft's companies, not the saved ones", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    const form = () => within(rowOf(BEN.email).getByRole("button", { name: "Save" }).closest("form")!);
    expect(form().getByText(/^Empty for someone on Globex only: Fundraising/)).toBeTruthy();
    await user.click(editor.company("Startup"));
    expect(form().queryByText(/^Empty for someone/)).toBeNull();
  });

  test("the editor offers the three member roles and never the owner's", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA]);
    render(page());
    const editor = await openEditor(user, ADA.email);
    expect([...editor.role().options].map((o) => o.textContent)).toEqual([
      "Co-founder",
      "Sales",
      "Engineer",
    ]);
  });

  test("with no company ticked nothing is sent, in the server's own sentence", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    await user.click(editor.company("Globex"));
    await user.click(editor.save());
    expect(updated()).not.toHaveBeenCalled();
    expect(rowOf(BEN.email).getByRole("alert").textContent).toBe("Pick at least one company.");
  });

  test("a refused change is shown and the draft is kept", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    updated().mockRejectedValueOnce(new ConvexError("That person is no longer on the team."));
    const editor = await openEditor(user, BEN.email);
    await user.selectOptions(editor.role(), "engineer");
    await user.click(editor.save());
    expect((await rowOf(BEN.email).findByRole("alert")).textContent).toBe(
      "That person is no longer on the team.",
    );
    expect(editor.role().value).toBe("engineer");
  });

  test("Cancel sends nothing and drops the draft", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    const editor = await openEditor(user, BEN.email);
    await user.selectOptions(editor.role(), "engineer");
    await user.click(rowOf(BEN.email).getByRole("button", { name: "Cancel" }));
    expect(updated()).not.toHaveBeenCalled();
    expect(rowOf(BEN.email).queryByLabelText("Role")).toBeNull();
    expect(rowOf(BEN.email).getByText("Sales")).toBeTruthy();
  });

  test("Save is aria-disabled, not disabled, while the request is out and sends once", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    convex.setQuery(api.team.list, [BEN]);
    render(page());
    updated().mockReturnValueOnce(pending.promise);
    const editor = await openEditor(user, BEN.email);
    await user.click(editor.save());
    expect(editor.save().getAttribute("aria-disabled")).toBe("true");
    expect((editor.save() as HTMLButtonElement).disabled).toBe(false);
    await user.click(editor.save());
    expect(updated()).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    await waitFor(() => expect(rowOf(BEN.email).queryByLabelText("Role")).toBeNull());
  });
});

describe("TeamView: removing a teammate", () => {
  const WARNING =
    "Remove this person? Their open sessions end at once, and their tasks stay assigned to a removed teammate.";

  test("asks first, saying what happens, and Keep removes nobody", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    await user.click(rowOf(ADA.email).getByRole("button", { name: `Remove ${ADA.email}` }));
    expect(removed()).not.toHaveBeenCalled();
    expect(rowOf(ADA.email).getByText(WARNING)).toBeTruthy();
    // Only the row asked about is asking.
    expect(screen.getAllByText(WARNING)).toHaveLength(1);

    await user.click(rowOf(ADA.email).getByRole("button", { name: "Keep" }));
    expect(removed()).not.toHaveBeenCalled();
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  test("confirming calls team.remove for that teammate, once", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    removed().mockReturnValueOnce(pending.promise);
    await user.click(rowOf(ADA.email).getByRole("button", { name: `Remove ${ADA.email}` }));
    const confirm = () => rowOf(ADA.email).getByRole("button", { name: "Remove from the team" });
    await user.click(confirm());
    expect(confirm().getAttribute("aria-disabled")).toBe("true");
    await user.click(confirm());
    expect(removed()).toHaveBeenCalledTimes(1);
    expect(removed()).toHaveBeenCalledWith({ id: "m1" });
    pending.resolve(null);
  });

  test("a removal that fails is shown on that row", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(page());
    removed().mockRejectedValueOnce(new Error("network"));
    await user.click(rowOf(ADA.email).getByRole("button", { name: `Remove ${ADA.email}` }));
    await user.click(rowOf(ADA.email).getByRole("button", { name: "Remove from the team" }));
    expect((await rowOf(ADA.email).findByRole("alert")).textContent).toBe(
      "That person could not be removed. Try again.",
    );
    expect(rowOf(BEN.email).queryByRole("alert")).toBeNull();
  });
});

// What a teammate who was given the Team page sees is in team-sensitive.test.tsx.
describe("TeamView: someone without the Team page", () => {
  test.each(["cofounder", "sales", "engineer"] as const)(
    "a %s, whose role does not start with it, is told who manages the team, and no query is sent",
    (role) => {
      convex.setQuery(api.team.list, [ADA, BEN]);
      render(as(role, <TeamView />));
      expect(
        screen.getByText("Only the owner, and people the owner gives the Team page, manage the team."),
      ).toBeTruthy();
      expect(screen.queryByText(ADA.email)).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      const sent = vi.mocked(useQuery).mock.calls.filter(([, args]) => args !== "skip");
      expect(sent).toEqual([]);
    },
  );

  test("the owner's page does send it", () => {
    convex.setQuery(api.team.list, []);
    render(page());
    const sent = vi.mocked(useQuery).mock.calls.filter(([, args]) => args !== "skip");
    expect(sent.length).toBeGreaterThan(0);
  });
});
