// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { obligation } from "@/lib/compliance/fixtures";
import { deferred, mockConvex } from "@/test-support/convex";
import CompliancePage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
const { search } = vi.hoisted(() => ({ search: { value: "" } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search.value) }));

// Local noon on 2026-10-12, so "today" is the 12th in any timezone.
const NOW = new Date(2026, 9, 12, 12).getTime();

let convex: ReturnType<typeof mockConvex>;
const starterButton = () => screen.getByRole("button", { name: "Add the starter checklist" });

beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.obligations.list, []);
  vi.mocked(useNow).mockReturnValue(NOW);
});
afterEach(cleanup);

describe("the compliance page's tabs", () => {
  afterEach(() => {
    search.value = "";
    window.history.replaceState(null, "", "/");
  });
  const tab = (name: string) => screen.getByRole("tab", { name });

  test("the dates are the first tab, and the others are named", () => {
    render(<CompliancePage />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Dates",
      "Questionnaires",
      "Answer bank",
      "Vendor agreements",
      "Evidence",
    ]);
    expect(tab("Dates").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Add the starter checklist" })).toBeTruthy();
  });

  test("a link with ?tab= opens that tab, and choosing a tab puts it in the address without navigating", async () => {
    const user = userEvent.setup();
    search.value = "tab=agreements";
    convex.setQuery(api.evidence.agreements, []);
    convex.setQuery(api.evidence.questionnaires, []);
    render(<CompliancePage />);
    expect(tab("Vendor agreements").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Add an agreement" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add the starter checklist" })).toBeNull();
    await user.click(tab("Questionnaires"));
    expect(window.location.search).toBe("?tab=questionnaires");
    expect(screen.getByRole("button", { name: "Add a questionnaire" })).toBeTruthy();
    await user.click(tab("Dates"));
    expect(window.location.search).toBe("");
  });

  test("the page's own purpose line stays on every tab", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.controls, []);
    render(<CompliancePage />);
    await user.click(tab("Evidence"));
    expect(screen.getByText(/This page tracks dates and evidence/)).toBeTruthy();
  });
});

describe("the compliance page", () => {
  test("it says what it is, and what it is not", () => {
    render(<CompliancePage />);
    expect(
      screen.getByText(
        "What has to be done, by when, and where the proof is. This page tracks dates and evidence. It does not say whether the company meets any standard.",
      ),
    ).toBeTruthy();
  });

  test.each([
    ["the obligations", () => convex.setQuery(api.obligations.list, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows placeholders, and no count, until %s is in", (_name, withhold) => {
    convex.setQuery(api.obligations.list, [obligation({ title: "An item" })]);
    withhold();
    const { container } = render(<CompliancePage />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("An item")).toBeNull();
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
  });

  test("with nothing listed it offers the starter checklist, and says its dates are not deadlines", () => {
    render(<CompliancePage />);
    expect(screen.getByRole("heading", { name: "Nothing here yet" })).toBeTruthy();
    expect(
      screen.getByText(
        "Add items one at a time below, or start from a checklist of questions to answer. Its items come without dates, except one the law fixes, and that one stays unconfirmed until you say it applies.",
      ),
    ).toBeTruthy();
  });

  test("the checklist is added only when asked for, with the owner's date", async () => {
    const user = userEvent.setup();
    convex.mutation(api.starterChecklist.add).mockResolvedValueOnce({ added: 28 });
    render(<CompliancePage />);
    expect(convex.mutation(api.starterChecklist.add)).not.toHaveBeenCalled();
    await user.click(starterButton());
    expect(convex.mutation(api.starterChecklist.add)).toHaveBeenCalledWith({ today: "2026-10-12" });
    expect(await screen.findByText("Added 28 items.")).toBeTruthy();
  });

  test.each([
    [0, "Every starter item is already here."],
    [1, "Added 1 item."],
  ])("adding %i says so", async (added, sentence) => {
    const user = userEvent.setup();
    convex.setQuery(api.obligations.list, [obligation()]);
    convex.mutation(api.starterChecklist.add).mockResolvedValueOnce({ added });
    render(<CompliancePage />);
    expect(
      screen.getByText(
        "The starter checklist adds only the items that are not here already, and never changes one you have edited.",
      ),
    ).toBeTruthy();
    await user.click(starterButton());
    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  test("a second click while it is being added sends nothing more", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ added: number }>();
    convex.mutation(api.starterChecklist.add).mockReturnValueOnce(pending.promise);
    render(<CompliancePage />);
    await user.click(starterButton());
    expect(starterButton().getAttribute("aria-disabled")).toBe("true");
    expect((starterButton() as HTMLButtonElement).disabled).toBe(false);
    await user.click(starterButton());
    expect(convex.mutation(api.starterChecklist.add)).toHaveBeenCalledTimes(1);
    pending.resolve({ added: 28 });
    expect(await screen.findByText("Added 28 items.")).toBeTruthy();
  });

  test("a failure to add it is shown", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.starterChecklist.add)
      .mockRejectedValueOnce(new ConvexError("Today's date did not arrive as a date."));
    render(<CompliancePage />);
    await user.click(starterButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Today's date did not arrive as a date.",
    );
  });

  test("nothing it renders says the company is compliant", () => {
    convex.setQuery(api.obligations.list, [
      obligation({ status: "done", due: "2026-01-01", dueConfirmed: true }),
    ]);
    const { container } = render(<CompliancePage />);
    // The page's own name is the one place the word stands, as a heading.
    const words = (container.textContent ?? "").replace(/^Compliance/, "");
    expect(words).not.toMatch(/\bcompliant\b|\bcompliance\b|\bcertified\b/i);
  });
});

describe("Globex's ISO 27001 calendar", () => {
  const isoButton = () => screen.queryByRole("button", { name: "Add the ISO 27001 calendar" });
  const asCofounderOn = (companies: ("us" | "kz")[]) =>
    render(
      <ViewerProvider viewer={{ role: "cofounder", companies, areas: areasOf("cofounder"), email: null, name: null }}>
        <CompanyProvider allowed={companies}>
          <CompliancePage />
        </CompanyProvider>
      </ViewerProvider>,
    );

  test("someone on Globex is offered it, and it is added only when asked for", async () => {
    const user = userEvent.setup();
    convex.mutation(api.isoPack.add).mockResolvedValueOnce({ items: 27, controls: 84 });
    asCofounderOn(["kz"]);
    expect(convex.mutation(api.isoPack.add)).not.toHaveBeenCalled();
    await user.click(isoButton()!);
    expect(convex.mutation(api.isoPack.add)).toHaveBeenCalledWith({});
    expect(await screen.findByText("Added 27 items and 84 controls.")).toBeTruthy();
  });

  test("adding it again says it is already here", async () => {
    const user = userEvent.setup();
    convex.mutation(api.isoPack.add).mockResolvedValueOnce({ items: 0, controls: 0 });
    asCofounderOn(["kz"]);
    await user.click(isoButton()!);
    expect(await screen.findByText("The ISO 27001 calendar is already here.")).toBeTruthy();
  });

  test("someone on Startup alone is not offered it", () => {
    asCofounderOn(["us"]);
    expect(isoButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Add the starter checklist" })).toBeTruthy();
  });

  test("a refusal is said in the server's words", async () => {
    const user = userEvent.setup();
    convex.mutation(api.isoPack.add).mockRejectedValueOnce(new ConvexError("You do not have access to this."));
    asCofounderOn(["kz"]);
    await user.click(isoButton()!);
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have access to this.");
  });
});
