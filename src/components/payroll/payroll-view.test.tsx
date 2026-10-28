// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import {
  draftRows,
  rowSums,
  totalsOf,
  type PayPerson,
  type PayrollLineRow,
} from "@convex/lib/payroll";
import { AREAS, areasOf, type Area, type Role } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { readTable } from "@/lib/table-export";
import { deferred, mockConvex } from "@/test-support/convex";
import { PayrollView } from "./payroll-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed "now", built from local parts so the month is October in any zone.
const NOW = new Date(2026, 9, 13, 12).getTime();
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// Every name, salary and rate here is made up. None is a statutory figure.
const OCT = "2026-10-01";
const SEP = "2026-09-01";

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  title: null as string | null,
  kind: "employee" as "employee" | "contractor",
  payBasis: "gross" as "gross" | "net",
  monthlyGross: 500_000_00 as number | null,
  monthlyNet: null as number | null,
  currency: "KZT" as "KZT" | "USD",
  startDate: null as string | null,
  endDate: null as string | null,
  notes: null as string | null,
  order: 0,
  archivedAt: null as number | null,
  removable: true,
  changedAt: 1,
  ...extra,
});
const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  appliesTo: "employee" as "employee" | "contractor",
  paidBy: "employee" as "employee" | "company",
  rateBp: 1000 as number | null,
  lessLineIds: [] as string[],
  allowance: 0,
  baseCap: null as number | null,
  order: 0,
  active: true,
  changedAt: 1,
  ...extra,
});

const ADA = person("p1", "Ada Example", { title: "Engineer", removable: false });
const BEN = person("p2", "Ben Example", { kind: "contractor", monthlyGross: 200_000_00, order: 1 });
const PENSION = line("l1", "Pension");
const LEVY = line("l2", "Levy", { paidBy: "company", rateBp: 350, order: 1 });
const UNSET = line("l3", "Social tax", { paidBy: "company", rateBp: null, order: 2 });

/** A saved month as `payroll.getRun` sends it, worked out by the shared arithmetic. */
function monthOf(
  people: PayPerson[],
  lines: PayrollLineRow[],
  extra: Record<string, unknown> = {},
  month = OCT,
  currency: "KZT" | "USD" = "KZT",
) {
  const rows = draftRows({ people, lines, month, companyCurrency: currency });
  return {
    month,
    status: "draft",
    paidOn: null,
    preparedAt: 1,
    rows: rows.map((row) => ({
      personId: row.personId,
      name: row.name,
      title: row.title ?? null,
      kind: row.kind,
      currency: row.currency,
      basis: row.basis ?? ("gross" as const),
      targetNet: row.targetNet ?? null,
      gross: row.gross ?? null,
      grossMissing: row.grossMissing ?? null,
      adjustment: row.adjustment ?? 0,
      adjustmentNote: row.adjustmentNote ?? null,
      lines: row.lines.map((l) => ({
        name: l.name,
        paidBy: l.paidBy,
        rateBp: l.rateBp ?? null,
        base: l.base ?? null,
        amount: l.amount ?? null,
        skipped: l.skipped ?? null,
      })),
      ...rowSums(row),
      net: row.net,
      cost: row.cost ?? null,
    })),
    totals: totalsOf(rows, currency),
    ...extra,
  };
}
const summary = (run: ReturnType<typeof monthOf>) => ({
  month: run.month,
  status: run.status,
  paidOn: run.paidOn,
  preparedAt: 1,
  people: run.rows.length,
  totals: run.totals,
});

let convex: ReturnType<typeof mockConvex>;
type State = {
  people?: ReturnType<typeof person>[];
  lines?: ReturnType<typeof line>[];
  runs?: Record<string, ReturnType<typeof monthOf> | null>;
};
/** What the four queries answer. A month with nothing saved answers null. */
function serve({ people = [ADA, BEN], lines = [PENSION, LEVY], runs = {} }: State = {}) {
  convex.setQuery(api.payroll.listPeople, people);
  convex.setQuery(api.payroll.listLines, lines);
  convex.setQueryBy(api.payroll.getRun, (args) => runs[(args as { month: string }).month] ?? null);
  convex.setQuery(
    api.payroll.listRuns,
    Object.values(runs)
      .filter((run) => run !== null)
      .map(summary)
      .sort((a, b) => (a.month < b.month ? 1 : -1)),
  );
}

const as = (role: Role, children: ReactNode, company: CompanyId = "kz") => (
  <ViewerProvider
    viewer={{
      role,
      companies: ["us", "kz"],
      areas: role === "owner" ? AREAS : areasOf(role),
      email: "someone@example.com",
      name: null,
    }}
  >
    <CompanyProvider allowed={[company]}>{children}</CompanyProvider>
  </ViewerProvider>
);
const page = (company: CompanyId = "kz") => as("owner", <PayrollView />, company);

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const field = <T extends HTMLElement = HTMLInputElement>(
  label: string | RegExp,
  scope: Pick<typeof screen, "getByLabelText"> = screen,
) => scope.getByLabelText(label) as T;
const dialog = () => within(screen.getByRole("dialog"));
const alertText = async () => (await screen.findByRole("alert")).textContent;
const monthTable = (currency = "KZT") =>
  screen.getByRole("table", { name: new RegExp(`paid in ${currency}`) });
/** A row of the month's table by its row header, as the text of its cells. */
const cells = (table: HTMLElement, header: string | RegExp) =>
  within(within(table).getByRole("rowheader", { name: header }).closest("tr")!)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
const called = (ref: Parameters<typeof convex.mutation>[0]) => convex.mutation(ref);

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
});
afterEach(cleanup);

// ── Whose page it is ────────────────────────────────────────────────────────

describe("PayrollView: whose page it is", () => {
  const NOT_YOURS = "Only the owner, and people the owner gives the Payroll page, can open this page.";

  test.each(["cofounder", "sales", "engineer"] as const)(
    "a %s, whose role does not start with it, is told so, and no query is sent",
    (role) => {
      serve({ runs: { [OCT]: monthOf([ADA], [PENSION]) } });
      render(as(role, <PayrollView />));
      expect(screen.getByText(NOT_YOURS)).toBeTruthy();
      expect(screen.queryByText("Ada Example")).toBeNull();
      const sent = vi.mocked(useQuery).mock.calls;
      expect(sent.length).toBeGreaterThan(0);
      for (const call of sent) expect(call[1]).toBe("skip");
    },
  );

  /** A teammate with pages of their own, on Globex, with that company in view. */
  const withAreas = (areas: readonly Area[]) => (
    <ViewerProvider
      viewer={{ role: "engineer", companies: ["kz"], areas, email: "someone@example.com", name: null }}
    >
      <CompanyProvider allowed={["kz"]}>
        <PayrollView />
      </CompanyProvider>
    </ViewerProvider>
  );

  test("a teammate with every other sensitive page and not this one is told the same", () => {
    serve({ runs: { [OCT]: monthOf([ADA], [PENSION]) } });
    render(withAreas(["finance", "settings", "team"]));
    expect(screen.getByText(NOT_YOURS)).toBeTruthy();
    for (const call of vi.mocked(useQuery).mock.calls) expect(call[1]).toBe("skip");
  });

  test("a teammate who was given it reads their company's payroll, and is told the owner gave it", () => {
    serve({ people: [ADA], runs: { [OCT]: monthOf([ADA], [PENSION]) } });
    render(withAreas(["payroll"]));
    expect(screen.getAllByText("Ada Example").length).toBeGreaterThan(0);
    expect(screen.getByText(/The owner gave you this page\./)).toBeTruthy();
    expect(screen.queryByText(/Only you/)).toBeNull();
    const sent = vi.mocked(useQuery).mock.calls.map((call) => call[1]);
    expect(sent).toContainEqual({ company: "kz" });
    expect(sent).not.toContain("skip");
    expect(JSON.stringify(sent)).not.toContain('"us"');
  });

  test("the owner is told nobody else can open it: payroll is the owner's alone", () => {
    serve();
    render(page());
    expect(
      screen.getByText(/Only you can open this page: payroll and costs are the owner's alone\./),
    ).toBeTruthy();
    expect(screen.queryByText(/tick on the Team page/)).toBeNull();
    expect(screen.queryByText(/The owner gave you this page/)).toBeNull();
  });

  test("the header says when a person, a line or a saved month last changed, with no colour", () => {
    const HOUR = 60 * 60 * 1000;
    serve({
      people: [{ ...ADA, changedAt: NOW - 30 * HOUR }, { ...BEN, changedAt: NOW - 50 * HOUR }],
      lines: [{ ...PENSION, changedAt: NOW - 4 * HOUR }, { ...LEVY, changedAt: NOW - 90 * HOUR }],
    });
    render(page());
    expect(screen.getByRole("button", { name: /^Typed in · last change 4 hours ago\. / })).toBeTruthy();
  });

  test("the owner's queries are for the company in view", () => {
    serve();
    render(page("kz"));
    const sent = vi.mocked(useQuery).mock.calls.map((call) => call[1]);
    expect(sent).toContainEqual({ company: "kz" });
    expect(sent).toContainEqual({ company: "kz", month: OCT });
    expect(sent).not.toContain("skip");
    expect(JSON.stringify(sent)).not.toContain('"us"');
    cleanup();
    vi.mocked(useQuery).mockClear();
    render(page("us"));
    expect(vi.mocked(useQuery).mock.calls.map((call) => call[1])).toContainEqual({
      company: "us",
      month: OCT,
    });
  });

  test("the standing note says whose the rates are", () => {
    serve();
    render(page());
    expect(screen.getByRole("heading", { level: 1, name: "Payroll" })).toBeTruthy();
    expect(
      screen.getByText(
        /The rates are yours to set and to confirm with your accountant\. The OS does the arithmetic/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/It is not tax advice/)).toBeTruthy();
  });
});

// ── The month ───────────────────────────────────────────────────────────────

describe("PayrollView: one table, live until paid", () => {
  /** The adjustment typed in a row. */
  const adjustment = (name: string) => field(`Adjustment for ${name}`);
  /** A live row's six money cells, with the adjustment field's value in its place. */
  const money = (table: HTMLElement, header: string | RegExp) =>
    within(within(table).getByRole("rowheader", { name: header }).closest("tr")!)
      .getAllByRole("cell")
      .slice(0, 6)
      .map((cell) => cell.querySelector("input")?.value ?? cell.textContent);
  const region = () => within(screen.getByRole("region", { name: "Month" }));

  test("with nothing saved, the month is one table worked out from today's people and lines", () => {
    serve();
    render(page());
    expect(region().getByRole("heading", { level: 2, name: "Oct 2026" })).toBeTruthy();
    expect(region().getByText("Not paid")).toBeTruthy();
    const table = monthTable();
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Person",
      "Gross",
      "Adjustment",
      "Withheld",
      "Net pay",
      "Company-paid",
      "Total cost",
      "Actions",
    ]);
    // 10% withheld, 3.5% on top; the adjustment field is empty.
    expect(money(table, /Ada Example/)).toEqual([
      "₸500,000",
      "",
      "₸50,000",
      "₸450,000",
      "₸17,500",
      "₸517,500",
    ]);
    expect(money(table, /Ben Example/)).toEqual(["₸200,000", "", "₸0", "₸200,000", "₸0", "₸200,000"]);
    expect(cells(table, "Employees (1)")[5]).toBe("₸517,500");
    expect(cells(table, "Contractors (1)")[5]).toBe("₸200,000");
    expect(cells(table, "Total (2 people)").slice(0, 6)).toEqual([
      "₸700,000",
      "₸0",
      "₸50,000",
      "₸650,000",
      "₸17,500",
      "₸717,500",
    ]);
    // One table: no second list of people, nothing to prepare or recalculate.
    expect(screen.queryByRole("table", { name: "People" })).toBeNull();
    for (const name of ["Prepare", "Recalculate", "Delete draft"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByText(/draft/i)).toBeNull();
    // Numbers sit in right-aligned, tabular columns; the table scrolls in its own box.
    const amount = within(table).getAllByRole("cell")[0]!;
    expect(amount.className).toContain("font-num");
    expect(amount.className).toContain("text-right");
    expect(table.parentElement!.className).toContain("overflow-x-auto");
  });

  test("the month downloads as it reads: an adjustment as money, not the field that holds it", () => {
    serve();
    render(page());
    const rows = readTable(monthTable());
    expect(rows[0]).toEqual(["Person", "Gross", "Adjustment", "Withheld", "Net pay", "Company-paid", "Total cost"]);
    const ada = rows.find((cells) => cells[0]!.startsWith("Ada Example"))!;
    expect(ada.slice(1)).toEqual(["₸500,000", "₸0", "₸50,000", "₸450,000", "₸17,500", "₸517,500"]);
    expect(rows.at(-1)).toEqual(["Total (2 people)", "₸700,000", "₸0", "₸50,000", "₸650,000", "₸17,500", "₸717,500"]);
  });

  test("a draft saved before the rates were set is not shown: only its adjustments are", () => {
    // Saved when the pension had no rate; the rate has been typed since.
    const stale = monthOf([ADA, BEN], [line("l1", "Pension", { rateBp: null }), LEVY]);
    stale.rows[0] = { ...stale.rows[0]!, adjustment: 30_000_00, adjustmentNote: "Bonus" };
    serve({ runs: { [OCT]: stale } });
    render(page());
    const table = monthTable();
    expect(money(table, /Ada Example/)).toEqual([
      "₸500,000",
      "30000",
      "₸50,000",
      "₸480,000",
      "₸17,500",
      "₸547,500",
    ]);
    expect(screen.queryByText(/Incomplete/)).toBeNull();
    expect(region().getByText("Not paid")).toBeTruthy();
    expect(button("Mark as paid").getAttribute("aria-disabled")).not.toBe("true");
  });

  test("one kind only: no subtotal rows, just the total", () => {
    serve({ people: [ADA], lines: [PENSION] });
    render(page());
    expect(within(monthTable()).queryByRole("rowheader", { name: /Employees/ })).toBeNull();
    expect(cells(monthTable(), "Total (1 person)")[3]).toBe("₸450,000");
  });

  test("with every figure known, a year at this rate is said under the heading", () => {
    serve();
    render(page());
    expect(region().getByText(/^A year at this month's rate:/).textContent).toBe(
      "A year at this month's rate: ₸8,610,000. That is the total cost × 12: a simple multiple, not a forecast.",
    );
  });

  test("a rate not set: the row and the foot say so, why is said once, and the month cannot be marked paid", async () => {
    const user = userEvent.setup();
    serve({ lines: [PENSION, UNSET] });
    render(page());
    const table = monthTable();
    const ada = within(table).getByRole("rowheader", { name: /Ada Example/ });
    expect(within(ada).getByText("Incomplete: 1 rate not set")).toBeTruthy();
    expect(within(table).getByRole("rowheader", { name: /Ben Example/ }).textContent).not.toContain(
      "Incomplete",
    );
    // A missing figure is not a zero: the foot says it is not known.
    expect(cells(table, "Total (2 people)").slice(0, 6)).toEqual([
      "₸700,000",
      "₸0",
      "₸50,000",
      "₸650,000",
      "Not known yet",
      "Not known yet",
    ]);
    const why = region().getByText(/^1 company-paid rate is not set/);
    expect(why.textContent).toBe(
      "1 company-paid rate is not set, so what the company pays on top, and the total cost, cannot be worked out for 1 person. Set the rate below.",
    );
    expect(region().getByRole("link", { name: "Set the rate below." }).getAttribute("href")).toBe(
      "#payroll-lines",
    );
    expect(region().queryByText(/A year at this month's rate/)).toBeNull();
    expect(
      region().getByText(
        "Oct 2026 cannot be marked paid yet: 1 rate is not set. Set each rate below, or switch the line off.",
      ),
    ).toBeTruthy();
    const mark = button("Mark as paid");
    expect(mark.getAttribute("aria-disabled")).toBe("true");
    await user.click(mark);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(called(api.payroll.markPaid)).not.toHaveBeenCalled();
  });

  test("Mark as paid asks first, says what freezing means, and sends the date", async () => {
    const user = userEvent.setup();
    serve();
    render(page());
    await user.click(button("Mark as paid"));
    expect(called(api.payroll.markPaid)).not.toHaveBeenCalled();
    expect(dialog().getByText(/freezes Oct 2026/)).toBeTruthy();
    expect(dialog().getByText(/later changes to people, pay or rates do not change/)).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(called(api.payroll.markPaid)).not.toHaveBeenCalled();

    await user.click(button("Mark as paid"));
    expect(field("Paid on", dialog()).value).toBe("2026-10-13");
    fireEvent.change(field("Paid on", dialog()), { target: { value: "2026-10-05" } });
    await user.click(dialog().getByRole("button", { name: "Mark as paid" }));
    expect(called(api.payroll.markPaid)).toHaveBeenCalledWith({
      company: "kz",
      month: OCT,
      paidOn: "2026-10-05",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a refused Mark as paid is said, and the dialog stays", async () => {
    const user = userEvent.setup();
    serve();
    called(api.payroll.markPaid).mockRejectedValueOnce(
      new ConvexError("Some lines have no amount. Set each rate or switch the line off, then mark the month paid."),
    );
    render(page());
    await user.click(button("Mark as paid"));
    await user.click(dialog().getByRole("button", { name: "Mark as paid" }));
    expect(await alertText()).toMatch(/^Some lines have no amount/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("an adjustment is typed in its row: a minus sign is a deduction, sent in minor units on Enter", async () => {
    const user = userEvent.setup();
    serve();
    render(page());
    await user.type(adjustment("Ada Example"), "-25,000.50{Enter}");
    expect(called(api.payroll.setAdjustment)).toHaveBeenCalledWith({
      company: "kz",
      month: OCT,
      personId: "p1",
      amount: -25_000_50,
    });
  });

  test("leaving the field saves it too, keeping the note it had; leaving it unchanged sends nothing", async () => {
    const user = userEvent.setup();
    const run = monthOf([ADA, BEN], [PENSION, LEVY]);
    run.rows[0] = { ...run.rows[0]!, adjustment: 30_000_00, adjustmentNote: "Bonus" };
    serve({ runs: { [OCT]: run } });
    render(page());
    await user.click(adjustment("Ben Example"));
    await user.tab();
    expect(called(api.payroll.setAdjustment)).not.toHaveBeenCalled();
    await user.clear(adjustment("Ada Example"));
    await user.type(adjustment("Ada Example"), "40000");
    await user.tab();
    expect(called(api.payroll.setAdjustment)).toHaveBeenCalledWith({
      company: "kz",
      month: OCT,
      personId: "p1",
      amount: 40_000_00,
      note: "Bonus",
    });
  });

  test("an adjustment that is not an amount is said and not sent; a refusal is shown", async () => {
    const user = userEvent.setup();
    serve();
    render(page());
    await user.type(adjustment("Ada Example"), "a lot{Enter}");
    expect(await alertText()).toBe("That is not an amount. Use a minus sign for a deduction.");
    expect(called(api.payroll.setAdjustment)).not.toHaveBeenCalled();

    called(api.payroll.setAdjustment).mockRejectedValueOnce(
      new ConvexError("A deduction cannot be more than the month's gross."),
    );
    await user.clear(adjustment("Ada Example"));
    await user.type(adjustment("Ada Example"), "-900000{Enter}");
    expect(await alertText()).toBe("A deduction cannot be more than the month's gross.");
  });

  test("what is being typed is kept when the month updates underneath", async () => {
    const user = userEvent.setup();
    serve();
    const view = render(page());
    await user.type(adjustment("Ada Example"), "100");
    const updated = monthOf([ADA, BEN], [PENSION, LEVY]);
    updated.rows[0] = { ...updated.rows[0]!, adjustment: 7_00, adjustmentNote: "From elsewhere" };
    serve({ runs: { [OCT]: updated } });
    view.rerender(page());
    expect(adjustment("Ada Example").value).toBe("100");
  });

  test("the breakdown shows each line's base, rate and amount, and the adjustment's note", async () => {
    const user = userEvent.setup();
    const income = line("l4", "Income", { lessLineIds: ["l1"], allowance: 50_000_00, order: 2 });
    const run = monthOf([ADA], [PENSION]);
    run.rows[0] = { ...run.rows[0]!, adjustment: 30_000_00, adjustmentNote: "Bonus" };
    serve({ people: [ADA], lines: [PENSION, LEVY, income], runs: { [OCT]: run } });
    render(page());
    const toggle = button("Breakdown for Ada Example");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const breakdown = screen.getByRole("table", { name: "Lines for Ada Example" });
    expect(within(breakdown).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Line",
      "Paid by",
      "Base",
      "Rate",
      "Amount",
    ]);
    expect(cells(breakdown, "Pension")).toEqual(["Withheld from pay", "₸500,000", "10%", "₸50,000"]);
    expect(cells(breakdown, "Levy")).toEqual(["Paid by the company", "₸500,000", "3.5%", "₸17,500"]);
    // 500,000 − 50,000 − 50,000.
    expect(cells(breakdown, "Income")).toEqual(["Withheld from pay", "₸400,000", "10%", "₸40,000"]);

    const note = field("Adjustment note for Ada Example");
    expect(note.value).toBe("Bonus");
    await user.clear(note);
    await user.type(note, "Quarterly bonus");
    await user.click(button("Save note"));
    expect(called(api.payroll.setAdjustment)).toHaveBeenCalledWith({
      company: "kz",
      month: OCT,
      personId: "p1",
      amount: 30_000_00,
      note: "Quarterly bonus",
    });
  });

  test("Add a person is at the top of the table; each row has Edit and Archive", async () => {
    const user = userEvent.setup();
    serve();
    render(page());
    const add = button("Add a person");
    expect(add.compareDocumentPosition(monthTable()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(button("Archive Ada Example"));
    expect(called(api.payroll.archivePerson)).toHaveBeenCalledWith({ id: "p1", archived: true });
    await user.click(button("Edit Ben Example"));
    expect(field("Name", dialog()).value).toBe("Ben Example");
  });

  test("people not on payroll that month, and archived people, wait in collapsed groups under it", async () => {
    const user = userEvent.setup();
    const later = person("p7", "Later Example", { startDate: "2026-11-01", order: 2 });
    const gone = person("p9", "Gone Example", { archivedAt: 5, order: 3 });
    serve({ people: [ADA, later, gone] });
    render(page());
    expect(within(monthTable()).queryByRole("rowheader", { name: /Later Example/ })).toBeNull();
    expect(screen.queryByText("Gone Example")).toBeNull();

    const notIn = button("Not on payroll in Oct 2026 (1)");
    expect(notIn.getAttribute("aria-expanded")).toBe("false");
    await user.click(notIn);
    const waiting = screen.getByRole("table", { name: "Not on payroll in Oct 2026" });
    expect(cells(waiting, "Later Example").slice(0, 4)).toEqual([
      "Employee",
      "₸500,000 gross",
      "Nov 1",
      "—",
    ]);
    await user.click(within(waiting).getByRole("button", { name: "Edit Later Example" }));
    expect(field("Name", dialog()).value).toBe("Later Example");
    await user.click(dialog().getByRole("button", { name: "Cancel" }));

    await user.click(button("Archived (1)"));
    const archived = screen.getByRole("table", { name: "Archived people" });
    expect(within(archived).getByRole("rowheader", { name: "Gone Example" })).toBeTruthy();
    await user.click(button("Restore Gone Example"));
    expect(called(api.payroll.archivePerson)).toHaveBeenCalledWith({ id: "p9", archived: false });
  });

  test("nobody on payroll that month: said, with Add a person and no table", () => {
    serve({ people: [] });
    render(page());
    expect(region().getByText(/^Nobody is on payroll in Oct 2026\./)).toBeTruthy();
    expect(screen.queryByRole("table", { name: /paid in/ })).toBeNull();
    expect(button("Add a person")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as paid" })).toBeNull();
  });

  test("lines in a circle: nothing is worked out, and it says where to look", () => {
    serve({
      lines: [
        line("a", "A", { lessLineIds: ["b"] }),
        line("b", "B", { lessLineIds: ["a"], order: 1 }),
      ],
    });
    render(page());
    expect(screen.queryByRole("table", { name: /paid in/ })).toBeNull();
    expect(
      region().getByText(/^Not known yet: some lines subtract each other in a circle\./).textContent,
    ).toBe("Not known yet: some lines subtract each other in a circle. See the lines below.");
  });

  test("someone paid in another currency has a table and totals of their own", () => {
    const dana = person("p3", "Dana Example", { currency: "USD", monthlyGross: 4_000_00, order: 2 });
    serve({ people: [ADA, dana], lines: [PENSION] });
    render(page());
    expect(cells(monthTable("KZT"), "Total (1 person)")[0]).toBe("₸500,000");
    expect(cells(monthTable("USD"), /Dana Example/)[0]).toBe("$4,000.00");
    expect(within(monthTable("KZT")).queryByRole("rowheader", { name: /Dana Example/ })).toBeNull();
    expect(within(monthTable("USD")).queryByRole("rowheader", { name: /Ada Example/ })).toBeNull();
    expect(cells(monthTable("USD"), "Total (1 person)")[5]).toBe("$4,000.00");
    expect(screen.getByText(/Amounts in different currencies are never added together/)).toBeTruthy();
  });

  test("previous and next move the month, and the query with it", async () => {
    const user = userEvent.setup();
    serve({ runs: { [SEP]: monthOf([ADA], [PENSION], { status: "paid", paidOn: "2026-10-05" }, SEP) } });
    render(page());
    expect(screen.queryByRole("button", { name: "Back to this month" })).toBeNull();
    await user.click(button("Previous month"));
    expect(screen.getByRole("heading", { level: 2, name: "Sep 2026" })).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.map((call) => call[1])).toContainEqual({
      company: "kz",
      month: SEP,
    });
    expect(monthTable()).toBeTruthy();
    await user.click(button("Next month"));
    await user.click(button("Next month"));
    expect(screen.getByRole("heading", { level: 2, name: "Nov 2026" })).toBeTruthy();
    await user.click(button("Back to this month"));
    expect(screen.getByRole("heading", { level: 2, name: "Oct 2026" })).toBeTruthy();
  });

  test("what was typed or refused in one month does not follow into another", async () => {
    const user = userEvent.setup();
    serve();
    render(page());
    await user.type(adjustment("Ada Example"), "a lot{Enter}");
    expect(await alertText()).toBe("That is not an amount. Use a minus sign for a deduction.");
    await user.click(button("Breakdown for Ada Example"));
    await user.click(button("Previous month"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("Breakdown for Ada Example").getAttribute("aria-expanded")).toBe("false");
    expect(adjustment("Ada Example").value).toBe("");
  });

  test("a button is aria-disabled, never disabled, while its request is in flight, and does not send twice", async () => {
    const user = userEvent.setup();
    serve();
    const wait = deferred();
    called(api.payroll.markPaid).mockReturnValueOnce(wait.promise);
    render(page());
    await user.click(button("Mark as paid"));
    const confirm = dialog().getByRole("button", { name: "Mark as paid" });
    await user.click(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await user.click(confirm);
    expect(called(api.payroll.markPaid)).toHaveBeenCalledTimes(1);
    wait.resolve(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("PayrollView: a paid month", () => {
  const paid = () => monthOf([ADA, BEN], [PENSION, LEVY], { status: "paid", paidOn: "2026-10-05" });

  test("shows the frozen copy, read-only, with when it was paid", async () => {
    const user = userEvent.setup();
    // Today's rate differs, and a paid month does not care.
    serve({ lines: [line("l1", "Pension", { rateBp: 2000 }), LEVY], runs: { [OCT]: paid() } });
    render(page());
    const region = within(screen.getByRole("region", { name: "Month" }));
    expect(region.getByText("Paid on Oct 5")).toBeTruthy();
    expect(
      region.getByText("Paid on Oct 5; later changes to people or rates do not change it."),
    ).toBeTruthy();
    // Still the saved 10%, not today's 20%.
    expect(cells(monthTable(), /Ada Example/)).toEqual([
      "₸500,000",
      "₸0",
      "₸50,000",
      "₸450,000",
      "₸17,500",
      "₸517,500",
    ]);
    expect(within(monthTable()).queryByRole("columnheader", { name: "Actions" })).toBeNull();
    for (const name of ["Mark as paid", "Add a person", "Archive Ada Example", "Edit Ada Example"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText("Adjustment for Ada Example")).toBeNull();
    await user.click(button("Breakdown for Ada Example"));
    expect(screen.getByRole("table", { name: "Lines for Ada Example" })).toBeTruthy();
    expect(screen.queryByLabelText("Adjustment note for Ada Example")).toBeNull();
  });

  test("a frozen adjustment is shown, with its note", async () => {
    const user = userEvent.setup();
    const run = paid();
    run.rows[0] = { ...run.rows[0]!, adjustment: 30_000_00, adjustmentNote: "Bonus", net: 480_000_00 };
    serve({ runs: { [OCT]: run } });
    render(page());
    expect(cells(monthTable(), /Ada Example/)[1]).toBe("₸30,000");
    await user.click(button("Breakdown for Ada Example"));
    expect(screen.getByText(/^Adjustment:/).textContent).toBe("Adjustment: ₸30,000 (Bonus)");
  });

  test("reopen asks first", async () => {
    const user = userEvent.setup();
    serve({ runs: { [OCT]: paid() } });
    render(page());
    await user.click(button("Reopen"));
    expect(called(api.payroll.reopenRun)).not.toHaveBeenCalled();
    expect(screen.getByText(/^Reopen Oct 2026\?/)).toBeTruthy();
    await user.click(button("Keep it paid"));
    expect(called(api.payroll.reopenRun)).not.toHaveBeenCalled();
    await user.click(button("Reopen"));
    await user.click(button("Reopen month"));
    expect(called(api.payroll.reopenRun)).toHaveBeenCalledWith({ company: "kz", month: OCT });
  });
});

// ── People ──────────────────────────────────────────────────────────────────

describe("PayrollView: people", () => {
  test("adding a person asks for the monthly net and sends it in minor units, in the company's currency", async () => {
    const user = userEvent.setup();
    serve({ people: [] });
    render(page());
    await user.click(button("Add a person"));
    const form = dialog();
    expect(field<HTMLSelectElement>("Paid in", form).value).toBe("KZT");
    await user.type(field("Name", form), "Cal Example");
    await user.type(field("Title", form), "Designer");
    await user.selectOptions(field("Kind", form), "contractor");
    expect(form.queryByLabelText("Monthly gross")).toBeNull();
    await user.type(field("Monthly net", form), "350,000.50");
    fireEvent.change(field("Start date", form), { target: { value: "2026-10-01" } });
    await user.type(field("Notes", form), "Part time");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(called(api.payroll.createPerson)).toHaveBeenCalledWith({
      company: "kz",
      name: "Cal Example",
      title: "Designer",
      kind: "contractor",
      payBasis: "net",
      monthlyNet: 350_000_50,
      currency: "KZT",
      startDate: "2026-10-01",
      notes: "Part time",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("on Startup a new person is paid in dollars unless said otherwise", async () => {
    const user = userEvent.setup();
    serve({ people: [] });
    render(page("us"));
    await user.click(button("Add a person"));
    const form = dialog();
    expect(field<HTMLSelectElement>("Paid in", form).value).toBe("USD");
    await user.type(field("Name", form), "Dana Example");
    await user.type(field("Monthly net", form), "9000");
    await user.selectOptions(field("Paid in", form), "KZT");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(called(api.payroll.createPerson)).toHaveBeenCalledWith({
      company: "us",
      name: "Dana Example",
      kind: "employee",
      payBasis: "net",
      monthlyNet: 9_000_00,
      currency: "KZT",
    });
  });

  test.each([
    ["", "500000", "A person needs a name."],
    ["Cal Example", "", "The monthly net is not an amount."],
    ["Cal Example", "lots", "The monthly net is not an amount."],
    ["Cal Example", "-5", "The monthly net is not an amount."],
  ])("name %j with net %j is said before anything is sent", async (name, gross, message) => {
    const user = userEvent.setup();
    serve({ people: [] });
    render(page());
    await user.click(button("Add a person"));
    const form = dialog();
    if (name) await user.type(field("Name", form), name);
    if (gross) await user.type(field("Monthly net", form), gross);
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe(message);
    expect(called(api.payroll.createPerson)).not.toHaveBeenCalled();
  });

  test("a refused save is shown and the form stays open with what was typed", async () => {
    const user = userEvent.setup();
    serve({ people: [] });
    called(api.payroll.createPerson).mockRejectedValueOnce(
      new ConvexError("The payroll is full (200 people at most)."),
    );
    render(page());
    await user.click(button("Add a person"));
    await user.type(field("Name", dialog()), "Cal Example");
    await user.type(field("Monthly net", dialog()), "1");
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe("The payroll is full (200 people at most).");
    expect(field("Name", dialog()).value).toBe("Cal Example");
  });

  test("editing opens with the person's own values, keeps them through a live update, and clears with null", async () => {
    const user = userEvent.setup();
    serve({ people: [person("p1", "Ada Example", { title: "Engineer", startDate: "2026-01-05", notes: "Remote" })] });
    const view = render(page());
    await user.click(button("Edit Ada Example"));
    const form = dialog();
    expect(field("Name", form).value).toBe("Ada Example");
    expect(field("Monthly gross", form).value).toBe("500000");
    expect(field("Start date", form).value).toBe("2026-01-05");
    await user.clear(field("Monthly gross", form));
    await user.type(field("Monthly gross", form), "600000");
    await user.clear(field("Title", form));
    await user.clear(field("Notes", form));

    // The server sends the person again; what is typed stays.
    serve({ people: [person("p1", "Renamed Elsewhere", { monthlyGross: 1 })] });
    view.rerender(page());
    expect(field("Name", dialog()).value).toBe("Ada Example");
    expect(field("Monthly gross", dialog()).value).toBe("600000");

    fireEvent.change(field("End date", dialog()), { target: { value: "2026-12-31" } });
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(called(api.payroll.updatePerson)).toHaveBeenCalledWith({
      id: "p1",
      name: "Ada Example",
      title: null,
      kind: "employee",
      payBasis: "gross",
      monthlyGross: 600_000_00,
      currency: "KZT",
      startDate: "2026-01-05",
      endDate: "2026-12-31",
      notes: null,
    });
  });

  test("a person's time serving customers and on sales and marketing: 0 until typed, sent only when it is not", async () => {
    const user = userEvent.setup();
    serve({ people: [] });
    render(page());
    await user.click(button("Add a person"));
    const form = dialog();
    expect(field("Time serving customers (%)", form).value).toBe("0");
    expect(field("Time on sales and marketing (%)", form).value).toBe("0");
    await user.type(field("Name", form), "Cal Example");
    await user.type(field("Monthly net", form), "1000");
    await user.clear(field("Time on sales and marketing (%)", form));
    await user.type(field("Time on sales and marketing (%)", form), "40");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(called(api.payroll.createPerson)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Cal Example", salesPercent: 40 }),
    );
    const sent = called(api.payroll.createPerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("cogsPercent");
  });

  test("an edit sends a share only when it changed, and over 100% together is said before anything is sent", async () => {
    const user = userEvent.setup();
    serve({ people: [person("p1", "Ada Example", { cogsPercent: 30, salesPercent: 0 })] });
    render(page());
    await user.click(button("Edit Ada Example"));
    const form = dialog();
    expect(field("Time serving customers (%)", form).value).toBe("30");
    await user.clear(field("Time on sales and marketing (%)", form));
    await user.type(field("Time on sales and marketing (%)", form), "80");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe("Time serving customers and time on sales and marketing add up to more than 100%.");
    expect(called(api.payroll.updatePerson)).not.toHaveBeenCalled();

    await user.clear(field("Time on sales and marketing (%)", dialog()));
    await user.type(field("Time on sales and marketing (%)", dialog()), "20");
    await user.click(dialog().getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.updatePerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "p1", salesPercent: 20 });
    expect(sent).not.toHaveProperty("cogsPercent");
  });

  test("someone in a saved month can be archived but is offered no delete", async () => {
    const user = userEvent.setup();
    serve({ people: [ADA] });
    render(page());
    await user.click(button("Edit Ada Example"));
    expect(dialog().queryByRole("button", { name: "Delete" })).toBeNull();
    expect(dialog().getByText(/In a saved month, so not deleted/)).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Archive" }));
    expect(called(api.payroll.archivePerson)).toHaveBeenCalledWith({ id: "p1", archived: true });
  });

  test("someone in no saved month can be deleted, after a confirmation", async () => {
    const user = userEvent.setup();
    serve({ people: [BEN] });
    render(page());
    await user.click(button("Edit Ben Example"));
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    expect(called(api.payroll.removePerson)).not.toHaveBeenCalled();
    expect(dialog().getByText("Delete this person?")).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Keep" }));
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    expect(called(api.payroll.removePerson)).toHaveBeenCalledWith({ id: "p2" });
  });

  test("a refused delete is shown", async () => {
    const user = userEvent.setup();
    serve({ people: [BEN] });
    called(api.payroll.removePerson).mockRejectedValueOnce(
      new ConvexError("That person is in a saved month. End or archive them instead."),
    );
    render(page());
    await user.click(button("Edit Ben Example"));
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    expect(await alertText()).toBe("That person is in a saved month. End or archive them instead.");
  });

});

// ── Lines ───────────────────────────────────────────────────────────────────

describe("PayrollView: tax and contribution lines", () => {
  const list = (kind: "employees" | "contractors") =>
    screen.getByRole("table", { name: `Lines for ${kind}` });

  test("each kind's lines: who pays, the rate, and what the base is", () => {
    const income = line("l4", "Income", {
      lessLineIds: ["l1"],
      allowance: 50_000_00,
      baseCap: 700_000_00,
      order: 2,
    });
    const fee = line("l6", "Fee", { appliesTo: "contractor", rateBp: 1250 });
    serve({ lines: [PENSION, LEVY, income, fee] });
    render(page());
    const table = list("employees");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Line",
      "Paid by",
      "Rate",
      "Base",
      "On",
      "Order",
      "Actions",
    ]);
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toEqual([
      "Pension",
      "Levy",
      "Income",
    ]);
    // The cells that are text: who pays, the rate, the base. The rest are controls.
    expect(cells(table, "Pension").slice(0, 3)).toEqual(["Withheld from pay", "10%", "gross"]);
    expect(cells(table, "Levy").slice(0, 3)).toEqual(["Paid by the company", "3.5%", "gross"]);
    expect(cells(table, "Income")[2]).toBe(
      "gross − Pension − ₸50,000 allowance, capped at ₸700,000",
    );
    const rate = within(table).getAllByRole("cell", { name: "10%" })[0]!;
    expect(rate.className).toContain("text-right");
    expect(rate.className).toContain("font-num");
    // Each row keeps its controls, named for its line.
    const pension = within(within(table).getByRole("rowheader", { name: "Pension" }).closest("tr")!);
    expect(pension.getByRole("checkbox", { name: "Pension is on" })).toBeTruthy();
    expect(pension.getByRole("button", { name: "Move Pension up" })).toBeTruthy();
    expect(pension.getByRole("button", { name: "Move Pension down" })).toBeTruthy();
    expect(pension.getByRole("button", { name: "Edit Pension" })).toBeTruthy();
    expect(cells(list("contractors"), "Fee")[1]).toBe("12.5%");
  });

  test("a line with no rate says so in words", () => {
    serve({ lines: [PENSION, UNSET] });
    render(page());
    const row = within(list("employees")).getByRole("rowheader", { name: "Social tax" }).closest("tr")!;
    expect(within(row).getByText("Rate not set")).toBeTruthy();
    expect(row.textContent).not.toContain("0%");
  });

  test("no lines yet, and the usual ones are offered with no rate", async () => {
    const user = userEvent.setup();
    serve({ lines: [] });
    called(api.payroll.addUsualLines).mockResolvedValueOnce(7);
    render(page());
    expect(screen.getAllByText("No lines yet.")).toHaveLength(2);
    expect(screen.queryByRole("table", { name: /Lines for/ })).toBeNull();
    expect(screen.getByText(/Names only: every rate is left for you to type/)).toBeTruthy();
    await user.click(button("Add the usual lines for employees"));
    expect(called(api.payroll.addUsualLines)).toHaveBeenCalledWith({ company: "kz", appliesTo: "employee" });
    expect(await screen.findByText("7 lines added, each with no rate.")).toBeTruthy();
  });

  test("contractors get the same names with their own rates, from their own button", async () => {
    const user = userEvent.setup();
    serve({ lines: [] });
    called(api.payroll.addUsualLines).mockResolvedValueOnce(7);
    render(page());
    await user.click(button("Add the usual lines for contractors"));
    expect(called(api.payroll.addUsualLines)).toHaveBeenCalledWith({ company: "kz", appliesTo: "contractor" });
    expect(await screen.findByText("7 lines added, each with no rate.")).toBeTruthy();
  });

  test("what was said for one company is not said for the other", async () => {
    const user = userEvent.setup();
    serve({ lines: [] });
    called(api.payroll.addUsualLines).mockResolvedValueOnce(7);
    const view = render(page("kz"));
    await user.click(button("Add the usual lines for employees"));
    expect(await screen.findByText("7 lines added, each with no rate.")).toBeTruthy();
    view.rerender(page("us"));
    expect(screen.queryByText("7 lines added, each with no rate.")).toBeNull();
  });

  test("when the usual lines are all there, that is said", async () => {
    const user = userEvent.setup();
    serve();
    called(api.payroll.addUsualLines).mockResolvedValueOnce(0);
    render(page());
    await user.click(button("Add the usual lines for employees"));
    expect(await screen.findByText("The usual lines are all there already.")).toBeTruthy();
  });

  test("adding a line: the rate is typed as a percentage and stored as basis points", async () => {
    const user = userEvent.setup();
    serve({ lines: [PENSION] });
    render(page());
    await user.click(button("Add a line for employees"));
    const form = dialog();
    await user.type(field("Name", form), "Income");
    await user.selectOptions(field("Paid by", form), "company");
    await user.type(field("Rate (%)", form), "12.5");
    await user.click(form.getByRole("checkbox", { name: "Pension" }));
    await user.type(field("Allowance", form), "50,000");
    await user.type(field("Cap", form), "700000");
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(called(api.payroll.createLine)).toHaveBeenCalledWith({
      company: "kz",
      appliesTo: "employee",
      name: "Income",
      paidBy: "company",
      rateBp: 1250,
      lessLineIds: ["l1"],
      allowance: 50_000_00,
      baseCap: 700_000_00,
      active: true,
    });
  });

  test("a rate left blank is sent as no rate, never as zero", async () => {
    const user = userEvent.setup();
    serve({ lines: [] });
    render(page());
    await user.click(button("Add a line for contractors"));
    await user.type(field("Name", dialog()), "Fee");
    await user.click(dialog().getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.createLine).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({
      company: "kz",
      appliesTo: "contractor",
      name: "Fee",
      paidBy: "employee",
      lessLineIds: [],
      allowance: 0,
      active: true,
    });
    expect(sent).not.toHaveProperty("rateBp");
  });

  test.each([
    ["Rate (%)", "12.345", "A rate is from 0% to 100%, with two decimals at most."],
    ["Rate (%)", "150", "A rate is from 0% to 100%, with two decimals at most."],
    ["Allowance", "some", "The allowance is not an amount."],
    ["Cap", "-1", "The cap is not an amount."],
  ])("%s of %j is said before anything is sent", async (label, value, message) => {
    const user = userEvent.setup();
    serve({ lines: [] });
    render(page());
    await user.click(button("Add a line for employees"));
    await user.type(field("Name", dialog()), "Income");
    await user.type(field(label, dialog()), value);
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe(message);
    expect(called(api.payroll.createLine)).not.toHaveBeenCalled();
  });

  test("editing a line: it cannot subtract itself, and clearing the rate and the cap sends null", async () => {
    const user = userEvent.setup();
    const income = line("l4", "Income", { lessLineIds: ["l1"], baseCap: 700_000_00, order: 2 });
    serve({ lines: [PENSION, LEVY, income, line("l6", "Fee", { appliesTo: "contractor" })] });
    render(page());
    await user.click(button("Edit Income"));
    const form = dialog();
    expect(field("Rate (%)", form).value).toBe("10");
    expect(field("Cap", form).value).toBe("700000");
    // The other lines of its kind, and only those.
    expect(form.getAllByRole("checkbox").map((box) => box.parentElement!.textContent)).toEqual([
      "Pension",
      "Levy",
      "On",
    ]);
    expect((form.getByRole("checkbox", { name: "Pension" }) as HTMLInputElement).checked).toBe(true);
    await user.click(form.getByRole("checkbox", { name: "Levy" }));
    await user.clear(field("Rate (%)", form));
    await user.clear(field("Cap", form));
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(called(api.payroll.updateLine)).toHaveBeenCalledWith({
      id: "l4",
      name: "Income",
      paidBy: "employee",
      rateBp: null,
      lessLineIds: ["l1", "l2"],
      allowance: 0,
      baseCap: null,
      active: true,
    });
  });

  test("a refused line is shown; deleting one asks first", async () => {
    const user = userEvent.setup();
    serve({ lines: [PENSION] });
    called(api.payroll.updateLine).mockRejectedValueOnce(
      new ConvexError("Those lines subtract each other in a circle."),
    );
    render(page());
    await user.click(button("Edit Pension"));
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe("Those lines subtract each other in a circle.");
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    expect(called(api.payroll.removeLine)).not.toHaveBeenCalled();
    expect(dialog().getByText("Delete this line?")).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Delete" }));
    expect(called(api.payroll.removeLine)).toHaveBeenCalledWith({ id: "l1" });
  });

  test("the lines download as words: the switch and the arrows are not in the file", () => {
    serve({ lines: [PENSION, line("l2", "Levy", { active: false, order: 1 })] });
    render(page());
    expect(readTable(list("employees"))).toEqual([
      ["Line", "Paid by", "Rate", "Base"],
      ["Pension", "Withheld from pay", "10%", "gross"],
      ["Levy Switched off", "Withheld from pay", "10%", "gross"],
    ]);
  });

  test("a line is switched off and on from its row", async () => {
    const user = userEvent.setup();
    serve({ lines: [PENSION, line("l2", "Levy", { active: false, order: 1 })] });
    render(page());
    const on = screen.getByRole("checkbox", { name: "Pension is on" }) as HTMLInputElement;
    const off = screen.getByRole("checkbox", { name: "Levy is on" }) as HTMLInputElement;
    expect([on.checked, off.checked]).toEqual([true, false]);
    await user.click(on);
    expect(called(api.payroll.updateLine)).toHaveBeenCalledWith({ id: "l1", active: false });
    await user.click(off);
    expect(called(api.payroll.updateLine)).toHaveBeenCalledWith({ id: "l2", active: true });
  });

  test("lines move up and down within their kind; the ends have nowhere to go", async () => {
    const user = userEvent.setup();
    const third = line("l4", "Income", { order: 2 });
    serve({ lines: [PENSION, LEVY, third, line("l6", "Fee", { appliesTo: "contractor" })] });
    render(page());
    expect(button("Move Pension up").getAttribute("aria-disabled")).toBe("true");
    expect(button("Move Income down").getAttribute("aria-disabled")).toBe("true");
    await user.click(button("Move Pension up"));
    expect(called(api.payroll.reorderLines)).not.toHaveBeenCalled();
    await user.click(button("Move Pension down"));
    expect(called(api.payroll.reorderLines)).toHaveBeenCalledWith({
      company: "kz",
      appliesTo: "employee",
      ids: ["l2", "l1", "l4"],
    });
    await user.click(button("Move Income up"));
    expect(called(api.payroll.reorderLines)).toHaveBeenLastCalledWith({
      company: "kz",
      appliesTo: "employee",
      ids: ["l1", "l4", "l2"],
    });
  });

  test("a refused switch is shown", async () => {
    const user = userEvent.setup();
    serve({ lines: [PENSION] });
    called(api.payroll.updateLine).mockRejectedValueOnce(new ConvexError("That line no longer exists."));
    render(page());
    await user.click(screen.getByRole("checkbox", { name: "Pension is on" }));
    expect(await alertText()).toBe("That line no longer exists.");
  });
});

// ── History ─────────────────────────────────────────────────────────────────

describe("PayrollView: history", () => {
  test("nothing paid yet", () => {
    serve();
    render(page());
    expect(screen.getByText("No month has been marked paid yet.")).toBeTruthy();
  });

  test("paid months with people and totals, each opening that month; a stored draft is not listed", async () => {
    const user = userEvent.setup();
    serve({
      runs: {
        [SEP]: monthOf([ADA], [PENSION, LEVY], { status: "paid", paidOn: "2026-10-05" }, SEP),
        [OCT]: monthOf([ADA, BEN], [PENSION, UNSET]),
      },
    });
    render(page());
    const history = screen.getByRole("table", { name: "Paid months" });
    expect(within(history).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Month",
      "Status",
      "People",
      "Gross",
      "Withheld",
      "Net",
      "Company-paid",
      "Total cost",
      "Actions",
    ]);
    expect(within(history).queryByRole("rowheader", { name: "Oct 2026" })).toBeNull();
    expect(cells(history, "Sep 2026")).toEqual([
      "Paid on Oct 5",
      "1",
      "₸500,000",
      "₸50,000",
      "₸450,000",
      "₸17,500",
      "₸517,500",
      "Open Sep 2026",
    ]);

    await user.click(button("Open Sep 2026"));
    const month = screen.getByRole("heading", { level: 2, name: "Sep 2026" });
    expect(document.activeElement).toBe(month);
    expect(cells(monthTable(), "Total (1 person)")[5]).toBe("₸517,500");
  });
});

// ── Pay entered as net ──────────────────────────────────────────────────────

describe("PayrollView: pay entered as net", () => {
  // Pension 10% withheld; income 10% withheld on gross less pension less a
  // 50,000 allowance; levy 3.5% paid by the company. 500,000 gross is 410,000 net.
  const INCOME = line("l4", "Income", { lessLineIds: ["l1"], allowance: 50_000_00, order: 2 });
  const LINES = [PENSION, LEVY, INCOME];
  const NIA = person("p5", "Nia Example", {
    payBasis: "net",
    monthlyGross: null,
    monthlyNet: 410_000_00,
  });
  const liveLine = () => dialog().getByTestId("gross-line").textContent;

  test("the form asks for net, and says the gross it works out to as it is typed", async () => {
    const user = userEvent.setup();
    serve({ people: [], lines: LINES });
    render(page());
    await user.click(button("Add a person"));
    const form = dialog();
    expect(field("Monthly net", form)).toBeTruthy();
    expect(form.getByRole("button", { name: "Enter gross instead" })).toBeTruthy();
    expect(liveLine()).toBe(
      "What they receive each month, after everything withheld. The gross is worked out from the lines for employees.",
    );
    await user.type(field("Name", form), "Nia Example");
    await user.type(field("Monthly net", form), "410,000");
    expect(liveLine()).toBe("Gross works out to ₸500,000 (net ₸410,000 after ₸90,000 withheld)");
    // The line follows what is typed, and the person's kind.
    await user.clear(field("Monthly net", form));
    await user.type(field("Monthly net", form), "410000.50");
    expect(liveLine()).toContain("net ₸410,000.50 after");
    await user.selectOptions(field("Kind", form), "contractor");
    expect(liveLine()).toBe("Gross works out to ₸410,000.50 (net ₸410,000.50 after ₸0 withheld)");
    await user.selectOptions(field("Kind", form), "employee");
    await user.clear(field("Monthly net", form));
    await user.type(field("Monthly net", form), "410000");
    await user.click(form.getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.createPerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({
      company: "kz",
      name: "Nia Example",
      kind: "employee",
      payBasis: "net",
      monthlyNet: 410_000_00,
      currency: "KZT",
    });
    // The gross is the server's to work out each month: none is sent.
    expect(sent).not.toHaveProperty("monthlyGross");
  });

  test("switching to gross sends the gross and no net, and back again", async () => {
    const user = userEvent.setup();
    serve({ people: [], lines: LINES });
    render(page());
    await user.click(button("Add a person"));
    const form = dialog();
    await user.type(field("Name", form), "Gus Example");
    await user.click(form.getByRole("button", { name: "Enter gross instead" }));
    expect(form.queryByLabelText("Monthly net")).toBeNull();
    await user.type(field("Monthly gross", form), "500000");
    expect(liveLine()).toContain("before anything is withheld");
    expect(form.getByRole("button", { name: "Enter net instead" })).toBeTruthy();
    await user.click(form.getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.createPerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({
      company: "kz",
      name: "Gus Example",
      kind: "employee",
      payBasis: "gross",
      monthlyGross: 500_000_00,
      currency: "KZT",
    });
    expect(sent).not.toHaveProperty("monthlyNet");
  });

  test("a gross that is not an amount is said in its own words", async () => {
    const user = userEvent.setup();
    serve({ people: [] });
    render(page());
    await user.click(button("Add a person"));
    await user.type(field("Name", dialog()), "Gus Example");
    await user.click(dialog().getByRole("button", { name: "Enter gross instead" }));
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(await alertText()).toBe("The monthly gross is not an amount.");
  });

  test.each([
    [
      [line("l1", "Pension", { rateBp: null }), LEVY],
      "KZT",
      "Gross cannot be worked out until 1 rate is set.",
    ],
    [
      [line("l1", "Pension", { rateBp: null }), line("l7", "Medical", { rateBp: null, order: 3 })],
      "KZT",
      "Gross cannot be worked out until 2 rates are set.",
    ],
    [
      [PENSION, INCOME],
      "USD",
      "Gross cannot be worked out: 1 line withheld from pay has an allowance or a cap in tenge, which is not computed for someone paid in US dollars.",
    ],
    [
      [line("l1", "Pension", { rateBp: 10_000 })],
      "KZT",
      "Gross cannot be worked out: with these rates, what is withheld leaves no gross that gives this net.",
    ],
  ])("the form says when the gross cannot be worked out, and guesses none", async (lines, currency, said) => {
    const user = userEvent.setup();
    serve({ people: [], lines });
    render(page());
    await user.click(button("Add a person"));
    await user.selectOptions(field("Paid in", dialog()), currency);
    await user.type(field("Monthly net", dialog()), "410000");
    expect(liveLine()).toBe(said);
    expect(liveLine()).not.toContain("works out to");
  });

  test("a company-paid rate not set does not stand in the way of the gross", async () => {
    const user = userEvent.setup();
    serve({ people: [], lines: [PENSION, UNSET] });
    render(page());
    await user.click(button("Add a person"));
    await user.type(field("Monthly net", dialog()), "450000");
    expect(liveLine()).toBe("Gross works out to ₸500,000 (net ₸450,000 after ₸50,000 withheld)");
  });

  test("editing someone entered as net opens on their net and sends it back as net", async () => {
    const user = userEvent.setup();
    serve({ people: [NIA], lines: LINES });
    render(page());
    await user.click(button("Edit Nia Example"));
    const form = dialog();
    expect(field("Monthly net", form).value).toBe("410000");
    expect(liveLine()).toBe("Gross works out to ₸500,000 (net ₸410,000 after ₸90,000 withheld)");
    await user.click(form.getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.updatePerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "p5", payBasis: "net", monthlyNet: 410_000_00 });
    expect(sent).not.toHaveProperty("monthlyGross");
  });

  test("someone entered as gross opens on their gross, and can be switched to net", async () => {
    const user = userEvent.setup();
    serve({ people: [BEN], lines: LINES });
    render(page());
    await user.click(button("Edit Ben Example"));
    const form = dialog();
    expect(field("Monthly gross", form).value).toBe("200000");
    await user.click(form.getByRole("button", { name: "Enter net instead" }));
    await user.clear(field("Monthly net", form));
    await user.type(field("Monthly net", form), "180000");
    await user.click(form.getByRole("button", { name: "Save" }));
    const sent = called(api.payroll.updatePerson).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "p2", payBasis: "net", monthlyNet: 180_000_00 });
    expect(sent).not.toHaveProperty("monthlyGross");
  });

  test("the month table works the gross out from the net, and the breakdown says so", async () => {
    const user = userEvent.setup();
    serve({ people: [NIA], lines: LINES });
    render(page());
    const table = monthTable();
    expect(cells(table, /Nia Example/).slice(0, 1)).toEqual(["₸500,000"]);
    expect(cells(table, /Nia Example/).slice(2, 6)).toEqual([
      "₸90,000",
      "₸410,000",
      "₸17,500",
      "₸517,500",
    ]);
    expect(screen.queryByText(/worked out from a net/)).toBeNull();
    await user.click(button("Breakdown for Nia Example"));
    expect(screen.getByText("Gross worked out from a net of ₸410,000")).toBeTruthy();
    expect(cells(screen.getByRole("table", { name: "Lines for Nia Example" }), "Income")).toEqual([
      "Withheld from pay",
      "₸400,000",
      "10%",
      "₸40,000",
    ]);
  });

  test("someone entered as gross has no such line in their breakdown", async () => {
    const user = userEvent.setup();
    serve({ people: [ADA], lines: [PENSION] });
    render(page());
    await user.click(button("Breakdown for Ada Example"));
    expect(screen.queryByText(/worked out from a net/)).toBeNull();
  });

  test("a changed net is in the table at once: the gross is worked out again", () => {
    serve({ people: [{ ...NIA, monthlyNet: 400_000_00 }], lines: LINES });
    render(page());
    expect(cells(monthTable(), /Nia Example/)[3]).toBe("₸400,000");
    expect(cells(monthTable(), /Nia Example/)[0]).not.toBe("₸500,000");
  });

  test("a withheld rate not set: no gross, withheld or cost is shown as a number, and the month cannot be paid", async () => {
    const user = userEvent.setup();
    const lines = [line("l1", "Pension", { rateBp: null }), LEVY];
    serve({ people: [NIA, BEN], lines });
    render(page());
    const table = monthTable();
    const nia = cells(table, /Nia Example/);
    expect([nia[0], nia[2], nia[3], nia[4], nia[5]]).toEqual(["—", "—", "₸410,000", "—", "—"]);
    const row = within(table).getByRole("rowheader", { name: /Nia Example/ });
    expect(
      within(row).getByText("Incomplete: gross cannot be worked out until 1 rate is set"),
    ).toBeTruthy();
    const total = cells(table, "Total (2 people)");
    expect(total[0]).toBe("Not known yet");
    expect(total[3]).toBe("₸610,000");
    expect(total[5]).toBe("Not known yet");
    expect(button("Mark as paid").getAttribute("aria-disabled")).toBe("true");
    await user.click(button("Mark as paid"));
    expect(called(api.payroll.markPaid)).not.toHaveBeenCalled();

    await user.click(button("Breakdown for Nia Example"));
    expect(
      screen.getByText("Gross not worked out from a net of ₸410,000: 1 rate is not set"),
    ).toBeTruthy();
    const breakdown = screen.getByRole("table", { name: "Lines for Nia Example" });
    expect(cells(breakdown, "Pension")).toEqual(["Withheld from pay", "—", "Rate not set", "Not computed"]);
    expect(cells(breakdown, "Levy")).toEqual([
      "Paid by the company",
      "—",
      "3.5%",
      "Not computed: no gross",
    ]);
  });
});

// ── What it all comes to ────────────────────────────────────────────────────

describe("PayrollView: the figures are said once", () => {
  test("no summary block repeats the table's totals", () => {
    serve();
    render(page());
    expect(screen.queryByRole("region", { name: "Payroll cost" })).toBeNull();
    // Each total is in the table's foot, and nowhere else on the page.
    expect(screen.getAllByText("₸717,500")).toHaveLength(1);
  });

  test("a teammate is shown none of it", () => {
    serve();
    render(as("cofounder", <PayrollView />));
    expect(screen.queryByRole("region", { name: "Month" })).toBeNull();
    expect(screen.queryByText(/₸/)).toBeNull();
  });
});
