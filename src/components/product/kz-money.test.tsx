// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ViewerProvider } from "@/components/viewer-provider";
import type { Area } from "@convex/lib/roles";
import { mockConvex } from "@/test-support/convex";
import { ModuleCard } from "./kz-module";
import { PeriodFigures } from "./kz-overview";
import { SpeedView } from "./kz-speed";
import { ModulesView } from "./kz-views";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/product",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  mockConvex();
});
afterEach(cleanup);

const as = (areas: Area[], children: ReactNode) =>
  render(
    <ViewerProvider viewer={{ role: "engineer", companies: ["kz"], areas, email: null, name: null }}>{children}</ViewerProvider>,
  );

// AI spend is a finance figure: the server sends it only to Finance, and the
// views leave its tile and columns out for anyone else, as the tab does with
// active clients.
describe("Product › Kazakhstan without Finance", () => {
  test("the period's figures leave out AI cost", () => {
    as(["product"], <PeriodFigures tiles={[]} span={1} />);
    expect(screen.queryByText(/AI cost/)).toBeNull();
    cleanup();
    as(["product", "finance"], <PeriodFigures tiles={[]} span={1} />);
    expect(screen.getByText("AI cost")).toBeTruthy();
  });

  test("the period's figures leave out the paying clinics: they are paying clients, Finance's", () => {
    as(["product"], <PeriodFigures tiles={[]} span={1} />);
    expect(screen.queryByText(/Clinics, trial \/ paid/)).toBeNull();
    expect(screen.getByText("Clinics on a trial")).toBeTruthy();
    cleanup();
    as(["product", "finance"], <PeriodFigures tiles={[]} span={1} />);
    expect(screen.getByText("Clinics, trial / paid")).toBeTruthy();
  });

  test("the modules table has no AI cost column", () => {
    as(["product"], <ModulesView tiles={[]} module={null} />);
    expect(screen.queryByRole("columnheader", { name: "AI cost" })).toBeNull();
    cleanup();
    as(["product", "finance"], <ModulesView tiles={[]} module={null} />);
    expect(screen.getByRole("columnheader", { name: "AI cost" })).toBeTruthy();
  });

  test("a module's card says nothing of its AI cost", () => {
    as(["product"], <ModuleCard tiles={[]} module="search" />);
    expect(screen.queryByText(/AI:/)).toBeNull();
    cleanup();
    as(["product", "finance"], <ModuleCard tiles={[]} module="search" />);
    expect(screen.getByText(/AI:/)).toBeTruthy();
  });

  test("Speed & AI has no AI cost a result column", () => {
    as(["product"], <SpeedView tiles={[]} span={1} end={null} />);
    expect(screen.queryByRole("columnheader", { name: "AI cost a result" })).toBeNull();
    cleanup();
    as(["product", "finance"], <SpeedView tiles={[]} span={1} end={null} />);
    expect(screen.getByRole("columnheader", { name: "AI cost a result" })).toBeTruthy();
  });
});
