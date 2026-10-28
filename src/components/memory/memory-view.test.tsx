// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, type Area, type Role } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { MemoryView } from "./memory-view";

const client = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useConvex: () => client,
}));
// Local noon on 2026-10-14.
const NOW = new Date(2026, 9, 14, 12).getTime();
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const nav = vi.hoisted(() => ({ query: "", replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/memory",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));

// Every name and title is made up.
const decision = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  company: "us",
  title: `Decision ${id}`,
  decision: "We decided it.",
  context: null,
  owner: { email: "ada@example.test", name: "Ada Example" },
  decidedOn: "2026-10-01",
  status: "decided",
  revisitOn: null,
  tags: [],
  meetingId: null,
  taskIds: [],
  dealIds: [],
  goalIds: [],
  links: [],
  byAgent: null,
  updatedAt: 1,
  ...over,
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  nav.query = "";
  nav.replaced = [];
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.decisions.list, [
    decision("a", { title: '<b>Price</b> per seat', revisitOn: "2026-10-10" }),
    decision("b", { status: "reversed", revisitOn: "2026-10-01" }),
    decision("c", { status: "proposed", tags: ["hiring"] }),
  ]);
  convex.setQuery(api.notes.list, []);
  convex.setQuery(api.meetingNotes.list, [
    { id: "m1", company: "us", kind: "investor", heldOn: "2026-10-07", title: "Example investor call", attendeeCount: 2, actionItems: 2, onBoard: 1 },
  ]);
  convex.setQuery(api.decisions.people, []);
  convex.setQuery(api.decisions.linkable, { tasks: [], deals: [], goals: [] });
  convex.setQuery(api.workTools.importableMeetings, [{ meetingId: "ff-1", title: "Made-up call", heldAt: NOW }]);
});
afterEach(cleanup);

const show = (role: Role = "owner", areas: readonly Area[] = AREAS) =>
  render(
    <ViewerProvider viewer={{ role, companies: ["us"], areas, email: "o@example.test", name: "Olga" }}>
      <CompanyProvider allowed={["us"]}>
        <MemoryView />
      </CompanyProvider>
    </ViewerProvider>,
  );

const asked = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi.mocked(useQuery).mock.calls.some(([called]) => getFunctionName(called as never) === getFunctionName(ref));

describe("the decisions tab", () => {
  test("a row per decision, its status in words, and a title that is only text", () => {
    show();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(table.querySelector("b")).toBeNull();
    expect(within(table).getByText("<b>Price</b> per seat")).toBeTruthy();
    expect(within(table).getByText("Reversed")).toBeTruthy();
    expect(within(table).getByText("Proposed")).toBeTruthy();
  });

  test("the banner counts what is due for a revisit, never a reversed one, and shows them", async () => {
    show();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("1 decision is due for a revisit.");
    await userEvent.setup().click(within(banner).getByRole("button", { name: "Show them" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });

  test("a filter goes into the address", async () => {
    show();
    await userEvent.setup().selectOptions(screen.getByLabelText("Status"), "proposed");
    expect(nav.replaced.at(-1)).toBe("/memory?status=proposed");
  });

  test("a link to one decision opens it", () => {
    nav.query = "decision=c";
    show();
    expect(screen.getByRole("form", { name: "Edit the decision" })).toBeTruthy();
  });
});

describe("the meetings tab", () => {
  test("lists meetings by date, and offers the owner their Fireflies meetings", () => {
    nav.query = "tab=meetings";
    show();
    expect(screen.getByText("Example investor call")).toBeTruthy();
    expect(screen.getByText("1 of 2 action items on the board")).toBeTruthy();
    expect(screen.getByLabelText("Start from one of your Fireflies meetings")).toBeTruthy();
  });

  test("a link from Today to one meeting opens it", () => {
    convex.setQuery(api.meetingNotes.get, {
      id: "m1",
      company: "us",
      kind: "investor",
      heldOn: "2026-10-07",
      title: "Example investor call",
      notes: "",
      attendees: [],
      outsideAttendees: [],
      actionItems: [],
      decisions: [],
    });
    nav.query = "tab=meetings&meeting=m1";
    show();
    expect(screen.getByRole("heading", { name: "Example investor call", level: 2 })).toBeTruthy();
  });

  test("Add to board warns of a near open card, and adds it only once confirmed", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.meetingNotes.get, {
      id: "m1",
      company: "us",
      kind: "investor",
      heldOn: "2026-10-07",
      title: "Example investor call",
      notes: "",
      attendees: [],
      outsideAttendees: [],
      actionItems: [{ text: "Send the made-up deck", taskId: null }],
      decisions: [],
    });
    convex.mutation(api.meetingNotes.addActionToBoard).mockRejectedValueOnce(
      new ConvexError({
        words: "This may repeat a card already open on the board.",
        refusal: { code: "possible_duplicate", matches: [{ id: "t1", title: "Send the deck" }] },
      }),
    );
    nav.query = "tab=meetings&meeting=m1";
    show();
    await user.click(screen.getByRole("button", { name: "Add to board" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Possible duplicate of “Send the deck”");
    expect(convex.mutation(api.meetingNotes.addActionToBoard)).toHaveBeenLastCalledWith({ id: "m1", index: 0, duplicates: "warn" });
    await user.click(screen.getByRole("button", { name: "Add anyway" }));
    expect(convex.mutation(api.meetingNotes.addActionToBoard)).toHaveBeenLastCalledWith({ id: "m1", index: 0, duplicates: "confirmed" });
  });

  test("'Add notes in Memory' from Today starts a draft from that Fireflies meeting, for the owner", async () => {
    client.query.mockResolvedValueOnce({
      title: "Made-up call",
      heldOn: "2026-10-13",
      notes: "A made-up summary.",
      actionItems: ["Send the made-up deck"],
    });
    nav.query = "tab=meetings&import=ff-1";
    show();
    const draft = await screen.findByRole("region", { name: "New meeting notes" });
    expect((within(draft).getByLabelText("Title") as HTMLInputElement).value).toBe("Made-up call");
    expect(client.query).toHaveBeenCalledWith(api.workTools.meetingToImport, { meetingId: "ff-1" });
  });

  test("a teammate with Memory is never offered the import, and it is not even asked for", () => {
    nav.query = "tab=meetings";
    show("cofounder", ["memory", "board"]);
    expect(screen.queryByLabelText("Start from one of your Fireflies meetings")).toBeNull();
    expect(asked(api.workTools.importableMeetings)).toBe(false);
  });
});

describe("the notes tab", () => {
  test("saves a note for the company in view, and a note's body stays text", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.notes.list, [
      {
        id: "n1",
        company: "us",
        title: "Made-up pricing note",
        body: "<b>Ten clinics</b>",
        createdAt: 1,
        updatedAt: 1,
        by: "research",
      },
    ]);
    nav.query = "tab=notes";
    show();

    const tab = screen.getByRole("tab", { name: "Notes (1)" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>Ten clinics</b>")).toBeTruthy();
    expect(screen.getByText("By research")).toBeTruthy();

    await user.type(screen.getByLabelText("Title"), "Made-up follow-up");
    await user.type(screen.getByLabelText("Note"), "Asked again.");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(convex.mutation(api.notes.create)).toHaveBeenCalledWith({
      company: "us",
      title: "Made-up follow-up",
      body: "Asked again.",
    });
  });

  test("choosing Notes puts the tab in the address", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("tab", { name: "Notes (0)" }));
    expect(nav.replaced.at(-1)).toBe("/memory?tab=notes");
  });
});
