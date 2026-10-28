// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { summarise } from "@convex/lib/costs";
import { AREAS, type Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { mockConvex } from "@/test-support/convex";
import { COSTS_NOT_YOURS, CostsView } from "./costs-view";
import { PAY_ELSEWHERE } from "./planned-burn";
import { CATEGORY_TONE, QUICK_ADD } from "./shared";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed "now", built from local parts so the month is October in any zone.
const NOW = new Date(2026, 9, 13, 12).getTime();
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const nav = vi.hoisted(() => ({ query: "", replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/costs",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));

// The Finance page's own figures: what it reads and what it works out are
// its own tests' business. Here only what this page does with the average.
const finance = vi.hoisted(() => ({
  average: null as { value: number; months: string[]; expected: string[] } | null,
  scorecardUsed: 0,
}));
vi.mock("@/hooks/use-scorecard", () => ({
  useScorecard: () => {
    finance.scorecardUsed += 1;
    return { tiles: [], sources: {}, money: { tiles: [], mercuryReadAt: null } };
  },
}));
vi.mock("@/lib/metrics/finance", () => ({
  financeSummary: () => ({ average: finance.average }),
}));

// Every vendor, note and amount here is made up.
const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  category: "software" as string,
  amount: 100_00,
  currency: "USD" as "USD" | "KZT",
  cadence: "monthly" as string,
  startsOn: "2026-01",
  endsOn: null as string | null,
  variable: false,
  bucket: null as string | null,
  paidBy: null as string | null,
  note: null as string | null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null as number | null,
  ...extra,
});
type Row = ReturnType<typeof line>;

const AWS = line("c1", "Example Cloud", { category: "cloud", amount: 400_00, variable: true, paidBy: "Mercury card" });
const TOOL = line("c2", "Example Tool");
const YEARLY = line("c3", "Example Yearly", { cadence: "yearly", amount: 1_200_00, note: "Renews in January" });
const RENT = line("c4", "Example Rent", { category: "office", cadence: "quarterly", amount: 900_00, startsOn: "2026-10" });
const ONCE = line("c5", "Example Audit", { category: "services", cadence: "once", amount: 2_000_00, startsOn: "2026-11" });
const ENDED = line("c6", "Example Ended", { category: "travel", endsOn: "2026-09" });
const ARCHIVED = line("c7", "Example Archived", { category: "marketing", archivedAt: 5 });
const ALL = [AWS, TOOL, YEARLY, RENT, ONCE, ENDED, ARCHIVED];

let convex: ReturnType<typeof mockConvex>;

/** What the queries answer: the lines, and the summary the server would work out from them. */
function serve(lines: Row[] = ALL, options: { fx?: number | null; company?: CompanyId } = {}) {
  const fx = options.fx == null ? null : { rate: options.fx, periodStart: "2026-09-01" };
  const company = options.company ?? "us";
  convex.setQuery(api.costs.list, lines);
  convex.setQueryBy(api.costs.summary, (args) => ({
    company,
    ...summarise({
      lines: lines as never,
      month: (args as { month: string }).month,
      companyCurrency: company === "us" ? "USD" : "KZT",
      fxUsdKzt: fx?.rate ?? null,
    }),
    fx,
  }));
}

const person = (id: string, monthlyGross: number) => ({
  id,
  name: `Example Person ${id}`,
  title: null,
  kind: "employee",
  payBasis: "gross",
  monthlyGross,
  monthlyNet: null,
  currency: "USD",
  startDate: null,
  endDate: null,
  notes: null,
  order: 0,
  archivedAt: null,
  removable: true,
});
const payLine = (rateBp: number | null) => ({
  id: "l1",
  name: "Made-up levy",
  appliesTo: "employee",
  paidBy: "company",
  rateBp,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  order: 0,
  active: true,
});
function servePayroll(rateBp: number | null = 1000) {
  convex.setQuery(api.payroll.listPeople, [person("p1", 5_000_00), person("p2", 4_000_00)]);
  convex.setQuery(api.payroll.listLines, [payLine(rateBp)]);
}

function page(areas: readonly Area[] = AREAS, company: CompanyId = "us", owner = areas === AREAS) {
  return (
    <ViewerProvider
      viewer={{
        role: owner ? "owner" : "engineer",
        companies: ["us", "kz"],
        areas,
        email: "someone@example.com",
        name: null,
      }}
    >
      <CompanyProvider allowed={[company]}>
        <CostsView />
      </CompanyProvider>
    </ViewerProvider>
  );
}

const tile = (name: string) => within(screen.getByRole("group", { name }));
const table = () => screen.getByRole("table", { name: "Cost lines" });
const rowNames = (within_: HTMLElement) =>
  within(within_)
    .getAllByRole("rowheader")
    .map((cell) => cell.textContent);
const cells = (within_: HTMLElement, header: string | RegExp) =>
  within(within(within_).getByRole("rowheader", { name: header }).closest("tr")!)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
const dialog = () => within(screen.getByRole("dialog"));
const sentTo = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([asked]) => getFunctionName(asked as never) === getFunctionName(ref))
    .map(([, args]) => args);

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  nav.query = "";
  nav.replaced = [];
  finance.average = null;
  finance.scorecardUsed = 0;
});
afterEach(cleanup);

describe("whose page it is", () => {
  test("someone without Costs is told so, and no query is sent: not even with Payroll and Finance", () => {
    serve();
    servePayroll();
    render(page(AREAS.filter((area) => area !== "costs"), "us", false));
    expect(screen.getByText(COSTS_NOT_YOURS)).toBeTruthy();
    expect(screen.queryByText("Example Cloud")).toBeNull();
    const sent = vi.mocked(useQuery).mock.calls;
    expect(sent.length).toBeGreaterThan(0);
    for (const [, args] of sent) expect(args).toBe("skip");
  });

  test("the owner reads that nobody else can open it", () => {
    serve();
    servePayroll();
    render(page());
    expect(screen.getByText(/Only you can open this page: payroll and costs are the owner's alone\./)).toBeTruthy();
    expect(screen.queryByText(/tick on the Team page/)).toBeNull();
  });

  test("the header says when a line it lists last changed, archived ones included, with no colour", () => {
    serve([AWS, { ...TOOL, updatedAt: NOW - 3 * 60 * 60 * 1000 }, { ...ARCHIVED, updatedAt: NOW - 60 * 60 * 1000 }]);
    servePayroll();
    render(page());
    expect(
      screen.getByRole("button", { name: /^Typed in · last change 1 hour ago\. / }),
    ).toBeTruthy();
  });

  test("the queries are for the company in view and the browser's month", () => {
    serve([], { company: "kz" });
    render(page(["costs"], "kz"));
    expect(sentTo(api.costs.list)).toContainEqual({ company: "kz" });
    expect(sentTo(api.costs.summary)).toContainEqual({ company: "kz", month: "2026-10" });
  });
});

describe("the head tiles", () => {
  test("run-rate, cash due, the next three months and a year, each in its own tile", () => {
    serve();
    render(page(["costs"]));
    // 400 + 100 + 1200/12 + 900/3
    expect(tile("Monthly run-rate").getByText("$900.00")).toBeTruthy();
    // 400 + 100 + the quarter's 900
    expect(tile("Cash due this month").getByText("$1,400.00")).toBeTruthy();
    // Nov 500 + 2000; Dec 500; Jan 500 + 900 + 1200
    expect(tile("Next 3 months, cash due").getByText("$5,600.00")).toBeTruthy();
    expect(tile("Yearly, at this rate").getByText("$10,800.00")).toBeTruthy();
    expect(screen.getByText(/1 of 4 lines are estimates\./)).toBeTruthy();
  });

  test("two currencies and no rate: Not known yet, with each currency's own figure", () => {
    serve([AWS, line("k1", "Example KZ", { currency: "KZT", amount: 500_000_00 })]);
    render(page(["costs"]));
    const runRate = tile("Monthly run-rate");
    expect(runRate.getByText("Not known yet")).toBeTruthy();
    expect(runRate.getByText("$400.00")).toBeTruthy();
    expect(runRate.getByText("₸500,000")).toBeTruthy();
    expect(screen.getByText(/no USD\/KZT rate is on record, so they are not added together/)).toBeTruthy();
  });

  test("two currencies and a rate: one total in dollars, the rate named", () => {
    serve([AWS, line("k1", "Example KZ", { currency: "KZT", amount: 500_000_00 })], { fx: 500 });
    render(page(["costs"]));
    expect(tile("Monthly run-rate").getByText("$1,400.00")).toBeTruthy();
    expect(screen.getByText(/in US dollars at 500 tenge to the dollar, the rate stored for Sep 2026/)).toBeTruthy();
  });
});

describe("planned burn", () => {
  const planned = () => tile("Run-rate incl. pay, a month");

  test("with Payroll too: costs plus payroll's total cost, said as such", () => {
    serve();
    servePayroll();
    render(page(["costs", "payroll"]));
    expect(sentTo(api.payroll.listPeople)).toContainEqual({ company: "us" });
    expect(planned().getByText("Costs and pay, a month")).toBeTruthy();
    // 900 of costs + 9,000 gross + 10% on top
    expect(planned().getByText("$10,800.00")).toBeTruthy();
    expect(planned().getByText(/Run-rate costs \$900\.00 \+ pay \$9,900\.00, for Oct 2026/)).toBeTruthy();
    expect(screen.queryByText(PAY_ELSEWHERE)).toBeNull();
  });

  test("without Payroll: costs only, the line says where pay is, and nothing of pay is asked for", () => {
    serve();
    servePayroll();
    render(page(["costs", "finance"]));
    expect(planned().getByText("Costs only, a month")).toBeTruthy();
    expect(planned().getByText("$900.00")).toBeTruthy();
    expect(planned().getByText(PAY_ELSEWHERE)).toBeTruthy();
    expect(PAY_ELSEWHERE).toBe("Pay is not included: it is on the Payroll page.");
    for (const args of [...sentTo(api.payroll.listPeople), ...sentTo(api.payroll.listLines)]) {
      expect(args).toBe("skip");
    }
    expect(document.body.textContent).not.toContain("Example Person");
    expect(document.body.textContent).not.toContain("9,900");
  });

  test("payroll's cost not known (a rate not set): pay is left out and the reason is said", () => {
    serve();
    servePayroll(null);
    render(page(["costs", "payroll"]));
    expect(planned().getByText("Costs only, a month")).toBeTruthy();
    expect(planned().getByText("$900.00")).toBeTruthy();
    expect(planned().getByText(/Pay is not included: its total cost is not known yet\. Set the rates on the/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("$9,900.00");
  });

  test("without Finance there is no actual burn, and the scorecard is not read", () => {
    serve();
    servePayroll();
    render(page(["costs", "payroll"]));
    expect(screen.queryByRole("group", { name: "Run-rate incl. pay vs actual" })).toBeNull();
    expect(finance.scorecardUsed).toBe(0);
  });

  test("with Finance and Payroll: the Finance page's net burn, and the difference", () => {
    serve();
    servePayroll();
    finance.average = { value: 9_300, months: ["2026-07-01", "2026-08-01", "2026-09-01"], expected: [] };
    render(page(["costs", "payroll", "finance"]));
    const versus = tile("Run-rate incl. pay vs actual");
    expect(versus.getByText("$9,300")).toBeTruthy();
    expect(versus.getByText("The run-rate is $1,500.00 above the actual net burn.")).toBeTruthy();
  });

  test("a tenge plan is set against the dollar burn at the stored rate, which is said", () => {
    serve([line("k1", "Example KZ", { currency: "KZT", amount: 500_000_00 })], { fx: 500, company: "kz" });
    convex.setQuery(api.payroll.listPeople, []);
    convex.setQuery(api.payroll.listLines, []);
    convex.setQuery(api.metrics.series, []);
    finance.average = { value: 900, months: ["2026-09-01"], expected: [] };
    render(page(["costs", "payroll", "finance"], "kz"));
    const versus = tile("Run-rate incl. pay vs actual");
    expect(versus.getByText("The run-rate is $100.00 above the actual net burn.")).toBeTruthy();
    expect(versus.getByText("The run-rate is $1,000.00 at 500 tenge to the dollar.")).toBeTruthy();
    expect(tile("Run-rate incl. pay, a month").getByText("₸500,000")).toBeTruthy();
  });

  test("no actual burn on record: Not known yet, never a comparison with zero", () => {
    serve();
    servePayroll();
    render(page(["costs", "payroll", "finance"]));
    const versus = tile("Run-rate incl. pay vs actual");
    expect(versus.getAllByText(/Not known yet/)).toHaveLength(2);
    expect(versus.queryByText(/above|below/)).toBeNull();
  });

  test("with Finance and no Payroll: the actual is shown and the two are not compared", () => {
    serve();
    finance.average = { value: 9_300, months: ["2026-09-01"], expected: [] };
    render(page(["costs", "finance"]));
    const versus = tile("Run-rate incl. pay vs actual");
    expect(versus.getByText("$9,300")).toBeTruthy();
    expect(versus.getByText("Not compared: pay is not in the run-rate.")).toBeTruthy();
  });
});

describe("by category", () => {
  test("a bar for each category with something recurring, the largest first, its value written", () => {
    serve();
    render(page(["costs"]));
    const group = screen.getByRole("group", { name: "Run-rate by category" });
    const rows = within(group).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Cloud$400.00", "Office$300.00", "Software$200.00"]);
    const bars = [...group.querySelectorAll<HTMLElement>("[data-bar]")];
    expect(bars.map((bar) => [bar.dataset.bar, bar.style.width])).toEqual([
      ["cloud", "100%"],
      ["office", "75%"],
      ["software", "50%"],
    ]);
    // One hue: the bars differ in length, not in kind.
    expect(new Set(bars.map((bar) => bar.style.backgroundColor))).toEqual(new Set(["var(--chart-1)"]));
  });

  test("twelve months of cash due, this month first", () => {
    serve();
    render(page(["costs"]));
    const chart = screen.getByRole("group", { name: "Cash due by month" });
    const months = within(chart).getAllByRole("img");
    expect(months).toHaveLength(12);
    expect(months[0]!.getAttribute("aria-label")).toBe("Oct 2026: Cash due $1,400.00");
    expect(months[1]!.getAttribute("aria-label")).toBe("Nov 2026: Cash due $2,500.00");
    expect(months[11]!.getAttribute("aria-label")).toMatch(/^Sep 2027/);
  });

  test("two currencies and no rate: a chart for each, never one scale for both", () => {
    serve([AWS, line("k1", "Example KZ", { currency: "KZT", amount: 500_000_00 })]);
    render(page(["costs"]));
    expect(screen.getByRole("group", { name: "Run-rate by category, in US dollars" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Run-rate by category, in tenge" })).toBeTruthy();
  });
});

describe("the table", () => {
  test("the lines in force, by category then name; ended and archived ones are folded away", () => {
    serve();
    render(page(["costs"]));
    expect(rowNames(table()).slice(0, 5)).toEqual([
      "Example Cloud≈ estimate",
      "Example Tool",
      "Example Yearly",
      "Example Rent",
      "Example Audit",
    ]);
    const ended = screen.getByRole("table", { name: "Ended and archived cost lines" });
    expect(rowNames(ended)).toEqual(["Example Archived", "Example Ended"]);
    expect(ended.closest("details")!.open).toBe(false);
    expect(within(ended.closest("details")!).getByText("Ended (2)")).toBeTruthy();
  });

  test("a row: the chip, what it counts as, the amount, the cadence, the monthly equivalent, since, until, paid by, the note", () => {
    serve();
    render(page(["costs"]));
    expect(cells(table(), /Example Cloud/).slice(0, 9)).toEqual([
      "Cloud",
      "Cost of serving customersby category",
      "≈ about $400.00",
      "Monthly",
      "≈ about $400.00",
      "Jan 2026",
      "—",
      "Mercury card",
      "—",
    ]);
    expect(cells(table(), "Example Yearly").slice(2, 5)).toEqual(["$1,200.00", "Yearly", "$100.00"]);
    expect(cells(table(), "Example Yearly")[8]).toBe("Renews in January");
    expect(cells(table(), "Example Audit").slice(4, 6)).toEqual(["One-off", "Nov 2026Not started"]);
  });

  test("each category wears its one colour, from the one map", () => {
    serve();
    render(page(["costs"]));
    const chip = within(table()).getByText("Office").closest("[data-slot='kind-tag']") as HTMLElement;
    expect(chip.dataset.tone).toBe(CATEGORY_TONE.office);
    expect(Object.keys(CATEGORY_TONE)).toHaveLength(8);
  });

  test("totals: the monthly equivalents of the lines that have started, per currency", () => {
    serve([...ALL, line("k1", "Example KZ", { currency: "KZT", amount: 500_000_00 })]);
    render(page(["costs"]));
    expect(cells(table(), "Total a month, USD")[4]).toBe("$900.00");
    expect(cells(table(), "Total a month, KZT")[4]).toBe("₸500,000");
  });

  test("a header that sorts is a button, says how the table is sorted, and writes the view to the address", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    const header = (name: string) => within(table()).getByRole("columnheader", { name });
    for (const name of ["Name", "Category", "Monthly equivalent"]) {
      expect(header(name).getAttribute("aria-sort")).toBe("none");
    }
    expect(header("Amount").getAttribute("aria-sort")).toBeNull();
    await user.click(within(header("Monthly equivalent")).getByRole("button"));
    expect(nav.replaced).toEqual(["/costs?sort=monthly&dir=asc"]);
  });

  test("the address decides the order and the filter", () => {
    serve();
    nav.query = "sort=monthly&dir=desc";
    render(page(["costs"]));
    expect(rowNames(table()).slice(0, 5)).toEqual([
      "Example Cloud≈ estimate",
      "Example Rent",
      "Example Tool",
      "Example Yearly",
      "Example Audit",
    ]);
    expect(
      within(table()).getByRole("columnheader", { name: "Monthly equivalent" }).getAttribute("aria-sort"),
    ).toBe("descending");
    cleanup();
    nav.query = "category=software";
    render(page(["costs"]));
    expect(rowNames(table())).toEqual(["Example Tool", "Example Yearly", "Total a month, USD"]);
    expect(cells(table(), "Total a month, USD")[4]).toBe("$200.00");
    expect(screen.queryByRole("table", { name: "Ended and archived cost lines" })).toBeNull();
  });

  test("choosing a category writes it to the address", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.selectOptions(screen.getByLabelText("Category"), "office");
    expect(nav.replaced).toEqual(["/costs?category=office"]);
  });
});

describe("adding and changing a line", () => {
  test("Add a cost: what was typed is sent, in minor units, for the company in view", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    const form = dialog();
    expect((form.getByLabelText("Starts") as HTMLInputElement).value).toBe("2026-10");
    expect((form.getByLabelText("Amount") as HTMLInputElement).value).toBe("");
    await user.type(form.getByLabelText("Name"), "Example Hosting");
    await user.selectOptions(form.getByLabelText("Category"), "cloud");
    await user.type(form.getByLabelText("Amount"), "1,234.50");
    await user.selectOptions(form.getByLabelText("How often"), "yearly");
    await user.click(form.getByLabelText(/This is an estimate/));
    await user.type(form.getByLabelText("Paid by (optional)"), "Mercury card");
    await user.click(form.getByRole("button", { name: "Add cost" }));
    expect(convex.mutation(api.costs.add)).toHaveBeenCalledWith({
      company: "us",
      name: "Example Hosting",
      category: "cloud",
      amount: 1_234_50,
      currency: "USD",
      cadence: "yearly",
      startsOn: "2026-10",
      variable: true,
      paidBy: "Mercury card",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test.each([
    ["", "A cost needs a name.", "Name"],
    ["Example", "The amount must be a whole amount above zero.", "Amount"],
  ])("what cannot be saved is said, and nothing is sent", async (name, message) => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    if (name !== "") await user.type(dialog().getByLabelText("Name"), name);
    await user.click(dialog().getByRole("button", { name: "Add cost" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(convex.mutation(api.costs.add)).not.toHaveBeenCalled();
  });

  test("a card number is refused before it is sent, in the server's words", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    await user.type(dialog().getByLabelText("Name"), "Example");
    await user.type(dialog().getByLabelText("Amount"), "10");
    await user.type(dialog().getByLabelText("Paid by (optional)"), "4111 1111 1111 1111");
    await user.click(dialog().getByRole("button", { name: "Add cost" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Leave card and account numbers out: say which card or account in words.",
    );
    expect(convex.mutation(api.costs.add)).not.toHaveBeenCalled();
  });

  test("the server's refusal is shown as it was said, and the form stays", async () => {
    const user = userEvent.setup();
    serve();
    convex.mutation(api.costs.add).mockRejectedValue(new ConvexError("The amount is too large."));
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    await user.type(dialog().getByLabelText("Name"), "Example");
    await user.type(dialog().getByLabelText("Amount"), "10");
    await user.click(dialog().getByRole("button", { name: "Add cost" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The amount is too large.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("Edit: the form holds the line, and saving sends the change with what was cleared as null", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(within(table()).getByRole("button", { name: "Edit Example Cloud" }));
    const form = dialog();
    expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("Example Cloud");
    expect((form.getByLabelText("Amount") as HTMLInputElement).value).toBe("400");
    expect((form.getByLabelText(/This is an estimate/) as HTMLInputElement).checked).toBe(true);
    // Editing offers no quick-add: the line has its name.
    expect(form.queryByRole("list", { name: "Common lines" })).toBeNull();
    await user.clear(form.getByLabelText("Amount"));
    await user.type(form.getByLabelText("Amount"), "450");
    await user.clear(form.getByLabelText("Paid by (optional)"));
    await user.click(form.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.costs.update)).toHaveBeenCalledWith({
      id: "c1",
      name: "Example Cloud",
      category: "cloud",
      amount: 450_00,
      currency: "USD",
      cadence: "monthly",
      startsOn: "2026-01",
      variable: true,
      endsOn: null,
      paidBy: null,
      note: null,
    });
  });

  test("Counts as: the category's default unless chosen, and a choice is sent", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    const form = dialog();
    const countsAs = form.getByLabelText("Counts as") as HTMLSelectElement;
    // Software runs the company unless said otherwise; cloud serves customers.
    expect(countsAs.selectedOptions[0]!.textContent).toBe("As its category: Running the company");
    await user.selectOptions(form.getByLabelText("Category"), "cloud");
    expect(countsAs.selectedOptions[0]!.textContent).toBe("As its category: Cost of serving customers");
    await user.type(form.getByLabelText("Name"), "Example Model API");
    await user.type(form.getByLabelText("Amount"), "64");
    await user.selectOptions(countsAs, "sales_marketing");
    await user.click(form.getByRole("button", { name: "Add cost" }));
    expect(convex.mutation(api.costs.add)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Example Model API", category: "cloud", bucket: "sales_marketing" }),
    );
  });

  test("an edit sends Counts as only when it changed, and back to the category's default as null", async () => {
    const user = userEvent.setup();
    serve([AWS, line("c8", "Example Agency", { category: "marketing", bucket: "operating" })]);
    render(page(["costs"]));
    await user.click(within(table()).getByRole("button", { name: "Edit Example Agency" }));
    expect((dialog().getByLabelText("Counts as") as HTMLSelectElement).value).toBe("operating");
    await user.selectOptions(dialog().getByLabelText("Counts as"), "");
    await user.click(dialog().getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.costs.update)).toHaveBeenCalledWith(expect.objectContaining({ id: "c8", bucket: null }));
  });

  test("the table says what each line counts as, and whether by its category", () => {
    serve([AWS, line("c8", "Example Agency", { category: "marketing", bucket: "operating" })]);
    render(page(["costs"]));
    expect(cells(table(), /Example Cloud/)[1]).toBe("Cost of serving customersby category");
    expect(cells(table(), "Example Agency")[1]).toBe("Running the company");
  });

  test("a one-off has a month and no end", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Add a cost" }));
    expect(dialog().getByLabelText("Ends (optional)")).toBeTruthy();
    await user.selectOptions(dialog().getByLabelText("How often"), "once");
    expect(dialog().queryByLabelText("Ends (optional)")).toBeNull();
    expect(dialog().getByLabelText("Month")).toBeTruthy();
  });

  test("Archive, Restore and Delete (which asks first)", async () => {
    const user = userEvent.setup();
    serve();
    render(page(["costs"]));
    await user.click(within(table()).getByRole("button", { name: "Archive Example Tool" }));
    expect(convex.mutation(api.costs.archive)).toHaveBeenCalledWith({ id: "c2" });

    const ended = screen.getByRole("table", { name: "Ended and archived cost lines" });
    await user.click(within(ended).getByRole("button", { name: "Restore Example Archived" }));
    expect(convex.mutation(api.costs.restore)).toHaveBeenCalledWith({ id: "c7" });
    // A line that only ended is not deleted: it can be edited or archived.
    expect(within(ended).queryByRole("button", { name: "Delete Example Ended" })).toBeNull();

    await user.click(within(ended).getByRole("button", { name: "Delete Example Archived" }));
    expect(convex.mutation(api.costs.remove)).not.toHaveBeenCalled();
    expect(screen.getByText("Delete “Example Archived” for good? This cannot be undone.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.costs.remove)).toHaveBeenCalledWith({ id: "c7" });
  });
});

describe("quick-add and the empty state", () => {
  test("no line yet: one sentence and the chips, and no tile, chart or table", () => {
    serve([]);
    render(page(["costs"]));
    expect(screen.getByText(/^No costs yet\. Add what Startup pays for each month/)).toBeTruthy();
    const chips = within(screen.getByRole("list", { name: "Common lines" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "AWS", "Google Cloud", "Vercel", "Convex", "GitHub", "Linear", "Slack", "Google Workspace",
      "Claude", "OpenAI", "Notion", "Figma", "Office rent", "Internet", "Accounting", "Legal",
    ]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("group", { name: "Monthly run-rate" })).toBeNull();
  });

  test("a chip fills the name and the category, never an amount, and creates nothing", async () => {
    const user = userEvent.setup();
    serve([]);
    render(page(["costs"]));
    await user.click(screen.getByRole("button", { name: "Office rent" }));
    const form = dialog();
    expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("Office rent");
    expect((form.getByLabelText("Category") as HTMLSelectElement).value).toBe("office");
    expect((form.getByLabelText("Amount") as HTMLInputElement).value).toBe("");
    expect(convex.mutation(api.costs.add)).not.toHaveBeenCalled();
    // Inside the form too: another chip replaces the two fields and nothing else.
    await user.type(form.getByLabelText("Amount"), "25");
    await user.click(form.getByRole("button", { name: "Slack" }));
    expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("Slack");
    expect((form.getByLabelText("Category") as HTMLSelectElement).value).toBe("software");
    expect((form.getByLabelText("Amount") as HTMLInputElement).value).toBe("25");
    expect(convex.mutation(api.costs.add)).not.toHaveBeenCalled();
    await user.click(form.getByRole("button", { name: "Cancel" }));
    expect(convex.mutation(api.costs.add)).not.toHaveBeenCalled();
  });

  test("no chip carries an amount", () => {
    for (const preset of QUICK_ADD) expect(Object.keys(preset).sort()).toEqual(["category", "name"]);
  });
});
