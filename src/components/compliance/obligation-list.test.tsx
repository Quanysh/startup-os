// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { OBLIGATION_CATEGORIES, type ObligationRow } from "@convex/lib/obligationShape";
import { obligation } from "@/lib/compliance/fixtures";
import { mockConvex } from "@/test-support/convex";
import { ObligationList } from "./obligation-list";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const TODAY = "2026-10-12";
const NOW = Date.UTC(2026, 9, 12, 12);

let convex: ReturnType<typeof mockConvex>;
const list = (rows: ObligationRow[]) => <ObligationList rows={rows} today={TODAY} now={NOW} />;
const confirmed = (due: string, patch: Partial<ObligationRow> = {}) =>
  obligation({ due, dueConfirmed: true, ...patch });
const itemOf = (title: string) => within(screen.getByText(title).closest("tr")!);
const summaryValue = (label: string) =>
  within(screen.getByRole("region", { name: "Summary" })).getByText(label).nextElementSibling
    ?.textContent;
const section = (label: string) => within(screen.getByRole("region", { name: label }));

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

describe("ObligationList: what it says", () => {
  test("every category is listed, in the page's order, even when empty", () => {
    render(list([]));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      OBLIGATION_CATEGORIES.map((c) => c.label),
    );
    expect(section("SOC 2").getByText("Nothing listed.")).toBeTruthy();
  });

  test.each([
    [confirmed("2026-10-09"), "overdue", "Overdue by 3 days · was due Oct 9"],
    [confirmed("2026-10-12"), "due_soon", "Due today"],
    [confirmed("2026-10-24"), "due_soon", "Due in 12 days · Oct 24"],
    [confirmed("2027-03-01"), "upcoming", "Due Mar 1, 2027"],
    [obligation({ due: "2027-03-01" }), "unconfirmed", "Unconfirmed: Mar 1, 2027"],
    [obligation(), "no_date", "No date yet"],
    [confirmed("2026-01-01", { status: "done" }), "done", "Done"],
    [obligation({ status: "not_applicable" }), "not_applicable", "Not applicable"],
  ])("%#: an item's due line", (row, state, text) => {
    render(list([{ ...row, title: "The item" }]));
    // The due line, not the status column beside it (a finished item says "Done" in both).
    const line = itemOf("The item").getByText(text, { selector: "[data-due]" });
    expect(line.getAttribute("data-due")).toBe(state);
  });

  test("a category's items are a table: item, due, repeats, status, evidence, actions", () => {
    const category = OBLIGATION_CATEGORIES.find((c) => c.id === "corporate_tax")!;
    render(
      list([
        confirmed("2026-10-09", {
          title: "Franchise tax",
          recurrence: "annual",
          status: "in_progress",
          note: "Paid from the operating account",
          evidenceUrl: "https://example.com/this-year",
        }),
        obligation({ title: "Federal return" }),
      ]),
    );
    const table = section(category.label).getByRole("table", { name: `${category.label}: items` });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((th) => th.textContent)).toEqual([
      "Item",
      "Due",
      "Repeats",
      "Status",
      "Evidence",
      "Actions",
    ]);
    for (const th of headers) expect(th.getAttribute("scope")).toBe("col");
    const cellsOf = (title: string) =>
      within(within(table).getByRole("rowheader", { name: new RegExp(title) }).closest("tr")!)
        .getAllByRole("cell")
        .map((td) => td.textContent);
    expect(cellsOf("Franchise tax").slice(0, 4)).toEqual([
      "Overdue by 3 days · was due Oct 9",
      "Every year",
      "In progress",
      "Evidence",
    ]);
    expect(cellsOf("Federal return").slice(0, 4)).toEqual([
      "No date yet",
      "Does not repeat",
      "Open",
      "No evidence linked",
    ]);
    // The note stays with its item.
    expect(
      within(table).getByRole("rowheader", { name: /Franchise tax/ }).textContent,
    ).toContain("Paid from the operating account");
    // Each row's buttons are named for its item.
    const row = itemOf("Federal return");
    expect(row.getByRole("button", { name: "Mark Federal return done" })).toBeTruthy();
    expect(row.getByRole("button", { name: "Edit Federal return" })).toBeTruthy();
  });

  test("a category with nothing in it is a sentence, not an empty table", () => {
    render(list([]));
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("an unconfirmed date is never shown as due or overdue, however old", () => {
    render(list([obligation({ title: "Old guess", due: "2020-01-01" })]));
    const item = itemOf("Old guess");
    expect(item.getByText("Unconfirmed: Jan 1, 2020")).toBeTruthy();
    expect(item.queryByText(/Overdue|Due /)).toBeNull();
    expect(summaryValue("Overdue")).toBe("0");
    expect(summaryValue("Dates to confirm")).toBe("1");
  });

  test("an item with no date shows none: no date is invented for it", () => {
    render(list([obligation({ title: "Undated", recurrence: "annual" })]));
    const item = itemOf("Undated");
    expect(item.getByText("No date yet")).toBeTruthy();
    expect(
      item.queryByText(/\b(20\d\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/),
    ).toBeNull();
  });

  test("the summary counts each state, and says a zero is not an all-clear", () => {
    render(
      list([
        confirmed("2026-10-09"),
        confirmed("2026-10-20"),
        confirmed("2026-11-01"),
        confirmed("2027-06-01"),
        obligation({ due: "2026-01-01" }),
        obligation(),
        obligation(),
        confirmed("2026-01-01", { status: "done" }),
      ]),
    );
    expect(summaryValue("Overdue")).toBe("1");
    expect(summaryValue("Due in the next 30 days")).toBe("2");
    expect(summaryValue("Dates to confirm")).toBe("1");
    expect(summaryValue("No date yet")).toBe("2");
    expect(summaryValue("Done")).toBe("1 of 8");
    expect(
      screen.getByText(
        "3 items have no confirmed date. Until its date is confirmed an item is never counted as due or overdue, so a zero above does not mean nothing is late.",
      ),
    ).toBeTruthy();
  });

  test("one item without a confirmed date reads in the singular; none says nothing", () => {
    const view = render(list([obligation()]));
    expect(screen.getByText(/^1 item has no confirmed date\./)).toBeTruthy();
    view.rerender(list([confirmed("2027-06-01")]));
    expect(screen.queryByText(/no confirmed date/)).toBeNull();
  });

  test("a category says how many are done and how many lack a confirmed date", () => {
    render(
      list([
        confirmed("2026-01-01", { category: "soc2", status: "done" }),
        obligation({ category: "soc2" }),
        obligation({ category: "soc2", due: "2027-01-01" }),
        confirmed("2027-01-01", { category: "soc2" }),
      ]),
    );
    expect(section("SOC 2").getByText("1 of 4 done · 2 without a confirmed date")).toBeTruthy();
  });

  test("it never says the company is compliant, even with everything done", () => {
    const everythingDone = OBLIGATION_CATEGORIES.flatMap((category) => [
      confirmed("2026-01-01", { category: category.id, status: "done", evidenceUrl: "https://example.com/e" }),
      obligation({ category: category.id, status: "not_applicable" }),
    ]);
    for (const rows of [everythingDone, [], [confirmed("2027-06-01")], [obligation()]]) {
      const { container } = render(list(rows));
      expect(container.textContent).not.toMatch(/\bcompliant\b|\bcompliance\b|\bcertified\b/i);
      expect(container.textContent).not.toMatch(/all clear|all set|up to date|on track|nothing to do/i);
      // No status colour vouches for a finished item or a category.
      expect(container.querySelector(".text-good")).toBeNull();
      cleanup();
    }
  });

  test("evidence, the previous cycle's evidence and a date's source are links that open elsewhere", () => {
    render(
      list([
        confirmed("2027-03-01", {
          title: "Franchise tax",
          recurrence: "annual",
          evidenceUrl: "https://example.com/this-year",
          lastEvidenceUrl: "https://example.com/last-year",
          sourceUrl: "https://corp.delaware.gov/paytaxes/",
          lastDoneAt: Date.UTC(2026, 1, 20),
          lastDoneFor: "2026-03-01",
        }),
      ]),
    );
    const item = itemOf("Franchise tax");
    const link = (name: string) => item.getByRole("link", { name });
    expect(link("Evidence").getAttribute("href")).toBe("https://example.com/this-year");
    expect(link("Previous evidence").getAttribute("href")).toBe("https://example.com/last-year");
    expect(link("Where this date is stated").getAttribute("href")).toBe(
      "https://corp.delaware.gov/paytaxes/",
    );
    for (const a of item.getAllByRole("link")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(item.getByText("Every year")).toBeTruthy();
    expect(item.getByText("Last finished Feb 20 (for Mar 1)")).toBeTruthy();
  });

  test("an open item with no evidence says so; a source without a date is the rule's", () => {
    render(
      list([obligation({ title: "Federal return", sourceUrl: "https://www.irs.gov/instructions/i1120" })]),
    );
    const item = itemOf("Federal return");
    expect(item.getByText("No evidence linked")).toBeTruthy();
    expect(item.getByRole("link", { name: "Where the rule is stated" })).toBeTruthy();
  });
});

describe("ObligationList: acting on an item", () => {
  test("Mark done sends the owner's date and the date it was showing", async () => {
    const user = userEvent.setup();
    const row = confirmed("2026-10-20", { title: "Pen test" });
    render(list([row]));
    await user.click(screen.getByRole("button", { name: "Mark Pen test done" }));
    expect(convex.mutation(api.obligations.complete)).toHaveBeenCalledWith({
      id: row.id,
      today: TODAY,
      expectedDue: "2026-10-20",
    });
  });

  test("a repeating item asks first, naming the date it will schedule", async () => {
    const user = userEvent.setup();
    const row = confirmed("2027-03-01", { title: "Franchise tax", recurrence: "annual", anchorDay: 1 });
    render(list([row]));
    await user.click(screen.getByRole("button", { name: "Mark Franchise tax done" }));
    // Nothing has happened yet: finishing a repeating item replaces its date.
    expect(convex.mutation(api.obligations.complete)).not.toHaveBeenCalled();
    const item = itemOf("Franchise tax");
    expect(item.getByText("Mark done and schedule Mar 1, 2028?")).toBeTruthy();
    expect(item.queryByRole("button", { name: "Mark Franchise tax done" })).toBeNull();

    await user.click(item.getByRole("button", { name: "Done" }));
    expect(convex.mutation(api.obligations.complete)).toHaveBeenCalledTimes(1);
    expect(convex.mutation(api.obligations.complete)).toHaveBeenCalledWith({
      id: row.id,
      today: TODAY,
      expectedDue: "2027-03-01",
    });
    expect(item.queryByText(/Mark done and schedule/)).toBeNull();
  });

  test("Keep leaves a repeating item as it was", async () => {
    const user = userEvent.setup();
    render(list([confirmed("2027-03-01", { title: "Franchise tax", recurrence: "annual" })]));
    await user.click(screen.getByRole("button", { name: "Mark Franchise tax done" }));
    await user.click(itemOf("Franchise tax").getByRole("button", { name: "Keep" }));
    expect(convex.mutation(api.obligations.complete)).not.toHaveBeenCalled();
    expect(screen.queryByText(/Mark done and schedule/)).toBeNull();
    expect(screen.getByRole("button", { name: "Mark Franchise tax done" })).toBeTruthy();
  });

  test("the date it names is the one the server will set: the 31st returns, an undated one counts from today", async () => {
    const user = userEvent.setup();
    render(
      list([
        confirmed("2026-02-28", { title: "Payroll", recurrence: "monthly", anchorDay: 31 }),
        obligation({ title: "Review", recurrence: "quarterly" }),
      ]),
    );
    await user.click(screen.getByRole("button", { name: "Mark Payroll done" }));
    expect(itemOf("Payroll").getByText("Mark done and schedule Mar 31?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mark Review done" }));
    expect(itemOf("Review").getByText("Mark done and schedule Jan 12, 2027?")).toBeTruthy();
  });

  test("an undated item is finished with no expected date", async () => {
    const user = userEvent.setup();
    const row = obligation({ title: "Undated" });
    render(list([row]));
    await user.click(screen.getByRole("button", { name: "Mark Undated done" }));
    expect(convex.mutation(api.obligations.complete)).toHaveBeenCalledWith({
      id: row.id,
      today: TODAY,
      expectedDue: null,
    });
  });

  test("a date is confirmed in one click, and only an unconfirmed one offers it", async () => {
    const user = userEvent.setup();
    const guess = obligation({ title: "Guess", due: "2027-03-01" });
    render(list([guess, confirmed("2027-03-01", { title: "Checked" }), obligation({ title: "Undated" })]));
    expect(screen.queryByRole("button", { name: "Confirm the date of Checked" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm the date of Undated" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm the date of Guess" }));
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledWith({
      id: guess.id,
      dueConfirmed: true,
    });
  });

  test("a finished or skipped item offers no Mark done", () => {
    render(
      list([
        confirmed("2026-01-01", { title: "Finished", status: "done" }),
        obligation({ title: "Skipped", status: "not_applicable" }),
      ]),
    );
    expect(screen.queryByRole("button", { name: /^Mark/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Finished" })).toBeTruthy();
  });

  test("a failure is shown on the item, in the server's words", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.obligations.complete)
      .mockRejectedValueOnce(new ConvexError("That item no longer exists."));
    render(list([obligation({ title: "Gone" }), obligation({ title: "Other" })]));
    await user.click(screen.getByRole("button", { name: "Mark Gone done" }));
    expect((await itemOf("Gone").findByRole("alert")).textContent).toBe(
      "That item no longer exists.",
    );
    expect(itemOf("Other").queryByRole("alert")).toBeNull();
  });

  test("Edit opens the item's editor, and a live update does not close or reset it", async () => {
    const user = userEvent.setup();
    const row = obligation({ title: "Risk analysis", category: "hipaa" });
    const view = render(list([row]));
    await user.click(screen.getByRole("button", { name: "Edit Risk analysis" }));
    const title = () => within(screen.getByRole("dialog", { name: "Edit item" })).getByLabelText("Title") as HTMLInputElement;
    await user.clear(title());
    await user.type(title(), "Typed and not saved");
    // The item changes on the server while its editor is open.
    view.rerender(list([{ ...row, title: "Renamed elsewhere", note: "A note" }]));
    expect(title().value).toBe("Typed and not saved");
  });

  test("Add an item starts in the category it was pressed in", async () => {
    const user = userEvent.setup();
    render(list([]));
    await user.click(screen.getByRole("button", { name: "Add an item to SOC 2" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add an item" }));
    expect((dialog.getByLabelText("Category") as HTMLSelectElement).value).toBe("soc2");
  });
});
