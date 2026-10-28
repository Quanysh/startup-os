// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { dayLabel } from "@/lib/format";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { ContactsView } from "./contacts-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  name: "Jane Example",
  emails: ["jane@example.test"],
  phone: null,
  linkedin: null,
  org: "Initech Health",
  title: null,
  company: "us",
  category: "advisor",
  linkedRecords: [],
  howMet: null,
  introducedBy: null,
  introducedByName: null,
  canIntroTo: [],
  lastContactAt: null,
  interactionCount: 0,
  owner: "Dana",
  notes: null,
  ...over,
});

describe("ContactsView", () => {
  test("filters by category and opens a contact", async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    convex.setQueryBy(api.contacts.list, (args) => {
      seen.push(args);
      return { contacts: [row()], nextCursor: null, owners: ["Dana"] };
    });
    render(<ContactsView />);
    expect(screen.getByRole("table", { name: "Contacts" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Jane Example" })).toBeDefined();
    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "advisor");
    expect(seen.at(-1)).toMatchObject({ category: "advisor", limit: 50 });
    await user.type(screen.getByPlaceholderText("Name, email or organisation"), "initech");
    expect(seen.at(-1)).toMatchObject({ query: "initech", category: "advisor" });
    await user.click(screen.getByRole("button", { name: "Jane Example" }));
    expect(screen.getByRole("dialog", { name: "Jane Example" })).toBeDefined();
    expect(screen.getByRole("link", { name: "jane@example.test" })).toBeDefined();
  });

  test("shows the primary email and last contact, and names instead of ids", async () => {
    const user = userEvent.setup();
    const last = Date.UTC(2026, 9, 19);
    convex.setQueryBy(api.contacts.list, () => ({
      contacts: [
        row({
          id: "c-partner",
          name: "Example Partner B",
          emails: ["example.partner.b@example.com"],
        }),
        row({
          name: "Example Customer C",
          emails: ["example.customer.c@example.com"],
          introducedBy: "c-partner",
          introducedByName: "Example Partner B",
          linkedRecords: [{ type: "deal", id: "deal-raw-id", name: "Example Specialty Group" }],
          lastContactAt: last,
        }),
      ],
      nextCursor: null,
      owners: ["Dana"],
    }));
    convex.setQueryBy(api.contacts.get, () => row({ id: "c-partner", name: "Example Partner B" }));
    render(<ContactsView />);
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Last contact" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Owner" })).toBeDefined();
    expect(screen.getByText("example.customer.c@example.com")).toBeDefined();
    expect(screen.getByText(dayLabel("2026-10-19", Date.now()))).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Example Customer C" }));
    const panel = screen.getByRole("dialog", { name: "Example Customer C" });
    expect(panel.textContent).toContain("Deal · Example Specialty Group");
    expect(panel.textContent).not.toContain("deal-raw-id");
    await user.click(within(panel).getByRole("button", { name: "Example Partner B" }));
    expect(screen.getByRole("dialog", { name: "Example Partner B" })).toBeDefined();
  });

  test("below sm each contact is a card with no table, and nothing is offered for download", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    try {
      convex.setQueryBy(api.contacts.list, () => ({
        contacts: [row(), row({ id: "c2", name: "Ben Example", emails: [], org: null })],
        nextCursor: null,
        owners: [],
      }));
      render(<ContactsView />);
      expect(screen.queryByRole("table")).toBeNull();
      const cards = within(screen.getByRole("list", { name: "Contacts" })).getAllByRole("listitem");
      expect(cards).toHaveLength(2);
      for (const card of cards) expect(card.getAttribute("data-layout")).toBe("card");
      expect(cards[0]!.textContent).toContain("Initech Health");
      expect(cards[0]!.textContent).toContain("jane@example.test");
      expect(within(cards[0]!).getByRole("button", { name: "Jane Example" })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("the wide table offers no download: addresses do not leave the page as a file", () => {
    convex.setQueryBy(api.contacts.list, () => ({ contacts: [row()], nextCursor: null, owners: [] }));
    render(<ContactsView />);
    expect(screen.getByRole("table", { name: "Contacts" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });

  test("a linked record is unlinked only by someone who holds its page", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({
      contacts: [
        row({
          linkedRecords: [
            { type: "deal", id: "d1", name: null },
            { type: "partner", id: "p1", name: "Example Partner" },
          ],
        }),
      ],
      nextCursor: null,
      owners: [],
    }));
    render(
      <ViewerProvider
        viewer={{ role: "custom", companies: ["us"], areas: ["contacts", "partnerships"], email: "a@example.test", name: null }}
      >
        <ContactsView />
      </ViewerProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Jane Example" }));
    const panel = screen.getByRole("dialog", { name: "Jane Example" });
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Deal");
    expect(within(items[0]!).queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "Unlink" })).toBeDefined();
  });

  test("a Startup contact is offered Customer and never Clinic; a Globex one the other way", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({
      contacts: [row(), row({ id: "c2", name: "Kz Example", company: "kz" })],
      nextCursor: null,
      owners: [],
    }));
    render(<ContactsView />);
    const optionsOf = (name: string) =>
      within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);
    await user.click(screen.getByRole("button", { name: "Jane Example" }));
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(optionsOf("Contact category")).toContain("Customer");
    expect(optionsOf("Contact category")).not.toContain("Clinic");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Kz Example" }));
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(optionsOf("Contact category")).toContain("Clinic");
    expect(optionsOf("Contact category")).not.toContain("Customer");
  });

  test("the category filter offers only the chosen company's categories", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({ contacts: [], nextCursor: null, owners: [] }));
    render(<ContactsView />);
    const optionsOf = () =>
      within(screen.getByRole("combobox", { name: "Category" })).getAllByRole("option").map((option) => option.textContent);
    expect(optionsOf()).toEqual(expect.arrayContaining(["Customer", "Clinic"]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Company" }), "kz");
    expect(optionsOf()).toContain("Clinic");
    expect(optionsOf()).not.toContain("Customer");
  });

  test("a click anywhere on the row opens the contact, with its notes and a way to reach them", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({
      contacts: [row({ notes: "2026-10-20 — First call\n\nLikes email", phone: "+1 555 0100" })],
      nextCursor: null,
      owners: [],
    }));
    render(<ContactsView />);
    await user.click(screen.getByText("Initech Health"));
    const drawer = screen.getByRole("dialog", { name: "Jane Example" });
    expect(within(drawer).getByRole("link", { name: "jane@example.test" }).getAttribute("href")).toBe(
      "mailto:jane@example.test",
    );
    expect(within(drawer).getByRole("link", { name: "+1 555 0100" }).getAttribute("href")).toBe("tel:+15550100");
    const notes = within(drawer).getByRole("region", { name: "Notes" });
    expect(notes.textContent).toContain("2026-10-20 — First call");
    expect(notes.textContent).toContain("Likes email");
    expect(within(drawer).queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  test("a note is added from the drawer and the box is cleared", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({ contacts: [row()], nextCursor: null, owners: [] }));
    render(<ContactsView />);
    await user.click(screen.getByRole("button", { name: "Jane Example" }));
    const drawer = screen.getByRole("dialog", { name: "Jane Example" });
    expect(within(drawer).getByText("No notes yet.")).toBeDefined();
    const box = within(drawer).getByRole("textbox", { name: "New note" });
    await user.type(box, "Asked for pricing");
    await user.click(within(drawer).getByRole("button", { name: "Add note" }));
    expect(convex.mutation(api.contacts.addNote)).toHaveBeenCalledWith({ id: "c1", text: "Asked for pricing" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("Edit details saves every field and returns to the read view", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({ contacts: [row()], nextCursor: null, owners: [] }));
    render(<ContactsView />);
    await user.click(screen.getByRole("button", { name: "Jane Example" }));
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const form = screen.getByRole("form", { name: "Edit contact" });
    const title = within(form).getByRole("textbox", { name: "Title" });
    await user.type(title, "COO");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.contacts.upsert)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", title: "COO", name: "Jane Example", category: "advisor" }),
    );
    expect(screen.queryByRole("form", { name: "Edit contact" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit details" })).toBeDefined();
  });

  test("Add a contact asks for a few fields and opens the new contact", async () => {
    const user = userEvent.setup();
    convex.setQueryBy(api.contacts.list, () => ({
      contacts: [row({ id: "c-new", name: "New Person", company: "kz", category: "kz_clinic" })],
      nextCursor: null,
      owners: [],
    }));
    convex.mutation(api.contacts.upsert).mockResolvedValue({ id: "c-new", created: true });
    render(<ContactsView />);
    await user.click(screen.getByRole("button", { name: "Add a contact" }));
    const dialog = screen.getByRole("dialog", { name: "Add a contact" });
    expect(within(dialog).queryByRole("textbox", { name: "How you met" })).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "New Person");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Contact company" }), "kz");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Contact category" }), "kz_clinic");
    await user.type(within(dialog).getByRole("textbox", { name: "Email" }), "new@example.test");
    await user.type(within(dialog).getByRole("textbox", { name: "Note" }), "Met at the forum");
    await user.click(within(dialog).getByRole("button", { name: "Add contact" }));
    expect(convex.mutation(api.contacts.upsert)).toHaveBeenCalledWith({
      company: "kz",
      name: "New Person",
      category: "kz_clinic",
      emails: ["new@example.test"],
      notes: `${new Date().toISOString().slice(0, 10)} — Met at the forum`,
    });
    expect(screen.getByRole("dialog", { name: "New Person" })).toBeDefined();
  });
});
