// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMutation } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { HANDOFF_WITHHELD } from "@convex/lib/handoffs";
import { AREAS } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { HandoffsView } from "./handoffs-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn(), useConvex: () => ({ query: vi.fn() }) }));
const NOW = new Date(2026, 9, 14, 12).getTime();
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
const nav = vi.hoisted(() => ({ query: "", replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/handoffs",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));

const HOUR = 3_600_000;
const handoff = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  company: "us",
  from: "Research",
  to: "Growth",
  title: `Handoff ${id}`,
  summary: "Ten clinics shortlisted.",
  links: [],
  status: "open",
  reason: null,
  openSince: NOW - HOUR,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  history: [{ at: NOW - HOUR, by: "Research", action: "create" }],
  withheld: false,
  ...over,
});

const reassign = vi.fn();
const close = vi.fn();
const answer = vi.fn();
let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  nav.query = "";
  nav.replaced = [];
  reassign.mockReset().mockResolvedValue(null);
  close.mockReset().mockResolvedValue(null);
  answer.mockReset().mockResolvedValue(null);
  convex = mockConvex();
  vi.mocked(useMutation).mockImplementation(((ref: unknown) => {
    const name = getFunctionName(ref as never);
    return name === getFunctionName(api.handoffs.close) ? close : name === getFunctionName(api.handoffs.answer) ? answer : reassign;
  }) as never);
  convex.setQuery(api.handoffs.list, [
    handoff("a", { title: "<b>Old</b> one", openSince: NOW - 30 * HOUR }),
    handoff("b", { status: "accepted", from: "Growth", to: "Ops" }),
    handoff("c", { status: "declined", reason: "No capacity" }),
  ]);
  convex.setQuery(api.handoffs.recipients, {
    people: [{ email: "bahram@example.test", name: "Bahram" }, { email: "no-name@example.test", name: null }],
    bots: [{ id: "support", name: "Support" }],
  });
});
afterEach(cleanup);

const show = (role: "owner" | "cofounder" = "owner") =>
  render(
    <ViewerProvider viewer={{ role, companies: ["us"], areas: role === "owner" ? AREAS : ["board"], email: "o@example.test", name: "Olga" }}>
      <CompanyProvider allowed={["us"]}>
        <HandoffsView />
      </CompanyProvider>
    </ViewerProvider>,
  );

describe("the handoffs page", () => {
  test("a row each, status in words, title only text, and a banner for one with no taker", () => {
    show();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(table.querySelector("b")).toBeNull();
    expect(within(table).getByText("<b>Old</b> one")).toBeTruthy();
    expect(within(table).getByText("Declined")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("1 handoff has been open for more than a day");
  });

  test("a filter goes into the address", async () => {
    show();
    await userEvent.setup().selectOptions(screen.getByLabelText("Bot"), "ops");
    expect(nav.replaced.at(-1)).toBe("/handoffs?bot=ops");
  });

  test("a filter in the address narrows the rows", () => {
    nav.query = "status=accepted";
    show();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });

  test("opening one shows its history; reassigning and closing call the owner's functions", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Open Handoff b" }));
    const panel = screen.getByRole("region", { name: "Handoff b" });
    expect(within(panel).getByText(/Research: create/)).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText("Hand it to"), "support");
    await user.click(within(panel).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(reassign).toHaveBeenCalledWith({ id: "b", to: "support" }));

    await user.click(screen.getByRole("button", { name: "Open Handoff b" }));
    await user.click(screen.getByRole("button", { name: "Close it" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: "b" }));
  });

  test("a teammate with the board may reassign one but is not offered closing it: that is the owner's", async () => {
    const user = userEvent.setup();
    show("cofounder");
    await user.click(screen.getByRole("button", { name: "Open Handoff b" }));
    const panel = screen.getByRole("region", { name: "Handoff b" });
    expect(within(panel).getByRole("button", { name: "Reassign" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Close it" })).toBeNull();
  });

  test("a person can be tagged: the picker lists the people who can take it, by name", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Open Handoff b" }));
    const panel = screen.getByRole("region", { name: "Handoff b" });
    const picker = within(panel).getByLabelText("Hand it to");
    expect(within(picker).getByRole("group", { name: "People" })).toBeTruthy();
    expect(within(picker).getByRole("option", { name: "Bahram" })).toBeTruthy();
    expect(within(picker).getByRole("option", { name: "no-name@example.test" })).toBeTruthy();
    await user.selectOptions(picker, "bahram@example.test");
    await user.type(within(panel).getByLabelText("Note"), "Can you size this?");
    await user.click(within(panel).getByRole("button", { name: "Reassign" }));
    await waitFor(() =>
      expect(reassign).toHaveBeenCalledWith({ id: "b", to: "bahram@example.test", note: "Can you size this?" }),
    );
  });

  test("another bot, not in the list, is typed in", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Open Handoff b" }));
    const panel = screen.getByRole("region", { name: "Handoff b" });
    await user.selectOptions(within(panel).getByLabelText("Hand it to"), "Another bot…");
    await user.type(within(panel).getByLabelText("Bot's id"), "ops");
    await user.click(within(panel).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(reassign).toHaveBeenCalledWith({ id: "b", to: "ops" }));
  });

  test("a finished handoff has no reassign or close", async () => {
    show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Handoff c" }));
    const panel = screen.getByRole("region", { name: "Handoff c" });
    expect(within(panel).getByText("Reason: No capacity")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Reassign" })).toBeNull();
  });

  test("a handoff to the viewer: accept, mark done with a note, decline only with a reason", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.handoffs.list, [
      handoff("p", {
        from: "support",
        to: "o@example.test",
        toRef: { type: "person", email: "o@example.test" },
        mine: true,
      }),
    ]);
    show();
    expect(within(screen.getByRole("table")).getByText("You")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Handoff p" }));
    let panel = screen.getByRole("region", { name: "Handoff p" });
    await user.click(within(panel).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "p", action: "accept" }));

    await user.click(screen.getByRole("button", { name: "Open Handoff p" }));
    panel = screen.getByRole("region", { name: "Handoff p" });
    expect((within(panel).getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(panel).getByLabelText("Your note"), "Booked for Thursday");
    await user.click(within(panel).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "p", action: "done", note: "Booked for Thursday" }));
  });

  test("a handoff to someone else has no answer buttons", async () => {
    convex.setQuery(api.handoffs.list, [handoff("q", { to: "x@example.test", toRef: { type: "person", email: "x@example.test" }, mine: false })]);
    show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Handoff q" }));
    expect(within(screen.getByRole("region", { name: "Handoff q" })).queryByRole("button", { name: "Accept" })).toBeNull();
  });

  test("one whose words are withheld says why, and offers nothing to read", async () => {
    convex.setQuery(api.handoffs.list, [
      handoff("w", { title: HANDOFF_WITHHELD, summary: "", withheld: true, from: "growth", to: "research" }),
    ]);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: `Open ${HANDOFF_WITHHELD}` }));
    const panel = screen.getByRole("region", { name: HANDOFF_WITHHELD });
    expect(panel.textContent).toContain("Its words are kept for whoever holds every page of figures the bot reads");
  });

  test("no handoff yet says how one is made", () => {
    convex.setQuery(api.handoffs.list, []);
    show();
    expect(screen.getByText(/No bot has handed anything over yet/)).toBeTruthy();
  });
});
