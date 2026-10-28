// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, type Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { mockConvex } from "@/test-support/convex";
import { AddTeammate } from "./add-teammate";
import { TeamView } from "./team-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The two sensitive pages on the team page (Payroll and Costs have no box:
// they are the owner's alone): who holds them is seen at a
// glance, a role never ticks them, a teammate who was given Team manages
// people within their own companies, and the owner reads what they changed.

const person = (over: Record<string, unknown>) => ({
  id: "m1",
  email: "ada@example.com",
  role: "cofounder",
  companies: ["us", "kz"],
  areas: ["finance", "board"],
  addedAt: 1,
  name: null,
  signedIn: true,
  telegram: null,
  self: false,
  editable: true,
  ...over,
});
const ADA = person({ areas: ["finance", "board", "settings", "team"] });
const BEN = person({ id: "m2", email: "ben@example.com", role: "sales", companies: ["kz"] });
const MANAGER = "manager@example.com";
const ME = person({
  id: "m3",
  email: MANAGER,
  role: "engineer",
  companies: ["kz"],
  areas: ["team"],
  self: true,
  editable: false,
});
const BOTH = person({ id: "m4", email: "both@example.com", editable: false });

let convex: ReturnType<typeof mockConvex>;
const as = (
  viewer: { role: "owner" | "engineer"; areas: readonly Area[]; companies: CompanyId[]; email: string },
  children: React.ReactNode,
) => <ViewerProvider viewer={{ ...viewer, name: null }}>{children}</ViewerProvider>;
const owner = { role: "owner", areas: AREAS, companies: ["us", "kz"], email: "owner@example.com" } as const;
const manager = { role: "engineer", areas: ["team"], companies: ["kz"], email: MANAGER } as const;
const rowOf = (email: string) =>
  within(screen.getByText(email, { selector: "p" }).closest("tbody")!);
const asked = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([, args]) => args !== "skip")
    .map(([ref]) => getFunctionName(ref as never));

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  convex.setQuery(api.team.changes, { rows: [], next: null, widened: [] });
});
afterEach(cleanup);

describe("who holds a sensitive page", () => {
  test("is shown on their row with a warning chip of its own, apart from the ordinary pages", () => {
    convex.setQuery(api.team.list, [ADA, BEN]);
    render(as({ ...owner, companies: [...owner.companies] }, <TeamView />));
    const held = rowOf("ada@example.com").getByRole("group", { name: "Sensitive pages they hold" });
    const chips = [...held.querySelectorAll("[data-tone]")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Sources and Telegram", "Team"]);
    expect(chips.every((chip) => (chip as HTMLElement).dataset.tone === "warning")).toBe(true);
    // A colour is never the only sign: each chip has an icon beside its words.
    expect(chips.every((chip) => chip.querySelector("svg") !== null)).toBe(true);
    // The ordinary pages are listed as before, without them.
    const pages = rowOf("ada@example.com").getByRole("group", { name: "Pages they can open" });
    expect([...pages.children].map((chip) => chip.textContent)).toEqual(["Board", "Finance"]);
  });

  test("someone with none has no such group", () => {
    convex.setQuery(api.team.list, [BEN]);
    render(as({ ...owner, companies: [...owner.companies] }, <TeamView />));
    expect(rowOf("ben@example.com").queryByRole("group", { name: /Sensitive/ })).toBeNull();
  });

  test("someone with only sensitive pages is not said to have no pages", () => {
    convex.setQuery(api.team.list, [person({ areas: ["settings"] })]);
    render(as({ ...owner, companies: [...owner.companies] }, <TeamView />));
    const row = rowOf("ada@example.com");
    expect(row.getByRole("group", { name: "Sensitive pages they hold" })).toBeTruthy();
    expect(row.queryByRole("group", { name: "Pages they can open" })).toBeNull();
    expect(row.queryByText(/^No pages/)).toBeNull();
  });
});

describe("a role never ticks a sensitive page", () => {
  const sensitive = (name: string) =>
    within(screen.getByRole("group", { name: "Sensitive" })).getByRole("checkbox", {
      name,
    }) as HTMLInputElement;

  test("in the add form: choosing a role leaves both unticked, and unticks one ticked by hand", async () => {
    const user = userEvent.setup();
    render(as({ ...owner, companies: [...owner.companies] }, <AddTeammate />));
    await user.click(screen.getByRole("radio", { name: "Co-founder" }));
    for (const name of ["Sources and Telegram", "Team"]) {
      expect(sensitive(name).checked).toBe(false);
    }
    await user.click(sensitive("Sources and Telegram"));
    expect(sensitive("Sources and Telegram").checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Sales" }));
    expect(sensitive("Sources and Telegram").checked).toBe(false);
  });

  test("the add form offers no Payroll or Costs box, and says they are the owner's alone", () => {
    render(as({ ...owner, companies: [...owner.companies] }, <AddTeammate />));
    expect(screen.queryByRole("checkbox", { name: "Payroll" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^Costs/ })).toBeNull();
    expect(screen.getByText("Payroll and costs are the owner's alone.")).toBeTruthy();
  });

  test("a sensitive page ticked by hand is sent with the rest", async () => {
    const user = userEvent.setup();
    render(as({ ...owner, companies: [...owner.companies] }, <AddTeammate />));
    await user.type(screen.getByLabelText("Google account email"), "new@example.com");
    await user.click(screen.getByRole("radio", { name: "Engineer" }));
    await user.click(sensitive("Team"));
    await user.click(screen.getByRole("button", { name: "Add to the team" }));
    expect(convex.mutation(api.team.add)).toHaveBeenCalledWith({
      email: "new@example.com",
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["product", "engineering", "board", "agents", "team"],
    });
  });

  test("in the editor: it opens on what the person holds, and choosing a role unticks it", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ADA]);
    render(as({ ...owner, companies: [...owner.companies] }, <TeamView />));
    const row = rowOf("ada@example.com");
    await user.click(row.getByRole("button", { name: "Edit ada@example.com" }));
    const box = (name: string) =>
      within(row.getByRole("group", { name: "Sensitive" })).getByRole("checkbox", {
        name,
      }) as HTMLInputElement;
    expect([box("Sources and Telegram").checked, box("Team").checked]).toEqual([true, true]);
    await user.selectOptions(row.getByLabelText("Role"), "sales");
    expect([box("Sources and Telegram").checked, box("Team").checked]).toEqual([false, false]);
  });
});

describe("a teammate who was given the Team page", () => {
  const page = () => as({ ...manager, areas: [...manager.areas], companies: [...manager.companies] }, <TeamView />);

  test("reads the team, and is told what they can and cannot do here", () => {
    convex.setQuery(api.team.list, [BEN, BOTH, ME]);
    render(page());
    expect(screen.getByRole("table", { name: "People" })).toBeTruthy();
    const yours = screen.getByRole("region", { name: "What you can do here" });
    expect(
      within(yours).getByText(
        "The owner gave you this page. You can add people, choose their ordinary pages and remove them, for Globex.",
      ),
    ).toBeTruthy();
    expect(
      within(yours).getByText(
        "You cannot change or remove yourself. Only the owner can.",
      ),
    ).toBeTruthy();
    expect(
      within(yours).getByText(
        "Only the owner gives Sources and Telegram, or Team, and only the owner changes someone who manages the team. Payroll and costs are the owner's alone.",
      ),
    ).toBeTruthy();
    expect(
      within(yours).getByText(
        "The owner is not listed and cannot be changed here. What you change is recorded for the owner.",
      ),
    ).toBeTruthy();
  });

  test("their own row is marked and has no buttons; nor has someone on a company they are not on", () => {
    convex.setQuery(api.team.list, [BEN, BOTH, ME]);
    render(page());
    expect(rowOf(MANAGER).getByText("You.")).toBeTruthy();
    expect(rowOf(MANAGER).queryByRole("button")).toBeNull();
    expect(
      rowOf("both@example.com").getByText("Also on a company you are not on: not yours to change."),
    ).toBeTruthy();
    expect(rowOf("both@example.com").queryByRole("button")).toBeNull();
    // Someone on their own company alone is theirs to change.
    expect(rowOf("ben@example.com").getByRole("button", { name: "Edit ben@example.com" })).toBeTruthy();
    expect(rowOf("ben@example.com").getByRole("button", { name: "Remove ben@example.com" })).toBeTruthy();
  });

  test("someone else who manages the team is said to be the owner's to change, and has no buttons", () => {
    const other = person({ id: "m5", email: "other@example.com", companies: ["kz"], areas: ["team"], editable: false });
    convex.setQuery(api.team.list, [BEN, other, ME]);
    render(page());
    expect(rowOf("other@example.com").getByText("Manages the team: only the owner changes them.")).toBeTruthy();
    expect(rowOf("other@example.com").queryByRole("button")).toBeNull();
  });

  test("the editor shows the sensitive pages read-only, and sends them back as they were whatever role is chosen", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [person({ ...BEN, areas: ["sales", "settings"] }), ME]);
    render(page());
    await user.click(rowOf("ben@example.com").getByRole("button", { name: "Edit ben@example.com" }));
    const group = rowOf("ben@example.com").getByRole("group", { name: "Sensitive" });
    expect(within(group).getByText("Only the owner changes these.")).toBeTruthy();
    for (const box of within(group).getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
    // Choosing a role ticks its ordinary pages and leaves what the owner gave.
    await user.selectOptions(rowOf("ben@example.com").getByLabelText("Role"), "engineer");
    await user.click(rowOf("ben@example.com").getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.team.update)).toHaveBeenCalledWith(
      expect.objectContaining({ role: "engineer", areas: ["product", "engineering", "board", "agents", "settings"] }),
    );
  });

  test("the add form shows the sensitive pages read-only too", () => {
    convex.setQuery(api.team.list, [ME]);
    render(page());
    const add = screen.getByRole("region", { name: "Add a teammate" });
    const group = within(add).getByRole("group", { name: "Sensitive" });
    for (const box of within(group).getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
  });

  test("the Telegram column is read, not changed: the username and whether it is linked, with no reset and no field", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [
      person({ ...BEN, telegram: "Ben_Example", telegramLinked: true, telegramLinkedAt: null }),
      ME,
    ]);
    render(page());
    expect(rowOf("ben@example.com").getByText("@Ben_Example")).toBeTruthy();
    expect(rowOf("ben@example.com").getByText("Linked")).toBeTruthy();
    expect(rowOf("ben@example.com").queryByRole("button", { name: /Reset link/ })).toBeNull();
    await user.click(rowOf("ben@example.com").getByRole("button", { name: "Edit ben@example.com" }));
    expect(rowOf("ben@example.com").queryByLabelText("Telegram username")).toBeNull();
    expect(
      rowOf("ben@example.com").getByText("Only the owner sets or resets a Telegram username."),
    ).toBeTruthy();
    await user.click(rowOf("ben@example.com").getByRole("button", { name: "Save" }));
    expect("telegram" in (convex.mutation(api.team.update).mock.calls[0]![0] as object)).toBe(false);
    // Nor when adding someone.
    const add = screen.getByRole("region", { name: "Add a teammate" });
    expect(within(add).queryByLabelText(/Telegram username/)).toBeNull();
  });

  test("the owner has no row, and nothing that is the owner's alone is asked for", () => {
    convex.setQuery(api.team.list, [BEN, ME]);
    render(page());
    expect(screen.queryByText(/The owner is set in the deployment/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Recent changes" })).toBeNull();
    // The roles are theirs to read: they give a person one that exists.
    expect(asked()).toEqual(["team:list", "roles:list"]);
  });

  test("offers only their own companies, when adding and when changing someone", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [BEN, ME]);
    render(page());
    const add = screen.getByRole("region", { name: "Add a teammate" });
    const companies = within(add).getByRole("group", { name: "Companies" });
    expect(within(companies).getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual([
      "Globex",
    ]);
    await user.click(rowOf("ben@example.com").getByRole("button", { name: "Edit ben@example.com" }));
    const editing = rowOf("ben@example.com").getByRole("group", { name: "Companies" });
    expect(within(editing).getAllByRole("checkbox")).toHaveLength(1);
  });

  test("adding sends their own company, never one they are not on", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, [ME]);
    render(page());
    await user.type(screen.getByLabelText("Google account email"), "new@example.com");
    await user.click(screen.getByRole("radio", { name: "Engineer" }));
    await user.click(screen.getByRole("button", { name: "Add to the team" }));
    expect(convex.mutation(api.team.add)).toHaveBeenCalledWith(
      expect.objectContaining({ companies: ["kz"] }),
    );
  });
});

describe("someone without the Team page", () => {
  test("is told who manages the team, and nothing is asked for", () => {
    convex.setQuery(api.team.list, [ADA]);
    render(
      as(
        { role: "engineer", areas: ["payroll", "settings", "board"], companies: ["kz"], email: MANAGER },
        <TeamView />,
      ),
    );
    expect(
      screen.getByText("Only the owner, and people the owner gives the Team page, manage the team."),
    ).toBeTruthy();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(asked()).toEqual([]);
  });
});

describe("the owner's record of what managers changed", () => {
  const page = () => as({ ...owner, companies: [...owner.companies] }, <TeamView />);
  const AT = Date.UTC(2026, 9, 13, 12, 0, 0);

  test("with none, says what will appear there", () => {
    convex.setQuery(api.team.list, []);
    render(page());
    const recent = screen.getByRole("region", { name: "Recent changes" });
    expect(
      within(recent).getByText(
        "Nothing yet. What someone you gave the Team page adds, changes or removes is listed here. Your own changes are listed only where you gave someone a sensitive page or put them on another company.",
      ),
    ).toBeTruthy();
    expect(asked()).toContain("team:changes");
  });

  test("each change: who, what, whom, when, and what they had before and after", () => {
    convex.setQuery(api.team.list, []);
    convex.setQuery(api.team.changes, { next: null, widened: [], rows: [
      {
        id: "c2",
        at: AT,
        kind: "update",
        actor: { email: "manager@example.com", name: "Mona Manager" },
        person: { email: "ben@example.com", name: null },
        before: { role: "sales", roleName: "Sales", companies: ["kz"], areas: ["sales"] },
        after: { role: "sales", roleName: "Sales", companies: ["kz"], areas: ["sales", "payroll", "team"] },
        telegramChanged: true,
      },
      {
        id: "c1",
        at: AT,
        kind: "remove",
        actor: null,
        person: null,
        before: { role: "engineer", roleName: "Engineer", companies: ["us", "kz"], areas: [] },
        after: null,
        telegramChanged: false,
      },
    ] });
    render(page());
    const items = within(screen.getByRole("region", { name: "Recent changes" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Mona Manager (manager@example.com) changed ben@example.com")).toBeTruthy();
    expect(within(items[0]!).getByText("Before: Sales · Globex · Sales")).toBeTruthy();
    expect(
      within(items[0]!).getByText("After: Sales · Globex · Sales, Payroll (sensitive), Team (sensitive)"),
    ).toBeTruthy();
    expect(within(items[0]!).getByText("Their Telegram username was changed too.")).toBeTruthy();
    expect(within(items[0]!).getByText("2026-10-13")).toBeTruthy();
    // Someone who can no longer be named is said so, never left blank.
    expect(
      within(items[1]!).getByText("A removed teammate removed someone who had not signed in"),
    ).toBeTruthy();
    expect(within(items[1]!).getByText("Before: Engineer · Startup, Globex · no pages")).toBeTruthy();
    expect(within(items[1]!).queryByText(/^After:/)).toBeNull();
  });

  const change = (id: string, email: string, over: Record<string, unknown> = {}) => ({
    id,
    at: AT,
    kind: "update",
    actor: { email: "manager@example.com", name: null },
    person: { email, name: null },
    before: { role: "sales", roleName: "Sales", companies: ["kz"], areas: ["sales"] },
    after: { role: "sales", roleName: "Sales", companies: ["kz"], areas: ["board"] },
    telegramChanged: false,
    ...over,
  });

  test("Show more asks for the page before, and adds it under what is already shown", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.team.list, []);
    convex.setQueryBy(api.team.changes, (args) => {
      const before = (args as { before?: number }).before;
      if (before === undefined) return { rows: [change("c3", "newest@example.com")], next: 300, widened: [] };
      if (before === 300) return { rows: [change("c2", "middle@example.com")], next: 200, widened: [] };
      return { rows: [change("c1", "oldest@example.com")], next: null, widened: [] };
    });
    render(page());
    const recent = within(screen.getByRole("region", { name: "Recent changes" }));
    expect(recent.getAllByRole("listitem")).toHaveLength(1);
    await user.click(recent.getByRole("button", { name: "Show more" }));
    expect(recent.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("newest@example.com"),
      expect.stringContaining("middle@example.com"),
    ]);
    await user.click(recent.getByRole("button", { name: "Show more" }));
    expect(recent.getAllByRole("listitem")).toHaveLength(3);
    // At the end there is nothing more to ask for.
    expect(recent.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("with everything on one page there is no Show more", () => {
    convex.setQuery(api.team.list, []);
    convex.setQuery(api.team.changes, { rows: [change("c1", "ben@example.com")], next: null, widened: [] });
    render(page());
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("what gave someone a sensitive page or another company is kept in a list of its own, above the rest", () => {
    convex.setQuery(api.team.list, []);
    const given = change("c9", "ada@example.com", {
      actor: { email: "owner@example.com", name: null },
      after: { role: "sales", roleName: "Sales", companies: ["us", "kz"], areas: ["sales", "payroll"] },
    });
    convex.setQuery(api.team.changes, {
      rows: [change("c10", "ben@example.com")],
      next: null,
      widened: [given],
    });
    render(page());
    const region = screen.getByRole("region", { name: "Recent changes" });
    const kept = within(region).getByRole("list", { name: "Sensitive pages and companies given" });
    expect(within(kept).getAllByRole("listitem")).toHaveLength(1);
    expect(within(kept).getByText("owner@example.com changed ada@example.com")).toBeTruthy();
    expect(
      within(kept).getByText("After: Sales · Startup, Globex · Sales, Payroll (sensitive)"),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        "Kept here whatever their age, and however many changes came after: the latest twenty.",
      ),
    ).toBeTruthy();
    // It comes before the running list.
    const lists = within(region).getAllByRole("list");
    expect(lists[0]).toBe(kept);
  });
});
