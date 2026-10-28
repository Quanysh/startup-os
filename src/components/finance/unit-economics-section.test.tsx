// @vitest-environment jsdom
// Unit economics on Finance, for each kind of viewer. Payroll, Costs and
// Customers are each asked for only by a viewer who holds that page; without
// one, what needs it says where it is, a sum says what it leaves out, and no
// ratio is worked out from a part. Pay appears aggregated, never a person's.
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { CompanyId } from "@convex/lib/company";
import type { PayrollLineRow } from "@convex/lib/payroll";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { Lens } from "@/lib/finance/all-costs";
import type { UnitCostLine, UnitPerson } from "@/lib/finance/unit-economics";
import type { Tile } from "@/lib/metrics/scorecard";
import { readTable } from "@/lib/table-export";
import { mockConvex } from "@/test-support/convex";
import { UnitEconomicsSection } from "./unit-economics-section";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Every name, amount and date here is made up.
const tile = (key: string, scope: string, points: [string, number][], currency: string | null = null): Tile => {
  const series = points.map(([month, value]) => ({ periodStart: `${month}-01`, value }));
  const newest = series.at(-1)!;
  return {
    key,
    scope,
    firstPeriodStart: series[0]!.periodStart,
    latest: { value: newest.value, periodStart: newest.periodStart, currency, source: "made_up", syncedAt: 1 },
    series,
  };
};

const KZ_TILES = [
  tile("mrr", "kz", [["2026-09", 6_000_000]], "KZT"),
  tile("paying_clinics", "kz", [["2026-09", 24]]),
  tile("logo_churn_monthly", "kz", [["2026-09", 2]]),
  tile("ai_token_cost", "kz_product", [["2026-09", 60]], "USD"),
  tile("ai_token_clinics", "kz_product", [["2026-09", 40]]),
  tile("fx_usd_kzt", "company", [["2026-09", 500]]),
];
const STARTUP_ZERO = tile("mrr", "us", [["2026-09", 0]], "USD");
const STARTUP_PAYING = [tile("mrr", "us", [["2026-09", 10_000]], "USD"), tile("paying_clinics", "us", [["2026-09", 4]])];

const line = (extra: Partial<UnitCostLine> & Pick<UnitCostLine, "name" | "category" | "amount">) => ({
  id: extra.name,
  currency: "KZT",
  cadence: "monthly",
  startsOn: "2026-01",
  endsOn: null,
  variable: false,
  archivedAt: null,
  bucket: null,
  paidBy: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const LINES: Record<CompanyId, unknown[]> = {
  us: [line({ name: "Example Hosting", category: "cloud", amount: 500_00, currency: "USD" })],
  kz: [
    line({ name: "Example Cloud", category: "cloud", amount: 300_000_00 }),
    line({ name: "Example CRM", category: "software", amount: 50_000_00, bucket: "cogs" }),
    line({ name: "Example Agency", category: "marketing", amount: 2_100_000_00, cadence: "once", startsOn: "2026-07" }),
  ],
};
const levy: PayrollLineRow = {
  id: "levy",
  name: "Made-up employer levy",
  paidBy: "company",
  rateBp: 1_000,
  lessLineIds: [],
  allowance: 0,
  baseCap: null,
  appliesTo: "employee",
  order: 0,
  active: true,
};
const person = (extra: Partial<UnitPerson> & Pick<UnitPerson, "id">): UnitPerson => ({
  name: "SECRET PERSON",
  kind: "employee",
  currency: "KZT",
  payBasis: "gross",
  monthlyGross: 0,
  order: 0,
  cogsPercent: 0,
  salesPercent: 0,
  ...extra,
});
const PEOPLE: Record<CompanyId, UnitPerson[]> = {
  us: [],
  // Costs ₸1,100,000, half of it serving customers; ₸550,000 at 40% selling.
  kz: [person({ id: "a", monthlyGross: 1_000_000_00, cogsPercent: 50 }), person({ id: "b", monthlyGross: 500_000_00, salesPercent: 40 })],
};
const clinic = (market: CompanyId, contractDate: string | null) => ({
  id: contractDate ?? "none",
  name: "SECRET CLINIC",
  market,
  status: "active",
  monthlyFee: null,
  currency: market === "us" ? "USD" : "KZT",
  lastPaymentDate: null,
  amountOwed: null,
  lastUsageDate: null,
  contractDate,
  baaDate: null,
  nextTouch: null,
  note: null,
  syncedAt: 1,
  archived: false,
});
const CLINICS = [clinic("kz", "2026-07-01"), clinic("kz", "2026-08-12"), clinic("kz", "2026-08-20"), clinic("kz", "2026-09-30"), clinic("kz", null)];

const ALL: Area[] = ["finance", "payroll", "costs", "customers"];
const asked = (fn: { toString(): string } | Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref, args]) => getFunctionName(ref) === getFunctionName(fn as never) && args !== "skip");

beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  const convex = mockConvex();
  const byCompany = <T,>(of: Record<CompanyId, T>) => (args: unknown) => of[(args as { company: CompanyId }).company];
  convex.setQueryBy(api.payroll.listPeople, byCompany(PEOPLE));
  convex.setQueryBy(api.payroll.listLines, byCompany({ us: [], kz: [levy] }));
  convex.setQueryBy(api.costs.list, byCompany(LINES));
  convex.setQuery(api.customers.list, { customers: CLINICS, lastPushAt: 1 });
});
afterEach(cleanup);

const show = (lens: Lens, { areas = ALL, tiles = [...KZ_TILES, STARTUP_ZERO] as Tile[], companies = ["us", "kz"] as CompanyId[] } = {}) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas, email: null, name: null }}>
      <UnitEconomicsSection lens={lens} currentMonth="2026-10" tiles={tiles} />
    </ViewerProvider>,
  );
const section = () => within(screen.getByRole("region", { name: "Unit economics" }));
const text = () => screen.getByRole("region", { name: "Unit economics" }).textContent ?? "";
/** A figure's words in full, in a company's lens. */
const figure = (label: string) => section().getByText(label, { selector: "dt" }).parentElement!.textContent;

describe("the group lens", () => {
  test("a table with a column per company and no sum, every row named", () => {
    show("group");
    const table = section().getByRole("table", { name: "Unit economics by company" });
    const rows = readTable(table);
    expect(rows[0]).toEqual(["Figure", "Startup, USD", "Globex, KZT"]);
    expect(rows.slice(1).map((row) => row[0])).toEqual([
      "Paying customers",
      "Revenue per customer / month",
      "COGS per customer / month",
      "Gross margin",
      "New customers (last 3 months)",
      "Sales and marketing spend (last 3 months)",
      "CAC",
      "CAC payback",
      "LTV",
      "LTV:CAC",
    ]);
    const kz = Object.fromEntries(rows.slice(1).map((row) => [row[0], row[2]]));
    expect(kz["Paying customers"]).toBe("24");
    expect(kz["Revenue per customer / month"]).toContain("₸250K");
    expect(kz["Revenue per customer / month"]).toContain("≈ $500");
    expect(kz["Gross margin"]).toBe("84.5%");
    expect(kz["New customers (last 3 months)"]).toBe("4");
    // ₸2,100,000 to the agency in July + ₸220,000 of pay × 3.
    expect(kz["Sales and marketing spend (last 3 months)"]).toContain("₸2.8M");
    expect(kz.CAC).toContain("₸690K");
    // Startup has no paying customers yet: never a zero in their place.
    const us = Object.fromEntries(rows.slice(1).map((row) => [row[0], row[1]]));
    expect(us["Revenue per customer / month"]).toBe("No paying customers yet");
    expect(us["Gross margin"]).toBe("No revenue yet");
    expect(us.CAC).toBe("No new customers in the last 3 months");
  });

  test("what each figure is made of, a line each, pay only ever as a sum", () => {
    show("group");
    expect(text()).toContain("Globex · COGS: Cloud ₸300K + Software ₸50K + 33% of pay marked as serving customers ₸550K + AI tokens $60 (Sep 2026, 40 clinics)");
    expect(text()).toContain("Globex · CAC: what was paid Jul–Sep 2026, Marketing ₸2.1M + 13% of pay marked as sales and marketing ₸660K, ÷ 4 clinics contracted in those months");
    expect(text()).toContain("1 clinic has no contract date and is not counted.");
    expect(text()).not.toContain("SECRET");
  });

  test("no benchmark band on Globex's figures, and Startup's shows none without a figure", () => {
    show("group");
    expect(text()).not.toMatch(/typical/i);
    expect(text()).toContain("No benchmark band on Globex's figures");
  });
});

describe("a company's lens", () => {
  test("Startup with no paying customers yet: one line and what will make it work", () => {
    show("us");
    expect(text()).toContain("Startup has no paying customers yet (MRR $0).");
    expect(text()).toContain("record Startup's MRR and paying customers");
    expect(section().queryByRole("table")).toBeNull();
    expect(section().queryAllByText("Gross margin", { selector: "dt" })).toHaveLength(0);
  });

  test("Globex: tenge with dollars alongside, and no band", () => {
    show("kz");
    expect(figure("Revenue per customer / month")).toContain("₸250K");
    expect(figure("Revenue per customer / month")).toContain("≈ $500");
    expect(figure("Gross margin")).toContain("84.5%");
    expect(figure("CAC payback")).toContain("months");
    expect(text()).not.toMatch(/typical for seed/i);
    expect(text()).not.toContain("Startup");
  });

  test("Startup with paying customers: gross margin is set against the published band", () => {
    show("us", { tiles: STARTUP_PAYING });
    // (10,000 − 500) ÷ 10,000 = 95%: above the AI-native band.
    expect(figure("Gross margin")).toContain("95.0%");
    expect(figure("Gross margin")).toContain("Stronger than typical for seed");
  });
});

describe("who is asked for what", () => {
  test("without Payroll: no payroll query, COGS says it leaves pay out, and the margin is on the Payroll page", () => {
    show("kz", { areas: ["finance", "costs", "customers"] });
    expect(asked(api.payroll.listPeople)).toEqual([]);
    expect(asked(api.payroll.listLines)).toEqual([]);
    expect(figure("COGS per customer / month")).toContain("excludes pay");
    expect(figure("Gross margin")).toContain("On the Payroll page");
    expect(figure("CAC")).toContain("On the Payroll page");
    expect(section().queryByRole("link", { name: "Mark people on Payroll" })).toBeNull();
    expect(section().getByRole("link", { name: "Mark costs on Costs" })).toBeTruthy();
  });

  test("without Customers: no customers query, and CAC is on the Customers page", () => {
    show("kz", { areas: ["finance", "payroll", "costs"] });
    expect(asked(api.customers.list)).toEqual([]);
    expect(figure("New customers (last 3 months)")).toContain("On the Customers page");
    expect(figure("CAC")).toContain("On the Customers page");
  });

  test("without Costs: no costs query, and no link to mark them", () => {
    show("kz", { areas: ["finance", "payroll", "customers"] });
    expect(asked(api.costs.list)).toEqual([]);
    expect(section().queryByRole("link", { name: "Mark costs on Costs" })).toBeNull();
    expect(figure("COGS per customer / month")).toContain("excludes registered costs");
  });

  test("a viewer on Globex alone asks nothing of Startup", () => {
    show("kz", { companies: ["kz"] });
    for (const fn of [api.payroll.listPeople, api.payroll.listLines, api.costs.list]) {
      expect(asked(fn).map(([, args]) => (args as { company: string }).company)).not.toContain("us");
    }
  });
});
