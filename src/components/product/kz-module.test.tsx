// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { clinic } from "@/lib/customers/fixtures";
import { mockConvex } from "@/test-support/convex";
import { ModuleCard } from "./kz-module";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const doctor = (name: string, customerId: string, now: number, before: number) => ({
  customerId,
  doctorId: name,
  name,
  weekStart: "2026-10-05",
  week: "usual",
  weekBefore: "usual",
  actions: now,
  previous: before,
  usual: 5,
  activeDays: 2,
  lastActiveOn: null,
  lastEvent: null,
  mainModule: "search",
  plan: "paid",
  trialEndedOn: null,
  trialOutcome: null,
  actionsBeforeTrialEnd: null,
  actionsAfterTrialEnd: null,
  modules: { search: now },
  modulesPrevious: { search: before },
});

describe("a module's card", () => {
  test("who uses it most, its clinics, and who stopped, by name", () => {
    const a = clinic({ name: "SECRET A" });
    const b = clinic({ name: "SECRET B" });
    convex.setQuery(api.customers.list, { customers: [a, b], lastPushAt: 1 });
    convex.setQuery(api.customers.doctorRoster, [
      doctor("SECRET LOW", a.id, 2, 2),
      doctor("SECRET HIGH", b.id, 30, 10),
      doctor("SECRET GONE", a.id, 0, 8),
    ]);
    render(<ModuleCard tiles={[]} module="search" />);
    const users = within(screen.getByRole("table", { name: "Doctors using Quick search" }));
    expect(users.getAllByRole("rowheader").map((th) => th.textContent)).toEqual(["SECRET HIGH", "SECRET LOW"]);
    const clinics = within(screen.getByRole("table", { name: "Clinics using Quick search" }));
    expect(clinics.getAllByRole("rowheader").map((th) => th.textContent)).toEqual(["SECRET B", "SECRET A"]);
    expect(screen.getByText(/SECRET GONE/).closest("li")?.textContent).toBe("SECRET GONE — SECRET A · 8 → 0");
  });
});
