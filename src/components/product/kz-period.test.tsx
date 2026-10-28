// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// A fork's second company, made up: the heading is its name, from the identity.
vi.mock("@convex/lib/identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@convex/lib/identity")>();
  return {
    ...real,
    COMPANY_IDENTITY: { ...real.COMPANY_IDENTITY, kz: { ...real.COMPANY_IDENTITY.kz, name: "Beta Labs" } },
  };
});

const { PeriodTitle } = await import("./kz-period");

afterEach(cleanup);

describe("the Kazakhstan tab's heading", () => {
  test("is the second company's name, with the weeks once they are read", () => {
    render(<PeriodTitle period={{ weeks: 1, end: null }} mondays={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: /^Beta Labs 1 week$/ })).toBeTruthy();
    cleanup();
    render(<PeriodTitle period={{ weeks: 1, end: null }} mondays={["2026-10-05"]} />);
    expect(screen.getByRole("heading", { level: 2, name: /^Beta Labs — 05\.10–11\.10 vs 28\.09–04\.10/ })).toBeTruthy();
    expect(screen.queryByText(/Globex/)).toBeNull();
  });
});
