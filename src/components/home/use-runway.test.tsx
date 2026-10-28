// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { areasOf, type Area } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { useRunway } from "./use-runway";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const NOW = vi.hoisted(() => new Date(2026, 9, 12, 12).getTime());
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

// The opening line's runway: Finance's own run-out, for a viewer with
// finance, and nothing asked for anyone else.

const seen = vi.fn();
const said = () => seen.mock.lastCall?.[0];
function Probe() {
  seen(useRunway());
  return null;
}
const show = (areas: readonly Area[], companies: ("us" | "kz")[], company: "us" | "kz" = companies[0]!) => {
  window.localStorage.setItem("startup-os:company", company);
  render(
    <CompanyProvider allowed={companies}>
      <ViewerProvider viewer={{ role: "cofounder", companies, areas, email: null, name: null }}>
        <Probe />
      </ViewerProvider>
    </CompanyProvider>,
  );
};
const sent = (ref: Parameters<typeof getFunctionName>[0]) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called, args]) => getFunctionName(called as never) === getFunctionName(ref) && args !== "skip")
    .map(([, args]) => args);

beforeEach(() => {
  const convex = mockConvex();
  vi.mocked(useQuery).mockClear();
  seen.mockClear();
  convex.setQuery(api.metrics.scorecard, { tiles: [], sources: {} });
  convex.setQuery(api.metrics.series, []);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the runway the opening line says", () => {
  test("without finance: nothing, and neither the figures nor Kazakhstan's balances are asked for", () => {
    show(areasOf("sales"), ["us", "kz"]);
    expect(said()).toBeNull();
    expect(sent(api.metrics.scorecard)).toEqual([]);
    expect(sent(api.metrics.series)).toEqual([]);
  });

  test("on both companies: the group's, which needs Kazakhstan's balances whatever company is in view", () => {
    show(["finance"], ["us", "kz"], "us");
    expect(sent(api.metrics.series)).toContainEqual({ key: "cash", scope: "kz", limit: 400 });
  });

  test("on Startup alone: Startup's own, and Kazakhstan's balances are never asked for", () => {
    show(["finance"], ["us"]);
    expect(sent(api.metrics.scorecard).length).toBeGreaterThan(0);
    expect(sent(api.metrics.series)).toEqual([]);
  });

  test("a figure that is not known is no runway: never a zero, never a guess", () => {
    show(["finance"], ["us", "kz"]);
    expect(said()).toBeNull();
  });

  test("still being read: undefined, so the line waits", () => {
    vi.mocked(useQuery).mockImplementation((() => undefined) as never);
    show(["finance"], ["us"]);
    expect(said()).toBeUndefined();
  });
});
