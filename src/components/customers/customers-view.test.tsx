// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { CustomerRow } from "@convex/lib/customerShape";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { US, clinic } from "@/lib/customers/fixtures";
import { mockConvex } from "@/test-support/convex";
import { CustomersView } from "./customers-view";

// Every switch on, as main has them; a case turns one off and `afterEach` puts it back.
const switches = vi.hoisted(() => ({
  secondCompany: true,
  subsidiaryFunding: true,
  kzProduct: true,
  supportInbox: true,
  verticalStartupAgents: true,
  startupInsights: true,
  verticalStartupProduct: true,
  kztCurrency: true,
}));
vi.mock("@convex/lib/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex/lib/features")>()),
  ...(await import("@convex/lib/deployment.kit")).MADE_UP_DEPLOYMENT,
  FEATURES: switches,
}));
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

// Local noon on 2026-10-12, so "today" is the 12th in any timezone.
const NOW = new Date(2026, 9, 12, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;
const FRESH = NOW - 2 * DAY;
const LATE = { lastPaymentDate: "2026-06-01" };

let convex: ReturnType<typeof mockConvex>;
const show = (
  customers: CustomerRow[],
  options: { lastPushAt?: number | null; query?: string; company?: "us" | "kz" } = {},
) => {
  convex.setQuery(api.customers.list, {
    customers,
    lastPushAt: options.lastPushAt === undefined ? FRESH : options.lastPushAt,
  });
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(options.query ?? "") as unknown as ReturnType<typeof useSearchParams>,
  );
  // With a company, the page is as someone on that company alone sees it.
  return render(
    options.company === undefined ? (
      <CustomersView />
    ) : (
      <CompanyProvider allowed={[options.company]}>
        <CustomersView />
      </CompanyProvider>
    ),
  );
};
const rowOf = (name: string) => within(screen.getByRole("button", { name }).closest("tr")!);
const table = () => screen.getByRole("table", { name: "Clinics" });
const columns = () =>
  within(table())
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
/** A clinic's row by its row header, as the text of its cells. */
const cellsOf = (name: string) =>
  within(within(table()).getByRole("rowheader", { name: new RegExp(name) }).closest("tr")!)
    .getAllByRole("cell")
    .map((td) => td.textContent);
const chip = (name: RegExp) =>
  within(screen.getByRole("navigation", { name: "Filter clinics" })).getByRole("link", { name });

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useNow).mockReturnValue(NOW);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("") as unknown as ReturnType<typeof useSearchParams>,
  );
});
afterEach(() => {
  cleanup();
  switches.secondCompany = true;
});

describe("the customers page", () => {
  test("in one-company mode, where the register push is not part of the OS, it says clinics come from won deals", () => {
    switches.secondCompany = false;
    show([], { lastPushAt: null });
    expect(screen.getByRole("heading", { name: "No clinics yet" })).toBeTruthy();
    expect(screen.getByText(/A clinic arrives here when its deal is marked won on/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "the Sales page" }).getAttribute("href")).toBe("/sales");
    expect(document.body.textContent).not.toContain("push:customers");
  });

  test.each([
    ["the clinics", () => convex.setQuery(api.customers.list, undefined)],
    ["the clock", () => vi.mocked(useNow).mockReturnValue(null)],
  ])("shows placeholders, and no clinic, until %s is in", (_name, withhold) => {
    convex.setQuery(api.customers.list, { customers: [clinic({ name: "SECRET A" })], lastPushAt: FRESH });
    withhold();
    const { container } = render(<CustomersView />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(container.textContent).not.toContain("SECRET");
  });

  test("before any push it says how clinics arrive", () => {
    show([], { lastPushAt: null });
    expect(screen.getByRole("heading", { name: "No clinics yet" })).toBeTruthy();
    expect(
      screen.getByText(/Clinics arrive with a push of the client register: export the register sheet to CSV, then run/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "sources page" }).getAttribute("href")).toBe(
      "/settings/sources",
    );
  });

  test("each clinic has a verdict and the reason for it", () => {
    show([clinic({ name: "SECRET A" }), clinic({ name: "SECRET B", ...LATE })]);
    const good = rowOf("SECRET A");
    expect(good.getByText("Good")).toBeTruthy();
    const late = rowOf("SECRET B");
    expect(late.getByText("At risk")).toBeTruthy();
    expect(
      late.getByText(
        "Last paid 131 days before the register was pushed on Oct 10 (watch after 45, at risk after 75).",
      ),
    ).toBeTruthy();
    // The market under the name; the status in a column of its own.
    expect(late.getByText("Kazakhstan")).toBeTruthy();
    expect(late.getByRole("cell", { name: "Active" })).toBeTruthy();
  });

  test("the clinics are a table: one row each, a column for each field", () => {
    show([
      clinic({
        name: "SECRET A",
        ...US,
        monthlyFee: 1_200,
        amountOwed: 300,
        contractDate: "2026-03-01",
        baaDate: "2026-03-02",
        nextTouch: "2026-10-20",
      }),
      clinic({ name: "SECRET B" }),
    ]);
    expect(columns()).toEqual([
      "Clinic",
      "Status",
      "Health",
      "Monthly fee",
      "Last payment",
      "Owed",
      "Contract",
      "BAA",
      "Next touch",
    ]);
    for (const th of within(table()).getAllByRole("columnheader")) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    const a = cellsOf("SECRET A");
    expect(a[0]).toBe("Active");
    expect(a[1]).toContain("Good");
    expect(a.slice(2)).toEqual(["$1,200", "Oct 1", "$300", "Mar 1", "Mar 2", "Oct 20"]);
    expect(cellsOf("SECRET B").slice(2)).toEqual([
      // The fee as the drawer gives it.
      "₸200K",
      "Oct 1",
      "Nothing owed",
      "Not on record",
      "Not applicable",
      "Not set",
    ]);
    // Amounts sit right-aligned in tabular figures.
    const fee = within(table()).getByRole("cell", { name: "$1,200" });
    expect(fee.className).toContain("text-right");
    expect(fee.className).toContain("font-num");
    // The row is opened by a real button in its first cell, not by the row.
    const header = within(table()).getByRole("rowheader", { name: /SECRET A/ });
    expect(within(header).getByRole("button", { name: "SECRET A" })).toBeTruthy();
    expect(header.closest("tr")!.onclick).toBeNull();
  });

  test("the BAA column is there for the US and for both companies, not for Kazakhstan alone", () => {
    const both = show([clinic({ name: "SECRET A", ...US }), clinic({ name: "SECRET B" })]);
    expect(columns()).toContain("BAA");
    both.unmount();
    const us = show([clinic({ name: "SECRET A", ...US }), clinic({ name: "SECRET B" })], {
      company: "us",
    });
    expect(columns()).toContain("BAA");
    us.unmount();
    show([clinic({ name: "SECRET A", ...US }), clinic({ name: "SECRET B" })], { company: "kz" });
    expect(columns()).not.toContain("BAA");
    expect(screen.queryByText("Not applicable")).toBeNull();
    expect(screen.queryByText("No date on record")).toBeNull();
  });

  test("a clinic's row opens its drawer from the keyboard", async () => {
    const user = userEvent.setup();
    show([clinic({ name: "SECRET A" })]);
    await user.tab();
    while (document.activeElement?.textContent !== "SECRET A") await user.tab();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "SECRET A" })).toBeTruthy();
  });

  test("what the register does not hold reads as not on record, never as zero", () => {
    show([
      clinic({
        name: "SECRET A",
        ...US,
        monthlyFee: null,
        lastPaymentDate: null,
        amountOwed: null,
        lastUsageDate: null,
      }),
    ]);
    const row = rowOf("SECRET A");
    // The fee, the last payment, the amount owed and the contract date.
    expect(cellsOf("SECRET A").slice(2, 6)).toEqual([
      "Not on record",
      "Not on record",
      "Not on record",
      "Not on record",
    ]);
    // With nothing to judge by the verdict is "Unknown", not a bad one.
    expect(row.getAllByText("Unknown").length).toBeGreaterThanOrEqual(1);
    expect(row.getByText("Nothing on record to judge by.")).toBeTruthy();
    // A blank BAA cell proves only that the register has no date.
    expect(row.getByText("No date on record")).toBeTruthy();
    expect(row.queryByText("Nothing owed")).toBeNull();
    expect(row.queryByText(/^[$₸]?0$/)).toBeNull();
  });

  test("a Kazakhstan clinic's BAA is not applicable; a paused clinic is not assessed", () => {
    show([clinic({ name: "SECRET A", status: "paused", ...LATE })]);
    const row = rowOf("SECRET A");
    expect(row.getByText("Not applicable")).toBeTruthy();
    expect(row.getByText("Not assessed")).toBeTruthy();
    expect(row.getByText("Paused in the client register.")).toBeTruthy();
  });

  test("the counts beside each filter leave out clinics no longer in the register", () => {
    show([
      clinic(),
      clinic(LATE),
      clinic(LATE),
      clinic({ ...LATE, archived: true }),
    ]);
    expect(chip(/^All/).textContent).toBe("All 3");
    expect(chip(/^At risk/).textContent).toBe("At risk 2");
    expect(chip(/^Good/).textContent).toBe("Good 1");
    expect(chip(/^At risk/).getAttribute("href")).toBe("/customers?health=at_risk");
    expect(chip(/^All/).getAttribute("aria-current")).toBe("true");
  });

  test("the home page's link shows only the clinics at risk", () => {
    show([clinic({ name: "SECRET A" }), clinic({ name: "SECRET B", ...LATE })], {
      query: "health=at_risk",
    });
    expect(screen.queryByRole("button", { name: "SECRET A" })).toBeNull();
    expect(screen.getByRole("button", { name: "SECRET B" })).toBeTruthy();
    expect(chip(/^At risk/).getAttribute("aria-current")).toBe("true");
  });

  test("US clinics with no BAA date can be listed on their own", () => {
    show(
      [
        clinic({ name: "SECRET A", ...US }),
        clinic({ name: "SECRET B", ...US, baaDate: "2026-03-03" }),
        clinic({ name: "SECRET C" }),
      ],
      { query: "baa=missing" },
    );
    expect(screen.getByRole("button", { name: "SECRET A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "SECRET B" })).toBeNull();
    expect(screen.queryByRole("button", { name: "SECRET C" })).toBeNull();
    expect(chip(/^No BAA date on record/).textContent).toBe("No BAA date on record 1");
  });

  test("filters that match nothing say so, with a way back", () => {
    show([clinic({ name: "SECRET A" })], { query: "health=at_risk" });
    expect(screen.getByText(/No clinics match these filters\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      "/customers",
    );
  });

  test("a clinic no longer in the register is hidden until asked for", () => {
    const customers = [clinic({ name: "SECRET A" }), clinic({ name: "SECRET B", archived: true })];
    show(customers);
    expect(screen.queryByRole("button", { name: "SECRET B" })).toBeNull();
    const toggle = screen.getByRole("link", { name: "Show 1 clinic no longer in the register" });
    expect(toggle.getAttribute("href")).toBe("/customers?archived=1");
    cleanup();

    show(customers, { query: "archived=1" });
    expect(rowOf("SECRET B").getByText(/No longer in the register/)).toBeTruthy();
    expect(rowOf("SECRET B").getByText("Not assessed")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Hide clinics no longer in the register" }),
    ).toBeTruthy();
  });

  // Until 2026-10-15 this read "Client register last pushed Oct 10." under the
  // header: when it was pushed is the header's now (freshness.forPage), once.
  test("a register pushed lately is not given a second time line", () => {
    show([clinic()]);
    expect(screen.queryByText(/last pushed/)).toBeNull();
  });

  test("a register not pushed for more than 14 days says nothing since is known", () => {
    show([clinic({ name: "SECRET A", lastPaymentDate: "2026-08-01", lastUsageDate: "2026-08-15" })], {
      lastPushAt: Date.UTC(2026, 7, 20, 9),
    });
    expect(
      screen.getByText(
        "The client register was last pushed Aug 20. Nothing since then is known: each clinic reads as it stood that day.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Client register last pushed/)).toBeNull();
    // Paid 19 days before the push: good then, and not made late by the weeks since.
    const row = rowOf("SECRET A");
    expect(row.getByText("Good")).toBeTruthy();
    expect(row.getByText("Paid 19 days before the register was pushed on Aug 20.")).toBeTruthy();
  });

  test("15 days after a push the register is called out of date; 14 days after it is not", () => {
    show([clinic()], { lastPushAt: NOW - 14 * DAY });
    expect(screen.queryByText(/Nothing since then is known/)).toBeNull();
    cleanup();
    show([clinic()], { lastPushAt: NOW - 15 * DAY });
    expect(screen.getByText(/Nothing since then is known/)).toBeTruthy();
  });

  test("a verdict resting on fewer than three signals says how many are not on record", () => {
    show([
      clinic({ name: "SECRET A" }),
      clinic({ name: "SECRET B", amountOwed: null, lastUsageDate: null }),
      clinic({ name: "SECRET C", ...LATE, lastUsageDate: null }),
      clinic({ name: "SECRET D", lastPaymentDate: null, amountOwed: null, lastUsageDate: null }),
      clinic({ name: "SECRET E", status: "paused", lastUsageDate: null }),
    ]);
    // All three on record: nothing appended.
    expect(
      rowOf("SECRET A").getByText("Paid 9 days before the register was pushed on Oct 10."),
    ).toBeTruthy();
    // "Good" on payment alone.
    expect(rowOf("SECRET B").getByText("Good")).toBeTruthy();
    expect(
      rowOf("SECRET B").getByText(
        "Paid 9 days before the register was pushed on Oct 10. · 2 of 3 signals not on record",
      ),
    ).toBeTruthy();
    expect(
      rowOf("SECRET C").getByText(
        "Last paid 131 days before the register was pushed on Oct 10 (watch after 45, at risk after 75). · 1 of 3 signals not on record",
      ),
    ).toBeTruthy();
    // Nothing on record, and a clinic that is not assessed, already say so.
    expect(rowOf("SECRET D").getByText("Nothing on record to judge by.")).toBeTruthy();
    expect(rowOf("SECRET E").getByText("Paused in the client register.")).toBeTruthy();
    expect(screen.getAllByText(/signals not on record/)).toHaveLength(2);
  });

  test("with no usage date anywhere, it says usage plays no part", () => {
    show([clinic({ lastUsageDate: null }), clinic({ lastUsageDate: null })]);
    expect(
      screen.getByText(
        "No clinic has a usage date on record, so usage plays no part in any verdict here.",
      ),
    ).toBeTruthy();
    cleanup();
    show([clinic({ lastUsageDate: null }), clinic()]);
    expect(screen.queryByText(/usage plays no part/)).toBeNull();
  });

  test("a clinic's name opens its details, and a push landing meanwhile does not close them", async () => {
    const user = userEvent.setup();
    const first = clinic({ name: "SECRET A", amountOwed: 120_000 });
    const view = show([first]);
    await user.click(screen.getByRole("button", { name: "SECRET A" }));
    const drawer = within(screen.getByRole("dialog", { name: "SECRET A" }));
    expect(drawer.getByText("Owes ₸120K: 0.6 months of fees (watch above 1, at risk above 2).")).toBeTruthy();

    await user.type(drawer.getByLabelText("Note"), "Call on Friday");
    // A push lands: the balance changes under the open drawer.
    convex.setQuery(api.customers.list, {
      customers: [{ ...first, amountOwed: 500_000 }],
      lastPushAt: NOW,
    });
    view.rerender(<CustomersView />);
    const after = within(screen.getByRole("dialog", { name: "SECRET A" }));
    expect(after.getByText("Owes ₸500K: 2.5 months of fees (watch above 1, at risk above 2).")).toBeTruthy();
    expect((after.getByLabelText("Note") as HTMLTextAreaElement).value).toBe("Call on Friday");
  });
});

describe("paying clinics and receivables, as the Dashboard shows them", () => {
  const figure = (key: string, value: number) => ({
    key,
    scope: "kz",
    firstPeriodStart: "2026-09-01",
    latest: { value, periodStart: "2026-09-01", currency: "KZT", source: "cfo_workbook", syncedAt: NOW - DAY },
    series: [{ periodStart: "2026-09-01", value }],
  });

  test("the scorecard's two figures for the company in view, above the clinics", () => {
    convex.setQuery(api.metrics.scorecard, {
      tiles: [figure("paying_clinics", 14), figure("receivables", 900_000)],
      sources: {},
    });
    convex.setQuery(api.targets.list, []);
    show([clinic({ name: "SECRET A" })], { company: "kz" });
    const figures = within(screen.getByRole("region", { name: "Paying clinics and receivables" }));
    expect(figures.getByRole("heading", { name: "Paying clinics" })).toBeTruthy();
    expect(figures.getByText("14")).toBeTruthy();
    expect(figures.getByRole("heading", { name: "Owed by clients" })).toBeTruthy();
  });

  test("not sent (no finance area) or not reported yet: no tile, and no empty one", () => {
    convex.setQuery(api.metrics.scorecard, { tiles: [], sources: {} });
    show([clinic({ name: "SECRET A" })], { company: "kz" });
    expect(screen.queryByRole("region", { name: "Paying clinics and receivables" })).toBeNull();
    expect(screen.queryByText("No value yet")).toBeNull();
  });
});

describe("a clinic won on the Sales board", () => {
  const won = (patch: Partial<CustomerRow> = {}) =>
    clinic({ name: "SECRET WON", dealId: "d1" as CustomerRow["dealId"], fromSales: true, ...patch });

  test("wears a From Sales tag that opens its deal, for a viewer with Sales", () => {
    show([won({ market: "us" }), clinic({ name: "SECRET PLAIN" })]);
    expect(rowOf("SECRET WON").getByRole("link", { name: "From Sales" }).getAttribute("href")).toBe("/sales/deals/d1");
    expect(rowOf("SECRET PLAIN").queryByText("From Sales")).toBeNull();
  });

  test("a Kazakhstan deal has no page of its own: the tag opens the Sales board", () => {
    show([won({ market: "kz" })]);
    expect(rowOf("SECRET WON").getByRole("link", { name: "From Sales" }).getAttribute("href")).toBe("/sales");
  });

  test("a register clinic Sales linked to a deal wears the tag too", () => {
    show([clinic({ name: "SECRET LINKED", dealId: "d2" as CustomerRow["dealId"] })]);
    expect(rowOf("SECRET LINKED").getByRole("link", { name: "From Sales" })).toBeTruthy();
  });

  test("a viewer without Sales reads the tag, with no link", () => {
    convex.setQuery(api.customers.list, { customers: [won()], lastPushAt: FRESH });
    render(
      <ViewerProvider viewer={{ role: "engineer", companies: ["us", "kz"], areas: ["customers"], email: null, name: null }}>
        <CustomersView />
      </ViewerProvider>,
    );
    expect(rowOf("SECRET WON").getByText("From Sales")).toBeTruthy();
    expect(rowOf("SECRET WON").queryByRole("link", { name: "From Sales" })).toBeNull();
  });

  test("is not judged: it sits under Not assessed, with the reason", () => {
    show([won()]);
    expect(chip(/Not assessed/).textContent).toContain("1");
    expect(rowOf("SECRET WON").getByText(/Won on the Sales board and not in the client register yet/)).toBeTruthy();
  });
});
