// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, areasOf } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { localIsoDate } from "@/lib/dates";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { AddTeammate } from "./add-teammate";
import { TeamView } from "./team-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Each person's Telegram username on the team page: a column the owner reads
// and a field the owner types.

const ADA = {
  id: "m1",
  email: "ada@example.com",
  role: "cofounder",
  companies: ["us", "kz"],
  areas: [...areasOf("cofounder")],
  addedAt: 1,
  name: "Ada Example",
  signedIn: true,
  telegram: "Ada_Example",
  self: false,
  editable: true,
};
const BEN = {
  id: "m2",
  email: "ben@example.com",
  role: "sales",
  companies: ["kz"],
  areas: ["board"],
  addedAt: 2,
  name: null,
  signedIn: false,
  telegram: null,
  self: false,
  editable: true,
};
const NOT_A_USERNAME = "That is not a Telegram username: 5 to 32 letters, digits or underscores.";

let convex: ReturnType<typeof mockConvex>;
const page = () => (
  <ViewerProvider
    viewer={{
      role: "owner",
      companies: ["us", "kz"],
      areas: AREAS,
      email: "owner@example.com",
      name: "Olga Owner",
    }}
  >
    <TeamView />
  </ViewerProvider>
);
const rowOf = (email: string) =>
  within(screen.getByText(email, { selector: "p" }).closest("tbody")!);
// The people table's: the owner's page has a table of roles too.
const headers = () =>
  within(screen.getByRole("table", { name: "People" }))
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
/** What a person's row says in the column with a heading. */
const cell = (email: string, heading: string) => {
  const row = screen
    .getByRole("rowheader", { name: new RegExp(email.replace(".", "\\.")) })
    .closest("tr")!;
  return [...row.children][headers().indexOf(heading)] as HTMLElement;
};
const updated = () => convex.mutation(api.team.update);
const added = () => convex.mutation(api.team.add);

beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.team.list, [ADA, BEN]);
});
afterEach(cleanup);

describe("the Telegram column", () => {
  test("sits between Pages and Signed in", () => {
    render(page());
    expect(headers()).toEqual([
      "Person",
      "Role",
      "Companies",
      "Pages",
      "Telegram",
      "Signed in",
      "Actions",
    ]);
  });

  test("shows a username with its @, as typed, and says when there is none", () => {
    render(page());
    expect(within(cell(ADA.email, "Telegram")).getByText("@Ada_Example")).toBeTruthy();
    expect(cell(BEN.email, "Telegram").textContent).toBe("Not set");
  });

  test("the owner's own row shows the owner's username from the Telegram page", () => {
    convex.setQuery(api.telegram.settings, { mine: "Olga_Owner" });
    render(page());
    expect(within(cell("owner@example.com", "Telegram")).getByText("@Olga_Owner")).toBeTruthy();
  });

  test("with none, the owner's row says so: no link elsewhere, it is set in this row", () => {
    convex.setQuery(api.telegram.settings, { mine: null });
    render(page());
    expect(cell("owner@example.com", "Telegram").textContent).toBe("Not set");
    expect(within(cell("owner@example.com", "Telegram")).queryByRole("link")).toBeNull();
  });

  test("an editor opened under a row spans the whole table, the new column included", async () => {
    const user = userEvent.setup();
    render(page());
    await user.click(rowOf(BEN.email).getByRole("button", { name: /Edit/ }));
    const form = rowOf(BEN.email).getByLabelText("Role").closest("td")!;
    expect(form.getAttribute("colspan")).toBe(String(headers().length));
  });
});

describe("whether a username is linked to a Telegram account", () => {
  const AT = Date.UTC(2026, 9, 13, 12);
  const LINKED = { ...ADA, telegramLinked: true, telegramLinkedAt: AT };
  const resetOne = () => convex.mutation(api.team.resetTelegram);
  const resetMine = () => convex.mutation(api.telegram.resetMine);

  test("a username nobody has added a task under yet says so, and has nothing to reset", () => {
    convex.setQuery(api.team.list, [{ ...ADA, telegramLinked: false, telegramLinkedAt: null }, BEN]);
    render(page());
    const ada = within(cell(ADA.email, "Telegram"));
    expect(ada.getByText("Not used yet")).toBeTruthy();
    expect(ada.queryByRole("button")).toBeNull();
    // No username, nothing to say of a link.
    expect(cell(BEN.email, "Telegram").textContent).toBe("Not set");
  });

  test("a linked one says so with the date, and can be reset", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [LINKED, BEN]);
    render(page());
    const ada = within(cell(ADA.email, "Telegram"));
    expect(ada.getByText(`Linked ${localIsoDate(AT)}`)).toBeTruthy();
    await user.click(ada.getByRole("button", { name: `Reset link of ${ADA.email}` }));
    expect(resetOne()).toHaveBeenCalledWith({ id: "m1" });
    expect(updated()).not.toHaveBeenCalled();
  });

  test("the download says the username and the link, never the button that resets it", () => {
    convex.setQuery(api.team.list, [LINKED, BEN]);
    render(page());
    const rows = readTable(screen.getByRole("table", { name: "People" }));
    const telegram = rows[0]!.indexOf("Telegram");
    const ada = rows.find((cells) => cells[0]!.startsWith(ADA.email))!;
    expect(ada[telegram]).toBe(`@Ada_Example Linked ${localIsoDate(AT)}`);
  });

  test("a link from before dates were kept is linked, without one", () => {
    convex.setQuery(api.team.list, [{ ...LINKED, telegramLinkedAt: null }, BEN]);
    render(page());
    expect(within(cell(ADA.email, "Telegram")).getByText("Linked")).toBeTruthy();
  });

  test("a reset that is refused is said in the server's words", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [LINKED, BEN]);
    resetOne().mockRejectedValueOnce(new ConvexError("That person is no longer on the team."));
    render(page());
    const ada = within(cell(ADA.email, "Telegram"));
    await user.click(ada.getByRole("button", { name: /Reset link/ }));
    expect((await ada.findByRole("alert")).textContent).toBe("That person is no longer on the team.");
  });

  test("the owner's own row says the same of the owner's, and resets it on the Telegram page's function", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.telegram.settings, { mine: "Olga_Owner", mineLinked: true, mineLinkedAt: AT });
    render(page());
    const mine = within(cell("owner@example.com", "Telegram"));
    expect(mine.getByText(`Linked ${localIsoDate(AT)}`)).toBeTruthy();
    await user.click(mine.getByRole("button", { name: "Reset link of owner@example.com" }));
    expect(resetMine()).toHaveBeenCalledWith({});
    expect(resetOne()).not.toHaveBeenCalled();
  });

  test("the owner's own, never used", () => {
    convex.setQuery(api.telegram.settings, { mine: "Olga_Owner", mineLinked: false, mineLinkedAt: null });
    render(page());
    expect(within(cell("owner@example.com", "Telegram")).getByText("Not used yet")).toBeTruthy();
  });
});

describe("the editor's Telegram field", () => {
  const open = async (email: string) => {
    const user = userEvent.setup();
    const view = render(page());
    await user.click(rowOf(email).getByRole("button", { name: /Edit/ }));
    const field = rowOf(email).getByLabelText("Telegram username") as HTMLInputElement;
    const save = rowOf(email).getByRole("button", { name: "Save" });
    return { user, view, field, save };
  };

  test("starts with the username on record, shown with its @", async () => {
    const { field } = await open(ADA.email);
    expect(field.value).toBe("@Ada_Example");
  });

  test("a new username is sent with the rest", async () => {
    const { user, field, save } = await open(BEN.email);
    await user.type(field, "@Ben_Example");
    await user.click(save);
    expect(updated()).toHaveBeenCalledWith({
      id: "m2",
      role: "sales",
      companies: ["kz"],
      areas: ["board"],
      telegram: "@Ben_Example",
    });
  });

  test("emptied, it is sent blank, which clears it", async () => {
    const { user, field, save } = await open(ADA.email);
    await user.clear(field);
    await user.click(save);
    expect(updated()).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", telegram: "" }));
  });

  test("left alone, it is not sent at all", async () => {
    const { user, save } = await open(ADA.email);
    await user.click(save);
    expect(updated()).toHaveBeenCalledTimes(1);
    expect("telegram" in (updated().mock.calls[0]![0] as object)).toBe(false);
  });

  test("what was typed outlives a live update to the row", async () => {
    const { user, view, field } = await open(BEN.email);
    await user.type(field, "Ben_Draft");
    convex.setQuery(api.team.list, [ADA, { ...BEN, telegram: "Someone_Else" }]);
    view.rerender(page());
    expect(field.value).toBe("Ben_Draft");
  });

  test("a refusal is shown in the server's words and the editor stays open with the draft", async () => {
    updated().mockRejectedValueOnce(new ConvexError(NOT_A_USERNAME));
    const { user, field, save } = await open(BEN.email);
    await user.type(field, "no");
    await user.click(save);
    expect((await rowOf(BEN.email).findByRole("alert")).textContent).toBe(NOT_A_USERNAME);
    expect(field.value).toBe("no");
  });
});

describe("the add form's Telegram field", () => {
  const fill = async () => {
    const user = userEvent.setup();
    render(<AddTeammate />);
    await user.type(screen.getByLabelText("Google account email"), "new.person@example.com");
    await user.click(screen.getByRole("radio", { name: "Sales" }));
    return { user, field: screen.getByLabelText(/Telegram username/) as HTMLInputElement };
  };
  const add = () => screen.getByRole("button", { name: "Add to the team" });

  test("is optional: left blank, nothing about Telegram is sent", async () => {
    const { user } = await fill();
    await user.click(add());
    expect(added()).toHaveBeenCalledTimes(1);
    expect("telegram" in (added().mock.calls[0]![0] as object)).toBe(false);
  });

  test("a username typed is sent, and the field is emptied once the person is added", async () => {
    const { user, field } = await fill();
    await user.type(field, "@New_Person");
    await user.click(add());
    expect(added()).toHaveBeenCalledWith(expect.objectContaining({ telegram: "@New_Person" }));
    await waitFor(() => expect(field.value).toBe(""));
  });

  test("a refusal keeps what was typed", async () => {
    added().mockRejectedValueOnce(new ConvexError(NOT_A_USERNAME));
    const { user, field } = await fill();
    await user.type(field, "x y");
    await user.click(add());
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_A_USERNAME);
    expect(field.value).toBe("x y");
  });
});

describe("the owner's own row: both usernames are set here, and only here", () => {
  const setMine = () => convex.mutation(api.telegram.setMine);
  const setGithub = () => convex.mutation(api.team.setMyGithub);
  const open = async () => {
    const user = userEvent.setup();
    convex.setQuery(api.telegram.settings, { mine: "Olga_Owner" });
    convex.setQuery(api.team.myGithub, { login: "olga-gh" });
    render(page());
    await user.click(rowOf("owner@example.com").getByRole("button", { name: /Edit your usernames/ }));
    const owner = rowOf("owner@example.com");
    return {
      user,
      owner,
      telegram: owner.getByLabelText("Telegram username") as HTMLInputElement,
      github: owner.getByLabelText("GitHub username") as HTMLInputElement,
      save: owner.getByRole("button", { name: "Save" }),
    };
  };

  test("the editor starts with both on record, with their @", async () => {
    const { telegram, github } = await open();
    expect(telegram.value).toBe("@Olga_Owner");
    expect(github.value).toBe("@olga-gh");
    // No second editor for the owner's GitHub username under the table.
    expect(screen.queryByLabelText("Your GitHub username")).toBeNull();
  });

  test("only what changed is sent, each to its own function", async () => {
    const { user, telegram, save } = await open();
    await user.clear(telegram);
    await user.type(telegram, "@Olga_New");
    await user.click(save);
    expect(setMine()).toHaveBeenCalledWith({ telegram: "@Olga_New" });
    expect(setGithub()).not.toHaveBeenCalled();
  });

  test("a GitHub change alone goes to the GitHub function", async () => {
    const { user, github, save } = await open();
    await user.clear(github);
    await user.type(github, "olga-new");
    await user.click(save);
    expect(setGithub()).toHaveBeenCalledWith({ github: "olga-new" });
    expect(setMine()).not.toHaveBeenCalled();
  });

  test("a refusal is shown in the server's words and the editor keeps the draft", async () => {
    setMine().mockRejectedValueOnce(new ConvexError(NOT_A_USERNAME));
    const { user, telegram, save, owner } = await open();
    await user.clear(telegram);
    await user.type(telegram, "x y");
    await user.click(save);
    expect((await owner.findByRole("alert")).textContent).toBe(NOT_A_USERNAME);
    expect(telegram.value).toBe("x y");
  });
});
