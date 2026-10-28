// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { US, clinic } from "@/lib/customers/fixtures";
import { mockConvex } from "@/test-support/convex";
import { ClinicsView } from "./kz-clinics";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: vi.fn() }));

const NOW = new Date(2026, 9, 12, 12).getTime();
const STARTS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const weeks = (checks: number[], modules: Record<string, number> = {}) =>
  checks.map((n, i) => ({
    weekStart: STARTS[i]!,
    checks: n,
    actions: n * 2,
    doctors: n > 0 ? 3 : 0,
    doctorsTotal: 4,
    activeDays: n > 0 ? 4 : 0,
    lastActiveOn: null,
    plan: "paid" as const,
    failures: 1,
    modules,
  }));

let convex: ReturnType<typeof mockConvex>;
const at = (query: string) =>
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>);
beforeEach(() => {
  convex = mockConvex();
  at("product=kz_product&view=clinics");
});
afterEach(cleanup);

const show = (areas: Area[], module: "search" | null = null) =>
  render(
    <ViewerProvider
      viewer={{ role: "custom", roleName: "Made-up role", focus: "general", companies: ["kz"], areas, email: "a@example.test", name: null }}
    >
      <ClinicsView now={NOW} module={module} />
    </ViewerProvider>,
  );

const seeded = () => {
  const steady = clinic({ name: "SECRET STEADY" });
  const quiet = clinic({ name: "SECRET QUIET" });
  const fading = clinic({ name: "SECRET FADING" });
  const us = clinic({ name: "SECRET US", ...US });
  convex.setQuery(api.customers.list, { customers: [steady, quiet, fading, us], lastPushAt: NOW });
  convex.setQuery(api.customers.usage, [
    { customerId: steady.id, weeks: weeks([40, 40, 40, 40, 41], { search: 10 }) },
    { customerId: quiet.id, weeks: weeks([40, 40, 40, 40, 0], { intake: 5 }) },
    { customerId: fading.id, weeks: weeks([40, 40, 40, 40, 12], { search: 30 }) },
  ]);
};
const rowsOf = (name: string) =>
  within(screen.getByRole("table", { name })).getAllByRole("rowheader").map((th) => th.textContent);

describe("Product › Kazakhstan › Clinics", () => {
  test("regular clinics in groups against their usual week, with the week before → last week", () => {
    seeded();
    show(["product", "customers"]);
    const regular = within(screen.getByRole("region", { name: "Regular clinics" }));
    expect(regular.getByText("Gone quiet · 1")).toBeTruthy();
    expect(regular.getByText("Below usual · 1")).toBeTruthy();
    expect(regular.getByText("As usual · 1")).toBeTruthy();
    expect(regular.getByText("Largest").nextSibling?.textContent).toBe("SECRET STEADY");
  });

  test("every clinic, the ones to look at first, filtered by the address", () => {
    seeded();
    show(["product", "customers"]);
    expect(rowsOf("Every clinic, the week before → last week")).toEqual(["SECRET QUIET", "SECRET FADING", "SECRET STEADY"]);
    cleanup();
    at("product=kz_product&view=clinics&status=fell");
    show(["product", "customers"]);
    expect(rowsOf("Every clinic, the week before → last week")).toEqual(["SECRET FADING"]);
  });

  test("narrowed to a module: its clinics, the busiest first", () => {
    seeded();
    show(["product", "customers"], "search");
    expect(rowsOf("Every clinic, the week before → last week")).toEqual(["SECRET FADING", "SECRET STEADY"]);
    expect(screen.getByRole("columnheader", { name: "Quick search: actions" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Uses Quick search/ }).getAttribute("href")).toBe(
      "/product?product=kz_product&view=clinics",
    );
  });

  test("a clinic's name leads to its own page, by its id", () => {
    seeded();
    show(["product", "customers"]);
    const links = screen.getAllByRole("link", { name: "SECRET FADING" });
    expect(links[0]!.getAttribute("href")).toMatch(/^\/product\/kz\/clinics\/c\d+$/);
  });

  test("without the Customers page no clinic is asked for or named", () => {
    seeded();
    show(["product"]);
    expect(screen.getByText(/Clinics are named from the client register/)).toBeTruthy();
    expect(screen.queryByText(/SECRET/)).toBeNull();
  });
});
