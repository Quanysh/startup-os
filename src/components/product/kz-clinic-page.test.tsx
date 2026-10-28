// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { clinic } from "@/lib/customers/fixtures";
import { mockConvex } from "@/test-support/convex";
import { ClinicPage } from "./kz-clinic-card";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/product/kz/clinics/x",
}));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
vi.mock("@/hooks/use-scorecard", () => ({ useScorecard: () => ({ tiles: [], sources: {} }) }));

const NOW = new Date(2026, 9, 12, 12).getTime();
const STARTS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useNow).mockReturnValue(NOW);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("") as unknown as ReturnType<typeof useSearchParams>);
});
afterEach(cleanup);

const show = (areas: Area[], id: string) =>
  render(
    <ViewerProvider
      viewer={{ role: "custom", roleName: "Made-up role", focus: "general", companies: ["kz"], areas, email: "a@example.test", name: null }}
    >
      <ClinicPage id={id} />
    </ViewerProvider>,
  );

describe("a Kazakhstan clinic's own page", () => {
  test("its name, status, figures, weeks and what the figures show, under a way back to Clinics", () => {
    const fading = clinic({ name: "SECRET FADING" });
    convex.setQuery(api.customers.list, { customers: [fading], lastPushAt: NOW });
    convex.setQuery(api.customers.usage, [
      {
        customerId: fading.id,
        weeks: [40, 40, 40, 40, 12].map((n, i) => ({
          weekStart: STARTS[i]!,
          checks: n,
          actions: n,
          doctors: 2,
          doctorsTotal: 3,
          activeDays: 3,
          lastActiveOn: "2026-10-09",
          plan: "paid" as const,
          failures: 0,
          modules: { search: n },
        })),
      },
    ]);
    convex.setQuery(api.customers.doctors, []);
    show(["product", "customers"], fading.id);
    expect(screen.getByRole("heading", { level: 1, name: /SECRET FADING/ })).toBeTruthy();
    expect(screen.getByText("Fell")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Clinics/ }).getAttribute("href")).toBe("/product?product=kz_product&view=clinics");
    expect(screen.getByText("Actions and checks, the last 13 weeks")).toBeTruthy();
    const hints = within(screen.getByRole("region", { name: "What the figures show" }));
    expect(hints.getByText("Nothing unusual in this week's figures.")).toBeTruthy();
  });

  test("a clinic of another market, or none, says it is not in Kazakhstan's register", () => {
    convex.setQuery(api.customers.list, { customers: [], lastPushAt: NOW });
    convex.setQuery(api.customers.usage, []);
    show(["product", "customers"], "nope");
    expect(screen.getByText(/not in Kazakhstan's client register/)).toBeTruthy();
  });

  test("without the Customers page no clinic is asked for or named", () => {
    show(["product"], "c1");
    expect(screen.getByText(/Clinics are named from the client register/)).toBeTruthy();
  });
});
