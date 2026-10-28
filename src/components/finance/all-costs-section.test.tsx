// @vitest-environment jsdom
// All costs, for each kind of viewer. Payroll and Costs are sensitive pages:
// their figures appear only to a viewer who holds them, a viewer who does not
// sends no query for them and is told where they are, and a viewer on one
// company reads that company alone.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { CompanyId } from "@convex/lib/company";
import type { CostLine } from "@convex/lib/costs";
import { COMPANY_IDENTITY } from "@convex/lib/identity";
import type { PayPerson } from "@convex/lib/payroll";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { Lens } from "@/lib/finance/all-costs";
import type { Tile } from "@/lib/metrics/scorecard";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { AllCostsSection } from "./all-costs-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const nav = vi.hoisted(() => ({ query: "", replaced: [] as string[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => "/finance",
  useRouter: () => ({ replace: (href: string) => nav.replaced.push(href) }),
}));

const NOW = Date.UTC(2026, 9, 12, 12);
const FX: Tile = {
  key: "fx_usd_kzt",
  scope: "company",
  firstPeriodStart: "2026-09-01",
  latest: { value: 500, periodStart: "2026-09-01", currency: null, source: "manual", syncedAt: NOW },
  series: [{ periodStart: "2026-09-01", value: 500 }],
};

// Every name and amount is made up.
const person = (extra: Partial<PayPerson> & { name: string }): PayPerson => ({
  id: extra.name,
  kind: "employee",
  currency: "USD",
  monthlyGross: 1_000_00,
  order: 0,
  ...extra,
});
const PEOPLE: Record<CompanyId, PayPerson[]> = {
  // Startup: $22,000 to employees, $2,000 to a contractor.
  us: [
    person({ name: "Example Engineer", monthlyGross: 22_000_00 }),
    person({ name: "Sample Contractor", kind: "contractor", monthlyGross: 2_000_00, order: 1 }),
  ],
  // Globex: ₸6,000,000 ($12,000 at 500).
  kz: [person({ name: "Example Analyst", currency: "KZT", monthlyGross: 6_000_000_00 })],
};
const line = (extra: Partial<CostLine> & { name: string }) => ({
  id: extra.name,
  category: "cloud",
  amount: 1_000_00,
  currency: "USD",
  cadence: "monthly",
  startsOn: "2025-01",
  endsOn: null,
  variable: false,
  paidBy: null,
  note: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...extra,
});
const LINES = {
  us: [
    line({ name: "Example Cloud", amount: 2_300_00 }),
    line({ name: "Sample Tool", category: "software", amount: 900_00, variable: true }),
    // Yearly, billed in October: $100 a month in the run-rate, $1,200 due now.
    line({ name: "Example Filing", category: "taxes_fees", amount: 1_200_00, cadence: "yearly", startsOn: "2025-10" }),
  ],
  kz: [
    line({ name: "Sample Rent", category: "office", amount: 500_000_00, currency: "KZT" }),
    line({ name: "Example Hosting", amount: 250_000_00, currency: "KZT" }),
  ],
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  nav.query = "";
  nav.replaced = [];
  convex = mockConvex();
  const byCompany = <T,>(of: Record<CompanyId, T>) => (args: unknown) => of[(args as { company: CompanyId }).company];
  convex.setQueryBy(api.payroll.listPeople, byCompany(PEOPLE));
  convex.setQueryBy(api.payroll.listLines, () => []);
  convex.setQueryBy(api.payroll.listRuns, () => []);
  convex.setQueryBy(api.costs.list, byCompany(LINES));
});
afterEach(cleanup);

const show = (
  lens: Lens,
  areas: Area[] = ["finance", "payroll", "costs"],
  { companies = ["us", "kz"] as CompanyId[], tiles = [FX] as Tile[] } = {},
) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas, email: null, name: null }}>
      <AllCostsSection lens={lens} currentMonth="2026-10" tiles={tiles} />
    </ViewerProvider>,
  );
const section = () => within(screen.getByRole("region", { name: "All costs" }));
/** A headline figure's words in full: its value and what it says. */
const figure = (label: string) => section().getByText(label, { selector: "dt" }).parentElement!.textContent;
const table = () => within(section().getByRole("table", { name: "Monthly costs by category" }));
/** Each body row's header and cells, as text. */
const rowsOf = () =>
  table()
    .getAllByRole("row")
    .filter((row) => row.closest("tbody") !== null && row.getAttribute("data-row") === "record")
    .map((row) => Array.from(row.querySelectorAll("th, td"), (cell) => cell.textContent));
/** The body row whose first cell starts with these words. */
const rowNamed = (start: string) => rowsOf().find((row) => row[0]!.startsWith(start))!;
const asked = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([, args]) => args !== "skip")
    .map(([ref, args]) => `${getFunctionName(ref as never)} ${(args as { company: string }).company}`);

describe("the group: both companies in dollars", () => {
  test("monthly costs, a year at that rate and cash due, each with what it means and each company's share", () => {
    show("group");
    // 27,300 for Startup (24,000 + 2,300 + 900 + 100) and 13,500 for Globex.
    expect(figure("Monthly costs")).toContain("$40,800.00");
    expect(figure("Monthly costs")).toContain("run-rate");
    expect(figure("Monthly costs")).toContain("Startup$27,300.00, 67%");
    expect(figure("Monthly costs")).toContain("Globex₸6,750,000 ≈ $13,500.00, 33%");
    expect(figure("Yearly at this rate")).toContain("$489,600.00");
    expect(figure("Yearly at this rate")).toContain("not a forecast");
    // The yearly bill falls due whole this month: 28,400 + 13,500.
    expect(figure("Cash due this month")).toContain("$41,900.00");
    expect(figure("Cash due this month")).toContain("yearly and quarterly bills whole");
  });

  test("by category: Payroll and each category, each company's own and the group's, the largest first", () => {
    show("group");
    expect(table().getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Category",
      "Startup, USD",
      "Globex, KZT",
      "Group, USD",
      "Share",
    ]);
    expect(rowsOf()).toEqual([
      ["PayrollGross and company-paid", "$24,000.00", "₸6,000,000≈ $12,000.00", "$36,000.00", "88%"],
      ["Cloud", "$2,300.00", "₸250,000≈ $500.00", "$2,800.00", "7%"],
      ["Office", "—", "₸500,000≈ $1,000.00", "$1,000.00", "2%"],
      ["Software", "$900.00", "—", "$900.00", "2%"],
      ["Taxes and fees", "$100.00", "—", "$100.00", "<1%"],
    ]);
    const total = table().getByRole("rowheader", { name: /^Total a month/ }).closest("tr")!;
    expect(Array.from(total.querySelectorAll("td"), (td) => td.textContent).slice(0, 3)).toEqual([
      "$27,300.00",
      "₸6,750,000≈ $13,500.00",
      "$40,800.00",
    ]);
  });

  test("one line says how the two companies stand: the subsidiary pays the team, Startup most subscriptions", () => {
    show("group");
    expect(
      section().getAllByText(
        "Globex (Globex LLP) is Startup Inc's subsidiary: the team is paid through it, and most subscriptions by Startup.",
      ),
    ).toHaveLength(1);
  });

  test("the rate is said once", () => {
    show("group");
    expect(section().getAllByText(/₸500 per \$1/)).toHaveLength(1);
    expect(section().getByText("Dollars for Globex's tenge at ₸500 per $1, the Sep 2026 rate.")).toBeTruthy();
  });

  /** A line's cells, as text: each company's column, the group's, the share. */
  const lineCells = (name: RegExp) =>
    Array.from(table().getByRole("rowheader", { name }).closest("tr")!.querySelectorAll("td"), (td) => td.textContent);

  test("every line is in view from the start: its company's own figure, the group's dollars and its share", () => {
    show("group");
    const tool = table().getByRole("rowheader", { name: /Sample Tool/ });
    expect(tool.textContent).toContain("Monthly");
    expect(tool.textContent).toContain("an estimate");
    // Startup's line in Startup's column; Globex's tenge in its own, and both in the group's dollars.
    expect(lineCells(/Sample Tool/)).toEqual(["≈ about $900.00", "", "≈ about $900.00", "2%"]);
    expect(lineCells(/Example Hosting/)).toEqual(["", "₸250,000", "$500.00", "1%"]);
    expect(table().getByRole("rowheader", { name: /Example Filing/ }).textContent).toContain("Yearly");
    expect(table().getByRole("rowheader", { name: /Sample Rent/ })).toBeTruthy();
  });

  test("in a category, the largest line first, whichever company's", () => {
    show("group");
    const names = table()
      .getAllByRole("rowheader")
      .map((th) => th.textContent ?? "")
      .filter((name) => /^(Example Cloud|Example Hosting)/.test(name));
    expect(names.map((name) => name.replace(/Monthly.*/, ""))).toEqual(["Example Cloud", "Example Hosting"]);
  });

  test("a category folds, and Categories only folds them all; Payroll opens on a click alone", () => {
    show("group");
    expect(table().getByRole("button", { name: /Software/ }).getAttribute("aria-expanded")).toBe("true");
    expect(table().getByRole("button", { name: /Payroll/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(table().getByRole("button", { name: /Software/ }));
    expect(table().queryByRole("rowheader", { name: /Sample Tool/ })).toBeNull();
    expect(table().getByRole("rowheader", { name: /Example Hosting/ })).toBeTruthy();

    const every = section().getByRole("button", { name: "Every line" });
    expect(every.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(every);
    expect(every.getAttribute("aria-pressed")).toBe("false");
    expect(table().queryByRole("rowheader", { name: /Example Hosting|Sample Rent|Example Filing/ })).toBeNull();
    fireEvent.click(every);
    expect(table().getByRole("rowheader", { name: /Sample Tool/ })).toBeTruthy();
  });

  test("Payroll opens to employees and contractors, never a person, and leads to the Payroll page", () => {
    show("group");
    fireEvent.click(table().getByRole("button", { name: /Payroll/ }));
    const employees = table().getByRole("rowheader", { name: "Employees" }).closest("tr")!;
    expect(Array.from(employees.querySelectorAll("td"), (td) => td.textContent).slice(0, 3)).toEqual([
      "$22,000.00",
      "₸6,000,000≈ $12,000.00",
      "$34,000.00",
    ]);
    expect(table().getByRole("rowheader", { name: "Contractors" })).toBeTruthy();
    expect(section().queryByText(/Example Engineer|Sample Contractor|Example Analyst/)).toBeNull();
    expect(table().getByRole("link", { name: "Open Payroll for people" }).getAttribute("href")).toBe("/payroll");
  });

  test("downloads as All costs: a figure and its dollars set apart, the note across the table left out", () => {
    show("group");
    fireEvent.click(table().getByRole("button", { name: /Payroll/ }));
    expect(section().getByRole("button", { name: "Download All costs as CSV" })).toBeTruthy();
    const rows = readTable(section().getByRole("table", { name: "Monthly costs by category" }));
    expect(rows[0]).toEqual(["Category", "Startup, USD", "Globex, KZT", "Group, USD", "Share"]);
    expect(rows.find((cells) => cells[0] === "Employees")!.slice(1, 4)).toEqual([
      "$22,000.00",
      "₸6,000,000 ≈ $12,000.00",
      "$34,000.00",
    ]);
    expect(rows.flat().join(" ")).not.toContain("Open Payroll");
  });

  test("the composition: one bar, Payroll then the categories in a fixed order, the small ones folded", () => {
    show("group");
    const legend = within(section().getByRole("list", { name: "Legend" }));
    expect(legend.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Payroll88%",
      "Office2%",
      "Cloud7%",
      "Software2%",
      "Other costs<1%",
    ]);
    const bar = within(section().getByRole("group", { name: "Monthly costs by category" }));
    const payroll = bar.getByRole("img", { name: "Payroll: $36,000.00, 88% of monthly costs" });
    // Hover and focus show the exact figure.
    fireEvent.pointerEnter(payroll);
    expect(section().getByRole("tooltip").textContent).toContain("$36,000.00");
    fireEvent.focus(bar.getByRole("img", { name: /^Other costs/ }));
    expect(section().getByRole("tooltip").textContent).toContain("Taxes and fees$100.00");
  });

  test("sorting by any column, kept in the address", () => {
    show("group");
    const header = table().getByRole("columnheader", { name: "Group, USD" });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(table().getByRole("columnheader", { name: "Globex, KZT" })).getByRole("button"));
    expect(nav.replaced).toEqual(["/finance?costs-sort=kz&costs-dir=desc"]);
  });

  test("a sort in the address orders the rows", () => {
    nav.query = "costs-sort=category&costs-dir=asc";
    show("group");
    expect(rowsOf().map((row) => row[0])).toEqual(["Cloud", "Office", "PayrollGross and company-paid", "Software", "Taxes and fees"]);
    expect(table().getByRole("columnheader", { name: "Category" }).getAttribute("aria-sort")).toBe("ascending");
  });

  test("with no rate on record: every group figure is not known, and each company's own still stands", () => {
    show("group", undefined, { tiles: [] });
    expect(figure("Monthly costs")).toContain("Not known yet");
    expect(figure("Monthly costs")).toContain("Globex₸6,750,000");
    expect(rowNamed("Payroll")).toEqual(["PayrollGross and company-paid", "$24,000.00", "₸6,000,000", "Not known yet", ""]);
    // Tenge of nothing needs no rate; a figure not known sorts last.
    expect(rowsOf().map((row) => row[0])).toEqual(["Software", "Taxes and fees", "PayrollGross and company-paid", "Cloud", "Office"]);
    expect(section().getByText(/wait for a USD\/KZT rate/)).toBeTruthy();
    expect(section().queryByRole("list", { name: "Legend" })).toBeNull();
  });

  test("Open Costs and Open Payroll", () => {
    show("group");
    expect(section().getByRole("link", { name: "Open Costs" }).getAttribute("href")).toBe("/costs");
    expect(section().getByRole("link", { name: "Open Payroll" }).getAttribute("href")).toBe("/payroll");
  });
});

describe("one company's lens", () => {
  test("Startup alone, in dollars: no group, and the other company is not named", () => {
    show("us");
    expect(table().getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Category", "Startup, USD", "Share"]);
    expect(figure("Monthly costs")).toContain("$27,300.00");
    expect(section().queryByText(/Globex|Group|₸/)).toBeNull();
    expect(asked().filter((call) => call.endsWith(" kz"))).toEqual([]);
  });

  test("Globex in tenge, with dollars alongside", () => {
    show("kz");
    expect(figure("Monthly costs")).toContain("₸6,750,000");
    expect(figure("Monthly costs")).toContain("≈ $13,500.00");
    expect(rowsOf()[0]).toEqual(["PayrollGross and company-paid", "₸6,000,000≈ $12,000.00", "89%"]);
  });

  test("a viewer on one company has that company's section alone", () => {
    show("us", undefined, { companies: ["us"] });
    expect(section().queryByText(/Globex|Group/)).toBeNull();
  });

  test("the line on the subsidiary is the group's: neither company's lens has it", () => {
    for (const lens of ["us", "kz"] as const) {
      show(lens);
      const text = screen.getByRole("region", { name: "All costs" }).textContent;
      expect(text, lens).not.toMatch(/subsidiary/);
      // Nor the subsidiary by its legal name, the name the bank pays it under.
      expect(text, lens).not.toContain(COMPANY_IDENTITY.kz.legalName);
      cleanup();
    }
  });
});

describe("what the viewer does not hold (access must not widen)", () => {
  test("without Payroll: no pay figure and no pay query, the page named, every total excluding it", () => {
    show("group", ["finance", "costs"]);
    expect(asked().some((call) => call.startsWith("payroll:"))).toBe(false);
    // A row with no figure sorts last.
    expect(rowsOf().at(-1)).toEqual(["Payroll", "On the Payroll page"]);
    expect(figure("Monthly costs")).toContain("excludes Payroll");
    expect(figure("Monthly costs")).toContain("$4,800.00");
    expect(table().getByRole("rowheader", { name: /^Total a month/ }).textContent).toContain("excludes Payroll");
    expect(section().queryByRole("button", { name: /Payroll/ })).toBeNull();
    expect(section().queryByRole("link", { name: /Open Payroll/ })).toBeNull();
    expect(section().getByRole("link", { name: "Open Costs" })).toBeTruthy();
  });

  test("without Costs: no category, line or cost query, the page named, every total excluding them", () => {
    show("group", ["finance", "payroll"]);
    expect(asked().some((call) => call.startsWith("costs:"))).toBe(false);
    expect(rowsOf().map((row) => row[0])).toEqual(["PayrollGross and company-paid", "Registered costs"]);
    expect(rowsOf()[1]).toEqual(["Registered costs", "On the Costs page"]);
    expect(figure("Monthly costs")).toContain("$36,000.00");
    expect(figure("Monthly costs")).toContain("exclude registered costs");
    expect(section().queryByText(/Cloud|Example Cloud/)).toBeNull();
    // Payroll alone is one piece: no chart.
    expect(section().queryByRole("list", { name: "Legend" })).toBeNull();
  });

  test("with neither: one line pointing to both pages, no figure, no query", () => {
    show("group", ["finance"]);
    expect(asked().filter((call) => /^(payroll|costs):/.test(call))).toEqual([]);
    expect(section().getByText("Pay is on the Payroll page, and every other cost on the Costs page.")).toBeTruthy();
    // The heading and that line: nothing else.
    expect(screen.getByRole("region", { name: "All costs" }).querySelectorAll("p")).toHaveLength(2);
    expect(section().queryByRole("table")).toBeNull();
    expect(section().queryByText(/\$|₸/)).toBeNull();
    expect(section().queryByRole("link")).toBeNull();
  });
});
